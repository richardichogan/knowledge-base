import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assessTopic, editorialServices, readSources, reviewDraft, type EditorialServices } from './editorial.js';
import { draftColumns, event, intake, listTopics, topicColumns } from './store.js';
import { PUBLISH_LIMITS, type Draft, type Topic } from './contracts.js';
import { microsoftRelevanceSql } from '../utils/microsoftRelevance.js';

export async function refreshPublishingDrafts(db: Pool, services: EditorialServices = editorialServices): Promise<void> {
  const lock = await db.connect();
  const key = 'athena-discover-publishing';
  let acquired = false;
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    acquired = true;
    await event(db, null, 'content-sync', 'draft-refresh-started', { limit: PUBLISH_LIMITS.draftShortlist });
    await intake(db);
    const candidates = (await db.query<Topic>(`SELECT ${topicColumns} FROM publishing_topics t
      WHERE state IN ('pending','ready')
        AND NOT EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=t.id AND d.approval<>'pending')
        AND NOT EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=t.id
          AND (d.destination IN ('blog','linkedin') OR d.variant='source') AND d.held)
        AND NOT EXISTS(SELECT 1 FROM publishing_schedule s JOIN publishing_drafts d ON d.id=s.draft_id
          WHERE d.topic_id=t.id AND d.version=s.version)
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
            AND (SELECT COUNT(*) FROM publishing_events WHERE event='preparation-started'
              AND created_at>NOW()-INTERVAL '24 hours')<$3 RETURNING ${topicColumns}`, [topic.id, lease, PUBLISH_LIMITS.dailyAssessments]);
          if (!claimed.rowCount) continue;
          await event(db, topic.id, 'content-sync', 'preparation-started', {});
          try { await assessTopic(db, claimed.rows[0]!, services); }
          finally { await db.query('UPDATE publishing_topics SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2', [topic.id, lease]); }
        } else {
          const sources = await readSources(db, topic.id, services);
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
          AND NOT EXISTS(SELECT 1 FROM publishing_drafts WHERE topic_id=$1 AND approval='approved')`, [topic.id, reason]);
        await event(db, topic.id, 'content-sync', 'draft-refresh-error', { reason });
      }
    }
    const shortlist = await listTopics(db, 0, true);
    await event(db, null, 'content-sync', 'draft-refresh-completed', {
      limit: PUBLISH_LIMITS.draftShortlist, reviewedTopics: candidates.length, drafts: shortlist.map(t => t.id),
    });
  } finally {
    try { if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
    finally { lock.release(); }
  }
}
