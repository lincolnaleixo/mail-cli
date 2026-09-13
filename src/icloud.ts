/**
 * iCloud backend — IMAP read (imapflow + postal-mime) + SMTP send (nodemailer).
 *
 * Read paths (inbox/unread/search/read/archive/trash) are ported from aiana
 * quill ~/tools/quill/src/fetch/icloud.ts. SMTP send + IMAP draft-append are
 * new (quill only ever read iCloud). Auth = the iCloud address + an
 * app-specific password; from is always the authenticated address.
 *
 * Search is **all-folder** and robust (2026-06-24): every selectable mailbox is
 * searched on one connection, a Gmail-style query mini-language is parsed into
 * IMAP criteria, and a local-filter fallback covers iCloud's flaky server-side
 * SEARCH. Connections carry timeouts + a transient-error retry. INBOX message
 * ids stay bare UIDs (backward-compatible with triage); messages in other
 * folders are addressed as "<folderPath>:<uid>".
 */

import { writeFileSync } from 'fs';
import {
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type ListResponse,
  type MessageAddressObject,
  type SearchObject,
} from 'imapflow';
import PostalMime from 'postal-mime';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { loadAttachments } from './attachments';
import { normalizeSubject, parseMessageIdList } from './headers';
import { resolveAllowedSender } from './sender';
import { cleanWhitespace, stripHtml } from './text';
import { describeImapError, isTransientFailure } from './transient';
import type {
  AttachmentMeta,
  DraftResult,
  Email,
  EmailBackend,
  FolderInfo,
  ICloudCreds,
  OutgoingMessage,
  SearchOptions,
  SendResult,
} from './types';


function formatSender(addr?: MessageAddressObject): string {
  const name = cleanWhitespace(addr?.name ?? '');
  const email = cleanWhitespace(addr?.address ?? '');
  return name ? `${name} <${email}>` : email;
}

function addressList(addrs?: MessageAddressObject[]): string {
  return (addrs ?? []).map((a) => cleanWhitespace(a.address ?? '')).filter(Boolean).join(', ');
}

/** Name + address joined for a case-insensitive substring match. */
function addressJoin(addrs?: MessageAddressObject[]): string {
  return (addrs ?? []).map((a) => `${a.name ?? ''} ${a.address ?? ''}`).join(' ');
}

function attachmentByteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === 'string') return content.length;
  return content.byteLength;
}

/** Decode a postal-mime attachment's content into raw bytes. */
function attachmentBytes(content: ArrayBuffer | Uint8Array | string, encoding?: string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf-8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(new Uint8Array(content));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:\0]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'attachment';
}

/** Body-only parse (no attachment decode) — used by the deep body scan. */
async function parseBody(source?: Buffer): Promise<string> {
  if (!source) return '';
  const parsed = await new PostalMime().parse(source);
  return cleanWhitespace(parsed.text || stripHtml(parsed.html || ''));
}

interface ParsedSource {
  body: string;
  attachments: AttachmentMeta[];
  /** Threading headers, free of charge — the source was already being parsed. */
  messageId?: string;
  inReplyTo?: string;
  references: string[];
}

/** Parse body + attachment metadata (attachments as ArrayBuffer for accurate size). */
async function parseSource(source?: Buffer): Promise<ParsedSource> {
  if (!source) return { body: '', attachments: [], references: [] };
  const parsed = await new PostalMime({ attachmentEncoding: 'arraybuffer' }).parse(source);
  const body = cleanWhitespace(parsed.text || stripHtml(parsed.html || ''));
  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename || '(unnamed)',
    mimeType: a.mimeType || 'application/octet-stream',
    size: attachmentByteLength(a.content),
  }));
  return {
    body,
    attachments,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parseMessageIdList(parsed.references),
  };
}

function toDate(v: Date | string | undefined): Date {
  return v instanceof Date ? v : new Date(v ?? 0);
}

function msgDate(m: FetchMessageObject): Date {
  return toDate(m.internalDate ?? m.envelope?.date);
}

// ---- ID encoding: INBOX ids stay bare numbers; others are "<folder>:<uid>" ----

function encodeId(folder: string, uid: number | string): string {
  return folder === 'INBOX' ? String(uid) : `${folder}:${uid}`;
}

