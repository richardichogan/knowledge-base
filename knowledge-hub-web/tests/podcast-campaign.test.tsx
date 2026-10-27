import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PodcastCampaign, PodcastEpisodeLinks } from '../src/notes/PodcastCampaign';
import type { PodcastCampaignDetail } from '../src/types/podcastCampaign';

const campaign: PodcastCampaignDetail = {
  noteId: 'episode', revision: 1, links: {
    youtube: 'https://youtu.be/abcdefghijk', spotify: 'https://open.spotify.com/episode/abcdefghijklmnopqrstuv',
    apple: 'https://podcasts.apple.com/gb/podcast/test/id12345678?i=12345678',
  },
  plan: {
    title: 'Episode campaign', notes: ['Uses the supplied campaign dates.'], excluded: ['Podcast-account LinkedIn copy is not scheduled.'],
    accounts: { blog: 'blog.example.com', linkedin: 'member', bluesky: 'podcast.bsky.social' }, linkedinName: 'Richard',
    posts: [{ id: 'post', destination: 'bluesky', label: 'Launch discussion', scheduledAt: '2099-01-05T09:00:00Z',
      copy: 'Read the episode discussion.', platform: 'youtube', url: 'https://youtu.be/abcdefghijk', blog: null }],
  },
  sourceRevision: 1, state: 'draft', approvedAt: null, error: null, deliveries: [], issues: [],
  sourceChanged: false, automaticDelivery: false,
};
function render(data: PodcastCampaignDetail, fields = false): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['podcast-campaign', data.noteId], data);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{fields
      ? <PodcastEpisodeLinks noteId={data.noteId} noteRevision={1} />
      : <PodcastCampaign noteId={data.noteId} noteRevision={1} beforePrepare={async () => true} />}</QueryClientProvider>);
  } finally { client.clear(); }
}
test('episode links are explicit fields, retain the original URLs and explain the channel rules', () => {
  const html = render(campaign, true);
  assert.equal((html.match(/type="url"/g) ?? []).length, 3);
  for (const label of ['YouTube episode URL', 'Spotify episode URL', 'Apple Podcasts episode URL']) assert.ok(html.includes(label));
  assert.ok(html.includes('Save episode links'));
  assert.ok(html.includes('Blog and LinkedIn include all three'));
});
test('campaign exposes complete copy, dates, exclusions and one approval while clearly disabling local automatic delivery', () => {
  const html = render(campaign);
  assert.ok(html.includes('Approve complete campaign'));
  assert.ok(html.includes('Local automatic delivery is off'));
  assert.ok(html.includes('Richard (personal)'));
  assert.ok(html.includes('Read the episode discussion.'));
  assert.ok(html.includes(campaign.links.youtube));
  assert.ok(html.includes('Podcast-account LinkedIn copy is not scheduled.'));
  const blocked = render({ ...campaign, issues: ['Publication date has passed.'] });
  assert.match(blocked, /disabled="">Approve complete campaign/);
  assert.ok(blocked.includes('Resolve before approval'));
});
test('approved campaigns retain pause and receipts but cannot be silently regenerated', () => {
  const html = render({ ...campaign, state: 'approved', approvedAt: '2026-10-27T09:00:00Z', sourceChanged: true });
  assert.ok(html.includes('Pause delivery'));
  assert.ok(html.includes('your note edits do not rewrite scheduled posts'));
  assert.ok(!html.includes('Prepare again from note'));
  const lockedLinks = render({ ...campaign, state: 'approved' }, true);
  assert.equal((lockedLinks.match(/disabled=""/g) ?? []).length, 3);
});
