import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { publishingFixture } from './publishing-fixture.js';
import type { Pool } from 'pg';
import type { Draft, Delivery, Source, Topic } from '../src/publishing/contracts.js';
import { isMicrosoftRelevant, microsoftRelevanceSql } from '../src/utils/microsoftRelevance.js';
import type { JobRun } from '../src/jobs/contracts.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/publishing';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/api/posts';
process.env.BLUESKY_IDENTIFIER = 'fixture.bsky.social';
const store = await import('../src/publishing/store.js');
const editorial = await import('../src/publishing/editorial.js');
const { reserveDelivery, deliver, inWindow, slotBlock, PublicationDeferred, PublicationUnconfirmed } = await import('../src/publishing/delivery.js');
const { parsePolicy } = await import('../src/publishing/contracts.js');
const { verifyBlog, tickPublishing, publishDraft, recoverBlogPublication } = await import('../src/publishing/worker.js');
const { refreshSchedule, listSchedule, planSchedule } = await import('../src/publishing/schedule.js');
const { refreshPublishingDrafts, publishingRefreshStatus } = await import('../src/publishing/refresh.js');
const { jobPublishingPosts } = await import('../src/publishing/content.js');
const { IntegrationError, AiOutputLimitError } = await import('../src/types/errors.js');
const prose = 'Administrators can now configure the documented capability through the existing management portal. Check the scope and permissions before enabling it. '.repeat(9);
const blog = { title: 'A practical administration change', summary: 'Check permissions before enabling the documented capability.', excerpt: 'A practical administration change.',
  content: `<p>${prose}</p>`, keyTakeaways: ['Check the documented permissions.'], categories: [], tags: [], postType: 'article', account: 'blog.fixture.invalid' };
