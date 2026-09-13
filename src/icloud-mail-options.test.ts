import { describe, expect, test } from 'bun:test';
import { mailOptions } from './icloud';
import type { OutgoingMessage } from './types';

const base: OutgoingMessage = { to: 'hotel@example.com', subject: 'Booking', body: 'hi' };

describe('mailOptions', () => {
  test('passes In-Reply-To through for nodemailer to emit', () => {
    expect(mailOptions({ ...base, inReplyTo: '<parent@example.test>' }, 'sender@example.test').inReplyTo).toBe('<parent@example.test>');
  });

  test('joins the References chain into one header value', () => {
    const opts = mailOptions({ ...base, references: ['<root@example.test>', '<parent@example.test>'] }, 'sender@example.test');
    expect(opts.references).toBe('<root@x> <parent@x>');
  });

  test('leaves threading fields undefined when absent', () => {
    const opts = mailOptions(base, 'sender@example.test');
    expect(opts.inReplyTo).toBeUndefined();
    expect(opts.references).toBeUndefined();
  });

  test('drops an empty References array rather than emitting a blank header', () => {
    expect(mailOptions({ ...base, references: [] }, 'sender@example.test').references).toBeUndefined();
  });

  test('never leaks the Gmail-only threadId into the MIME options', () => {
    expect(mailOptions({ ...base, threadId: 'thread-abc' }, 'sender@example.test')).not.toHaveProperty('threadId');
  });

  test('carries the ordinary fields, with the resolved sender', () => {
    const opts = mailOptions({ ...base, cc: 'cc@example.test', html: '<p>hi</p>' }, 'sender@example.test');
    expect(opts).toMatchObject({
      from: 'sender@example.test',
      to: 'hotel@example.com',
      cc: 'a@x.com',
      subject: 'Booking',
      text: 'hi',
      html: '<p>hi</p>',
    });
  });
});
