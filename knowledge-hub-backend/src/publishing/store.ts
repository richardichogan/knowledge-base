import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { cleanUrl } from '../integrations/discovery/feedReader.js';
import { MS_PER_HOUR } from '../config/constants.js';
import { microsoftRelevanceSql } from '../utils/microsoftRelevance.js';
import { parsePolicy, PUBLISH_LIMITS, type PublishingFeed, type Topic, type Source, type Draft, type Delivery, type FeedId } from './contracts.js';

export const topicColumns = `id,title,fingerprint,event_key AS "eventKey",rationale,priority,state,error,created_at::text AS "createdAt",assessed_at::text AS "assessedAt"`;
export const sourceColumns = `item_id AS "itemId",topic_id AS "topicId",title,url,body,read_at::text AS "readAt",discovered_at::text AS "discoveredAt"`;
export const draftColumns = `id,topic_id AS "topicId",destination,variant,version,content,review,approval,held,reason,
  distinct_argument AS "distinctArgument",reviewed_at::text AS "reviewedAt",expires_at::text AS "expiresAt",
  reviewed_blog_version AS "reviewedBlogVersion",reviewed_feed_revision AS "reviewedFeedRevision"`;
export const deliveryColumns = `id,identity,destination,topic_id AS "topicId",draft_id AS "draftId",version,account,status,
  attempted_at::text AS "attemptedAt",published_at::text AS "publishedAt",next_attempt_at::text AS "nextAttemptAt",attempts,receipt,error`;

