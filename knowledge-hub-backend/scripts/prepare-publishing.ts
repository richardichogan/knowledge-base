import 'dotenv/config';
import { createHash } from 'node:crypto';
import { getDb, closeDb } from '../src/db/db.js';
import { assessTopic, editorialServices, readSources, reviewDraft } from '../src/publishing/editorial.js';
import { draftColumns, event, feeds, holdTopic, listTopics, topicColumns, transaction } from '../src/publishing/store.js';
import { cleanUrl } from '../src/integrations/discovery/feedReader.js';
import { microsoftRelevanceSql } from '../src/utils/microsoftRelevance.js';
import type { Draft, Topic } from '../src/publishing/contracts.js';
import { loadConnectionCredentials } from '../src/services/connectionCredentials.js';

if (process.env['PUBLISHING_PREPARE'] !== 'approved') {
  throw new Error('Set PUBLISHING_PREPARE=approved to prepare real shared-database drafts. This command cannot publish or approve posts.');
}
const db = getDb();
const lock = await db.connect();
const lockKey = 'athena-discover-publishing';
let locked = false;
let calls = 0;
const MAX_CALLS = 100;
const MAX_TOPICS = 8;
const REQUIRED_BLUESKY = 4;
const REQUIRED_PACKAGES = 2;
async function readiness() {
  const topics = await listTopics(db, 0, true);
  const bluesky = topics.filter(topic => topic.drafts.some(draft => draft.destination === 'bluesky' && draft.review === 'pass' && !draft.held)).length;
  const packages = topics.filter(topic => topic.drafts.some(draft => draft.destination === 'blog' && draft.review === 'pass' && !draft.held)).length;
  return { topics, bluesky, packages, complete: bluesky >= REQUIRED_BLUESKY && packages >= REQUIRED_PACKAGES };
}
const services = {
  ...editorialServices,
  chat: async (...args: Parameters<typeof editorialServices.chat>) => {
    if (++calls > MAX_CALLS) throw new Error('Preparation reached its bounded model-call allowance.');
    return editorialServices.chat(...args);
  },
};
try {
  await loadConnectionCredentials(db);
  if ((await feeds(db)).some(feed => feed.enabled)) throw new Error('Turn both posting switches off before running preparation-only validation.');
  locked = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey])).rows[0]?.locked === true;
  if (!locked) throw new Error('The publishing worker is already active. Wait for it to finish before preparing more drafts.');
  const recoverable = (await db.query<Topic>(`SELECT ${topicColumns} FROM publishing_topics t
    WHERE EXISTS(SELECT 1 FROM publishing_events e WHERE e.topic_id=t.id AND e.actor='local-preparation')
      AND EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=t.id AND d.review<>'pass' AND d.approval='pending')
      AND NOT EXISTS(SELECT 1 FROM publishing_drafts d WHERE d.topic_id=t.id AND d.approval<>'pending')
      AND NOT EXISTS(SELECT 1 FROM publishing_deliveries p WHERE p.topic_id=t.id)
    ORDER BY created_at LIMIT 3`)).rows;
  for (const topic of recoverable) {
    console.log(`[Preparation only] Recovering saved copy: ${topic.title}`);
    await event(db, topic.id, 'local-preparation', 'recovery-started', { publishingDisabled: true });
    try {
      const sources = await readSources(db, topic.id, services);
      const drafts = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1
        ORDER BY CASE destination WHEN 'blog' THEN 0 WHEN 'linkedin' THEN 1 ELSE 2 END`, [topic.id])).rows;
      for (const draft of drafts) {
        if (draft.review === 'pass' && !draft.held) continue;
        await db.query("UPDATE publishing_drafts SET held=FALSE,approval='pending' WHERE id=$1 AND version=$2", [draft.id, draft.version]);
        await reviewDraft(db, { ...draft, held: false }, sources, services);
      }
      await db.query("UPDATE publishing_topics SET state='ready',error=NULL WHERE id=$1", [topic.id]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Saved draft recovery failed';
      console.error('[Preparation only] Recovery held:', message);
      await holdTopic(db, topic.id, false, 'local-preparation', message);
    }
    const state = await readiness();
    console.log(JSON.stringify({ readyTopics: state.topics.length, bluesky: state.bluesky, packages: state.packages, modelCalls: calls }));
    if (calls >= MAX_CALLS) break;
  }
  const candidates = (await db.query<{ id: string; title: string; url: string; publishedAt: string }>(`
    SELECT c.id,c.title,c.url,c.published_at::text AS "publishedAt" FROM content_items c
    WHERE c.source='discovered-article' AND c.url IS NOT NULL AND ${microsoftRelevanceSql('c')}
      AND c.published_at>NOW()-INTERVAL '48 hours'
      AND c.url NOT LIKE '%/roadmap%' AND c.url NOT LIKE '%youtube.com/%'
      AND COALESCE(c.workflow_state,'to-review') NOT IN ('archived','shelved','published')
      AND NOT EXISTS(SELECT 1 FROM publishing_sources s JOIN publishing_topics t ON t.id=s.topic_id
        WHERE s.item_id=c.id AND t.state IN ('held','rejected'))
      AND NOT EXISTS(SELECT 1 FROM publishing_sources s JOIN publishing_drafts d ON d.topic_id=s.topic_id WHERE s.item_id=c.id)
    ORDER BY c.published_at::date DESC,c.relevance_score DESC NULLS LAST,c.published_at DESC LIMIT $1`, [MAX_TOPICS])).rows;
  for (const candidate of candidates) {
    if (calls >= MAX_CALLS || (await readiness()).complete) break;
    const fingerprint = createHash('sha256').update(candidate.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).digest('hex');
    const topic = await transaction(db, async connection => {
      const existing = (await connection.query<{ topic_id: string }>('SELECT topic_id FROM publishing_sources WHERE item_id=$1', [candidate.id])).rows[0];
      let id = existing?.topic_id;
      if (!id) {
        id = (await connection.query<{ id: string }>(`INSERT INTO publishing_topics(title,fingerprint)
          VALUES($1,$2) ON CONFLICT(fingerprint) DO UPDATE SET fingerprint=publishing_topics.fingerprint RETURNING id`, [candidate.title, fingerprint])).rows[0]!.id;
        await connection.query(`INSERT INTO publishing_sources(item_id,topic_id,title,url,discovered_at)
          SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM publishing_drafts WHERE topic_id=$2)
          ON CONFLICT DO NOTHING`, [candidate.id, id, candidate.title, cleanUrl(candidate.url), candidate.publishedAt]);
      }
      return (await connection.query<Topic>(`UPDATE publishing_topics SET state='assessing',error=NULL
        WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM publishing_drafts WHERE topic_id=$1) RETURNING ${topicColumns}`, [id])).rows[0];
    });
    if (!topic) continue;
    console.log(`[Preparation only] ${topic.title}`);
    await event(db, topic.id, 'local-preparation', 'preparation-started', { publishingDisabled: true });
    try { await assessTopic(db, topic, services); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Editorial preparation failed';
      console.error('[Preparation only] Held:', message);
      await holdTopic(db, topic.id, false, 'local-preparation', message);
    }
    const ready = await readiness();
    console.log(JSON.stringify({ readyTopics: ready.topics.length, bluesky: ready.bluesky, packages: ready.packages, modelCalls: calls, publishedPosts: 0 }));
    if (ready.complete || calls >= MAX_CALLS) break;
  }
  const ready = await readiness();
  if ((await feeds(db)).some(feed => feed.enabled)) throw new Error('A feed was enabled concurrently. Preparation did not change its settings.');
  console.log(JSON.stringify({ complete: ready.complete, bluesky: ready.bluesky, packages: ready.packages, ready: ready.topics.map(topic => ({ id: topic.id, title: topic.title, destinations: topic.drafts.map(draft => draft.destination) })), modelCalls: calls, approvedPosts: 0, publishedPosts: 0 }));
  if (!ready.complete) throw new Error('Preparation stopped before a representative batch was ready. See the recorded findings; no approvals or publication occurred.');
} finally {
  if (locked) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
  lock.release();
  await closeDb();
}
