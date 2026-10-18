/**
 * integrations/alliance/allianceMailSync.ts — IBM Alliance inbox via Microsoft
 * Graph (delegated Mail.Read, the signed-in Alliance account).
 *
 * Runs once the stored sign-in has been granted Mail.Read (user consent: the
 * user reconnects at /auth/alliance). ALLIANCE_MAIL_ENABLED=false turns it
 * off. Mirrors graphMailSync: last 30
 * days of inbox, AI importance filter, important mail indexed as source='email'.
 */

import type { Pool } from 'pg';
import { env } from '../../config/env.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import type { ContentItem } from '../../types/contentItem.js';
import { MS_PER_DAY } from '../../config/constants.js';
import { filterImportantEmails } from '../email/emailImportanceFilter.js';
import { allianceGraphGet, getAllianceStatus, isAllianceConfigured } from './allianceGraph.js';

const SYNC_STATE_KEY = 'alliance-mail';
const SYNC_WINDOW_DAYS = 30;
const MAX_BODY_CHARS = 5_000;
const ISO_DATE_CHARS = 10;
const ACCOUNT_LABEL = 'alliance';

export interface AllianceMessage {
  id: string;
  subject: string | null;
  bodyPreview: string;
  body?: { content: string; contentType: 'text' | 'html' };
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime: string;
  webLink: string;
  isRead: boolean;
}

interface MessagePage {
  value: AllianceMessage[];
  '@odata.nextLink'?: string;
}

export function allianceInboxPath(since: Date): string {
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $select: 'id,subject,bodyPreview,body,from,receivedDateTime,webLink,isRead',
    $top: '50',
    $orderby: 'receivedDateTime desc',
  });
  return `/me/mailFolders/inbox/messages?${params.toString()}`;
}

function sender(msg: AllianceMessage): string {
  const name = msg.from?.emailAddress?.name ?? '';
  const address = msg.from?.emailAddress?.address ?? 'unknown';
  return name ? `${name} <${address}>` : address;
}

export function allianceMessageToContentItem(msg: AllianceMessage, account: string): Omit<ContentItem, 'id' | 'indexedAt'> {
  const from = sender(msg);
  const subject = msg.subject ?? '(no subject)';
  const raw = msg.body?.contentType === 'text' ? msg.body.content : msg.bodyPreview;
  return {
    source: 'email',
    sourceId: `alliance-${msg.id}`,
    title: `[${ACCOUNT_LABEL}] ${subject}`,
    summary: `From: ${from} on ${msg.receivedDateTime.slice(0, ISO_DATE_CHARS)}`,
    body: `From: ${from}\nDate: ${msg.receivedDateTime}\nSubject: ${subject}\n\n${raw.slice(0, MAX_BODY_CHARS)}`,
    publishedAt: msg.receivedDateTime,
    url: msg.webLink,
    projectContext: 'personal',
    metadata: { from, account, accountLabel: ACCOUNT_LABEL, isRead: msg.isRead, graphId: msg.id },
    tags: ['email', ACCOUNT_LABEL],
  };
}

/** Syncs important Alliance inbox mail. No-op until enabled, connected and consented. */
export async function syncAllianceMail(db: Pool): Promise<{ indexed: number; errors: number }> {
  if (!env.ALLIANCE_MAIL_ENABLED || !isAllianceConfigured()) return { indexed: 0, errors: 0 };
  const status = await getAllianceStatus(db);
  if (!status.connected) {
    await upsertSyncState(db, SYNC_STATE_KEY, { lastError: 'Alliance account not connected' });
    return { indexed: 0, errors: 0 };
  }
  if (!status.mailAccess) {
    await upsertSyncState(db, SYNC_STATE_KEY, {
      lastError: 'Mail.Read not granted — reconnect at /auth/alliance and accept the mail permission',
    });
    return { indexed: 0, errors: 0 };
  }

  const account = status.account ?? env.ALLIANCE_ALLOWED_UPN ?? 'alliance';
  const messages: AllianceMessage[] = [];
  try {
    let next: string | undefined = allianceInboxPath(new Date(Date.now() - SYNC_WINDOW_DAYS * MS_PER_DAY));
    while (next !== undefined) {
      const page: MessagePage = await allianceGraphGet<MessagePage>(db, next);
      messages.push(...page.value);
      next = page['@odata.nextLink'];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertSyncState(db, SYNC_STATE_KEY, { lastError: `Inbox read failed: ${message}` });
    console.error(`[AllianceMail] Inbox read failed: ${message}`);
    return { indexed: 0, errors: 1 };
  }

  let indexed = 0;
  let errors = 0;
  if (messages.length > 0) {
    const mask = await filterImportantEmails(messages.map((m) => ({
      subject: m.subject ?? '(no subject)', from: sender(m), date: m.receivedDateTime,
    })));
    const important = messages.filter((_, i) => mask[i] === true);
    console.warn(`[AllianceMail] ${String(important.length)}/${String(messages.length)} messages passed importance filter`);
    for (const msg of important) {
      try {
        await upsertContentItem(db, allianceMessageToContentItem(msg, account));
        indexed++;
      } catch (err) {
        errors++;
        console.error(`[AllianceMail] Upsert failed for ${msg.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await upsertSyncState(db, SYNC_STATE_KEY, {
    lastSyncAt: new Date(), lastError: errors > 0 ? `${String(errors)} errors` : null, itemCount: indexed,
  });
  return { indexed, errors };
}
