import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { articleProse } from '../src/utils/articleReading.js';
import { getSchedule } from '../src/ai/contentSchedule.js';
import { acknowledgePodcastPrep, claimPodcastPrep, generatePodcastPrep, getPodcastPrepStatus, podcastPrepDue, podcastRecordingDate } from '../src/ai/podcastPrep.js';
import { isFreshEvidence, isMicrosoftRelevant, mapPodcastResearch, parsePodcastProposal, rankPodcastCandidates, selectPodcastSources, readPodcastSource, isNewsItem, showLaneScore, tavilyNewsTopic, renderPodcastBrief, selectEpisodeDocuments, type PodcastEvidence, type PodcastTopic, type ShowEpisode } from '../src/ai/podcastPrepResearch.js';

const now = new Date('2026-10-15T06:00:00Z');
const recording = '2026-10-16';
const evidence: PodcastEvidence[] = Array.from({ length: 6 }, (_, i) => ({
  id: `source-${i + 1}`, title: `Announcement ${i + 1}`, date: '2026-10-14', text: 'Verified source text',
  url: `https://example.com/news/${i + 1}`,
}));
const topics: PodcastTopic[] = evidence.map((e, i) => ({
  title: `Enterprise topic ${i + 1}`, synopsis: 'What happened.', angle: 'An enterprise decision.',
  relevance: ['Changes procurement.', 'Changes adoption.'], sourceIds: [e.id],
  showThreadId: i === 0 ? 'show-1' : null, showThread: i === 0 ? 'Agents need an HR-style owner; the new release makes that owner mandatory.' : '',
  points: Array.from({ length: i === 0 ? 6 : i === 1 ? 4 : 2 }, () => ({ text: 'Evidence-backed point.', evidenceIds: [e.id] })),
  priorCoverage: 'EP44: earlier discussion.', change: 'A new dated announcement changes the earlier conclusion.',
  handoff: 'Ask David about architectural consequences.', conclusion: 'Check the operational model.', question: 'Who owns the decision?',
}));
const archive: ShowEpisode[] = [{ id: 'show-1', title: 'What Would HR Do With an AI Agent?', date: '2026-10-06', thesis: 'Treat agents like staff.' }];
const prepared = { proposal: { topics, warnings: [] }, evidence, warnings: [], archive };

async function fixture(): Promise<{ memory: PGlite; db: Pool }> {
  const memory = new PGlite();
  await memory.exec(`
    CREATE TABLE content_schedule(format text PRIMARY KEY,next_date date,interval_days int,note text,updated_at timestamptz DEFAULT NOW());
    INSERT INTO content_schedule VALUES('podcast','2026-10-16',14,NULL,NOW());
    CREATE TABLE content_items(id uuid,title text,body text,source text,metadata jsonb,published_at timestamptz,indexed_at timestamptz);
    CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY,title text,persona text,pinned boolean,updated_at timestamptz DEFAULT NOW());
    CREATE TABLE ai_chat_messages(id serial PRIMARY KEY,session_id uuid,role text,content text,persona text,sources text[],context_used jsonb,next_steps text[],created_at timestamptz DEFAULT NOW());
    CREATE TABLE chat_outputs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid,title text,kind text,format text,updated_at timestamptz DEFAULT NOW());
    CREATE TABLE chat_output_versions(output_id uuid,version int,content text,author text,note text,created_at timestamptz DEFAULT NOW(),PRIMARY KEY(output_id,version));`);
  await memory.exec(await readFile(new URL('../src/db/migrations/077_podcast_prep.sql', import.meta.url), 'utf8'));
  const query = (sql: string, values?: unknown[]) => memory.query(sql, values);
  const client = { query, release: () => undefined };
  const db = { query, connect: async () => client } as unknown as Pool;
  return { memory, db };
}

