import { describe, expect, test } from 'bun:test';
import { buildReply } from './reply';
import type { Email } from './types';

/** A minimal received message; each test overrides only what it exercises. */
function original(overrides: Partial<Email> = {}): Email {
  return {
    id: '1',
    account: 'gmail',
    threadId: 'thread-abc',
    from: 'Hotel <hotel@example.com>',
    to: 'lincolnmorais@gmail.com',
    subject: 'Upcoming Stay',
    date: 'Fri, 31 Jul 2026 02:05:54 +0100',
    messageId: '<parent@example.com>',
    snippet: '',
    body: 'Check in is from 4pm.',
    labelIds: [],
    isUnread: false,
    ...overrides,
  };
}

describe('buildReply — References chain (RFC 5322 §3.6.4)', () => {
  test('extends the parent chain and appends the parent id last', () => {
    const msg = buildReply(original({ references: ['<root@x>', '<mid@x>'] }), { body: 'ok' });
    expect(msg.references).toEqual(['<root@x>', '<mid@x>', '<parent@example.com>']);
    expect(msg.inReplyTo).toBe('<parent@example.com>');
  });

  test('seeds from In-Reply-To when the parent has no References', () => {
    const msg = buildReply(original({ inReplyTo: '<grandparent@x>' }), { body: 'ok' });
    expect(msg.references).toEqual(['<grandparent@x>', '<parent@example.com>']);
  });

  test('is exactly the parent id when the parent has neither', () => {
    expect(buildReply(original(), { body: 'ok' }).references).toEqual(['<parent@example.com>']);
  });

  test('emits neither header when the parent has no Message-ID', () => {
    const msg = buildReply(original({ messageId: undefined }), { body: 'ok' });
    expect(msg.inReplyTo).toBeUndefined();
    expect(msg.references).toBeUndefined();
  });

  test('degrades to unthreaded rather than throwing on a malformed parent id', () => {
    const msg = buildReply(original({ messageId: 'not a <valid> id' }), { body: 'ok' });
    expect(msg.inReplyTo).toBeUndefined();
    expect(msg.references).toBeUndefined();
  });

  test('drops malformed inherited ids but keeps the good ones', () => {
    const msg = buildReply(original({ references: ['<good@x>', 'garbage'] }), { body: 'ok' });
    expect(msg.references).toEqual(['<good@x>', '<parent@example.com>']);
  });

  test('dedupes while preserving first occurrence', () => {
    const msg = buildReply(original({ references: ['<a@x>', '<a@x>', '<b@x>'] }), { body: 'ok' });
    expect(msg.references).toEqual(['<a@x>', '<b@x>', '<parent@example.com>']);
  });

  test('caps a pathological chain, keeping the root and the most recent', () => {
    const long = Array.from({ length: 60 }, (_, i) => `<m${i}@x>`);
    const refs = buildReply(original({ references: long }), { body: 'ok' }).references!;
    expect(refs).toHaveLength(25);
    expect(refs[0]).toBe('<m0@x>');
    expect(refs.at(-1)).toBe('<parent@example.com>');
  });
});

describe('buildReply — recipient', () => {
  test('answers From by default', () => {
    expect(buildReply(original(), { body: 'ok' }).to).toBe('Hotel <hotel@example.com>');
  });

  test('honors Reply-To over From', () => {
    const msg = buildReply(original({ replyTo: 'bookings@example.com' }), { body: 'ok' });
    expect(msg.to).toBe('bookings@example.com');
  });

  test('an explicit `to` wins over both', () => {
    const msg = buildReply(original({ replyTo: 'bookings@example.com' }), { body: 'ok', to: 'other@x.com' });
    expect(msg.to).toBe('other@x.com');
  });

  test('never inherits cc or bcc — no implicit reply-all', () => {
    const msg = buildReply(original({ to: 'a@x.com, b@x.com' }), { body: 'ok' });
    expect(msg.cc).toBeUndefined();
    expect(msg.bcc).toBeUndefined();
  });

  test('carries an explicit cc through', () => {
    expect(buildReply(original(), { body: 'ok', cc: 'gabi@x.com' }).cc).toBe('gabi@x.com');
  });
});

describe('buildReply — subject and threadId', () => {
  test('prefixes Re: once', () => {
    expect(buildReply(original(), { body: 'ok' }).subject).toBe('Re: Upcoming Stay');
  });

  test('does not double-prefix a reply to a reply', () => {
    expect(buildReply(original({ subject: 'Re: Upcoming Stay' }), { body: 'ok' }).subject).toBe(
      'Re: Upcoming Stay',
    );
  });

  test('an explicit subject wins', () => {
    expect(buildReply(original(), { body: 'ok', subject: 'Custom' }).subject).toBe('Custom');
  });

  test('passes the Gmail threadId through, and omits an empty one', () => {
    expect(buildReply(original(), { body: 'ok' }).threadId).toBe('thread-abc');
    expect(buildReply(original({ threadId: '' }), { body: 'ok' }).threadId).toBeUndefined();
  });
});

describe('buildReply — body', () => {
  test('quotes the original beneath the reply by default', () => {
    const msg = buildReply(original(), { body: 'See you then.' });
    expect(msg.body).toContain('See you then.');
    expect(msg.body).toContain('wrote:');
    expect(msg.body).toContain('> Check in is from 4pm.');
  });

  test('omits the quote when asked', () => {
    const msg = buildReply(original(), { body: 'See you then.', quote: false });
    expect(msg.body).toBe('See you then.');
  });

  test('quotes blank lines as a bare marker', () => {
    const msg = buildReply(original({ body: 'one\n\ntwo' }), { body: 'hi' });
    expect(msg.body).toContain('> one\n>\n> two');
  });

  test('builds a blockquote when replying in HTML', () => {
    const msg = buildReply(original(), { body: 'plain', html: '<p>rich</p>' });
    expect(msg.html).toContain('<p>rich</p>');
    expect(msg.html).toContain('<blockquote');
  });

  test('escapes HTML in the quoted original', () => {
    const msg = buildReply(original({ body: '<script>alert(1)</script>' }), {
      body: 'hi',
      html: '<p>hi</p>',
    });
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('&lt;script&gt;');
  });
});
