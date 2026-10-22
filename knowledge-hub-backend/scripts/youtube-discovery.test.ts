import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { channelIdFromPage, resolveDiscoveryFeed, videoFromPage, youtubeUrl, youtubeVideoId } from '../src/integrations/discovery/youtube.js';
import { captionText, playerFromPage, retrieveCaptions } from '../src/integrations/discovery/youtubeCaptions.js';
import { collectYouTubeEvidence, relatedYouTubeArticles, enrichPendingYouTubeVideos } from '../src/integrations/discovery/youtubeEvidence.js';
import { runDeepDive } from '../src/ai/contentPick.js';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { Pool } from 'pg';

test('YouTube URLs resolve canonical channels and video formats without accepting lookalike hosts', async () => {
  const id = 'UC0m-80FnNY2Qb7obvTL_2fA';
  assert.equal(await resolveDiscoveryFeed(`https://www.youtube.com/channel/${id}/videos`), `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  assert.equal(await resolveDiscoveryFeed('https://example.org/feed.xml'), 'https://example.org/feed.xml');
  for (const url of ['https://youtu.be/O9nqK23LRbA?t=5', 'https://www.youtube.com/watch?v=O9nqK23LRbA&list=foo', 'https://youtube.com/shorts/O9nqK23LRbA', 'https://youtube.com/live/O9nqK23LRbA']) {
    assert.equal(youtubeVideoId(url), 'O9nqK23LRbA');
    await assert.rejects(resolveDiscoveryFeed(url), /Add video/);
  }
  assert.equal(youtubeVideoId('https://youtube.com.evil.test/watch?v=O9nqK23LRbA'), null);
  assert.equal(youtubeVideoId('https://youtube.com/watch?v=invalid'), null);
  for (const url of ['http://youtube.com/@test', 'https://user:pass@youtube.com/@test', 'https://youtube.com:8443/@test']) assert.throws(() => youtubeUrl(url));
  await assert.rejects(resolveDiscoveryFeed('https://youtube.com/results?search_query=test'), /channel URL/);
  assert.equal(channelIdFromPage(`{"channelMetadataRenderer":{"title":"Azure","externalId":"${id}"}}`), id);
  assert.throws(() => channelIdFromPage('consent required'), /Could not resolve/);
});

test('Player parsing handles semicolons/braces in strings and captions retain real timing', () => {
  const player = { videoDetails: { title: 'Braces }; inside a string "quoted"' }, captions: {} };
  assert.deepEqual(playerFromPage(`var ytInitialPlayerResponse = ${JSON.stringify(player)}; next();`), player);
  const result = captionText(JSON.stringify({ events: [{ tStartMs: 1250, segs: [{ utf8: 'Project ' }, { utf8: 'Perception &amp; agents' }] }] }));
  assert.equal(result.text, '[1.3s] Project Perception & agents');
  assert.equal(result.truncated, false);
  assert.equal(captionText('<transcript><text start="2.4">Human approval &amp; review</text></transcript>').text, '[2.4s] Human approval & review');
  assert.throws(() => captionText(''), /no text/);
  assert.throws(() => captionText('{"events":[]}'), /empty/);
});

test('Public caption attempt is bounded, prefers authored English and rejects unsafe addresses', async () => {
  const track = (baseUrl: string, languageCode: string, kind?: string) => ({ baseUrl, languageCode, kind });
  const data = (tracks: unknown[]) => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
  let reads = 0;
  const reader = async (url: string): Promise<string> => {
    reads++;
    assert.equal(new URL(url).searchParams.get('fmt'), 'json3');
    assert.equal(new URL(url).searchParams.get('lang'), 'en');
    return '{"events":[{"tStartMs":0,"segs":[{"utf8":"Approval remains."}]}]}';
  };
  const captions = await retrieveCaptions(data([
    track('https://www.youtube.com/api/timedtext?lang=de', 'de'),
    track('https://www.youtube.com/api/timedtext?lang=en&kind=asr', 'en', 'asr'),
    track('https://www.youtube.com/api/timedtext?lang=en', 'en'),
  ]), reader);
  assert.equal(captions.status, 'retrieved');
  assert.equal(captions.automatic, false);
  assert.equal(reads, 1);
  assert.equal((await retrieveCaptions({}, reader)).status, 'unavailable');
  assert.equal(reads, 1);
  assert.equal((await retrieveCaptions(data([track('https://evil.test/api/timedtext', 'en')]), reader)).status, 'failed');
  assert.equal(reads, 1, 'Unsafe caption location must not be fetched');
  assert.equal((await retrieveCaptions(data([track('https://www.youtube.com/api/timedtext?lang=en', 'en')]), async () => '')).status, 'failed');
});

test('Missing transcripts trigger exactly one attributed subject search; captions do not need it', async () => {
  const video = { videoId: 'Wd0iFeEImBA', title: 'Microsoft 365 and Project Perception', channel: 'Microsoft Security',
    url: 'https://www.youtube.com/watch?v=Wd0iFeEImBA', durationSeconds: 100, publishedAt: null,
    summary: 'YouTube video - description only; no transcript retrieved.\nAgent risk demo.',
    transcript: { status: 'unavailable' as const, text: '' } };
  let calls = 0;
  const search = async (query: string) => {
    calls++;
    assert.match(query, /Project Perception.*Microsoft Security/);
    return { status: 'retrieved' as const, sources: [{ title: 'Project background', url: 'https://www.microsoft.com/security/blog/perception',
      content: 'Separate background about coordinated defence.', publishedAt: null }] };
  };
  const evidence = await collectYouTubeEvidence(video, search);
  assert.equal(calls, 1);
  assert.equal(evidence.metadata['contentBasis'], 'description-only');
  assert.match(evidence.body, /NOT a transcript/);
  assert.match(evidence.body, /https:\/\/www.microsoft.com\/security\/blog\/perception/);
  assert.equal(relatedYouTubeArticles(evidence.metadata).length, 1);
  await collectYouTubeEvidence({ ...video, transcript: { status: 'retrieved', text: 'Real captions.' } }, search);
  assert.equal(calls, 1);
  const failed = await collectYouTubeEvidence(video, async () => { throw new Error('SECRET PROVIDER DETAIL'); });
  assert.equal((failed.metadata['secondaryResearch'] as { status: string }).status, 'failed');
  assert.ok(!failed.body.includes('SECRET'));
  assert.deepEqual(relatedYouTubeArticles({ secondaryResearch: { sources: [{ title: 'Unsafe', url: 'javascript:alert(1)' }, null] } }), []);
});

test('Existing videos are enriched sequentially without changing workflow or replacing metadata', async () => {
  const db = new Pool();
  const writes: string[] = [];
  const query = mock.method(db, 'query', async (sql: string) => {
    if (sql.startsWith('SELECT')) return { rows: [{ id: 'video-a', url: 'https://youtube.com/watch?v=Wd0iFeEImBA' }] };
    writes.push(sql);
    return { rows: [] };
  });
  try {
    await enrichPendingYouTubeVideos(db, async () => ({
      videoId: 'Wd0iFeEImBA', title: 'Demo', channel: 'Example', url: 'https://youtube.com/watch?v=Wd0iFeEImBA',
      summary: 'Real public captions', publishedAt: null, durationSeconds: 2,
      transcript: { status: 'retrieved', text: 'Real public captions' },
    }));
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /metadata=metadata \|\|/);
    assert.match(writes[0]!, /foundry_indexed_at=NULL/);
    assert.ok(!writes[0]!.includes('workflow_state'));
  } finally { query.mock.restore(); await db.end(); }
});

test('Video deep dives use stored evidence, not watch-page navigation mistaken for full content', async () => {
  const db = new Pool();
  const writes = mock.method(db, 'query', async () => ({ rows: [] }));
  const chat = mock.method(FoundryClient.prototype, 'chatBulk', async (messages) => {
    const prompt = JSON.stringify(messages);
    assert.match(prompt, /no video transcript was retrieved/);
    assert.match(prompt, /Separate background evidence/);
    assert.match(prompt, /not proof of what was said/);
    return JSON.stringify({ news: 'A demo exists.', angle: 'Review risk controls.', format: 'blog', worth: 90 });
  });
  try {
    const dive = await runDeepDive(db, { id: 'video', title: 'Project Perception', url: 'https://youtube.com/watch?v=Wd0iFeEImBA',
      body: 'Description only. Separate background evidence: https://example.org/background',
      published_at: new Date(), metadata: { youtubeEvidenceVersion: 1, transcriptStatus: 'unavailable' } },
    { schedule: 'No immediate deadline', own: '', episodes: '' });
    assert.equal(dive.textSource, 'summary');
    assert.equal(dive.worth, 60);
    assert.equal(chat.mock.callCount(), 1);
  } finally { chat.mock.restore(); writes.mock.restore(); await db.end(); }
});

test('Video metadata is description-only, canonical, bounded and never presented as a transcript', () => {
  const player = { videoDetails: { videoId: 'O9nqK23LRbA', title: 'Agentic borders', author: 'Microsoft Azure', lengthSeconds: '1717', shortDescription: 'Governance and sovereignty.' } };
  const html = `var ytInitialPlayerResponse = ${JSON.stringify(player)}; "publishDate":"2026-03-01"`;
  const video = videoFromPage(html, 'O9nqK23LRbA');
  assert.equal(video.title, 'Agentic borders');
  assert.equal(video.durationSeconds, 1717);
  assert.equal(video.url, 'https://www.youtube.com/watch?v=O9nqK23LRbA');
  assert.match(video.summary, /description only; no transcript retrieved/);
  assert.match(video.summary, /Governance and sovereignty/);
  assert.equal(video.publishedAt?.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.throws(() => videoFromPage(html, 'differentId'), /incomplete/);
  assert.throws(() => videoFromPage('private video', 'O9nqK23LRbA'), /unavailable/);
});
