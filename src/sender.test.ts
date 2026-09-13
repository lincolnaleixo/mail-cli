import { describe, expect, test } from 'bun:test';
import { resolveAllowedSender } from './sender';

describe('resolveAllowedSender', () => {
  const primary = 'sender@example.test';
  const aliases = ['alias@example.test'];

  test('uses the primary identity by default', () => {
    expect(resolveAllowedSender(primary, aliases)).toBe(primary);
  });

  test('accepts a configured custom-domain identity', () => {
    expect(resolveAllowedSender(primary, aliases, 'ALIAS@EXAMPLE.TEST')).toBe('alias@example.test');
  });

  test('rejects an unconfigured address on the same domain', () => {
    expect(() => resolveAllowedSender(primary, aliases, 'other@example.test')).toThrow(
      'is not authorized for this account',
    );
  });

  test('rejects display names and header injection', () => {
    expect(() => resolveAllowedSender(primary, aliases, 'Example <alias@example.test>')).toThrow();
    expect(() => resolveAllowedSender(primary, aliases, 'alias@example.test\nBcc: attacker@example.test')).toThrow();
  });
});
