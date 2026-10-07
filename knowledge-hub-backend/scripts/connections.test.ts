import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Client, Pool } from 'pg';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { runInferredEdgeJob, selectRelatedCandidates } from '../src/jobs/inferredEdgeJob.js';
import { syncAllNodes } from '../src/services/nodeService.js';
import { createSpark, deleteSpark } from '../src/services/sparkService.js';

test('inference only accepts supplied candidates with a reason and adequate confidence', () => {
  const related = [
    { candidate_id: 'note', confidence: 0.9, reason: ' Explains the task architecture. ' },
    { candidate_id: 'unknown', confidence: 1, reason: 'Invented target' },
    { candidate_id: 'task', confidence: 0.69, reason: 'Broad overlap' },
    { candidate_id: 'task', confidence: 0.9, reason: ' ' },
    { candidate_id: 'task', confidence: 1.1, reason: 'Invalid score' },
    { candidate_id: 'note', confidence: 0.8, reason: 'Duplicate' },
    null,
  ];
  assert.deepEqual(selectRelatedCandidates(JSON.stringify({ related }), new Set(['note', 'task'])),
    [{ candidate_id: 'note', confidence: 0.9, reason: 'Explains the task architecture.' }]);
  assert.throws(() => selectRelatedCandidates('{"related":null}', new Set()), /must be an array/);
  assert.deepEqual(selectRelatedCandidates('{"related":[]}', new Set()), []);
  const many = Array.from({ length: 8 }, (_, i) => ({ candidate_id: String(i), confidence: 0.7 + i * 0.02, reason: 'Concrete evidence' }));
  const selected = selectRelatedCandidates(JSON.stringify({ related: many }), new Set(many.map(r => r.candidate_id)));
  assert.equal(selected.length, 5);
  assert.equal(selected[0]?.candidate_id, '7');
});

test('existing node sync includes GitHub issues, PRs and other indexed GitHub activity', async () => {
  const db = new Pool();
  const writes: unknown[][] = [];
  const query = mock.method(db, 'query', async (sql: string, values: unknown[]) => {
    if (sql.startsWith('INSERT INTO nodes')) {
      writes.push(values);
      return { rows: [{ id: 'graph-id' }] };
    }
    if (sql.includes("ELSE 'github_item'")) {
      assert.match(sql, /github-issue/);
      assert.match(sql, /github-pr-review/);
      return { rows: ['issue', 'pull_request', 'github_item'].map(ref_type => ({ id: ref_type, ref_type, title: 'Context', tags: ['AI'] })) };
    }
    return { rows: [] };
  });
  try {
    await syncAllNodes(db);
    assert.deepEqual(writes.map(values => values[1]).sort(), ['github_item', 'issue', 'pull_request']);
  } finally { query.mock.restore(); await db.end(); }
});

