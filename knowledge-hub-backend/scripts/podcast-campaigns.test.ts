import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishingFixture } from './publishing-fixture.js';
import type { PodcastPlan } from '../src/publishing/podcastCampaign.js';
import type { PublishingServices } from '../src/publishing/worker.js';
import type { PublishingFeed } from '../src/publishing/contracts.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/podcast';
process.env.NODE_ENV = 'development';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/api/posts';
process.env.BLOG_POSTS_API_KEY = 'fixture';
process.env.LINKEDIN_ACCESS_TOKEN = 'fixture';
process.env.BLUESKY_IDENTIFIER = 'fixture.bsky.social';
process.env.BLUESKY_APP_PASSWORD = 'fixture';
const contracts = await import('../src/publishing/podcastCampaign.js');
const { materialisePodcastSelections, podcastSourceBlocks } = await import('../src/publishing/podcastCampaignSource.js');
const store = await import('../src/publishing/podcastCampaignStore.js');
const { repairPodcastCopy, proposePodcastTimes } = await import('../src/publishing/podcastCampaignPreparation.js');
const { publishPodcastPost, tickPodcastCampaigns } = await import('../src/publishing/podcastCampaignWorker.js');
const { composeBlueskyText, graphemeLength } = await import('../src/integrations/social/bluesky.js');
const { parsePublishBody } = await import('../src/services/blogPublisher.js');
const links = {
  youtube: 'https://youtu.be/abcdefghijk',
  spotify: 'https://open.spotify.com/episode/abcdefghijklmnopqrstuv',
  apple: 'https://podcasts.apple.com/gb/podcast/test/id12345678?i=12345678',
};
const prose = 'This episode discusses how to separate agent permissions from model output and verify the resulting audit records. '.repeat(5);
const blog = { title: 'Who checks the agent', slug: 'who-checks-the-agent', excerpt: 'Episode discussion.',
  summary: 'A practical discussion of agent permissions and audit records.', content: `<p>${prose}</p>`,
  keyTakeaways: [], categories: [], tags: [] };
