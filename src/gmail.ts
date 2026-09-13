/**
 * Gmail backend — used by both gmail-personal and gmail-secondary accounts.
 *
 * Calls the Gmail REST API directly using an OAuth refresh token. Keeping this
 * adapter dependency-free makes the installed cross-harness skill portable.
 */

import { writeFileSync } from 'fs';
import { loadAttachments } from './attachments';
import { assertHeaderSafe, foldHeader, normalizeMessageId, parseMessageIdList } from './headers';
import { resolveAllowedSender } from './sender';
import { stripHtml } from './text';
import type {
  Account,
  AttachmentMeta,
  DraftResult,
  Email,
  EmailBackend,
  FolderInfo,
  GmailAccountCreds,
  OutgoingMessage,
  SendResult,
} from './types';

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:\0]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'attachment';
}

interface GmailAttachment extends AttachmentMeta {
  attachmentId: string;
}

interface GmailHeader { name?: string | null; value?: string | null }
interface GmailPartBody { attachmentId?: string | null; size?: number | null; data?: string | null }
interface GmailPart {
  filename?: string | null;
  mimeType?: string | null;
  body?: GmailPartBody | null;
  headers?: GmailHeader[] | null;
  parts?: GmailPart[] | null;
}
interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  payload?: GmailPart | null;
}
interface GmailLabel {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  messagesTotal?: number | null;
}

/** Walk a (possibly nested) payload for parts that carry an attachment. */
function collectAttachments(payload?: GmailPart | null): GmailAttachment[] {
  const out: GmailAttachment[] = [];
  const walk = (p?: GmailPart | null): void => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        size: p.body.size ?? 0,
        attachmentId: p.body.attachmentId,
      });
    }
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return out;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getHeader(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function getBody(payload?: GmailPart | null): string {
  if (!payload) return '';
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    // A single-part text/html message has no `parts` to fall through to, so it
    // must be stripped here or the raw markup escapes as the body.
    return payload.mimeType === 'text/html' ? stripHtml(decoded) : decoded;
  }

  const parts = payload.parts ?? [];
  // Prefer text/plain anywhere in the (possibly nested) tree.
  const findPlain = (ps: GmailPart[]): string | null => {
    for (const p of ps) {
      if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data);
      if (p.parts) {
        const nested = findPlain(p.parts);
        if (nested) return nested;
      }
    }
    return null;
  };
  const plain = findPlain(parts);
  if (plain) return plain;

  // Fall back to HTML, stripped to rough plain text.
  const findHtml = (ps: GmailPart[]): string | null => {
    for (const p of ps) {
      if (p.mimeType === 'text/html' && p.body?.data) return decodeBase64Url(p.body.data);
      if (p.parts) {
        const nested = findHtml(p.parts);
        if (nested) return nested;
      }
    }
    return null;
  };
  const html = findHtml(parts);
  if (html) return stripHtml(html);
  return '';
}

function toEmail(account: Account, msg: GmailMessage): Email {
  const headers = msg.payload?.headers ?? [];
  const references = parseMessageIdList(getHeader(headers, 'References'));
  return {
    id: msg.id ?? '',
    account,
    threadId: msg.threadId ?? '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    messageId: getHeader(headers, 'Message-ID') || undefined,
    inReplyTo: getHeader(headers, 'In-Reply-To') || undefined,
    references: references.length ? references : undefined,
    replyTo: getHeader(headers, 'Reply-To') || undefined,
    snippet: msg.snippet ?? '',
    body: getBody(msg.payload),
    labelIds: msg.labelIds ?? [],
    isUnread: msg.labelIds?.includes('UNREAD') ?? false,
  };
}

/**
 * Encode a subject for a header line. Pure ASCII goes out verbatim: Gmail only
 * adds a message to a thread when "the Subject headers must match", and an
 * unnecessary encoded-word is one more way for that comparison to fail.
 */
