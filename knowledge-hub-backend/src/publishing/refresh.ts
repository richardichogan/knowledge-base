import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { assessTopic, editorialServices, readSources, reviewDraft, type EditorialServices } from './editorial.js';
import { draftColumns, event, intake, listTopics, topicColumns } from './store.js';
import { PUBLISH_LIMITS, type Draft, type Topic } from './contracts.js';
import { microsoftRelevanceSql } from '../utils/microsoftRelevance.js';
import { ConflictError } from '../types/errors.js';

const key = 'athena-discover-publishing';
export async function refreshPublishingDrafts(db: Pool, services: EditorialServices = editorialServices, actor = 'content-sync', heldLock?: PoolClient): Promise<void> {
  const lock = heldLock ?? await db.connect();
  let acquired = heldLock !== undefined;
  try {
    if (!acquired) await lock.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    acquired = true;
    await event(db, null, actor, 'draft-refresh-started', { limit: PUBLISH_LIMITS.draftShortlist });
    const auditStart = (await db.query<{ id: string }>('SELECT MAX(id)::text AS id FROM publishing_events')).rows[0]!.id;
    const assessed = new Set<string>();
    let assessmentAttempts = 0;
    await intake(db);
    const candidates = (await db.query<Topic>(`SELECT ${topicColumns} FROM publishing_topics t
      WHERE state IN ('pending','ready')
        AND NOT EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=t.id AND d.approval<>'pending')
        AND NOT EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=t.id
          AND (d.destination IN ('blog','linkedin') OR d.variant='source') AND d.held)
        AND NOT EXISTS(SELECT 1 FROM publishing_schedule s JOIN publishing_drafts d ON d.id=s.draft_id
          WHERE d.topic_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM publishing_deliveries p WHERE p.topic_id=t.id)
      ORDER BY EXISTS(SELECT 1 FROM publishing_sources s WHERE s.topic_id=t.id AND ${microsoftRelevanceSql('s')}) DESC,
        (SELECT MAX(discovered_at) FROM publishing_sources s WHERE s.topic_id=t.id) DESC,
        priority DESC,created_at DESC,id LIMIT $1`, [PUBLISH_LIMITS.draftShortlist])).rows;
    for (const topic of candidates) {
      try {
        const saved = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1
          ORDER BY CASE destination WHEN 'blog' THEN 0 WHEN 'linkedin' THEN 1 ELSE 2 END`, [topic.id])).rows;
        if (!saved.length) {
          const lease = randomUUID();
          const claimed = await db.query<Topic>(`UPDATE publishing_topics SET state='assessing',lease=$2,
            lease_until=NOW()+INTERVAL '15 minutes' WHERE id=$1 AND state='pending'
            AND NOT EXISTS(SELECT 1 FROM publishing_drafts WHERE topic_id=$1)
            RETURNING ${topicColumns}`, [topic.id, lease]);
          if (!claimed.rowCount) {
            await event(db, topic.id, actor, 'draft-refresh-skipped', { reason: 'Topic changed or is no longer an unassessed pending candidate.' });
            continue;
          }
          // The candidate limit bounds this sync independently of the background worker's rolling allowance.
          assessmentAttempts++;
          await event(db, topic.id, actor, 'preparation-started', {});
          try { await assessTopic(db, claimed.rows[0]!, services); assessed.add(topic.id); }
          finally { await db.query('UPDATE publishing_topics SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2', [topic.id, lease]); }
        } else {
          const sources = await readSources(db, topic.id, services, true);
          for (const previous of saved) {
            const scheduled = await db.query(`SELECT id FROM publishing_drafts WHERE topic_id=$1 AND approval='approved'`, [topic.id]);
            if (scheduled.rowCount) break;
            const draft = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE id=$1`, [previous.id])).rows[0];
            if (!draft || draft.held || draft.approval !== 'pending') continue;
            await reviewDraft(db, draft, sources, services, true, true);
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Draft refresh failed.';
        console.error('[Publishing] Content-sync draft refresh failed:', reason);
        await db.query(`UPDATE publishing_topics SET state='held',error=$2 WHERE id=$1
          AND NOT EXISTS(SELECT 1 FROM publishing_drafts WHERE topic_id=$1 AND approval='approved')
          AND NOT EXISTS(SELECT 1 FROM publishing_schedule s JOIN publishing_drafts d ON d.id=s.draft_id WHERE d.topic_id=$1)
          AND NOT EXISTS(SELECT 1 FROM publishing_deliveries WHERE topic_id=$1)`, [topic.id, reason]);
        await event(db, topic.id, actor, 'draft-refresh-error', { reason });
      }
    }
    const shortlist = await listTopics(db, 0, true);
    const outcomes = (await db.query<{ topicId: string; event: string; draftId: string | null }>(`
      SELECT topic_id AS "topicId",event,detail->>'draftId' AS "draftId" FROM publishing_events
      WHERE id>$1 AND topic_id=ANY($2::uuid[])
        AND event IN ('review-pass','review-revise','review-hold','review-error','draft-refresh-error')`,
    [auditStart, candidates.map(topic => topic.id)])).rows;
    const reviews = outcomes.filter(outcome => ['review-pass', 'review-revise', 'review-hold'].includes(outcome.event));
    const reviewed = new Set(reviews.map(outcome => outcome.topicId));
    const failed = new Set(outcomes.filter(outcome => outcome.event.endsWith('-error')).map(outcome => outcome.topicId));
    await event(db, null, actor, 'draft-refresh-completed', {
      limit: PUBLISH_LIMITS.draftShortlist, selectedTopics: candidates.length, assessmentAttempts, assessedTopics: assessed.size,
      reviewedTopics: reviewed.size, reviewedDrafts: new Set(reviews.flatMap(outcome => outcome.draftId ? [outcome.draftId] : [])).size,
      failedTopics: failed.size,
      skippedTopics: candidates.filter(topic => !assessed.has(topic.id) && !reviewed.has(topic.id) && !failed.has(topic.id)).length,
      drafts: shortlist.map(t => t.id),
    });
  } catch (error) {
    await event(db, null, actor, 'draft-refresh-error', { reason: error instanceof Error ? error.message : 'Draft refresh failed.' });
    throw error;
  } finally {
    try { if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
    finally { lock.release(); }
  }

}

