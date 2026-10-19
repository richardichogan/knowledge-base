import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoverParkingAction } from '../src/components/discover/DiscoverParkingAction';
import { hasParkingDestination, parkingLabel } from '../src/features/discover/parkingLot';
import type { DiscoverItem } from '../src/services/api';
import type { DiscoverParking } from '../src/types/discover';

test('newsletter and podcast selections are independent and both have an explicit shared label', () => {
  for (const [newsletter, podcast, expected] of [
    [true, false, 'Newsletter'], [false, true, 'Podcast'], [true, true, 'Newsletter and podcast'],
    [false, false, 'Choose newsletter, podcast or both'],
  ] as const) {
    assert.equal(parkingLabel({ newsletter, podcast }), expected);
    assert.equal(hasParkingDestination({ newsletter, podcast }), newsletter || podcast);
  }
});

function markup(parking?: DiscoverParking): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const item = { id: 'fixture', title: 'Saved article', ...(parking ? { parking } : {}) } as DiscoverItem;
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><DiscoverParkingAction item={item} /></QueryClientProvider>);
  } finally { client.clear(); }
}

test('parking control is an accessible inline disclosure, not an automatic save or publishing action', () => {
  const html = markup();
  assert.match(html, /Park for later/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls=/);
  assert.ok(!html.includes('<form'), 'No editor before deliberate activation');
  assert.ok(!html.includes('Publish'), 'Parking is not a publishing action');
});

test('restored parking destinations are visible without opening another panel', () => {
  const time = '2026-10-19T12:00:00.000Z';
  for (const selection of [{ newsletter: true, podcast: false }, { newsletter: false, podcast: true }, { newsletter: true, podcast: true }]) {
    const html = markup({ ...selection, parkedAt: time, updatedAt: time });
    assert.match(html, /Edit parking/);
    assert.ok(html.includes(parkingLabel(selection)));
    assert.ok(!html.includes('role="status"'), 'Saved initial data is not a new-save confirmation');
  }
});
