import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelIdFromPage, resolveDiscoveryFeed, videoFromPage, youtubeUrl, youtubeVideoId } from '../src/integrations/discovery/youtube.js';

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