function decodeId(id: string): { folder: string; uid: string } {
  const idx = id.lastIndexOf(':');
  if (idx <= 0) return { folder: 'INBOX', uid: id };
  const tail = id.slice(idx + 1);
  // The trailing segment must be all digits, else treat the whole id as a bare INBOX uid.
  if (/^\d+$/.test(tail)) return { folder: id.slice(0, idx), uid: tail };
  return { folder: 'INBOX', uid: id };
}

async function toEmail(message: FetchMessageObject, folder = 'INBOX'): Promise<Email> {
  const env = message.envelope;
  const parsed = await parseSource(message.source);
  const { body, attachments } = parsed;
  const flags = message.flags ?? new Set<string>();
  return {
    id: encodeId(folder, message.uid),
    account: 'icloud',
    threadId: message.threadId ? String(message.threadId) : '',
    folder,
    from: formatSender(env?.from?.[0]),
    to: addressList(env?.to),
    subject: cleanWhitespace(env?.subject || '(no subject)'),
    date: msgDate(message).toISOString(),
    // The envelope is present even on cheap fetches; the parsed source only on
    // a full one. References therefore needs a full read (which `reply` does).
    messageId: env?.messageId ?? parsed.messageId,
    inReplyTo: env?.inReplyTo ?? parsed.inReplyTo,
    references: parsed.references.length ? parsed.references : undefined,
    replyTo: addressList(env?.replyTo) || undefined,
    snippet: body.replace(/\s+/g, ' ').trim().slice(0, 200),
    body,
    labelIds: Array.from(flags),
    isUnread: !flags.has('\\Seen'),
    attachments: attachments.length ? attachments : undefined,
  };
}

/** Cheap fetch — envelope only, no message source. */
const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  internalDate: true,
  flags: true,
};

/** Full fetch — adds the raw source (needed for body, attachments, full read). */
const FULL_QUERY: FetchQueryObject = { ...ENVELOPE_QUERY, source: true };

/** Thread fetch — envelope + the reference headers that link a conversation. */
const THREAD_QUERY: FetchQueryObject = {
  ...ENVELOPE_QUERY,
  headers: ['references', 'in-reply-to', 'message-id'],
};

/** Newest `limit` items (UIDs sort ascending → largest are newest). */
function newest<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

/** Most-recent envelopes to scan when iCloud's server SEARCH is unreliable. */
const BODY_SCAN_CAP = 200;

// ---- Query mini-language (Gmail-style) ----

interface ParsedQuery {
  criteria: SearchObject;
  bareTerms: string[];
  /** A body match is required (a `body:` term, or a deep-mode bare term). */
  wantsBody: boolean;
  /** An attachment match is required (`has:attachment`). */
  wantsAttachment: boolean;
}

const OPERATOR_KEYS = new Set([
  'from', 'to', 'cc', 'subject', 'body',
  'since', 'before', 'after', 'newer_than', 'older_than',
  'is', 'has', 'header',
]);

/** Quote-aware tokenizer: keeps `subject:"hotel am park"` and `"a b c"` whole. */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /(\S*"[^"]*")|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const tok = (m[1] ?? m[2] ?? '').trim();
    if (tok) tokens.push(tok);
  }
  return tokens;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function splitOperator(token: string): { key: string; value: string } | null {
  const idx = token.indexOf(':');
  if (idx <= 0) return null;
  const key = token.slice(0, idx).toLowerCase();
  return { key, value: stripQuotes(token.slice(idx + 1)) };
}

