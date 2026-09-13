/**
 * RFC 5322 header primitives — pure, no I/O.
 *
 * Two jobs: keep operator-supplied values from breaking out of their header
 * line, and give both backends one shared understanding of message ids and
 * reply subjects. The iCloud thread reader and the reply builder must agree on
 * what "the same subject" and "a message id" mean, so those live here rather
 * than being defined twice.
 */

/** Longest permitted header line, per RFC 5322 §2.1.1 (998 octets + CRLF). */
const MAX_LINE_OCTETS = 998;

/**
 * Reject a value that could inject extra headers into a raw MIME message.
 * Returns the value trimmed of surrounding whitespace so callers can inline it.
 */
export function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`header "${name}" contains a line break or NUL; refusing to build the message`);
  }
  return value.trim();
}

/**
 * Canonicalize one message id to `<local@domain>`. Angle brackets are added
 * when missing. The `@` is required: RFC 5322 §3.6.4 defines a msg-id as
 * `id-left "@" id-right`, so a bare word is not one, and accepting it would let
 * a stray token pose as a link in a References chain.
 */
export function normalizeMessageId(raw: string): string {
  const trimmed = raw.trim();
  const bracketed = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`;
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(bracketed)) {
    throw new Error(`"${raw}" is not a valid RFC 5322 message id`);
  }
  return bracketed;
}

/**
 * Pull every `<...>` token out of a References / In-Reply-To header value.
 * Lenient by design: this parses values written by other people's mail clients,
 * where malformed input must be dropped rather than throw.
 */
export function parseMessageIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  return (raw.match(/<[^<>\s]+>/g) ?? []).map((s) => s.trim());
}

/**
 * Fold a header onto continuation lines so no line exceeds the RFC limit.
 * Gmail transmits our `raw` verbatim, so a long References chain would
 * otherwise produce an oversized line.
 */
export function foldHeader(name: string, value: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = `${name}:`;
  for (const token of tokens) {
    if (current.length + 1 + token.length > MAX_LINE_OCTETS) {
      lines.push(current);
      current = ` ${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  lines.push(current);
  return lines.join('\r\n');
}

/**
 * Strip every leading reply/forward prefix across common locales.
 */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd|fw|aw|wg|res|enc)\s*:\s*)+/i, '').trim();
}

/** `Re: <subject>` — idempotent, so a reply to a reply keeps exactly one prefix. */
export function replySubject(subject: string): string {
  const base = normalizeSubject(subject);
  return base ? `Re: ${base}` : 'Re:';
}
