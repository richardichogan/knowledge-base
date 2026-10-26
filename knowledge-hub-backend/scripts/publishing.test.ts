import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { publishingFixture } from './publishing-fixture.js';
import type { Pool } from 'pg';
import type { Draft, Delivery, Source, Topic } from '../src/publishing/contracts.js';
import { isMicrosoftRelevant, microsoftRelevanceSql } from '../src/utils/microsoftRelevance.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/publishing';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/api/posts';
process.env.BLUESKY_IDENTIFIER = 'fixture.bsky.social';
const store = await import('../src/publishing/store.js');
const editorial = await import('../src/publishing/editorial.js');
const { reserveDelivery, deliver, inWindow, slotBlock, PublicationDeferred, PublicationUnconfirmed } = await import('../src/publishing/delivery.js');
const { parsePolicy } = await import('../src/publishing/contracts.js');
const { verifyBlog, tickPublishing, publishDraft } = await import('../src/publishing/worker.js');
const { refreshSchedule, listSchedule } = await import('../src/publishing/schedule.js');
const { refreshPublishingDrafts } = await import('../src/publishing/refresh.js');
const { IntegrationError, AiOutputLimitError } = await import('../src/types/errors.js');
const prose = 'Administrators can now configure the documented capability through the existing management portal. Check the scope and permissions before enabling it. '.repeat(9);
const blog = { title: 'A practical administration change', summary: 'Check permissions before enabling the documented capability.', excerpt: 'A practical administration change.',
  content: `<p>${prose}</p>`, keyTakeaways: ['Check the documented permissions.'], categories: [], tags: [], postType: 'article', account: 'blog.fixture.invalid' };
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
    await f.db.query("UPDATE publishing_drafts SET approval='pending',reviewed_at=NOW()-INTERVAL '25 hours' WHERE topic_id=$1", [pending.id]);
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
    assert.equal((await f.db.query("SELECT * FROM publishing_events WHERE event='draft-refresh-completed'")).rows.length, 1);
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
    await assert.rejects(editorial.reviewDraft(f.db, d, [s], {
      ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input, tokens, schema) => {
        if (!system.includes('Repair only')) return { outcome: 'revise', findings: ['Clarify the permission requirement.'] };
        assert.deepEqual(schema, editorial.EDITORIAL_SCHEMAS.edits);
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
        assert.ok(typeof input === 'object' && input !== null && 'draft' in input);
        assert.equal((input.draft as { copy: string }).copy, 'Check the documented scope and permissions before enabling the capability.');
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
test('pause, stale review and stale version fail closed before a network request', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const d = await draft(f.db, t.id);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /off/);
    await enable(f.db);
    await f.db.query("UPDATE publishing_drafts SET review='hold' WHERE id=$1", [d.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /fresh/);
    await f.db.query("UPDATE publishing_drafts SET review='pass',approval='pending',reviewed_at=NOW()-INTERVAL '25 hours' WHERE id=$1", [d.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /fresh/);
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
test('daily caps count only successes, include blog-linked Bluesky and do not catch up in bursts', () => {
  const now = new Date('2026-10-24T18:00Z');
  const history = [0, 1, 2, 3].map(i => ({ status: 'sent', publishedAt: `2026-10-24T${String(i * 3 + 1).padStart(2, '0')}:00Z` } as Delivery));
  assert.match(slotBlock(history, 'bluesky', now)!, /Daily/);
  assert.match(slotBlock(history.slice(0, 3), 'linkedin', now)!, /Daily/);
  assert.equal(slotBlock(history.map(d => ({ ...d, status: 'failed' })), 'bluesky', now), null);
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
test('accuracy and voice are separate checks; two unsuccessful revisions end in a hold with versioned findings', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id); const d = await draft(f.db, t.id);
    await f.db.query("UPDATE publishing_drafts SET approval='pending' WHERE id=$1", [d.id]);
    d.approval = 'pending';
    const calls: string[] = [];
    await editorial.reviewDraft(f.db, d, [s], { ...editorial.editorialServices, preferences: async () => '',
      chat: async (system, input) => {
        calls.push(system);
        if (system.includes('Repair only')) {
          const current = input as { content: { copy: string } };
          return { edits: [{ field: 'copy', before: current.content.copy, after: `${current.content.copy} Check scope.` }] };
        }
        return { outcome: 'revise', findings: ['Clarify the source claim.'] };
      } });
    const result = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [d.id])).rows[0]!;
    assert.equal(result.version, 3); assert.equal(result.review, 'hold');
    assert.equal(calls.filter(s => s.includes('accuracy review only')).length, 3);
    assert.equal(calls.filter(s => s.includes('voice review only')).length, 3);
    assert.equal((await f.db.query<{ reviews: unknown[] }>('SELECT reviews FROM publishing_versions WHERE draft_id=$1', [d.id])).rows.filter(v => v.reviews.length).length, 3);
  } finally { await f.close(); }
});
test('changed full source evidence invalidates existing human approvals before stale review can pass', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const b = await draft(f.db, t.id, 'blog', 'blog'); await draft(f.db, t.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', '');
    await f.db.query("UPDATE publishing_sources SET read_at=NOW()-INTERVAL '25 hours'");
    await editorial.readSources(f.db, t.id, { ...editorial.editorialServices, read: async () => ({ title: 'Changed evidence', text: prose + 'A materially changed qualification.' }) });
    const rows = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1`, [t.id])).rows;
    assert.ok(rows.every(d => d.review === 'pending' && d.approval === 'pending'));
  } finally { await f.close(); }
});
test('settings changed mid-review cannot authorise stale drafts; new editorial guidance clears paired approvals', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); const s = await source(f.db, t.id); await enable(f.db);
    const blue = await draft(f.db, t.id);
    const current = (await store.feeds(f.db)).find(feed => feed.id === 'bluesky')!;
    await store.saveFeed(f.db, 'bluesky', current.revision, true, { ...current.policy, guidance: 'Focus on administration consequences.' }, 'human');
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(blue)), /review/);
    const pending = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [blue.id])).rows[0]!;
    await editorial.reviewDraft(f.db, pending, [s], { ...editorial.editorialServices, preferences: async () => '', chat: async () => ({ outcome: 'pass', findings: [] }) });
    const reviewed = (await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE id=$1`, [blue.id])).rows[0]!;
    assert.equal(reviewed.reviewedFeedRevision, 2);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(reviewed)), /human approval/);
    await store.decideDraft(f.db, reviewed.id, reviewed.version, 'approve', 'human', 'Reviewed the new guidance.');
    await reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(reviewed));
    const b = await draft(f.db, t.id, 'blog', 'blog'); const l = await draft(f.db, t.id, 'linkedin', 'blog');
    await store.decideDraft(f.db, b.id, 1, 'approve', 'human', ''); await store.decideDraft(f.db, l.id, 1, 'approve', 'human', '');
    const blogFeed = (await store.feeds(f.db)).find(feed => feed.id === 'blog-linkedin')!;
    await store.saveFeed(f.db, blogFeed.id, blogFeed.revision, true, { ...blogFeed.policy, guidance: 'Only substantial analysis.' }, 'human');
    assert.ok((await f.db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE destination IN ('blog','linkedin')`)).rows.every(d => d.approval === 'pending' && d.review === 'pending'));
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
test('preparation is automatic; enabling alone never posts before exact-version human approval', async () => {
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
    const editorialServices = { ...editorial.editorialServices, ...services, preferences: async () => '', chat: async (system: string) => {
      if (system.includes('Select BEFORE')) return { bluesky: true, blog: false, distinctArgument: false, priority: 80, rationale: 'A useful practical change.' };
      if (system.includes('Create ONLY')) return { bluesky: { copy: 'Check the scope of this practical administration change.' } };
      return { outcome: 'pass', findings: [] };
    } };
    await tickPublishing(f.db, editorialServices, services);
    assert.equal(sends, 0);
    const prepared = await store.listTopics(f.db);
    assert.equal(prepared[0]!.state, 'ready'); assert.equal(prepared[0]!.drafts[0]!.review, 'pass');
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
