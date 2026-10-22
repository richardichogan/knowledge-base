import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLedger, noteFound, noteRead, ledgerCounts, summariseLedger, dropFromLedger } from '../src/ai/knowledge/evidence.js';
import { resolveAnswer, validateCitation, normaliseWhitespace, parseCitations } from '../src/ai/knowledge/citations.js';
import { TurnBudget, budgetLimitation, completenessAnswer, exhaustiveQualification, isKnowledgeOrchestrationEnabled } from '../src/ai/knowledge/budgets.js';
import { authorityLabel, attributionVerb, overclaimProblems, dedupeSyndicated, interpretWatchRun, watchStatement, chatQuoteAllowed } from '../src/ai/knowledge/evidenceAuthority.js';
import { emptyContextUsed, attachEvidence, recordToolEvidence } from '../src/ai/contextUsage.js';

const ref = (id: string, kind = 'note') => ({ kind, id });
function ledgerWith(text: string, version = 'v1') {
  const l = createLedger();
  noteRead(l, ref('N1'), { text, version, title: 'N1', projectId: 'p1' });
  return l;
}

test('EVD-01: disagreeing sources are both cited and validated', () => {
  const l = ledgerWith('Threshold is GBP 25,000.');
  noteRead(l, ref('D1'), { text: 'Threshold is GBP 50,000.' });
  const d = resolveAnswer(l, 'N1 says 25,000 [[cite:note:N1|GBP 25,000]]. D1 says 50,000 [[cite:note:D1|GBP 50,000]].', { repairsUsed: 0, canRepair: true });
  assert.equal(d.action, 'release');
  assert.equal(ledgerCounts(l).cited, 2);
});

test('EVD-02/EVD-10: authority labels separate decisions, suggestions and reconstructions', () => {
  assert.equal(authorityLabel({ kind: 'note', origin: 'human', subtype: 'decision' }), 'recorded decision');
  assert.equal(authorityLabel({ kind: 'note', origin: 'ai-generated' }), 'AI suggestion');
  const rec = authorityLabel({ kind: 'note', origin: 'imported', subtype: 'copilot_import' });
  assert.equal(attributionVerb(rec), 'The note says');
  assert.ok(overclaimProblems('The meeting decided to ship', rec).length > 0);
  assert.ok(overclaimProblems('The removal was agreed', 'AI suggestion').length > 0);
});

test('EVD-03: AI analysis is not independent corroboration; syndicated copies count once', () => {
  assert.ok(overclaimProblems('independently confirmed', 'AI analysis (not independent corroboration)').length > 0);
  const { unique, duplicates } = dedupeSyndicated([
    { id: 'a', title: 'ExampleCo launches X!', body: null },
    { id: 'b', title: 'ExampleCo launches X', body: null },
    { id: 'c', title: 'Other', contentHash: 'h1' },
    { id: 'd', title: 'Different title', contentHash: 'h1' },
  ]);
  assert.deepEqual(unique.map((u) => u.id), ['a', 'c']);
  assert.equal(duplicates.length, 2);
});

test('EVD-04: fabricated ref or unread result is rejected, repaired once, then partial', () => {
  const l = ledgerWith('Real text.');
  noteFound(l, ref('U1'), {});
  const answer = 'Real fact [[cite:note:N1|Real text.]]. Invented fact [[cite:note:ZZ]]. Unread fact [[cite:note:U1]].';
  assert.equal(validateCitation(l, parseCitations(answer)[1]!).problem, 'unknown_ref');
  assert.equal(validateCitation(l, parseCitations(answer)[2]!).problem, 'unread');
  const first = resolveAnswer(l, answer, { repairsUsed: 0, canRepair: true });
  assert.equal(first.action, 'repair');
  const second = resolveAnswer(l, answer, { repairsUsed: 1, canRepair: true });
  assert.equal(second.action, 'partial');
  if (second.action === 'partial') {
    assert.ok(second.answer.includes('Real fact'));
    assert.ok(!second.answer.includes('Invented'));
    assert.ok(second.answer.includes('could not tie'));
  }
});

