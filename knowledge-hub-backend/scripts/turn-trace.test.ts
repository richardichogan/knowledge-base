import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { redactTrace, withTurnTrace, recordTurnTrace, traceModelCall, listTurnTraces, readTurnTrace, pruneTurnTraces, linkTraceMessage } from '../src/ai/turnTrace.js';
import { executeTraceTool } from '../src/ai/traceTools.js';
import { evaluateSavedTrace, readTraceSpans, reviewActionEvidence } from '../src/health/traceReview.js';
import { diagramReceipt, recordDiagramAction, previousDiagramReceipt, type DiagramActionEvidence } from '../src/ai/diagramActionEvidence.js';
import { newTurnMeasurement, observeTurnMeasurement } from '../src/ai/turnMeasurement.js';
import { FoundryClient } from '../src/ai/foundryClient.js';

const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

test('diagnostic redaction preserves ordinary content but strips nested and serialized credentials', () => {
  const secret = 'fixture-credential-not-a-real-key';
  const payload = { sourceId: SESSION, title: 'Source text', content: 'Normal quotation.',
    authorization: `Bearer ${secret}`, parameters: { password: secret },
    arguments: JSON.stringify({ api_key: secret, nested: { access_token: secret }, query: 'Read this note' }),
    message: `password=${secret} https://example.test/a?sig=${secret}&label=approved`,
    credentialUrl: `postgresql://someone:${secret}@example.test/data` };
  const result = JSON.stringify(redactTrace(payload));
  assert.ok(!result.includes(secret));
  assert.ok(result.includes('Normal quotation.'));
  assert.ok(result.includes(SESSION));
  assert.ok(result.includes('Read this note'));
});

