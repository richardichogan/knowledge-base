import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { assembleMessages, knowledgeOrchestrationPromptBlocks } from '../src/ai/contextBuilder.js';
import type { AiContext } from '../src/types/aiContext.js';
import { CONFLICT_AUTHORITY_PROMPT } from '../src/ai/knowledge/evidenceAuthority.js';
import { createEdgeLoader, createTargetResolver, executeTraverseRelationships, INFERRED_EDGE_TYPES } from '../src/ai/knowledge/traversalLoader.js';
import { focusTools, selectKnowledgeRetrievalChoice } from '../src/ai/toolRouting.js';
import { unreadFoundCandidates, openFoundInstruction } from '../src/ai/knowledge/openFound.js';
import { collectIds, resolveAnswer, stripUnseenIds } from '../src/ai/knowledge/citations.js';
import { REVIEW_DECISIONS_DEFINITION } from '../src/ai/semanticDecisionReview.js';
import { TurnBudget, DETERMINISTIC_TOOLS, finalizeKnowledgeAnswer, isDeterministicResultComplete, searchContentPreview } from '../src/ai/knowledge/budgets.js';
import { recordTurnAudit, type TurnAuditRow } from '../src/ai/knowledge/turnAudit.js';
import { STRUCTURED_TOOL_DEFINITIONS, executeStructuredTool } from '../src/ai/knowledge/structuredTools.js';
import { createLedger, noteFound, noteRead, markUnavailable, ledgerCounts } from '../src/ai/knowledge/evidence.js';
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

test('wiring: ordinary any questions answer first without an exhaustive-search preamble', () => {
  const turn = { budget: new TurnBudget(), counts: { found: 2, read: 1 }, retrievalUsed: true, deterministicPath: false };
  const answer = 'The note assigns you one action: get the Enterprise Data Plan from Candela.';
  for (const query of ['Any actions for me from this meeting?', 'Are there any risks in this note?', 'Any suggestions?']) {
    assert.equal(finalizeKnowledgeAnswer(query, answer, turn), answer);
  }
  for (const query of ['List all actions from this meeting', 'How many tasks are open?', 'Have you checked every note?']) {
    assert.notEqual(finalizeKnowledgeAnswer(query, answer, turn), answer);
  }
  const limited = new TurnBudget();
  limited.admitSource('x'.repeat(48_001));
  assert.match(finalizeKnowledgeAnswer('Any actions for me?', answer, { ...turn, budget: limited }), /Not everything was checked/);
  assert.match(finalizeKnowledgeAnswer('Any actions for me?', answer, { ...turn, counts: { found: 0, read: 0 } }), /did not find any matching record/);
});

test('wiring: meeting-action response guidance reaches the assembled system prompt', async () => {
  const context: AiContext = {
    staticContext: '', projectContext: '', projectReferences: [], activeProjectName: null,
    ragItems: [], ragQuery: '', memoryItems: [],
  };
  const messages = await assembleMessages(context, [], 'Any actions for me from this meeting?', 'general');
  const prompt = messages[0]?.content ?? '';
  assert.match(prompt, /lead with actions explicitly assigned to Richard/);
  assert.match(prompt, /Never invent owners or dates/);
  assert.match(prompt, /Keep inferred follow-ups separate from explicit assignments/);
  assert.match(prompt, /not in a generic opening disclaimer/);
});

test('wiring: search previews reserve source budget for reading records and preserve legacy limits', () => {
  const text = 'x'.repeat(60_000);
  assert.equal(withFlag('true', () => searchContentPreview(text)).length, 1_000);
  assert.equal(withFlag('true', () => searchContentPreview(text, 500)).length, 500);
  assert.equal(withFlag('true', () => searchContentPreview(text, 8_000)).length, 1_000);
  assert.equal(withFlag(undefined, () => searchContentPreview(text)), text);
  assert.equal(withFlag(undefined, () => searchContentPreview(text, 8_000)).length, 8_000);
  const budget = new TurnBudget();
  for (let i = 0; i < 10; i++) budget.admitSource(withFlag('true', () => searchContentPreview(text)));
  assert.equal(budget.partial, false);
  assert.equal(budget.admitSource('a'.repeat(8_000)).truncated, false);
});