test('EVD-05: right id with a quote from another source fails; whitespace is normalised', () => {
  const l = ledgerWith('The   gate\nis  manual.');
  noteRead(l, ref('N2'), { text: 'Autonomous release.' });
  assert.equal(validateCitation(l, { ref: ref('N1'), quote: 'Autonomous release.' }).problem, 'quote_mismatch');
  assert.equal(validateCitation(l, { ref: ref('N1'), quote: 'The gate is manual.' }).ok, true);
  assert.equal(normaliseWhitespace(' a \u00a0\n b '), 'a b');
  assert.equal(validateCitation(l, { ref: ref('N1'), version: 'v2' }).problem, 'version_mismatch');
  assert.equal(validateCitation(l, { ref: ref('N1') }, { allowedProjectIds: new Set(['p2']) }).problem, 'scope_denied');
  assert.equal(validateCitation(l, { ref: ref('N1'), locator: 'x' }).ok, true);
});

test('EVD-06: Found=20, Read=3, Cited=2 reaches the client payload additively', () => {
  const l = createLedger();
  for (let i = 0; i < 20; i++) noteFound(l, ref(`F${i}`), { title: `T${i}` });
  for (let i = 0; i < 3; i++) noteRead(l, ref(`F${i}`), { text: `text ${i}` });
  const d = resolveAnswer(l, 'A [[cite:note:F0|text 0]] B [[cite:note:F1|text 1]]', { repairsUsed: 0, canRepair: true });
  assert.equal(d.action, 'release');
  const used = emptyContextUsed();
  assert.equal(used.evidence, undefined);
  attachEvidence(used, l);
  assert.deepEqual(used.evidence?.counts, { found: 20, read: 3, cited: 2 });
  assert.ok(!JSON.stringify(used.evidence).includes('text 0'));
});