test('Thursday preparation is recording-aware and DST-safe, with bounded daytime catch-up', () => {
  assert.equal(podcastPrepDue(recording, now), true);
  assert.equal(podcastPrepDue(recording, new Date('2026-10-15T05:59:00Z')), false);
  assert.equal(podcastPrepDue('2026-10-23', now), false);
  assert.equal(podcastPrepDue('2026-10-19', now), false);
  assert.equal(podcastPrepDue(recording, new Date('2026-10-15T17:00:00Z')), false);
  assert.equal(podcastPrepDue('2026-10-30', new Date('2026-10-29T07:00:00Z')), true);
  assert.equal(podcastPrepDue('2026-10-30', new Date('2026-10-29T06:59:00Z')), false);
  assert.equal(podcastPrepDue(recording, new Date('2026-10-16T06:00:00Z')), false);
});

test('an explicitly documented Monday release resolves to Friday without rewriting the schedule; calendar recording dates take precedence', () => {
  const entry = { format: 'podcast' as const, next: '2026-10-19', daysAway: 4, intervalDays: 14,
    note: 'Recorded on Fridays, released the following Monday; alternates weeks with the newsletter' };
  assert.equal(podcastRecordingDate(entry, now), recording);
  assert.equal(podcastRecordingDate({ ...entry, note: null }, now), '2026-10-19');
  assert.equal(podcastRecordingDate({ ...entry, dateSource: 'calendar' }, now), '2026-10-19');
  assert.equal(podcastRecordingDate(entry, new Date('2026-10-17T06:00Z')), '2026-10-30');
  assert.equal(podcastRecordingDate({ ...entry, cancelledDates: [recording] }, now), '2026-10-30');
  assert.equal(entry.next, '2026-10-19');
});

test('six ranked topics have progressively lighter depth, dated links, reserves, and prior coverage', () => {
  const parsed = parsePodcastProposal(JSON.stringify({ topics, warnings: [] }), evidence, archive);
  assert.equal(parsed.topics.length, 6);
  assert.deepEqual(parsed.topics.slice(0, 3).map((t) => t.points.length), [6, 4, 2]);
  const markdown = renderPodcastBrief(recording, { ...prepared, proposal: parsed }, now);
  assert.match(markdown, /Recommended running order/);
  assert.match(markdown, /https:\/\/example.com\/news\/1/);
  assert.match(markdown, /EP44/);
  assert.match(markdown, /\(reserve\)/);
  assert.match(markdown, /Continues Cloudy thread:\*\* "What Would HR Do With an AI Agent\?" \(2026-10-06\)/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [{ ...topics[0], sourceIds: ['invented'] }], warnings: [] }), evidence, archive), /unknown news source/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [topics[0], topics[0]], warnings: [] }), evidence, archive), /distinct/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [{ ...topics[0], points: [] }], warnings: [] }), evidence, archive), /depth/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [{ ...topics[0], points: [{ text: 'Invented point', evidenceIds: [] }] }], warnings: [] }), evidence, archive), /lacks/);
  assert.match(parsePodcastProposal(JSON.stringify({ topics: [], warnings: [] }), []).warnings[0]!, /incomplete/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [{ ...topics[0], showThreadId: '' }], warnings: [] }), evidence, archive), /lead topic must continue/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [{ ...topics[0], showThreadId: 'show-99' }], warnings: [] }), evidence, archive), /unknown Cloudy episode/);
  assert.throws(() => parsePodcastProposal(JSON.stringify({ topics: [{ ...topics[0], showThread: '' }], warnings: [] }), evidence, archive), /empty field/);
  assert.equal(isFreshEvidence('2026-10-14', new Date('2026-10-06'), now), true);
  assert.equal(isFreshEvidence('2026-10-01', new Date('2026-10-06'), now), false);
  assert.equal(isFreshEvidence('unknown', new Date('2026-10-06'), now), false);
  assert.equal(isFreshEvidence('2026-10-17', new Date('2026-10-06'), now), false);
});

test('episode selection groups transcript/show notes, keeps complete bodies, and does not let a recently edited older episode displace newer ones', () => {
  const rows = ['Cloudy: EP42', 'Cloudy: Episode 44: Show Notes', 'Cloudy: Episode 44 | Transcript', 'CLOUDY: EP43 | Discussion'].map((title, i) => ({
    id: String(i), title, body: 'x'.repeat(42_853), date: '2026-10-06', url: null, metadata: {},
  }));
  const selected = selectEpisodeDocuments(rows);
  assert.deepEqual([...selected.keys()], ['44', '43']);
  assert.equal(selected.get('44')?.length, 2);
  assert.equal(selected.get('44')?.[1]?.body?.length, 42_853);
});

