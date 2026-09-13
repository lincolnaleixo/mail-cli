import { describe, expect, test } from 'bun:test';
import { icloudBackend } from './icloud';
import type { ICloudCreds, OutgoingMessage } from './types';

/**
 * The Sent-copy path: SMTP delivery leaves no mailbox trace, so send() files
 * its own copy. These cover the two things that copy must get right, both of
 * which failed silently in the first cut: the archived message must carry the
 * Message-ID the SMTP server actually used (not a freshly minted one), and the
 * Bcc list must survive into the copy while drafts still strip it.
 */
const creds: ICloudCreds = {
  email: 'sender@example.test',
  imapServer: 'imap.mail.me.com',
  imapPort: 993,
  smtpServer: 'smtp.mail.me.com',
  smtpPort: 587,
  appSpecificPassword: 'unused-no-connection-is-made',
};

const base: OutgoingMessage = { to: 'hotel@example.com', subject: 'Booking', body: 'hi' };

// buildMime is private; the test drives it directly because the alternative is
// a live IMAP append.
function buildMime(msg: OutgoingMessage, opts?: { messageId?: string; keepBcc?: boolean }): Promise<Buffer> {
  return (icloudBackend(creds) as unknown as {
    buildMime(m: OutgoingMessage, o?: { messageId?: string; keepBcc?: boolean }): Promise<Buffer>;
  }).buildMime(msg, opts);
}

// Minimal stand-in for the one ImapFlow call the resolver makes.
function fakeClient(boxes: { path: string; specialUse?: string }[]) {
  return { list: async () => boxes } as unknown as Parameters<
    (c: never) => void
  >[0];
}

function resolveSent(boxes: { path: string; specialUse?: string }[]): Promise<string | null> {
  return (icloudBackend(creds) as unknown as {
    resolveSentMailbox(c: unknown): Promise<string | null>;
  }).resolveSentMailbox(fakeClient(boxes));
}

describe('iCloud Sent mailbox resolution', () => {
  test('prefers "Sent Messages" over the empty \\Sent-flagged "Sent Items"', async () => {
    // Lincoln's real account shape: Sent Items carries \Sent but holds 0
    // messages, while Sent Messages holds every mail he has ever sent.
    expect(
      await resolveSent([
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: 'Sent Items', specialUse: '\\Sent' },
        { path: 'Sent Messages' },
      ]),
    ).toBe('Sent Messages');
  });

  test('falls back to the \\Sent special-use box when Apple naming is absent', async () => {
    expect(
      await resolveSent([
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: 'Verzonden', specialUse: '\\Sent' },
      ]),
    ).toBe('Verzonden');
  });

  test('returns null when no sent mailbox exists, so send() reports sentCopy=false', async () => {
    expect(await resolveSent([{ path: 'INBOX', specialUse: '\\Inbox' }])).toBeNull();
  });
});

describe('iCloud Sent copy MIME', () => {
  test('reuses the Message-ID from the SMTP send instead of minting a new one', async () => {
    const mime = (await buildMime(base, { messageId: '<sent-123@example.test>' })).toString('utf-8');
    expect(mime).toContain('Message-ID: <sent-123@example.test>');
  });

  test('mints a Message-ID when none is supplied (the draft path)', async () => {
    const mime = (await buildMime(base)).toString('utf-8');
    expect(mime).toMatch(/^Message-ID: <.+>$/m);
  });

  test('keeps Bcc in the Sent copy so the archive shows who was blind-copied', async () => {
    const mime = (await buildMime({ ...base, bcc: 'quiet@example.com' }, { keepBcc: true })).toString('utf-8');
    expect(mime).toContain('Bcc: quiet@example.com');
  });

  test('strips Bcc without the flag, so drafts never carry it', async () => {
    const mime = (await buildMime({ ...base, bcc: 'quiet@example.com' })).toString('utf-8');
    expect(mime).not.toContain('Bcc:');
  });
});
