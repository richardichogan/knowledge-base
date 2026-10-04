import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { executeToolCall } from '../src/ai/chatTools.js';
import { selectRequiredToolChoice } from '../src/ai/toolRouting.js';
import { describeToolActivity } from '../src/ai/turnActivity.js';
import type { LlmToolDefinition } from '../src/ai/foundryClient.js';

const savedSpark = {
  id: 'spark-id', sourceId: null, sourceType: null, body: 'A thought worth keeping.',
  tags: [], clusterId: null, createdAt: '2026-10-04T20:00:00.000Z',
};

test('chat creates a standalone Spark through the existing service and triggers clustering', async () => {
  const db = new Pool();
  const queries: string[] = [];
  mock.method(db, 'query', async (sql: string, values: unknown[]) => {
    queries.push(sql);
    if (!sql.includes('INSERT INTO sparks')) return { rows: [] };
    assert.deepEqual(values, [null, null, savedSpark.body, []]);
    return { rows: [{
      id: savedSpark.id, source_id: null, source_type: null, body: savedSpark.body,
      tags: [], cluster_id: null, created_at: savedSpark.createdAt,
    }] };
  });
  const result = await executeToolCall(db, 'create_spark', JSON.stringify({ body: `  ${savedSpark.body}  ` }));
  assert.deepEqual(result, {
    created: true, spark: savedSpark,
    note: 'Saved in Sparks in the Think section. Confirm briefly using the saved body.',
  });
  assert.ok(queries.some((sql) => sql.includes('INSERT INTO sparks')));
  assert.ok(queries.some((sql) => sql.includes("t.role = 'concept'")));
});

test('captures requested source attachment and normalises tag names, not IDs', async () => {
  const db = new Pool();
  mock.method(db, 'query', async (sql: string, values: unknown[]) => {
    if (!sql.includes('INSERT INTO sparks')) return { rows: [] };
    assert.deepEqual(values, ['article-id', 'discover_item', 'Keep this idea', ['AI', 'Copilot']]);
    return { rows: [{
      id: savedSpark.id, source_id: 'article-id', source_type: 'discover_item', body: 'Keep this idea',
      tags: ['AI', 'Copilot'], cluster_id: null, created_at: savedSpark.createdAt,
    }] };
  });
  const result = await executeToolCall(db, 'create_spark', JSON.stringify({
    body: 'Keep this idea', sourceId: ' article-id ', sourceType: ' discover_item ',
    tags: [' AI ', 'AI', 'Copilot'],
  }), 'active-project');
  assert.ok(result !== null && typeof result === 'object' && 'created' in result && result.created === true);
});

test('invalid arguments never insert a Spark', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => {
    assert.fail('Invalid input must not reach the database');
  });
  const invalidInputs = [
    {}, { body: '' }, { body: '  ' }, { body: 42 },
    { body: 'Idea', tags: 'AI' }, { body: 'Idea', tags: [12] },
    { body: 'Idea', tags: [' '] }, { body: 'Idea', tags: null },
    { body: 'Idea', sourceId: 'source' }, { body: 'Idea', sourceType: 'note' },
    { body: 'Idea', sourceId: 12, sourceType: 'note' },
    { body: 'Idea', sourceId: 'source', sourceType: {} },
    { body: 'Idea', sourceId: '', sourceType: 'note' },
    { body: 'Idea', sourceId: 'source', sourceType: ' ' },
  ];
  for (const input of invalidInputs) {
    const result = await executeToolCall(db, 'create_spark', JSON.stringify(input));
    assert.ok(result !== null && typeof result === 'object' && 'error' in result, JSON.stringify(input));
    assert.ok(!('created' in result));
  }
  assert.equal(query.mock.callCount(), 0);
});

test('database failures propagate instead of claiming a Spark was saved', async () => {
  const db = new Pool();
  mock.method(db, 'query', async () => { throw new Error('database unavailable'); });
  await assert.rejects(
    executeToolCall(db, 'create_spark', '{"body":"Keep this"}'),
    /database unavailable/,
  );
});

test('Spark requests do not force edits to the open note or canvas', () => {
  const tools: LlmToolDefinition[] = ['create_spark', 'propose_note_edit', 'propose_map_changes'].map((name) => ({
    type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
  }));
  for (const message of ['Save this as a spark', 'Create a spark from this note', 'Put this idea in Sparks']) {
    assert.equal(selectRequiredToolChoice(message, tools, [], null, true, true), undefined);
  }
  assert.deepEqual(selectRequiredToolChoice('Rewrite this note', tools, [], null, true), {
    type: 'function', function: { name: 'propose_note_edit' },
  });
  assert.equal(describeToolActivity('create_spark', '{"body":"An idea"}'), 'Saving a Spark');
});
