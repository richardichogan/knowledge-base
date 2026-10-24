import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { MS_PER_HOUR } from '../config/constants.js';
import { ValidationError, IntegrationError } from '../types/errors.js';
import { parsePublishBody, sendToBlog } from '../services/blogPublisher.js';
import { postToBluesky } from '../integrations/social/bluesky.js';
import { postToLinkedIn, getLinkedInMember } from '../integrations/social/linkedin.js';
import { articleProse, readPublicPage } from '../utils/articleReading.js';
import { assessTopic, editorialServices, readSources, reviewDraft, type EditorialServices } from './editorial.js';
import { assertSocialOpportunity, deliver, destinationAccount, inWindow, PublicationDeferred, PublicationUnconfirmed } from './delivery.js';
import { deliveryColumns, draftColumns, event, feeds, holdTopic, intake, sourceColumns, topicColumns } from './store.js';
import { PUBLISH_LIMITS, type Delivery, type Draft, type Source, type Topic } from './contracts.js';

export interface PublishingServices {
  blog: typeof sendToBlog; bluesky: typeof postToBluesky; linkedin: typeof postToLinkedIn; read: typeof readPublicPage;
  member: typeof getLinkedInMember;
}
const publishingServices: PublishingServices = { blog: sendToBlog, bluesky: postToBluesky, linkedin: postToLinkedIn, read: readPublicPage, member: getLinkedInMember };
const normalise = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export async function verifyBlog(url: string, content: Record<string, unknown>, read = readPublicPage): Promise<{ url: string; verifiedAt: string }> {
  let target: URL;
  try { target = new URL(url); } catch { throw new ValidationError('Provide the final public HTTPS article URL.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || /preview|wp-admin|\/edit(?:\/|$)/i.test(target.pathname)
    || target.hostname !== new URL(env.BLOG_POSTS_URL).hostname) throw new ValidationError('Provide the final public HTTPS article URL on the configured blog, not an editor or preview.');
  const actual = await read(target.href);
  if (actual.finalUrl) {
    const final = new URL(actual.finalUrl);
    if (final.hostname !== target.hostname || final.search || /preview|wp-admin|\/edit(?:\/|$)/i.test(final.pathname)) throw new ValidationError('The article redirected away from its public blog location.');
  }
  const expected = normalise(articleProse(String(content.content)));
  const body = normalise(actual.text);
  const snippet = PUBLISH_LIMITS.verificationChars;
  if (!normalise(actual.title).includes(normalise(String(content.title)))
    || expected.length < snippet || !body.includes(expected.slice(0, snippet))
    || !body.includes(expected.slice(Math.floor(expected.length / PUBLISH_LIMITS.half), Math.floor(expected.length / PUBLISH_LIMITS.half) + snippet))) {
    throw new ValidationError('The public URL does not contain the expected article. Check the blog before promoting it.');
  }
  return { url: target.href, verifiedAt: new Date().toISOString() };
}
export async function publishDraft(db: Pool, draft: Draft, services = publishingServices): Promise<void> {
  const feed = draft.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin';
  const account = draft.destination === 'linkedin' ? String(draft.content.account) : destinationAccount(draft.destination);
  const context = { identity: `draft:${draft.id}:v${draft.version}`, topicId: draft.topicId, draftId: draft.id, version: draft.version, feed, distinctArgument: draft.distinctArgument } as const;
  if (draft.destination === 'blog') {
    // Check LinkedIn's opportunity before making the paired blog publicly visible.
    const memberDraft = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1 AND destination='linkedin'`, [draft.topicId])).rows[0];
    if (!memberDraft) throw new PublicationDeferred('The LinkedIn hook is missing.');
    const member = await services.member();
    if (member.id !== memberDraft.content.account) throw new PublicationDeferred('LinkedIn account changed. Rebind and reapprove the hook.');
    await assertSocialOpportunity(db, 'linkedin', member.id);
    await deliver(db, 'blog', account, context, async () => {
      const result = await services.blog(parsePublishBody(draft.content));
      if (!result.payload.success) {
        if (result.httpStatus >= PUBLISH_LIMITS.serverError || result.payload.error.code === 'BLOG_DUPLICATE') throw new PublicationUnconfirmed(result.payload.error.message);
        throw new IntegrationError('blog', result.payload.error.message);
      }
      if (!result.payload.data.url) throw new PublicationUnconfirmed('Blog accepted the article without a public URL. Reconcile it; do not republish.');
      try { return { ...result.payload.data, ...await verifyBlog(result.payload.data.url, draft.content, services.read) }; }
      catch (error) { throw new PublicationUnconfirmed(`Blog accepted, but public verification failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    });
    return;
  }
  let url: string;
  let title: string;
  if (draft.variant === 'blog') {
    const receipt = (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE topic_id=$1 AND destination='blog' AND status='sent'`, [draft.topicId])).rows[0]?.receipt;
    if (!receipt?.verifiedAt || typeof receipt.url !== 'string') throw new PublicationDeferred('Waiting for the verified public blog URL.');
    url = receipt.url;
    const blog = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1 AND destination='blog'`, [draft.topicId])).rows[0]!;
    title = String(blog.content.title);
    await verifyBlog(url, blog.content, services.read);
  } else {
    const source = (await db.query<Source>(`SELECT ${sourceColumns} FROM publishing_sources WHERE topic_id=$1 AND read_at IS NOT NULL ORDER BY discovered_at LIMIT 1`, [draft.topicId])).rows[0];
    if (!source) throw new PublicationDeferred('No fully read source is available.');
    url = source.url; title = source.title;
  }
  const copy = String(draft.content.copy);
  const receipt = draft.destination === 'bluesky'
    ? await deliver(db, 'bluesky', account, context, () => services.bluesky(copy, { url, title, description: '' }))
    : await deliver(db, 'linkedin', account, context, () => services.linkedin(copy, { url, title }, account));
  const key = draft.destination === 'bluesky' ? 'blueskyPost' : 'linkedinPost';
  await db.query(`UPDATE content_items SET workflow_state='published',
    metadata=COALESCE(metadata,'{}') || jsonb_build_object($2::text,$3::jsonb)
    WHERE id IN (SELECT item_id FROM publishing_sources WHERE topic_id=$1)`, [draft.topicId, key,
    JSON.stringify({ ...receipt, status: 'posted', postedAt: new Date().toISOString(), ledgerManaged: true, draftId: draft.id })]);
}

