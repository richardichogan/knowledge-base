import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { publishingFixture } from './publishing-fixture.js';
import type { Pool } from 'pg';
import type { Draft, Delivery, Source, Topic } from '../src/publishing/contracts.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/publishing';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/api/posts';
process.env.BLUESKY_IDENTIFIER = 'fixture.bsky.social';
const store = await import('../src/publishing/store.js');
const editorial = await import('../src/publishing/editorial.js');
const { reserveDelivery, deliver, inWindow, slotBlock, PublicationDeferred, PublicationUnconfirmed } = await import('../src/publishing/delivery.js');
const { parsePolicy } = await import('../src/publishing/contracts.js');
const { verifyBlog, tickPublishing, publishDraft } = await import('../src/publishing/worker.js');
const { IntegrationError } = await import('../src/types/errors.js');
const prose = 'Administrators can now configure the documented capability through the existing management portal. Check the scope and permissions before enabling it. '.repeat(9);
const blog = { title: 'A practical administration change', summary: 'Check permissions before enabling the documented capability.', excerpt: 'A practical administration change.',
  content: `<p>${prose}</p>`, keyTakeaways: ['Check the documented permissions.'], categories: [], tags: [], postType: 'article', account: 'blog.fixture.invalid' };
async function topic(db: Pool): Promise<Topic> {
  return (await db.query<Topic>(`INSERT INTO publishing_topics(title,fingerprint,state) VALUES('Practical update',$1,'ready') RETURNING ${store.topicColumns}`, [randomUUID()])).rows[0]!;
}
async function source(db: Pool, id: string): Promise<Source> {
  return (await db.query<Source>(`INSERT INTO publishing_sources(item_id,topic_id,title,url,body,read_at,discovered_at)
    VALUES($1,$2,'Original evidence','https://source.fixture.invalid/update',$3,NOW(),NOW()) RETURNING ${store.sourceColumns}`, [randomUUID(), id, prose])).rows[0]!;
}
async function draft(db: Pool, id: string, destination: Draft['destination'] = 'bluesky', variant: Draft['variant'] = 'source'): Promise<Draft> {
  await store.saveDraft(db, id, destination, variant, destination === 'blog' ? blog : { copy: 'A practical change, with permissions to check.', account: destination === 'bluesky' ? 'fixture.bsky.social' : 'member' },
    new Date(Date.now() + 3600000).toISOString(), false);
  await db.query("UPDATE publishing_drafts SET review='pass',reviewed_at=NOW(),reviewed_blog_version=1,reviewed_feed_revision=1 WHERE topic_id=$1", [id]);
  return (await db.query<Draft>(`SELECT ${store.draftColumns} FROM publishing_drafts WHERE topic_id=$1 AND destination=$2`, [id, destination])).rows[0]!;
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
test('pause, stale review, expiry and stale version all fail closed before a network request', async () => {
  const f = await publishingFixture();
  try {
    const t = await topic(f.db); await source(f.db, t.id); const d = await draft(f.db, t.id);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /off/);
    await enable(f.db);
    await f.db.query("UPDATE publishing_drafts SET reviewed_at=NOW()-INTERVAL '25 hours' WHERE id=$1", [d.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /fresh/);
    await f.db.query("UPDATE publishing_drafts SET reviewed_at=NOW(),expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1", [d.id]);
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /expired/);
    await f.db.query("UPDATE publishing_drafts SET expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1", [d.id]);
    await editorial.editDraft(f.db, d.id, 1, { copy: 'Changed wording.' }, 'human');
    await assert.rejects(reserveDelivery(f.db, 'bluesky', 'fixture.bsky.social', context(d)), /version/);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
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
    const calls: string[] = [];
    await editorial.reviewDraft(f.db, d, [s], { ...editorial.editorialServices, preferences: async () => '',
      chat: async system => {
        calls.push(system);
        if (system.includes('Revise only')) return { copy: 'A more precise practical update.' };
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
test('disabled switches still prepare reviewed drafts; enabling publishes at most one and never replays it', async () => {
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
    await f.db.query("INSERT INTO content_items(title,url,source) VALUES('Practical update','https://source.fixture.invalid/update','discovered-article')");
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