function encodeSubject(subject: string): string {
  const safe = assertHeaderSafe('Subject', subject);
  if (/^[\x20-\x7E]*$/.test(safe)) return `Subject: ${safe}`;
  return `Subject: =?UTF-8?B?${Buffer.from(safe, 'utf-8').toString('base64')}?=`;
}

/** The body content as MIME lines: plain text, or multipart/alternative when `html` is set. */
function bodyLines(msg: OutgoingMessage, boundary: string): string[] {
  if (!msg.html) {
    return [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.body,
    ];
  }
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.body,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.html,
    `--${boundary}--`,
  ];
}

/**
 * Build an RFC 2822 message and base64url-encode it for the Gmail API.
 * When `html` is set, emits multipart/alternative so rich clients render HTML
 * while plain-text clients still see `body`. When `attachments` are present,
 * the whole message is wrapped in multipart/mixed with each file base64-encoded.
 *
 * Every interpolated value is checked for CR/LF first — Gmail transmits this
 * string verbatim, so an unchecked address could inject its own headers.
 */
export function buildRaw(msg: OutgoingMessage, from?: string): string {
  const headers: string[] = [`To: ${assertHeaderSafe('To', msg.to)}`];
  if (from) headers.push(`From: ${assertHeaderSafe('From', from)}`);
  headers.push(encodeSubject(msg.subject));
  headers.push('MIME-Version: 1.0');
  if (msg.cc) headers.push(`Cc: ${assertHeaderSafe('Cc', msg.cc)}`);
  if (msg.bcc) headers.push(`Bcc: ${assertHeaderSafe('Bcc', msg.bcc)}`);
  if (msg.replyTo) headers.push(`Reply-To: ${assertHeaderSafe('Reply-To', msg.replyTo)}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${normalizeMessageId(msg.inReplyTo)}`);
  if (msg.references?.length) {
    // A deep chain would otherwise exceed the 998-octet line limit.
    headers.push(foldHeader('References', msg.references.map(normalizeMessageId).join(' ')));
  }

  const altBoundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const files = loadAttachments(msg.attachments);

  let message: string;
  if (files.length) {
    const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const lines = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      `--${mixedBoundary}`,
      ...bodyLines(msg, altBoundary),
    ];
    for (const f of files) {
      lines.push(
        `--${mixedBoundary}`,
        `Content-Type: ${f.mimeType}; name="${f.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${f.filename}"`,
        '',
        // RFC 2045 §6.8: base64 body lines must stay within 76 characters.
        f.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      );
    }
    lines.push(`--${mixedBoundary}--`);
    message = lines.join('\r\n');
  } else {
    message = [...headers, ...bodyLines(msg, altBoundary)].join('\r\n');
  }

  return Buffer.from(message, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

class GmailBackend implements EmailBackend {
  readonly account: Account;
  private creds: GmailAccountCreds;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(account: Account, creds: GmailAccountCreds) {
    this.account = account;
    this.creds = creds;
  }

  private async token(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.creds.client_id,
        client_secret: this.creds.client_secret,
        refresh_token: this.creds.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) throw new Error(`Gmail OAuth failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error('Gmail OAuth response did not include an access token');
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = await this.token(!retry);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { ...init, headers });
    if (response.status === 401 && retry) {
      this.accessToken = null;
      return this.api<T>(path, init, false);
    }
    if (!response.ok) throw new Error(`Gmail API ${init.method ?? 'GET'} ${path} failed (${response.status}): ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async list(query: string, limit: number): Promise<Email[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    while (ids.length < limit) {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(500, limit - ids.length)) });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.api<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>(`/messages?${params}`);
      ids.push(...(res.messages ?? []).map((m) => m.id ?? '').filter(Boolean));
      pageToken = res.nextPageToken;
      if (!pageToken || !res.messages?.length) break;
    }
    const emails: Email[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const full = await Promise.all(chunk.map((id) => this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`)));
      emails.push(...full.map((message) => toEmail(this.account, message)));
    }
    return emails;
  }

  inbox(limit: number): Promise<Email[]> {
    return this.list('in:inbox', limit);
  }

  unread(limit: number): Promise<Email[]> {
    return this.list('is:unread in:inbox', limit);
  }

  search(query: string, limit: number): Promise<Email[]> {
    return this.list(query, limit);
  }

  async read(id: string): Promise<Email> {
    return toEmail(this.account, await this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`));
  }

  async archive(id: string): Promise<void> {
    await this.api(`/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: JSON.stringify({ removeLabelIds: ['INBOX'] }) });
  }

  async move(id: string, destination: string): Promise<void> {
    const labels = await this.api<{ labels?: GmailLabel[] }>('/labels');
    const label = (labels.labels ?? []).find(
      (item) => item.name?.toLowerCase() === destination.toLowerCase(),
    );
    if (!label?.id || label.type !== 'user') {
      throw new Error(`Gmail user label "${destination}" not found`);
    }
    await this.api(`/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      body: JSON.stringify({
        addLabelIds: [label.id],
        removeLabelIds: ['INBOX'],
      }),
    });
  }

  async trash(id: string): Promise<void> {
    await this.api(`/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' });
  }

  // Gmail only adds a message to an existing thread when all three of its
  // criteria hold: the threadId is supplied here, In-Reply-To/References are
  // RFC-compliant, and the subjects match. A mismatch can silently create a new
  // thread instead of failing, so all three are set together or not at all.
  async draft(msg: OutgoingMessage): Promise<DraftResult> {
    const from = resolveAllowedSender(this.creds.email ?? '', [], msg.from);
    const raw = buildRaw(msg, from);
    const res = await this.api<{ id?: string; message?: GmailMessage }>('/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) } }),
    });
    return {
      draftId: res.id ?? '',
      messageId: res.message?.id ?? '',
      threadId: res.message?.threadId ?? undefined,
    };
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const from = resolveAllowedSender(this.creds.email ?? '', [], msg.from);
    const raw = buildRaw(msg, from);
    const res = await this.api<GmailMessage>('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) }),
    });
    return { messageId: res.id ?? '', threadId: res.threadId ?? undefined };
  }

  async folders(): Promise<FolderInfo[]> {
    const res = await this.api<{ labels?: GmailLabel[] }>('/labels');
    return (res.labels ?? []).map((l) => ({
      name: l.name ?? l.id ?? '',
      path: l.id ?? '',
      specialUse: l.type === 'system' ? 'system' : undefined,
      messages: l.messagesTotal ?? undefined,
    }));
  }

  async thread(id: string): Promise<Email[]> {
    // `id` is a message id from a listing — resolve its thread, then pull every message.
    const meta = await this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=minimal`);
    const threadId = meta.threadId;
    if (!threadId) return [toEmail(this.account, meta)];
    const thr = await this.api<{ messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(threadId)}?format=full`);
    return (thr.messages ?? []).map((m) => toEmail(this.account, m));
  }

  async attachments(id: string): Promise<AttachmentMeta[]> {
    const res = await this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    return collectAttachments(res.payload).map(({ filename, mimeType, size }) => ({ filename, mimeType, size }));
  }

  async downloadAttachment(id: string, index: number, outDir: string): Promise<string> {
    const res = await this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    const atts = collectAttachments(res.payload);
    const att = atts[index];
    if (!att) throw new Error(`attachment index ${index} out of range (have ${atts.length})`);
    const data = await this.api<{ data?: string }>(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(att.attachmentId)}`);
    const bytes = Buffer.from((data.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const outPath = `${outDir.replace(/\/$/, '')}/${sanitizeFilename(att.filename)}`;
    writeFileSync(outPath, bytes, { flag: 'wx' });
    return outPath;
  }
}

export function gmailBackend(account: Account, creds: GmailAccountCreds): EmailBackend {
  return new GmailBackend(account, creds);
}