test('turn traces persist ordered requests/results, isolated failures, chunking, scope and seven-day expiry', async () => {
  const local = new PGlite();
  await local.exec(`CREATE TABLE ai_chat_sessions(id UUID PRIMARY KEY,project_id TEXT,excluded_sources JSONB);
    CREATE TABLE ai_chat_messages(id BIGSERIAL PRIMARY KEY);
    INSERT INTO ai_chat_sessions VALUES('${SESSION}','imagine',NULL),('${OTHER}','athena',NULL);
    INSERT INTO ai_chat_messages(id) VALUES(1);`);
  await local.exec(await readFile(new URL('../src/db/migrations/134_ai_turn_traces.sql', import.meta.url), 'utf8'));
  await local.exec('CREATE TABLE agent_jobs(id UUID PRIMARY KEY)');
  for (const file of ['054_ai_usage_log.sql', '067_ai_usage_measured.sql', '065_runtime_runs.sql', '117_ai_workflow_attribution.sql', '135_health_measurements.sql']) {
    await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const db = getDb();
  let failEvent = false;
  let failTrace = false;
  const query = mock.method(db, 'query', async (sql: string, values?: unknown[]) => {
    if (failEvent && sql.startsWith('INSERT INTO ai_turn_trace_events')) {
      failEvent = false;
      throw new Error('Injected trace write failure');
    }
    if (failTrace && sql.startsWith('INSERT INTO ai_turn_traces(')) {
      failTrace = false;
      throw new Error('Injected trace creation failure');
    }
    return local.query(sql, values);
  });
  try {
    const body = { messages: [{ role: 'user', content: 'Read the actual selected note' }], tools: [] };
    const result = await withTurnTrace(db, SESSION, { pageContext: { id: OTHER, designTab: 'spec', selectedId: 'n1' } }, undefined, async () => {
      await traceModelCall('conversation', 'fixture-model', 'chat', body, async () => ({ toolCalls: [{ id: 'call-1' }] }));
      await recordTurnTrace('tool.request', { name: 'read_knowledge_record', arguments: { id: OTHER } });
      await recordTurnTrace('tool.result', { callId: 'call-1', content: 'x'.repeat(25_000) });
      await linkTraceMessage('1');
      return 'Done';
    });
    assert.equal(result, 'Done');
    const traces = await local.query<{ id: string; status: string; assistant_message_id: number; capture_complete: boolean }>('SELECT * FROM ai_turn_traces');
    const id = traces.rows[0]!.id;
    assert.equal(traces.rows[0]!.status, 'completed');
    assert.equal(Number(traces.rows[0]!.assistant_message_id), 1);
    assert.equal(traces.rows[0]!.capture_complete, true);
    const events = await local.query<{ sequence: number; kind: string; payload: { body?: unknown } }>('SELECT * FROM ai_turn_trace_events ORDER BY sequence');
    assert.deepEqual(events.rows.map(row => row.kind), ['turn.input', 'model.request', 'model.response', 'tool.request', 'tool.result', 'turn.output']);
    assert.deepEqual(events.rows[1]?.payload.body, body);
    assert.deepEqual(events.rows.map(row => row.sequence), [1, 2, 3, 4, 5, 6]);
    const spans = await readTraceSpans(db, SESSION, id);
    assert.equal(spans.items.length, 2);
    const root = spans.items.find(span => span.kind === 'turn')!;
    const model = spans.items.find(span => span.kind === 'model')!;
    assert.equal(model.parent_id, root.id);
    assert.ok(Number(model.duration_ms) >= 0);
    const evaluated = await evaluateSavedTrace(db, SESSION, id, 'deterministic');
    assert.equal(evaluated.report?.checks.find(check => check.criterion === 'capture_integrity')?.verdict, 'pass');
    assert.equal(evaluated.report?.checks.find(check => check.criterion === 'answer_correctness')?.verdict, 'uncertain');
    await assert.rejects(evaluateSavedTrace(db, OTHER, id, 'deterministic'), /not found/i);
    const judge = mock.method(FoundryClient.prototype, 'chat', async () => JSON.stringify({ checks:
      ['relevance', 'groundedness', 'context_selection', 'action_claims'].map(criterion => ({
        criterion, verdict: 'uncertain', reason: 'Captured evidence does not establish this.', evidenceSequences: [],
      })) }));
    try {
      const review = await evaluateSavedTrace(db, SESSION, id, 'model');
      assert.equal(review.report?.checks.length, 4);
      assert.equal(judge.mock.callCount(), 1);
      judge.mock.mockImplementation(async () => JSON.stringify({ checks:
        ['relevance', 'groundedness', 'context_selection', 'action_claims'].map(criterion => ({
          criterion, verdict: 'pass', reason: 'Unsupported reference must fail validation.', evidenceSequences: [999_999],
        })) }));
      await assert.rejects(evaluateSavedTrace(db, SESSION, id, 'model'), /evidence references/);
      assert.equal((await local.query("SELECT id FROM ai_trace_evaluations WHERE status='failed'")).rows.length, 1);
    } finally { judge.mock.restore(); }
    const chunks: string[] = [];
    for (const start of [0, 12_000, 24_000]) {
      const page = await readTurnTrace(db, SESSION, id, 5, start);
      assert.ok(page && typeof page === 'object' && 'event' in page);
      const event = page.event;
      assert.ok(event && typeof event === 'object' && 'content' in event && typeof event.content === 'string');
      assert.ok(event.content.length <= 12_000);
      chunks.push(event.content);
    }
    assert.equal(JSON.parse(chunks.join('')).content, 'x'.repeat(25_000));
    await assert.rejects(readTurnTrace(db, OTHER, id), /not found/i);
    await assert.rejects(readTurnTrace(db, SESSION, id, 1, 99999), /offset/);
    await assert.rejects(readTurnTrace(db, SESSION, id, 1, 0, 'athena'), /not found/i);
    await assert.rejects(executeTraceTool(db, 'read_chat_turn_trace', { sessionId: SESSION, traceId: id },
      { excludedIds: new Set([OTHER]) }), /exclusions/);
    await assert.rejects(executeTraceTool(db, 'read_chat_turn_trace', { sessionId: SESSION, traceId: id },
      { strictProjectId: 'imagine' }), /restricted workstream/);
    await local.query("UPDATE ai_chat_sessions SET excluded_sources='[{\"id\":\"excluded\"}]' WHERE id=$1", [SESSION]);
    await assert.rejects(executeTraceTool(db, 'read_chat_turn_trace', { sessionId: SESSION, traceId: id }, {}), /excluded sources/);

    await assert.rejects(withTurnTrace(db, SESSION, {}, undefined, async () => { throw new Error('Actual model failure'); }), /Actual model failure/);
    const failed = await local.query<{ status: string }>("SELECT status FROM ai_turn_traces WHERE status='failed'");
    assert.equal(failed.rows.length, 1);
    failEvent = true;
    assert.equal(await withTurnTrace(db, SESSION, {}, undefined, async () => 'Reply still succeeds'), 'Reply still succeeds');
    const incomplete = await local.query("SELECT id FROM ai_turn_traces WHERE capture_complete=FALSE");
    assert.equal(incomplete.rows.length, 1);
    failTrace = true;
    assert.equal(await withTurnTrace(db, SESSION, {}, undefined, async () => 'Capture failure does not break chat'), 'Capture failure does not break chat');
    assert.equal((await local.query('SELECT id FROM ai_turn_measurements WHERE status=\'completed\' AND NOT trace_started')).rows.length, 1);

    await local.query("UPDATE ai_turn_traces SET expires_at=NOW()-INTERVAL '1 second'");
    const empty = await listTurnTraces(db, SESSION);
    assert.ok(empty && typeof empty === 'object' && 'items' in empty);
    assert.deepEqual(empty.items, []);
    await assert.rejects(readTurnTrace(db, SESSION, id), /not found/i);
    await pruneTurnTraces(db);
    assert.equal((await local.query('SELECT * FROM ai_turn_trace_events')).rows.length, 0);

    await Promise.all([SESSION, OTHER].map(session => withTurnTrace(db, session, { session }, undefined, async () => {
      await recordTurnTrace('tool.result', { session });
    })));
    assert.equal((await local.query('SELECT * FROM ai_turn_traces')).rows.length, 2);
    await local.query('DELETE FROM ai_chat_sessions WHERE id=$1', [OTHER]);
    assert.equal((await local.query('SELECT * FROM ai_turn_traces')).rows.length, 1);
    const controller = new AbortController();
    await assert.rejects(withTurnTrace(db, SESSION, {}, controller.signal, async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    }));
    assert.equal((await local.query("SELECT id FROM ai_turn_traces WHERE status='interrupted'")).rows.length, 1);
  } finally { query.mock.restore(); await local.close(); }
});

