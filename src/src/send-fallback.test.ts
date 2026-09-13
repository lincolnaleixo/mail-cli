import { describe, expect, test } from 'bun:test'
import { sendWithFallback } from './client';
import { isRetryableSendFailure } from './transient';
import type { EmailBackend, OutgoingMessage, SendResult } from './types';

const MESSAGE: OutgoingMessage = {
  to: 'someone@example.com',
  subject: 'Hello',
  body: 'Body',
  from: 'lincoln@icloud.com',
  threadId: 'icloud-thread-1',
};

function backend(account: EmailBackend['account'], send: (msg: OutgoingMessage) => Promise<SendResult>): EmailBackend {
  return { account, send } as unknown as EmailBackend;
}

function smtpError(code: string, message = 'send failed'): Error {
  return Object.assign(new Error(message), { code });
}

describe('sendWithFallback', () => {
  test('uses the requested account when it can send', async () => {
    const primary = backend('icloud', async () => ({ messageId: 'icloud-1', sentCopy: true }));
    const fallback = backend('gmail', async () => {
      throw new Error('fallback must not be used');
    });
    expect(await sendWithFallback(primary, fallback, MESSAGE)).toEqual({ messageId: 'icloud-1', sentCopy: true });
  });

  test('falls back to Gmail when iCloud never handed the message off', async () => {
    const delivered: OutgoingMessage[] = [];
    const primary = backend('icloud', async () => {
      throw smtpError('ECONNECTION', 'Connection timeout');
    });
    const fallback = backend('gmail', async (msg) => {
      delivered.push(msg);
      return { messageId: 'gmail-1', threadId: 'gmail-thread-1' };
    });

    const result = await sendWithFallback(primary, fallback, MESSAGE);

    expect(result).toEqual({
      messageId: 'gmail-1',
      threadId: 'gmail-thread-1',
      sentVia: 'gmail',
      fallbackFrom: 'icloud',
      fallbackReason: 'Connection timeout',
    });
    // The iCloud identity and thread id must not travel to Gmail.
    expect(delivered).toEqual([{ to: 'someone@example.com', subject: 'Hello', body: 'Body' }]);
  });

  test('never falls back when delivery is ambiguous', async () => {
    const primary = backend('icloud', async () => {
      throw smtpError('EMESSAGE', 'Data command failed');
    });
    const fallback = backend('gmail', async () => {
      throw new Error('fallback must not be used');
    });
    await expect(sendWithFallback(primary, fallback, MESSAGE)).rejects.toThrow('Data command failed');
  });

  test('rethrows when the account has no fallback route', async () => {
    const primary = backend('gmail', async () => {
      throw smtpError('ECONNECTION', 'Connection timeout');
    });
    await expect(sendWithFallback(primary, null, MESSAGE)).rejects.toThrow('Connection timeout');
  });
});

describe('isRetryableSendFailure', () => {
  test('accepts failures that happen before the message is streamed', () => {
    expect(isRetryableSendFailure(smtpError('EAUTH', 'Invalid login'))).toBe(true);
    expect(isRetryableSendFailure(smtpError('ESOCKET'))).toBe(true);
    expect(isRetryableSendFailure(smtpError('EENVELOPE', 'Recipient rejected'))).toBe(true);
    expect(isRetryableSendFailure(new Error('getaddrinfo EAI_AGAIN smtp.mail.me.com'))).toBe(true);
  });

  test('refuses anything that might already be delivered', () => {
    expect(isRetryableSendFailure(smtpError('EMESSAGE'))).toBe(false);
    expect(isRetryableSendFailure(new Error('Socket timeout'))).toBe(false);
    expect(isRetryableSendFailure(new Error('Command failed'))).toBe(false);
    expect(isRetryableSendFailure(undefined)).toBe(false);
  });
});
