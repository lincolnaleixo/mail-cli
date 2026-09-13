/**
 * Credential loader for the email skill.
 *
 * Credentials are injected into this process by the audited System Vault client:
 *   system-vault run inbox_triage -- bun ...
 *
 * Secret values stay in the child environment and are never written to disk.
 */

import type { GmailAccountCreds, ICloudCreds } from './types';

let cachedGmailPersonal: GmailAccountCreds | null = null;
let cachedGmailLln: GmailAccountCreds | null = null;
let cachedIcloud: ICloudCreds | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}; run through: system-vault run inbox_triage -- bun ...`);
  }
  return value;
}

export function gmailPersonalCreds(): GmailAccountCreds {
  if (!cachedGmailPersonal) {
    cachedGmailPersonal = {
      client_id: required('GMAIL_PERSONAL_CLIENT_ID'),
      client_secret: required('GMAIL_PERSONAL_CLIENT_SECRET'),
      refresh_token: required('GMAIL_PERSONAL_REFRESH_TOKEN'),
      email: 'lincolnmorais@gmail.com',
    };
  }
  return cachedGmailPersonal;
}

export function gmailLlnCreds(): GmailAccountCreds {
  if (!cachedGmailLln) {
    cachedGmailLln = {
      client_id: required('GMAIL_LLN_CLIENT_ID'),
      client_secret: required('GMAIL_LLN_CLIENT_SECRET'),
      refresh_token: required('GMAIL_LLN_REFRESH_TOKEN'),
      email: 'lincoln@longlifenutri.com',
    };
  }
  return cachedGmailLln;
}

export function icloudCreds(): ICloudCreds {
  if (!cachedIcloud) {
    cachedIcloud = {
      email: 'lincolnmorais@icloud.com',
      sendFrom: ['contact@bakeitfun.com'],
      imapServer: 'imap.mail.me.com',
      imapPort: 993,
      smtpServer: 'smtp.mail.me.com',
      smtpPort: 587,
      appSpecificPassword: required('ICLOUD_APP_PASSWORD'),
    };
  }
  return cachedIcloud;
}
