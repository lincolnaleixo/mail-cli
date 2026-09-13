/** Load provider credentials and mailbox identities from the environment. */

import type { GmailAccountCreds, ICloudCreds } from './types';

let cachedGmailPersonal: GmailAccountCreds | null = null;
let cachedGmailSecondary: GmailAccountCreds | null = null;
let cachedIcloud: ICloudCreds | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

export function gmailPersonalCreds(): GmailAccountCreds {
  if (!cachedGmailPersonal) {
    cachedGmailPersonal = {
      client_id: required('GMAIL_PERSONAL_CLIENT_ID'),
      client_secret: required('GMAIL_PERSONAL_CLIENT_SECRET'),
      refresh_token: required('GMAIL_PERSONAL_REFRESH_TOKEN'),
      email: required('GMAIL_PERSONAL_EMAIL'),
    };
  }
  return cachedGmailPersonal;
}

export function gmailSecondaryCreds(): GmailAccountCreds {
  if (!cachedGmailSecondary) {
    cachedGmailSecondary = {
      client_id: required('GMAIL_SECONDARY_CLIENT_ID'),
      client_secret: required('GMAIL_SECONDARY_CLIENT_SECRET'),
      refresh_token: required('GMAIL_SECONDARY_REFRESH_TOKEN'),
      email: required('GMAIL_SECONDARY_EMAIL'),
    };
  }
  return cachedGmailSecondary;
}

export function icloudCreds(): ICloudCreds {
  if (!cachedIcloud) {
    cachedIcloud = {
      email: required('ICLOUD_EMAIL'),
      sendFrom: required('ICLOUD_SEND_FROM').split(',').map((value) => value.trim()).filter(Boolean),
      imapServer: process.env.ICLOUD_IMAP_SERVER || 'imap.mail.me.com',
      imapPort: Number(process.env.ICLOUD_IMAP_PORT || 993),
      smtpServer: process.env.ICLOUD_SMTP_SERVER || 'smtp.mail.me.com',
      smtpPort: Number(process.env.ICLOUD_SMTP_PORT || 587),
      appSpecificPassword: required('ICLOUD_APP_PASSWORD'),
    };
  }
  return cachedIcloud;
}
