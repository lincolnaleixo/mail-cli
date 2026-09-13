/**
 * Shared classification of email backend failures.
 *
 * Two jobs, both learned from a real incident (2026-08-18): Apple's IMAP server
 * answered tagged NO/BAD for two hours and let sockets stall. imapflow reports a
 * tagged failure as a bare `Error('Command failed')` and hangs the real reason
 * off `responseStatus` / `responseText` / `executedCommand`, so the journal only
 * ever said "Command failed" and the retry helper never recognised throttling as
 * transient.
 *
 * `describeImapError` puts the server's own words back into the message, and
 * `isTransientFailure` decides what may be retried or degraded. Both are used by
 * the iCloud backend and by callers that only receive the flattened message
 * string (see the operations unit's code/jobs/newsletter-router/run.ts,
 * observed in the legacy backend before this System migration).
 */

/** Socket/DNS level codes that always mean "try again later". */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Text that marks a temporary server-side refusal, wherever it appears. */
const TRANSIENT_TEXT = [
  'timeout',
  'timed out',
  'socket',
  'econnreset',
  // imapflow's message for a tagged NO/BAD: the command was refused, so nothing
  // was applied. Apple returns it while throttling.
  'command failed',
  'connection closed',
  'unexpected close',
  'throttl',
  'temporar',
  'try again',
  'server busy',
  'busy, try',
  'system error',
  'temporary system problem',
  'service unavailable',
  'server unavailable',
  'currently unavailable',
];

/**
 * Text that must never be retried or degraded: a permanent configuration,
 * credential, or policy fault. Checked before everything else.
 */
const PERMANENT_TEXT = [
  'authentication',
  'invalid credentials',
  'login failed',
  'app-specific password',
  'missing ',
  'not found',
  'does not exist',
  'is ambiguous',
];

type ImapErrorish = {
  authenticationFailed?: boolean;
  code?: string;
  message?: string;
  responseStatus?: string;
  responseText?: string;
  executedCommand?: string;
};

function asImapError(e: unknown): ImapErrorish | undefined {
  if (typeof e === 'string') return { message: e };
  if (e && typeof e === 'object') return e as ImapErrorish;
  return undefined;
}

function haystack(err: ImapErrorish, fallback: unknown): string {
  return [err.message ?? String(fallback), err.responseText, err.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * True when the failure is worth retrying (and worth degrading a single account
 * for) rather than failing closed. Auth and configuration faults are never
 * transient: they do not heal on their own and must surface immediately.
 */
export function isTransientFailure(e: unknown): boolean {
  const err = asImapError(e);
  if (!err || err.authenticationFailed) return false;
  const text = haystack(err, e);
  if (PERMANENT_TEXT.some((marker) => text.includes(marker))) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  if (TRANSIENT_TEXT.some((marker) => text.includes(marker))) return true;
  const status = (err.responseStatus ?? '').toUpperCase();
  return status === 'NO' || status === 'BAD';
}

/**
 * Rewrite an imapflow error message so it carries the server's response.
 * Returns the original message unchanged when there is nothing to add.
 */
export function describeImapError(e: unknown): string {
  const err = asImapError(e);
  if (!err) return String(e);
  const base = err.message ?? String(e);
  const status = (err.responseStatus ?? '').toUpperCase();
  if (!status && !err.responseText) return base;
  const command = err.executedCommand?.split(' ').slice(1, 3).join(' ');
  const parts = [
    status ? `IMAP ${status}` : 'IMAP',
    command ? `on ${command}` : null,
  ].filter(Boolean).join(' ');
  return err.responseText ? `${base} (${parts}: ${err.responseText})` : `${base} (${parts})`;
}

/**
 * SMTP/API codes that prove the message was never handed to the server, so the
 * same message can safely be sent again through another account.
 *
 * `EMESSAGE` is deliberately absent: it means the failure happened while the
 * body was being streamed, when the server may already have accepted it.
 * Falling back there would risk sending the message twice.
 */
const SEND_NEVER_LEFT_CODES = new Set([
  'EAUTH',
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDNS',
  'ENOTFOUND',
  'ESOCKET',
  'ETIMEDOUT',
  'EENVELOPE',
]);

const SEND_NEVER_LEFT_TEXT = [
  'getaddrinfo',
  'connect econnrefused',
  'connection timeout',
  'greeting never received',
  'invalid login',
  'authentication failed',
  'authentication unsuccessful',
];

/**
 * True when an outgoing message provably never left, so retrying it through a
 * different account cannot deliver it twice. Defaults to false: an ambiguous
 * failure must surface rather than risk a duplicate send.
 */
export function isRetryableSendFailure(e: unknown): boolean {
  const err = asImapError(e) as (ImapErrorish & { code?: string }) | undefined;
  if (!err) return false;
  if (err.code === 'EMESSAGE') return false;
  if (err.code && SEND_NEVER_LEFT_CODES.has(err.code)) return true;
  const text = (err.message ?? String(e)).toLowerCase();
  return SEND_NEVER_LEFT_TEXT.some((marker) => text.includes(marker));
}
