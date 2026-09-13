import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { assertSendConfirmed, parseFlags } from './cli';
import { archiveEmail } from './client';

describe('email CLI safety', () => {
  test('combined personal reads remain the default', () => {
    expect(parseFlags(['inbox', '5'])).toEqual({
      account: 'personal',
      flags: {},
      positional: ['inbox', '5'],
    });
  });

  test('send confirmation is an explicit boolean flag', () => {
    const parsed = parseFlags(['send', '/tmp/message.json', '--account', 'lln', '--confirm-send']);
    expect(parsed.account).toBe('lln');
    expect(parsed.flags['confirm-send']).toBe(true);
    expect(parsed.positional).toEqual(['send', '/tmp/message.json']);
  });

  test('send is refused before network work without confirmation', () => {
    expect(() => assertSendConfirmed({})).toThrow('send requires --confirm-send');
    expect(() => assertSendConfirmed({ 'confirm-send': true })).not.toThrow();
  });

  test('unknown and duplicate options are rejected', () => {
    expect(() => parseFlags(['trash', 'id', '--account', 'gmail', '--dry-run'])).toThrow('unknown option --dry-run');
    expect(() => parseFlags(['inbox', '--json', '--json'])).toThrow('duplicate option --json');
    expect(() => parseFlags(['inbox', '--account', 'gmail', '--account', 'icloud'])).toThrow('duplicate option --account');
  });

  test('a write through combined personal routing is rejected before credentials', () => {
    expect(() => archiveEmail('personal', 'message-id')).toThrow('--account personal is ambiguous');
  });

  test('the real CLI refuses send before reading its payload', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, 'cli.ts'), 'send', '/definitely/missing.json', '--account', 'gmail'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const error = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(error).toContain('send requires --confirm-send');
    expect(error).not.toContain('failed to read JSON file');
    expect(error).not.toContain('missing GMAIL');
  });
});
