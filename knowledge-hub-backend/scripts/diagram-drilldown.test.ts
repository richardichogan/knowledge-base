import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { listDrilldowns, openDrilldown } from '../src/services/diagramService.js';
import { emptyDiagram } from '../src/types/diagram.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/types/errors.js';

const parentId = randomUUID();
const nodeId = randomUUID();
const childId = randomUUID();
const document = { ...emptyDiagram(), nodes: [{ id: nodeId, label: 'Runtime' }] };

function stub(options: { revision?: number; existing?: boolean; missingShape?: boolean; failInit?: boolean; type?: string } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let released = false;
  const connection = mock.method(Pool.prototype, 'connect', async () => ({
    query: async (raw: string, values: unknown[] = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();
      calls.push({ sql, values });
      if (sql.startsWith('SELECT canvas_type')) return { rows: [{ canvas_type: options.type ?? 'diagram' }] };
      if (sql.startsWith('SELECT d.revision')) return { rows: [{
        revision: options.revision ?? 4, document: options.missingShape ? emptyDiagram() : document, project: 'imagine',
      }] };
      if (sql.startsWith('SELECT d.node_id')) return { rows: options.existing ? [{ nodeId, canvasId: childId, title: 'Existing detail' }] : [] };
      if (sql.startsWith('INSERT INTO canvases')) return { rows: [{ id: childId }] };
      if (sql.startsWith('INSERT INTO canvas_diagrams') && options.failInit) throw new Error('Database write failed');
      return { rows: [] };
    },
    release: () => { released = true; },
  }));
  return { calls, released: () => released, restore: () => { connection.mock.restore(); } };
}

test('creates and associates a child in one transaction, inheriting the project and starting empty', async () => {
  const state = stub();
  try {
    assert.deepEqual(await openDrilldown(parentId, nodeId, { revision: 4 }), { nodeId, canvasId: childId, title: 'Runtime - detail' });
    assert.ok(state.calls.some(call => call.sql.includes('FOR UPDATE')));
    assert.deepEqual(state.calls.find(call => call.sql.startsWith('INSERT INTO canvases'))?.values, ['Runtime - detail', 'imagine']);
    assert.deepEqual(JSON.parse(String(state.calls.find(call => call.sql.startsWith('INSERT INTO canvas_diagrams'))?.values[1])), emptyDiagram());
    assert.deepEqual(state.calls.find(call => call.sql.startsWith('INSERT INTO diagram_drilldowns'))?.values, [parentId, nodeId, childId]);
    assert.equal(state.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(state.released(), true);
  } finally { state.restore(); }
});

test('reopening uses the existing child and never creates another canvas', async () => {
  const state = stub({ existing: true });
  try {
    assert.equal((await openDrilldown(parentId, nodeId, { revision: 4 })).title, 'Existing detail');
    assert.equal(state.calls.some(call => call.sql.startsWith('INSERT')), false);
    assert.equal(state.calls.at(-1)?.sql, 'COMMIT');
  } finally { state.restore(); }
});

test('stale revisions, removed shapes, and brainstorm canvases cannot create a child', async () => {
  for (const options of [{ revision: 5 }, { missingShape: true }, { type: 'brainstorm' }]) {
    const state = stub(options);
    try {
      await assert.rejects(openDrilldown(parentId, nodeId, { revision: 4 }), error =>
        error instanceof ConflictError || error instanceof NotFoundError);
      assert.equal(state.calls.some(call => call.sql.startsWith('INSERT')), false);
      assert.equal(state.calls.at(-1)?.sql, 'ROLLBACK');
      assert.equal(state.released(), true);
    } finally { state.restore(); }
  }
});

test('a failed child initialization rolls back without leaving an orphan association', async () => {
  const state = stub({ failInit: true });
  try {
    await assert.rejects(openDrilldown(parentId, nodeId, { revision: 4 }), /Database write failed/);
    assert.equal(state.calls.some(call => call.sql.startsWith('INSERT INTO diagram_drilldowns')), false);
    assert.equal(state.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(state.released(), true);
  } finally { state.restore(); }
});

test('invalid identities and request bodies fail before opening a transaction', async () => {
  const state = stub();
  try {
    for (const body of [null, [], {}, { revision: -1 }, { revision: 4, canvasId: childId }]) {
      await assert.rejects(openDrilldown(parentId, nodeId, body), ValidationError);
    }
    await assert.rejects(openDrilldown(parentId, 'bad-id', { revision: 4 }), ValidationError);
    assert.equal(state.calls.length, 0);
  } finally { state.restore(); }
});

test('listing retains associations for undo and excludes deleted child canvases', async () => {
  const query = mock.method(Pool.prototype, 'query', async (sql: string, values: unknown[]) => {
    assert.equal(values[0], parentId);
    if (sql.startsWith('SELECT canvas_type')) return { rows: [{ canvas_type: 'diagram' }] };
    assert.ok(sql.includes('WHERE d.canvas_id = $1'));
    assert.ok(sql.includes('JOIN canvases c ON c.id = d.child_canvas_id'));
    return { rows: [{ nodeId, canvasId: childId, title: 'Runtime detail' }] };
  });
  try { assert.deepEqual(await listDrilldowns(parentId), [{ nodeId, canvasId: childId, title: 'Runtime detail' }]); }
  finally { query.mock.restore(); }
});