export async function tickPublishing(db: Pool, editorial: EditorialServices = editorialServices, publishing = publishingServices): Promise<void> {
  if (env.NODE_ENV !== 'production' || env.isDevelopment) return;
  const lock = await db.connect();
  const key = 'athena-discover-publishing';
  let acquired = false;
  try {
    acquired = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])).rows[0]?.locked === true;
    if (!acquired) return;
    await db.query(`UPDATE publishing_topics SET state='held',lease=NULL,lease_until=NULL,error='Editorial worker interrupted. Review or reassess this topic.'
      WHERE state='assessing' AND lease_until<NOW()`);
    await intake(db);
    const lease = randomUUID();
    const topic = (await db.query<Topic>(`UPDATE publishing_topics SET state='assessing',lease=$1,lease_until=NOW()+INTERVAL '15 minutes'
      WHERE id=(SELECT id FROM publishing_topics WHERE state='pending'
        AND (SELECT COUNT(*) FROM publishing_events WHERE event='preparation-started' AND created_at>NOW()-INTERVAL '24 hours')<$2
        ORDER BY priority DESC,created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${topicColumns}`, [lease, PUBLISH_LIMITS.dailyAssessments])).rows[0];
    if (topic) {
      await event(db, topic.id, 'editorial-worker', 'preparation-started', {});
      try { await assessTopic(db, topic, editorial); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Editorial preparation failed';
        console.error('[Publishing] Editorial preparation held:', message);
        await holdTopic(db, topic.id, false, 'editorial-worker', message);
      } finally { await db.query('UPDATE publishing_topics SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2', [topic.id, lease]); }
    }
    const review = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE review='pending' AND NOT held
      AND topic_id IN(SELECT id FROM publishing_topics WHERE state='ready') ORDER BY updated_at LIMIT 1`)).rows[0];
    if (review) {
      const delivered = await db.query("SELECT id FROM publishing_deliveries WHERE draft_id=$1 AND status IN ('sent','sending','unconfirmed')", [review.id]);
      try { await reviewDraft(db, review, await readSources(db, review.topicId, editorial), editorial, !delivered.rowCount); }
      catch (error) { await holdTopic(db, review.topicId, false, 'review-worker', error instanceof Error ? error.message : 'Review failed'); console.error('[Publishing] Review failed:', error); }
    }
    const settings = await feeds(db);
    const enabled = settings.filter(f => f.enabled && inWindow(f.policy, new Date())).map(f => f.id);
    if (!enabled.length) return;
    const queue = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts d
      WHERE NOT held AND approval<>'rejected' AND review='pass'
      AND ((destination='bluesky' AND $1) OR (destination<>'bluesky' AND $2))
      AND topic_id IN(SELECT id FROM publishing_topics WHERE state='ready')
      AND (variant='source' OR NOT EXISTS(SELECT 1 FROM publishing_drafts required WHERE required.topic_id=d.topic_id
        AND required.destination IN ('blog','linkedin') AND (required.approval<>'approved' OR required.held OR required.review<>'pass')))
      AND NOT EXISTS(SELECT 1 FROM publishing_deliveries p WHERE p.draft_id=d.id AND p.version=d.version AND p.status IN ('sent','sending','unconfirmed'))
      ORDER BY (SELECT priority FROM publishing_topics WHERE id=d.topic_id) DESC,created_at DESC LIMIT 20`,
    [enabled.includes('bluesky'), enabled.includes('blog-linkedin')])).rows;
    for (const draft of queue) {
      if (!enabled.includes(draft.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin')) continue;
      if (new Date(draft.expiresAt) <= new Date()) {
        await db.query("UPDATE publishing_drafts SET held=TRUE,reason='Expired before a publishing opportunity.' WHERE id=$1", [draft.id]);
        await event(db, draft.topicId, 'publisher', 'draft-expired', { id: draft.id }); continue;
      }
      try {
        const companions = draft.variant === 'blog' ? (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1 AND destination IN ('blog','linkedin')`, [draft.topicId])).rows : [];
        const stale = [draft, ...companions].filter(d => !d.reviewedAt
          || d.reviewedFeedRevision !== settings.find(f => f.id === (d.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin'))?.revision
          || Date.now() - new Date(d.reviewedAt).getTime() > PUBLISH_LIMITS.staleHours * MS_PER_HOUR);
        if (stale.length) {
          const sources = await readSources(db, draft.topicId, editorial);
          for (const candidate of new Map(stale.map(d => [d.id, d])).values()) await reviewDraft(db, candidate, sources, editorial, false);
          continue;
        }
        await publishDraft(db, draft, publishing);
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Publishing failed';
        await db.query('UPDATE publishing_drafts SET reason=$2 WHERE id=$1', [draft.id, reason]);
        if (error instanceof PublicationDeferred) continue;
        const retry = await db.query<{ next_attempt_at: string | null }>('SELECT next_attempt_at FROM publishing_deliveries WHERE draft_id=$1 AND version=$2', [draft.id, draft.version]);
        if (!retry.rows[0]?.next_attempt_at) await db.query('UPDATE publishing_drafts SET held=TRUE WHERE id=$1', [draft.id]);
        console.error('[Publishing] Delivery held:', reason);
        await event(db, draft.topicId, 'publisher', 'publishing-error', { draftId: draft.id, error: reason });
        break;
      }
    }
  } finally {
    try { if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); } finally { lock.release(); }
  }
}