test('schedule reads are non-mutating, calendar overrides win, and explicit cancellations do not prepare the cancelled recording', async () => {
  const { memory, db } = await fixture();
  try {
    await memory.exec("UPDATE content_schedule SET next_date='2026-10-02'");
    const schedule = await getSchedule(db, now, false);
    assert.equal(schedule.podcast.next, recording);
    assert.equal((await memory.query<{ date: string }>("SELECT to_char(next_date,'YYYY-MM-DD') AS date FROM content_schedule")).rows[0]?.date, '2026-10-02');
    await memory.exec(`INSERT INTO content_items VALUES(gen_random_uuid(),'Podcast Record',NULL,'graph-calendar','{"isCancelled":true}','2026-10-16T09:00Z',NOW())`);
    assert.equal((await getSchedule(db, now, false)).podcast.next, '2026-10-30');
    await memory.exec(`INSERT INTO content_items VALUES(gen_random_uuid(),'Podcast Record',NULL,'graph-calendar','{}','2026-10-23T09:00Z',NOW())`);
    assert.equal((await getSchedule(db, now, false)).podcast.next, '2026-10-23');
  } finally { await memory.close(); }
});

test('once the recording-day "Podcast Record" event has ended, the next recording is due and today is no longer current', async () => {
  const { memory, db } = await fixture();
  try {
    await memory.exec(`INSERT INTO content_items VALUES(gen_random_uuid(),'Podcast Record',NULL,'graph-calendar',
      '{"start":"2026-10-16T09:00:00.000Z","end":"2026-10-16T10:00:00.000Z"}','2026-10-16T09:00Z',NOW())`);
    assert.equal((await getSchedule(db, new Date('2026-10-16T09:30:00Z'), false)).podcast.next, recording);
    const after = await getSchedule(db, new Date('2026-10-16T10:05:00Z'), false);
    assert.equal(after.podcast.next, '2026-10-30');
    assert.deepEqual(after.podcast.recordedDates, [recording]);
    assert.equal(podcastRecordingDate({ ...after.podcast, next: '2026-10-19', dateSource: 'schedule',
      note: 'Recorded on Fridays, released the following Monday' }, new Date('2026-10-16T10:05:00Z')), '2026-10-30');
    assert.equal((await getPodcastPrepStatus(db, new Date('2026-10-16T10:05:00Z'))).nextRecording, '2026-10-30');
  } finally { await memory.close(); }
});

test('leases prevent duplicate jobs, honour retry cooldown, recover interruption, and stop after three automatic attempts', async () => {
  const { memory, db } = await fixture();
  try {
    assert.ok(await claimPodcastPrep(db, recording, false));
    assert.equal(await claimPodcastPrep(db, recording, false), null);
    assert.equal(await claimPodcastPrep(db, recording, true), null);
    await memory.exec("UPDATE podcast_prep_runs SET status='failed',retry_at=NOW()+interval '15 minutes'");
    assert.equal(await claimPodcastPrep(db, recording, false), null);
    await memory.exec("UPDATE podcast_prep_runs SET retry_at=NOW()-interval '1 minute'");
    assert.ok(await claimPodcastPrep(db, recording, false));
    await memory.exec("UPDATE podcast_prep_runs SET started_at=NOW()-interval '31 minutes'");
    assert.equal((await getPodcastPrepStatus(db, now)).run?.status, 'failed');
    assert.ok(await claimPodcastPrep(db, recording, false));
    await memory.exec("UPDATE podcast_prep_runs SET started_at=NOW()-interval '31 minutes'");
    assert.equal(await claimPodcastPrep(db, recording, false), null);
    assert.equal((await getPodcastPrepStatus(db, now)).run?.status, 'failed');
    assert.ok(await claimPodcastPrep(db, recording, true));
  } finally { await memory.close(); }
});

