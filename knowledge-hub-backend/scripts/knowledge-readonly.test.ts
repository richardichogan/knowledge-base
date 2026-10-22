import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { handleConversationTurn } from '../src/ai/conversationService.js';
import { emptyContextUsed } from '../src/ai/contextUsage.js';
import { getToolDefinitions } from '../src/ai/chatTools.js';
import { SESSION } from './knowledge-fixtures.js';
import { harnessDb, recordingPool, scriptModel, snapshotAllTables, toolResults } from './knowledge-harness.js';

const NOTE = '30000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000002';
const DOC = '30000000-0000-4000-8000-000000000003';

const WRITE_ATTEMPTS = [
  { name: 'create_task', args: { title: 'Sneaky task' } },
  { name: 'update_task', args: { id: 't1', status: 'done' } },
  { name: 'create_note_draft', args: { content: 'Sneaky note' } },
  { name: 'create_spark', args: { content: 'Sneaky spark' } },
  { name: 'remember', args: { content: 'Sneaky memory' } },
  { name: 'save_output', args: { title: 'Sneaky output', content: 'x' } },
  { name: 'set_content_plan', args: { items: [] } },
];

const READ_CALLS = [
  { name: 'search_knowledge_base', args: { query: 'retention' } },
  { name: 'read_knowledge_record', args: { kind: 'note', id: NOTE } },
  { name: 'read_knowledge_record', args: { kind: 'content-item', id: DOC } },
  { name: 'read_knowledge_record', args: { kind: 'task', id: 't1' } },
  { name: 'read_knowledge_record', args: { kind: 'project', id: 'p1' } },
  { name: 'read_knowledge_record', args: { kind: 'graph-node', id: NODE } },
  { name: 'list_tasks', args: {} },
];

async function seed(): Promise<Awaited<ReturnType<typeof harnessDb>>> {
  const db = await harnessDb();
  await db.query(`INSERT INTO projects (id, name) VALUES ('p1', 'Platform')`);
  await db.query(`INSERT INTO notes (id, content) VALUES ($1, 'Retention note body')`, [NOTE]);
  await db.query(`INSERT INTO nodes (id, ref_id, ref_type, title) VALUES ($1, $2, 'note', 'Retention node')`, [NODE, NOTE]);
  await db.query(`INSERT INTO content_items (id, source, source_id, title, body) VALUES ($1, 'document', 'd1', 'Retention document', 'Retention is 90 days.')`, [DOC]);
  await db.query(`INSERT INTO tasks (id, title, body, status) VALUES ('t1', 'Retention task', 'Change retention.', 'backlog')`);
  return db;
}

test('SAFE-10 the knowledge tools themselves expose no write path', async () => {
  const names = (await getToolDefinitions()).map((t) => t.function.name);
  assert.ok(names.includes('read_knowledge_record') && names.includes('search_knowledge_base'));
  const { executeToolCall } = await import('../src/ai/chatTools.js');
  const db = await seed();
  const { pool, writes, failedReads } = recordingPool(db);
  const before = await snapshotAllTables(db);
  try {
    for (const call of READ_CALLS) await executeToolCall(pool, call.name, JSON.stringify(call.args), undefined, { sessionId: SESSION });
    assert.deepEqual(writes, [], 'no write statement was issued');
    assert.equal(await snapshotAllTables(db), before, 'every table is byte-for-byte unchanged');
    assert.deepEqual(failedReads.filter((q) => /knowledge_indexing_work/.test(q)), []);
  } finally { await db.close(); }
});

test('SAFE-10 a full cross-source turn in read-only mode reaches no write path, even when the model tries', async () => {
  const db = await seed();
  const { pool, writes } = recordingPool(db);
  const before = await snapshotAllTables(db);
  const fetchSpy = mock.method(globalThis, 'fetch', () => { throw new Error('network is not reachable in read-only turns'); });
  const model = scriptModel((round, index) => {
    if (index === 0) return [...READ_CALLS, ...WRITE_ATTEMPTS];
    const results = toolResults(round);
    const attempts = results.slice(READ_CALLS.length);
    assert.equal(attempts.length, WRITE_ATTEMPTS.length);
    for (const result of attempts) assert.ok(JSON.stringify(result).toLowerCase().includes('error'), `write attempt must be refused: ${JSON.stringify(result)}`);
    return 'Read everything; changed nothing.';
  });
  const called: string[] = [];
  try {
    const reply = await handleConversationTurn(pool, [], 'Summarise everything about retention', 'standard', 'general', SESSION,
      undefined, (name) => { called.push(name); }, {}, { contextUsed: emptyContextUsed(), readOnlyTools: true });
    assert.equal(reply, 'Read everything; changed nothing.');
    assert.equal(model.callCount(), 2, 'no model calls beyond the scripted rounds');
    const exposed = model.rounds[0]!.tools.map((t) => t.function.name);
    for (const w of WRITE_ATTEMPTS) assert.ok(!exposed.includes(w.name), `${w.name} is not exposed`);
    assert.deepEqual(writes, [], 'no write statement was issued');
    assert.equal(await snapshotAllTables(db), before, 'every table is unchanged');
    assert.equal(fetchSpy.mock.callCount(), 0, 'no outbound network call (watchlist, discovery, web)');
  } finally { model.restore(); fetchSpy.mock.restore(); await db.close(); }
});
