import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublishingFeedControls } from '../src/components/discover/DiscoverPublishing';
import type { PublishingFeed } from '../src/types/publishing';

const policy = { timezone: 'Europe/London', startHour: 8, endHour: 20, days: [0, 1, 2, 3, 4, 5, 6], expiryHours: 48, guidance: '' };
const feeds: PublishingFeed[] = [{ id: 'bluesky', revision: 1, enabled: false, policy }, { id: 'blog-linkedin', revision: 1, enabled: false, policy: { ...policy, expiryHours: 168 } }];
test('publishing presents exactly one accessible automation switch per coordinated feed, both off', () => {
  let writes = 0;
  const html = renderToStaticMarkup(<PublishingFeedControls feeds={feeds} busy={false} act={async () => { writes++; return true; }} />);
  assert.equal([...html.matchAll(/role="switch"/g)].length, 2);
  assert.equal([...html.matchAll(/aria-checked="false"/g)].length, 2);
  assert.match(html, /Bluesky posting automation/); assert.match(html, /Blog \/ LinkedIn posting automation/);
  assert.match(html, /Both approvals required/); assert.match(html, /Up to 4 posts\/day/);
  assert.match(html, /Up to 3 LinkedIn posts\/day/);
  assert.equal([...html.matchAll(/<details class="kh-publishing__policy">/g)].length, 2);
  assert.equal(writes, 0);
});
test('feed controls reflect persisted state, disable writes while saving and preserve visible schedule labels', () => {
  const html = renderToStaticMarkup(<PublishingFeedControls feeds={feeds.map(f => ({ ...f, enabled: f.id === 'bluesky' }))} busy act={async () => true} />);
  assert.equal([...html.matchAll(/aria-checked="true"/g)].length, 1);
  assert.ok([...html.matchAll(/<button[^>]+role="switch"[^>]*>/g)].every(([button]) => button.includes('disabled')));
  for (const label of ['Timezone', 'From', 'Until', 'Expiry (hours)', 'Publishing days', 'Editorial guidance']) assert.ok(html.includes(label));
});