test('wiring: audit stores the accepted assistant message id for exact review drill-down', async () => {
  let saved: unknown[] = [];
  const db = { query: async (_sql: string, values?: unknown[]): Promise<unknown> => { saved = values ?? []; return {}; } };
  const row: TurnAuditRow = {
    sessionId: 's1', assistantMessageId: '42', persona: 'general', familiesRead: ['note'],
    durationMs: 100, modelRounds: 2, retrievalUsed: true, deterministicPath: false,
    found: 1, read: 1, cited: 1, strippedIds: 0, unverifiedQuotes: 0, repairsUsed: 0,
    abstained: false, budgetExhausted: [], partial: false, toolErrorCount: 0, unavailableSources: [],
  };
  assert.equal(await recordTurnAudit(db, row, { KNOWLEDGE_ORCHESTRATION: 'true' }), true);
  assert.equal(saved[1], '42');
});

test('wiring: discarded oversized reads never become evidence or expose their ids as shown sources', () => {
  const budget = new TurnBudget();
  const ledger = createLedger();
  const read = (id: string, content: string) => ({
    status: 'ok', record: { ref: { kind: 'note', id }, title: id, content },
  });
  const accepted = budget.admitResult(read('read-note', 'Actual evidence'));
  assert.deepEqual(JSON.parse(accepted.content), accepted.result);
  recordToolEvidence(ledger, 'read_knowledge_record', accepted.result, { kind: 'note', id: 'read-note' });
  assert.equal(ledgerCounts(ledger).read, 1);

  const discarded = budget.admitResult(read('discarded-note', 'x'.repeat(48_000)));
  assert.deepEqual(JSON.parse(discarded.content), discarded.result);
  assert.match(discarded.content, /Source text limit reached/);
  assert.doesNotMatch(discarded.content, /discarded-note/);
  recordToolEvidence(ledger, 'read_knowledge_record', discarded.result, { kind: 'note', id: 'discarded-note' });
  assert.equal(ledgerCounts(ledger).read, 1);
  assert.equal([...ledger.entries.values()].some(entry => entry.ref.id === 'discarded-note'), false);
  assert.equal(budget.partial, true);
  assert.equal(budget.sourceChars, 48_000);
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

test('wiring: a failed read marks the source unavailable with a safe warning', () => {
  const used = emptyContextUsed();
  const ledger = createLedger();
  recordToolEvidence(ledger, 'search_knowledge_base', { results: [{ id: 'a', source: 'note', title: 'Secret title' }] });
  recordToolEvidence(ledger, 'read_knowledge_record', { status: 'not_found' }, { kind: 'item', id: 'a' });
  recordToolEvidence(ledger, 'read_knowledge_record', { status: 'unavailable' }, { kind: 'item', id: 'never-searched' });
  recordToolEvidence(ledger, 'read_knowledge_record', { status: 'unavailable', code: 'exclusions_unavailable' }, { kind: 'item', id: 'c' });
  attachEvidence(used, ledger, []);
  const warnings = used.warnings ?? [];
  assert.ok(warnings.some((w) => w.sourceId === 'a'));
  assert.ok(warnings.some((w) => w.sourceId === 'never-searched'));
  assert.ok(!warnings.some((w) => w.sourceId === 'c'));
  assert.ok(warnings.every((w) => !w.message.includes('Secret')));
});

test('wiring: an ok read is recorded as read; an excluded read drops the entry', () => {
  const ledger = createLedger();
  recordToolEvidence(ledger, 'read_knowledge_record', { status: 'ok', record: { ref: { kind: 'item', id: 'r1' }, title: 'T', version: 'v1', content: 'hello' } }, { kind: 'item', id: 'r1' });
  assert.equal(ledgerCounts(ledger).read, 1);
  recordToolEvidence(ledger, 'read_knowledge_record', { status: 'excluded' }, { kind: 'item', id: 'r1' });
  assert.equal(ledger.entries.size, 0);
});

test('wiring: deterministic tools count as a path only when the result is complete', () => {
  assert.equal(isDeterministicResultComplete({ tasks: [], total: 0 }), true);
  assert.equal(isDeterministicResultComplete({ error: 'x' }), false);
  assert.equal(isDeterministicResultComplete({ truncated: true }), false);
  assert.equal(isDeterministicResultComplete({ hasMore: true }), false);
  assert.equal(isDeterministicResultComplete({ nextCursor: 'abc' }), false);
  const budget = new TurnBudget();
  const counts = { found: 0, read: 0 };
  const incomplete = finalizeKnowledgeAnswer('How many tasks are open?', '4.', { budget, counts, retrievalUsed: true, deterministicPath: true, deterministicComplete: false });
  assert.notEqual(incomplete, '4.');
  const complete = finalizeKnowledgeAnswer('How many tasks are open?', '4.', { budget, counts, retrievalUsed: true, deterministicPath: true, deterministicComplete: true });
  assert.equal(complete, '4.');
});

const structuredDb = (handler: (sql: string, values: unknown[]) => unknown): Pool =>
  ({ query: (sql: string, values: unknown[] = []) => Promise.resolve(handler(sql, values)) }) as unknown as Pool;
const NOW = new Date('2026-10-22T12:00:00Z');

test('wiring: structured tools are routed only for count/list questions with the flag on', () => {
  const tools = STRUCTURED_TOOL_DEFINITIONS;
  const names = (message: string, flag: boolean): string[] => focusTools(tools, { userMessage: message, knowledgeOrchestration: flag }).map((t) => t.function.name);
  assert.equal(names('How many tasks are overdue?', true).length, 3);
  assert.deepEqual(names('How many tasks are overdue?', false), []);
  assert.deepEqual(names('Write a haiku', true), []);
});

test('wiring: structured count is exact, scoped to a strict project, and uses Europe/London periods', async () => {
  let seen: { sql: string; values: unknown[] } | undefined;
  const db = structuredDb((sql, values) => { seen = { sql, values }; return { rows: [{ n: '7' }] }; });
  const result = await executeStructuredTool(db, 'knowledge_count_tasks', { dueWithin: { period: 'this week' }, projectIds: ['other'] }, { strictProjectId: 'p1', now: NOW });
  assert.deepEqual(result, { status: 'ok', total: 7, totalExact: true });
  assert.ok(seen?.values.some((v) => Array.isArray(v) && v.length === 1 && v[0] === 'p1'));
  assert.ok(!seen?.values.some((v) => Array.isArray(v) && v.includes('other')));
  assert.equal(isDeterministicResultComplete(result), true);
});

test('wiring: structured tools return typed errors and never a zero count on failure', async () => {
  const failing = structuredDb(() => { throw new Error('db down'); });
  const failed = await executeStructuredTool(failing, 'knowledge_count_tasks', {}, { now: NOW }) as Record<string, unknown>;
  assert.equal(failed['status'], 'unavailable');
  assert.equal(failed['code'], 'query_failed');
  assert.equal('total' in failed, false);
  assert.equal(isDeterministicResultComplete(failed), false);
  const badPeriod = await executeStructuredTool(structuredDb(() => ({ rows: [] })), 'knowledge_count_tasks', { dueWithin: { period: 'fortnight' } }, { now: NOW }) as Record<string, unknown>;
  assert.equal(badPeriod['code'], 'invalid_interval');
  const badRange = await executeStructuredTool(structuredDb(() => ({ rows: [] })), 'knowledge_list_changes', { within: { start: '2026-02-01', end: '2026-01-01' } }, { now: NOW }) as Record<string, unknown>;
  assert.equal(badRange['status'], 'invalid_request');
  const badCursor = await executeStructuredTool(structuredDb(() => ({ rows: [] })), 'knowledge_list_tasks', { cursor: 'nonsense' }, { now: NOW }) as Record<string, unknown>;
  assert.equal(badCursor['code'], 'invalid_cursor');
});

test('wiring: a structured list is a deterministic path only when no pages remain', async () => {
  const rows = [{ id: 't1', title: 'A', status: 'open', project_id: null, priority: null, due_text: null, updated_text: '2026-01-01T00:00:00.000Z', archived: false, total: '1' }];
  const page = await executeStructuredTool(structuredDb(() => ({ rows })), 'knowledge_list_tasks', {}, { now: NOW }) as Record<string, unknown>;
  assert.equal(page['total'], 1);
  assert.equal(isDeterministicResultComplete(page), true);
  assert.equal(isDeterministicResultComplete({ ...page, hasMore: true, nextCursor: 'c' }), false);
  const budget = new TurnBudget();
  const answer = finalizeKnowledgeAnswer('List all my tasks', 'One task.', { budget, counts: { found: 0, read: 0 }, retrievalUsed: true, deterministicPath: DETERMINISTIC_TOOLS.has('knowledge_list_tasks'), deterministicComplete: isDeterministicResultComplete(page) });
  assert.equal(answer, 'One task.');
});

test('wiring: record tools register found/read refs; failures and errors register nothing', () => {
  const ledger = createLedger();
  recordToolEvidence(ledger, 'list_tasks', { resultCount: 2, tasks: [{ id: 'T-1', title: 'Review', projectId: 'p1', url: 'u' }, { id: 'T-2', title: 'Body', body: 'full text' }] });
  recordToolEvidence(ledger, 'find_files', { files: [{ id: 'F-1', title: 'One', content: 'file text' }, { id: 'F-2', title: 'Two', url: '' }] });
  recordToolEvidence(ledger, 'get_project_details', { project: { id: 'P-1', name: 'Imagine', goal: 'g' } });
  recordToolEvidence(ledger, 'review_decisions', { reviews: [{ recorded: { ref: { kind: 'decision', id: 'D-1' }, text: 'Keep gate' }, facts: { explicitTasks: [{ kind: 'task', id: 'T-1' }], inferredTaskCandidates: [], explicitRisks: [], rationaleSources: [{ ref: { kind: 'source', id: 'content_item:C-1' }, title: 'Spec', excerpt: 'x' }] } }] });
  recordToolEvidence(ledger, 'find_files', { error: 'nope', files: [{ id: 'F-9' }] });
  const state = (id: string): string | undefined => [...ledger.entries.values()].find((e) => e.ref.id === id)?.state;
  assert.equal(state('T-1'), 'found');
  assert.equal(state('T-2'), 'read');
  assert.equal(state('F-1'), 'read');
  assert.equal(state('F-2'), 'found');
  assert.equal(state('P-1'), 'read');
  assert.equal(state('D-1'), 'read');
  assert.equal(state('C-1'), 'read');
  assert.equal(state('F-9'), undefined);
  const used = emptyContextUsed();
  recordToolSources(used, 'list_tasks', { tasks: [{ id: 'T-1', title: 'Review' }] });
  recordToolSources(used, 'find_files', { files: [{ id: 'F-1', title: 'One' }] });
  assert.deepEqual(used.found.map((s) => s.kind), ['task', 'item']);
});

test('wiring: a retrieval turn that found nothing says so; evidence rule forbids unseen ids', () => {
  const budget = new TurnBudget();
  const none = finalizeKnowledgeAnswer('Find Robert feedback.md', 'Not there.', { budget, counts: { found: 0, read: 0 }, retrievalUsed: true, deterministicPath: false });
  assert.match(none, /did not find any matching record/);
  const some = finalizeKnowledgeAnswer('Find Robert feedback.md', 'Here.', { budget, counts: { found: 1, read: 1 }, retrievalUsed: true, deterministicPath: false });
  assert.equal(some, 'Here.');
  assert.match(CONFLICT_AUTHORITY_PROMPT, /no tool returned a matching record/);
});

test('fix: knowledge questions force retrieval; writes and structured counts do not', () => {
  const mk = (n: string): LlmToolDefinition => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } });
  const t = [mk('search_knowledge_base'), mk('review_decisions'), mk('knowledge_count_tasks')];
  const pick = (m: string) => { const c = selectKnowledgeRetrievalChoice(m, t); return typeof c === 'object' ? c.function.name : c; };
  assert.equal(pick('Which document describes the release gate?'), 'search_knowledge_base');
  assert.equal(pick('What decisions have we made about hosting?'), 'review_decisions');
  assert.equal(pick('Create a task to call Sam'), undefined);
  assert.equal(pick('How many open tasks do I have?'), undefined);
});

