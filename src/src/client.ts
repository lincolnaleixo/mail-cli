/**
 * Account router.
 *
 * Maps an `--account` selector to one or more backends, then dispatches.
 *   personal (default) → fan across gmail + icloud for reads;
 *                        ambiguous (errors) for archive/trash/draft/send.
 *   gmail              → gmail-personal only.
 *   icloud             → icloud only.
 *   lln|company|empresa|longlifenutri → gmail-lln only.
 *
 * The canonical keyword→account map lives in SKILL.md (ACCOUNT ROUTING); keep
 * the two in sync.
 */

import { gmailBackend } from './gmail';
import { icloudBackend } from './icloud';
import { gmailLlnCreds, gmailPersonalCreds, icloudCreds } from './creds';
import { buildReply, type ReplyInput } from './reply';
import { isRetryableSendFailure } from './transient';
import type {
  Account,
  AttachmentMeta,
  DraftResult,
  Email,
  EmailBackend,
  FolderInfo,
  OutgoingMessage,
  SearchOptions,
  SendResult,
} from './types';

export function normalizeSelector(raw: string): 'personal' | Account {
  const s = raw.trim().toLowerCase();
  if (s === 'personal') return 'personal';
  if (s === 'gmail' || s === 'google') return 'gmail';
  if (s === 'icloud') return 'icloud';
  if (s === 'lln' || s === 'company' || s === 'empresa' || s === 'longlifenutri') return 'lln';
  throw new Error(
    `unknown account "${raw}". Use one of: personal | gmail | icloud | lln (aliases: company, empresa, longlifenutri)`,
  );
}

function makeBackend(account: Account): EmailBackend {
  switch (account) {
    case 'gmail':
      return gmailBackend('gmail', gmailPersonalCreds());
    case 'lln':
      return gmailBackend('lln', gmailLlnCreds());
    case 'icloud':
      return icloudBackend(icloudCreds());
  }
}

/** Backends to read from. `personal` fans across gmail + icloud. */
function readBackends(selector: string): EmailBackend[] {
  const n = normalizeSelector(selector);
  if (n === 'personal') return [makeBackend('gmail'), makeBackend('icloud')];
  return [makeBackend(n)];
}

/** Single concrete backend required for a write/destructive op. */
function writeBackend(selector: string, op: string): EmailBackend {
  const n = normalizeSelector(selector);
  if (n === 'personal') {
    throw new Error(
      `--account personal is ambiguous for "${op}". Pick an explicit account: ` +
        `gmail or icloud (or lln/company for LongLifeNutri).`,
    );
  }
  return makeBackend(n);
}

export interface FanResult {
  emails: Email[];
  /** Per-backend failures (e.g. one inbox unreachable) — surfaced as warnings. */
  errors: string[];
}

async function fan(
  backends: EmailBackend[],
  fn: (b: EmailBackend) => Promise<Email[]>,
  limit?: number,
): Promise<FanResult> {
  const settled = await Promise.allSettled(backends.map(fn));
  const emails: Email[] = [];
  const errors: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') emails.push(...r.value);
    else errors.push(`${backends[i]?.account ?? 'unknown'}: ${r.reason?.message ?? r.reason}`);
  });
  emails.sort((a, b) => b.date.localeCompare(a.date));
  // Cap the MERGED set so a fanned `personal` read returns `limit` total, not limit-per-backend.
  return { emails: limit != null ? emails.slice(0, limit) : emails, errors };
}

export function listInbox(selector: string, limit: number): Promise<FanResult> {
  return fan(readBackends(selector), (b) => b.inbox(limit), limit);
}

export function listUnread(selector: string, limit: number): Promise<FanResult> {
  return fan(readBackends(selector), (b) => b.unread(limit), limit);
}

export function searchEmails(
  selector: string,
  query: string,
  limit: number,
  opts?: SearchOptions,
): Promise<FanResult> {
  return fan(readBackends(selector), (b) => b.search(query, limit, opts), limit);
}

/** Read a single message. `personal` tries each backend until one resolves the id. */
export async function readEmail(selector: string, id: string): Promise<Email> {
  const backends = readBackends(selector);
  if (backends.length === 1) return backends[0]!.read(id);
  const errors: string[] = [];
  for (const b of backends) {
    try {
      return await b.read(id);
    } catch (e) {
      errors.push(`${b.account}: ${(e as Error).message}`);
    }
  }
  throw new Error(`message "${id}" not found in personal accounts (${errors.join('; ')})`);
}

export function archiveEmail(selector: string, id: string): Promise<void> {
  return writeBackend(selector, 'archive').archive(id);
}

export function moveEmail(selector: string, id: string, destination: string): Promise<void> {
  return writeBackend(selector, 'move').move(id, destination);
}

export function trashEmail(selector: string, id: string): Promise<void> {
  return writeBackend(selector, 'trash').trash(id);
}

export function draftEmail(selector: string, msg: OutgoingMessage) {
  return writeBackend(selector, 'draft').draft(msg);
}

/**
 * Draft a threaded reply to an existing message.
 *
 * The backend is resolved once and used for BOTH the read and the write: the
 * derived threadId belongs to that account, so reading through the fanning
 * `readEmail` could pair a Gmail thread with a different backend.
 */