function reviewedPassage(input: unknown, field: string, reason: string, contains = '') {
  const passages = (input as { passages: Array<{ id: string; field: string; before: string }> }).passages;
  const passage = passages.find(item => item.field === field && item.before.includes(contains));
  assert.ok(passage);
  return { id: passage.id, reason, kind: 'style', claim: '', contradiction: '', sourceIds: [] };
}
function target(input: unknown) {
  return (input as { finding: { id: string; before: string } }).finding;
}
async function topic(db: Pool): Promise<Topic> {
  return (await db.query<Topic>(`INSERT INTO publishing_topics(title,fingerprint,state) VALUES('Practical update',$1,'ready') RETURNING ${store.topicColumns}`, [randomUUID()])).rows[0]!;
}
async function source(db: Pool, id: string): Promise<Source> {
  return (await db.query<Source>(`INSERT INTO publishing_sources(item_id,topic_id,title,url,body,read_at,discovered_at)
    VALUES($1,$2,'Original Microsoft evidence','https://source.fixture.invalid/update',$3,NOW(),NOW()) RETURNING ${store.sourceColumns}`, [randomUUID(), id, prose])).rows[0]!;
}
async function draft(db: Pool, id: string, destination: Draft['destination'] = 'bluesky', variant: Draft['variant'] = 'source'): Promise<Draft> {
  await store.saveDraft(db, id, destination, variant, destination === 'blog' ? blog : { copy: 'A practical change, with permissions to check.', account: destination === 'bluesky' ? 'fixture.bsky.social' : 'member' },
    new Date(Date.now() + 3600000).toISOString(), false);
  await db.query("UPDATE publishing_drafts SET review='pass',reviewed_at=NOW(),reviewed_blog_version=1,reviewed_feed_revision=1 WHERE topic_id=$1", [id]);
  if (destination === 'bluesky') await db.query("UPDATE publishing_drafts SET approval='approved' WHERE topic_id=$1 AND destination='bluesky'", [id]);
  const saved = (await db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1 AND destination=$2`, [id, destination])).rows[0]!;
  await db.query('INSERT INTO publishing_schedule(draft_id,version,scheduled_at) VALUES($1,$2,NOW())', [saved.id, saved.version]);
  return saved;
}
const context = (d: Draft) => ({ identity: `draft:${d.id}:v${d.version}`, topicId: d.topicId, draftId: d.id, version: d.version, feed: d.destination === 'bluesky' ? 'bluesky' as const : 'blog-linkedin' as const,
  now: new Date() });
async function enable(db: Pool): Promise<void> { await db.query(`UPDATE publishing_feeds SET enabled=TRUE,policy=policy || '{"startHour":0,"endHour":24}'::jsonb`); }

test('combined publishing reads pending LinkedIn drafts and source evidence without assigning or approving slots', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const evidence = await source(f.db, t.id);
    const linkedin = await draft(f.db, t.id, 'linkedin', 'blog');
    const entries = await listSchedule(f.db, true);
    const entry = entries.find(p => p.draftId === linkedin.id)!;
    assert.equal(entry.destination, 'linkedin');
    assert.equal(entry.status, 'Awaiting approval');
    assert.equal(entry.approved, false);
    assert.equal(entry.origin, 'Discover');
    assert.equal(entry.scheduledAt, null);
    assert.equal(entry.sources?.[0]?.id, evidence.itemId);
    assert.equal(entry.sources?.[0]?.url, evidence.url);
    assert.deepEqual(await listSchedule(f.db), []);
    assert.equal((await f.db.query<{ approval: string }>('SELECT approval FROM publishing_drafts WHERE id=$1', [linkedin.id])).rows[0]!.approval, 'pending');
  } finally { await f.close(); }
});

test('a draft awaiting editorial review does not report approval as its blocker', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const d = await draft(f.db, t.id);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='hold' WHERE id=$1", [d.id]);
    const entry = (await listSchedule(f.db, true)).find(post => post.draftId === d.id)!;
    assert.equal(entry.reason, 'Waiting for a passed editorial review.');
  } finally { await f.close(); }
});

test('weekly digest content excludes published outputs while retaining unpublished copy and sources', () => {
  const run: JobRun = {
    id: 'run', jobId: 'weekly', revision: 1, definition: { name: "What's New in Microsoft", kind: 'weekly-microsoft',
      prompt: '', schedule: { timezone: 'Europe/London', days: [1], times: ['08:00'] }, approval: 'required',
      deviceId: '', inputFolder: '', outputFolder: '', outputs: ['blog', 'linkedin', 'bluesky'] },
    scheduledAt: '2026-10-26T08:00:00Z', deadline: '2026-10-26T12:00:00Z', status: 'partial', preview: false,
    approvedAt: '2026-10-26T08:00:00Z', createdAt: '', updatedAt: '',
    steps: [{ key: 'blog', status: 'succeeded', startedAt: '' }, { key: 'linkedin', status: 'succeeded', startedAt: '' }, { key: 'bluesky', status: 'failed', startedAt: '', error: 'Copy exceeds limit.' }],
    artifacts: { blog: { title: 'Saved weekly article', content: '<p>Complete saved body.</p>' },
      linkedin: 'Complete LinkedIn copy.', bluesky: 'Complete Bluesky copy.',
      sources: [{ id: 'evidence', title: 'Microsoft announcement', url: 'https://example.com/news' }] },
  };
  const entries = jobPublishingPosts(run);
  assert.equal(entries.length, 1);
  assert.equal(entries.some(p => p.destination === 'linkedin' || p.destination === 'blog'), false);
  assert.equal(entries.find(p => p.destination === 'bluesky')!.reason, 'Copy exceeds limit.');
  assert.equal(entries[0]!.copy, run.artifacts.bluesky);
  assert.equal(entries[0]!.sources?.[0]?.title, 'Microsoft announcement');
  assert.equal(entries[0]!.origin, 'Microsoft weekly digest');
  assert.equal(entries[0]!.approved, true);
  assert.equal(jobPublishingPosts({ ...run, status: 'awaiting-approval', approvedAt: null })[0]!.approved, false);
});

test('discard rejects only the pending Blog/LinkedIn package and retains source articles and other drafts', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const s = await source(f.db, t.id);
    await f.db.query("INSERT INTO content_items(id,title,source) VALUES($1,'Keep the source','discovered-article')", [s.itemId]);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const l = await draft(f.db, t.id, 'linkedin', 'blog');
    const blue = await draft(f.db, t.id);
    await f.db.query('DELETE FROM publishing_schedule');
    await f.db.query("UPDATE publishing_drafts SET approval='pending' WHERE topic_id=$1", [t.id]);
    await assert.rejects(store.discardDraft(f.db, b.id, { [b.id]: 1, [l.id]: 2 }, 'human'), /changed/);
    await store.discardDraft(f.db, b.id, { [b.id]: 1, [l.id]: 1 }, 'human');
    const rows = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
    assert.ok(rows.filter(row => row.id !== blue.id).every(row => row.approval === 'rejected' && row.held));
    assert.equal(rows.find(row => row.id === blue.id)!.approval, 'pending');
    assert.equal((await f.db.query('SELECT id FROM content_items WHERE id=$1', [s.itemId])).rowCount, 1);
    await f.db.query("UPDATE publishing_sources SET read_at=NOW()-INTERVAL '2 days' WHERE topic_id=$1", [t.id]);
    await editorial.readSources(f.db, t.id, { ...editorial.editorialServices, read: async () => ({ title: s.title, text: prose + 'Changed evidence.' }) });
    assert.equal((await f.db.query("SELECT id FROM publishing_drafts WHERE topic_id=$1 AND approval='rejected' AND held", [t.id])).rowCount, 2);
    await assert.rejects(editorial.editDraft(f.db, b.id, 1, blog, 'editorial-revision', undefined, true), /no longer available/);
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE event='drafts-discarded'")).rowCount, 1);
    await store.discardDraft(f.db, blue.id, { [blue.id]: 1 }, 'human');
    assert.equal((await f.db.query("SELECT id FROM publishing_drafts WHERE topic_id=$1 AND approval='rejected' AND held", [t.id])).rowCount, 3);
  } finally { await f.close(); }
});
test('source reading keeps complete articles beyond 60,000 characters and holds only evidence that exceeds the model context', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    await source(f.db, t.id);
    await f.db.query("UPDATE publishing_sources SET read_at=NOW()-INTERVAL '2 days' WHERE topic_id=$1", [t.id]);
    const long = prose.repeat(Math.ceil(90_000 / prose.length));
    const [read] = await editorial.readSources(f.db, t.id, { ...editorial.editorialServices, read: async () => ({ title: 'Long', text: long }) });
    assert.equal(read!.body, long, 'the full original is kept, not truncated or held');
    await f.db.query("UPDATE publishing_sources SET read_at=NOW()-INTERVAL '2 days' WHERE topic_id=$1", [t.id]);
    await assert.rejects(editorial.readSources(f.db, t.id, { ...editorial.editorialServices, contextTokens: () => 60_000,
      read: async () => ({ title: 'Long', text: long + 'Updated.' }) }), /full-reading context/);
    assert.equal((await f.db.query('SELECT body FROM publishing_sources WHERE topic_id=$1', [t.id])).rows[0].body, long, 'oversized evidence is not saved');
  } finally { await f.close(); }
});
test('discard refuses approved, scheduled and attempted topics without changing any saved draft', async () => {
  const f = await publishingFixture();
  try {
    for (const protection of ['approved', 'scheduled', 'attempted']) {
      const t = await topic(f.db);
      const d = await draft(f.db, t.id);
      if (protection !== 'approved') await f.db.query("UPDATE publishing_drafts SET approval='pending' WHERE id=$1", [d.id]);
      if (protection !== 'scheduled') await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
      if (protection === 'attempted') await f.db.query(`INSERT INTO publishing_deliveries(identity,topic_id,draft_id,destination,account,status)
        VALUES($1,$2,$3,'bluesky','fixture','failed')`, [`draft:${d.id}`, t.id, d.id]);
      const before = (await f.db.query('SELECT * FROM publishing_drafts WHERE id=$1', [d.id])).rows;
      await assert.rejects(store.discardDraft(f.db, d.id, { [d.id]: 1 }, 'human'), /approved, scheduled or attempted/);
      assert.deepEqual((await f.db.query('SELECT * FROM publishing_drafts WHERE id=$1', [d.id])).rows, before);
    }
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE event='drafts-discarded'")).rowCount, 0);
  } finally { await f.close(); }
});
test('rejecting an entire draft removes every destination while retaining the source', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const s = await source(f.db, t.id);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const l = await draft(f.db, t.id, 'linkedin', 'blog');
    const blue = await draft(f.db, t.id, 'bluesky', 'blog');
    const versions = { [b.id]: b.version, [l.id]: l.version, [blue.id]: blue.version };
    await assert.rejects(store.rejectDraftTopic(f.db, t.id, versions, 'human'), /approved, scheduled or attempted/);
    await f.db.query('DELETE FROM publishing_schedule');
    await f.db.query("UPDATE publishing_drafts SET approval='pending' WHERE topic_id=$1", [t.id]);
    await assert.rejects(store.rejectDraftTopic(f.db, t.id, { ...versions, [l.id]: 99 }, 'human'), /changed/);
    await store.rejectDraftTopic(f.db, t.id, versions, 'human');
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
    assert.ok(saved.every(item => item.approval === 'rejected' && item.held));
    assert.equal((await f.db.query("SELECT id FROM publishing_topics WHERE id=$1 AND state='rejected'", [t.id])).rowCount, 1);
    assert.equal((await f.db.query('SELECT item_id FROM publishing_sources WHERE item_id=$1', [s.itemId])).rowCount, 1);
    assert.ok(!(await listSchedule(f.db, true)).some(item => item.topicId === t.id));
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE event='draft-topic-rejected' AND topic_id=$1", [t.id])).rowCount, 1);
  } finally { await f.close(); }
});
test('draft refresh status reports zero-result assessments, failures and interruptions explicitly', async () => {
  const f = await publishingFixture();
  try {
    await store.event(f.db, null, 'human', 'draft-refresh-completed', { assessedTopics: 8, reviewedDrafts: 0, drafts: [], failedTopics: 0 });
    assert.match((await publishingRefreshStatus(f.db)).message, /assessed 8.*0 suggestions/);
    await store.event(f.db, null, 'human', 'draft-refresh-error', { reason: 'Source unavailable' });
    assert.match((await publishingRefreshStatus(f.db)).message, /Refresh failed: Source unavailable/);
    await store.event(f.db, null, 'human', 'draft-refresh-started', {});
    assert.match((await publishingRefreshStatus(f.db)).message, /interrupted/);
  } finally { await f.close(); }
});
test('publishing accuracy and voice checks run concurrently on the same saved draft', { timeout: 5000 }, async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET review='pending' WHERE id=$1", [d.id]);
    let release!: () => void;
    const accuracy = new Promise<void>(resolve => { release = resolve; });
    const seen: unknown[] = [];
    await editorial.reviewDraft(f.db, d, [s], { ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        seen.push(input);
        if (system.includes('Perform the accuracy')) await accuracy;
        else release();
        return { outcome: 'pass', findings: [] };
      },
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], seen[1]);
  } finally { await f.close(); }
});

test('social copy length validation tells editorial repair the exact limit', () => {
  assert.throws(() => editorial.parseDraftContent('bluesky', { copy: 'x'.repeat(248) }),
    /Social copy is 248 characters; bluesky allows at most 240/);
});

test('draft-only review cannot change versions or review state when approval arrives during model work', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending' WHERE id=$1", [d.id]);
    d.approval = 'pending';
    const versions = (await f.db.query('SELECT * FROM publishing_versions WHERE draft_id=$1', [d.id])).rows;
    let approved: unknown[] = [];
    let calls = 0;
    await editorial.reviewDraft(f.db, d, [s], { ...editorial.editorialServices, preferences: async () => '',
      chat: async () => {
        if (++calls === 2) {
          await f.db.query("UPDATE publishing_drafts SET approval='approved' WHERE id=$1", [d.id]);
          await f.db.query('INSERT INTO publishing_schedule(draft_id,version,scheduled_at) VALUES($1,1,NOW())', [d.id]);
          approved = (await f.db.query('SELECT * FROM publishing_drafts WHERE id=$1', [d.id])).rows;
        }
        return { outcome: 'pass', findings: [] };
      },
    }, true, true);
    assert.equal(calls, 2);
    assert.deepEqual((await f.db.query('SELECT * FROM publishing_drafts WHERE id=$1', [d.id])).rows, approved);
    assert.deepEqual((await f.db.query('SELECT * FROM publishing_versions WHERE draft_id=$1', [d.id])).rows, versions);
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE event LIKE 'review-%' AND topic_id=$1", [t.id])).rowCount, 0);
    await f.db.query("UPDATE publishing_sources SET read_at=NOW()-INTERVAL '2 days' WHERE topic_id=$1", [t.id]);
    await editorial.readSources(f.db, t.id, { ...editorial.editorialServices, read: async () => ({ title: s.title, text: prose + 'New evidence.' }) }, true);
    assert.deepEqual((await f.db.query('SELECT * FROM publishing_drafts WHERE id=$1', [d.id])).rows, approved);
  } finally { await f.close(); }
});

test('feed defaults are off, revision checked and schedule validated including UK DST', async () => {
  const f = await publishingFixture();
  try {
    const initial = await store.feeds(f.db);
    assert.ok(initial.every(x => !x.enabled));
    assert.deepEqual(initial.map(x => x.policy.expiryHours).sort((a, b) => a - b), [48, 168]);
    const p = initial[0]!.policy;
    assert.equal(inWindow(p, new Date('2026-07-01T07:00Z')), true);
    assert.equal(inWindow(p, new Date('2026-12-01T07:00Z')), false);
    assert.throws(() => parsePolicy({ ...p, days: [] }));
    assert.throws(() => parsePolicy({ ...p, startHour: 20, endHour: 8 }));
    await store.saveFeed(f.db, initial[0]!.id, 1, true, p, 'human');
    await assert.rejects(store.saveFeed(f.db, initial[0]!.id, 1, false, p, 'stale'), /changed/);
  } finally { await f.close(); }
});
test('scheduling persists future slots while paused without imposing draft expiry', async () => {
  const f = await publishingFixture();
  try {
    for (let i = 0; i < 6; i++) {
      const t = await topic(f.db);
      await draft(f.db, t.id);
    }
    await f.db.query("UPDATE publishing_drafts SET expires_at=NOW()+INTERVAL '4 days'");
    await f.db.query('DELETE FROM publishing_schedule');
    await refreshSchedule(f.db);
    const plan = await listSchedule(f.db);
    assert.equal(plan.length, 6);
    assert.ok(plan.every(p => p.paused && p.scheduledAt && Date.parse(p.scheduledAt) > Date.now()));
    for (let i = 1; i < plan.length; i++) {
      assert.ok(Date.parse(plan[i]!.scheduledAt!) - Date.parse(plan[i - 1]!.scheduledAt!) >= 2 * 3600000);
    }
    await refreshSchedule(f.db);
    assert.deepEqual((await listSchedule(f.db)).map(p => p.scheduledAt), plan.map(p => p.scheduledAt), 'future commitments remain stable');
    await f.db.query("UPDATE publishing_drafts SET expires_at=NOW()+INTERVAL '1 second' WHERE id=$1", [plan[0]!.draftId]);
    await refreshSchedule(f.db);
    const queued = (await listSchedule(f.db)).find(p => p.draftId === plan[0]!.draftId)!;
    assert.equal(queued.scheduledAt, plan[0]!.scheduledAt);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rowCount, 0);
  } finally { await f.close(); }
});
test('canonical and same-title duplicates are recorded once in intake, without starving later items', async () => {
  const f = await publishingFixture();
  try {
    await f.db.query(`INSERT INTO content_items(title,url,source) VALUES
      ('First event','https://source.fixture.invalid/a?utm_source=x','discovered-article'),
      ('Syndicated title','https://source.fixture.invalid/a','discovered-article'),
      ('First event','https://source.fixture.invalid/syndication','discovered-article'),
      ('Different useful event','https://source.fixture.invalid/b','discovered-article')`);
    await store.intake(f.db); await store.intake(f.db);
    assert.equal((await f.db.query('SELECT * FROM publishing_sources')).rows.length, 4);
    assert.equal((await store.listTopics(f.db)).length, 2);
  } finally { await f.close(); }
});
test('prepared drafts appear before newer candidates, before database pagination', async () => {
  const f = await publishingFixture();
  try {
    const prepared = await topic(f.db); await draft(f.db, prepared.id);
    await f.db.query("UPDATE publishing_topics SET created_at=NOW()-INTERVAL '1 day' WHERE id=$1", [prepared.id]);
    await f.db.query(`INSERT INTO publishing_topics(title,fingerprint)
      SELECT 'New candidate ' || n,gen_random_uuid()::text FROM generate_series(1,60) n`);
    const first = await store.listTopics(f.db);
    const second = await store.listTopics(f.db, first.length);
    assert.equal(first[0]!.id, prepared.id);
    assert.equal(first[0]!.drafts.length, 1);
    assert.equal(first.length, 50);
    assert.equal(second.length, 11);
    assert.equal(new Set([...first, ...second].map(t => t.id)).size, 61);
  } finally { await f.close(); }
});

test('YouTube stays in Discover but never enters publishing or consumes article intake slots', async () => {
  const f = await publishingFixture();
  try {
    for (const url of ['https://www.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk',
      'https://m.youtube.com/shorts/abcdefghijk', 'https://www.youtube.com/live/abcdefghijk']) {
      await f.db.query(`INSERT INTO content_items(title,url,source) VALUES('Microsoft video',$1,'discovered-article')`, [url]);
    }
    await f.db.query(`INSERT INTO content_items(title,url,source,metadata) VALUES
      ('Microsoft imported video','https://source.fixture.invalid/video','discovered-article','{"contentKind":"youtube-video"}'),
      ('Microsoft written update','https://source.fixture.invalid/article','discovered-article','{}')`);
    await store.intake(f.db);
    assert.equal((await f.db.query('SELECT id FROM content_items')).rowCount, 6);
    assert.deepEqual((await f.db.query('SELECT title FROM publishing_topics')).rows, [{ title: 'Microsoft written update' }]);
    const imported = await topic(f.db);
    await source(f.db, imported.id);
    await f.db.query("UPDATE publishing_sources SET url='https://www.youtube.com/watch?v=abcdefghijk' WHERE topic_id=$1", [imported.id]);
    await draft(f.db, imported.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending' WHERE topic_id=$1", [imported.id]);
    await f.db.query('DELETE FROM publishing_schedule');
    assert.equal((await store.listTopics(f.db, 0, true)).length, 0);
    await assert.rejects(editorial.readSources(f.db, imported.id, { ...editorial.editorialServices,
      read: async () => { throw new Error('YouTube must not be fetched'); },
    }), /written articles only/);
    await refreshPublishingDrafts(f.db, { ...editorial.editorialServices,
      preferences: async () => '',
      chat: async system => {
        assert.match(system, /Select BEFORE/);
        return { relatedTopicId: null, blog: false, bluesky: false, priority: 10,
          rationale: 'Not selected.', exceptionReason: null, distinctArgument: false };
      },
      read: async () => ({ title: 'Microsoft written update', text: prose }),
    });
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE topic_id=$1 AND event='preparation-started'", [imported.id])).rowCount, 0);
  } finally { await f.close(); }
});
test('Drafts has at most eight entries across all feeds, ordered by Microsoft relevance and freshness', async () => {
  const f = await publishingFixture();
  try {
    const blueskyIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = await topic(f.db); await source(f.db, t.id); await draft(f.db, t.id);
      await f.db.query("UPDATE publishing_sources SET discovered_at=NOW()-($2::int * INTERVAL '1 minute') WHERE topic_id=$1", [t.id, i]);
      blueskyIds.push(t.id);
    }
    for (let i = 0; i < 8; i++) {
      const t = await topic(f.db); await source(f.db, t.id);
      await draft(f.db, t.id, 'blog', 'blog'); await draft(f.db, t.id, 'linkedin', 'blog');
    }
    const empty = await topic(f.db); await source(f.db, empty.id); await draft(f.db, empty.id);
    await f.db.query("UPDATE publishing_drafts SET content='{}' WHERE topic_id=$1", [empty.id]);
    const unreviewed = await topic(f.db); await source(f.db, unreviewed.id); await draft(f.db, unreviewed.id);
    await f.db.query("UPDATE publishing_drafts SET review='pending' WHERE topic_id=$1", [unreviewed.id]);
    const generic = await topic(f.db); await source(f.db, generic.id); await draft(f.db, generic.id);
    await f.db.query("UPDATE publishing_sources SET title='Generic cloud update' WHERE topic_id=$1", [generic.id]);
    const missingHook = await topic(f.db); await source(f.db, missingHook.id);
    await draft(f.db, missingHook.id, 'blog', 'blog'); await draft(f.db, missingHook.id, 'bluesky', 'blog');
    await f.db.query("UPDATE publishing_drafts SET approval='pending'");
    await f.db.query('DELETE FROM publishing_schedule');
    const result = await store.listTopics(f.db, 0, true);
    assert.equal(result.length, 8);
    assert.ok(result.filter(t => t.drafts.some(d => d.destination === 'bluesky')).length <= 7);
    assert.ok(result.filter(t => t.drafts.some(d => d.destination === 'blog')).length <= 6);
    assert.equal((await store.listTopics(f.db, 8, true)).length, 0, 'pagination cannot expose more drafts beyond the eight-entry shortlist');
    assert.ok(!result.some(t => [empty.id, unreviewed.id, generic.id, missingHook.id].includes(t.id)));
    const selectedBluesky = result.filter(t => blueskyIds.includes(t.id));
    assert.deepEqual(selectedBluesky.map(t => t.id), blueskyIds.slice(0, selectedBluesky.length));
  } finally { await f.close(); }
});
test('a scheduled package never reappears in Drafts through its pending Bluesky companion', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id);
    await draft(f.db, t.id, 'blog', 'blog'); await draft(f.db, t.id, 'linkedin', 'blog');
    await draft(f.db, t.id, 'bluesky', 'blog');
    await f.db.query("UPDATE publishing_drafts SET approval='pending'");
    await f.db.query('DELETE FROM publishing_schedule');
    assert.equal((await store.listTopics(f.db, 0, true)).length, 1);
    await store.approvePackage(f.db, t.id, { blog: 1, linkedin: 1 }, 'human');
    assert.equal((await store.listTopics(f.db, 0, true)).length, 0);
  } finally { await f.close(); }
});
test('content-sync refresh reviews unscheduled copy but preserves approved packages and never publishes', async () => {
  const f = await publishingFixture();
  let reviews = 0;
  try {
    const pending = await topic(f.db); await source(f.db, pending.id); await draft(f.db, pending.id);
    const scheduled = await topic(f.db); await source(f.db, scheduled.id); await draft(f.db, scheduled.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending',reviewed_at=NULL WHERE topic_id=$1", [pending.id]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id IN (SELECT id FROM publishing_drafts WHERE topic_id=$1)', [pending.id]);
    const original = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [scheduled.id])).rows;
    await refreshPublishingDrafts(f.db, { ...editorial.editorialServices,
      preferences: async () => '', read: async () => ({ title: 'Microsoft evidence', text: prose }),
      chat: async system => { assert.match(system, /review only/); reviews++; return { outcome: 'pass', findings: [] }; },
    });
    assert.equal(reviews, 2);
    assert.deepEqual((await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [scheduled.id])).rows, original);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
    assert.ok((await store.listTopics(f.db, 0, true)).some(t => t.id === pending.id));
    const completed = (await f.db.query<{ detail: Record<string, unknown> }>("SELECT detail FROM publishing_events WHERE event='draft-refresh-completed'")).rows;
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0]!.detail, { limit: 8, selectedTopics: 1, assessmentAttempts: 0, assessedTopics: 0,
      reviewedTopics: 1, reviewedDrafts: 1, failedTopics: 0, skippedTopics: 0, drafts: [pending.id] });
  } finally { await f.close(); }
});
test('content sync replaces a full shortlist with fresh reviewed proposals despite an exhausted rolling allowance', async () => {
  const f = await publishingFixture();
  let assessments = 0;
  try {
    const oldIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const old = await topic(f.db); await source(f.db, old.id); oldIds.push(old.id);
      if (i === 7) {
        await draft(f.db, old.id, 'blog', 'blog'); await draft(f.db, old.id, 'linkedin', 'blog');
      } else await draft(f.db, old.id);
    }
    await f.db.query("UPDATE publishing_sources SET discovered_at=NOW()-INTERVAL '2 days'");
    await f.db.query("UPDATE publishing_drafts SET approval='pending'");
    await f.db.query('DELETE FROM publishing_schedule');
    assert.equal((await store.listTopics(f.db, 0, true)).length, 8);
    const approved = await topic(f.db); await source(f.db, approved.id); await draft(f.db, approved.id);
    const originalDrafts = (await f.db.query('SELECT * FROM publishing_drafts ORDER BY id')).rows;
    const originalSchedule = (await f.db.query('SELECT * FROM publishing_schedule ORDER BY draft_id')).rows;
    for (let i = 0; i < 12; i++) await store.event(f.db, null, 'editorial-worker', 'preparation-started', {});
    for (let i = 0; i < 9; i++) {
      await f.db.query(`INSERT INTO content_items(title,url,source,metadata)
        VALUES($1,$2,'discovered-article',jsonb_build_object('discoveredAt',NOW()-($3::int * INTERVAL '1 minute')))`,
      [`Microsoft fresh arrival ${i}`, `https://source.fixture.invalid/fresh-${i}`, i]);
    }
    await refreshPublishingDrafts(f.db, { ...editorial.editorialServices,
      preferences: async () => '', read: async () => ({ title: 'Microsoft evidence', text: prose }),
      chat: async system => {
        if (system.includes('Select BEFORE')) {
          assessments++;
          return { relatedTopicId: null, blog: false, bluesky: true, priority: 80, rationale: 'Substantive fresh Microsoft evidence.',
            exceptionReason: null, distinctArgument: false };
        }
        if (system.includes('Create ONLY')) return { bluesky: { copy: 'Check the documented permissions before enabling this Microsoft capability.' } };
        assert.match(system, /review only/);
        return { outcome: 'pass', findings: [] };
      },
    });
    assert.equal(assessments, 8, 'a sync has its own bounded allowance, not the exhausted rolling gate');
    assert.equal((await f.db.query("SELECT id FROM publishing_topics WHERE state='pending'")).rowCount, 1, 'the ninth arrival waits for a later bounded refresh');
    assert.deepEqual((await f.db.query('SELECT * FROM publishing_drafts WHERE topic_id=ANY($1::uuid[]) ORDER BY id', [[...oldIds, approved.id]])).rows,
      originalDrafts, 'approved work and previous draft history remain intact');
    assert.deepEqual((await f.db.query('SELECT * FROM publishing_schedule ORDER BY draft_id')).rows, originalSchedule);
    const shortlist = await store.listTopics(f.db, 0, true);
    assert.equal(shortlist.length, 8);
    assert.equal(shortlist.filter(t => t.title.startsWith('Microsoft fresh arrival')).length, 7, 'new reviewed posts replace old proposals within the per-feed cap');
    assert.ok(shortlist.some(t => t.id === oldIds[7]), 'the existing blog package remains a separate destination');
    assert.ok(shortlist.every(t => t.drafts.every(d => d.approval === 'pending' && d.review === 'pass')));
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rowCount, 0);
    const detail = (await f.db.query<{ detail: Record<string, unknown> }>("SELECT detail FROM publishing_events WHERE event='draft-refresh-completed'")).rows[0]!.detail;
    assert.deepEqual({ ...detail, drafts: [] }, { limit: 8, selectedTopics: 8, assessmentAttempts: 8, assessedTopics: 8,
      reviewedTopics: 8, reviewedDrafts: 8, skippedTopics: 0, failedTopics: 0, drafts: [] });
  } finally { await f.close(); }
});
test('refresh audit distinguishes selection, assessment, skipped claims and failed sources from completed reviews', async () => {
  const f = await publishingFixture();
  try {
    const skipped = await topic(f.db); await source(f.db, skipped.id);
    const rejected = await topic(f.db); await source(f.db, rejected.id);
    const failed = await topic(f.db); await source(f.db, failed.id);
    await f.db.query("UPDATE publishing_topics SET state='pending' WHERE id=ANY($1::uuid[])", [[rejected.id, failed.id]]);
    await f.db.query("UPDATE publishing_sources SET read_at=NULL,url='https://source.fixture.invalid/failure' WHERE topic_id=$1", [failed.id]);
    await refreshPublishingDrafts(f.db, { ...editorial.editorialServices, preferences: async () => '',
      read: async () => { throw new Error('Evidence unavailable'); },
      chat: async system => {
        assert.match(system, /Select BEFORE/);
        return { relatedTopicId: null, blog: false, bluesky: false, priority: 10, rationale: 'Insufficient substance.',
          exceptionReason: null, distinctArgument: false };
      },
    });

    const detail = (await f.db.query<{ detail: Record<string, unknown> }>("SELECT detail FROM publishing_events WHERE event='draft-refresh-completed'")).rows[0]!.detail;
    assert.deepEqual(detail, { limit: 8, selectedTopics: 3, assessmentAttempts: 2, assessedTopics: 1,
      reviewedTopics: 0, reviewedDrafts: 0, skippedTopics: 1, failedTopics: 1, drafts: [] });
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE event='draft-refresh-skipped' AND topic_id=$1", [skipped.id])).rowCount, 1);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rowCount, 0);
  } finally { await f.close(); }
});