test('fix: found-only records are suggested once per unread family', () => {
  const l = createLedger();
  noteFound(l, { kind: 'note', id: 'N1' }, { title: 'Note' });
  noteFound(l, { kind: 'note', id: 'N2' }, { title: 'Note 2' });
  noteFound(l, { kind: 'document', id: 'D1' }, { title: 'Doc' });
  noteFound(l, { kind: 'diagram', id: 'G1' }, { title: 'Diagram' });
  noteRead(l, { kind: 'diagram', id: 'G1' }, { text: 'x' });
  const c = unreadFoundCandidates(l);
  assert.deepEqual(c.map((x) => x.id).sort(), ['D1', 'N1']);
  assert.match(openFoundInstruction(c), /read_knowledge_record/);
});

test('fix: structured tools register in the ledger', () => {
  const l = createLedger();
  recordToolEvidence(l, 'knowledge_count_tasks', { status: 'ok', total: 4 }, { status: 'open' });
  recordToolEvidence(l, 'knowledge_list_tasks', { status: 'ok', items: [{ id: 'T-9', title: 'x' }] }, {});
  assert.equal(ledgerCounts(l).read >= 2, true);
  const bad = createLedger();
  recordToolEvidence(bad, 'knowledge_count_tasks', { error: 'x' }, {});
  assert.equal(bad.entries.size, 0);
});