function parseAbsoluteDate(value: string): Date | null {
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseRelativeDate(value: string): Date | null {
  const m = value.match(/^(\d+)\s*([dwm])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const days = m[2]!.toLowerCase() === 'd' ? n : m[2]!.toLowerCase() === 'w' ? n * 7 : n * 30;
  return new Date(Date.now() - days * 86_400_000);
}

function parseQuery(raw: string, opts: { deepBody?: boolean } = {}): ParsedQuery {
  const criteria: SearchObject = {};
  const bareTerms: string[] = [];
  const headerMatches: Record<string, string> = {};
  let wantsBody = false;
  let wantsAttachment = false;

  for (const token of tokenize(raw)) {
    const op = splitOperator(token);
    if (!op || !OPERATOR_KEYS.has(op.key)) {
      bareTerms.push(stripQuotes(token));
      continue;
    }
    const { key, value } = op;
    if (!value && key !== 'is' && key !== 'has') {
      bareTerms.push(token);
      continue;
    }
    switch (key) {
      case 'from': criteria.from = value; break;
      case 'to': criteria.to = value; break;
      case 'cc': criteria.cc = value; break;
      case 'subject': criteria.subject = value; break;
      case 'body': criteria.body = value; wantsBody = true; break;
      case 'since':
      case 'after': { const d = parseAbsoluteDate(value); if (d) criteria.since = d; break; }
      case 'before': { const d = parseAbsoluteDate(value); if (d) criteria.before = d; break; }
      case 'newer_than': { const d = parseRelativeDate(value); if (d) criteria.since = d; break; }
      case 'older_than': { const d = parseRelativeDate(value); if (d) criteria.before = d; break; }
      case 'is': {
        const v = value.toLowerCase();
        if (v === 'unread' || v === 'unseen') criteria.seen = false;
        else if (v === 'read' || v === 'seen') criteria.seen = true;
        else if (v === 'flagged' || v === 'starred') criteria.flagged = true;
        else if (v === 'unflagged') criteria.flagged = false;
        break;
      }
      case 'has': {
        const v = value.toLowerCase();
        if (v === 'attachment' || v === 'attachments') wantsAttachment = true;
        break;
      }
      case 'header': {
        const eq = value.indexOf('=');
        if (eq > 0) headerMatches[value.slice(0, eq)] = value.slice(eq + 1);
        break;
      }
    }
  }

  if (Object.keys(headerMatches).length) criteria.header = headerMatches;

  // Bare terms → OR across from + subject (+ body in deep mode), AND-ed into the rest.
  if (bareTerms.length) {
    const joined = bareTerms.join(' ');
    const or: SearchObject[] = [{ from: joined }, { subject: joined }];
    if (opts.deepBody) {
      or.push({ body: joined });
      wantsBody = true;
    }
    criteria.or = or;
  }

  return { criteria, bareTerms, wantsBody, wantsAttachment };
}

// ---- Connection robustness: fresh client per attempt, retry transient errors ----

function buildImap(creds: ICloudCreds): ImapFlow {
  return new ImapFlow({
    host: creds.imapServer,
    port: creds.imapPort,
    secure: true,
    auth: { user: creds.email, pass: creds.appSpecificPassword },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/**
 * Re-throw with the server's own explanation in the message.
 *
 * imapflow raises a bare `Error('Command failed')` for a tagged NO/BAD and keeps
 * the reason on `responseStatus`/`responseText`, so without this every caller
 * (and the journal) only ever saw "Command failed".
 */
function rethrowDescribed(e: unknown): never {
  const described = describeImapError(e);
  if (e instanceof Error && described !== e.message) {
    throw new Error(described, { cause: e });
  }
  throw e;
}

/** Run `fn`, retrying transient connection errors with backoff; never retry auth failures. */
async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseDelayMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientFailure(e) || attempt === retries) rethrowDescribed(e);
      await new Promise((r) => setTimeout(r, base * 2 ** attempt));
    }
  }
  rethrowDescribed(lastErr);
}

class ICloudBackend implements EmailBackend {
  readonly account = 'icloud' as const;
  private creds: ICloudCreds;

  constructor(creds: ICloudCreds) {
    this.creds = creds;
  }

  /**
   * Fresh client per attempt, with an `'error'` listener attached before it can
   * fire. imapflow emits `'error'` for socket faults that arrive while no
   * command is pending (`imap-flow.js` `emitError`); with no listener, Node's
   * EventEmitter throws it out of the event loop and kills the whole process,
   * bypassing every caller's try/catch. Swallowing it here turns those faults
   * back into ordinary rejections of the awaited command.
   */
  private newImap(): ImapFlow {
    const client = buildImap(this.creds);
    client.on('error', (e: unknown) => {
      console.error(`iCloud IMAP connection error: ${describeImapError(e)}`);
    });
    return client;
  }

  /** Connect, run fn against an open+locked INBOX, then release + logout (with retry). */
  private async withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return withRetry(async () => {
      const client = this.newImap();
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
        try { await client.logout(); } catch { /* best-effort close */ }
      }
    });
  }

  /** Connect with no mailbox lock (caller opens mailboxes as needed), then logout (with retry). */
  private async withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return withRetry(async () => {
      const client = this.newImap();
      await client.connect();
      try {
        return await fn(client);
      } finally {
        try { await client.logout(); } catch { /* best-effort close */ }
      }
    });
  }

  /** Resolve a mailbox by IMAP special-use flag, falling back to common names. */
  private async resolveMailbox(
    client: ImapFlow,
    special: string | null,
    fallbacks: string[],
  ): Promise<string | null> {
    const boxes = await client.list();
    const byUse = special
      ? boxes.find((b) => b.specialUse === special)
      : undefined;
    if (byUse) return byUse.path;
    for (const name of fallbacks) {
      const byName = boxes.find((b) => b.path.toLowerCase() === name.toLowerCase());
      if (byName) return byName.path;
    }
    return null;
  }

  /**
   * Where Apple Mail actually files sent mail, which is NOT the special-use box.
   *
   * iCloud exposes both "Sent Messages" (no specialUse, the one Apple Mail
   * writes to and the one the user reads) and "Sent Items" (flagged \Sent,
   * empty). Resolving by special-use first, the sane default everywhere else,
   * files the copy into the box nobody opens, so the name wins here and
   * special-use is only the fallback for accounts shaped differently.
   */
  private async resolveSentMailbox(client: ImapFlow): Promise<string | null> {
    return (
      (await this.resolveMailbox(client, null, ['Sent Messages'])) ??
      (await this.resolveMailbox(client, '\\Sent', ['Sent Items', 'Sent']))
    );
  }

  /** Is this mailbox worth searching? Skips Noselect/All, and Trash/Junk by default. */
  private isSearchable(box: ListResponse, opts: SearchOptions): boolean {
    const flags = box.flags ?? new Set<string>();
    if (flags.has('\\Noselect') || flags.has('\\NonExistent')) return false;
    if (box.specialUse === '\\All') return false; // avoid double-counting the Gmail-style All view
    const lname = box.path.toLowerCase();
    const isTrash = box.specialUse === '\\Trash' || lname === 'trash' || lname === 'deleted messages';
    const isJunk = box.specialUse === '\\Junk' || lname === 'junk' || lname === 'spam';
    if (isTrash && !opts.includeTrash) return false;
    if (isJunk && !opts.includeJunk) return false;
    if (opts.folders?.length) {
      return opts.folders.some((f) => f.toLowerCase() === box.path.toLowerCase());
    }
    return true;
  }

  async inbox(limit: number): Promise<Email[]> {
    return this.withInbox(async (client) => {
      const total = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0;
      if (!total) return [];
      const start = Math.max(1, total - limit + 1);
      const fetched = await client.fetchAll(`${start}:*`, FULL_QUERY);
      const emails = await Promise.all(fetched.map((m) => toEmail(m)));
      return emails.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    });
  }

  async unread(limit: number): Promise<Email[]> {
    return this.withInbox(async (client) => {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
      if (!uids.length) return [];
      const fetched = await client.fetchAll(newest(uids, limit), FULL_QUERY, { uid: true });
      const emails = await Promise.all(fetched.map((m) => toEmail(m)));
      return emails.sort((a, b) => b.date.localeCompare(a.date));
    });
  }

  async search(query: string, limit: number, opts: SearchOptions = {}): Promise<Email[]> {
    const pq = parseQuery(query, { deepBody: !!opts.body });
    return this.withConnection(async (client) => {
      const boxes = (await client.list()).filter((b) => this.isSearchable(b, opts));
      const collected: { folder: string; msg: FetchMessageObject }[] = [];
      for (const box of boxes) {
        try {
          await client.mailboxOpen(box.path, { readOnly: true });
          const msgs = await this.searchOneBox(client, pq, limit);
          for (const m of msgs) collected.push({ folder: box.path, msg: m });
        } catch {
          // A single unreadable box never fails the whole search.
        }
      }
      return this.mergeSortLimit(collected, limit);
    });
  }

  /**
   * Search the currently-open mailbox. iCloud's server SEARCH (from/to/subject/
   * body/text/date/flags) is reliable once the connection is robust, so we lean
   * on it — one cheap envelope fetch, and it reaches matches far older than any
   * local window. A successful server result (even empty) is trusted. The local
   * recent-window scan is the fallback only when there's no reliable server
   * answer: the SEARCH errored, or the sole constraint is `has:attachment`
   * (which has no server form).
   */
  private async searchOneBox(client: ImapFlow, pq: ParsedQuery, cap: number): Promise<FetchMessageObject[]> {
    const { criteria, wantsBody, wantsAttachment } = pq;

    const hasCriteria = Object.keys(criteria).length > 0;
    let serverUids: number[] = [];
    let serverOk = false;
    if (hasCriteria) {
      try {
        serverUids = ((await client.search(criteria, { uid: true })) || []) as number[];
        serverOk = true;
      } catch {
        serverOk = false; // fall through to the local scan
      }
    }
    serverUids.sort((a, b) => a - b);

    // Reliable server hit (criteria — incl. body — handled server-side) with nothing left to
    // confirm locally → trust it as-is with a cheap envelope fetch.
    if (serverUids.length && !wantsAttachment) {
      return client.fetchAll(newest(serverUids, Math.max(cap, 50)), ENVELOPE_QUERY, { uid: true });
    }

    // has:attachment narrows server hits → confirm the attachment locally (no server form for it).
    if (serverUids.length && wantsAttachment) {
      const pool = await client.fetchAll(newest(serverUids, BODY_SCAN_CAP), FULL_QUERY, { uid: true });
      return this.filterAsync(pool, pq);
    }

    // The server answered reliably for this box (criteria matched nothing here) → done.
    if (hasCriteria && serverOk) return [];

    // No reliable server answer (the SEARCH errored, or has:attachment is the only constraint) →
    // bounded recent-window scan, filtered locally.
    const hasLocalCheckable = !!(
      criteria.from || criteria.to || criteria.cc || criteria.subject ||
      criteria.body || criteria.or || criteria.since || criteria.before ||
      criteria.seen !== undefined || criteria.flagged !== undefined || wantsAttachment
    );
    if (hasLocalCheckable) {
      const fetchQuery = wantsBody || wantsAttachment ? FULL_QUERY : ENVELOPE_QUERY;
      const pool = await this.fetchRecent(client, BODY_SCAN_CAP, fetchQuery);
      return this.filterAsync(pool, pq);
    }
    return [];
  }

  /** Fetch the newest `n` messages in the open mailbox by sequence number. */
  private async fetchRecent(client: ImapFlow, n: number, query: FetchQueryObject): Promise<FetchMessageObject[]> {
    const total = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0;
    if (!total) return [];
    const start = Math.max(1, total - n + 1);
    return client.fetchAll(`${start}:*`, query);
  }

  private async filterAsync(msgs: FetchMessageObject[], pq: ParsedQuery): Promise<FetchMessageObject[]> {
    const out: FetchMessageObject[] = [];
    for (const m of msgs) if (await this.matchesMessage(m, pq)) out.push(m);
    return out;
  }

  /** Local match of a parsed query — substring on headers, lazy body/attachment parse. */
  private async matchesMessage(m: FetchMessageObject, pq: ParsedQuery): Promise<boolean> {
    const c = pq.criteria;
    const env = m.envelope;
    const fromStr = addressJoin(env?.from).toLowerCase();
    const toStr = addressJoin(env?.to).toLowerCase();
    const ccStr = addressJoin(env?.cc).toLowerCase();
    const subjStr = (env?.subject ?? '').toLowerCase();

    if (c.from && !fromStr.includes(String(c.from).toLowerCase())) return false;
    if (c.to && !toStr.includes(String(c.to).toLowerCase())) return false;
    if (c.cc && !ccStr.includes(String(c.cc).toLowerCase())) return false;
    if (c.subject && !subjStr.includes(String(c.subject).toLowerCase())) return false;
    if (c.seen === true && !m.flags?.has('\\Seen')) return false;
    if (c.seen === false && m.flags?.has('\\Seen')) return false;
    if (c.flagged === true && !m.flags?.has('\\Flagged')) return false;
    if (c.flagged === false && m.flags?.has('\\Flagged')) return false;

    const dt = msgDate(m);
    if (c.since && dt < toDate(c.since)) return false;
    if (c.before && dt >= toDate(c.before)) return false;

    // Parse the source at most once, and only when a clause needs it.
    let parsed: { body: string; attachments: AttachmentMeta[] } | null = null;
    const getParsed = async () => (parsed ??= await parseSource(m.source));

    if (c.body) {
      const p = await getParsed();
      if (!p.body.toLowerCase().includes(String(c.body).toLowerCase())) return false;
    }
    if (pq.wantsAttachment) {
      const p = await getParsed();
      if (!p.attachments.length) return false;
    }
    if (c.or?.length) {
      let any = false;
      for (const o of c.or) {
        if (o.from && fromStr.includes(String(o.from).toLowerCase())) { any = true; break; }
        if (o.subject && subjStr.includes(String(o.subject).toLowerCase())) { any = true; break; }
        if (o.to && toStr.includes(String(o.to).toLowerCase())) { any = true; break; }
        if (o.cc && ccStr.includes(String(o.cc).toLowerCase())) { any = true; break; }
        if (o.body) {
          const p = await getParsed();
          if (p.body.toLowerCase().includes(String(o.body).toLowerCase())) { any = true; break; }
        }
      }
      if (!any) return false;
    }
    return true;
  }

  /** Dedupe across folders (prefer the INBOX copy), sort newest-first, cap the merged set. */
  private async mergeSortLimit(items: { folder: string; msg: FetchMessageObject }[], limit: number): Promise<Email[]> {
    const byKey = new Map<string, { folder: string; msg: FetchMessageObject }>();
    for (const it of items) {
      const key = it.msg.envelope?.messageId || `${it.folder}:${it.msg.uid}`;
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, it);
      else if (it.folder === 'INBOX' && existing.folder !== 'INBOX') byKey.set(key, it);
    }
    const emails = await Promise.all(Array.from(byKey.values()).map((it) => toEmail(it.msg, it.folder)));
    return emails.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  /** Fetch one message from a specific box; null if absent (box unreadable or uid gone). */
  private async fetchFromBox(
    client: ImapFlow,
    path: string,
    uid: string,
    query: FetchQueryObject = FULL_QUERY,
  ): Promise<FetchMessageObject | null> {
    try {
      await client.mailboxOpen(path, { readOnly: true });
      const m = await client.fetchOne(uid, query, { uid: true });
      return m && typeof m !== 'boolean' ? m : null;
    } catch {
      return null;
    }
  }

  /** Locate a message: try the decoded folder, then (for a legacy bare INBOX id) scan others. */
  private async locateMessage(
    client: ImapFlow,
    folder: string,
    uid: string,
    query: FetchQueryObject = FULL_QUERY,
  ): Promise<{ folder: string; msg: FetchMessageObject } | null> {
    const direct = await this.fetchFromBox(client, folder, uid, query);
    if (direct) return { folder, msg: direct };
    if (folder !== 'INBOX') return null; // an encoded id is exact — don't guess
    for (const box of await client.list()) {
      if (box.path === 'INBOX' || (box.flags ?? new Set()).has('\\Noselect')) continue;
      const m = await this.fetchFromBox(client, box.path, uid, query);
      if (m) return { folder: box.path, msg: m };
    }
    return null;
  }

  async read(id: string): Promise<Email> {
    const { folder, uid } = decodeId(id);
    return this.withConnection(async (client) => {
      const found = await this.locateMessage(client, folder, uid);
      if (!found) throw new Error(`iCloud message ${id} not found`);
      return toEmail(found.msg, found.folder);
    });
  }

  async archive(id: string): Promise<void> {
    return this.moveTo(id, '\\Archive', ['Archive']);
  }

  async move(id: string, destination: string): Promise<void> {
    return this.moveTo(id, null, [destination]);
  }

  async trash(id: string): Promise<void> {
    return this.moveTo(id, '\\Trash', ['Trash', 'Deleted Messages']);
  }

  /** Move a message to a resolved destination, from whatever source folder its id encodes. */
  private async moveTo(id: string, special: string | null, fallbacks: string[]): Promise<void> {
    const { folder, uid } = decodeId(id);
    return this.withConnection(async (client) => {
      const dest = await this.resolveMailbox(client, special, fallbacks);
      if (!dest) throw new Error(`iCloud mailbox "${fallbacks[0]}" not found`);
      if (folder.toLowerCase() === dest.toLowerCase()) return; // already there — no-op
      await client.mailboxOpen(folder); // read-write for the move
      const present = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true });
      if (!present || typeof present === 'boolean') throw new Error(`iCloud message ${id} not found in ${folder}`);
      await client.messageMove(uid, dest, { uid: true });
    });
  }

  async folders(): Promise<FolderInfo[]> {
    return this.withConnection(async (client) => {
      const boxes = await client.list();
      const out: FolderInfo[] = [];
      for (const b of boxes) {
        let messages: number | undefined;
        try {
          const st = await client.status(b.path, { messages: true });
          messages = st.messages;
        } catch { /* \Noselect or otherwise un-statusable */ }
        out.push({ name: b.name, path: b.path, specialUse: b.specialUse, messages });
      }
      return out;
    });
  }

  async thread(id: string): Promise<Email[]> {
    const { folder, uid } = decodeId(id);
    return this.withConnection(async (client) => {
      const seed = await this.locateMessage(client, folder, uid, THREAD_QUERY);
      if (!seed) throw new Error(`iCloud message ${id} not found`);

      const ids = new Set<string>();
      const seedMsgId = seed.msg.envelope?.messageId;
      if (seedMsgId) ids.add(seedMsgId);
      for (const r of parseMessageIdList(headerText(seed.msg.headers))) ids.add(r);
      const subjectKey = subjectKeyOf(seed.msg.envelope?.subject ?? '');

      const collected: { folder: string; msg: FetchMessageObject }[] = [{ folder: seed.folder, msg: seed.msg }];
      const boxes = (await client.list()).filter((b) => this.isSearchable(b, {}));
      for (const box of boxes) {
        try {
          await client.mailboxOpen(box.path, { readOnly: true });
          const uids = new Set<number>();
          if (subjectKey.length >= 3) {
            const su = ((await client.search({ subject: subjectKey }, { uid: true })) || []) as number[];
            su.forEach((u) => uids.add(u));
          }
          if (!uids.size) continue;
          const msgs = await client.fetchAll(Array.from(uids), THREAD_QUERY, { uid: true });
          for (const m of msgs) {
            if (m.uid === seed.msg.uid && box.path === seed.folder) continue; // already have the seed
            if (inThread(m, ids, subjectKey)) collected.push({ folder: box.path, msg: m });
          }
        } catch { /* skip unreadable box */ }
      }

      const emails = await this.mergeThread(collected);
      return emails.sort((a, b) => a.date.localeCompare(b.date)); // oldest first
    });
  }

  private async mergeThread(items: { folder: string; msg: FetchMessageObject }[]): Promise<Email[]> {
    const byKey = new Map<string, { folder: string; msg: FetchMessageObject }>();
    for (const it of items) {
      const key = it.msg.envelope?.messageId || `${it.folder}:${it.msg.uid}`;
      if (!byKey.has(key)) byKey.set(key, it);
    }
    return Promise.all(Array.from(byKey.values()).map((it) => toEmail(it.msg, it.folder)));
  }

  async attachments(id: string): Promise<AttachmentMeta[]> {
    const email = await this.read(id);
    return email.attachments ?? [];
  }

  async downloadAttachment(id: string, index: number, outDir: string): Promise<string> {
    const { folder, uid } = decodeId(id);
    return this.withConnection(async (client) => {
      const found = await this.locateMessage(client, folder, uid);
      if (!found?.msg.source) throw new Error(`iCloud message ${id} not found`);
      const parsed = await new PostalMime({ attachmentEncoding: 'arraybuffer' }).parse(found.msg.source);
      const atts = parsed.attachments ?? [];
      const att = atts[index];
      if (!att) throw new Error(`attachment index ${index} out of range (have ${atts.length})`);
      const bytes = attachmentBytes(att.content, att.encoding);
      const outPath = `${outDir.replace(/\/$/, '')}/${sanitizeFilename(att.filename || `attachment-${index}`)}`;
      writeFileSync(outPath, bytes, { flag: 'wx' });
      return outPath;
    });
  }

  async draft(msg: OutgoingMessage): Promise<DraftResult> {
    const raw = await this.buildMime(msg);
    const client = this.newImap();
    await client.connect();
    try {
      const dest = await this.resolveMailbox(client, '\\Drafts', ['Drafts']);
      if (!dest) throw new Error('no iCloud Drafts mailbox found');
      const res = await client.append(dest, raw, ['\\Draft']);
      const uid = res && typeof res !== 'boolean' ? res.uid : undefined;
      return { draftId: uid ? String(uid) : '' };
    } finally {
      await client.logout();
    }
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const from = resolveAllowedSender(this.creds.email, this.creds.sendFrom ?? [], msg.from);
    const transport = nodemailer.createTransport({
      host: this.creds.smtpServer,
      port: this.creds.smtpPort,
      secure: false, // STARTTLS on 587
      requireTLS: true,
      auth: { user: this.creds.email, pass: this.creds.appSpecificPassword },
    });
    const info = await transport.sendMail(mailOptions(msg, from));
    const messageId = info.messageId ?? '';
    const sentCopy = await this.appendToSent(msg, messageId);
    return { messageId, sentCopy };
  }

  /**
   * File a copy of a just-sent message in Sent Messages.
   *
   * SMTP delivery leaves no trace in the mailbox, so without this an iCloud
   * send vanishes from Lincoln's own history (Gmail needs no equivalent: the
   * API files sent mail itself). Best-effort by design: the mail is already
   * delivered by the time we get here, so an IMAP failure must never turn a
   * successful send into a thrown error. Returns whether the copy landed.
   *
   * The SMTP-generated Message-ID is threaded back into the copy so the
   * archived message is the same message, not a re-composed lookalike.
   */
  private async appendToSent(msg: OutgoingMessage, messageId: string): Promise<boolean> {
    try {
      const raw = await this.buildMime(msg, { messageId, keepBcc: true });
      const client = this.newImap();
      await client.connect();
      try {
        const dest = await this.resolveSentMailbox(client);
        if (!dest) return false;
        await client.append(dest, raw, ['\\Seen']);
        return true;
      } finally {
        try { await client.logout(); } catch { /* best-effort close */ }
      }
    } catch {
      return false; // already sent; an unfiled copy is not a send failure
    }
  }

  private buildMime(
    msg: OutgoingMessage,
    opts: { messageId?: string; keepBcc?: boolean } = {},
  ): Promise<Buffer> {
    const from = resolveAllowedSender(this.creds.email, this.creds.sendFrom ?? [], msg.from);
    const composer = new MailComposer({
      ...mailOptions(msg, from),
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
    });
    const node = composer.compile();
    // keepBcc is a MimeNode flag, not a MailComposer mail field: passing it in
    // the mail object is silently ignored and the Bcc header is stripped.
    if (opts.keepBcc) node.keepBcc = true;
    return new Promise((resolve, reject) => {
      node.build((err, message) => (err ? reject(err) : resolve(message)));
    });
  }
}