test('refresh restores saved drafts and reaches five new articles beyond failures and rejections within its budget', async () => {
      const f = await publishingFixture();
      let assessments = 0;
      const written: string[] = [];
      try {
        const stale = await topic(f.db); await source(f.db, stale.id); await draft(f.db, stale.id);
        await f.db.query('DELETE FROM publishing_schedule');
        await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending',reviewed_at=NULL");
        for (let i = 0; i < 13; i++) {
          const candidate = await topic(f.db); await source(f.db, candidate.id);
          await f.db.query("UPDATE publishing_topics SET state='pending',title=$2 WHERE id=$1", [candidate.id, `Microsoft arrival ${i}`]);
          await f.db.query(`UPDATE publishing_sources SET url=$2,read_at=NULL,discovered_at=NOW()-($3::int * INTERVAL '1 minute')
            WHERE topic_id=$1`, [candidate.id, `https://source.fixture.invalid/${i < 4 ? 'failure' : i < 7 ? 'rejected' : 'useful'}-${i}`, i]);
          if (i >= 7 && i < 12) written.push(candidate.id);
        }
        await refreshPublishingDrafts(f.db, { ...editorial.editorialServices,
          preferences: async () => '',
          read: async url => {
            if (url.includes('/failure-')) throw new Error('Source unavailable');
            return { title: 'Microsoft written article', text: prose };
          },
          chat: async (system, input) => {
            if (system.includes('Select BEFORE')) {
              assessments++;
              const sources = (input as { sources: Source[] }).sources;
              return { relatedTopicId: null, blog: false, bluesky: !sources[0]!.url.includes('/rejected-'),
                priority: 80, rationale: 'Source-specific selection.', exceptionReason: null, distinctArgument: false };
            }
            if (system.includes('Create ONLY')) return { bluesky: { copy: 'Check the documented permissions before enabling this Microsoft capability.' } };
            assert.match(system, /review only/);
            return { outcome: 'pass', findings: [] };
          },
        });
        const shortlist = await store.listTopics(f.db, 0, true);
        assert.ok(shortlist.some(entry => entry.id === stale.id));
        assert.ok(written.every(id => shortlist.some(entry => entry.id === id)), 'all five new usable articles reach the shortlist');
        assert.equal(assessments, 8, 'four failed reads and eight model assessments exhaust twelve attempts');
        assert.equal((await f.db.query("SELECT id FROM publishing_topics WHERE state='pending'")).rowCount, 1);
        assert.equal((await f.db.query('SELECT id FROM publishing_deliveries')).rowCount, 0);
        assert.equal((await f.db.query("SELECT id FROM publishing_drafts WHERE approval<>'pending'")).rowCount, 0);
        const detail = (await f.db.query<{ detail: { assessmentAttempts: number; reviewedDrafts: number } }>(
          "SELECT detail FROM publishing_events WHERE event='draft-refresh-completed'")).rows[0]!.detail;
        assert.equal(detail.assessmentAttempts, 12);
        assert.equal(detail.reviewedDrafts, 6);
      } finally { await f.close(); }
    });
