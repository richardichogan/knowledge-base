/**
 * emailSync.ts
 *
 * IMAP-based email sync using imapflow + mailparser.
 * Connects to each account defined in EMAIL_ACCOUNTS, fetches messages
 * from the last 7 days, runs AI importance filtering, and upserts
 * important emails as source='email' content items.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Pool } from 'pg';
import { env } from '../../config/env.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { filterImportantEmails } from './emailImportanceFilter.js';
import type { ContentItem } from '../../types/contentItem.js';

interface EmailAccountConfig {
  label: string;
  email: string;
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass: string;
}

interface RawEmail {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  textBody: string;
  accountLabel: string;
  accountEmail: string;
}

/** Parse the EMAIL_ACCOUNTS env var, returning an empty array if not set/invalid. */
function parseEmailAccounts(): EmailAccountConfig[] {
  const raw = env.EMAIL_ACCOUNTS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as EmailAccountConfig[];
  } catch {
    console.error('[EmailSync] Failed to parse EMAIL_ACCOUNTS — check JSON formatting');
    return [];
  }
}

/** Fetch emails from a single IMAP account since the given date. */
async function fetchFromAccount(
  account: EmailAccountConfig,
  since: Date,
): Promise<RawEmail[]> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: { user: account.user, pass: account.pass },
    logger: {
      debug: (): void => { /* suppress */ },
      info: (obj: Record<string, unknown>): void => { console.warn('[IMAP]', JSON.stringify(obj)); },
      warn: (obj: Record<string, unknown>): void => { console.warn('[IMAP WARN]', JSON.stringify(obj)); },
      error: (obj: Record<string, unknown>): void => { console.error('[IMAP ERROR]', JSON.stringify(obj)); },
    },
  });

  const emails: RawEmail[] = [];
  await client.connect();

  try {
    await client.mailboxOpen('INBOX');

    const searchResult = await client.search({ since });
    // search() returns false when the mailbox is empty
    const uids: number[] = searchResult === false ? [] : searchResult;
    if (uids.length === 0) return emails;

    const CHUNK = 50;
    for (let i = 0; i < uids.length; i += CHUNK) {
      // Explicitly typed so fetch() sees number[] not (false | number[])
      const chunk: number[] = uids.slice(i, i + CHUNK);

      for await (const msg of client.fetch(chunk, { source: true })) {
        const src = msg.source;
        if (!src) continue;

        let subject = '(no subject)';
        let fromText = 'unknown';
        let date = new Date().toISOString();
        let textBody = '';
        let messageId = `${account.email}-${String(msg.uid)}-${String(Date.now())}`;

        try {
          // simpleParser returns Promise<ParsedMail> — await it cleanly
          const parsed = await simpleParser(src);
          subject = parsed.subject ?? subject;
          fromText = parsed.from?.text ?? parsed.from?.value[0]?.address ?? fromText;
          date = parsed.date?.toISOString() ?? date;
          const rawText: string = typeof parsed.text === 'string' ? parsed.text
            : typeof parsed.html === 'string' ? parsed.html
            : '';
          const MAX_BODY = 5_000;
          textBody = rawText.slice(0, MAX_BODY);
          messageId = parsed.messageId ?? messageId;
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.error(`[EmailSync] Parse error uid=${String(msg.uid)} in ${account.email}: ${errMsg}`);
        }

        emails.push({ messageId, subject, from: fromText, date, textBody, accountLabel: account.label, accountEmail: account.email });
      }
    }
  } finally {
    await client.logout();
  }

  return emails;
}

/** Convert a RawEmail to a ContentItem for upsert. */
function emailToContentItem(email: RawEmail): Omit<ContentItem, 'id' | 'indexedAt'> {
  const title = `[${email.accountLabel}] ${email.subject}`;
  const DATE_PREFIX_LEN = 10; // YYYY-MM-DD
  const summary = `From: ${email.from} on ${email.date.slice(0, DATE_PREFIX_LEN)}`;
  const body = `From: ${email.from}\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.textBody}`;

  return {
    source: 'email',
    sourceId: email.messageId,
    title,
    summary,
    body,
    publishedAt: email.date,
    projectContext: 'personal',
    metadata: {
      from: email.from,
      account: email.accountEmail,
      accountLabel: email.accountLabel,
    },
    tags: ['email', email.accountLabel],
  };
}

/** Main sync function — runs all configured email accounts. */
export async function syncEmails(db: Pool): Promise<{ indexed: number; errors: number }> {
  const accounts = parseEmailAccounts();
  if (accounts.length === 0) {
    console.warn('[EmailSync] No EMAIL_ACCOUNTS configured — skipping email sync');
    return { indexed: 0, errors: 0 };
  }

  // Sync window: last 7 days (or since last sync if we add state tracking)
  const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000; // eslint-disable-line @typescript-eslint/no-magic-numbers
  const since = new Date(Date.now() - SYNC_WINDOW_MS);

  let totalIndexed = 0;
  let totalErrors = 0;

  for (const account of accounts) {
    if (!account.pass) {
      console.warn(`[EmailSync] Skipping ${account.email} — no password configured`);
      continue;
    }

    console.warn(`[EmailSync] Connecting to ${account.email} (${account.host}:${account.port})`);

    let accountEmails: RawEmail[] = [];
    try {
      accountEmails = await fetchFromAccount(account, since);
      console.warn(`[EmailSync] ${account.email}: fetched ${accountEmails.length} messages since ${since.toISOString().split('T')[0]}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[EmailSync] Failed to fetch from ${account.email}: ${message}`);
      totalErrors++;
      await upsertSyncState(db, `email-${account.label}`, {
        lastSyncAt: new Date(),
        lastError: message,
        itemCount: 0,
      });
      continue;
    }

    if (accountEmails.length === 0) {
      await upsertSyncState(db, `email-${account.label}`, {
        lastSyncAt: new Date(),
        lastError: null,
        itemCount: 0,
      });
      continue;
    }

    // Run AI importance filter
    let importanceMask: boolean[];
    try {
      importanceMask = await filterImportantEmails(
        accountEmails.map(e => ({ subject: e.subject, from: e.from, date: e.date })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[EmailSync] AI filter failed for ${account.email}: ${message} — indexing all`);
      importanceMask = accountEmails.map(() => true);
    }

    const importantEmails = accountEmails.filter((_, idx) => importanceMask[idx]);
    console.warn(
      `[EmailSync] ${account.email}: ${importantEmails.length}/${accountEmails.length} emails passed importance filter`,
    );

    let accountIndexed = 0;
    for (const email of importantEmails) {
      try {
        const item = emailToContentItem(email);
        await upsertContentItem(db, item);
        accountIndexed++;
      } catch (err) {
        totalErrors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[EmailSync] Upsert failed for message ${email.messageId}: ${message}`);
      }
    }

    totalIndexed += accountIndexed;

    await upsertSyncState(db, `email-${account.label}`, {
      lastSyncAt: new Date(),
      lastError: null,
      itemCount: accountIndexed,
    });
  }

  return { indexed: totalIndexed, errors: totalErrors };
}
