# mail-cli

Email CLI for Gmail and iCloud workflows

## Install

## Use

## License

MIT.
# mail-cli

A TypeScript CLI for reading, searching, triaging, drafting, and explicitly authorized email operations across configured Gmail and iCloud accounts.

## Install

Requires Bun. Clone this repository, run `bun install`, then run `bun run check`.

## Use

The executable is `./bin/mail-cli`. The default invocation is:

```bash
system-vault run inbox_triage -- ./bin/mail-cli help
```

Commands: `inbox`, `unread`, `search`, `read`, `thread`, `folders`, `attachments`, `triage-sweep`, `triage-mark`, `archive`, `move`, `trash`, `draft`, `reply`, `send`, and `help`. Writes require explicit authorization; sending additionally requires `--confirm-send`.

## Environment

Credentials are read only from environment variables. Inject them with your organization's secret broker; never commit a `.env` file or put secret values in arguments.

Gmail account variables are `GMAIL_PERSONAL_CLIENT_ID`, `GMAIL_PERSONAL_CLIENT_SECRET`, `GMAIL_PERSONAL_REFRESH_TOKEN`, `GMAIL_LLN_CLIENT_ID`, `GMAIL_LLN_CLIENT_SECRET`, `GMAIL_LLN_REFRESH_TOKEN`; iCloud uses `ICLOUD_APP_PASSWORD`.

## License

MIT. See [LICENSE](LICENSE).