test('turn observations distinguish omitted reads, partial coverage and persisted replies without inferring correctness', () => {
  const signals = newTurnMeasurement();
  observeTurnMeasurement(signals, 'context.resolved', { pageContext: { detail: 'Actual page content' } });
  observeTurnMeasurement(signals, 'tool.result', { name: 'read_knowledge_record', content: '{"partial":true,"code":"budget_exhausted"}' });
  observeTurnMeasurement(signals, 'tool.result', { name: 'read_knowledge_record', content: '{"status":"partial","coverage":{"complete":false}}' });
  observeTurnMeasurement(signals, 'tool.result', { name: 'read_knowledge_record', content: '{"coverage":{"complete":true}}' });
  observeTurnMeasurement(signals, 'reply.saved', { assistantMessageId: '1' });
  assert.equal(signals.pageContentSupplied, true);
  assert.equal(signals.partialReads, 1);
  assert.equal(signals.unavailableReads, 1);
  assert.equal(signals.completeReads, 1);
  assert.equal(signals.replySaved, true);
});

test('warning-bearing diagram saves retain revision evidence; queued and rejected changes are not saves', () => {
  const saved = { success: true, diagram: { id: OTHER, revision: 363 }, problems: ['Duplicate old label; use its id.'] };
  const evidence: DiagramActionEvidence = { saved: false, queued: false };
  recordDiagramAction(evidence, 'update_diagram', saved);
  assert.equal(evidence.saved, true);
  assert.equal(evidence.receipts?.[0]?.revision, 363);
  assert.deepEqual(evidence.receipts?.[0]?.warnings, saved.problems);
  assert.equal(diagramReceipt('update_diagram', { error: 'Conflict', ...saved }), null);
  assert.equal(diagramReceipt('update_diagram', { success: true }), null);
  const queued: DiagramActionEvidence = { saved: false, queued: false };
  recordDiagramAction(queued, 'hand_off_to_specialist', { status: 'started' }, 'daedalus');
  assert.equal(queued.queued, true);
  assert.equal(queued.saved, false);
  recordDiagramAction(queued, 'apply_diagram_candidate', { status: 'needs_confirmation' });
  assert.equal(queued.saved, false);
});