// ---- Outgoing mail ----

/**
 * One shared option object for both send (SMTP) and draft (MIME + IMAP APPEND),
 * so the two paths can never disagree about which headers a message carries.
 *
 * `msg.threadId` is deliberately unused: IMAP has no server-side thread object,
 * and Apple Mail groups on In-Reply-To/References, which we emit below.
 */
export function mailOptions(msg: OutgoingMessage, from: string) {
  return {
    from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    replyTo: msg.replyTo,
    subject: msg.subject,
    text: msg.body,
    html: msg.html,
    inReplyTo: msg.inReplyTo,
    // nodemailer accepts an array, but joining keeps the emitted header explicit.
    references: msg.references?.length ? msg.references.join(' ') : undefined,
    attachments: loadAttachments(msg.attachments).map((a) => ({
      filename: a.filename,
      contentType: a.mimeType,
      content: a.content,
    })),
  };
}

// ---- Thread helpers ----

function headerText(headers?: Buffer): string {
  return headers ? headers.toString('utf-8') : '';
}

/** Subject key for conversation grouping — case-insensitive, prefixes stripped. */
function subjectKeyOf(s: string): string {
  return normalizeSubject(s).toLowerCase();
}

function inThread(m: FetchMessageObject, ids: Set<string>, subjectKey: string): boolean {
  const msgId = m.envelope?.messageId;
  if (msgId && ids.has(msgId)) return true;
  if (parseMessageIdList(headerText(m.headers)).some((r) => ids.has(r))) return true;
  if (subjectKey && subjectKeyOf(m.envelope?.subject ?? '') === subjectKey) return true;
  return false;
}

