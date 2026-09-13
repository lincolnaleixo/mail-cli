/**
 * Email skill — shared types.
 *
 * One skill, three accounts, two backends:
 *   - gmail-personal + gmail-lln  → Gmail REST API (OAuth refresh token)
 *   - icloud                      → IMAP read (imapflow) + SMTP send (nodemailer)
 */

/** A concrete account that maps to exactly one mailbox/backend. */
export type Account = 'gmail' | 'lln' | 'icloud';

/** Backend family behind an account. */
export type Provider = 'gmail' | 'icloud';

/**
 * What the caller types after `--account`. `personal` is the default and fans
 * across gmail + icloud for reads; `company`/`empresa`/`longlifenutri` are
 * aliases for `lln`. Resolved by `resolveAccounts` in client.ts.
 */
export type AccountSelector =
  | 'personal'
  | 'gmail'
  | 'icloud'
  | 'lln'
  | 'company'
  | 'empresa'
  | 'longlifenutri';

/** Attachment metadata (no bytes) — surfaced on read across both backends. */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  /** Size in bytes (best-effort; the decoded length). */
  size: number;
}

/** A mailbox/folder (iCloud) or label (Gmail). */
export interface FolderInfo {
  /** Display name (last path segment / label name). */
  name: string;
  /** Stable path/id — iCloud mailbox path, or Gmail label id. */
  path: string;
  /** IMAP special-use flag (\\Archive, \\Sent, …) or 'system' for a Gmail system label. */
  specialUse?: string;
  /** Message count when cheaply available. */
  messages?: number;
}

/** A normalized email, identical shape across both backends. */
export interface Email {
  /**
   * Provider message id. Gmail: the Gmail message id. iCloud: the IMAP UID as a
   * string for an INBOX message (bare, e.g. "5567"), or "<folderPath>:<uid>"
   * for a message in any other folder (e.g. "Archive:48213").
   */
  id: string;
  account: Account;
  threadId: string;
  /** iCloud only — the mailbox the message lives in (INBOX, Archive, Sent, …). */
  folder?: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  /** RFC 5322 Message-ID, e.g. "<abc@mail.example>". Absent when the source carried none. */
  messageId?: string;
  /** RFC 5322 In-Reply-To (raw header value) — the parent this message answers. */
  inReplyTo?: string;
  /** RFC 5322 References chain, oldest first. Populated on a full read; may be absent on a cheap listing. */
  references?: string[];
  /** RFC 5322 Reply-To — where a reply should go instead of `from`. */
  replyTo?: string;
  snippet: string;
  body: string;
  labelIds: string[];
  isUnread: boolean;
  /** Attachment metadata when the message was read with its source (no bytes). */
  attachments?: AttachmentMeta[];
}

/** Options for an all-folder search (iCloud honors these; Gmail ignores them). */
export interface SearchOptions {
  /** Deep body scan — match the message body, not just headers. */
  body?: boolean;
  /** Include the Trash mailbox (skipped by default). */
  includeTrash?: boolean;
  /** Include the Junk/Spam mailbox (skipped by default). */
  includeJunk?: boolean;
  /** Restrict the search to these mailbox paths (default: every searchable folder). */
  folders?: string[];
}

/** A file to attach to an outgoing message, read from disk at build time. */
export interface OutgoingAttachment {
  /** Absolute path to the file on disk. */
  path: string;
  /** Filename shown to the recipient (default: basename of `path`). */
  filename?: string;
  /** MIME type (default: guessed from the extension, else application/octet-stream). */
  mimeType?: string;
}

/** Outgoing message payload (draft + send share this shape). */
export interface OutgoingMessage {
  /** Explicit sender identity. The backend rejects addresses outside its configured allowlist. */
  from?: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  cc?: string;
  bcc?: string;
  /** RFC `Reply-To:` header — where replies to THIS message should go. Not threading; see `inReplyTo`. */
  replyTo?: string;
  /** RFC `In-Reply-To:` — the Message-ID this message answers. Not `replyTo`; the two are unrelated. */
  inReplyTo?: string;
  /** RFC `References:` chain, oldest first. Emitted space-separated and folded. */
  references?: string[];
  /** Gmail's native thread id — groups the message in Gmail's own UI. Ignored by the iCloud backend. */
  threadId?: string;
  /** Files to attach, read from disk when the message is built. */
  attachments?: OutgoingAttachment[];
}

export interface SendResult {
  messageId: string;
  threadId?: string;
  /**
   * Set only when the requested account could not hand the message off and a
   * fallback account delivered it instead. The recipient therefore sees the
   * fallback account's address, not the requested one.
   */
  sentVia?: Account;
  /** The account that was asked for but could not send. */
  fallbackFrom?: Account;
  /** Why the requested account failed, for the operator to read. */
  fallbackReason?: string;
  /**
   * iCloud only: whether a copy was filed in Sent Messages. SMTP delivery
   * leaves no mailbox trace, so the backend appends one itself; `false` means
   * the mail went out but is not in the sent folder. Gmail omits this: the API
   * files sent mail on its own.
   */
  sentCopy?: boolean;
}

export interface DraftResult {
  draftId: string;
  messageId?: string;
  /** Gmail only — the thread the draft landed in. Compare against the original to verify grouping. */
  threadId?: string;
}

/** Uniform backend contract — implemented by gmail.ts and icloud.ts. */
export interface EmailBackend {
  readonly account: Account;
  inbox(limit: number): Promise<Email[]>;
  unread(limit: number): Promise<Email[]>;
  /** Search. iCloud searches every folder; `opts` is iCloud-only (Gmail ignores it). */
  search(query: string, limit: number, opts?: SearchOptions): Promise<Email[]>;
  read(id: string): Promise<Email>;
  archive(id: string): Promise<void>;
  /** Move out of Inbox into one exact user label/folder without changing read state. */
  move(id: string, destination: string): Promise<void>;
  trash(id: string): Promise<void>;
  draft(msg: OutgoingMessage): Promise<DraftResult>;
  send(msg: OutgoingMessage): Promise<SendResult>;
  /** List mailboxes (iCloud) / labels (Gmail). */
  folders(): Promise<FolderInfo[]>;
  /** All messages in the same conversation as `id`, oldest first. */
  thread(id: string): Promise<Email[]>;
  /** Attachment metadata for a message (no bytes). */
  attachments(id: string): Promise<AttachmentMeta[]>;
  /** Download one attachment (by index) to outDir; returns the written file path. */
  downloadAttachment(id: string, index: number, outDir: string): Promise<string>;
}

// ---- Credential shapes (System Vault profile "inbox_triage") ----

export interface GmailAccountCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  email?: string;
}

export interface ICloudCreds {
  email: string;
  /** Additional iCloud custom-domain addresses verified for SMTP sending. */
  sendFrom?: string[];
  imapServer: string;
  imapPort: number;
  smtpServer: string;
  smtpPort: number;
  appSpecificPassword: string;
}

export interface EmailCreds {
  'gmail-personal': GmailAccountCreds;
  'gmail-lln': GmailAccountCreds;
  icloud: ICloudCreds;
}
