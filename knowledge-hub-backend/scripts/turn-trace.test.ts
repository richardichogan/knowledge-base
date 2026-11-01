import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { redactTrace, withTurnTrace, recordTurnTrace, traceModelCall, listTurnTraces, readTurnTrace, pruneTurnTraces, linkTraceMessage } from '../src/ai/turnTrace.js';
import { executeTraceTool } from '../src/ai/traceTools.js';

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
  const db = getDb();
  let failEvent = false;
  const query = mock.method(db, 'query', async (sql: string, values?: unknown[]) => {
    if (failEvent && sql.startsWith('INSERT INTO ai_turn_trace_events')) {
      failEvent = false;
      throw new Error('Injected trace write failure');
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
      { strictProjectId: 'imagine' }), /restricted project/);
    await local.query("UPDATE ai_chat_sessions SET excluded_sources='[{\"id\":\"excluded\"}]' WHERE id=$1", [SESSION]);
    await assert.rejects(executeTraceTool(db, 'read_chat_turn_trace', { sessionId: SESSION, traceId: id }, {}), /excluded sources/);

    await assert.rejects(withTurnTrace(db, SESSION, {}, undefined, async () => { throw new Error('Actual model failure'); }), /Actual model failure/);
    const failed = await local.query<{ status: string }>("SELECT status FROM ai_turn_traces WHERE status='failed'");
    assert.equal(failed.rows.length, 1);
    failEvent = true;
    assert.equal(await withTurnTrace(db, SESSION, {}, undefined, async () => 'Reply still succeeds'), 'Reply still succeeds');
    const incomplete = await local.query("SELECT id FROM ai_turn_traces WHERE capture_complete=FALSE");
    assert.equal(incomplete.rows.length, 1);

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
