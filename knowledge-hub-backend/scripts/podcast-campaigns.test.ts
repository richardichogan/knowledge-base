import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishingFixture } from './publishing-fixture.js';
import type { PodcastPlan } from '../src/publishing/podcastCampaign.js';
import type { PublishingServices } from '../src/publishing/worker.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/podcast';
process.env.NODE_ENV = 'development';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/api/posts';
process.env.BLOG_POSTS_API_KEY = 'fixture';
process.env.LINKEDIN_ACCESS_TOKEN = 'fixture';
process.env.BLUESKY_IDENTIFIER = 'fixture.bsky.social';
process.env.BLUESKY_APP_PASSWORD = 'fixture';
const contracts = await import('../src/publishing/podcastCampaign.js');
const { materialisePodcastSelections, podcastSourceBlocks, validatePodcastArtworkSource, formatPodcastBlog } = await import('../src/publishing/podcastCampaignSource.js');
const { renderPodcastArtwork } = await import('../src/publishing/podcastCampaignAssets.js');
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
function sequencePost(kind: 'teaser' | 'launch' | 'quote' | 'fuller', scheduledAt: string): PodcastPlan['posts'][number] {
  const post = plan().posts[1]!;
  return { ...post, label: kind, scheduledAt, assetSpec: {
    kind, headline: 'Episode title', quote: null, speaker: null, timestamp: null, episodeNumber: null,
  } };
}
test('new campaigns stagger tied source times by stage, leaving legacy saved order unchanged', () => {
  const draft = plan();
  const at = '2099-01-05T08:00:00.000Z';
  draft.posts = [sequencePost('fuller', at), { ...draft.posts[0]!, scheduledAt: at },
    sequencePost('quote', at), sequencePost('launch', at), sequencePost('teaser', at)];
  const original = structuredClone(draft);
  draft.posts.sort(contracts.comparePodcastPosts);
  proposePodcastTimes(draft, new Date('2098-01-01'));
  draft.sequenceRequired = true;
  assert.deepEqual(draft.posts.map(post => post.destination === 'blog' ? 'blog' : post.assetSpec?.kind),
    ['teaser', 'launch', 'blog', 'fuller', 'quote']);
  assert.deepEqual(contracts.podcastSequenceIssues(draft), []);
  assert.ok(draft.posts.every(post => post.scheduledAt?.startsWith('2099-01-05')));
  assert.deepEqual(contracts.podcastSequenceIssues(original), [], 'legacy plans are not gated or changed');
  assert.equal(original.posts[0]?.assetSpec?.kind, 'fuller');
});
test('future stages can span days; inverted dates, equal stage times and missing milestones block approval without mutation', () => {
  const draft = plan();
  draft.sequenceRequired = true;
  draft.posts = [sequencePost('launch', '2099-01-05T09:00:00.000Z'),
    { ...draft.posts[0]!, scheduledAt: '2099-01-06T09:00:00.000Z' },
    sequencePost('quote', '2099-01-07T09:00:00.000Z'), sequencePost('fuller', '2099-01-07T09:00:00.000Z')];
  assert.deepEqual(contracts.podcastSequenceIssues(draft), []);
  draft.posts[2]!.scheduledAt = '2099-01-04T09:00:00.000Z';
  const original = structuredClone(draft);
  assert.match(contracts.podcastPlanIssues(draft).join('\n'), /quote: schedule it after launch/);
  assert.deepEqual(draft, original);
  draft.posts[2]!.scheduledAt = draft.posts[1]!.scheduledAt;
  assert.match(contracts.podcastSequenceIssues(draft).join('\n'), /quote: schedule it after Launch blog/);
  draft.posts = draft.posts.filter(post => post.assetSpec?.kind !== 'launch');
  assert.match(contracts.podcastSequenceIssues(draft).join('\n'), /Add the episode launch post/);
  draft.followUp = true;
  draft.posts = [sequencePost('quote', '2099-01-07T09:00:00.000Z')];
  assert.deepEqual(contracts.podcastSequenceIssues(draft), [], 'bounded follow-up windows do not require reissuing earlier posts');
});
test('future campaign checks include its separately prepared recording teaser', () => {
  const draft = plan();
  draft.sequenceRequired = true;
  draft.posts = [sequencePost('launch', '2099-01-05T08:00:00.000Z'),
    { ...draft.posts[0]!, scheduledAt: '2099-01-06T08:00:00.000Z' }];
  const teaser = { ...plan(), recordingTease: true, posts: [sequencePost('teaser', '2099-01-04T08:00:00.000Z')] };
  assert.deepEqual(contracts.podcastSequenceIssues(draft, teaser), []);
  teaser.posts[0]!.scheduledAt = '2099-01-07T08:00:00.000Z';
  assert.match(contracts.podcastPlanIssues(draft, new Date(), true, teaser).join('\n'), /launch: schedule it after teaser/);
});
test('blog formatting inserts H2s while preserving exact H1, paragraphs and inline links', async () => {
  const html = '<h1>Saved title</h1>\n<p>Exact introduction.</p>\n<p>Keep <strong>these words</strong>.</p>\n<p>Keep <a href="https://example.com">this link</a>.</p>';
  const formatted = await formatPodcastBlog(html, 'Saved title', async () => ({
    sections: [{ beforeParagraph: 1, heading: 'Ownership & authority' }, { beforeParagraph: 2, heading: 'Independent checks' }],
  }));
  assert.equal(formatted.replace(/<h2>[^<]+<\/h2>\n/g, ''), html);
  assert.equal((formatted.match(/<h1>/g) ?? []).length, 1);
  assert.equal((formatted.match(/<h2>/g) ?? []).length, 2);
  assert.match(formatted, /Ownership &amp; authority/);
  await assert.rejects(formatPodcastBlog(html, 'Saved title', async () => ({
    sections: [{ beforeParagraph: 1, heading: 'First' }, { beforeParagraph: 1, heading: 'Duplicate' }],
  })), /invalid section/);
});
test('independent review blocks pending, failed, malformed and changed drafts without gating legacy plans', () => {
  const draft = plan();
  assert.deepEqual(contracts.podcastPlanIssues(draft), []);
  contracts.requirePodcastCreationReview(draft);
  assert.match(contracts.podcastPlanIssues(draft).join('\n'), /pending/);
  draft.review = { ...draft.review!, status: 'fail', findings: [] };
  assert.match(contracts.podcastPlanIssues(draft).join('\n'), /failed/);
  draft.review = { ...draft.review, status: 'pass', reviewer: 'gpt-6-astra', checkedAt: new Date().toISOString() };
  assert.deepEqual(contracts.podcastPlanIssues(draft), []);
  draft.posts[1]!.copy += ' Changed.';
  assert.match(contracts.podcastPlanIssues(draft).join('\n'), /changed/);
  assert.deepEqual(contracts.podcastPlanIssues(draft, new Date(), false), []);
});
test('teaser same-day timing preserves review but a different day invalidates it', () => {
  const draft = plan();
  draft.recordingTease = true;
  const original = contracts.podcastReviewFingerprint(draft);
  draft.posts[0]!.scheduledAt = '2099-01-05T08:15:00Z';
  assert.equal(contracts.podcastReviewFingerprint(draft), original);
  draft.posts[0]!.scheduledAt = '2099-01-06T08:15:00Z';
  assert.notEqual(contracts.podcastReviewFingerprint(draft), original);
});
test('the application schedules saved calendar headings, not model-produced dates or timezone requirements', () => {
  const source = '### Monday, 2 November 2026, LinkedIn, personal account\n\nThe episode is out.\n\n### Tuesday, 3 November 2026\n\nAn authored weekday quote.';
  const selection = (from: number) => ({ from, to: from, startAfter: '', endBefore: '' });
  const clock = { timezone: 'Europe/London', time: '09:00' };
  const result = materialisePodcastSelections(source, {
    title: 'Episode', notes: [], excluded: [], posts: [
      { destination: 'linkedin', label: 'Launch', scheduledAt: 'Monday, 2 November 2026', copy: selection(1), blog: null },
      { destination: 'bluesky', label: 'Tuesday quote', scheduledAt: null, copy: selection(3), blog: null },
    ],
  }, { blog: clock, linkedin: clock, bluesky: clock });
  assert.deepEqual((result.posts as { scheduledAt: string; copy: string }[]).map(post => post.scheduledAt),
    ['2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z']);
  assert.equal((result.posts as { copy: string }[])[0]?.copy, 'The episode is out.');
  const summer = materialisePodcastSelections('### Monday, 29 June 2026, 09:15\n\nSource copy.', {
    posts: [{ destination: 'linkedin', label: 'Launch', copy: selection(1), blog: null }],
  }, { blog: clock, linkedin: clock, bluesky: clock });
  assert.equal((summer.posts as { scheduledAt: string }[])[0]?.scheduledAt, '2026-06-29T08:15:00.000Z');
});
test('quote artwork preserves source attribution and the approved speaker-specific colours and dimensions', () => {
  const quote = 'Who can create a digital worker?';
  const source = `Episode discussion\n\nQuote: “${quote}” — Richard (42:15)\n\nQuote: “Who checks its permissions?” — David (02:39)`;
  const spec = { kind: 'quote' as const, headline: 'Episode discussion', quote, speaker: 'Richard', timestamp: '42:15', episodeNumber: 46 };
  validatePodcastArtworkSource(source, spec);
  assert.throws(() => validatePodcastArtworkSource(source, { ...spec, speaker: 'David' }), /same saved source passage/);
  assert.throws(() => validatePodcastArtworkSource(source, { ...spec, timestamp: '02:39' }), /same saved source passage/);
  for (const [speaker, colour] of [['Richard', '#3ddbd9'], ['David', '#78a9ff'], ['Cyrus', '#be95ff']] as const) {
    const image = renderPodcastArtwork({ ...spec, speaker });
    assert.equal(image.width, 1080); assert.equal(image.height, 1080);
    assert.equal(image.png.readUInt32BE(16), 1080); assert.equal(image.png.readUInt32BE(20), 1080);
    assert.ok(image.svg.includes(`fill="${colour}"`));
    assert.ok(image.svg.includes('Who can create a digital worker?'));
    assert.ok(image.svg.includes('fill="#3ddbd9" font-size="22"'));
  }
  const launch = renderPodcastArtwork({ ...spec, kind: 'launch', quote: null, speaker: null, timestamp: null });
  assert.equal(launch.png.readUInt32BE(16), 1200); assert.equal(launch.png.readUInt32BE(20), 675);
});
test('new campaigns require reviewed images, while a complete recording teaser needs no episode URLs', () => {
  const campaign = plan();
  campaign.assetsRequired = true;
  assert.match(contracts.podcastPlanIssues(campaign).join('\n'), /image/i);
  const raw = rawPlan();
  raw.posts = raw.posts.filter(post => post.destination !== 'blog');
  const teaser = contracts.parsePodcastPlan(raw, { youtube: '', spotify: '', apple: '' }, accounts, 'Richard', { recordingTease: true, authored: true });
  assert.ok(teaser.posts.every(post => post.url === null));
  assert.deepEqual(contracts.podcastPlanIssues(teaser, new Date('2098-01-01')), []);
});
test('internal campaign section labels cannot become public artwork headlines', () => {
  for (const headline of ['11a Post-Recording Tease', 'Recording day, governance theme', 'Friday, 30 October 2026, LinkedIn']) {
    assert.throws(() => contracts.parsePodcastAssetSpec({ kind: 'teaser', headline, quote: null, speaker: null, timestamp: null }, 46), /audience-facing/);
  }
  assert.equal(contracts.parsePodcastAssetSpec({
    kind: 'teaser', headline: 'The Real Governance Problem Starts After the Agent Works', quote: null, speaker: null, timestamp: null,
  }, 46).headline, 'The Real Governance Problem Starts After the Agent Works');
});
async function fixture() {
  const f = await publishingFixture();
  await f.pg.exec(`CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active');
    CREATE FUNCTION note_list_metadata(value TEXT) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS 'SELECT value::jsonb';
    UPDATE publishing_feeds SET enabled=true,policy=policy || '{"startHour":0,"endHour":24}'::jsonb;`);
  await f.pg.exec(readFileSync(new URL('../src/db/migrations/113_podcast_campaigns.sql', import.meta.url), 'utf8'));
  const noteId = randomUUID();
  await f.db.query('INSERT INTO notes(id,content) VALUES($1,$2)', [noteId, JSON.stringify({
    title: 'Episode', contentType: 'podcast-show-notes', contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: Object.values(links).join('\n') }] }]),
  })]);
  return { ...f, noteId };
}
test('YouTube replacement refuses stale revisions, mismatched URLs and delivered campaigns without changing approved content', async () => {
  const f = await fixture();
  try {
    await store.savePodcastLinks(f.db, f.noteId, 0, links, 'human');
    await f.db.query("UPDATE podcast_campaigns SET plan=$2,source_revision=1,state='approved',approved_at=NOW() WHERE note_id=$1", [f.noteId, JSON.stringify(plan())]);
    const before = await store.getPodcastCampaign(f.db, f.noteId);
    const replacement = 'https://youtu.be/EZB61c67Zk0';
    await assert.rejects(store.replacePodcastYoutubeLink(f.db, f.noteId, 0, links.youtube, replacement, 'human'), /changed/);
    await assert.rejects(store.replacePodcastYoutubeLink(f.db, f.noteId, before.revision, 'https://youtu.be/zyxwvutsrqp', replacement, 'human'), /URL changed/);
    const post = before.plan!.posts[0]!;
    await f.db.query(`INSERT INTO publishing_deliveries(identity,destination,account,status,receipt,published_at)
      VALUES($1,'blog','blog.fixture.invalid','sent','{"url":"https://blog.fixture.invalid/episode"}',NOW())`, [`podcast:${f.noteId}:${post.id}`]);
    await assert.rejects(store.replacePodcastYoutubeLink(f.db, f.noteId, before.revision, links.youtube, replacement, 'human'), /Publication has started/);
    const after = await store.getPodcastCampaign(f.db, f.noteId);
    assert.equal(after.revision, before.revision);
    assert.equal(after.state, 'approved');
    assert.deepEqual(after.links, before.links);
    assert.deepEqual(after.plan, before.plan);
  } finally { await f.close(); }
});
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
test('only missing dates and destination validity need attention; dates, ordering and account capacity do not block podcast scheduling', () => {
  const result = plan();
  assert.deepEqual(contracts.podcastPlanIssues(result, new Date('2099-01-01T00:00:00Z')), []);
  const bad = structuredClone(result);
  bad.posts[0]!.scheduledAt = null;
  bad.posts[1]!.scheduledAt = '2020-01-01T09:00:00Z';
  assert.match(contracts.podcastPlanIssues(bad).join('\n'), /publication date/);
  assert.doesNotMatch(contracts.podcastPlanIssues(bad).join('\n'), /past/);
  assert.equal(bad.posts[1]!.scheduledAt, '2020-01-01T09:00:00Z');
  const crowded = structuredClone(result);
  crowded.posts.push({ ...crowded.posts[2]!, id: randomUUID(), scheduledAt: '2099-01-06T10:00:00Z' });
  assert.deepEqual(contracts.podcastPlanIssues(crowded, new Date('2099-01-01')), []);
  crowded.posts[2]!.scheduledAt = '2099-01-05T07:00:00Z';
  assert.deepEqual(contracts.podcastPlanIssues(crowded, new Date('2099-01-01')), []);
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
  test('public extraction removes scheduling headings and internal blog links without changing authored words', () => {
    const markdown = '### Monday, 2 November 2026, LinkedIn, personal account\n\nKeep this exact paragraph.\n\n## Blog\n\nListen to [the podcast](http://localhost:5173/projects?projectId=podcast) and [GitHub](/companies?companyId=github). Use [YouTube](https://youtu.be/abcdefghijk).';
    const range = (from: number, to = from) => ({ from, to, startAfter: '', endBefore: '' });
    const result = materialisePodcastSelections(markdown, { posts: [
      { destination: 'linkedin', copy: range(0, 1) },
      { destination: 'blog', blog: {
        title: range(2), slug: range(2), excerpt: range(1), summary: range(1), content: range(3),
        keyTakeaways: null, categories: null, tags: null,
      } },
    ] });
    const posts = result.posts as Array<{ copy: string; blog: { content: string } }>;
    assert.equal(posts[0]!.copy, 'Keep this exact paragraph.');
    assert.doesNotMatch(posts[1]!.blog.content, /localhost|companies\?|projects\?/);
    assert.match(posts[1]!.blog.content, /the podcast and GitHub/);
    assert.match(posts[1]!.blog.content, /href="https:\/\/youtu.be\/abcdefghijk"/);
  });
  assert.equal((result.posts as Array<{ copy: string }>)[0]!.copy, 'Listen to the podcast. Keep these words.\n\nNext paragraph.');
});
test('authored podcast copy is preserved and article style is advisory, while required-field checks remain', () => {
  const authored = { ...blog, postType: 'podcast', content: '<p>A game-changer — that was the phrase used.</p>' };
  assert.equal(parsePublishBody(authored, true).content, authored.content);
  assert.throws(() => parsePublishBody(authored), /banned AI/);
  assert.equal(parsePublishBody({ ...authored, postType: 'article' }, true).content, authored.content);
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
test('delivery enforces approval and pause but not post order, uses listening URLs, and never repeats a confirmed send', async () => {
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
    await publishPodcastPost(f.db, campaign, prepared.posts[1]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    assert.deepEqual(sends, ['linkedin', 'blog']);
    await publishPodcastPost(f.db, campaign, prepared.posts[1]!, send);
    await f.db.query("UPDATE podcast_campaigns SET state='paused',revision=revision+1 WHERE note_id=$1", [f.noteId]);
    await assert.rejects(publishPodcastPost(f.db, campaign, prepared.posts[2]!, send), /paused/);
    assert.deepEqual(sends, ['linkedin', 'blog']);
    await f.db.query("UPDATE podcast_campaigns SET state='approved' WHERE note_id=$1", [f.noteId]);
    campaign = await store.getPodcastCampaign(f.db, f.noteId);
    await publishPodcastPost(f.db, campaign, prepared.posts[2]!, send);
    assert.deepEqual(sends, ['linkedin', 'blog', 'bluesky']);
  } finally { await f.close(); }
});
test('approved follow-up campaigns deliver existing socials independently without republishing a launch blog', async () => {
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
    await publishPodcastPost(f.db, campaign, prepared.posts[1]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[0]!, send);
    await publishPodcastPost(f.db, campaign, prepared.posts[1]!, send);
    assert.deepEqual(sends, ['linkedin', 'bluesky']);
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
    const drafts = await store.listPodcastSchedule(f.db, true);
    assert.equal(drafts.length, 3, 'combined publishing includes every destination from draft campaigns');
    assert.ok(drafts.some(post => post.destination === 'linkedin'));
    assert.ok(drafts.every(post => post.status === 'Draft · awaiting approval' && post.origin === 'Podcast campaign'));
    assert.deepEqual(drafts[0]!.sources, [{ id: f.noteId, title: 'Show Notes', url: null }]);
    await f.db.query("UPDATE podcast_campaigns SET state='approved',approved_at=NOW() WHERE note_id=$1", [f.noteId]);
    const before = (await f.db.query('SELECT * FROM podcast_campaigns WHERE note_id=$1', [f.noteId])).rows;
    await f.db.query('UPDATE publishing_feeds SET enabled=false');
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
  assert.equal(post.sourceCopy, original.posts[0]!.copy);
  assert.equal(post.url, links.apple);
  assert.match(result.notes.join('\n'), /shortened.*Review/);
  assert.ok(post.sourceHash);
  const again = structuredClone(original);
  await repairPodcastCopy(again, result, links, async () => { throw new Error('Unchanged correction should be reused'); });
  assert.equal(again.posts[0]!.copy, goodCopy);
  assert.equal(again.posts[0]!.sourceCopy, original.posts[0]!.copy);
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
test('campaign Bluesky fitting preserves other channels, valid copy, artwork and dates', async () => {
  const draft = plan();
  draft.posts[2]!.copy = 'Preserve the original agent permissions and audit argument. '.repeat(7);
  const before = structuredClone(draft);
  await repairPodcastCopy({ ...draft, posts: draft.posts.filter(post => post.destination === 'bluesky') },
    null, links, async () => ({ copy: 'Keep agent permissions separate from model output and verify independent audit records.' }));
  assert.deepEqual(draft.posts.slice(0, 2), before.posts.slice(0, 2));
  assert.equal(draft.posts[2]!.scheduledAt, before.posts[2]!.scheduledAt);
  assert.deepEqual(draft.posts[2]!.assetSpec, before.posts[2]!.assetSpec);
  assert.equal(draft.posts[2]!.sourceCopy, before.posts[2]!.copy);
  assert.ok(graphemeLength(composeBlueskyText(draft.posts[2]!.copy, draft.posts[2]!.url)) <= 300);
});
test('fitting retries with measured drafts and does not constrain the decoder to cut words', async () => {
  const draft = repairDraft();
  draft.posts[0]!.copy = 'Keep the original argument and its qualification. '.repeat(10);
  let calls = 0;
  await repairPodcastCopy(draft, null, links, async (_system, input, _tokens, schema) => {
    const budget = input as { previousDraft: string | null; previousProblem: string; targetCharacters: number; copyAllowance: number };
    assert.ok(budget.targetCharacters < budget.copyAllowance);
    const copySchema = (schema.schema as { properties: { copy: Record<string, unknown> } }).properties.copy;
    assert.equal(copySchema.maxLength, undefined);
    calls++;
    if (calls === 1) return { copy: 'x'.repeat(400) };
    assert.equal(budget.previousDraft, 'x'.repeat(400));
    assert.match(budget.previousProblem, /measured 400/);
    return { copy: 'Keep the argument and its qualification intact.' };
  });
  assert.equal(calls, 2);
});
test('corrections rejected by independent review are not reused', async () => {
  const draft = repairDraft();
  draft.posts[0]!.copy = 'An authored complete argument. '.repeat(20);
  const previous = structuredClone(draft);
  await repairPodcastCopy(previous, null, links, async () => ({ copy: 'A broken partial' }));
  contracts.requirePodcastCreationReview(previous);
  previous.review!.status = 'fail';
  let calls = 0;
  await repairPodcastCopy(draft, previous, links, async () => { calls++; return { copy: 'A complete argument, with its qualification preserved.' }; });
  assert.equal(calls, 1);
  assert.equal(draft.posts[0]!.copy, 'A complete argument, with its qualification preserved.');
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
  }), /copy adaptation failed/);
  assert.equal(calls, 4);
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
test('normal campaign dates stay authored even when preparation happens later', () => {
  const result = repairDraft();
  result.posts.push({ ...result.posts[0]!, id: randomUUID(), scheduledAt: '2026-10-27T09:45:00Z' });
  const now = new Date('2026-10-27T10:34:36Z');
  proposePodcastTimes(result, now);
  assert.equal(result.posts[0]!.scheduledAt, '2026-10-27T09:30:00Z');
  assert.equal(result.posts[1]!.scheduledAt, '2026-10-27T10:00:00.000Z');
  assert.deepEqual(contracts.podcastPlanIssues(result, now), []);
  assert.doesNotMatch(result.notes.join('\n'), /assigned the next future time/);
  const snapshot = structuredClone(result);
  proposePodcastTimes(result, now);
  assert.deepEqual(result, snapshot);
});
test('the recording teaser alone can run Friday, Saturday or Sunday before Monday release without booking restrictions', () => {
  for (const day of ['2026-10-30', '2026-10-31', '2026-11-01']) {
    const result = repairDraft();
    result.recordingTease = true;
    result.posts[0]!.scheduledAt = '2026-10-30T09:00:00Z';
    proposePodcastTimes(result, new Date(`${day}T12:00:00Z`));
    assert.equal(result.posts[0]!.scheduledAt, `${day}T12:15:00.000Z`);
    assert.match(result.notes.join('\n'), /recording teaser/);
  }
});
test('future source times remain exact across UK DST and crowded same-account schedules', () => {
  const summer = repairDraft();
  summer.window = { from: '2026-07-07', to: '2026-07-08' };
  summer.posts[0]!.scheduledAt = '2026-07-07T07:00:00Z';
  proposePodcastTimes(summer, new Date('2026-07-07T06:00:00Z'));
  assert.equal(summer.posts[0]!.scheduledAt, '2026-07-07T07:00:00Z');
  const crowded = repairDraft();
  const first = crowded.posts[0]!;
  crowded.posts = Array.from({ length: 5 }, () => ({ ...first, id: randomUUID() }));
  proposePodcastTimes(crowded, new Date('2026-10-27T06:00:00Z'));
  assert.deepEqual(crowded.posts.map(post => Date.parse(post.scheduledAt!)),
    Array.from({ length: 5 }, (_, index) => Date.parse('2026-10-27T09:30:00Z') + index * 30 * 60_000));
  assert.deepEqual(contracts.podcastPlanIssues(crowded, new Date('2026-10-27T06:00:00Z')), []);
});
