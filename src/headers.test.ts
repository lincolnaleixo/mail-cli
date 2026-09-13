import { describe, expect, test } from 'bun:test';
import {
  assertHeaderSafe,
  foldHeader,
  normalizeMessageId,
  normalizeSubject,
  parseMessageIdList,
  replySubject,
} from './headers';

describe('assertHeaderSafe', () => {
  test('passes an ordinary value through, trimmed', () => {
    expect(assertHeaderSafe('To', '  a@b.com ')).toBe('a@b.com');
  });

  test('rejects header injection via CRLF', () => {
    expect(() => assertHeaderSafe('To', 'a@b.com\r\nBcc: attacker@example.com')).toThrow(
      'refusing to build the message',
    );
  });

  test('rejects bare CR, bare LF, and NUL', () => {
    expect(() => assertHeaderSafe('Cc', 'a@b.com\rBcc: x@y.com')).toThrow();
    expect(() => assertHeaderSafe('Cc', 'a@b.com\nBcc: x@y.com')).toThrow();
    expect(() => assertHeaderSafe('Cc', 'a@b.com\0')).toThrow();
  });
});

describe('normalizeMessageId', () => {
  test('adds missing angle brackets', () => {
    expect(normalizeMessageId('abc@mail.example')).toBe('<abc@mail.example>');
  });

  test('keeps an already-canonical id', () => {
    expect(normalizeMessageId('<abc@mail.example>')).toBe('<abc@mail.example>');
  });

  test('rejects two ids, embedded whitespace, and empty input', () => {
    expect(() => normalizeMessageId('<a@b> <c@d>')).toThrow('not a valid RFC 5322 message id');
    expect(() => normalizeMessageId('<a b@c>')).toThrow();
    expect(() => normalizeMessageId('')).toThrow();
  });
});

describe('parseMessageIdList', () => {
  test('returns an empty list for empty or absent input', () => {
    expect(parseMessageIdList('')).toEqual([]);
    expect(parseMessageIdList(undefined)).toEqual([]);
  });

  test('extracts one id and many ids in order', () => {
    expect(parseMessageIdList('<a@x>')).toEqual(['<a@x>']);
    expect(parseMessageIdList('<a@x> <b@x> <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  test('reads a folded header value', () => {
    expect(parseMessageIdList('<a@x>\r\n <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  test('drops malformed tokens instead of throwing', () => {
    expect(parseMessageIdList('garbage <a@x> more')).toEqual(['<a@x>']);
  });
});

describe('foldHeader', () => {
  const chain = Array.from({ length: 40 }, (_, i) => `<message-${i}@quite-long-domain.example.com>`);

  test('keeps every line within the RFC limit', () => {
    for (const line of foldHeader('References', chain.join(' ')).split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  test('starts continuation lines with a space', () => {
    const [first, ...rest] = foldHeader('References', chain.join(' ')).split('\r\n');
    expect(first!.startsWith('References:')).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
    for (const line of rest) expect(line.startsWith(' ')).toBe(true);
  });

  test('round-trips back to the original list', () => {
    expect(parseMessageIdList(foldHeader('References', chain.join(' ')))).toEqual(chain);
  });

  test('leaves a short value on one line', () => {
    expect(foldHeader('In-Reply-To', '<a@x>')).toBe('In-Reply-To: <a@x>');
  });
});

describe('normalizeSubject', () => {
  test('strips reply and forward prefixes across locales', () => {
    expect(normalizeSubject('Re: Booking')).toBe('Booking');
    expect(normalizeSubject('FWD: Booking')).toBe('Booking');
    expect(normalizeSubject('AW: Booking')).toBe('Booking');
    expect(normalizeSubject('RES: Booking')).toBe('Booking');
    expect(normalizeSubject('ENC: Booking')).toBe('Booking');
  });

  test('strips a run of stacked prefixes', () => {
    expect(normalizeSubject('Re: RE: Fwd: Booking')).toBe('Booking');
  });

  test('preserves the original casing of the subject itself', () => {
    expect(normalizeSubject('Re: Booking Confirmation')).toBe('Booking Confirmation');
  });
});

describe('replySubject', () => {
  test('adds one prefix to a bare subject', () => {
    expect(replySubject('Booking')).toBe('Re: Booking');
  });

  test('is idempotent and never double-prefixes', () => {
    expect(replySubject('Re: Booking')).toBe('Re: Booking');
    expect(replySubject('RE: re: Booking')).toBe('Re: Booking');
    expect(replySubject(replySubject('Booking'))).toBe('Re: Booking');
  });

  test('replaces a forward prefix with a reply prefix', () => {
    expect(replySubject('Fwd: Booking')).toBe('Re: Booking');
  });

  test('handles an empty subject', () => {
    expect(replySubject('')).toBe('Re:');
  });
});
