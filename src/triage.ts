/**
 * Email triage sweep: the email capture mouth.
 *
 * The queue is **anything in the inbox** — read or unread:
 * read-but-not-archived mail was invisible to the original unread-only sweep
 * and piled up). Two operations, both driven from cli.ts:
 *   triage-sweep — list every INBOX message across all three accounts, minus
 *                  ids already recorded in local state. READ-ONLY:
 *                  never marks read, archives, moves, or deletes (Gmail
 *                  messages.get and ImapFlow BODY.PEEK are mutation-free).
 *   triage-mark  — record ids that were routed but should STAY in the inbox.
 *                  The default triage completion is `archive` (after operator
 *                  authorization), which empties the queue by itself; the mark is
 *                  the dedup for the keep-in-inbox cases.
 *
 * State: `$MAIL_CLI_STATE_DIR/email/triage-state.json`, or the XDG default. Per account:
 * { lastSweep, processed: { id → date-marked } };
 * icloud additionally records the INBOX UIDVALIDITY — IMAP UIDs are only stable
 * within one validity epoch, so on change the icloud map is cleared with a
 * warning (old entries would alias new mail).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { gmailBackend } from './gmail';
import { icloudInboxWithValidity } from './icloud';
import { gmailLlnCreds, gmailPersonalCreds, icloudCreds } from './creds';
import type { Email } from './types';

const STATE_PATH = join(
  process.env.MAIL_CLI_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'mail-cli'),
  'email',
  'triage-state.json',
);

export type TriageAccount = 'gmail' | 'lln' | 'icloud';
export const TRIAGE_ACCOUNTS: TriageAccount[] = ['gmail', 'lln', 'icloud'];

interface AccountState {
  lastSweep: string | null;
  uidValidity?: string | null;
  processed: Record<string, string>;
}

interface TriageState {
  _comment?: string;
  screenshots?: { folderId: string; processedFolderId: string };
  email: Record<TriageAccount, AccountState>;
}

const emptyAccount = (): AccountState => ({ lastSweep: null, processed: {} });

export function loadState(): TriageState {
  if (!existsSync(STATE_PATH)) {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const initial: TriageState = {
      email: { gmail: emptyAccount(), lln: emptyAccount(), icloud: emptyAccount() },
    };
    writeFileSync(STATE_PATH, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    return initial;
  }
  const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as TriageState;
  raw.email ??= { gmail: emptyAccount(), lln: emptyAccount(), icloud: emptyAccount() };
  for (const a of TRIAGE_ACCOUNTS) {
    raw.email[a] ??= emptyAccount();
    raw.email[a].processed ??= {};
  }
  return raw;
}

/** Atomic write (tmp + rename) — a crash mid-write must not eat the dedup memory. */
function saveState(state: TriageState): void {
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

// Prune only entries BOTH older than 120 days AND beyond the newest 1000 per
// account — bounded file growth without ever forgetting recent routing.
const PRUNE_AGE_DAYS = 120;
const PRUNE_KEEP = 1000;

function prune(acc: AccountState): number {
  const entries = Object.entries(acc.processed);
  if (entries.length <= PRUNE_KEEP) return 0;
  const cutoff = Date.now() - PRUNE_AGE_DAYS * 86_400_000;
  entries.sort((a, b) => a[1].localeCompare(b[1])); // oldest first
  let pruned = 0;
  for (const [id, date] of entries) {
    if (entries.length - pruned <= PRUNE_KEEP) break;
    if (new Date(date).getTime() >= cutoff) break;
    delete acc.processed[id];
    pruned++;
  }
  return pruned;
}

/** Record routed ids for an account. Run right after routing each item, not in bulk. */
export function markProcessed(account: TriageAccount, ids: string[]): { marked: number; pruned: number; total: number } {
  const state = loadState();
  const acc = state.email[account];
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ids) acc.processed[id] = today;
  const pruned = prune(acc);
  saveState(state);
  return { marked: ids.length, pruned, total: Object.keys(acc.processed).length };
}

export interface SweepAccountResult {
  account: TriageAccount;
  /** Messages in the inbox right now (icloud: exact; gmail/lln: what the capped fetch returned). */
  inboxTotal: number;
  /** Inbox items already routed in a previous triage (subtracted from items). */
  alreadyProcessed: number;
  items: Email[];
  /** True when the fetch hit --limit — raise it to see the rest. */
  capped: boolean;
  warning?: string;
  error?: string;
}

/**
 * Sweep all three accounts' ENTIRE inboxes (read + unread). Touches nothing in
 * any mailbox; the only write is state bookkeeping (lastSweep, and the icloud
 * uidValidity guard).
 */
export async function sweep(limit: number): Promise<SweepAccountResult[]> {
  const state = loadState();
  const now = new Date().toISOString();

  const tasks: Array<Promise<SweepAccountResult>> = [
    (async (): Promise<SweepAccountResult> => {
      const emails = await gmailBackend('gmail', gmailPersonalCreds()).inbox(limit);
      return { account: 'gmail', inboxTotal: emails.length, alreadyProcessed: 0, items: emails, capped: emails.length >= limit };
    })(),
    (async (): Promise<SweepAccountResult> => {
      const emails = await gmailBackend('lln', gmailLlnCreds()).inbox(limit);
      return { account: 'lln', inboxTotal: emails.length, alreadyProcessed: 0, items: emails, capped: emails.length >= limit };
    })(),
    (async (): Promise<SweepAccountResult> => {
      const { uidValidity, inboxTotal, emails } = await icloudInboxWithValidity(icloudCreds(), limit);
      const acc = state.email.icloud;
      let warning: string | undefined;
      if (acc.uidValidity && uidValidity && acc.uidValidity !== uidValidity) {
        warning =
          `icloud UIDVALIDITY changed ${acc.uidValidity} → ${uidValidity}: UIDs renumbered, ` +
          `cleared ${Object.keys(acc.processed).length} processed entries (expect re-listed mail — re-judge, don't re-route blindly)`;
        acc.processed = {};
      }
      acc.uidValidity = uidValidity;
      return { account: 'icloud', inboxTotal, alreadyProcessed: 0, items: emails, capped: emails.length >= limit, warning };
    })(),
  ];

  const settled = await Promise.allSettled(tasks);
  const results: SweepAccountResult[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          account: TRIAGE_ACCOUNTS[i]!,
          inboxTotal: 0,
          alreadyProcessed: 0,
          items: [],
          capped: false,
          error: (r.reason as Error)?.message ?? String(r.reason),
        },
  );

  // Subtract already-routed ids; stamp lastSweep only on accounts that answered.
  for (const res of results) {
    if (res.error) continue;
    const processed = state.email[res.account].processed;
    const before = res.items.length;
    res.items = res.items.filter((e) => !processed[e.id]);
    res.alreadyProcessed = before - res.items.length;
    state.email[res.account].lastSweep = now;
  }

  saveState(state);
  return results;
}
