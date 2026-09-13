import { describe, expect, test } from 'bun:test';
import { resolveAllowedSender } from './sender';

describe('resolveAllowedSender', () => {
  const primary = 'lincolnmorais@icloud.com';
  const aliases = ['contact@bakeitfun.com'];

  test('uses the primary identity by default', () => {
    expect(resolveAllowedSender(primary, aliases)).toBe(primary);
  });

  test('accepts a configured custom-domain identity', () => {
    expect(resolveAllowedSender(primary, aliases, 'CONTACT@BAKEITFUN.COM')).toBe('contact@bakeitfun.com');
  });

  test('rejects an unconfigured address on the same domain', () => {
    expect(() => resolveAllowedSender(primary, aliases, 'other@bakeitfun.com')).toThrow(
      'is not authorized for this account',
    );
  });

  test('rejects display names and header injection', () => {
    expect(() => resolveAllowedSender(primary, aliases, 'BakeItFun <contact@bakeitfun.com>')).toThrow();
    expect(() => resolveAllowedSender(primary, aliases, 'contact@bakeitfun.com\nBcc: attacker@example.com')).toThrow();
  });
});
