/**
 * Message body text helpers — pure, no I/O.
 *
 * Shared by both backends so an HTML-only message reads the same way whether it
 * arrived over IMAP or the Gmail API. Marketing and booking-confirmation mail is
 * frequently single-part text/html; without this the raw markup escapes as the
 * message body, into a read, a search snippet, or a quoted reply.
 */

export function cleanWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    // Tags collapse to spaces, which otherwise strand one at each line edge.
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Reduce an HTML body to rough plain text, keeping paragraph and line breaks. */
export function stripHtml(html: string): string {
  return cleanWhitespace(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"'),
  );
}
