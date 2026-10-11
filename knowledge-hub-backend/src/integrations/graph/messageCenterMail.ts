/**
 * messageCenterMail.ts — Microsoft 365 Message Center emails (o365mc@microsoft.com) → Discover.
 *
 * The tenant's Message Center notifications arrive in the blog mailbox. Each MC post becomes a
 * discovered article (group "Microsoft"), so it is scored, shown in Discover, and included in the
 * Monday "what's new" Microsoft digest. Keyed by MC id, so a re-sent or updated post updates in place.
 */
import type { Pool } from 'pg';
import { upsertContentItem } from '../../db/queries.js';
import { decodeEntities } from '../discovery/feedReader.js';

export const MESSAGE_CENTER_SENDER = 'o365mc@microsoft.com';
export const MESSAGE_CENTER_SOURCE_ID = 'message-center';
export const MESSAGE_CENTER_SOURCE_TITLE = 'Microsoft 365 Message Center';
const MAX_BODY_CHARS = 6_000;

export interface MessageCenterPost {
  mcId: string;
  title: string;
  body: string;
  major: boolean;
}

export function isMessageCenterSender(address: string | undefined): boolean {
  return address?.trim().toLowerCase() === MESSAGE_CENTER_SENDER;
}

export function messageCenterUrl(mcId: string): string {
  return `https://admin.microsoft.com/Adminportal/Home#/MessageCenter/:/messages/${mcId}`;
}

/** Email HTML → plain text that keeps its line structure (the MC parser works line by line). */
export function emailHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MC_LINE = /^(MC\d{5,9})\b\s*(?:·|\||-|–)?/;
const NOISE_LINE = /^(view the description of the update\.?|tenant id:.*|view in message center.*|view this update.*)$/i;

/**
 * Splits a Message Center email (plain text) into its posts. Each post is its title line, then a
 * line starting with the MC id ("MC1492954 · ORG NAME"), then the description. A weekly-digest
 * style email with several posts gives several entries.
 */
export function parseMessageCenterEmail(text: string, subject = ''): MessageCenterPost[] {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const major = /major update/i.test(subject);
  const anchors: Array<{ line: number; mcId: string; titleLine: number }> = [];
  lines.forEach((line, i) => {
    const m = MC_LINE.exec(line);
    if (m === null) return;
    let t = i - 1;
    while (t >= 0 && (lines[t] === '' || NOISE_LINE.test(lines[t]!))) t--;
    if (t >= 0 && !MC_LINE.test(lines[t]!)) anchors.push({ line: i, mcId: m[1]!, titleLine: t });
  });

  const posts: MessageCenterPost[] = [];
  const seen = new Set<string>();
  anchors.forEach((a, k) => {
    if (seen.has(a.mcId)) return;
    seen.add(a.mcId);
    const end = k + 1 < anchors.length ? anchors[k + 1]!.titleLine : lines.length;
    const body = lines.slice(a.line + 1, end)
      .filter((l) => !NOISE_LINE.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_BODY_CHARS);
    posts.push({ mcId: a.mcId, title: lines[a.titleLine]!, body, major });
  });

  // No title/id layout found: fall back to the first MC id anywhere and the subject.
  if (posts.length === 0) {
    const id = /\bMC\d{5,9}\b/.exec(text)?.[0];
    if (id !== undefined && subject.trim() !== '') {
      posts.push({ mcId: id, title: subject.trim(), body: text.trim().slice(0, MAX_BODY_CHARS), major });
    }
  }
  return posts;
}

/** Adds each post not already in Discover (the inbox is re-read every sync). Returns how many were new. */
export async function upsertMessageCenterPosts(db: Pool, posts: MessageCenterPost[], receivedAt: string): Promise<number> {
  if (posts.length === 0) return 0;
  const known = await db.query<{ url: string }>(
    `SELECT url FROM content_items WHERE source = 'discovered-article' AND url = ANY($1)`,
    [posts.map((p) => messageCenterUrl(p.mcId))],
  );
  const knownUrls = new Set(known.rows.map((r) => r.url));
  const discoveredAt = new Date().toISOString();
  let stored = 0;
  for (const p of posts.filter((post) => !knownUrls.has(messageCenterUrl(post.mcId)))) {
    await upsertContentItem(db, {
      source: 'discovered-article',
      sourceId: `mc-${p.mcId}`,
      title: `${p.title} (${p.mcId})`,
      summary: `via ${MESSAGE_CENTER_SOURCE_TITLE}${p.major ? ' · major update' : ''} · discovered ${discoveredAt.slice(0, 10)}`,
      body: p.body,
      publishedAt: receivedAt,
      url: messageCenterUrl(p.mcId),
      projectContext: 'msft-blog',
      metadata: {
        originalPublishedAt: receivedAt,
        discoveredAt,
        sourceTitle: MESSAGE_CENTER_SOURCE_TITLE,
        sourceUrl: 'https://admin.microsoft.com/Adminportal/Home#/MessageCenter',
        sourceId: MESSAGE_CENTER_SOURCE_ID,
        sourceGroup: 'Microsoft',
        mcId: p.mcId,
        majorUpdate: p.major,
        status: 'new',
      },
      tags: [MESSAGE_CENTER_SOURCE_TITLE],
    });
    stored++;
  }
  return stored;
}
