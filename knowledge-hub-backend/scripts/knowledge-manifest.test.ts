import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CONTENT_SOURCE_DISPOSITIONS, KNOWLEDGE_FAMILIES } from '../src/ai/knowledge/manifest.js';

test('COV-01: every ContentSource has a disposition mapped to a known family', async () => {
  const text = await readFile(new URL('../src/types/contentItem.ts', import.meta.url), 'utf8');
  const union = text.slice(text.indexOf('export type ContentSource'), text.indexOf('/**', text.indexOf('export type ContentSource')));
  const sources = [...union.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(sources.length >= 30);
  const kinds = new Set(KNOWLEDGE_FAMILIES.map((f) => f.kind));
  for (const s of sources) {
    const d = (CONTENT_SOURCE_DISPOSITIONS as Record<string, { family: string; reason: string }>)[s];
    assert.ok(d, `missing disposition for ${s}`);
    assert.ok(kinds.has(d.family), `${s} maps to unknown family ${d.family}`);
    assert.ok(d.reason.length > 0);
  }
  assert.deepEqual(Object.keys(CONTENT_SOURCE_DISPOSITIONS).sort(), [...sources].sort());
});

test('COV-01: families are unique, explained and name their tests', () => {
  assert.equal(new Set(KNOWLEDGE_FAMILIES.map((f) => f.kind)).size, KNOWLEDGE_FAMILIES.length);
  for (const f of KNOWLEDGE_FAMILIES) {
    assert.ok(f.reason && f.entryPoint && f.tests.length > 0, f.kind);
    assert.ok(f.capabilities.length > 0, f.kind);
  }
});
