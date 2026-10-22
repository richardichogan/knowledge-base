import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsedLine } from '../src/components/athena/UsedLine';
import { KnowledgeFamilies } from '../src/components/health/KnowledgeFamilies';
import { groupSources, safeExternalUrl, sourceTarget } from '../src/components/athena/usedSources';
import type { ContextUsedApi } from '../src/types';
import type { HealthFamilies, HealthFamily } from '../src/services/api';

const used = (overrides: Partial<ContextUsedApi>): ContextUsedApi => ({
  project: null, instructions: 0, inView: null, found: [], auto: [], outputs: 0, decisions: 0, screens: 0, ...overrides,
});

function renderUsed(value: ContextUsedApi, excluded: string[] = []): string {
  // The detail is collapsed by default, so drive it open through the initial state of useState.
  const original = React.useState;
  (React as { useState: unknown }).useState = ((initial: unknown) => original(initial === false ? true : initial)) as typeof React.useState;
  try {
    return renderToStaticMarkup(<UsedLine used={value} excluded={new Set(excluded)} onExclude={() => undefined} onInclude={() => undefined} />);
  } finally {
    (React as { useState: unknown }).useState = original;
  }
}

test('UI-01 sources are grouped Cited, Read and Found at their furthest lifecycle', () => {
  const groups = groupSources({
    found: [{ id: 'a', kind: 'note', title: 'Claims note' }, { id: 'b', kind: 'document', title: 'Spec', lifecycle: 'cited' }],
    auto: [{ id: 'a', kind: 'note', title: 'Claims note', lifecycle: 'found' }, { id: 'c', kind: 'item', title: 'Mail' }],
  });
  assert.deepEqual(groups.map((g) => [g.lifecycle, g.sources.map((s) => s.id)]), [['cited', ['b']], ['read', ['a']], ['found', ['c']]]);
});

test('UI-01 the used line labels each state and keeps "Don\'t use this"', () => {
  const html = renderUsed(used({
    found: [{ id: 'b', kind: 'document', title: 'Spec', lifecycle: 'cited', url: 'https://athena.example/library/b' }],
    auto: [{ id: 'c', kind: 'item', title: 'Mail' }],
  }));
  assert.match(html, /ai-used__state--cited">Cited/);
  assert.match(html, /ai-used__state--found">Found/);
  assert.match(html, /Don’t use this/);
  assert.match(html, /href="https:\/\/athena\.example\/library\/b"/);
});

test('UI-02 an unavailable target is not linked, and warnings stay scoped to the reply or source', () => {
  const html = renderUsed(used({
    found: [{ id: 'gone', kind: 'note', title: 'Deleted note', available: false, url: 'https://athena.example/notes/gone' }],
    warnings: [{ message: 'Semantic search was unavailable for this answer.' }, { message: 'Extract is partial.', sourceId: 'gone' }],
  }));
  assert.match(html, /No longer available/);
  assert.doesNotMatch(html, /href="https:\/\/athena\.example\/notes\/gone"/);
  assert.match(html, /Semantic search was unavailable for this answer\./);
  assert.match(html, /Extract is partial\./);
  assert.match(html, /2 notices/);
  assert.equal(renderUsed(used({ found: [{ id: 'x', kind: 'note', title: 'Fine' }] })).includes('ai-used__warning'), false);
});

test('UI-02 external links are validated and never expose credentials', () => {
  assert.equal(safeExternalUrl('https://example.com/a?token=abc'), null);
  assert.equal(safeExternalUrl('https://user:pw@example.com/'), null);
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('https://example.com/a?page=2'), 'https://example.com/a?page=2');
  assert.deepEqual(sourceTarget({ id: '1', kind: 'item', title: 't', url: 'https://example.com/x?sig=1' }), { kind: 'none' });
  assert.deepEqual(sourceTarget({ id: '1', kind: 'item', title: 't', url: 'https://example.com/x' }), { kind: 'external', href: 'https://example.com/x' });
  assert.deepEqual(sourceTarget({ id: '1', kind: 'note', title: 't', url: '/notes/1' }), { kind: 'internal', href: '/notes/1' });
});

const family = (overrides: Partial<HealthFamily>): HealthFamily => ({
  kind: 'note', availability: 'partial', state: 'partial', capabilities: ['discover', 'read'], entryPoint: 'search', reason: 'indexed copy',
  sources: ['note'], counts: { eligible: null, indexed: 4, pending: null, failed: null },
  extraction: { fullText: 3, metadataOnly: 1, atIngestionCap: 0 }, lastIndexedAt: null, lastSuccessfulSyncAt: null, errorCategories: [], ...overrides,
});
const families = (list: HealthFamily[], state: HealthFamilies['semantic']['state'] = 'coverage-not-measured'): HealthFamilies => ({
  families: list, orchestrationEnabled: false, decisionTablesMeasured: false, lastSuccessfulSyncAt: null,
  semantic: { state, providerConfigured: true, message: 'The provider is configured but how much has been indexed is not measured.',
    work: { measured: false, pending: null, failed: null, done: null } },
});

test('AC-13 health shows partial states, not-measured counts and no percentage or green provider claim', () => {
  const html = renderToStaticMarkup(<KnowledgeFamilies section={{ available: true, data: families([
    family({}),
    family({ kind: 'person', state: 'not-configured', availability: 'unavailable', sources: [], counts: { eligible: null, indexed: null, pending: null, failed: null }, extraction: null }),
    family({ kind: 'email', state: 'temporarily-unavailable', errorCategories: ['sync-errors'] }),
  ]) }} />);
  assert.match(html, /Connected, coverage not measured/);
  assert.match(html, /Not measured/);
  assert.match(html, /Unsupported extraction|Partial coverage/);
  assert.match(html, /Not configured/);
  assert.match(html, /Temporarily unavailable/);
  assert.match(html, /Latest sync reported errors/);
  assert.match(html, /Read live/);
  assert.doesNotMatch(html, /%/);
  assert.doesNotMatch(html, /Up to date/);
});

test('AC-13 an unreadable or absent coverage section is scoped to itself', () => {
  assert.match(renderToStaticMarkup(<KnowledgeFamilies section={{ available: false, message: 'This section could not be read right now.' }} />), /Coverage unavailable/);
  assert.match(renderToStaticMarkup(<KnowledgeFamilies section={undefined} />), /does not report per-family coverage/);
});