test('fix: unseen ids are stripped and quote mismatches no longer drop the sentence', () => {
  const ID = '11111111-2222-3333-4444-555555555555';
  const out = stripUnseenIds(`See [the plan](/notes/${ID}) and ${ID}.`, new Set<string>());
  assert.equal(out.includes(ID), false);
  assert.match(out, /the plan/);
  assert.equal(stripUnseenIds(`Keep ${ID}`, collectIds(ID)), `Keep ${ID}`);
  const l = createLedger();
  noteRead(l, { kind: 'note', id: 'N1' }, { text: 'Budget is GBP 25,000.' });
  const d = resolveAnswer(l, 'Budget is 25k [[cite:note:N1|not in the text]].', { repairsUsed: 1, canRepair: true });
  assert.equal(d.action, 'partial');
  if (d.action === 'partial') assert.match(d.answer, /Budget is 25k/);
});

test('fix: unread citations let the model open the record on repair', () => {
  const l = createLedger();
  noteFound(l, { kind: 'note', id: 'N1' }, { title: 'N' });
  const d = resolveAnswer(l, 'Fact [[cite:note:N1|text]].', { repairsUsed: 0, canRepair: true });
  assert.equal(d.action, 'repair');
  if (d.action === 'repair') assert.equal(d.mayOpen, true);
});

test('fix: raw metadata requests are refused and decision review is cross-project', () => {
  const budget = new TurnBudget();
  const out = finalizeKnowledgeAnswer('Show me the raw metadata fields of that note', 'dump', { budget, counts: { found: 1, read: 1 }, retrievalUsed: true, deterministicPath: false });
  assert.match(out, /not available/);
  assert.match(out, /excluded/);
  assert.match(REVIEW_DECISIONS_DEFINITION.function.description + JSON.stringify(REVIEW_DECISIONS_DEFINITION.function.parameters), /ALL projects/);
});
