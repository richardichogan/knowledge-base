import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { knowledgeOrchestrationPromptBlocks } from '../src/ai/contextBuilder.js';
import { CONFLICT_AUTHORITY_PROMPT } from '../src/ai/knowledge/evidenceAuthority.js';
import { createEdgeLoader, createTargetResolver, executeTraverseRelationships, INFERRED_EDGE_TYPES } from '../src/ai/knowledge/traversalLoader.js';
import { focusTools } from '../src/ai/toolRouting.js';
import { TurnBudget, finalizeKnowledgeAnswer } from '../src/ai/knowledge/budgets.js';
import { createLedger, noteFound, noteRead, markUnavailable } from '../src/ai/knowledge/evidence.js';
import { attachEvidence, emptyContextUsed, recordToolSources, recordToolEvidence } from '../src/ai/contextUsage.js';
import type { LlmToolDefinition } from '../src/ai/foundryClient.js';

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env['KNOWLEDGE_ORCHESTRATION'];
  if (value === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = value;
  try { return fn(); } finally { if (prior === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = prior; }
}

function fakeDb(handler: (sql: string, params: unknown[]) => unknown[]): Pool {
  return { query: async (sql: string, params: unknown[]) => ({ rows: handler(sql, params) }) } as unknown as Pool;
}

test('wiring: conflict/authority prompt is injected only when the flag is on', () => {
  assert.deepEqual(withFlag(undefined, () => knowledgeOrchestrationPromptBlocks()), []);
  assert.deepEqual(withFlag('1', () => knowledgeOrchestrationPromptBlocks()), ['---', CONFLICT_AUTHORITY_PROMPT]);
});

test('wiring: edge loader labels explicit vs inferred and records provenance', async () => {
  const db = fakeDb(() => [
    { ref_id: 'T1', ref_type: 'task', edge_type: 'references', confidence: '1.00' },
    { ref_id: 'N2', ref_type: 'note', edge_type: 'tag_overlap', confidence: '0.60' },
  ]);
  const edges = await createEdgeLoader(db)({ kind: 'note', id: 'N1' });
  assert.equal(edges[0]?.explicit, true);
  assert.equal(edges[1]?.explicit, false);
  assert.equal(edges[1]?.provenance, 'graph-inference');
  assert.ok(INFERRED_EDGE_TYPES.has('thematically_related'));
});

test('wiring: target resolver rejects dangling, deleted and excluded targets', async () => {
  const rowsFor = (rows: unknown[]) => createTargetResolver(fakeDb(() => rows), new Set(['X']));
  assert.deepEqual(await rowsFor([])({ kind: 'note', id: 'a' }), { status: 'dangling' });
  assert.deepEqual(await rowsFor([{ title: 't', project: null, present: false }])({ kind: 'note', id: 'a' }), { status: 'deleted' });
  assert.deepEqual(await rowsFor([])({ kind: 'note', id: 'X' }), { status: 'excluded' });
  assert.deepEqual(await rowsFor([{ title: 't', project: 'p', present: true }])({ kind: 'note', id: 'a' }), { status: 'ok', title: 't', projectId: 'p' });
});

test('wiring: traverse tool returns unread, labelled targets and omits dangling ones', async () => {
  const pool = fakeDb((sql, params) => {
    if (sql.includes('WITH me')) return params[1] === 'N1'
      ? [{ ref_id: 'T1', ref_type: 'note', edge_type: 'references', confidence: '1' }, { ref_id: 'GONE', ref_type: 'note', edge_type: 'references', confidence: '1' }]
      : [];
    return params[1] === 'GONE' ? [] : [{ title: 'Target', project: 'p1', present: true }];
  });
  const out = await executeTraverseRelationships(pool, { kind: 'note', id: 'N1' }, {}) as { results: Array<{ id: string; read: boolean; label: string }>; rejectedCount: number };
  assert.deepEqual(out.results.map((r) => r.id), ['T1']);
  assert.equal(out.results[0]?.read, false);
  assert.equal(out.results[0]?.label, 'explicit');
  assert.equal(out.rejectedCount, 1);
  const bad = await executeTraverseRelationships(pool, { kind: '', id: '' }, {});
  assert.ok('error' in (bad as object));
});

test('wiring: traversal tool is routed only for relationship questions with the flag on', () => {
  const tools = [{ type: 'function', function: { name: 'traverse_relationships', description: '', parameters: {} } }, { type: 'function', function: { name: 'search_knowledge_base', description: '', parameters: {} } }] as unknown as LlmToolDefinition[];
  const names = (message: string, flag: boolean): string[] => focusTools(tools, { userMessage: message, knowledgeOrchestration: flag }).map((t) => t.function.name);
  assert.ok(names('What depends on the pricing note?', true).includes('traverse_relationships'));
  assert.ok(!names('What depends on the pricing note?', false).includes('traverse_relationships'));
  assert.ok(!names('Summarise my week', true).includes('traverse_relationships'));
});

test('wiring: exhaustive queries are qualified without a deterministic path; challenges never claim completeness', () => {
  const budget = new TurnBudget();
  const counts = { found: 5, read: 2 };
  const qualified = finalizeKnowledgeAnswer('How many notes mention Acme?', 'Three.', { budget, counts, retrievalUsed: true, deterministicPath: false });
  assert.match(qualified, /can't give an exact count/);
  const exact = finalizeKnowledgeAnswer('How many tasks are open?', '4 open.', { budget, counts, retrievalUsed: true, deterministicPath: true });
  assert.equal(exact, '4 open.');
  const challenge = finalizeKnowledgeAnswer('Have you checked everything?', 'Yes.', { budget, counts, retrievalUsed: true, deterministicPath: false });
  assert.match(challenge, /Not necessarily everything\. I found 5 records and read 2/);
  assert.doesNotMatch(challenge, /^Yes/);
});

test('wiring: source payload carries lifecycle, availability and warnings additively', () => {
  const used = emptyContextUsed();
  const ledger = createLedger();
  const result = { results: [{ id: 'a', source: 'note', title: 'Alpha' }, { id: 'b', source: 'note', title: 'Beta' }] };
  recordToolSources(used, 'search_knowledge_base', result);
  recordToolEvidence(ledger, 'search_knowledge_base', result);
  noteRead(ledger, { kind: 'item', id: 'a' }, { title: 'Alpha', text: 'text' });
  markUnavailable(ledger, { kind: 'item', id: 'b' });
  attachEvidence(used, ledger, ['Source text limit reached.']);
  assert.equal(used.found[0]?.lifecycle, 'read');
  assert.equal(used.found[0]?.available, true);
  assert.equal(used.found[1]?.lifecycle, 'found');
  assert.equal(used.found[1]?.available, false);
  assert.ok(used.warnings?.some((w) => w.sourceId === 'b'));
  assert.ok(used.warnings?.some((w) => w.message === 'Source text limit reached.'));
  assert.ok(noteFound(ledger, { kind: 'item', id: 'a' }) !== undefined);
});

test('wiring: traversal targets appear as Found sources', () => {
  const used = emptyContextUsed();
  const ledger = createLedger();
  const result = { results: [{ id: 'T1', type: 'task', title: 'Ship it' }] };
  recordToolSources(used, 'traverse_relationships', result);
  recordToolEvidence(ledger, 'traverse_relationships', result);
  assert.equal(used.found[0]?.id, 'T1');
  assert.equal(ledger.entries.size, 1);
});