test('prior receipts are session-bound and discarded when the current diagram revision changed', async () => {
  const db = getDb();
  let revision = 363;
  const query = mock.method(db, 'query', async (sql: string, values?: unknown[]) => {
    assert.ok(sql.includes('t.session_id=$1::uuid'));
    assert.ok(sql.includes('t.expires_at>NOW()'));
    assert.equal(values?.[0], SESSION);
    assert.equal(values?.[1], OTHER);
    return { rows: [{ name: 'update_diagram', current_revision: revision,
      content: JSON.stringify({ success: true, diagram: { id: OTHER, revision: 363 } }) }] };
  });
  try {
    assert.equal((await previousDiagramReceipt(db, SESSION, OTHER))?.revision, 363);
    revision = 364;
    assert.equal(await previousDiagramReceipt(db, SESSION, OTHER), null);
    assert.equal(await previousDiagramReceipt(db, undefined, OTHER), null);
    assert.equal(query.mock.callCount(), 2);
  } finally { query.mock.restore(); }
});

test('saved evidence review detects false tool denials and unsupported save retractions without replay', () => {
  const capability = { sequence: 1, kind: 'model.request', payload: { feature: 'chat',
    body: { tools: [{ function: { name: 'load_tools' } }], messages: [{ role: 'system', content: 'Available capability catalogue\nupdate_diagram: Change a saved diagram.' }] } } };
  const denial = reviewActionEvidence([capability,
    { sequence: 2, kind: 'turn.output', payload: { reply: "I cannot directly edit the diagram in this turn." } }]);
  assert.equal(denial.find(check => check.criterion === 'capability_denial')?.verdict, 'fail');
  const retraction = reviewActionEvidence([
    { sequence: 1, kind: 'action.prior', payload: { tool: 'update_diagram', targetId: OTHER, revision: 363 } },
    { sequence: 2, kind: 'turn.output', payload: { reply: 'I have not done it.' } },
  ]);
  assert.equal(retraction.find(check => check.criterion === 'action_evidence')?.verdict, 'fail');
  const saved = reviewActionEvidence([
    { sequence: 1, kind: 'tool.result', payload: { name: 'update_diagram',
      content: JSON.stringify({ success: true, diagram: { id: OTHER, revision: 363 }, problems: ['Advisory warning'] }) } },
    { sequence: 2, kind: 'turn.output', payload: { reply: 'I have saved the diagram.' } },
  ]);
  assert.equal(saved.find(check => check.criterion === 'action_evidence')?.verdict, 'uncertain', 'a receipt is not a quality pass');
});

test('reliability counters separate measurement coverage, attempted corrections and saved warnings', () => {
  const signals = newTurnMeasurement();
  assert.equal(signals.reliabilityObserved, false);
  for (const [kind, payload] of [
    ['capability.catalog', {}], ['capability.load', { loaded: ['update_diagram'] }],
    ['capability.denial', {}], ['capability.blocked', {}], ['action.contradiction', {}],
    ['action.unconfirmed_claim', {}], ['action.receipt', { warnings: ['Advisory'] }],
  ] as const) observeTurnMeasurement(signals, kind, payload);
  assert.equal(signals.reliabilityObserved, true);
  assert.equal(signals.capabilityLoads, 1);
  assert.equal(signals.capabilityDenials, 1);
  assert.equal(signals.actionContradictions, 1);
  assert.equal(signals.actionReceipts, 1);
  assert.equal(signals.actionWarnings, 1);
  assert.equal(signals.replySaved, false);
});