const accounts = { blog: 'blog.fixture.invalid', linkedin: 'member', bluesky: 'fixture.bsky.social' };
const rawPlan = () => ({
  title: 'Episode campaign', notes: [], excluded: ['Podcast-account LinkedIn copy stays in the source note.'],
  posts: [
    { destination: 'blog', label: 'Launch blog', scheduledAt: '2099-01-05T08:00:00Z', copy: '', blog },
    { destination: 'linkedin', label: 'Personal launch', scheduledAt: '2099-01-05T09:00:00Z', copy: 'A discussion of agent permissions and audit records.', blog: null },
    { destination: 'bluesky', label: 'First Bluesky post', scheduledAt: '2099-01-06T09:00:00Z', copy: 'Who checks the agent? We discuss permissions and independent audit records.', blog: null },
  ],
});
const plan = (): PodcastPlan => contracts.parsePodcastPlan(rawPlan(), links, accounts, 'Richard');
async function fixture() {
  const f = await publishingFixture();
  await f.pg.exec(`CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active');
    CREATE FUNCTION note_list_metadata(value TEXT) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS 'SELECT value::jsonb';
    UPDATE publishing_feeds SET policy=policy || '{"startHour":0,"endHour":24}'::jsonb;`);
  await f.pg.exec(readFileSync(new URL('../src/db/migrations/113_podcast_campaigns.sql', import.meta.url), 'utf8'));
  const noteId = randomUUID();
  await f.db.query('INSERT INTO notes(id,content) VALUES($1,$2)', [noteId, JSON.stringify({
    title: 'Episode', contentType: 'podcast-show-notes', contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: Object.values(links).join('\n') }] }]),
  })]);
  return { ...f, noteId };
}
test('episode URLs require the correct platform and episode, and only unambiguous URLs are prefilled', () => {
  assert.deepEqual(contracts.parseEpisodeLinks(links, true), links);
  assert.throws(() => contracts.parseEpisodeLinks({ ...links, apple: 'https://podcasts.apple.com/gb/podcast/test/id12345678' }), /episode/);
  assert.throws(() => contracts.parseEpisodeLinks({ ...links, youtube: 'https://youtube.com/@podcast' }), /episode/);
  assert.throws(() => contracts.parseEpisodeLinks({ ...links, spotify: 'https://open.spotify.com.evil.invalid/episode/abc' }), /episode/);
  assert.throws(() => contracts.parseEpisodeLinks({ ...links, youtube: 'https://user:password@youtu.be/abcdefghijk' }), /credentials/);
  assert.throws(() => contracts.parseEpisodeLinks({ ...links, apple: '' }, true), /Apple Podcasts/);
  const content = (text: string) => JSON.stringify({ contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text }] }]) });
  assert.deepEqual(contracts.episodeLinksFromNote(content(Object.values(links).join('\n'))), links);
  assert.equal(contracts.episodeLinksFromNote(content(`${links.youtube}\nhttps://youtu.be/lmnopqrstuv`)).youtube, '');
});
test('blog and personal LinkedIn contain all three episode links; Bluesky rotates chronologically within the full-post limit', () => {
  const raw = rawPlan();
  raw.posts.push(
    { ...raw.posts[2]!, scheduledAt: '2099-01-08T09:00:00Z' },
    { ...raw.posts[2]!, scheduledAt: '2099-01-07T09:00:00Z' },
  );
  const result = contracts.parsePodcastPlan(raw, links, accounts, 'Richard');
  for (const url of Object.values(links)) {
    assert.ok(result.posts[0]!.blog!.content.includes(url.replaceAll('&', '&amp;')));
    assert.ok(result.posts[1]!.copy.includes(url));
  }
  const blue = result.posts.filter(post => post.destination === 'bluesky');
  assert.deepEqual(blue.map(post => post.platform), ['youtube', 'spotify', 'apple']);
  assert.deepEqual(blue.map(post => post.url), [links.youtube, links.spotify, links.apple]);
  assert.ok(blue.every(post => graphemeLength(composeBlueskyText(post.copy, post.url)) <= 300));
  raw.posts[2]!.copy = 'x'.repeat(300);
  assert.throws(() => contracts.parsePodcastPlan(raw, links, accounts, 'Richard'), /Bluesky allows 300/);
});
test('missing dates, past dates, ordering and per-account spacing block approval rather than changing the supplied schedule', () => {
  const result = plan();
  assert.deepEqual(contracts.podcastPlanIssues(result, new Date('2099-01-01T00:00:00Z')), []);
  const bad = structuredClone(result);
  bad.posts[0]!.scheduledAt = null;
  bad.posts[1]!.scheduledAt = '2020-01-01T09:00:00Z';
  assert.match(contracts.podcastPlanIssues(bad).join('\n'), /publication date/);
  assert.match(contracts.podcastPlanIssues(bad).join('\n'), /past/);
  assert.equal(bad.posts[1]!.scheduledAt, '2020-01-01T09:00:00Z');
  const crowded = structuredClone(result);
  crowded.posts.push({ ...crowded.posts[2]!, id: randomUUID(), scheduledAt: '2099-01-06T10:00:00Z' });
  assert.match(contracts.podcastPlanIssues(crowded, new Date('2099-01-01')).join('\n'), /at least 2 hours/);
  crowded.posts[2]!.scheduledAt = '2099-01-05T07:00:00Z';
  assert.match(contracts.podcastPlanIssues(crowded, new Date('2099-01-01')).join('\n'), /after the launch blog/);
});
test('campaign preparation copies exact source passages and cannot substitute generated copy', () => {
  const markdown = '## Bluesky\n\nTuesday 27 October 2026 (Git hooks) Keep this exact sentence. #DevOps\n\n## LinkedIn\n\nAn existing [episode](https://example.com) post.\n\nSecond paragraph stays.';
  const blocks = podcastSourceBlocks(markdown);
  assert.equal(blocks.length, 5);
  const selection = { title: 'Episode', notes: [], excluded: [], posts: [
    { destination: 'bluesky', label: 'Git hooks', scheduledAt: '2026-10-27T09:00:00Z',
      copy: { from: 1, to: 1, startAfter: 'Tuesday 27 October 2026 (Git hooks) ', endBefore: '' }, blog: null },
    { destination: 'linkedin', label: 'Existing post', scheduledAt: '2026-10-28T09:00:00Z',
      copy: { from: 3, to: 4, startAfter: '', endBefore: '' }, blog: null },
  ] };
  const result = materialisePodcastSelections(markdown, selection);
  const posts = result.posts as Array<{ copy: string }>;
  assert.equal(posts[0]!.copy, 'Keep this exact sentence. #DevOps');
  assert.equal(posts[1]!.copy, 'An existing episode post.\n\nSecond paragraph stays.');
  assert.throws(() => materialisePodcastSelections(markdown, {
    ...selection, posts: [{ ...selection.posts[0], copy: 'A rewritten post' }],
  }), /object/);
  selection.posts[0]!.copy.startAfter = 'A prefix that was never in the note';
  assert.throws(() => materialisePodcastSelections(markdown, selection), /does not match/);
});
test('source conversion preserves punctuation next to links and emphasis, without publishing internal project URLs', () => {
  const result = materialisePodcastSelections('Listen to [the podcast](http://localhost:5173/projects?projectId=podcast). **Keep** these words.\n\nNext paragraph.', {
    posts: [{ destination: 'linkedin', copy: { from: 0, to: 1, startAfter: '', endBefore: '' } }],
  });
  assert.equal((result.posts as Array<{ copy: string }>)[0]!.copy, 'Listen to the podcast. Keep these words.\n\nNext paragraph.');
});
test('authored podcast blog copy is preserved, while normal blog style and required-field checks remain', () => {
  const authored = { ...blog, postType: 'podcast', content: '<p>A game-changer — that was the phrase used.</p>' };
  assert.equal(parsePublishBody(authored, true).content, authored.content);
  assert.throws(() => parsePublishBody(authored), /banned AI/);
  assert.throws(() => parsePublishBody({ ...authored, postType: 'article' }, true), /banned AI/);
  assert.throws(() => parsePublishBody({ ...authored, title: '' }, true), /required/);
  assert.throws(() => parsePublishBody({ ...authored, excerpt: 'x'.repeat(301) }, true), /not been shortened/);
});
test('follow-up windows retain oversized authored copy for review without inventing a launch', () => {
  const raw = rawPlan();
  raw.posts = raw.posts.slice(2);
  raw.posts[0]!.copy = 'x'.repeat(280);
  const result = contracts.parsePodcastPlan(raw, links, accounts, 'Richard',
    { authored: true, window: { from: '2099-01-06', to: '2099-01-08' } });
  assert.equal(result.followUp, true);
  assert.equal(result.posts[0]!.copy, 'x'.repeat(280));
  const issues = contracts.podcastPlanIssues(result, new Date('2099-01-01')).join('\n');
  assert.match(issues, /Bluesky allows 300/);
  assert.doesNotMatch(issues, /launch blog|no LinkedIn/);
  assert.throws(() => contracts.parsePodcastPlan(raw, links, accounts, 'Richard',
    { authored: true, window: { from: '2099-01-07', to: '2099-01-08' } }), /outside/);
  assert.throws(() => contracts.parsePodcastWindow({ from: '2026-02-30', to: '2026-03-01' }), /calendar/);
});
test('one revision-checked approval covers the frozen campaign; pause/resume preserves identities and published links cannot change', async () => {
  const f = await fixture();
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ sub: 'member', name: 'Richard' }), { status: 200 }));
  try {
    const suggested = await store.getPodcastCampaign(f.db, f.noteId);
    assert.equal(suggested.revision, 0);
    assert.deepEqual(suggested.links, links);
    await store.savePodcastLinks(f.db, f.noteId, 0, links, 'human');
    await f.db.query('UPDATE podcast_campaigns SET plan=$2,source_revision=1 WHERE note_id=$1', [f.noteId, JSON.stringify(plan())]);
    const approved = await store.decidePodcastCampaign(f.db, f.noteId, 1, 'approve', 'human');
    assert.equal(approved.state, 'approved');
    assert.ok(approved.approvedAt);
    await assert.rejects(store.decidePodcastCampaign(f.db, f.noteId, 1, 'pause', 'human'), /changed/);
    const paused = await store.decidePodcastCampaign(f.db, f.noteId, approved.revision, 'pause', 'human');
    const resumed = await store.decidePodcastCampaign(f.db, f.noteId, paused.revision, 'resume', 'human');
    assert.deepEqual(resumed.plan, approved.plan);
    const pausedAgain = await store.decidePodcastCampaign(f.db, f.noteId, resumed.revision, 'pause', 'human');
    await f.db.query(`INSERT INTO publishing_deliveries(identity,destination,account,status,published_at)
      VALUES($1,'blog',$2,'sent',NOW())`, [contracts.podcastIdentity(f.noteId, resumed.plan!.posts[0]!.id), accounts.blog]);
    await assert.rejects(store.savePodcastLinks(f.db, f.noteId, pausedAgain.revision, links, 'human'), /Publication has started/);
  } finally { fetchMock.mock.restore(); await f.close(); }
});
test('delivery enforces approval, pause and ordering at claim time, uses listening URLs, and never repeats a confirmed send', async () => {
  const f = await fixture();
  const sends: string[] = [];
  const prepared = plan();
  prepared.posts.forEach((post, index) => { post.scheduledAt = new Date(Date.now() - (10 - index) * 60_000).toISOString(); });
  const send: PublishingServices = {
    member: async () => ({ id: 'member', name: 'Richard' }),
    blog: async () => { sends.push('blog'); return { httpStatus: 200, payload: { success: true, data: { status: 'published', editUrl: null, url: 'https://blog.fixture.invalid/episode/' } } }; },
    read: async () => ({ title: blog.title, text: prose }),
    linkedin: async (copy, link) => { Object.values(links).forEach(url => assert.ok(copy.includes(url))); assert.equal(link, null);
      sends.push('linkedin'); return { urn: 'urn', url: 'https://www.linkedin.com/feed/update/fixture' }; },
    bluesky: async (_copy, link) => { assert.equal(link?.url, links.youtube); sends.push('bluesky'); return { uri: 'uri', url: 'https://bsky.app/profile/fixture/post/1' }; },
  };
  try {
    await store.savePodcastLinks(f.db, f.noteId, 0, links, 'human');
    await f.db.query(`UPDATE podcast_campaigns SET plan=$2,source_revision=1,approved_at=NOW() WHERE note_id=$1`, [f.noteId, JSON.stringify(prepared)]);
    let campaign = await store.getPodcastCampaign(f.db, f.noteId);
    await assert.rejects(publishPodcastPost(f.db, campaign, prepared.posts[0]!, send), /paused/);
    assert.deepEqual(sends, []);
    await f.db.query("UPDATE podcast_campaigns SET state='approved' WHERE note_id=$1", [f.noteId]);
    campaign = await store.getPodcastCampaign(f.db, f.noteId);
    await assert.rejects(publishPodcastPost(f.db, campaign, prepared.posts[1]!, send), /launch blog/);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    assert.deepEqual(sends, ['blog']);
    await assert.rejects(publishPodcastPost(f.db, campaign, prepared.posts[2]!, send), /earlier campaign post/);
    await publishPodcastPost(f.db, campaign, prepared.posts[1]!, send);
    await f.db.query("UPDATE podcast_campaigns SET state='paused',revision=revision+1 WHERE note_id=$1", [f.noteId]);
    await assert.rejects(publishPodcastPost(f.db, campaign, prepared.posts[2]!, send), /paused/);
    assert.deepEqual(sends, ['blog', 'linkedin']);
    await f.db.query("UPDATE podcast_campaigns SET state='approved' WHERE note_id=$1", [f.noteId]);
    campaign = await store.getPodcastCampaign(f.db, f.noteId);
    await publishPodcastPost(f.db, campaign, prepared.posts[2]!, send);
    assert.deepEqual(sends, ['blog', 'linkedin', 'bluesky']);
  } finally { await f.close(); }
});
test('approved follow-up campaigns deliver existing socials in order without republishing a launch blog', async () => {
  const f = await fixture();
  const sends: string[] = [];
  const prepared = plan();
  prepared.posts = [prepared.posts[2]!, prepared.posts[1]!];
  prepared.followUp = true;
  prepared.posts.forEach((post, index) => { post.scheduledAt = new Date(Date.now() - (10 - index) * 60_000).toISOString(); });
  const send: PublishingServices = {
    member: async () => ({ id: 'member', name: 'Richard' }),
    blog: async () => { throw new Error('A follow-up must not publish the launch blog.'); },
    read: async () => { throw new Error('A follow-up must not depend on a new launch receipt.'); },
    linkedin: async () => { sends.push('linkedin'); return { urn: 'urn', url: 'https://www.linkedin.com/feed/update/fixture' }; },
    bluesky: async (copy, link) => {
      assert.equal(copy, prepared.posts[0]!.copy);
      assert.equal(link?.url, links.youtube);
      sends.push('bluesky'); return { uri: 'uri', url: 'https://bsky.app/profile/fixture/post/1' };
    },
  };
  try {
    await store.savePodcastLinks(f.db, f.noteId, 0, links, 'human');
    await f.db.query(`UPDATE podcast_campaigns SET plan=$2,source_revision=1,state='approved',approved_at=NOW() WHERE note_id=$1`,
      [f.noteId, JSON.stringify(prepared)]);
    const campaign = await store.getPodcastCampaign(f.db, f.noteId);
    await assert.rejects(publishPodcastPost(f.db, campaign, prepared.posts[1]!, send), /earlier campaign post/);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[1]!, send);
    assert.deepEqual(sends, ['bluesky', 'linkedin']);
  } finally { await f.close(); }
});
test('local automatic delivery stays disabled', async () => {
  const f = await fixture();
  try {
    await tickPodcastCampaigns(f.db);
    assert.equal((await f.db.query('SELECT id FROM publishing_deliveries')).rowCount, 0);
  } finally { await f.close(); }
});
test('Scheduling projects approved campaign posts without creating jobs or altering approval and excludes confirmed posts', async () => {
  const f = await fixture();
  try {
    await store.savePodcastLinks(f.db, f.noteId, 0, links, 'human');
    const prepared = plan();
    await f.db.query('UPDATE podcast_campaigns SET plan=$2,source_revision=1 WHERE note_id=$1', [f.noteId, JSON.stringify(prepared)]);
    assert.deepEqual(await store.listPodcastSchedule(f.db), [], 'unapproved drafts must not enter Scheduling');
    await f.db.query("UPDATE podcast_campaigns SET state='approved',approved_at=NOW() WHERE note_id=$1", [f.noteId]);
    const before = (await f.db.query('SELECT * FROM podcast_campaigns WHERE note_id=$1', [f.noteId])).rows;
    const entries = await store.listPodcastSchedule(f.db);
    assert.equal(entries.length, 3);
    assert.ok(entries.every(entry => entry.noteId === f.noteId && entry.paused && !entry.campaignPaused));
    assert.ok(entries[2]!.copy.includes(links.youtube));
    assert.equal((await f.db.query('SELECT * FROM publishing_schedule')).rowCount, 0);
    assert.equal((await f.db.query('SELECT * FROM publishing_deliveries')).rowCount, 0);
    assert.deepEqual((await f.db.query('SELECT * FROM podcast_campaigns WHERE note_id=$1', [f.noteId])).rows, before);
    await f.db.query(`INSERT INTO publishing_deliveries(identity,destination,account,status,published_at)
      VALUES($1,'blog',$2,'sent',NOW())`, [contracts.podcastIdentity(f.noteId, prepared.posts[0]!.id), accounts.blog]);
    await f.db.query(`INSERT INTO publishing_deliveries(identity,destination,account,status,error)
      VALUES($1,'linkedin',$2,'unconfirmed','Check the provider receipt')`, [contracts.podcastIdentity(f.noteId, prepared.posts[1]!.id), accounts.linkedin]);
    await f.db.query("UPDATE podcast_campaigns SET state='paused' WHERE note_id=$1", [f.noteId]);
    const remaining = await store.listPodcastSchedule(f.db);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.every(entry => entry.campaignPaused));
    assert.equal(remaining[0]!.deliveryStatus, 'unconfirmed');
    assert.match(remaining[0]!.reason, /provider receipt/);
  } finally { await f.close(); }
});

