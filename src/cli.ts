#!/usr/bin/env bun
/** Email CLI for Gmail and iCloud accounts. */

import { readFileSync } from 'fs';
import {
  archiveEmail,
  downloadAttachments,
  draftEmail,
  listAttachments,
  listFolders,
  listInbox,
  listUnread,
  moveEmail,
  readEmail,
  replyEmail,
  searchEmails,
  sendEmail,
  threadEmails,
  trashEmail,
  type FanResult,
} from './client';
import type { ReplyInput } from './reply';
import type { Email, OutgoingMessage, SearchOptions } from './types';
import { markProcessed, sweep, TRIAGE_ACCOUNTS, type TriageAccount } from './triage';

const SCRATCH_DIR =
  process.env.MAIL_CLI_SCRATCH_DIR ||
  process.env.TMPDIR || '/tmp';

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

type Flags = Record<string, string | boolean>;

/** Flags that take a value (`--limit 5` / `--limit=5`). */
const VALUE_FLAGS = ['--account', '-a', '--limit', '--out', '--from', '--to', '--subject', '--since', '--before'];
/** Boolean flags (presence = true). */
const BOOL_FLAGS = new Set(['--json', '--body', '--has-attachment', '--unread', '--confirm-send', '--allow-fallback']);

/** Parse argv into account selector, named flags, and positional args. */
export function parseFlags(argv: string[]): { account: string; flags: Flags; positional: string[] } {
  let account = 'personal';
  let accountSeen = false;
  const flags: Flags = {};
  const positional: string[] = [];
  const setFlag = (key: string, value: string | boolean): void => {
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate option --${key}`);
    flags[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--account' || a === '-a') {
      if (accountSeen) throw new Error('duplicate option --account');
      account = argv[++i] ?? (() => { throw new Error('--account needs a value'); })();
      accountSeen = true;
      continue;
    }
    if (a.startsWith('--account=')) {
      if (accountSeen) throw new Error('duplicate option --account');
      account = a.slice('--account='.length);
      accountSeen = true;
      continue;
    }
    let matched = false;
    for (const vf of VALUE_FLAGS) {
      if (vf === '--account' || vf === '-a') continue;
      const key = vf.replace(/^-+/, '');
      if (a === vf) { setFlag(key, argv[++i] ?? (() => { throw new Error(`${vf} needs a value`); })()); matched = true; break; }
      if (a.startsWith(`${vf}=`)) { setFlag(key, a.slice(vf.length + 1)); matched = true; break; }
    }
    if (matched) continue;
    if (BOOL_FLAGS.has(a)) { setFlag(a.replace(/^-+/, ''), true); continue; }
    if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    positional.push(a);
  }
  return { account, flags, positional };
}

export function assertSendConfirmed(flags: Flags): void {
  if (flags['confirm-send'] !== true) {
    throw new Error('send requires --confirm-send after explicit authorization for this exact recipient and message');
  }
}

function requireArgs(command: string, args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new Error(`usage: ${usage} (${command} received ${args.length} argument(s))`);
}

/** Quote a filter value if it contains whitespace (so the mini-language keeps it whole). */
function quoteIfNeeded(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

/** Fold the unified filter flags into one Gmail-style query string both backends understand. */
function buildFilterQuery(positional: string, flags: Flags): string {
  const parts: string[] = [];
  if (positional) parts.push(positional);
  if (flags.from) parts.push(`from:${quoteIfNeeded(String(flags.from))}`);
  if (flags.to) parts.push(`to:${quoteIfNeeded(String(flags.to))}`);
  if (flags.subject) parts.push(`subject:${quoteIfNeeded(String(flags.subject))}`);
  if (flags.since) parts.push(`since:${flags.since}`);
  if (flags.before) parts.push(`before:${flags.before}`);
  if (flags.unread) parts.push('is:unread');
  if (flags['has-attachment']) parts.push('has:attachment');
  return parts.join(' ').trim();
}

function emailToJson(e: Email): Record<string, unknown> {
  return {
    id: e.id,
    account: e.account,
    folder: e.folder,
    threadId: e.threadId,
    from: e.from,
    to: e.to,
    subject: e.subject,
    date: e.date,
    messageId: e.messageId,
    isUnread: e.isUnread,
    labelIds: e.labelIds,
    attachments: e.attachments,
    snippet: e.snippet.slice(0, 200),
  };
}

function formatEmail(e: Email, verbose = false): void {
  const unread = e.isUnread ? '[UNREAD] ' : '';
  const folder = e.folder && e.folder !== 'INBOX' ? ` (${e.folder})` : '';
  console.log(`${unread}[${e.account}]${folder} [${e.id}]`);
  console.log(`  From: ${e.from}`);
  console.log(`  Subject: ${e.subject}`);
  console.log(`  Date: ${e.date}`);
  if (e.attachments?.length) {
    console.log(`  Attachments: ${e.attachments.map((a) => a.filename).join(', ')}`);
  }
  if (verbose) {
    console.log(`  To: ${e.to}`);
    console.log(`\n${e.body}`);
  } else {
    console.log(`  Snippet: ${e.snippet.slice(0, 100)}${e.snippet.length > 100 ? '…' : ''}`);
  }
  console.log('');
}

function printFan(result: FanResult): void {
  for (const err of result.errors) console.error(`  ⚠ ${err}`);
  console.log(`Found ${result.emails.length} email(s)\n`);
  result.emails.forEach((e) => formatEmail(e));
}

/** Resolve a limit from a positional arg, then `--limit`, then a default. */
function resolveLimit(positionalLimit: string | undefined, flags: Flags, fallback: number): number {
  return parseInt(positionalLimit ?? '', 10) || parseInt(String(flags.limit ?? ''), 10) || fallback;
}

function loadPayload(path: string | undefined): OutgoingMessage {
  if (!path) die('usage: <draft|send> <json-file>   (keys: to, subject, body; +from, html, cc, bcc, replyTo, attachments)');
  let payload: OutgoingMessage;
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    return die(`failed to read JSON file: ${(e as Error).message}`);
  }
  if (!payload.to || !payload.subject || !payload.body) {
    die('JSON must include: to, subject, body');
  }
  return payload;
}

/** Keys an operator may set on a reply. Everything else is derived from the original. */
const REPLY_KEYS = new Set(['body', 'html', 'from', 'to', 'cc', 'bcc', 'subject', 'quote', 'attachments']);

function loadReplyPayload(path: string | undefined): ReplyInput {
  if (!path) die('usage: reply <id> <json-file>   (keys: body; +html, from, to, cc, bcc, subject, quote)');
  let payload: ReplyInput;
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    return die(`failed to read JSON file: ${(e as Error).message}`);
  }
  if (!payload.body) die('reply JSON must include: body');
  const unknown = Object.keys(payload).filter((k) => !REPLY_KEYS.has(k));
  if (unknown.length) {
    die(
      `unknown reply key(s): ${unknown.join(', ')}. ` +
        `Threading (inReplyTo, references, threadId) is derived from the original — do not set it. ` +
        `Allowed: ${[...REPLY_KEYS].join(', ')}`,
    );
  }
  return payload;
}

const HELP = `email — read and send across configured accounts

Usage:
  mail-cli <command> [args] [--account <selector>]

Account selectors (--account, default: personal):
  personal              gmail + icloud — reads fan across both; writes must pick one
  gmail                 Gmail API account
  icloud                IMAP + SMTP account
  lln                   Additional Gmail API account

Commands:
  inbox [limit]         List inbox (default 20)
  unread [limit]        List unread inbox messages
  search <query>        Search ALL folders (icloud) / All Mail (gmail). Same
                        query mini-language on both backends (see below).
  read <id>             Read full message
  thread <id>           Show the whole conversation for a message
  folders               List mailboxes (icloud) / labels (gmail) + counts
  attachments <id> [--out <dir>]
                        List a message's attachments; with --out, download them
                        (default dir: the session scratchpad)
  archive <id>          Archive (remove from inbox / move to Archive)
  move <id> <folder>    Move out of inbox into an exact label/folder
  trash <id>            Move to trash
  draft <json-file>     Create a draft (safe default — lands in Drafts for review)
  reply <id> <json-file>
                        Draft a threaded reply: recipient, "Re:" subject,
                        In-Reply-To, References and the Gmail threadId are all
                        derived from the original. Supply only "body". Always
                        drafts — use send for anything that must go out.
  send <json-file> --confirm-send [--allow-fallback]
                        Send immediately — explicit account + exact-message authorization only.
                        iCloud → Gmail fallback additionally requires --allow-fallback.
  triage-sweep [--limit N] [--json]
                        Mailbox-read-only: EVERYTHING in the inbox (read + unread) across ALL 3
                        accounts, minus already-triaged ids
                        (under the configured state directory). The sweep itself is
                        mailbox-read-only but updates that local dedup state. Default limit 50/account.
  triage-mark <account> <id> [<id>…]
                        Record ids routed but KEPT in the inbox (the default
                        completion is archive, after operator authorization).
                        account: gmail|lln|icloud
  help                  Show this help

Search scope: icloud now searches EVERY selectable folder (INBOX, Archive,
Sent, …; Trash + Junk skipped by default) and merges/dedupes the hits — a routed
or archived message is findable, matching the Mail app. gmail searches All Mail.

Query mini-language (both backends):
  from: to: cc: subject: body:   field match (quote multi-word: subject:"hotel am park")
  since:YYYY/M/D  before:YYYY/M/D  newer_than:7d  older_than:30d   dates
  is:unread  is:flagged          state
  has:attachment                 has any attachment
  bare words                     match from OR subject (add --body to also scan bodies)

Unified filter flags (translate to each backend): --from --to --subject --since
--before --has-attachment --unread --limit N --body (deep body scan) --json

JSON payload (draft/send): { "from"?, "to", "subject", "body", "html"?, "cc"?, "bcc"?, "replyTo"?, "attachments"? }
  Programmatic callers may also set "inReplyTo", "references" and "threadId".
  Note "replyTo" (the Reply-To: header) and "inReplyTo" (the parent's
  Message-ID) are different things.
  "attachments": [{ "path": "/abs/file.pdf", "filename"?, "mimeType"? }] — files
  are read from disk at build time; 18 MB total cap.
JSON payload (reply): { "body", "html"?, "from"?, "to"?, "cc"?, "bcc"?, "subject"?, "quote"?, "attachments"? }
  The original is quoted beneath the reply unless "quote": false. CC is never
  inherited — reply-all is an explicit act.
--json works on: inbox, unread, search, read, thread, folders, attachments.

Examples:
  mail-cli inbox --account gmail 5
  mail-cli unread --account personal 10
  mail-cli search "from:sender@example.test" --account lln
  mail-cli search "subject:example" --account icloud
  mail-cli search --from sender@example.test --since 2026/6/1 --account personal
  mail-cli thread MESSAGE_ID --account gmail
  mail-cli attachments FOLDER:MESSAGE_ID --out ./tmp --account icloud
  mail-cli read MESSAGE_ID --account gmail
  mail-cli draft ./draft.json --account icloud
  mail-cli reply MESSAGE_ID ./reply.json --account gmail
`;

async function main() {
  const { account, flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const args = positional.slice(1);
  const wantJson = !!flags.json;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case 'inbox': {
      const limit = resolveLimit(args[0], flags, 20);
      const result = await listInbox(account, limit);
      if (wantJson) { console.log(JSON.stringify(result.emails.map(emailToJson), null, 2)); break; }
      console.log(`\nInbox (account: ${account}, limit: ${limit})\n`);
      printFan(result);
      break;
    }
    case 'unread': {
      const limit = resolveLimit(args[0], flags, 20);
      const result = await listUnread(account, limit);
      if (wantJson) { console.log(JSON.stringify(result.emails.map(emailToJson), null, 2)); break; }
      console.log(`\nUnread (account: ${account}, limit: ${limit})\n`);
      printFan(result);
      break;
    }
    case 'search': {
      const query = buildFilterQuery(args.join(' '), flags);
      if (!query) die('usage: search <query>  (or use --from/--to/--subject/--since/--before/--has-attachment/--unread)');
      const limit = resolveLimit(undefined, flags, 20);
      const opts: SearchOptions = { body: !!flags.body };
      const result = await searchEmails(account, query, limit, opts);
      if (wantJson) { console.log(JSON.stringify(result.emails.map(emailToJson), null, 2)); break; }
      console.log(`\nSearch "${query}" (account: ${account}, limit: ${limit})\n`);
      printFan(result);
      break;
    }
    case 'read': {
      const id = args[0];
      if (!id) die('usage: read <id>');
      const email = await readEmail(account, id);
      if (wantJson) {
        // The full surface: a listing carries messageId only, since a deep
        // References chain across 50 messages is noise.
        const full = {
          ...emailToJson(email),
          inReplyTo: email.inReplyTo,
          references: email.references,
          replyTo: email.replyTo,
          body: email.body,
        };
        console.log(JSON.stringify(full, null, 2));
        break;
      }
      formatEmail(email, true);
      break;
    }
    case 'thread': {
      const id = args[0];
      if (!id) die('usage: thread <id> [--account <gmail|icloud|lln>]');
      const emails = await threadEmails(account, id);
      if (wantJson) { console.log(JSON.stringify(emails.map(emailToJson), null, 2)); break; }
      console.log(`\nThread (${emails.length} message(s), account: ${account})\n`);
      emails.forEach((e) => formatEmail(e));
      break;
    }
    case 'folders': {
      const { results, errors } = await listFolders(account);
      if (wantJson) { console.log(JSON.stringify(results, null, 2)); break; }
      for (const err of errors) console.error(`  ⚠ ${err}`);
      for (const r of results) {
        console.log(`=== ${r.account} (${r.folders.length} folders) ===`);
        for (const f of r.folders) {
          const su = f.specialUse ? `  ${f.specialUse}` : '';
          const cnt = f.messages != null ? `  (${f.messages})` : '';
          console.log(`  ${f.path}${su}${cnt}`);
        }
        console.log('');
      }
      break;
    }
    case 'attachments': {
      const id = args[0];
      if (!id) die('usage: attachments <id> [--out <dir>] [--account <gmail|icloud|lln>]');
      if (flags.out !== undefined) {
        const outDir = flags.out ? String(flags.out) : SCRATCH_DIR;
        const { account: acct, paths } = await downloadAttachments(account, id, outDir);
        if (wantJson) { console.log(JSON.stringify({ account: acct, paths }, null, 2)); break; }
        console.log(`Downloaded ${paths.length} attachment(s) from ${acct} to ${outDir}:`);
        paths.forEach((p) => console.log(`  ${p}`));
        break;
      }
      const { account: acct, items } = await listAttachments(account, id);
      if (wantJson) { console.log(JSON.stringify({ account: acct, items }, null, 2)); break; }
      console.log(`\n${items.length} attachment(s) [${acct}]\n`);
      items.forEach((a, i) => console.log(`  [${i}] ${a.filename} — ${a.mimeType} (${a.size} bytes)`));
      break;
    }
    case 'archive': {
      requireArgs('archive', args, 1, 'archive <id> --account <gmail|icloud|lln>');
      const id = args[0];
      if (!id) die('usage: archive <id> --account <gmail|icloud|lln>');
      await archiveEmail(account, id);
      console.log(`Email ${id} archived (${account}).`);
      break;
    }
    case 'move': {
      requireArgs('move', args, 2, 'move <id> <folder> --account <gmail|icloud|lln>');
      const [id, destination] = args;
      if (!id || !destination) {
        die('usage: move <id> <folder> --account <gmail|icloud|lln>');
      }
      await moveEmail(account, id, destination);
      console.log(`Email ${id} moved to ${destination} (${account}).`);
      break;
    }
    case 'trash': {
      requireArgs('trash', args, 1, 'trash <id> --account <gmail|icloud|lln>');
      const id = args[0];
      if (!id) die('usage: trash <id> --account <gmail|icloud|lln>');
      await trashEmail(account, id);
      console.log(`Email ${id} moved to trash (${account}).`);
      break;
    }
    case 'draft': {
      requireArgs('draft', args, 1, 'draft <json-file> --account <gmail|icloud|lln>');
      const payload = loadPayload(args[0]);
      const res = await draftEmail(account, payload);
      console.log(`Draft created (${account}).`);
      console.log(`  Draft ID:   ${res.draftId}`);
      if (res.messageId) console.log(`  Message ID: ${res.messageId}`);
      break;
    }
    case 'reply': {
      requireArgs('reply', args, 2, 'reply <id> <json-file> --account <gmail|icloud|lln>');
      const [id, file] = args;
      if (!id) die('usage: reply <id> <json-file> --account <gmail|icloud|lln>');
      const res = await replyEmail(account, id, loadReplyPayload(file));
      console.log(`Reply drafted (${res.account}).`);
      console.log(`  Draft ID:   ${res.draft.draftId}`);
      if (res.draft.messageId) console.log(`  Message ID: ${res.draft.messageId}`);
      console.log(`  To:         ${res.original.replyTo || res.original.from}`);
      if (res.original.messageId) {
        console.log(`  In-Reply-To: ${res.original.messageId}`);
      } else {
        console.log('  ⚠ The original carries no Message-ID — this reply is not threaded.');
      }
      // Gmail silently starts a new thread when its criteria are not met, so
      // compare rather than assume the draft landed in the conversation.
      if (res.original.threadId) {
        const grouped = res.draft.threadId === res.original.threadId;
        console.log(`  Thread:     ${grouped ? 'grouped with the original' : '⚠ NOT grouped — Gmail started a new thread'}`);
      }
      break;
    }
    case 'send': {
      assertSendConfirmed(flags);
      requireArgs('send', args, 1, 'send <json-file> --confirm-send --account <gmail|icloud|lln>');
      const payload = loadPayload(args[0]);
      const res = await sendEmail(account, payload, flags['allow-fallback'] === true);
      console.log(`Message sent (${res.sentVia ?? account}).`);
      if (res.sentVia) {
        console.log(
          `  NOTE: ${res.fallbackFrom} could not send (${res.fallbackReason}); ` +
            `delivered from ${res.sentVia} instead, so the recipient sees that address.`,
        );
      }
      console.log(`  Message ID: ${res.messageId}`);
      if (res.threadId) console.log(`  Thread ID:  ${res.threadId}`);
      if (res.sentCopy === false) {
        console.log('  WARNING: delivered, but no copy could be filed in Sent Messages.');
      }
      break;
    }
    case 'triage-sweep': {
      const limit = parseInt(String(flags.limit ?? ''), 10) || 50;
      const results = await sweep(limit);
      if (wantJson) {
        console.log(
          JSON.stringify(
            results.map((r) => ({
              ...r,
              items: r.items.map((e) => ({
                id: e.id, from: e.from, subject: e.subject, date: e.date, snippet: e.snippet.slice(0, 200),
              })),
            })),
            null,
            2,
          ),
        );
        break;
      }
      for (const r of results) {
        if (r.error) {
          console.log(`=== ${r.account} — SWEEP FAILED: ${r.error}\n`);
          continue;
        }
        const cap = r.capped ? ` (hit --limit ${limit}; raise it to see the rest)` : '';
        console.log(`=== ${r.account} — ${r.inboxTotal} in inbox, ${r.items.length} to triage, ${r.alreadyProcessed} already routed${cap}`);
        if (r.warning) console.log(`  ⚠ ${r.warning}`);
        console.log('');
        r.items.forEach((e) => formatEmail(e));
      }
      break;
    }
    case 'triage-mark': {
      const acct = args[0] as TriageAccount;
      const ids = args.slice(1);
      if (!TRIAGE_ACCOUNTS.includes(acct) || !ids.length) {
        die('usage: triage-mark <gmail|lln|icloud> <id> [<id>…]');
      }
      const res = markProcessed(acct, ids);
      console.log(`Marked ${res.marked} id(s) processed for ${acct} (map: ${res.total}${res.pruned ? `, pruned ${res.pruned} old` : ''}).`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

if (import.meta.main) main().catch((e) => die(`Error: ${e?.message ?? e}`));
