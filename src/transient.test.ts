import { describe, expect, test } from 'bun:test'
import { describeImapError, isTransientFailure } from './transient';

describe('isTransientFailure', () => {
  test('treats socket and DNS faults as transient', () => {
    expect(isTransientFailure(new Error('Socket timeout'))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error('boom'), { code: 'EAI_AGAIN' }))).toBe(true);
  });

  test('treats a tagged NO/BAD as transient, with or without server text', () => {
    // The 2026-08-18 incident: imapflow reports the refusal as "Command failed".
    expect(isTransientFailure(new Error('Command failed'))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: '[THROTTLED] Too many requests, try again later',
    }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error('nope'), { responseStatus: 'BAD' }))).toBe(true);
  });

  test('classifies the flattened message string the router receives', () => {
    expect(isTransientFailure('icloud: Command failed')).toBe(true);
    expect(isTransientFailure('icloud: Socket timeout')).toBe(true);
    expect(isTransientFailure('icloud: iCloud mailbox "News" not found')).toBe(false);
  });

  test('never degrades an auth or configuration fault', () => {
    expect(isTransientFailure(Object.assign(new Error('Command failed'), { authenticationFailed: true }))).toBe(false);
    expect(isTransientFailure(new Error('Invalid credentials'))).toBe(false);
    expect(isTransientFailure(new Error('missing ICLOUD_APP_PASSWORD; run through: system-vault run inbox_triage'))).toBe(false);
    expect(isTransientFailure(new Error('icloud destination News does not exist'))).toBe(false);
    expect(isTransientFailure(new Error('Gmail user label "Newsletter" not found'))).toBe(false);
    expect(isTransientFailure(undefined)).toBe(false);
  });
});

describe('describeImapError', () => {
  test('puts the server response back into the message', () => {
    expect(describeImapError(Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: '[THROTTLED] Too many requests',
      executedCommand: 'A3 FETCH 1:* (UID)',
    }))).toBe('Command failed (IMAP NO on FETCH 1:*: [THROTTLED] Too many requests)');
  });

  test('leaves a plain error untouched', () => {
    expect(describeImapError(new Error('Socket timeout'))).toBe('Socket timeout');
    expect(describeImapError('plain string')).toBe('plain string');
  });
});