test('non-Microsoft topics need an exceptional explicit relevance rationale before drafting', async () => {
  const f = await publishingFixture();
  try {
    for (const exceptionReason of [null, 'A major PHP runtime change affects the enterprise workloads this audience operates.']) {
      const t = await topic(f.db); await source(f.db, t.id);
      await f.db.query("UPDATE publishing_sources SET title='A PHP runtime change' WHERE topic_id=$1", [t.id]);
      await editorial.assessTopic(f.db, t, {
        ...editorial.editorialServices, preferences: async () => '',
        chat: async system => {
          if (system.includes('Select BEFORE')) return { blog: false, bluesky: true, distinctArgument: false, priority: 95, rationale: 'Enterprise runtime relevance.', exceptionReason };
          if (system.includes('Create ONLY')) return { bluesky: { copy: 'Check the documented runtime compatibility requirements before upgrading.' } };
          return { outcome: 'pass', findings: [] };
        },
      });
      const saved = await f.db.query('SELECT id FROM publishing_drafts WHERE topic_id=$1', [t.id]);
      assert.equal(saved.rows.length, exceptionReason === null ? 0 : 1);
    }
  } finally { await f.close(); }
});
test('editorial JSON preserves long escaped copy and refuses truncated content without repairing it', async () => {
  const content = { ...blog, content: `<p>${'A quoted "capability" with a newline.\n'.repeat(700)}</p>` };
  assert.deepEqual(await editorial.requestEditorialJson({ chatBulk: async () => JSON.stringify(content) },
    'Revise this draft.', {}, 5000, editorial.EDITORIAL_SCHEMAS.blog), content);
  await assert.rejects(editorial.requestEditorialJson({ chatBulk: async () => '{"content":"' + 'a'.repeat(21900) },
    'Revise this draft.', {}, 5000, editorial.EDITORIAL_SCHEMAS.blog), /incomplete draft.*saved draft is unchanged/i);
});
test('official GitHub Blog evidence is Microsoft-relevant without matching lookalike domains', async () => {
  const f = await publishingFixture();
  try {
    for (const [url, expected] of [
      ['https://github.blog/changelog/update', true],
      ['https://github.blog.attacker.invalid/update', false],
      ['https://notgithub.blog/update', false],
    ] as const) {
      assert.equal(isMicrosoftRelevant({ title: 'Public monitoring update', url }), expected);
      const result = await f.db.query<{ relevant: boolean }>(`SELECT ${microsoftRelevanceSql('candidate')} AS relevant
        FROM (SELECT 'Public monitoring update'::text AS title,$1::text AS url,''::text AS body) candidate`, [url]);
      assert.equal(result.rows[0]!.relevant, expected);
    }
  } finally { await f.close(); }
});
test('Bluesky generation carries the exact copy length ceiling in its strict schema', () => {
  assert.deepEqual(editorial.EDITORIAL_SCHEMAS.bluesky.schema, {
    type: 'object', additionalProperties: false, properties: { copy: { type: 'string', maxLength: 240 } }, required: ['copy'],
  });
  assert.ok(JSON.stringify(editorial.EDITORIAL_SCHEMAS.package).includes('"maxLength":240'));
});
test('blog-linked Bluesky review cannot pass copy which exceeds the combined permalink limit', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    await f.db.query(`UPDATE publishing_drafts SET content=content || $2::jsonb WHERE id=$1`,
      [b.id, JSON.stringify({ slug: 'github-tightens-the-screws-microsoft-chases-supply-chain-fallout' })]);
    const blue = await draft(f.db, t.id, 'bluesky', 'blog');
    blue.content.copy = 'x'.repeat(230);
    await f.db.query("UPDATE publishing_drafts SET content=$2,review='pending' WHERE id=$1", [blue.id, JSON.stringify(blue.content)]);
    await editorial.reviewDraft(f.db, blue, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async () => ({ outcome: 'pass', findings: [] }),
    }, false);
    const result = await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [blue.id]);
    assert.equal(result.rows[0]!.review, 'revise');
    assert.equal(result.rows[0]!.content.copy, blue.content.copy);
    assert.equal(result.rows[0]!.approval, 'approved');
    const history = await f.db.query<{ reviews: unknown }>('SELECT reviews FROM publishing_versions WHERE draft_id=$1 AND version=$2', [blue.id, blue.version]);
    assert.match(JSON.stringify(history.rows[0]!.reviews), /Bluesky allows 300/);
  } finally { await f.close(); }
});
test('editorial repairs patch only exact passages and leave all other text and metadata untouched', () => {
  const original = { ...blog, content: '<article><p>Keep this opening.</p><p>Fix this claim. Keep the qualification.</p><p>Keep this ending.</p></article>',
    keyTakeaways: ['Keep this takeaway.', 'Fix this takeaway.'], tags: ['Original tag'] };
  const result = editorial.applyEditorialEdits('blog', original, { edits: [
    { field: 'content', before: 'Fix this claim.', after: 'Corrected claim.' },
    { field: 'keyTakeaways', before: 'Fix this takeaway.', after: 'Corrected takeaway.' },
  ] });
  assert.deepEqual(result, { ...original, content: '<article><p>Keep this opening.</p><p>Corrected claim. Keep the qualification.</p><p>Keep this ending.</p></article>',
    keyTakeaways: ['Keep this takeaway.', 'Corrected takeaway.'] });
  assert.equal(original.keyTakeaways[1], 'Fix this takeaway.');
});
test('editorial repairs reject whole-article replacements, stale matches, overlaps, no-ops and metadata edits', () => {
  const content = { ...blog, content: '<p>First paragraph.</p><p>Second paragraph.</p>' };
  for (const edits of [
    [{ field: 'content', before: content.content, after: '<p>New whole article.</p>' }],
    [{ field: 'content', before: 'Missing text.', after: 'Changed.' }],
    [{ field: 'content', before: 'First paragraph.', after: 'First paragraph.' }],
    [{ field: 'account', before: 'blog.fixture.invalid', after: 'other.invalid' }],
    [{ field: 'content', before: 'First paragraph.', after: 'Updated.' }, { field: 'content', before: 'paragraph.', after: 'text.' }],
  ]) assert.throws(() => editorial.applyEditorialEdits('blog', content, { edits }), /saved draft is unchanged/i);
  assert.equal(content.content, '<p>First paragraph.</p><p>Second paragraph.</p>');
  assert.throws(() => editorial.applyEditorialEdits('linkedin', { copy: 'Same. Same.' }, {
    edits: [{ field: 'copy', before: 'Same.', after: 'Changed.' }],
  }), /ambiguous passage/);
});
test('publishing blog categories preserve unknown topics as tags without dropping existing tags', () => {
  const parsed = editorial.parseDraftContent('blog', {
    ...blog, categories: ['Azure', 'AI', 'Microsoft Foundry'], tags: ['Existing', 'microsoft foundry'],
  });
  assert.deepEqual(parsed.categories, ['Microsoft Azure', 'AI']);
  assert.deepEqual(parsed.tags, ['Existing', 'microsoft foundry']);
  assert.throws(() => editorial.parseDraftContent('blog', {
    ...blog, categories: ['New topic'], tags: Array.from({ length: 30 }, (_, index) => `tag${index}`),
  }), /at most 30 tags/);
});
test('category-only correction carries existing hook passes forward without changing copy', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const hook = await draft(f.db, t.id, 'linkedin', 'blog');
    await f.db.query('DELETE FROM publishing_schedule');
    const original = { ...b.content, categories: ['Azure', 'Microsoft Foundry'], tags: ['existing'] };
    await f.db.query("UPDATE publishing_drafts SET content=$2,review='hold' WHERE id=$1", [b.id, JSON.stringify(original)]);
    const corrected = { ...original, categories: ['Microsoft Azure'], tags: ['existing', 'Microsoft Foundry'] };
    await assert.rejects(editorial.editDraft(f.db, b.id, 1, { ...corrected, title: 'Changed' },
      'editorial-recovery', undefined, true, true), /Only the category and tag correction/);
    await editorial.editDraft(f.db, b.id, 1, corrected, 'editorial-recovery', undefined, true, true);
    const rows = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
    const savedBlog = rows.find(row => row.id === b.id)!;
    const savedHook = rows.find(row => row.id === hook.id)!;
    assert.deepEqual(savedBlog.content, corrected);
    assert.equal(savedBlog.version, 2);
    assert.equal(savedHook.review, 'pass');
    assert.equal(savedHook.reviewedBlogVersion, 2);
    assert.deepEqual(savedHook.content, hook.content);
    assert.equal((await f.db.query("SELECT id FROM publishing_events WHERE event='blog-metadata-corrected' AND topic_id=$1", [t.id])).rowCount, 1);
  } finally { await f.close(); }
});
test('a specifically authorised tag removal preserves passed hooks and all other content', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const hook = await draft(f.db, t.id, 'linkedin', 'blog');
    await f.db.query('DELETE FROM publishing_schedule');
    const original = { ...b.content, tags: ['existing', 'incorrect'] };
    await f.db.query("UPDATE publishing_drafts SET content=$2,review='hold' WHERE id=$1", [b.id, JSON.stringify(original)]);
    const corrected = { ...original, tags: ['existing'] };
    const tagCorrection = { tag: 'incorrect', expectedHooks: [{ id: hook.id, version: hook.version }] };
    await assert.rejects(editorial.editDraft(f.db, b.id, 1, { ...corrected, title: 'Changed' },
      'user-requested-tag-correction', undefined, true, true, undefined, tagCorrection), /Only the category and tag correction/);
    await assert.rejects(editorial.editDraft(f.db, b.id, 1, corrected,
      'user-requested-tag-correction', undefined, true, true, undefined,
      { tag: 'incorrect', expectedHooks: [{ id: hook.id, version: hook.version + 1 }] }), /passed hooks changed/);
    await editorial.editDraft(f.db, b.id, 1, corrected, 'user-requested-tag-correction', undefined, true, true, undefined, tagCorrection);
    const rows = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
    assert.deepEqual(rows.find(row => row.id === b.id)!.content, corrected);
    assert.equal(rows.find(row => row.id === hook.id)!.review, 'pass');
    assert.equal(rows.find(row => row.id === hook.id)!.reviewedBlogVersion, 2);
  } finally { await f.close(); }
});
for (const outcome of ['consistent', 'restored-pass', 'conflict', 'concurrent-change'] as const) {
  test(`blog repair handles passed hooks only after a ${outcome} consistency check`, async () => {
    const f = await publishingFixture();
    try {
      const t = await topic(f.db); const s = await source(f.db, t.id);
      const b = await draft(f.db, t.id, 'blog', 'blog');
      const hook = await draft(f.db, t.id, 'linkedin', 'blog');
      await f.db.query('DELETE FROM publishing_schedule');
      await f.db.query("UPDATE publishing_drafts SET approval='pending' WHERE topic_id=$1", [t.id]);
      await f.db.query("UPDATE publishing_drafts SET review='pending' WHERE id=$1", [b.id]);
      if (outcome === 'restored-pass') {
        await f.db.query(`UPDATE publishing_drafts SET review='pending',reviewed_at=NULL,
          reason='Blog changed; hook must be reviewed and approved again.' WHERE id=$1`, [hook.id]);
        await f.db.query(`UPDATE publishing_versions SET reviews=$2 WHERE draft_id=$1 AND version=1`,
          [hook.id, JSON.stringify([{ outcome: 'pass', at: '2026-10-28T13:08:15.950Z' }])]);
      }
      b.review = 'pending';
      const services: typeof editorial.editorialServices = {
        ...editorial.editorialServices, preferences: async () => '',
        chat: async (system, input, _tokens, _schema, role) => {
          if (system.includes('Correct only the supplied')) return { edits: [{ id: target(input).id,
            after: 'Check the documented permissions before enabling the capability.', remove: '' }] };
          if (system.includes('Check only whether each unchanged')) {
            assert.equal(role, 'blog-author');
            if (outcome === 'concurrent-change') {
              await f.db.query("UPDATE publishing_drafts SET content=content || '{\"copy\":\"Changed concurrently\"}'::jsonb,version=version+1 WHERE id=$1", [hook.id]);
            }
            return { hooks: [{ id: hook.id, consistent: outcome !== 'conflict', reason: 'Checked against the corrected article.' }] };
          }
          return { outcome: 'revise', findings: [reviewedPassage(input, 'summary', 'Clarify the summary.')] };
        },
      };
      if (outcome === 'consistent' || outcome === 'restored-pass' || outcome === 'conflict') {
        await editorial.reviewDraft(f.db, b, [s], services);
      } else {
        await assert.rejects(editorial.reviewDraft(f.db, b, [s], services), /saved package is unchanged/i);
      }
      const rows = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
      const savedBlog = rows.find(row => row.id === b.id)!;
      const savedHook = rows.find(row => row.id === hook.id)!;
      assert.equal(savedBlog.version, outcome === 'consistent' || outcome === 'restored-pass' || outcome === 'conflict' ? 2 : 1);
      if (outcome === 'conflict') {
        assert.equal(savedHook.review, 'pending');
        assert.equal(savedHook.version, hook.version + 1);
        assert.equal(savedHook.reviewedBlogVersion, null);
        const rewrites = await f.db.query("SELECT id FROM publishing_events WHERE event='hook-rewrite-requested' AND topic_id=$1", [t.id]);
        assert.equal(rewrites.rowCount, 1);
        return;
      }
      assert.equal(savedHook.review, 'pass');
      assert.equal(savedHook.reviewedBlogVersion, outcome === 'consistent' || outcome === 'restored-pass' ? 2 : 1);
      if (outcome !== 'concurrent-change') assert.deepEqual(savedHook.content, hook.content);
      const events = await f.db.query("SELECT id FROM publishing_events WHERE event='blog-hook-consistency-preserved' AND topic_id=$1", [t.id]);
      assert.equal(events.rowCount, outcome === 'consistent' || outcome === 'restored-pass' ? 1 : 0);
    } finally { await f.close(); }
  });
}
test('a passed blog restores an unchanged hook pass after checking its original blog version', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const hook = await draft(f.db, t.id, 'linkedin', 'blog');
    await f.db.query('DELETE FROM publishing_schedule');
    await f.db.query(`UPDATE publishing_drafts SET review='pending',reviewed_at=NULL,
      reason='Blog changed; hook must be reviewed and approved again.' WHERE id=$1`, [hook.id]);
    await f.db.query('UPDATE publishing_versions SET reviews=$2 WHERE draft_id=$1 AND version=1',
      [hook.id, JSON.stringify([{ outcome: 'pass', at: '2026-10-28T13:08:15.950Z' }])]);
    const currentBlog = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [b.id])).rows[0]!;
    await editorial.reconcilePassedBlogHooks(f.db, currentBlog, [s], {
      ...editorial.editorialServices, chat: async (_system, _input, _tokens, _schema, role) => {
        assert.equal(role, 'blog-author');
        return { hooks: [{ id: hook.id, consistent: true, reason: 'The hook matches.' }] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [hook.id])).rows[0]!;
    assert.equal(saved.review, 'pass');
    assert.equal(saved.reviewedBlogVersion, b.version);
    assert.deepEqual(saved.content, hook.content);
    assert.equal((await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [b.id])).rows[0]!.version, b.version);
  } finally { await f.close(); }
});
test('editorial retries an invalid repair with the validation error without replacing other text', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending' WHERE id=$1", [d.id]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending';
    let repairs = 0;
    let checks = 0;
    await editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input, _tokens, _schema, role) => {
        if (system.includes('Correct only the supplied')) {
          assert.equal(role, 'social-author');
          assert.match(system, /Calliope/);
          repairs++;
          assert.equal('content' in (input as object), false);
          if (repairs === 1) return { edits: [{ id: 'invalid', after: 'Correction.', remove: '' }] };
          assert.match(String((input as { repairError: unknown }).repairError), /invalid target/);
          return { edits: [{ id: target(input).id, after: 'A documented change, with permissions to check.', remove: '' }] };
        }
        assert.equal(role, 'critic');
        assert.match(system, /Momus/);
        checks++;
        return checks <= 2 ? { outcome: 'revise', findings: [reviewedPassage(input, 'copy', 'Change the wording.')] } : { outcome: 'pass', findings: [] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(repairs, 2);
    assert.equal(saved.content.copy, 'A documented change, with permissions to check.');
    assert.equal(saved.review, 'pass');
  } finally { await f.close(); }
});
test('editorial retries only the rejected target without sending the draft', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending' WHERE id=$1", [d.id]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending';
    let repairs = 0; let reviews = 0;
    await editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        if (system.includes('Correct only the supplied')) {
          repairs++;
          const current = input as { finding: { id: string; before: string }; repairError?: string; content?: unknown };
          assert.equal(current.content, undefined);
          if (repairs === 1) return { edits: [] };
          assert.match(current.repairError!, /one correction/);
          return { edits: [{ id: current.finding.id, after: 'A documented change, with scope to check.', remove: '' }] };
        }
        reviews++;
        return reviews <= 2 ? { outcome: 'revise', findings: [reviewedPassage(input, 'copy', 'Fix the wording.')] } : { outcome: 'pass', findings: [] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(repairs, 2);
    assert.equal(saved.content.copy, 'A documented change, with scope to check.');
    assert.equal(saved.review, 'pass');
  } finally { await f.close(); }
});
test('a linked multi-sentence blog finding sends only related flagged sentences to the author', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id, 'blog', 'blog');
    const content = { ...d.content, content: '<p>First flagged sentence. Second flagged sentence. Unrelated sentence.</p>' };
    await f.db.query("UPDATE publishing_drafts SET content=$2,approval='pending',review='pending' WHERE id=$1", [d.id, JSON.stringify(content)]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending'; d.content = content;
    await assert.rejects(editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        if (system.includes('Correct only the supplied')) {
          const current = input as { finding: { before: string; relatedFindings: Array<{ before: string }> }; content?: unknown };
          assert.equal(current.content, undefined);
          assert.equal(current.finding.before, 'First flagged sentence.');
          assert.deepEqual(current.finding.relatedFindings.map(item => item.before), ['Second flagged sentence.']);
          throw new Error('Inspected targeted request.');
        }
        const first = reviewedPassage(input, 'content', 'placeholder', 'First flagged');
        const second = reviewedPassage(input, 'content', 'placeholder', 'Second flagged');
        return { outcome: 'revise', findings: [
          { ...first, reason: `Merge ${first.id}-${second.id}.` },
          { ...second, reason: 'Remove the repeated detail.' },
        ] };
      },
    }), /Inspected targeted request/);
  } finally { await f.close(); }
});
test('later review rounds preserve accepted unchanged passages', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    const content = { ...d.content, copy: 'First issue. Unchanged accepted sentence.' };
    await f.db.query("UPDATE publishing_drafts SET content=$2,approval='pending',review='pending' WHERE id=$1", [d.id, JSON.stringify(content)]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending'; d.content = content;
    let accuracyReviews = 0;
    await editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        if (system.includes('Correct only the supplied')) {
          return { edits: [{ id: target(input).id, after: 'Corrected first sentence.', remove: '' }] };
        }
        if (system.includes('voice review only')) return { outcome: 'pass', findings: [] };
        accuracyReviews++;
        const finding = accuracyReviews === 1
          ? reviewedPassage(input, 'copy', 'Fix this sentence.', 'First issue')
          : reviewedPassage(input, 'copy', 'Optional alternative wording.', 'Unchanged accepted');
        return { outcome: 'revise', findings: [finding] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(saved.review, 'pass');
    assert.equal(saved.content.copy, 'Corrected first sentence. Unchanged accepted sentence.');
    assert.equal(accuracyReviews, 2);
  } finally { await f.close(); }
});
test('a new contradiction can reopen an accepted passage when it identifies the changed passage', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    const content = { ...d.content, copy: 'First issue. Previously accepted sentence.' };
    await f.db.query("UPDATE publishing_drafts SET content=$2,approval='pending',review='pending' WHERE id=$1", [d.id, JSON.stringify(content)]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending'; d.content = content;
    let accuracyReviews = 0;
    await editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        if (system.includes('Correct only the supplied')) {
          const current = target(input);
          return { edits: [{ id: current.id, after: current.before.includes('First issue')
            ? 'Corrected first sentence.' : 'Consistent second sentence.', remove: '' }] };
        }
        if (system.includes('voice review only')) return { outcome: 'pass', findings: [] };
        accuracyReviews++;
        if (accuracyReviews === 1) return { outcome: 'revise', findings: [reviewedPassage(input, 'copy', 'Fix this sentence.', 'First issue')] };
        if (accuracyReviews === 2) {
          const changed = reviewedPassage(input, 'copy', '', 'Corrected first');
          return { outcome: 'revise', findings: [{
            ...reviewedPassage(input, 'copy', `Contradicts ${changed.id}.`, 'Previously accepted'), kind: 'coherence',
          }] };
        }
        return { outcome: 'pass', findings: [] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(saved.review, 'pass');
    assert.equal(saved.content.copy, 'Corrected first sentence. Consistent second sentence.');
    assert.equal(accuracyReviews, 3);
  } finally { await f.close(); }
});
test('a Bluesky length repair receives the exact target budget without the full post', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    const copy = `${'A'.repeat(250)}. A second sentence remains unchanged.`;
    const content = { ...d.content, copy };
    await f.db.query("UPDATE publishing_drafts SET content=$2,approval='pending',review='pending' WHERE id=$1", [d.id, JSON.stringify(content)]);
    await f.db.query('UPDATE publishing_versions SET content=$2 WHERE draft_id=$1 AND version=1', [d.id, JSON.stringify(content)]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending'; d.content = content;
    let repairs = 0;
    await editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        if (system.includes('Correct only the supplied')) {
          repairs++;
          const current = input as { finding: { id: string; before: string; maximumReplacementGraphemes: number; maximumReplacementCodeUnits: number }; content?: unknown };
          assert.equal(current.content, undefined);
          assert.ok(!current.finding.before.includes('A second sentence'));
          const maximum = Math.min(current.finding.maximumReplacementGraphemes, current.finding.maximumReplacementCodeUnits);
          assert.ok(maximum > 1);
          return { edits: [{ id: current.finding.id, after: `${current.finding.before.slice(0, maximum - 1)}.`, remove: '' }] };
        }
        const request = input as { validation: string[] };
        if (system.includes('voice review only') && request.validation.length) {
          return { outcome: 'revise', findings: [{ ...reviewedPassage(input, 'copy', 'Shorten this sentence.', 'AAAA'), kind: 'length' }] };
        }
        return { outcome: 'pass', findings: [] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(repairs, 1);
    assert.equal(saved.review, 'pass');
    assert.match(String(saved.content.copy), /A second sentence remains unchanged\.$/);
  } finally { await f.close(); }
});
test('editorial continues targeted fixes beyond two rounds while distinct findings remain', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending' WHERE id=$1", [d.id]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending'; d.review = 'pending';
    const changes = [['practical', 'documented'], ['change', 'update'], ['permissions', 'scope']] as const;
    let repairs = 0;
    await editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        if (system.includes('Correct only the supplied')) {
          const change = changes[repairs++]!;
          const finding = target(input);
          return { edits: [{ id: finding.id, after: finding.before.replace(change[0], change[1]), remove: '' }] };
        }
        if (system.includes('voice review only')) return { outcome: 'pass', findings: [] };
        const content = input as { passages: Array<{ before: string }> };
        const next = changes.find(([before]) => content.passages.some(item => item.before.includes(before)));
        return next ? { outcome: 'revise', findings: [reviewedPassage(input, 'copy', `Fix ${next[0]}.`, next[0])] } : { outcome: 'pass', findings: [] };
      },
    });
    const saved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(repairs, 3);
    assert.equal(saved.review, 'pass');
    assert.equal(saved.content.copy, 'A documented update, with scope to check.');
  } finally { await f.close(); }
});
test('editorial retries output exhaustion once, keeps the schema and does not retry refusals', async () => {
  const limits: number[] = [];
  const value = await editorial.requestEditorialJson({
    chatBulk: async (_messages, tokens, _timeout, _effort, schema) => {
      limits.push(tokens!); assert.deepEqual(schema, editorial.EDITORIAL_SCHEMAS.social);
      if (limits.length === 1) throw new AiOutputLimitError();
      return '{"copy":"A complete source-backed update."}';
    },
  }, 'Revise.', {}, 5000, editorial.EDITORIAL_SCHEMAS.social);
  assert.equal(value.copy, 'A complete source-backed update.');
  assert.deepEqual(limits, [5000, 10000]);
  for (const error of [new AiOutputLimitError(), new Error('Structured bulk extraction was incomplete or refused')]) {
    let calls = 0;
    await assert.rejects(editorial.requestEditorialJson({ chatBulk: async () => { calls++; throw error; } },
      'Revise.', {}, 5000, editorial.EDITORIAL_SCHEMAS.social));
    assert.equal(calls, error instanceof AiOutputLimitError ? 2 : 1);
  }
});
test('a truncated blog revision leaves exact saved content, versions and approvals intact', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    const d = await draft(f.db, t.id, 'blog', 'blog');
    await f.db.query("UPDATE publishing_drafts SET review='pending' WHERE id=$1", [d.id]);
    await assert.rejects(editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input, tokens, schema) => {
        const content = input as { draft?: Record<string, unknown>; content?: Record<string, unknown>; blog?: Record<string, unknown> };
        for (const item of [content.draft, content.content, content.blog]) {
          if (!item) continue;
          assert.equal('account' in item, false);
          assert.equal('accountName' in item, false);
          assert.equal('status' in item, false);
        }
        if (!system.includes('Correct only the supplied')) {
          return { outcome: 'revise', findings: [reviewedPassage(input, 'summary', 'Clarify the permission requirement.')] };
        }
        assert.equal(schema.name, 'blog_passage_edits');
        assert.equal(content.content, undefined);
        return editorial.requestEditorialJson({ chatBulk: async () => '{"edits":[{"before":"' + 'a'.repeat(21900) }, system, input, tokens, schema);
      },
    }), /incomplete draft/);
    const after = (await store.topicDetail(f.db, t.id)).drafts.find(x => x.id === d.id)!;
    assert.deepEqual(after.content, d.content);
    assert.equal(after.version, 1);
    assert.equal(after.approval, 'pending');
    assert.equal((await f.db.query('SELECT * FROM publishing_versions WHERE draft_id=$1', [d.id])).rows.length, 1);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
  } finally { await f.close(); }
});
test('the actual model HTTP boundary requests strict schemas and never parses a length-truncated response', async () => {
  const { FoundryClient } = await import('../src/ai/foundryClient.js');
  const { env } = await import('../src/config/env.js');
  const { getDb } = await import('../src/db/db.js');
  const telemetry = mock.method(getDb(), 'query', async () => ({ rows: [] }));
  const endpoint = env.AZURE_OPENAI_ENDPOINT_GPT54;
  try {
    for (const bulk of [false, true]) {
      env.AZURE_OPENAI_ENDPOINT_GPT54 = bulk ? 'https://fixture.invalid' : undefined;
      const credential = mock.getter(env, 'AZURE_OPENAI_API_KEY_GPT54', () => bulk ? 'fixture-key' : undefined);
      const lightCredential = mock.getter(env, 'AZURE_OPENAI_API_KEY', () => 'fixture-light-key');
      const limits: number[] = [];
      const network = mock.method(globalThis, 'fetch', async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.response_format.type, 'json_schema');
        assert.equal(request.response_format.json_schema.strict, true);
        assert.deepEqual(request.response_format.json_schema.schema, editorial.EDITORIAL_SCHEMAS.social.schema);
        limits.push(request.max_completion_tokens);
        return new Response(JSON.stringify({ choices: [{
          finish_reason: limits.length === 1 ? 'length' : 'stop',
          message: { content: limits.length === 1 ? '{"copy":"unfinished' : '{"copy":"Complete reviewed source copy."}' },
        }] }), { status: 200 });
      });
      try {
        const result = await editorial.requestEditorialJson(new FoundryClient('publishing-test'), 'Return social copy.', {}, 5000, editorial.EDITORIAL_SCHEMAS.social);
        assert.equal(result.copy, 'Complete reviewed source copy.');
        assert.deepEqual(limits, [5000, 10000]);
      } finally { network.mock.restore(); credential.mock.restore(); lightCredential.mock.restore(); }
    }
  } finally {
    env.AZURE_OPENAI_ENDPOINT_GPT54 = endpoint;
    telemetry.mock.restore();
  }
});
test('missing generated copy is rejected before saving any destination or sending it for review', async () => {
  const f = await publishingFixture();
  try {
    for (const blogSelected of [false, true]) {
      const t = await topic(f.db); await source(f.db, t.id);
      let calls = 0;
      await assert.rejects(editorial.assessTopic(f.db, t, {
        ...editorial.editorialServices, preferences: async () => '',
        chat: async system => {
          calls++;
          if (system.includes('Select BEFORE')) return { bluesky: true, blog: blogSelected, distinctArgument: false, priority: 80, rationale: 'A substantive practical administration change.' };
          if (system.includes('Create ONLY')) return { blog, linkedin: { copy: 'Read the practical administration argument.' }, bluesky: { text: 'Wrong field, not copy.' } };
          throw new Error('An empty draft must never reach review');
        },
      }), /did not return complete bluesky draft text/);
      assert.equal(calls, 2);
      assert.equal((await f.db.query('SELECT * FROM publishing_drafts WHERE topic_id=$1', [t.id])).rows.length, 0);
    }
  } finally { await f.close(); }
});
test('legacy drafts without copy are generated before review, creating a new unapproved version', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id);
    await store.saveDraft(f.db, t.id, 'bluesky', 'source', { account: 'fixture.bsky.social' }, new Date(Date.now() + 3600000).toISOString(), false);
    const empty = (await store.topicDetail(f.db, t.id)).drafts[0]!;
    const calls: string[] = [];
    const services = {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system: string, input: unknown) => {
        calls.push(system);
        if (system.includes('Write the missing')) return { copy: 'Check the documented scope and permissions before enabling the capability.' };
        assert.ok(typeof input === 'object' && input !== null && 'passages' in input);
        assert.ok(Array.isArray(input.passages));
        assert.ok(input.passages.some((passage: { field: string; before: string }) =>
          passage.field === 'copy' && passage.before === 'Check the documented scope and permissions before enabling the capability.'));
        return { outcome: 'pass', findings: [] };
      },
    };
    await assert.rejects(editorial.reviewDraft(f.db, empty, [s], services, false), /no complete saved text/);
    assert.equal(calls.length, 0);
    await editorial.reviewDraft(f.db, empty, [s], services);
    const generated = (await store.topicDetail(f.db, t.id)).drafts[0]!;
    assert.equal(generated.version, 2); assert.equal(generated.approval, 'pending'); assert.equal(generated.review, 'pass');
    assert.equal(calls.length, 3); assert.match(calls[0]!, /Write the missing/);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
  } finally { await f.close(); }
});
test('pause, unreviewed copy, missing approval and stale version fail closed before a network request', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const d = await draft(f.db, t.id);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /off/);
    await enable(f.db);
    await f.db.query("UPDATE publishing_drafts SET review='hold' WHERE id=$1", [d.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /passed editorial review/);
    await f.db.query("UPDATE publishing_drafts SET review='pass',approval='pending',reviewed_at=NOW()-INTERVAL '25 hours' WHERE id=$1", [d.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /human approval/);
    await f.db.query("UPDATE publishing_drafts SET reviewed_at=NOW(),approval='approved',expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1", [d.id]);
    await editorial.editDraft(f.db, d.id, 1, { copy: 'Changed wording.' }, 'human');
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /version/);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
  } finally { await f.close(); }
});
test('an approved version is not reopened just because its passed review is older than a day', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const d = await draft(f.db, t.id); await enable(f.db);
    await f.db.query("UPDATE publishing_drafts SET reviewed_at=NOW()-INTERVAL '40 hours' WHERE id=$1", [d.id]);
    await reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d));
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 1);
  } finally { await f.close(); }
});
test('a passed review never expires: an old pass can still be approved and delivered without another review', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const d = await draft(f.db, t.id); await enable(f.db);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',reviewed_at=NOW()-INTERVAL '40 hours' WHERE id=$1", [d.id]);
    await store.decideDraft(f.db, d.id, d.version, 'approve', 'human', '');
    const approved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(approved.approval, 'approved'); assert.equal(approved.review, 'pass');
    await reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(approved));
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 1);
  } finally { await f.close(); }
});
test('simultaneous claims share an account slot and uncertainty blocks every later post', async () => {
  const f = await publishingFixture();
  try {
    const results = await Promise.allSettled([reserveDelivery(f.db, 'bluesky', 'account', { identity: 'a' }), reserveDelivery(f.db, 'bluesky', 'account', { identity: 'b' })]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(results.some(x => x.status === 'rejected' && x.reason instanceof PublicationDeferred));
    await f.db.query("UPDATE publishing_deliveries SET status='unconfirmed',attempted_at=NOW()-INTERVAL '10 days'");
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'account', { identity: 'c' }), /unresolved/);
  } finally { await f.close(); }
});
test('successful delivery uses actual publication time and returns the stored receipt without resending', async () => {
  const f = await publishingFixture();
  try {
    let sends = 0;
    const send = async () => { sends++; return { uri: 'uri', url: 'https://bsky.app/profile/fixture/post/id' }; };
    const receipt = await deliver(f.db, 'bluesky', 'account', { identity: 'a' }, send);
    assert.deepEqual(await deliver(f.db, 'bluesky', 'account', { identity: 'a' }, send), receipt);
    assert.equal(sends, 1);
    const rows = (await f.db.query<Delivery>(`SELECT ${store.deliveryColumns} FROM publishing_deliveries`)).rows;
    assert.ok(rows[0]!.publishedAt);
    assert.match(slotBlock(rows, 'bluesky', new Date())!, /interval/);
  } finally { await f.close(); }
});
test('there are no daily caps: only spacing since the last success blocks a post', () => {
  const now = new Date('2026-10-24T18:00Z');
  const history = [0, 1, 2, 3].map(i => ({ identity: `fixture:${i}`, status: 'sent', publishedAt: `2026-10-24T${String(i * 3 + 1).padStart(2, '0')}:00Z` } as Delivery));
  assert.equal(slotBlock(history, 'bluesky', now), null);
  assert.equal(slotBlock(history.slice(0, 3), 'linkedin', now), null);
  assert.equal(slotBlock(history.map(d => ({ ...d, status: 'failed' })), 'bluesky', now), null);
  assert.equal(slotBlock(history.map(d => ({ ...d, identity: `podcast:${d.identity}` })), 'bluesky', now), null);
});
test('explicit independent timing bypasses spacing, never unresolved deliveries', () => {
  const now = new Date('2026-11-02T11:30Z');
  const history = [0, 1, 2, 3].map(i => ({
    identity: `fixture:${i}`, status: 'sent', publishedAt: '2026-11-02T11:29Z',
  } as Delivery));
  assert.match(slotBlock(history, 'bluesky', now)!, /interval/);
  assert.match(slotBlock(history.slice(0, 1), 'bluesky', now)!, /interval/);
  assert.equal(slotBlock(history, 'bluesky', now, true), null);
  for (const status of ['sending', 'unconfirmed'] as const) {
    assert.match(slotBlock([{ ...history[0]!, status }], 'bluesky', now, true)!, /unresolved/);
  }
});
test('manual Discover posts bypass interval pacing while preserving duplicate and uncertain-delivery protection', async () => {
  const route = await readFile(new URL('../src/routes/discover.ts', import.meta.url), 'utf8');
  assert.match(route, /deliver\(db, 'linkedin', memberId, \{ identity: `discover:\$\{id\}`, independentSchedule: true \}/);
  assert.match(route, /deliver\(db, 'bluesky', destinationAccount\('bluesky'\), \{ identity: `discover:\$\{id\}`, independentSchedule: true \}/);
  const f = await publishingFixture();
  try {
    for (const destination of ['bluesky', 'linkedin'] as const) {
      const account = destination === 'bluesky' ? 'fixture.bsky.social' : 'member';
      let sends = 0;
      const send = async () => { sends++; return { url: 'https://example.test/post' }; };
      const first = { identity: `manual-${destination}-first`, independentSchedule: true };
      await deliver(f.db, destination, account, first, send);
      await assert.rejects(reserveDelivery(f.db, destination, account, { identity: `automatic-${destination}` }), /interval/);
      await deliver(f.db, destination, account, { identity: `manual-${destination}-second`, independentSchedule: true }, send);
      await deliver(f.db, destination, account, first, send);
      assert.equal(sends, 2, 'manual posts are immediate, but the same delivery is not sent twice');
      await assert.rejects(deliver(f.db, destination, account, { identity: `manual-${destination}-uncertain`, independentSchedule: true },
        async () => { throw new PublicationUnconfirmed('Receipt unavailable.'); }));
      await assert.rejects(reserveDelivery(f.db, destination, account, { identity: `manual-${destination}-next`, independentSchedule: true }), /unresolved/);
    }
  } finally { await f.close(); }
});
test('unknown outcomes reserve capacity; only definite transient failures get bounded retries', async () => {
  const f = await publishingFixture();
  try {
    await assert.rejects(deliver(f.db, 'linkedin', 'member', { identity: 'uncertain' }, async () => { throw new PublicationUnconfirmed('Timed out'); }));
    assert.equal((await f.db.query<Delivery>(`SELECT ${store.deliveryColumns} FROM publishing_deliveries WHERE identity='uncertain'`)).rows[0]!.status, 'unconfirmed');
    await assert.rejects(reserveDelivery(f.db, 'linkedin', 'member', { identity: 'later' }), /unresolved/);
    await assert.rejects(deliver(f.db, 'linkedin', 'other', { identity: 'rate' }, async () => { throw new IntegrationError('linkedin', 'HTTP 429'); }));
    const retry = (await f.db.query<Delivery>(`SELECT ${store.deliveryColumns} FROM publishing_deliveries WHERE identity='rate'`)).rows[0]!;
    assert.equal(retry.status, 'failed'); assert.ok(retry.nextAttemptAt);
    await assert.rejects(reserveDelivery(f.db, 'linkedin', 'other', { identity: 'rate' }));
    for (const [attempt, minutes] of [[2, 15], [3, 60], [4, null]] as const) {
      await f.db.query("UPDATE publishing_deliveries SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE identity='rate'");
      const start = Date.now();
      await assert.rejects(deliver(f.db, 'linkedin', 'other', { identity: 'rate' }, async () => { throw new IntegrationError('linkedin', 'HTTP 429'); }));
      const next = (await f.db.query<Delivery>(`SELECT ${store.deliveryColumns} FROM publishing_deliveries WHERE identity='rate'`)).rows[0]!;
      assert.equal(next.attempts, attempt);
      if (minutes === null) assert.equal(next.nextAttemptAt, null);
      else assert.ok(Math.abs(new Date(next.nextAttemptAt!).getTime() - start - minutes * 60000) < 1000);
    }
    await assert.rejects(deliver(f.db, 'linkedin', 'third', { identity: 'bad-config' }, async () => { throw new IntegrationError('linkedin', 'Renew token'); }));
    assert.equal((await f.db.query<Delivery>(`SELECT ${store.deliveryColumns} FROM publishing_deliveries WHERE identity='bad-config'`)).rows[0]!.nextAttemptAt, null);
  } finally { await f.close(); }
});
test('blog and LinkedIn require separate exact-version approval; blog edit invalidates the hook', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); await enable(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog'); const l = await draft(f.db, t.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', '');
    await assert.rejects(reserveDelivery(f.db, 'blog', 'blog.fixture.invalid', context(b)), /Both/);
    await store.decideDraft(f.db, l.id, 1, 'approve', 'human', '');
    await editorial.editDraft(f.db, b.id, 1, { ...blog, title: 'The revised practical argument' }, 'human');
    const changed = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
    assert.ok(changed.every(x => x.approval === 'pending' && x.review === 'pending'));
    assert.equal(changed.find(x => x.id === b.id)!.version, 2);
    assert.equal(changed.find(x => x.id === b.id)!.content.account, 'blog.fixture.invalid');
    await assert.rejects(store.decideDraft(f.db, b.id, 1, 'approve', 'human', ''), /changed/);
    assert.equal((await f.db.query('SELECT * FROM publishing_versions WHERE draft_id=$1', [b.id])).rows.length, 2);
  } finally { await f.close(); }
});
test('one package approval covers both exact versions atomically and rejects stale or unready copy', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const l = await draft(f.db, t.id, 'linkedin', 'blog');
    await assert.rejects(store.approvePackage(f.db, t.id, { blog: 1, linkedin: 2 }, 'human'), /changed/);
    await f.db.query("UPDATE publishing_drafts SET review='pending' WHERE id=$1", [l.id]);
    await assert.rejects(store.approvePackage(f.db, t.id, { blog: 1, linkedin: 1 }, 'human'), /LinkedIn/);
    assert.ok((await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows.every(d => d.approval === 'pending'));
    await f.db.query("UPDATE publishing_drafts SET review='pass' WHERE id=$1", [l.id]);
    await store.approvePackage(f.db, t.id, { blog: b.version, linkedin: l.version }, 'human');
    assert.ok((await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows.every(d => d.approval === 'approved'));
    assert.equal((await f.db.query("SELECT * FROM publishing_versions WHERE approved_by='human'")).rows.length, 2);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
  } finally { await f.close(); }
});
test('a queued source post is superseded by the blog and a sent one needs a distinct argument and 24 hours', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); await enable(f.db);
    const blue = await draft(f.db, t.id); await draft(f.db, t.id, 'blog', 'blog');
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(blue)), /superseded/);
    const next = await topic(f.db); await source(f.db, next.id); const later = await draft(f.db, next.id);
    await f.db.query('UPDATE publishing_topics SET event_key=$2 WHERE id=$1', [next.id, t.eventKey]);
    await f.db.query(`INSERT INTO publishing_deliveries(identity,destination,topic_id,account,status,attempted_at,published_at)
      VALUES('prior','bluesky',$1,'fixture.bsky.social','sent',NOW()-INTERVAL '25 hours',NOW()-INTERVAL '25 hours')`, [t.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(later)), /distinct/);
    await reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', { ...context(later), distinctArgument: true });
  } finally { await f.close(); }
});
test('public blog verification rejects missing, preview and unrelated pages; no publication is faked', async () => {
  const good = async () => ({ title: blog.title, text: prose });
  assert.ok((await verifyBlog('https://blog.fixture.invalid/article', blog, good)).verifiedAt);
  await assert.rejects(verifyBlog('https://blog.fixture.invalid/article?preview=true', blog, good), /public/);
  await assert.rejects(verifyBlog('https://unrelated.invalid/article', blog, good), /configured/);
  await assert.rejects(verifyBlog('https://blog.fixture.invalid/article', blog, async () => ({ title: '404', text: 'Not found' })), /expected article/);
  await assert.rejects(verifyBlog('https://blog.fixture.invalid/article', blog, async () => ({ ...await good(), finalUrl: 'https://elsewhere.invalid/article' })), /redirected/);
});
test('unreadable source is held before any drafting or model judgement', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id);
    await f.db.query('UPDATE publishing_sources SET body=$2,read_at=NULL WHERE topic_id=$1', [t.id, '']);
    let calls = 0;
    await assert.rejects(editorial.assessTopic(f.db, t, { ...editorial.editorialServices, read: async () => { throw new Error('Unreadable'); },
      chat: async () => { calls++; return {}; } }), /Unreadable/);
    assert.equal(calls, 0); assert.equal((await f.db.query('SELECT * FROM publishing_drafts')).rows.length, 0);
  } finally { await f.close(); }
});
test('selection can choose nothing and preserves rationale without generating filler', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id);
    let calls = 0;
    await editorial.assessTopic(f.db, t, { ...editorial.editorialServices, preferences: async () => '',
      chat: async () => { calls++; return { bluesky: false, blog: false, distinctArgument: false, rationale: 'No substantive practical change.', priority: 5 }; } });
    assert.equal(calls, 1); assert.equal((await f.db.query('SELECT * FROM publishing_drafts')).rows.length, 0);
    assert.match((await store.listTopics(f.db))[0]!.rationale, /No substantive/);
  } finally { await f.close(); }
});
test('accuracy and voice are separate checks; unchanged findings stop a stalled repair with versioned evidence', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id); const d = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending',review='pending' WHERE id=$1", [d.id]);
    await f.db.query('DELETE FROM publishing_schedule WHERE draft_id=$1', [d.id]);
    d.approval = 'pending';
    const calls: string[] = [];
    await editorial.reviewDraft(f.db, d, [s], { ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        calls.push(system);
        if (system.includes('Correct only the supplied')) {
          const current = target(input);
          return { edits: [{ id: current.id, after: `${current.before} Check scope.`, remove: '' }] };
        }
        return { outcome: 'revise', findings: [reviewedPassage(input, 'copy', 'Clarify the source claim.')] };
      } });
    const result = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(result.version, 2); assert.equal(result.review, 'hold');
    assert.equal(calls.filter(s => s.includes('accuracy review only')).length, 2);
    assert.equal(calls.filter(s => s.includes('voice review only')).length, 2);
    assert.match(result.reason, /same findings remain after targeted repair/);
    assert.equal((await f.db.query<{ reviews: unknown[] }>('SELECT reviews FROM publishing_versions WHERE draft_id=$1', [d.id])).rows.filter(v => v.reviews.length).length, 2);
  } finally { await f.close(); }
});
test('changed source evidence never reopens a passed review or an existing human approval', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const b = await draft(f.db, t.id, 'blog', 'blog'); await draft(f.db, t.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', '');
    const unpassed = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET review='revise',approval='pending',reviewed_at=NULL WHERE id=$1", [unpassed.id]);
    const passedRows = async () => (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id<>$1 ORDER BY id`, [unpassed.id])).rows;
    const before = await passedRows();
    assert.ok(before.length === 2 && before.every(d => d.review === 'pass') && before.some(d => d.approval === 'approved'));
    await f.db.query("UPDATE publishing_sources SET read_at=NOW()-INTERVAL '25 hours'");
    await editorial.readSources(f.db, t.id, { ...editorial.editorialServices, read: async () => ({ title: 'Changed evidence', text: prose + 'A materially changed qualification.' }) });
    assert.deepEqual(await passedRows(), before, 'a pass and its approval are permanent');
    const requeued = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [unpassed.id])).rows[0]!;
    assert.equal(requeued.review, 'pending'); assert.equal(requeued.approval, 'pending'); assert.equal(requeued.reviewedAt, null);
  } finally { await f.close(); }
});
test('feed settings and editorial guidance never reopen a passed or approved draft, but re-queue unpassed ones', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); await enable(f.db);
    const blue = await draft(f.db, t.id);
    const waiting = await topic(f.db); await source(f.db, waiting.id);
    const unpassed = await draft(f.db, waiting.id);
    await f.db.query("UPDATE publishing_drafts SET review='revise',approval='pending',reviewed_at=NULL WHERE id=$1", [unpassed.id]);
    const current = (await store.feeds(f.db)).find(feed => feed.id === 'bluesky')!;
    await store.saveFeed(f.db, 'bluesky', current.revision, true, { ...current.policy, guidance: 'Focus on administration consequences.' }, 'human');
    const kept = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [blue.id])).rows[0]!;
    assert.equal(kept.review, 'pass'); assert.equal(kept.approval, 'approved');
    assert.equal(kept.reviewedFeedRevision, 1, 'the saved review is not repeated for the new feed revision');
    const requeued = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [unpassed.id])).rows[0]!;
    assert.equal(requeued.review, 'pending'); assert.equal(requeued.approval, 'pending'); assert.equal(requeued.reviewedAt, null);
    await reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(kept));
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 1);
    const pkg = await topic(f.db); await source(f.db, pkg.id);
    const b = await draft(f.db, pkg.id, 'blog', 'blog'); const l = await draft(f.db, pkg.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', ''); await store.decideDraft(f.db, l.id, 1, 'approve', 'human', '');
    const blogFeed = (await store.feeds(f.db)).find(feed => feed.id === 'blog-linkedin')!;
    await store.saveFeed(f.db, blogFeed.id, blogFeed.revision, true, { ...blogFeed.policy, guidance: 'Only substantial analysis.' }, 'human');
    const approved = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [pkg.id])).rows;
    assert.equal(approved.length, 2);
    assert.ok(approved.every(d => d.approval === 'approved' && d.review === 'pass'));
  } finally { await f.close(); }
});
test('legacy manual and Jobs successes count towards the same account ledger', async () => {
  const f = await publishingFixture();
  try {
    await f.db.query(`INSERT INTO content_items(title,source,metadata) VALUES('Historic','discovered-article',$1)`,
      [JSON.stringify({ blueskyPost: { status: 'posted', url: 'https://bsky.app/fixture', postedAt: new Date().toISOString() } })]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', { identity: 'new' }), /interval/);
    assert.equal((await f.db.query("SELECT * FROM publishing_deliveries WHERE identity LIKE 'discover:%'")).rows.length, 1);
  } finally { await f.close(); }
});
test('preparation has no daily allowance; enabling alone never posts before exact-version human approval', async () => {
  const f = await publishingFixture();
  const { env } = await import('../src/config/env.js');
  const mode = env.NODE_ENV; env.NODE_ENV = 'production';
  let sends = 0;
  const services = {
    member: async () => ({ id: 'member', name: 'Fixture' }),
    read: async () => ({ title: 'Original evidence', text: prose }),
    blog: async (): Promise<never> => { throw new Error('Blog not selected'); },
    linkedin: async (): Promise<never> => { throw new Error('LinkedIn not selected'); },
    bluesky: async () => { sends++; return { uri: 'uri', url: 'https://bsky.app/profile/fixture/post/id' }; },
  };
  try {
    await f.db.query("INSERT INTO content_items(title,url,source) VALUES('Practical Microsoft update','https://source.fixture.invalid/update','discovered-article')");
    for (let i = 0; i < 20; i++) await store.event(f.db, null, 'editorial-worker', 'preparation-started', {});
    const editorialServices = { ...editorial.editorialServices, ...services, preferences: async () => '', chat: async (system: string) => {
      if (system.includes('Select BEFORE')) return { bluesky: true, blog: false, distinctArgument: false, priority: 80, rationale: 'A useful practical change.' };
      if (system.includes('Create ONLY')) return { bluesky: { copy: 'Check the scope of this practical administration change.' } };
      return { outcome: 'pass', findings: [] };
    } };
    await tickPublishing(f.db, editorialServices, services);
    assert.equal(sends, 0);
    const prepared = await store.listTopics(f.db);
    assert.equal(prepared[0]!.state, 'ready', 'prior daily assessments never block new preparation');
    assert.equal(prepared[0]!.drafts[0]!.review, 'pass');
    await enable(f.db);
    await tickPublishing(f.db, editorialServices, services);
    assert.equal(sends, 0, 'automation cannot send a post the user has not approved');
    const ready = prepared[0]!.drafts[0]!;
    await store.decideDraft(f.db, ready.id, ready.version, 'approve', 'human', 'Send for scheduling.');
    await tickPublishing(f.db, editorialServices, services);
    assert.equal(sends, 0, 'approval assigns a future slot rather than publishing immediately');
    await f.db.query("UPDATE publishing_schedule SET scheduled_at=NOW()-INTERVAL '1 minute' WHERE draft_id=$1", [ready.id]);
    await tickPublishing(f.db, editorialServices, services);
    await tickPublishing(f.db, editorialServices, services);
    assert.equal(sends, 1);
    assert.equal((await f.db.query<{ workflow_state: string }>('SELECT workflow_state FROM content_items')).rows[0]!.workflow_state, 'published');
  } finally { env.NODE_ENV = mode; await f.close(); }
});
test('a verified blog survives LinkedIn rejection and retry without republishing; unverified acceptance blocks promotion', async () => {
  const f = await publishingFixture();
  let blogs = 0; let linkedin = 0;
  const services = {
    member: async () => ({ id: 'member', name: 'Fixture' }),
    read: async () => ({ title: blog.title, text: prose }),
    blog: async () => { blogs++; return { httpStatus: 200, payload: { success: true as const, data: { url: 'https://blog.fixture.invalid/article', editUrl: null, status: 'published' as const } } }; },
    bluesky: async () => ({ uri: 'uri', url: 'https://bsky.app/fixture' }),
    linkedin: async () => { linkedin++; if (linkedin === 1) throw new IntegrationError('linkedin', 'HTTP 429'); return { urn: 'urn', url: 'https://www.linkedin.com/feed/update/fixture' }; },
  };
  try {
    const t = await topic(f.db); await source(f.db, t.id); await enable(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog'); const l = await draft(f.db, t.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', ''); await store.decideDraft(f.db, l.id, 1, 'approve', 'human', '');
    await publishDraft(f.db, b, services);
    await assert.rejects(publishDraft(f.db, l, services), /429/);
    await publishDraft(f.db, b, services);
    assert.equal(blogs, 1);
    await f.db.query("UPDATE publishing_deliveries SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE destination='linkedin'");
    await publishDraft(f.db, l, services);
    assert.equal(blogs, 1); assert.equal(linkedin, 2);
    const other = await topic(f.db); await source(f.db, other.id);
    const otherBlog = await draft(f.db, other.id, 'blog', 'blog'); const otherHook = await draft(f.db, other.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, otherBlog.id, 1, 'approve', 'human', ''); await store.decideDraft(f.db, otherHook.id, 1, 'approve', 'human', '');
    await f.db.query("UPDATE publishing_deliveries SET published_at=NOW()-INTERVAL '4 hours' WHERE destination='linkedin'");
    await assert.rejects(publishDraft(f.db, otherBlog, { ...services, read: async () => ({ title: 'Error', text: 'Not found' }) }), /verification failed/);
    assert.equal((await f.db.query<{ status: string }>("SELECT status FROM publishing_deliveries WHERE draft_id=$1", [otherBlog.id])).rows[0]!.status, 'unconfirmed');
    await assert.rejects(publishDraft(f.db, otherHook, services), /verified/);
  } finally { await f.close(); }
});

test('accepted blog confirmation recovers from 404 without recreating it and gates LinkedIn before Bluesky', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); await enable(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const l = await draft(f.db, t.id, 'linkedin', 'blog');
    const blue = await draft(f.db, t.id, 'bluesky', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', '');
    await store.decideDraft(f.db, l.id, 1, 'approve', 'human', '');
    let available = false;
    const order: string[] = [];
    const url = 'https://blog.fixture.invalid/new-blog';
    const services = {
      member: async () => ({ id: 'member', name: 'Fixture' }),
      blog: async () => { order.push('blog'); return { httpStatus: 200, payload: { success: true as const, data: { url, editUrl: null, status: 'published' as const } } }; },
      read: async () => { if (!available) throw new Error('Page returned HTTP 404'); return { title: blog.title, text: prose }; },
      linkedin: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); order.push('linkedin'); return { urn: 'urn', url: 'https://www.linkedin.com/fixture' }; },
      bluesky: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); order.push('bluesky'); return { uri: 'uri', url: 'https://bsky.app/fixture' }; },
    };
    await assert.rejects(publishDraft(f.db, b, services), /HTTP 404/);
    const delivery = (await f.db.query<Delivery>(`SELECT ${store.deliveryColumns} FROM publishing_deliveries WHERE draft_id=$1`, [b.id])).rows[0]!;
    assert.equal(delivery.receipt?.url, url);
    assert.ok(delivery.nextAttemptAt);
    await f.db.query('UPDATE publishing_drafts SET held=TRUE,reason=$2 WHERE id=$1', [b.id, delivery.error]);
    available = true;
    assert.equal(await recoverBlogPublication(f.db, delivery, services.read), true);
    assert.equal(await recoverBlogPublication(f.db, delivery, services.read), false, 'confirmation is idempotent');
    const confirmed = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [b.id])).rows[0]!;
    assert.equal(confirmed.held, false);
    assert.equal(confirmed.approval, 'approved');
    assert.equal(confirmed.version, 1);
    await publishDraft(f.db, b, services);
    await assert.rejects(publishDraft(f.db, blue, services), /LinkedIn/);
    await publishDraft(f.db, l, services);
    await publishDraft(f.db, blue, services);
    assert.deepEqual(order, ['blog', 'linkedin', 'bluesky']);
  } finally { await f.close(); }
});

test('blog-flow slots follow Blog then LinkedIn then Bluesky while standalone Bluesky has no dependency', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); await enable(f.db);
    const b = await draft(f.db, t.id, 'blog', 'blog');
    const l = await draft(f.db, t.id, 'linkedin', 'blog');
    const blue = await draft(f.db, t.id, 'bluesky', 'blog');
    const now = new Date('2026-10-27T07:00:00Z');
    const candidates = [b, l, blue].map(d => ({ ...d, approval: 'approved' as const,
      title: 'Fixture', topicState: 'ready', scheduleReason: null,
      scheduledAt: d.destination === 'bluesky' ? '2026-10-27T08:15:00Z' : null }));
    const settings = await store.feeds(f.db);
    const plan = planSchedule(candidates, settings, [], now);
    const at = (destination: Draft['destination']): number => Date.parse(plan.find(p => p.destination === destination)!.scheduledAt!);
    assert.ok(at('blog') < at('linkedin'));
    assert.ok(at('linkedin') < at('bluesky'));
    const standalone = planSchedule([{ ...candidates[2]!, variant: 'source' }], settings, [], now);
    assert.ok(standalone[0]!.scheduledAt);
    assert.doesNotMatch(standalone[0]!.reason, /LinkedIn|blog/);
  } finally { await f.close(); }
});

test('held drafts do not reserve slots and overdue commitments are not silently rebooked', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db);
    await source(f.db, t.id);
    await enable(f.db);
    const blue = await draft(f.db, t.id);
    const settings = await store.feeds(f.db);
    const now = new Date('2026-10-30T16:30:00Z');
    const candidate = { ...blue, title: 'Fixture', topicState: 'ready', scheduleReason: null,
      scheduledAt: '2026-10-30T08:00:00Z' };
    const overdue = planSchedule([candidate], settings, [], now)[0]!;
    assert.equal(overdue.scheduledAt, '2026-10-30T08:00:00.000Z');
    assert.match(overdue.reason, /Overdue/);
    const plan = planSchedule([
      { ...candidate, held: true },
      { ...candidate, id: randomUUID(), topicId: randomUUID(), scheduledAt: null },
    ], settings, [], now);
    const blocked = plan.find(post => post.draftId === blue.id)!;
    assert.equal(blocked.scheduledAt, null);
    assert.match(blocked.reason, /hold/i);
    assert.equal(plan.find(post => post.draftId !== blue.id)!.scheduledAt,
      planSchedule([{ ...candidate, id: 'other', scheduledAt: null }], settings, [], now)[0]!.scheduledAt,
      'A blocked source must not consume the next available slot');
  } finally { await f.close(); }
});

for (const state of ['shelved', 'archived']) {
  test(`exact-version approval permits delivery with a ${state} source without bypassing holds or revocation`, async () => {
    const f = await publishingFixture();
    try {
      const t = await topic(f.db);
      const s = await source(f.db, t.id);
      const blue = await draft(f.db, t.id);
      await enable(f.db);
      await f.db.query('UPDATE publishing_feeds SET policy=jsonb_set(policy,\'{days}\',\'[0,1,2,3,4,5,6]\')');
      await f.db.query("INSERT INTO content_items(id,title,source,workflow_state) VALUES($1,'Filed source','discovered-article',$2)", [s.itemId, state]);
      assert.ok((await listSchedule(f.db)).find(post => post.draftId === blue.id)!.scheduledAt);
      await f.db.query('UPDATE publishing_drafts SET held=TRUE WHERE id=$1', [blue.id]);
      await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(blue)), /held/);
      await f.db.query("UPDATE publishing_drafts SET held=FALSE,approval='pending' WHERE id=$1", [blue.id]);
      await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(blue)), /archived or shelved/);
      await f.db.query("UPDATE publishing_drafts SET approval='approved' WHERE id=$1", [blue.id]);
      await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', { ...context(blue), version: blue.version + 1 }), /version/);
      await reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(blue));
    } finally { await f.close(); }
  });
}