test('EVD-06b: tool results feed the ledger as Found then Read', () => {
  const l = createLedger();
  recordToolEvidence(l, 'search_diagrams', { results: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
  recordToolEvidence(l, 'read_diagram', { id: 'a', title: 'A', content: 'body' });
  assert.deepEqual(ledgerCounts(l), { found: 2, read: 1, cited: 0 });
  dropFromLedger(l, ref('a', 'diagram'));
  assert.equal(summariseLedger(l).entries.length, 1);
});

test('EVD-07/08: failed or empty coverage is never "no change"; quiet covered run is bounded', () => {
  assert.equal(interpretWatchRun({ status: 'failed', coverage: {} }), 'failed');
  assert.equal(interpretWatchRun({ status: 'no_meaningful_change', coverage: {} }), 'insufficient_coverage');
  assert.match(watchStatement('failed', '2026-10-01'), /2026-10-01/);
  assert.doesNotMatch(watchStatement('failed', '2026-10-01'), /no change/i);
  const quiet = interpretWatchRun({ status: 'no_meaningful_change', coverage: { sources: 3 } });
  assert.equal(quiet, 'quiet_covered');
  assert.match(watchStatement(quiet), /not a claim about the wider market/);
});

test('EVD-09: summaries cannot back exact quotes', () => {
  assert.equal(chatQuoteAllowed('summary', true), false);
  assert.equal(chatQuoteAllowed('summary', false), true);
  assert.equal(chatQuoteAllowed('verbatim', true), true);
  assert.equal(chatQuoteAllowed('decision', true), true);
});

test('EVD-11: completeness challenge answers no with bounded scope', () => {
  const b = new TurnBudget();
  b.admitSource('x'.repeat(48_001));
  const a = completenessAnswer(b, { found: 20, read: 3 });
  assert.match(a, /^No\./);
  assert.match(a, /Not everything was checked/);
  assert.doesNotMatch(completenessAnswer(new TurnBudget(), { found: 1, read: 1 }), /everything was checked\b(?!\.)/i);
});

test('EVD-12: no second correction; invalid or timed-out repair gives supported partial or explicit failure', () => {
  const l = ledgerWith('Only text.');
  const bad = 'Claim [[cite:note:NOPE]].';
  const noTime = resolveAnswer(l, bad, { repairsUsed: 0, canRepair: false });
  assert.equal(noTime.action, 'partial');
  const done = resolveAnswer(l, bad, { repairsUsed: 1, canRepair: true });
  assert.equal(done.action, 'partial');
  if (done.action === 'partial') assert.match(done.answer, /couldn't support/);
});

test('PERF-04: text, tool and time budgets stop independently and mark partial scope', async () => {
  const b = new TurnBudget();
  const first = b.admitSource('a'.repeat(47_000));
  assert.equal(first.truncated, false);
  const second = b.admitSource('b'.repeat(5_000));
  assert.equal(second.truncated, true);
  assert.equal(second.text.length, 1_000);
  assert.ok(b.exhausted.has('source_chars') && !b.exhausted.has('tool_executions'));

  const t = new TurnBudget();
  for (let i = 0; i < 8; i++) assert.equal((await t.runRetrieval(async () => i)).ok, true);
  const ninth = await t.runRetrieval(async () => 9);
  assert.deepEqual(ninth, { ok: false, reason: 'tool_executions' });
  assert.ok(!t.exhausted.has('wall_time'));

  let now = 0;
  const w = new TurnBudget(undefined, {}, () => now);
  await w.runRetrieval(async () => { now += 10_000; });
  assert.deepEqual(await w.runRetrieval(async () => 1), { ok: false, reason: 'wall_time' });
  assert.match(budgetLimitation(w), /Not everything was checked/);
});

test('PERF-05: abort stops new retrieval work', async () => {
  const c = new AbortController();
  const b = new TurnBudget(c.signal);
  assert.equal((await b.runRetrieval(async () => 1)).ok, true);
  c.abort();
  let ran = false;
  const r = await b.runRetrieval(async () => { ran = true; });
  assert.deepEqual(r, { ok: false, reason: 'aborted' });
  assert.equal(ran, false);
});

test('PERF-06: source text across several tool rounds stays within the cap', () => {
  const b = new TurnBudget();
  let sent = 0;
  for (let i = 0; i < 10; i++) sent += b.admitSource('z'.repeat(12_000)).text.length;
  assert.equal(sent, 48_000);
});

test('PERF-07: flag off by default and exhaustive queries need a deterministic path', () => {
  assert.equal(isKnowledgeOrchestrationEnabled({}), false);
  assert.equal(isKnowledgeOrchestrationEnabled({ KNOWLEDGE_ORCHESTRATION: 'true' }), true);
  assert.equal(exhaustiveQualification('summarise this note', { deterministicPath: false, complete: false }), null);
  assert.match(exhaustiveQualification('how many tasks are overdue', { deterministicPath: false, complete: false }) ?? '', /can't give an exact count/);
  assert.equal(exhaustiveQualification('count all overdue tasks', { deterministicPath: true, complete: true }), null);
  assert.match(exhaustiveQualification('list every task', { deterministicPath: true, complete: false }) ?? '', /partial/);
});

test('SAFE-08/SAFE-10: evidence handling is read-only and ledger holds no publish state', () => {
  const l = ledgerWith('Private IMAGINE evidence.');
  const before = JSON.stringify([...l.entries.values()]);
  resolveAnswer(l, 'Fact [[cite:note:N1|Private IMAGINE evidence.]]', { repairsUsed: 0, canRepair: true });
  const after = [...l.entries.values()];
  assert.equal(after[0]?.projectId, 'p1');
  assert.equal(after.length, JSON.parse(before).length);
  assert.ok(!('publish' in (after[0] ?? {})));
});