export async function replyEmail(
  selector: string,
  id: string,
  input: ReplyInput,
): Promise<{ account: Account; original: Email; draft: DraftResult }> {
  const backend = writeBackend(selector, 'reply');
  const original = await backend.read(id);
  const draft = await backend.draft(buildReply(original, input));
  return { account: backend.account, original, draft };
}

/**
 * Second route for an outgoing message when its own account cannot send.
 *
 * iCloud's SMTP is the flaky one (2026-08-18: hours of IMAP and connection
 * faults), and Lincoln's Gmail can carry the message instead. Gmail and LLN have
 * no fallback: they are the fallback.
 */
const SEND_FALLBACK: Partial<Record<Account, Account>> = { icloud: 'gmail' };

/**
 * Send through `primary`, falling back to `fallback` only when the message
 * provably never left (see `isRetryableSendFailure`). Anything ambiguous throws,
 * because a second attempt could deliver the same message twice.
 */
export async function sendWithFallback(
  primary: EmailBackend,
  fallback: EmailBackend | null,
  msg: OutgoingMessage,
): Promise<SendResult> {
  try {
    return await primary.send(msg);
  } catch (error) {
    if (!fallback || !isRetryableSendFailure(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    // `from` and `threadId` belong to the primary account: the fallback sends
    // under its own identity, as a new conversation.
    const { from: _from, threadId: _threadId, ...portable } = msg;
    const result = await fallback.send(portable);
    return {
      ...result,
      sentVia: fallback.account,
      fallbackFrom: primary.account,
      fallbackReason: reason,
    };
  }
}

export function sendEmail(selector: string, msg: OutgoingMessage, allowFallback = false): Promise<SendResult> {
  const primary = writeBackend(selector, 'send');
  const fallback = allowFallback ? SEND_FALLBACK[primary.account] : undefined;
  return sendWithFallback(primary, fallback ? makeBackend(fallback) : null, msg);
}

export interface FoldersResult {
  results: { account: Account; folders: FolderInfo[] }[];
  errors: string[];
}

/** List folders/labels across the selected account(s). */
export async function listFolders(selector: string): Promise<FoldersResult> {
  const backends = readBackends(selector);
  const settled = await Promise.allSettled(
    backends.map((b) => b.folders().then((folders) => ({ account: b.account, folders }))),
  );
  const results: { account: Account; folders: FolderInfo[] }[] = [];
  const errors: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(r.value);
    else errors.push(`${backends[i]?.account ?? 'unknown'}: ${r.reason?.message ?? r.reason}`);
  });
  return { results, errors };
}

/** Conversation view. `personal` tries each backend until one resolves the id. */
export async function threadEmails(selector: string, id: string): Promise<Email[]> {
  const backends = readBackends(selector);
  const errors: string[] = [];
  for (const b of backends) {
    try {
      const emails = await b.thread(id);
      return emails.slice().sort((a, e) => (Date.parse(a.date) || 0) - (Date.parse(e.date) || 0));
    } catch (e) {
      errors.push(`${b.account}: ${(e as Error).message}`);
    }
  }
  throw new Error(`thread for "${id}" not found (${errors.join('; ')})`);
}

/** Attachment metadata for a message. `personal` tries each backend until one resolves the id. */
export async function listAttachments(
  selector: string,
  id: string,
): Promise<{ account: Account; items: AttachmentMeta[] }> {
  const backends = readBackends(selector);
  const errors: string[] = [];
  for (const b of backends) {
    try {
      return { account: b.account, items: await b.attachments(id) };
    } catch (e) {
      errors.push(`${b.account}: ${(e as Error).message}`);
    }
  }
  throw new Error(`attachments for "${id}" not found (${errors.join('; ')})`);
}

/** Download every attachment of a message into outDir. Tries each backend for `personal`. */
export async function downloadAttachments(
  selector: string,
  id: string,
  outDir: string,
): Promise<{ account: Account; paths: string[] }> {
  const backends = readBackends(selector);
  const errors: string[] = [];
  for (const b of backends) {
    try {
      const items = await b.attachments(id);
      const paths: string[] = [];
      for (let i = 0; i < items.length; i++) paths.push(await b.downloadAttachment(id, i, outDir));
      return { account: b.account, paths };
    } catch (e) {
      errors.push(`${b.account}: ${(e as Error).message}`);
    }
  }
  throw new Error(`attachments for "${id}" not found (${errors.join('; ')})`);
}

/** Download one attachment by index. Used by review generation to enforce byte ceilings before reading bytes. */
export async function downloadAttachment(
  selector: string,
  id: string,
  index: number,
  outDir: string,
): Promise<{ account: Account; path: string }> {
  const backends = readBackends(selector);
  const errors: string[] = [];
  for (const b of backends) {
    try {
      return { account: b.account, path: await b.downloadAttachment(id, index, outDir) };
    } catch (e) {
      errors.push(`${b.account}: ${(e as Error).message}`);
    }
  }
  throw new Error(`attachment ${index} for "${id}" not found (${errors.join('; ')})`);
}
