/**
 * Resolve an explicitly requested From identity against a backend allowlist.
 *
 * Exact address matching also rejects display-name and header-injection input.
 * Comparison is case-insensitive, while the configured canonical spelling is
 * preserved in the generated message.
 */
export function resolveAllowedSender(
  defaultSender: string,
  additionalSenders: string[],
  requested?: string,
): string {
  const configured = [defaultSender, ...additionalSenders];
  const allowed = new Map(configured.map((address) => [address.trim().toLowerCase(), address.trim()]));
  const candidate = requested === undefined ? defaultSender : requested;
  const resolved = allowed.get(candidate.trim().toLowerCase());
  if (!resolved) {
    throw new Error(
      `From address "${candidate}" is not authorized for this account. ` +
        `Use one of: ${configured.join(', ')}`,
    );
  }
  return resolved;
}