export function icloudBackend(creds: ICloudCreds): EmailBackend {
  return new ICloudBackend(creds);
}

/**
 * The whole INBOX (read + unread) + its UIDVALIDITY in one connection — used by
 * the triage sweep (triage.ts), whose queue is "anything in the inbox"
 * (Lincoln, 2026-06-11), keyed on UIDs (the validity guards renumbering).
 * Read path only (fetch uses BODY.PEEK; flags untouched). INBOX ids stay bare,
 * so triage-state keys are unchanged.
 */
export async function icloudInboxWithValidity(
  creds: ICloudCreds,
  limit: number,
): Promise<{ uidValidity: string; inboxTotal: number; emails: Email[] }> {
  return withRetry(async () => {
    const client = buildImap(creds);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity =
        client.mailbox && typeof client.mailbox !== 'boolean' ? String(client.mailbox.uidValidity ?? '') : '';
      const total = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0;
      if (!total) return { uidValidity, inboxTotal: 0, emails: [] };
      const start = Math.max(1, total - limit + 1);
      const fetched = await client.fetchAll(`${start}:*`, FULL_QUERY);
      const emails = await Promise.all(fetched.map((m) => toEmail(m)));
      return {
        uidValidity,
        inboxTotal: total,
        emails: emails.sort((a, b) => b.date.localeCompare(a.date)),
      };
    } finally {
      lock.release();
      try { await client.logout(); } catch { /* best-effort close */ }
    }
  });
}
