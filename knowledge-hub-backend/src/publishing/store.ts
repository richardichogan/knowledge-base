import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { cleanUrl } from '../integrations/discovery/feedReader.js';
import { MS_PER_HOUR } from '../config/constants.js';
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
    await c.query(`UPDATE publishing_drafts SET expires_at=(SELECT MIN(discovered_at) FROM publishing_sources WHERE topic_id=publishing_drafts.topic_id)
      + make_interval(hours=>$2) WHERE (destination='bluesky')=$1`, [id === 'bluesky', parsed.expiryHours]);
    await event(c, null, actor, 'feed-configured', result.rows[0]);
    return result.rows[0];
  });
}
export async function listTopics(db: Pool, offset = 0): Promise<Array<Topic & { drafts: Draft[]; deliveries: Delivery[] }>> {
  const rows = (await db.query<Topic>(`SELECT ${topicColumns} FROM publishing_topics ORDER BY created_at DESC LIMIT ${PUBLISH_LIMITS.maxHistory} OFFSET $1`, [offset])).rows;
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
    ORDER BY c.relevance_score DESC NULLS LAST,c.indexed_at DESC LIMIT $1`, [PUBLISH_LIMITS.intake])).rows;
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
export async function decideDraft(db: Pool, id: string, version: unknown, action: 'approve' | 'reject' | 'hold' | 'resume', actor: string, reason: string): Promise<void> {
  await transaction(db, async c => {
    const d = (await c.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!d) throw new NotFoundError('Publishing draft');
    if (d.version !== version) throw new ConflictError('Draft changed. Review the current version.', 'PUBLISHING_CONFLICT');
    if (action === 'approve' && (d.review !== 'pass' || !d.reviewedAt || Date.now() - new Date(d.reviewedAt).getTime() > PUBLISH_LIMITS.staleHours * MS_PER_HOUR || new Date(d.expiresAt) <= new Date())) throw new ValidationError('Only a current, unexpired draft with a fresh passed review can be approved.');
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
