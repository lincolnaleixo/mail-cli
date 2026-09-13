import { describe, expect, test } from 'bun:test';
import { buildRaw } from './gmail';
import type { OutgoingMessage } from './types';

/** Decode what Gmail would receive, so assertions run against the real wire format. */
function headerLines(msg: OutgoingMessage, from = 'me@example.com'): string[] {
  const decoded = Buffer.from(buildRaw(msg, from), 'base64url').toString('utf-8');
  return decoded.split('\r\n\r\n')[0]!.split('\r\n');
}

const base: OutgoingMessage = { to: 'hotel@example.com', subject: 'Booking', body: 'hi' };

describe('buildRaw — threading headers', () => {
  test('emits In-Reply-To and References when supplied', () => {
    const lines = headerLines({ ...base, inReplyTo: '<parent@x>', references: ['<root@x>', '<parent@x>'] });
    expect(lines).toContain('In-Reply-To: <parent@x>');
    expect(lines).toContain('References: <root@x> <parent@x>');
  });

  test('omits both when absent', () => {
    const joined = headerLines(base).join('\n');
    expect(joined).not.toContain('In-Reply-To');
    expect(joined).not.toContain('References');
  });

  test('adds angle brackets to a bare message id', () => {
    expect(headerLines({ ...base, inReplyTo: 'parent@x' })).toContain('In-Reply-To: <parent@x>');
  });

  test('folds a long References chain within the line limit', () => {
    const chain = Array.from({ length: 40 }, (_, i) => `<message-${i}@quite-long-domain.example.com>`);
    for (const line of headerLines({ ...base, references: chain })) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });
});

describe('buildRaw — subject encoding', () => {
  test('emits a plain Subject for ASCII, so Gmail thread matching sees it verbatim', () => {
    expect(headerLines(base)).toContain('Subject: Booking');
  });

  test('encodes a non-ASCII subject', () => {
    const line = headerLines({ ...base, subject: 'Reserva confirmada ✓' }).find((l) =>
      l.startsWith('Subject:'),
    )!;
    expect(line).toContain('=?UTF-8?B?');
    expect(Buffer.from(line.replace(/^Subject: =\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString()).toBe(
      'Reserva confirmada ✓',
    );
  });
});

describe('buildRaw — header injection', () => {
  test('rejects CRLF in every interpolated address field', () => {
    const attack = 'a@b.com\r\nBcc: attacker@example.com';
    expect(() => buildRaw({ ...base, to: attack })).toThrow('refusing to build the message');
    expect(() => buildRaw({ ...base, cc: attack })).toThrow();
    expect(() => buildRaw({ ...base, bcc: attack })).toThrow();
    expect(() => buildRaw({ ...base, replyTo: attack })).toThrow();
  });

  test('rejects CRLF in the subject', () => {
    expect(() => buildRaw({ ...base, subject: 'x\r\nBcc: attacker@example.com' })).toThrow();
  });

  test('rejects a malformed message id rather than emitting it', () => {
    expect(() => buildRaw({ ...base, inReplyTo: 'not a valid id' })).toThrow('not a valid RFC 5322 message id');
  });
});

describe('buildRaw — attachments', () => {
  const withFile = (extra: Partial<OutgoingMessage> = {}): string => {
    const path = `${import.meta.dir}/../README.md`;
    const raw = buildRaw({ ...base, attachments: [{ path }], ...extra }, 'me@example.com');
    return Buffer.from(raw, 'base64url').toString('utf-8');
  };

  test('wraps the message in multipart/mixed with the file base64-encoded', () => {
    const decoded = withFile();
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain('Content-Disposition: attachment; filename="README.md"');
    expect(decoded).toContain('Content-Type: text/markdown; name="README.md"');
    // The attachment body must round-trip to the real file bytes.
    const b64 = decoded.split('Content-Disposition: attachment; filename="README.md"')[1]!
      .split('\r\n\r\n')[1]!.split('\r\n--')[0]!.replace(/\r\n/g, '');
    expect(Buffer.from(b64, 'base64').toString()).toContain('# mail-cli');
  });

  test('keeps multipart/alternative nested inside multipart/mixed when html is set', () => {
    const decoded = withFile({ html: '<p>hi</p>' });
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain('multipart/alternative');
    expect(decoded).toContain('<p>hi</p>');
  });

  test('base64 body lines stay within the RFC 2045 76-char limit', () => {
    const decoded = withFile();
    const attachment = decoded.split('Content-Transfer-Encoding: base64')[1]!;
    for (const line of attachment.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  test('rejects a missing file', () => {
    expect(() => buildRaw({ ...base, attachments: [{ path: '/nonexistent/file.pdf' }] })).toThrow(
      'attachment not found',
    );
  });

  test('no attachments leaves the message single-part as before', () => {
    const decoded = Buffer.from(buildRaw(base, 'me@example.com'), 'base64url').toString();
    expect(decoded).not.toContain('multipart/mixed');
  });
});

describe('buildRaw — existing behavior preserved', () => {
  test('still emits both parts for a multipart/alternative message', () => {
    const decoded = Buffer.from(buildRaw({ ...base, html: '<p>hi</p>' }, 'me@example.com'), 'base64url').toString();
    expect(decoded).toContain('multipart/alternative');
    expect(decoded).toContain('text/plain');
    expect(decoded).toContain('text/html');
    expect(decoded).toContain('<p>hi</p>');
  });

  test('keeps To, From, and MIME-Version', () => {
    const lines = headerLines(base);
    expect(lines).toContain('To: hotel@example.com');
    expect(lines).toContain('From: me@example.com');
    expect(lines).toContain('MIME-Version: 1.0');
  });
});
