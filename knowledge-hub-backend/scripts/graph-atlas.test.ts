import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Pool } from 'pg';
import { parseAtlasQuery, readGraphAtlas } from '../src/services/graphAtlas.js';

test('atlas query accepts canonical and legacy seeds and bounded options', () => {
  assert.deepEqual(parseAtlasQuery({}), { days: 365, depth: 1, seed: null, nodeTypes: [], edgeTypes: [], includeInferred: true });
  const query = parseAtlasQuery({ seed: 'note:abc-123', depth: '2', days: '3650', node_types: 'note,company', edge_types: 'mentions' });
  assert.equal(query.seed, 'note:abc-123');
  assert.equal(parseAtlasQuery({ include_inferred: 'false' }).includeInferred, false);
  assert.deepEqual(query.nodeTypes, ['note', 'company']);
  assert.equal(parseAtlasQuery({ seed: 'b6392f14-2c5a-4320-8f17-0beff0550987' }).seed, 'b6392f14-2c5a-4320-8f17-0beff0550987');
});

test('atlas rejects malformed and unbounded inputs', () => {
  for (const query of [{ depth: '3' }, { days: '0' }, { days: '3651' }, { days: '1.5' }, { seed: ['note:x'] },
    { seed: "x';DROP TABLE notes" }, { node_types: 'note);' }, { edge_types: {} }, { include_inferred: 'yes' }]) {
    assert.throws(() => parseAtlasQuery(query));
  }
});

test('atlas binds filters and exposes cap truncation without any write query', async () => {
  const db = new Pool();
  let bindings: unknown[] = [];
  const queryMock = mock.method(db, 'query', async (sql: string, params: unknown[]) => {
    bindings = params;
    assert.match(sql, /WITH RECURSIVE/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
    assert.match(sql, /type_rank<=20/);
    assert.match(sql, /'tag:'\|\|t\.id/);
    assert.match(sql, /tag_memberships AS MATERIALIZED/);
    assert.match(sql, /'tagged_with',1,jsonb_build_object\('evidence','Saved taxonomy membership'/);
    assert.match(sql, /SELECT t\.name FROM note_tags nt JOIN tags t/);
    assert.match(sql, /SELECT MIN\(depth\) FROM walk/);
    assert.doesNotMatch(sql, /use_count|TAG_OVERLAP_MAX_USES/);
    return { rows: [{ root_id: 'company:123', nodes: [], edges: [], total_nodes: 600, total_edges: 3000, matched_nodes: 501, matched_edges: 2501 }] };
  });
  try {
    const response = await readGraphAtlas(db, parseAtlasQuery({ days: '30', seed: 'company:123', node_types: 'company' }), new Date('2026-02-01T00:00:00Z'));
    assert.deepEqual(bindings, ['company:123', 1, '2026-01-02T00:00:00.000Z', ['company'], [], true]);
    assert.equal(response.stats.truncated, true);
    assert.equal(response.stats.filteredNodes, 0);
    assert.equal(response.rootId, 'company:123');
    assert.equal(queryMock.mock.callCount(), 1);
  } finally { queryMock.mock.restore(); await db.end(); }
});