export async function startPublishingDraftRefresh(db: Pool, actor: string): Promise<void> {
  const lock = await db.connect();
  let acquired = false;
  try {
    acquired = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])).rows[0]?.locked === true;
    if (!acquired) throw new ConflictError('Publishing is already working. Wait for it to finish before refreshing drafts.', 'PUBLISHING_BUSY');
  } catch (error) {
    lock.release();
    throw error;
  }
  // The refresh owns and releases this connection; it never runs the delivery worker.
  void refreshPublishingDrafts(db, editorialServices, actor, lock).catch(error => {
    console.error('[Publishing] Manual draft refresh failed:', error);
  });
}

export async function publishingRefreshStatus(db: Pool): Promise<{ running: boolean; message: string; updatedAt: string | null }> {
  const lock = await db.connect();
  let available = false;
  try {
    available = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])).rows[0]?.locked === true;
    const last = (await lock.query<{ event: string; detail: { assessedTopics?: number; reviewedDrafts?: number; failedTopics?: number; drafts?: string[]; reason?: string }; at: string }>(
      `SELECT event,detail,created_at::text AS at FROM publishing_events WHERE topic_id IS NULL
        AND event IN ('draft-refresh-started','draft-refresh-completed','draft-refresh-error') ORDER BY id DESC LIMIT 1`,
    )).rows[0];
    return {
      running: !available, updatedAt: last?.at ?? null,
      message: !available ? 'Publishing is working. New reviewed drafts will appear here; approved and scheduled posts are unchanged.'
        : !last ? 'Refresh prepares new candidates from the latest discovered articles. It does not publish anything.'
          : last.event === 'draft-refresh-error' ? `Refresh failed: ${last.detail.reason ?? 'See Publishing Audit for details.'}`
            : last.event === 'draft-refresh-started' ? 'The last refresh was interrupted. Refresh again to continue; saved posts are unchanged.'
              : `Last refresh assessed ${last.detail.assessedTopics ?? 0} topics and reviewed ${last.detail.reviewedDrafts ?? 0} drafts; ${last.detail.drafts?.length ?? 0} suggestions available, ${last.detail.failedTopics ?? 0} failures. Candidates rejected by editorial checks do not become drafts; see Audit for reasons.`,
    };
  } finally {
    try { if (available) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
    finally { lock.release(); }
  }
}