export async function transaction<T>(db: Pool, action: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try { await c.query('BEGIN'); const result = await action(c); await c.query('COMMIT'); return result; }
  catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
export async function event(db: Pick<Pool, 'query'>, topicId: string | null, actor: string, name: string, detail: unknown): Promise<void> {
  await db.query('INSERT INTO publishing_events(topic_id,actor,event,detail) VALUES($1,$2,$3,$4)', [topicId, actor, name, JSON.stringify(detail)]);
}
export async function feeds(db: Pick<Pool, 'query'>): Promise<PublishingFeed[]> {
  return (await db.query<PublishingFeed>('SELECT id,enabled,revision,policy FROM publishing_feeds ORDER BY id')).rows;
}
export async function saveFeed(db: Pool, id: FeedId, revision: unknown, enabled: unknown, policy: unknown, actor: string): Promise<PublishingFeed> {
  if (!Number.isInteger(revision) || typeof enabled !== 'boolean') throw new ValidationError('Provide the current feed revision and explicit automation setting.');
  const parsed = parsePolicy(policy);
  return transaction(db, async c => {
    const prior = (await c.query<PublishingFeed>('SELECT id,enabled,revision,policy FROM publishing_feeds WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const result = await c.query<PublishingFeed>(`UPDATE publishing_feeds SET enabled=$3,policy=$4,revision=revision+1,updated_at=NOW()
      WHERE id=$1 AND revision=$2 RETURNING id,enabled,revision,policy`, [id, revision, enabled, JSON.stringify(parsed)]);
    if (!result.rows[0]) throw new ConflictError('Feed changed. Reload before saving.', 'PUBLISHING_CONFLICT');
    if (prior?.policy.guidance !== parsed.guidance) await c.query(`UPDATE publishing_drafts SET review='pending',approval='pending',reviewed_at=NULL,
      reason='Editorial guidance changed; review and approval required.' WHERE (destination='bluesky')=$1`, [id === 'bluesky']);
    await event(c, null, actor, 'feed-configured', result.rows[0]);
    return result.rows[0];
  });
}
export async function listTopics(db: Pool, offset = 0, shortlist = false): Promise<Array<Topic & { drafts: Draft[]; deliveries: Delivery[] }>> {
  const microsoft = `EXISTS(SELECT 1 FROM publishing_sources s WHERE s.topic_id=publishing_topics.id AND ${microsoftRelevanceSql('s')})`;
  const fresh = '(SELECT MAX(discovered_at) FROM publishing_sources s WHERE s.topic_id=publishing_topics.id)';
  const curated = shortlist ? `WITH eligible AS (
    SELECT d.topic_id,d.destination,row_number() OVER(PARTITION BY d.destination
      ORDER BY ${microsoft} DESC,${fresh} DESC,priority DESC,publishing_topics.created_at DESC,publishing_topics.id) AS position
    FROM publishing_topics JOIN publishing_drafts d ON d.topic_id=publishing_topics.id
    WHERE state='ready' AND d.destination IN ('bluesky','blog') AND d.review='pass' AND NOT d.held
      AND d.approval='pending' AND d.reviewed_at>NOW()-INTERVAL '24 hours'
      AND NOT EXISTS(SELECT 1 FROM publishing_drafts scheduled
        WHERE scheduled.topic_id=d.topic_id AND scheduled.approval='approved')
      AND NOT EXISTS(SELECT 1 FROM publishing_schedule scheduled
        JOIN publishing_drafts member ON member.id=scheduled.draft_id
        WHERE member.topic_id=d.topic_id AND member.version=scheduled.version)
      AND NOT EXISTS(SELECT 1 FROM publishing_deliveries delivered
        WHERE delivered.topic_id=d.topic_id AND delivered.status IN ('sent','sending','unconfirmed'))
      AND ((${microsoft}) OR (priority>=${PUBLISH_LIMITS.exceptionPriority} AND EXISTS(
        SELECT 1 FROM publishing_events e WHERE e.topic_id=publishing_topics.id AND e.event='selection'
          AND length(COALESCE(e.detail->>'exceptionReason',''))>0)))
      AND (CASE WHEN d.destination='blog' THEN NULLIF(BTRIM(d.content->>'content'),'') IS NOT NULL
        AND NULLIF(BTRIM(d.content->>'title'),'') IS NOT NULL AND NULLIF(BTRIM(d.content->>'summary'),'') IS NOT NULL
        ELSE NULLIF(BTRIM(d.content->>'copy'),'') IS NOT NULL END)
      AND NOT EXISTS(SELECT 1 FROM publishing_deliveries p WHERE p.draft_id=d.id AND p.version=d.version AND p.status IN ('sent','sending','unconfirmed'))
      AND (d.variant='source' OR (SELECT COUNT(*) FROM publishing_drafts companion
        WHERE companion.topic_id=d.topic_id AND companion.destination IN ('blog','linkedin') AND companion.review='pass'
          AND NOT companion.held AND companion.approval<>'rejected'
          AND companion.reviewed_at>NOW()-INTERVAL '24 hours')=${PUBLISH_LIMITS.packageDestinations})
      AND (d.destination='bluesky' OR EXISTS(SELECT 1 FROM publishing_drafts hook
        WHERE hook.topic_id=d.topic_id AND hook.destination='linkedin' AND hook.review='pass' AND NOT hook.held
          AND hook.approval<>'rejected' AND hook.reviewed_at>NOW()-INTERVAL '24 hours'
          AND hook.reviewed_blog_version=d.version AND NULLIF(BTRIM(hook.content->>'copy'),'') IS NOT NULL))
    ), shortlist AS (
      SELECT id FROM publishing_topics WHERE id IN (
        SELECT topic_id FROM eligible WHERE position<=CASE WHEN destination='bluesky'
          THEN ${PUBLISH_LIMITS.blueskyCap + PUBLISH_LIMITS.alternatives} ELSE ${PUBLISH_LIMITS.linkedinCap + PUBLISH_LIMITS.alternatives} END)
      ORDER BY ${microsoft} DESC,${fresh} DESC,priority DESC,created_at DESC,id
      LIMIT ${PUBLISH_LIMITS.draftShortlist}
    )` : '';
  const rows = (await db.query<Topic>(`${curated} SELECT ${topicColumns} FROM publishing_topics
    ${shortlist ? 'WHERE id IN (SELECT id FROM shortlist)' : ''}
    ORDER BY EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=publishing_topics.id) DESC,
      ${shortlist ? `${microsoft} DESC,${fresh} DESC,priority DESC,` : ''}created_at DESC,id
    LIMIT ${PUBLISH_LIMITS.maxHistory} OFFSET $1`, [offset])).rows;
  const drafts = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=ANY($1::uuid[])`, [rows.map(t => t.id)])).rows;
  const deliveries = (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE topic_id=ANY($1::uuid[])`, [rows.map(t => t.id)])).rows;
  return rows.map(t => ({ ...t, drafts: drafts.filter(d => d.topicId === t.id), deliveries: deliveries.filter(d => d.topicId === t.id) }));
}
export async function topicDetail(db: Pool, id: string): Promise<unknown> {
  const topic = (await db.query<Topic>(`SELECT ${topicColumns} FROM publishing_topics WHERE id=$1`, [id])).rows[0];
  if (!topic) throw new NotFoundError('Publishing topic');
  const [sources, drafts, versions, attempts, events] = await Promise.all([
    db.query<Source>(`SELECT ${sourceColumns} FROM publishing_sources WHERE topic_id=$1`, [id]),
    db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [id]),
    db.query<Record<string, unknown>>(`SELECT v.* FROM publishing_versions v JOIN publishing_drafts d ON d.id=v.draft_id WHERE d.topic_id=$1 ORDER BY v.version DESC`, [id]),
    db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE topic_id=$1 ORDER BY attempted_at DESC`, [id]),
    db.query<Record<string, unknown>>('SELECT id,actor,event,detail,created_at FROM publishing_events WHERE topic_id=$1 ORDER BY id DESC LIMIT 50', [id]),
  ]);
  return { topic, sources: sources.rows, drafts: drafts.rows, versions: versions.rows, deliveries: attempts.rows, events: events.rows };
}
export async function intake(db: Pool): Promise<void> {
  const rows = (await db.query<{ id: string; title: string; url: string; discoveredAt: string }>(`
    SELECT c.id,c.title,c.url,COALESCE(c.metadata->>'discoveredAt',c.indexed_at::text) AS "discoveredAt"
    FROM content_items c WHERE c.source='discovered-article' AND c.url IS NOT NULL
      AND c.indexed_at>NOW()-INTERVAL '48 hours' AND c.published_at>NOW()-INTERVAL '7 days'
      AND COALESCE(c.workflow_state,'to-review') NOT IN ('archived','shelved')
      AND NOT EXISTS(SELECT 1 FROM publishing_sources s WHERE s.item_id=c.id)
    ORDER BY ${microsoftRelevanceSql('c')} DESC,c.published_at DESC,c.relevance_score DESC NULLS LAST,c.indexed_at DESC LIMIT $1`, [PUBLISH_LIMITS.intake])).rows;
  for (const row of rows) {
    const url = cleanUrl(row.url);
    const fingerprint = createHash('sha256').update(row.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).digest('hex');
    await transaction(db, async c => {
      const existing = await c.query<{ id: string }>('SELECT topic_id AS id FROM publishing_sources WHERE url=$1 LIMIT 1', [url]);
      const topic = existing.rows.length ? existing : await c.query<{ id: string }>(`INSERT INTO publishing_topics(title,fingerprint) VALUES($1,$2)
        ON CONFLICT(fingerprint) DO UPDATE SET fingerprint=publishing_topics.fingerprint RETURNING id`, [row.title, fingerprint]);
      const id = topic.rows[0]!.id;
      await c.query('UPDATE publishing_deliveries SET topic_id=$2 WHERE identity=$1 AND topic_id IS NULL', [`discover:${row.id}`, id]);
      const inserted = await c.query(`INSERT INTO publishing_sources(item_id,topic_id,title,url,discovered_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING RETURNING item_id`, [row.id, id, row.title, url, row.discoveredAt]);
      if (inserted.rowCount && !existing.rows.length) {
        await c.query(`UPDATE publishing_drafts SET review='pending',approval='pending',reviewed_at=NULL,
          reason='Additional source coverage requires review.' WHERE topic_id=$1`, [id]);
      }
      await c.query('DELETE FROM publishing_topics WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM publishing_sources WHERE topic_id=$1)', [id]);
      if (!/^https?:\/\//i.test(url)) await c.query("UPDATE publishing_topics SET state='held',error='Source URL is not a public web article.' WHERE id=$1", [id]);
    });
  }
}
export async function saveDraft(db: Pool, topicId: string, destination: Draft['destination'], variant: Draft['variant'],
  content: Record<string, unknown>, expiresAt: string, distinct: boolean): Promise<void> {
  await transaction(db, async c => {
    const draft = await c.query<{ id: string; version: number }>(`INSERT INTO publishing_drafts(topic_id,destination,variant,content,expires_at,distinct_argument)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(topic_id,destination) DO NOTHING RETURNING id,version`,
    [topicId, destination, variant, JSON.stringify(content), expiresAt, distinct]);
    const d = draft.rows[0];
    if (d) await c.query('INSERT INTO publishing_versions(draft_id,version,content) VALUES($1,$2,$3)', [d.id, d.version, JSON.stringify(content)]);
  });
}
function assertApprovable(d: Draft): void {
  const complete = (d.destination === 'blog' ? ['title', 'summary', 'content'] : ['copy'])
    .every(field => typeof d.content[field] === 'string' && Boolean(d.content[field].trim()));
  if (!complete || d.held || d.review !== 'pass' || !d.reviewedAt
    || Date.now() - new Date(d.reviewedAt).getTime() > PUBLISH_LIMITS.staleHours * MS_PER_HOUR) {
    throw new ValidationError(`${d.destination === 'blog' ? 'Blog' : d.destination === 'linkedin' ? 'LinkedIn' : 'Bluesky'} v${d.version} needs complete copy and a current passed review before scheduling.`);
  }
}
export async function approvePackage(db: Pool, topicId: string, versions: { blog: unknown; linkedin: unknown }, actor: string): Promise<void> {
  await transaction(db, async c => {
    const topic = (await c.query<{ state: string }>('SELECT state FROM publishing_topics WHERE id=$1 FOR NO KEY UPDATE', [topicId])).rows[0];
    if (!topic) throw new NotFoundError('Publishing package');
    if (topic.state !== 'ready') throw new ValidationError('This package is held or is still being prepared.');
    const pair = (await c.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts
      WHERE topic_id=$1 AND destination IN ('blog','linkedin') ORDER BY id FOR UPDATE`, [topicId])).rows;
    const blog = pair.find(d => d.destination === 'blog');
    const linkedin = pair.find(d => d.destination === 'linkedin');
    if (!blog || !linkedin) throw new ValidationError('The blog and LinkedIn copy must both exist before approving the package.');
    if (blog.version !== versions.blog || linkedin.version !== versions.linkedin) {
      throw new ConflictError('The package changed. Reload and read the current saved versions.', 'PUBLISHING_CONFLICT');
    }
    for (const draft of pair) assertApprovable(draft);
    if (linkedin.reviewedBlogVersion !== blog.version) throw new ValidationError('LinkedIn copy needs its consistency review against the current blog version.');
    const unresolved = await c.query(`SELECT id FROM publishing_deliveries WHERE draft_id=ANY($1::uuid[])
      AND status IN ('sending','unconfirmed')`, [pair.map(d => d.id)]);
    if (unresolved.rowCount) throw new ValidationError('A package delivery is unresolved. Reconcile it in History before approving.');
    for (const draft of pair) {
      await c.query("UPDATE publishing_drafts SET approval='approved',reason='',updated_at=NOW() WHERE id=$1", [draft.id]);
      await c.query('UPDATE publishing_versions SET approved_by=$3,approved_at=NOW() WHERE draft_id=$1 AND version=$2',
        [draft.id, draft.version, actor]);
    }
    await event(c, topicId, actor, 'package-approved', { blog: { id: blog.id, version: blog.version }, linkedin: { id: linkedin.id, version: linkedin.version } });
  });
}
export async function decideDraft(db: Pool, id: string, version: unknown, action: 'approve' | 'reject' | 'hold' | 'resume', actor: string, reason: string): Promise<void> {
  await transaction(db, async c => {
    const d = (await c.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!d) throw new NotFoundError('Publishing draft');
    if (d.version !== version) throw new ConflictError('Draft changed. Review the current version.', 'PUBLISHING_CONFLICT');
    if (action === 'approve') assertApprovable(d);
    await c.query(`UPDATE publishing_drafts SET approval=$2,held=$3,reason=$4,updated_at=NOW() WHERE id=$1`,
      [id, action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : d.approval, action === 'hold' || action === 'reject', reason]);
    if (action === 'approve') await c.query('UPDATE publishing_versions SET approved_by=$3,approved_at=NOW() WHERE draft_id=$1 AND version=$2', [id, version, actor]);
    await event(c, d.topicId, actor, `draft-${action}`, { id, version, reason });
  });
}
export async function holdTopic(db: Pool, id: string, rejected: boolean, actor: string, reason: string): Promise<void> {
  await transaction(db, async c => {
    const changed = await c.query("UPDATE publishing_topics SET state=$2,error=$3 WHERE id=$1 RETURNING id", [id, rejected ? 'rejected' : 'held', reason]);
    if (!changed.rowCount) throw new NotFoundError('Publishing topic');
    await c.query('UPDATE publishing_drafts SET held=TRUE,reason=$2 WHERE topic_id=$1', [id, reason]);
    await event(c, id, actor, rejected ? 'topic-rejected' : 'topic-held', { reason });
  });
}
