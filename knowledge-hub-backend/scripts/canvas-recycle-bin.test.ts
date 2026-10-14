import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import {
  deleteCanvas, listCanvases, listDeletedCanvases, permanentlyDeleteCanvas, restoreCanvas,
} from '../src/services/canvasService.js';

const canvasId = randomUUID();
const row = {
  id: canvasId, title: 'Agentic SDLC', description: null, project: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  deleted_at: new Date().toISOString(), canvas_type: 'diagram', linked_notes: [], node_count: 15,
  parent_canvas_id: null, parent_shape_label: null,
};

test('active and recycled lists are mutually exclusive', async () => {
  const calls: string[] = [];
  const query = mock.method(Pool.prototype, 'query', async (raw: string) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    calls.push(sql);
    return { rows: sql.includes('deleted_at IS NOT NULL') ? [row] : [] };
  });
  try {
    assert.deepEqual(await listCanvases(), []);
    const recycled = await listDeletedCanvases();
    assert.equal(recycled[0]?.title, 'Agentic SDLC');
    assert.equal(recycled[0]?.deletedAt, row.deleted_at);
    assert.ok(calls.some(sql => sql.includes('WHERE c.deleted_at IS NULL')));
    assert.ok(calls.some(sql => sql.includes('WHERE c.deleted_at IS NOT NULL')));
  } finally { query.mock.restore(); }
});

test('delete moves a canvas to the recycle bin without deleting dependent data', async () => {
  const calls: string[] = [];
  const connection = mock.method(Pool.prototype, 'connect', async () => ({
    query: async (raw: string) => { calls.push(raw.replace(/\s+/g, ' ').trim()); return { rows: [] }; },
    release: () => undefined,
  }));
  try {
    await deleteCanvas(canvasId);
    assert.ok(calls.some(sql => sql.startsWith('UPDATE canvases SET deleted_at = COALESCE')));
    assert.ok(calls.some(sql => sql.startsWith("DELETE FROM nodes WHERE ref_id")));
    assert.equal(calls.some(sql => /^DELETE FROM canvases/.test(sql)), false);
    assert.equal(calls.at(-1), 'COMMIT');
  } finally { connection.mock.restore(); }
});

test('restore is retry-safe when the first acknowledgement is lost', async () => {
  const calls: string[] = [];
  const query = mock.method(Pool.prototype, 'query', async (raw: string) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    calls.push(sql);
    if (sql.startsWith('UPDATE canvases SET deleted_at = NULL')) return { rows: [] };
    if (sql.includes('WHERE c.id = $1 AND c.deleted_at IS NULL')) return { rows: [{ ...row, deleted_at: null }] };
    return { rows: [] };
  });
  try {
    const result = await restoreCanvas(canvasId);
    assert.equal(result?.restored, false);
    assert.equal(result?.canvas.deletedAt, null);
    assert.ok(calls[0]?.includes('deleted_at IS NOT NULL'));
  } finally { query.mock.restore(); }
});

test('permanent delete only removes a canvas already in the recycle bin', async () => {
  for (const found of [false, true]) {
    const calls: string[] = [];
    const connection = mock.method(Pool.prototype, 'connect', async () => ({
      query: async (raw: string) => {
        const sql = raw.replace(/\s+/g, ' ').trim();
        calls.push(sql);
        return { rows: sql.startsWith('DELETE FROM canvases') && found ? [{ id: canvasId }] : [] };
      },
      release: () => undefined,
    }));
    try {
      assert.equal(await permanentlyDeleteCanvas(canvasId), found);
      assert.ok(calls.some(sql => sql.includes('DELETE FROM canvases WHERE id = $1 AND deleted_at IS NOT NULL')));
      assert.equal(calls.at(-1), found ? 'COMMIT' : 'ROLLBACK');
    } finally { connection.mock.restore(); }
  }
});
