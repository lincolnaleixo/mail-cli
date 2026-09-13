# mail-cli

A Bun and TypeScript command-line client for reading, searching, triaging,
drafting, and explicitly authorized email operations across configured Gmail
and iCloud accounts.

## Install

Requires [Bun](https://bun.sh/). Clone the repository and run:

```bash
bun install
bun run check
```

Run the executable directly with `./bin/mail-cli`, or put the repository's
`bin` directory on your `PATH` and run `mail-cli`.

## Commands

All commands accept `--account <personal|gmail|icloud|secondary>` where relevant.
The `personal` selector reads from its configured Gmail and iCloud accounts;
writes require an explicit provider account.

* `inbox [limit]` — list inbox messages (default limit: 20).
* `unread [limit]` — list unread inbox messages.
* `search <query>` — search messages using the CLI query language.
* `read <id>` — read a complete message.
* `thread <id>` — show a message's conversation.
* `folders` — list folders or labels and counts.
* `attachments <id> [--out <dir>]` — list or download attachments.
* `archive <id>` — archive a message.
* `move <id> <folder>` — move a message to a folder or label.
* `trash <id>` — move a message to trash.
* `draft <json-file>` — create a draft.
* `reply <id> <json-file>` — create a threaded reply draft.
* `send <json-file> --confirm-send` — send an exact, explicitly authorized message.
* `triage-sweep [--limit N] [--json]` — list untriaged inbox messages and update local deduplication state.
* `triage-mark <account> <id> [<id>...]` — record messages kept in the inbox after routing.
* `help` — print built-in help.

Read-only commands support `--json` where shown by `mail-cli help`. Search
also supports `--from`, `--to`, `--subject`, `--since`, `--before`,
`--has-attachment`, `--unread`, `--body`, and `--limit`. Sending with an iCloud
failure fallback additionally requires `--allow-fallback`.

Draft and send JSON objects use `to`, `subject`, and `body`, with optional
`from`, `html`, `cc`, `bcc`, `replyTo`, and `attachments` fields. Reply JSON
uses `body` and optional formatting, recipient, quote, and attachment fields.

## Environment

Credentials and mailbox identities are read only from environment variables.
Use your preferred secret manager to inject them; never commit a `.env` file or
put secret values in command arguments.

Required Gmail variables:

* `GMAIL_PERSONAL_CLIENT_ID`, `GMAIL_PERSONAL_CLIENT_SECRET`, `GMAIL_PERSONAL_REFRESH_TOKEN`, `GMAIL_PERSONAL_EMAIL`
* `GMAIL_SECONDARY_CLIENT_ID`, `GMAIL_SECONDARY_CLIENT_SECRET`, `GMAIL_SECONDARY_REFRESH_TOKEN`, `GMAIL_SECONDARY_EMAIL`

Required iCloud variables:

* `ICLOUD_EMAIL`, `ICLOUD_SEND_FROM`, `ICLOUD_APP_PASSWORD`

Optional iCloud connection variables are `ICLOUD_IMAP_SERVER`,
`ICLOUD_IMAP_PORT`, `ICLOUD_SMTP_SERVER`, and `ICLOUD_SMTP_PORT`.
`MAIL_CLI_STATE_DIR` controls triage state storage; `MAIL_CLI_SCRATCH_DIR`
controls the default attachment scratch directory.

## Checks

`bun run check` runs TypeScript type checking followed by the complete test
suite. Individual checks are available as `bun run typecheck` and
`bun run test`.

## License

MIT. See [LICENSE](LICENSE).
