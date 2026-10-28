/**
 * graphMailSync.ts
 *
 * Syncs emails from two M365 mailboxes on the same tenant via Microsoft Graph:
 *   - richard.hogan@themicrosoftcloudblog.com  (/me/)
 *   - podcast@themicrosoftcloudblog.com         (/users/podcast@...)
 *
 * Uses the existing GraphClient (same OAuth2 refresh token flow as calendar/todo).
 * Requires Mail.Read and Mail.Read.Shared scopes. For the podcast shared mailbox the token account
 * must have FullAccess or at minimum read permissions on that mailbox.
 *
 * Fetches the last 30 days of inbox messages, runs AI importance filtering,
 * and upserts important ones as source='email' content items. Microsoft 365
 * Message Center emails skip the filter and go to Discover, one article per MC post.
 */

import type { Pool } from 'pg';
import { getGraphClient } from './graphClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { filterImportantEmails } from '../email/emailImportanceFilter.js';
import type { ContentItem } from '../../types/contentItem.js';
import { emailHtmlToText, isMessageCenterSender, parseMessageCenterEmail, upsertMessageCenterPosts } from './messageCenterMail.js';
import { addSourceFailure, syncFailureSummary, type SyncFailure } from '../../sync/sourceDiagnostics.js';

const SYNC_SOURCE = 'email';
const SYNC_STATE_KEY = 'graph-mail';
const SYNC_WINDOW_DAYS = 30; // eslint-disable-line @typescript-eslint/no-magic-numbers
const MAX_BODY_CHARS = 5_000;

interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { content: string; contentType: 'text' | 'html' };
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  webLink: string;
  isRead: boolean;
}

interface MailboxConfig {
  /** Graph API path prefix, e.g. '/me' or '/users/podcast@themicrosoftcloudblog.com' */
  apiPath: string;
  account: string;
  accountLabel: string;
  projectContext: string;
}

const MAILBOXES: MailboxConfig[] = [
  {
    apiPath: '/me',
    account: 'richard.hogan@themicrosoftcloudblog.com',
    accountLabel: 'blog',
    projectContext: 'msft-blog',
  },
  {
    apiPath: '/users/podcast@themicrosoftcloudblog.com',
    account: 'podcast@themicrosoftcloudblog.com',
    accountLabel: 'podcast',
    projectContext: 'msft-blog',
  },
];

/**
 * Syncs M365 inbox mail for all configured mailboxes via Microsoft Graph.
 * Only important messages (AI-scored >= 3) are indexed.
 */
export async function syncGraphMail(
  db: Pool,
): Promise<{ indexed: number; errors: number; failures: SyncFailure[] }> {
  const client = getGraphClient();
  let indexed = 0;
  let errors = 0;
  const failures: SyncFailure[] = [];

  const since = new Date(
    Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1_000, // eslint-disable-line @typescript-eslint/no-magic-numbers
  );
  const sinceIso = since.toISOString();

  for (const mailbox of MAILBOXES) {
    try {
      const messages: GraphMessage[] = [];

      for await (const page of client.paginate<GraphMessage>(
        `${mailbox.apiPath}/mailFolders/inbox/messages`,
        {
          $filter: `receivedDateTime ge ${sinceIso}`,
          $select: 'id,subject,bodyPreview,body,from,receivedDateTime,webLink,isRead',
          $top: '50',
          $orderby: 'receivedDateTime desc',
        },
      )) {
        messages.push(...page);
      }

      // Message Center posts go to Discover (scored there, and into the Monday Microsoft digest).
      const messageCenter = messages.filter((m) => isMessageCenterSender(m.from?.emailAddress?.address));
      let mcPosts = 0;
      for (const msg of messageCenter) {
        try {
          const text = msg.body.contentType === 'html' ? emailHtmlToText(msg.body.content) : msg.body.content;
          mcPosts += await upsertMessageCenterPosts(db, parseMessageCenterEmail(text, msg.subject ?? ''), msg.receivedDateTime);
        } catch (err) {
          addSourceFailure(failures, mailbox.accountLabel, err);
          errors++;
          console.error(`[GraphMail] Message Center email ${msg.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (messageCenter.length > 0) {
        console.warn(`[GraphMail] ${mailbox.accountLabel}: ${String(messageCenter.length)} Message Center email(s), ${String(mcPosts)} new Discover item(s)`);
      }
      const mail = messages.filter((m) => !messageCenter.includes(m));
      if (mail.length === 0) continue;

      const importanceMask = await filterImportantEmails(
        mail.map(m => ({
          subject: m.subject ?? '(no subject)',
          from: `${m.from.emailAddress.name} <${m.from.emailAddress.address}>`,
          date: m.receivedDateTime,
        })),
      );

      const important = mail.filter((_, idx) => importanceMask[idx] === true);
      console.warn(
        `[GraphMail] ${mailbox.accountLabel}: ${String(important.length)}/${String(mail.length)} messages passed importance filter`,
      );

      for (const msg of important) {
        try {
          await upsertContentItem(db, messageToContentItem(msg, mailbox));
          indexed++;
        } catch (err) {
          addSourceFailure(failures, mailbox.accountLabel, err);
          errors++;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[GraphMail] Upsert failed for ${msg.id}: ${message}`);
        }
      }
    } catch (err) {
      addSourceFailure(failures, mailbox.accountLabel, err);
      const failure = failures[failures.length - 1];
      if (failure?.code === 'access-denied' && mailbox.apiPath !== '/me') {
        failure.action = 'Reconnect Microsoft Graph at /auth/graph to consent to Mail.Read.Shared, and verify shared-mailbox read access.';
      }
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GraphMail] Failed for mailbox ${mailbox.account}: ${message}`);
    }
  }

  await upsertSyncState(db, SYNC_STATE_KEY, {
    lastSyncAt: new Date(),
    lastError: syncFailureSummary(errors, failures),
    itemCount: indexed,
  });

  return { indexed, errors, failures };
}

function messageToContentItem(
  msg: GraphMessage,
  mailbox: MailboxConfig,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const from = `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`;
  const DATE_PREFIX_LEN = 10; // YYYY-MM-DD
  const subject = msg.subject ?? '(no subject)';

  const rawBody =
    msg.body.contentType === 'text'
      ? msg.body.content
      : msg.bodyPreview;
  const body = rawBody.slice(0, MAX_BODY_CHARS);

  return {
    source: SYNC_SOURCE,
    sourceId: `graph-${mailbox.accountLabel}-${msg.id}`,
    title: `[${mailbox.accountLabel}] ${subject}`,
    summary: `From: ${from} on ${msg.receivedDateTime.slice(0, DATE_PREFIX_LEN)}`,
    body: `From: ${from}\nDate: ${msg.receivedDateTime}\nSubject: ${subject}\n\n${body}`,
    publishedAt: msg.receivedDateTime,
    url: msg.webLink,
    projectContext: mailbox.projectContext,
    metadata: {
      from,
      account: mailbox.account,
      accountLabel: mailbox.accountLabel,
      isRead: msg.isRead,
      graphId: msg.id,
    },
    tags: ['email', mailbox.accountLabel],
  };
}