test('generation posts the brief into the conversation, acknowledgement is version-specific, refresh reads the conversation', async () => {
  const { memory, db } = await fixture();
  try {
    const status = await generatePodcastPrep(db, true, now, false, async () => prepared);
    assert.equal(status.run?.status, 'ready');
    const run = status.run!;
    assert.ok(run.generatedAt);
    assert.equal(run.outputId, null);
    assert.equal((await memory.query('SELECT * FROM chat_outputs')).rows.length, 0);
    const briefs = await memory.query("SELECT content FROM ai_chat_messages WHERE role='assistant'");
    assert.equal(briefs.rows.length, 1);
    assert.match(String(briefs.rows[0]?.content), /# Podcast preparation: 2026-10-16/);
    await acknowledgePodcastPrep(db, recording, run.generatedAt!);
    assert.ok((await getPodcastPrepStatus(db, now)).run?.acknowledgedAt);
    await assert.rejects(acknowledgePodcastPrep(db, recording, '2000-01-01'), /not found/);
    await memory.query(`INSERT INTO ai_chat_messages(session_id,role,content) VALUES($1,'user','Prefer commercial implications')`, [run.sessionId]);
    let received = '';
    const refreshed = await generatePodcastPrep(db, true, now, false, async (_db, _date, previous) => { received = previous; return prepared; });
    assert.match(received, /# Podcast preparation: 2026-10-16/);
    assert.match(received, /Prefer commercial implications/);
    assert.equal(refreshed.run?.sessionId, run.sessionId);
    assert.equal(refreshed.run?.acknowledgedAt, null);
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='assistant'")).rows.length, 2);
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='user'")).rows.length, 1);
    assert.equal((await memory.query('SELECT persona FROM ai_chat_sessions')).rows[0]?.persona, 'podcast_prep');
    await generatePodcastPrep(db, false, now, false, async () => { throw new Error('Already prepared: must not rerun'); });
  } finally { await memory.close(); }
});

test('failed research is visible and rescheduled recordings cannot publish into the wrong brief', async () => {
  const { memory, db } = await fixture();
  try {
    await assert.rejects(generatePodcastPrep(db, true, now, false, async () => { throw new Error('Research unavailable'); }), /Research unavailable/);
    assert.equal((await getPodcastPrepStatus(db, now)).run?.status, 'failed');
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='assistant'")).rows.length, 0);
    await assert.rejects(generatePodcastPrep(db, true, now, false, async () => {
      await memory.exec("UPDATE content_schedule SET next_date='2026-10-23'");
      return prepared;
    }), /date changed/);
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='assistant'")).rows.length, 0);
    await memory.exec("UPDATE content_schedule SET next_date='2026-10-16'");
    await assert.rejects(generatePodcastPrep(db, true, now, false, async () => {
      await memory.exec("UPDATE podcast_prep_runs SET started_at=NOW()-interval '31 minutes'");
      return prepared;
    }), /lease expired/);
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='assistant'")).rows.length, 0);
    await memory.exec("UPDATE content_schedule SET next_date='2026-10-19'");
    assert.match((await getPodcastPrepStatus(db, now)).scheduleWarning!, /not a Friday/);
  } finally { await memory.close(); }
});

test('podcast research ranks Cloudy-lane Microsoft AI news first and drops off-lane Microsoft news', () => {
  const generic = { title: 'Startup raises funding for AI agents', url: 'https://example.com/a', date: '2026-10-14T10:00:00Z', text: 'General industry news' };
  const msText = { title: 'New enterprise agent pricing', url: 'https://example.com/b', date: '2026-10-12T10:00:00Z', text: 'Microsoft 365 Copilot licensing changes' };
  const msHost = { title: 'Announcing new capabilities', url: 'https://azure.microsoft.com/blog/x', date: '2026-10-11T10:00:00Z', text: '' };
  const chips = { title: 'Powering Azure infrastructure from grid to chip', url: 'https://azure.microsoft.com/blog/y', date: '2026-10-15T10:00:00Z', text: 'Datacentre power and racks.' };
  const governance = { title: 'Microsoft publishes agent accountability guidance', url: 'https://blogs.microsoft.com/z', date: '2026-10-08T10:00:00Z', text: 'Copilot agents need governance, oversight and audit.' };
  assert.equal(isMicrosoftRelevant(generic), false);
  assert.equal(isMicrosoftRelevant(msText), true);
  assert.equal(isMicrosoftRelevant(msHost), true);
  assert.equal(showLaneScore(chips), 0);
  assert.equal(showLaneScore(msHost), 0);
  assert.ok(showLaneScore(governance) > showLaneScore(generic));
  assert.equal(isNewsItem({ title: 'AZ-900 Microsoft Azure Fundamentals', url: 'https://www.spoclearn.com/us/course/az-900-training' }), false);
  assert.equal(isNewsItem({ title: 'GitHub Copilot app for Beginners', url: 'https://github.blog/ai/copilot-beginners' }), false);
  assert.equal(isNewsItem({ title: 'Agents overview', url: 'https://learn.microsoft.com/en-us/copilot/agents' }), false);
  assert.equal(isNewsItem(governance), true);
  assert.deepEqual(rankPodcastCandidates([generic, chips, msHost, msText, governance]).map((c) => c.url),
    [governance.url, msText.url, generic.url, chips.url, msHost.url]);
  const ranked = { ...msText, url: 'https://example.com/discover', discoverRank: 82.4 };
  const lowerRanked = { ...governance, url: 'https://example.com/discover-low', discoverRank: 40 };
  assert.deepEqual(rankPodcastCandidates([governance, lowerRanked, generic, ranked]).map((c) => c.url),
    [ranked.url, lowerRanked.url, governance.url, generic.url], 'Ranked Discover articles lead in-lane Microsoft web hits, highest rank first');
  const brief = renderPodcastBrief(recording, { ...prepared, evidence: evidence.map((e, i) => i === 0 ? { ...e, discoverRank: 82.4 } : e) }, now);
  assert.match(brief, /Discover rank 82\.4/);
  assert.match(brief, /web news search/);
});

test('podcast sources mix Discover and web news search instead of Discover filling every slot', () => {
  const item = (url: string, discoverRank?: number) => ({ title: 'Microsoft Copilot governance update', url, date: '2026-10-14', text: '',
    ...(discoverRank !== undefined ? { discoverRank } : {}) });
  const discover = Array.from({ length: 20 }, (_, i) => item(`https://example.com/d/${i}`, 90 - i));
  const web = Array.from({ length: 3 }, (_, i) => item(`https://example.com/w/${i}`));
  const dupe = item('https://example.com/d/5');
  const picked = selectPodcastSources([...discover, ...web, dupe], 8, () => true);
  assert.equal(picked.length, 8);
  assert.deepEqual(picked.filter((c) => c.discoverRank === undefined).map((c) => c.url), web.map((w) => w.url), 'every web source is kept');
  assert.deepEqual(picked.filter((c) => c.discoverRank !== undefined).map((c) => c.discoverRank), [90, 89, 88, 87, 86], 'Discover fills the rest in rank order');
  assert.equal(selectPodcastSources([dupe, discover[5]!], 8, () => true)[0]!.discoverRank, 85, 'a URL found by both keeps its Discover rank');
  assert.equal(selectPodcastSources(web, 8, () => true).length, 3, 'web alone still works');
});

test('article reader uses the longest article region, not a byline card', () => {
  const body = 'Microsoft announced new Copilot licensing. '.repeat(40);
  const html = `<html><body><article><h1>Title</h1></article><main><article><p>${body}</p></article></main></body></html>`;
  assert.ok(articleProse(html).length >= 800);
  assert.ok(articleProse(html).includes('Copilot licensing'));
});

test('Tavily news topic is only sent when the schema accepts it', () => {
  assert.equal(tavilyNewsTopic({ enum: ['general'] }), undefined);
  assert.equal(tavilyNewsTopic({ enum: ['general', 'news'] }), 'news');
  assert.equal(tavilyNewsTopic({ type: 'string' }), undefined);
  assert.equal(tavilyNewsTopic(undefined), undefined);
});

test('Tech Community reads the requested full article from page data, never related articles or descriptions', () => {
  const body = '<p>Microsoft Entra identity governance announcement.</p>'.repeat(30);
  const data = { props: { pageProps: { apolloState: {
    'BlogTopicMessage:message:4556460': { body },
    'BlogTopicMessage:message:999': { body: '<p>Unrelated article</p>'.repeat(100) },
  } } } };
  const html = `<html><head><script type="application/ld+json">{"description":"Summary only"}</script></head><body>Loading...
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
  const result = articleProse(html, 'https://techcommunity.microsoft.com/blog/entra/example/4556460');
  assert.ok(result.length > 800);
  assert.match(result, /identity governance announcement/);
  assert.doesNotMatch(result, /Unrelated|Loading|Summary only/);
  assert.throws(() => articleProse(html, 'https://techcommunity.microsoft.com/blog/entra/missing/123'), /requested article body/);
});

test('Tech Community pages without embedded article data fail instead of extracting generic page text', () => {
  const html = `<html><body><main><article>${'<p>Related Microsoft article teaser and navigation text.</p>'.repeat(40)}</article></main></body></html>`;
  assert.throws(() => articleProse(html, 'https://techcommunity.microsoft.com/blog/entra/example/4556460'), /__NEXT_DATA__/);
  assert.throws(() => articleProse(html, 'https://techcommunity.microsoft.com/blog/entra/no-id'), /__NEXT_DATA__/);
  const data = `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"apolloState":{}}}}</script>`;
  assert.throws(() => articleProse(data, 'https://techcommunity.microsoft.com/blog/entra/no-id'), /article ID/);
});

test('research workers preserve order, run at most three requests and propagate source failures', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapPodcastResearch([30, 5, 10, 1, 2], async (delay) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return delay;
  });
  assert.deepEqual(result, [30, 5, 10, 1, 2]);
  assert.equal(peak, 3);
  await assert.rejects(mapPodcastResearch([1, 2], async () => { throw new Error('Source returned HTTP 403'); }), /HTTP 403/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(mapPodcastResearch([1, 2, 3, 4], async () => {
    calls++;
    controller.abort(new Error('Preparation deadline'));
    return 1;
  }, controller.signal), /deadline/);
  assert.equal(calls, 1);
});

test('preparation deadline fails the run and never saves a late result or an empty success', async () => {
  const { memory, db } = await fixture();
  try {
    let finish!: (value: typeof prepared) => void;
    const delayed = new Promise<typeof prepared>((resolve) => { finish = resolve; });
    await assert.rejects(generatePodcastPrep(db, true, now, false, () => delayed, 20), /deadline/);
    assert.equal((await getPodcastPrepStatus(db, now)).run?.status, 'failed');
    finish(prepared);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='assistant'")).rows.length, 0);
    await assert.rejects(generatePodcastPrep(db, true, now, false, async () => ({
      proposal: { topics: [], warnings: [] }, evidence: [], warnings: [],
    })), /no evidenced topics/);
    assert.equal((await memory.query("SELECT * FROM ai_chat_messages WHERE role='assistant'")).rows.length, 0);
  } finally { await memory.close(); }
});

test('podcast source reads surface HTTP and extraction failures instead of returning summaries', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('Forbidden', { status: 403 }));
  try {
    await assert.rejects(readPodcastSource('https://microsoft.com/article'), /https:\/\/microsoft.com\/article: Page returned HTTP 403/);
    fetch.mock.mockImplementation(async () => new Response('<html><main>Just a title</main></html>', { headers: { 'content-type': 'text/html' } }));
    await assert.rejects(readPodcastSource('https://microsoft.com/article'), /Article extraction returned 12 characters/);
    const body = 'Microsoft Copilot enterprise governance. '.repeat(30);
    fetch.mock.mockImplementation(async () => new Response(`<html><article><p>${body}</p></article></html>`, { headers: { 'content-type': 'text/html' } }));
    assert.equal(await readPodcastSource('https://microsoft.com/article'), body.trim());
  } finally { fetch.mock.restore(); }
});
