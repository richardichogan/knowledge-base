import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublishingFeedControls, PublishingDraftPreview, PublishingDraftList, TopicReview, publishingApprovalBlocker } from '../src/components/discover/DiscoverPublishing';
import type { PublishingFeed, PublishingDraft, PublishingTopic, PublishingDetail } from '../src/types/publishing';

const policy = { timezone: 'Europe/London', startHour: 8, endHour: 20, days: [0, 1, 2, 3, 4, 5, 6], expiryHours: 48, guidance: '' };
const feeds: PublishingFeed[] = [{ id: 'bluesky', revision: 1, enabled: false, policy }, { id: 'blog-linkedin', revision: 1, enabled: false, policy: { ...policy, expiryHours: 168 } }];
test('publishing presents exactly one accessible automation switch per coordinated feed, both off', () => {
  let writes = 0;
  const html = renderToStaticMarkup(<PublishingFeedControls feeds={feeds} busy={false} act={async () => { writes++; return true; }} />);
  assert.equal([...html.matchAll(/role="switch"/g)].length, 2);
  assert.equal([...html.matchAll(/aria-checked="false"/g)].length, 2);
  assert.match(html, /Bluesky posting automation/); assert.match(html, /Blog \/ LinkedIn posting automation/);
  assert.match(html, /One package approval covers Blog and LinkedIn/); assert.match(html, /Up to 4 posts\/day/);
  assert.match(html, /Up to 3 LinkedIn posts\/day/);
  assert.equal([...html.matchAll(/<details class="kh-publishing__policy">/g)].length, 2);
  assert.equal(writes, 0);
});
test('feed controls reflect persisted state, disable writes while saving and preserve visible schedule labels', () => {
  const html = renderToStaticMarkup(<PublishingFeedControls feeds={feeds.map(f => ({ ...f, enabled: f.id === 'bluesky' }))} busy act={async () => true} />);
  assert.equal([...html.matchAll(/aria-checked="true"/g)].length, 1);
  assert.ok([...html.matchAll(/<button[^>]+role="switch"[^>]*>/g)].every(([button]) => button.includes('disabled')));
  for (const label of ['Timezone', 'From', 'Until', 'Publishing days', 'Editorial guidance']) assert.ok(html.includes(label));
  assert.ok(!html.includes('Expiry (hours)'));
});
const savedDraft: PublishingDraft = {
  id: 'saved', topicId: 'topic', destination: 'linkedin', variant: 'blog', version: 1,
  content: { copy: 'The complete saved copy.\nIncluding the last sentence, not just its title.' },
  review: 'pass', approval: 'pending', held: false, reason: '', reviewedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
test('draft preview shows exact complete social copy, with no publication or configuration writes', () => {
  const html = renderToStaticMarkup(<PublishingDraftPreview draft={savedDraft} />);
  assert.ok(html.includes(String(savedDraft.content.copy)));
  assert.ok(!html.includes('<button'));
  assert.match(html, /kh-publishing__copy/);
});
test('a held or unreviewed draft explains recovery instead of suggesting it can publish', () => {
  assert.equal(publishingApprovalBlocker(savedDraft), null);
  assert.match(publishingApprovalBlocker({ ...savedDraft, held: true })!, /Publishing is on hold/);
  const deliveryFailure = 'Blog accepted, but public verification failed: Page returned HTTP 404';
  assert.equal(publishingApprovalBlocker({ ...savedDraft, held: true, approval: 'approved', reason: deliveryFailure }), deliveryFailure);
  assert.match(publishingApprovalBlocker({ ...savedDraft, held: true, review: 'hold' })!, /not ready for approval/);
  assert.match(publishingApprovalBlocker({ ...savedDraft, review: 'pending' })!, /accuracy and voice checks pass/);
  assert.match(publishingApprovalBlocker({ ...savedDraft, review: 'revise' })!, /Edit the copy/);
  assert.equal(publishingApprovalBlocker({ ...savedDraft, expiresAt: new Date(0).toISOString() }), null);
});
test('missing saved copy is an explicit generation state, never undefined or ready for approval', () => {
  const empty = { ...savedDraft, content: { account: 'member' } };
  const html = renderToStaticMarkup(<PublishingDraftPreview draft={empty} />);
  assert.match(html, /No post text was saved/);
  assert.ok(!html.includes('undefined'));
  assert.match(publishingApprovalBlocker(empty)!, /not ready for approval/);
});
test('the draft list uses post titles and copy, with unprepared sources separated', () => {
  const prepared: PublishingTopic = { id: 'topic', title: 'Source headline', rationale: '', priority: 50, state: 'held', error: 'failure', drafts: [savedDraft], deliveries: [] };
  const html = renderToStaticMarkup(<PublishingDraftList selected="topic" onSelect={() => { throw new Error('Rendering must not select or write'); }}
    topics={[prepared, { ...prepared, id: 'candidate', title: 'Unprepared source', drafts: [] }]} />);
  assert.match(html, /aria-label="Draft posts"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /The complete saved copy/);
  assert.match(html, /Needs attention/);
  assert.ok(!html.includes('Unprepared source'));
  assert.ok(!html.includes('Sources awaiting drafts'));
});
test('the actual review pane puts full copy before technical findings and exposes one recovery action', () => {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const empty = { ...savedDraft, id: 'broken', destination: 'bluesky' as const, variant: 'source' as const, held: true, review: 'hold', content: { account: 'fixture' }, reason: '{"accuracy":["No complete draft text was provided."]}' };
  const topic: PublishingTopic = { id: 'topic', title: 'A saved source', rationale: '', priority: 50, state: 'held', error: 'Unterminated JSON', drafts: [empty], deliveries: [] };
  query.setQueryData(['publishing', 'topic', 'topic'], { topic, drafts: [empty], sources: [], deliveries: [], events: [], versions: [] } satisfies PublishingDetail);
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><TopicReview id="topic" feeds={feeds} busy={false} act={async () => { throw new Error('Rendering must not write'); }} /></QueryClientProvider>);
  assert.ok(!html.includes('Generate draft</button>'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('Send for scheduling</button>'));
  assert.ok(html.indexOf('No post text was saved for this record') < html.indexOf('Publishing status and findings'));
  assert.ok(html.includes('<summary>Publishing status and findings</summary>'));
  assert.ok(html.indexOf('More actions') < html.indexOf('Rebind account'));
  query.clear();
});
test('a completed reviewed post offers send for scheduling without asking the user to generate or run review', () => {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const ready = { ...savedDraft, destination: 'bluesky' as const, variant: 'source' as const };
  const topic: PublishingTopic = { id: 'topic', title: 'A finished Microsoft post', rationale: '', priority: 90, state: 'ready', error: null, drafts: [ready], deliveries: [] };
  query.setQueryData(['publishing', 'topic', 'topic'], { topic, drafts: [ready], sources: [], deliveries: [], events: [], versions: [] } satisfies PublishingDetail);
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><TopicReview id="topic" feeds={feeds} busy={false} readyOnly act={async () => true} /></QueryClientProvider>);
  assert.match(html, /Send for scheduling<\/button>/);
  assert.match(html, /The complete saved copy/);
  assert.ok(!html.includes('Generate draft'));
  assert.ok(!html.includes('Resume and review'));
  assert.match(html, /automation is off; planned times are paused/);
  query.clear();
});
test('blog and LinkedIn share one package approval even after a legacy partial approval', () => {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const blog: PublishingDraft = { ...savedDraft, id: 'blog', destination: 'blog', content: { title: 'Quick take', summary: 'A complete summary', content: '<p>The article.</p>' } };
  const linkedin: PublishingDraft = { ...savedDraft, approval: 'approved' };
  const topic: PublishingTopic = { id: 'topic', title: 'A complete package', rationale: '', priority: 90, state: 'ready', error: null, drafts: [blog, linkedin], deliveries: [] };
  query.setQueryData(['publishing', 'topic', 'topic'], { topic, drafts: [blog, linkedin], sources: [], deliveries: [], events: [], versions: [] } satisfies PublishingDetail);
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><TopicReview id="topic" initialDestination="linkedin" feeds={feeds} busy={false} act={async () => true} /></QueryClientProvider>);
  assert.match(html, /Send package for scheduling<\/button>/);
  assert.match(html, /approves both saved versions together/);
  assert.ok(!html.includes('must both be approved'));
  query.clear();
});
