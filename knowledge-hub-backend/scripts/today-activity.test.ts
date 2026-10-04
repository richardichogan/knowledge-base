import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { queryTimeline } from '../src/db/queries.js';

test('recent activity uses source update timestamps and filters future events before pagination', async () => {
  const db = new Pool();
  const queries: string[] = [];
  mock.method(db, 'query', async (sql: string, params: unknown[]) => {
    queries.push(sql);
    assert.match(sql, /COALESCE\(NULLIF\(metadata->>'updatedAt', ''\)::timestamptz, published_at\) > \$1/);
    assert.match(sql, /<= NOW\(\)/);
    assert.equal(params[0], '2026-10-03T10:00:00Z');
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
    assert.match(sql, /ORDER BY COALESCE\(NULLIF\(metadata->>'updatedAt', ''\)::timestamptz, published_at\) DESC/);
    assert.deepEqual(params, ['2026-10-03T10:00:00Z', 100, 0]);
    return { rows: [] };
  });
  assert.deepEqual(await queryTimeline(db, { since: '2026-10-03T10:00:00Z', pageSize: 100 }), { items: [], total: 0 });
  assert.equal(queries.length, 2);
});

test('normal timeline and before cursors preserve publication ordering', async () => {
  const db = new Pool();
  mock.method(db, 'query', async (sql: string, params: unknown[]) => {
    assert.ok(!sql.includes("metadata->>'updatedAt'"));
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
    assert.match(sql, /ORDER BY ci.published_at DESC/);
    if (params.length === 3) {
      assert.match(sql, /ci.published_at < \$1/);
      assert.deepEqual(params, ['2026-10-04T10:00:00Z', 20, 0]);
    } else assert.deepEqual(params, [20, 20]);
    return { rows: [] };
  });
  assert.deepEqual(await queryTimeline(db, { page: 2, pageSize: 20 }), { items: [], total: 0 });
  assert.deepEqual(await queryTimeline(db, { before: '2026-10-04T10:00:00Z', pageSize: 20 }), { items: [], total: -1 });
});