const campaignSettings: PublishingFeed[] = [
  { id: 'blog-linkedin', enabled: true, revision: 1, policy: { days: [1, 2, 3, 4, 5], startHour: 8, endHour: 20, timezone: 'Europe/London', expiryHours: 168, guidance: '' } },
  { id: 'bluesky', enabled: true, revision: 1, policy: { days: [1, 2, 3, 4, 5], startHour: 8, endHour: 20, timezone: 'Europe/London', expiryHours: 48, guidance: '' } },
];
function repairDraft(): PodcastPlan {
  const result = plan();
  result.posts = result.posts.slice(2);
  result.posts[0]!.scheduledAt = '2026-10-27T09:30:00Z';
  result.followUp = true;
  result.window = { from: '2026-10-27', to: '2026-10-29' };
  return result;
}
test('preparation shortens only oversized copy with its real link budget, then reuses corrections for unchanged sources', async () => {
  const result = repairDraft();
  const post = result.posts[0]!;
  post.url = links.apple;
  post.copy = 'Keep permissions outside the model. '.repeat(12);
  const original = structuredClone(result);
  const goodCopy = 'Keep agent permissions outside the model, with independent checks.';
  let calls = 0;
  await repairPodcastCopy(result, null, links, async (_system, input) => {
    calls++;
    const budget = input as { copyAllowance: number; source: string };
    assert.equal(budget.copyAllowance, 300 - graphemeLength(`\n\n${links.apple}`));
    assert.equal(budget.source, original.posts[0]!.copy);
    return { copy: goodCopy };
  });
  assert.equal(calls, 1);
  assert.equal(post.copy, goodCopy);
  assert.equal(post.url, links.apple);
  assert.match(result.notes.join('\n'), /shortened.*Review/);
  assert.ok(post.sourceHash);
  const again = structuredClone(original);
  await repairPodcastCopy(again, result, links, async () => { throw new Error('Unchanged correction should be reused'); });
  assert.equal(again.posts[0]!.copy, goodCopy);
  const changed = structuredClone(original);
  changed.posts[0]!.copy += 'A different source qualification.';
  await repairPodcastCopy(changed, result, links, async () => { calls++; return { copy: 'Different source qualification retained.' }; });
  assert.equal(calls, 2);
  const changedLink = structuredClone(original);
  changedLink.posts[0]!.url = links.spotify;
  await repairPodcastCopy(changedLink, result, links, async () => { calls++; return { copy: goodCopy }; });
  assert.equal(calls, 3);
  await repairPodcastCopy(repairDraft(), null, links, async () => { throw new Error('Valid copy must not be rewritten'); });
});
test('legacy draft corrections are retained only for an unchanged source revision and unique matching post', async () => {
  const current = repairDraft();
  current.posts[0]!.copy = 'Long authored source. '.repeat(30);
  const previous = structuredClone(current);
  previous.posts[0]!.copy = 'Previously reviewed shorter copy.';
  await repairPodcastCopy(current, previous, links, async () => { throw new Error('Keep the saved manual correction'); }, true);
  assert.equal(current.posts[0]!.copy, previous.posts[0]!.copy);
  const changed = repairDraft();
  changed.posts[0]!.copy = 'Long authored source. '.repeat(30);
  let called = false;
  await repairPodcastCopy(changed, previous, links, async () => { called = true; return { copy: 'New source revision checked.' }; }, false);
  assert.equal(called, true);
});
test('invalid model repairs are bounded and cannot introduce URLs or silently truncate copy', async () => {
  const result = repairDraft();
  result.posts[0]!.copy = 'Original long source. '.repeat(30);
  let calls = 0;
  await assert.rejects(repairPodcastCopy(result, null, links, async () => {
    calls++;
    return { copy: calls === 1 ? 'x'.repeat(301) : 'Visit https://unapproved.invalid' };
  }), /could not shorten/);
  assert.equal(calls, 2);
  assert.equal(result.posts[0]!.copy, 'Original long source. '.repeat(30));
  await assert.rejects(repairPodcastCopy(result, null, links, async () => { throw new Error('Provider unavailable'); }), /Provider unavailable/);
});
test('LinkedIn shortening preserves all three listening links and does not send them to the copy rewriter', async () => {
  const result = plan();
  result.posts = [result.posts[1]!];
  const post = result.posts[0]!;
  const footer = '\n\n' + Object.entries(links).map(([platform, url]) =>
    `${contracts.EPISODE_LABELS[platform as keyof typeof links]}: ${url}`).join('\n');
  post.copy = 'Original discussion. '.repeat(200) + footer;
  await repairPodcastCopy(result, null, links, async (_system, input) => {
    const budget = input as { copyAllowance: number; source: string };
    assert.equal(budget.copyAllowance, 3000 - footer.length);
    assert.ok(!budget.source.includes('https://'));
    return { copy: 'The original discussion, shortened for LinkedIn.' };
  });
  assert.equal(post.copy, 'The original discussion, shortened for LinkedIn.' + footer);
});
test('expired draft times are re-proposed inside the chosen window with review time, order and spacing', () => {
  const result = repairDraft();
  result.posts.push({ ...result.posts[0]!, id: randomUUID(), scheduledAt: '2026-10-27T09:45:00Z' });
  const now = new Date('2026-10-27T10:34:36Z');
  proposePodcastTimes(result, campaignSettings, now);
  assert.equal(result.posts[0]!.scheduledAt, '2026-10-27T11:00:00.000Z');
  assert.equal(result.posts[1]!.scheduledAt, '2026-10-27T13:00:00.000Z');
  assert.deepEqual(contracts.podcastPlanIssues(result, now), []);
  assert.match(result.notes.join('\n'), /Approval is still required/);
  const snapshot = structuredClone(result);
  proposePodcastTimes(result, campaignSettings, now);
  assert.deepEqual(result, snapshot);
});
test('preparation moves to the next permitted day only within the explicitly selected window', () => {
  const result = repairDraft();
  proposePodcastTimes(result, campaignSettings, new Date('2026-10-27T19:50:00Z'));
  assert.equal(result.posts[0]!.scheduledAt, '2026-10-28T08:00:00.000Z');
  const expired = repairDraft();
  assert.throws(() => proposePodcastTimes(expired, campaignSettings, new Date('2026-10-29T19:50:00Z')), /no future slot/);
  assert.equal(expired.posts[0]!.scheduledAt, '2026-10-27T09:30:00Z');
  const noWindow = repairDraft();
  noWindow.window = null;
  assert.throws(() => proposePodcastTimes(noWindow, campaignSettings, new Date('2026-10-27T19:50:00Z')), /no future slot/);
});
test('future slots respect UK DST and per-account daily caps without altering valid authored times', () => {
  const summer = repairDraft();
  summer.window = { from: '2026-07-07', to: '2026-07-08' };
  summer.posts[0]!.scheduledAt = '2026-07-07T07:00:00Z';
  proposePodcastTimes(summer, campaignSettings, new Date('2026-07-07T06:00:00Z'));
  assert.equal(summer.posts[0]!.scheduledAt, '2026-07-07T07:00:00.000Z');
  const crowded = repairDraft();
  const first = crowded.posts[0]!;
  crowded.posts = Array.from({ length: 5 }, () => ({ ...first, id: randomUUID() }));
  proposePodcastTimes(crowded, campaignSettings, new Date('2026-10-27T06:00:00Z'));
  assert.equal(crowded.posts[4]!.scheduledAt?.slice(0, 10), '2026-10-28');
  assert.deepEqual(contracts.podcastPlanIssues(crowded, new Date('2026-10-27T06:00:00Z')), []);
});
