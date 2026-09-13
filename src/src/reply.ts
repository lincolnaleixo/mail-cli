/**
 * Reply derivation — pure, no I/O.
 *
 * One shared implementation of RFC 5322 §3.6.4 so both backends only ever
 * *emit* threading headers, never derive them. The operator supplies a body;
 * everything that makes the message land inside the existing conversation is
 * computed from the original here.
 */

import { normalizeMessageId, parseMessageIdList, replySubject } from './headers';
import type { Email, OutgoingAttachment, OutgoingMessage } from './types';

/**
 * Defensive cap on the References chain. RFC 5322 does not sanction trimming,
 * so this only guards against a pathological chain; folding handles ordinary
 * length. The first id is kept because threading algorithms anchor on the root.
 */
const MAX_REFERENCES = 25;

/** What the operator supplies for a reply — only `body` is required. */
export interface ReplyInput {
  body: string;
  html?: string;
  /** Sender identity; validated against the account allowlist by the backend. */
  from?: string;
  /** Override the derived recipient (default: the original's Reply-To, else From). */
  to?: string;
  /** Copied recipients. Never inherited from the original — reply-all is an explicit act. */
  cc?: string;
  bcc?: string;
  /** Override the derived `Re: ...` subject. */
  subject?: string;
  /** Include the quoted original beneath the reply. Defaults to true. */
  quote?: boolean;
  /** Files to attach, read from disk when the message is built. */
  attachments?: OutgoingAttachment[];
}

/**
 * Build the References chain for a reply, per RFC 5322 §3.6.4: the parent's own
 * chain (falling back to its In-Reply-To when it has none), with the parent's
 * Message-ID appended. Order is oldest first and is load-bearing.
 */
function buildReferences(original: Email, parentId: string): string[] {
  const inherited = original.references?.length
    ? original.references
    : parseMessageIdList(original.inReplyTo);

  const chain: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...inherited, parentId]) {
    let id: string;
    try {
      id = normalizeMessageId(raw);
    } catch {
      continue; // inbound values come from other people's clients — drop, don't throw
    }
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }

  if (chain.length <= MAX_REFERENCES) return chain;
  return [chain[0]!, ...chain.slice(-(MAX_REFERENCES - 1))];
}

/** Format the attribution line that introduces the quoted original. */
function attribution(original: Email): string {
  const when = Number.isNaN(Date.parse(original.date))
    ? original.date
    : new Date(original.date).toUTCString();
  return `On ${when}, ${original.from} wrote:`;
}

/**
 * Cap on the quoted original. Booking and marketing mail is often a very long
 * HTML table; quoting all of it buries the actual reply.
 */
const MAX_QUOTED_LINES = 50;

/** Quote the original body the way every mail client does: one `> ` per line. */
function quoteText(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept = lines.slice(0, MAX_QUOTED_LINES).map((line) => (line ? `> ${line}` : '>'));
  if (lines.length > MAX_QUOTED_LINES) {
    kept.push(`> [... ${lines.length - MAX_QUOTED_LINES} more lines]`);
  }
  return kept.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Derive a threaded reply to `original`.
 *
 * When the original carries no Message-ID, neither `In-Reply-To` nor
 * `References` is emitted: a chain that omits its own parent threads worse than
 * no chain at all, and a fabricated id would be a lie.
 */
export function buildReply(original: Email, input: ReplyInput): OutgoingMessage {
  // The parent's id is inbound data: a malformed one degrades to an unthreaded
  // reply rather than failing the whole command.
  let parentId: string | undefined;
  try {
    parentId = original.messageId ? normalizeMessageId(original.messageId) : undefined;
  } catch {
    parentId = undefined;
  }

  const bodyParts = [input.body];
  if (input.quote !== false && original.body) {
    bodyParts.push('', attribution(original), quoteText(original.body));
  }

  let html: string | undefined;
  if (input.html) {
    html = input.html;
    if (input.quote !== false && original.body) {
      html +=
        `\n<p>${escapeHtml(attribution(original))}</p>\n` +
        `<blockquote type="cite">${escapeHtml(original.body).replace(/\r?\n/g, '<br>\n')}</blockquote>`;
    }
  }

  return {
    from: input.from,
    // RFC 5322 §3.6.2: a sender that set Reply-To wants answers there, not at From.
    to: input.to ?? original.replyTo ?? original.from,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject ?? replySubject(original.subject),
    body: bodyParts.join('\n'),
    html,
    inReplyTo: parentId,
    references: parentId ? buildReferences(original, parentId) : undefined,
    threadId: original.threadId || undefined,
    attachments: input.attachments,
  };
}