test('existing inference uses real content across types and balances candidate selection', async () => {
  const db = new Pool();
  const source = { id: 'source', ref_id: 'note-ref', ref_type: 'note', title: 'Architecture' };
  const candidates = ['task', 'discover_item', 'issue', 'pull_request', 'commit'].map(ref_type => ({
    id: ref_type, ref_id: `${ref_type}-ref`, ref_type, title: ref_type,
  }));
  const writes: unknown[][] = [];
  const query = mock.method(db, 'query', async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT id, ref_id, ref_type, title FROM nodes')) return { rows: [source] };
    if (sql.includes('ROW_NUMBER()')) {
      assert.match(sql, /PARTITION BY n.ref_type/);
      assert.match(sql, /ORDER BY type_rank/);
      return { rows: candidates };
    }
    if (sql.includes('FROM notes')) return { rows: [{ content: JSON.stringify({
      title: 'Architecture', contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'Private networking architecture' }] }]),
    }) }] };
    if (sql.includes('FROM tasks')) return { rows: [{ description: 'Implement private endpoints' }] };
    if (sql.includes('FROM content_items')) return { rows: [{ body: `Concrete content for ${String(values[0])}` }] };
    if (sql.startsWith('INSERT INTO edges')) { writes.push(values); return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const chat = mock.method(FoundryClient.prototype, 'chat', async (_model: string, messages: Array<{ content: string }>) => {
    const payload = JSON.parse(messages[1]!.content) as { source: { summary: string }; candidates: Array<{ summary: string }> };
    assert.equal(payload.source.summary, 'Private networking architecture');
    assert.match(payload.candidates[0]!.summary, /Implement private endpoints/);
    for (const item of payload.candidates.slice(1)) assert.match(item.summary, /Concrete content/);
    return JSON.stringify({ related: [{ candidate_id: 'task', confidence: 0.9, reason: 'The task implements the private networking design in this note.' }] });
  });
  try {
    await runInferredEdgeJob(db);
    assert.equal(chat.mock.callCount(), 1);
    assert.equal(writes.length, 1);
    assert.match(String(writes[0]?.[4]), /implements the private networking/);
  } finally { chat.mock.restore(); query.mock.restore(); await db.end(); }
});

test('Spark creation commits its graph node and original-source connection together', async () => {
    const db = new Pool();
    let released = false;
    const client = Object.assign(new Client(), { release: () => { released = true; } });
    const calls: string[] = [];
    const connect = mock.method(db, 'connect', async () => client);
    const background = mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }));
    const query = mock.method(client, 'query', async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.startsWith('INSERT INTO sparks')) {
        assert.deepEqual(values, ['note-ref', 'note', 'Selected idea', []]);
        return { rows: [{ id: 'spark-ref', source_id: 'note-ref', source_type: 'note', body: 'Selected idea', tags: [], cluster_id: null, created_at: '2026-10-07' }] };
      }
      if (sql.startsWith('INSERT INTO nodes')) return { rows: [{ id: 'spark-node' }] };
      if (sql.startsWith('SELECT id FROM nodes')) return { rows: [{ id: 'note-node' }] };
      if (sql.startsWith('INSERT INTO edges')) {
        assert.deepEqual(values?.slice(0, 4), ['spark-node', 'note-node', 'has_spark', 1]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    try {
      const spark = await createSpark(db, { body: 'Selected idea', sourceId: 'note-ref', sourceType: 'note' });
      assert.equal(spark.sourceId, 'note-ref');
      assert.equal(calls[0], 'BEGIN');
      assert.equal(calls.at(-1), 'COMMIT');
      assert.equal(released, true);
      await new Promise(resolve => setImmediate(resolve));
    } finally { query.mock.restore(); background.mock.restore(); connect.mock.restore(); await db.end(); }
  });

  test('failed Spark graph write rolls back capture; deleting a Spark removes its graph node', async () => {
    const db = new Pool();
    const client = Object.assign(new Client(), { release: () => {} });
    const connect = mock.method(db, 'connect', async () => client);
    const calls: string[] = [];
    const query = mock.method(client, 'query', async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('INSERT INTO sparks')) return { rows: [{ id: 'spark-ref', body: 'Idea', tags: [], source_id: null, source_type: null, cluster_id: null, created_at: '2026-10-07' }] };
      if (sql.startsWith('INSERT INTO nodes')) throw new Error('Graph unavailable');
      return { rows: [], rowCount: 1 };
    });
    try {
      await assert.rejects(createSpark(db, { body: 'Idea' }), /Graph unavailable/);
      assert.equal(calls.at(-1), 'ROLLBACK');
      assert.equal(calls.includes('COMMIT'), false);
      calls.length = 0;
      await deleteSpark(db, 'spark-ref');
      assert.match(calls[2]!, /DELETE FROM nodes WHERE ref_id/);
      assert.equal(calls.at(-1), 'COMMIT');
    } finally { query.mock.restore(); connect.mock.restore(); await db.end(); }
  });
