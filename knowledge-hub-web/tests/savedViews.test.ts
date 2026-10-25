import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DISCOVER_VIEW, parseSavedViews, parseSharedView, parseWorkspaceView, sharedViewUrl } from '../src/utils/savedViews';

test('versioned Plan/Discover views round-trip exact scopes, sorts and shareable links', () => {
  const plan = { version: 1 as const, kind: 'plan' as const, view: 'focus' as const, project: 'unavailable-project', tag: 'unavailable-tag' };
  const discover = { ...DEFAULT_DISCOVER_VIEW, source: 'IBM & Microsoft', title: '50%_literal', sort: 'editorial' as const };
  for (const view of [plan, discover]) {
    assert.deepEqual(parseWorkspaceView(view), view);
    const url = new URL(sharedViewUrl(new URL('https://example.com/plan?other=retained#section'), view));
    assert.equal(url.searchParams.get('other'), 'retained');
    assert.equal(url.hash, '#section');
    assert.deepEqual(parseSharedView(url.search, view.kind), view);
    const record = { id: '11111111-1111-4111-8111-111111111111', name: 'My focused view', view };
    assert.deepEqual(parseSavedViews(JSON.stringify({ version: 1, items: [record] })), [record]);
  }
  assert.deepEqual(parseSavedViews(null), []);
  assert.equal(parseSharedView('?noteId=existing', 'plan'), null);
});

test('native Design and Use Case deep links do not look like malformed shared JSON views', () => {
  assert.equal(parseSharedView('?view=designs&design=some-id', 'plan'), null);
  assert.equal(parseSharedView('?view=use-cases&useCase=some-id', 'plan'), null);
});

test('unknown, malformed, duplicate and oversized views/links fail explicitly without widening scope', () => {
  const record = { id: '11111111-1111-4111-8111-111111111111', name: 'Review', view: DEFAULT_DISCOVER_VIEW };
  for (const value of [{ ...DEFAULT_DISCOVER_VIEW, version: 2 }, { ...DEFAULT_DISCOVER_VIEW, sort: 'invented' },
    { ...DEFAULT_DISCOVER_VIEW, tab: 'all' }, { ...DEFAULT_DISCOVER_VIEW, cfpState: 'invalid' },
    { ...DEFAULT_DISCOVER_VIEW, format: 'invented' },
    { ...DEFAULT_DISCOVER_VIEW, source: ['nested'] }, { ...DEFAULT_DISCOVER_VIEW, title: 'x'.repeat(257) },
    { ...DEFAULT_DISCOVER_VIEW, title: '\n' }, { ...DEFAULT_DISCOVER_VIEW, unknown: 'ignored' },
    { version: 1, kind: 'plan', view: 'focus', project: 42, tag: '' }]) {
    assert.throws(() => parseWorkspaceView(value));
  }
  for (const raw of ['{', JSON.stringify({ version: 2, items: [] }),
    JSON.stringify({ version: 1, items: [{ ...record, name: ' ' }] }),
    JSON.stringify({ version: 1, items: [record, record] }),
    JSON.stringify({ version: 1, items: [record, { ...record, id: '22222222-2222-4222-8222-222222222222', name: 'review' }] }),
    JSON.stringify({ version: 1, items: Array.from({ length: 21 }, (_, i) => ({ ...record, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `View ${i}` })) }),
    'x'.repeat(32_001)]) assert.throws(() => parseSavedViews(raw));
  assert.throws(() => parseSharedView('?view=%7B', 'discover'));
  assert.throws(() => parseSharedView('?view=a&view=b', 'discover'));
  assert.throws(() => parseSharedView(`?view=${encodeURIComponent(JSON.stringify(DEFAULT_DISCOVER_VIEW))}`, 'plan'));
});

test('publishing formats round-trip while older Discover views remain supported', () => {
  for (const format of ['newsletter', 'podcast', 'fullBlog', 'quickBlog', 'social', ''] as const) {
    const view = { ...DEFAULT_DISCOVER_VIEW, format };
    assert.deepEqual(parseWorkspaceView(view), view);
  }
  const { format: _format, ...legacyView } = DEFAULT_DISCOVER_VIEW;
  assert.deepEqual(parseWorkspaceView(legacyView), DEFAULT_DISCOVER_VIEW);
});

test('Discover Watchlists is a restorable, shareable view without copying a private baseline into the URL', () => {
  const view = { ...DEFAULT_DISCOVER_VIEW, tab: 'watchlists' as const };
  assert.deepEqual(parseWorkspaceView(view), view);
  const url = new URL(sharedViewUrl(new URL('https://example.com/discover'), view));
  assert.deepEqual(parseSharedView(url.search, 'discover'), view);
  assert.ok(!url.searchParams.get('view')?.includes('baseline'));
});

test('Parking lot round-trips independently of article workflow and does not change the default Discover view', () => {
  const view = { ...DEFAULT_DISCOVER_VIEW, tab: 'parking-lot' as const };
  assert.deepEqual(parseWorkspaceView(view), view);
  const url = new URL(sharedViewUrl(new URL('https://example.com/discover'), view));
  assert.deepEqual(parseSharedView(url.search, 'discover'), view);
  assert.equal(DEFAULT_DISCOVER_VIEW.tab, 'to-review');
});
