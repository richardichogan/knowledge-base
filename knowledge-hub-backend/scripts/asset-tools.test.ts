import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { DiagramDocument } from '../src/types/diagram.js';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { addToDiagram, executeAssetTool, getAssetToolDefinitions, isAssetTool, layoutColumns, ASSET_WRITE_TOOLS } = await import('../src/ai/assetTools.js');

const EMPTY: DiagramDocument = { schemaVersion: 1, nodes: [], edges: [] } as unknown as DiagramDocument;

async function database(): Promise<Pool> {
  const pg = new PGlite();
  const schema = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const projects = /CREATE TABLE IF NOT EXISTS projects \([\s\S]*?\n\);/.exec(schema)?.[0];
  assert.ok(projects);
  await pg.exec(projects);
  await pg.exec(await readFile(new URL('../src/db/migrations/051_discovery_sources.sql', import.meta.url), 'utf8'));
  await pg.exec(`CREATE TABLE sparks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL, tags text[] NOT NULL DEFAULT '{}');
    CREATE TABLE content_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text, title text, url text, workflow_state text, metadata jsonb NOT NULL DEFAULT '{}');`);
  return pg as unknown as Pool;
}

test('every asset tool has a definition and is treated as a write tool', () => {
  const names = getAssetToolDefinitions().map((t) => t.function.name).sort();
  assert.deepEqual(names, [...ASSET_WRITE_TOOLS].sort());
  assert.ok(isAssetTool('create_diagram'));
  assert.ok(!isAssetTool('create_note_draft'));
});

test('layout puts each shape one column after what feeds it', () => {
  const cols = layoutColumns(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'd' }, { from: 'c', to: 'a' }]);
  assert.ok([...cols.values()].every((c) => c >= 0 && c < 4)); // the cycle is bounded
  const straight = layoutColumns(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
  assert.deepEqual([...straight.values()], [0, 1, 2]);
});

test('adding to a diagram creates shapes, connectors by key or label, and description footnotes', () => {
  const first = addToDiagram(EMPTY, [
    { key: 'ui', label: 'Web app', kind: 'process', colour: 'blue', footnote: true, description: 'React front end' },
    { key: 'api', label: 'API', kind: 'process', colour: 'green', footnote: false },
  ], [{ from: 'ui', to: 'api', label: 'calls', dashed: false }]);
  assert.deepEqual(first.problems, []);
  assert.equal(first.doc.nodes.length, 2);
  const [ui, api] = first.doc.nodes;
  assert.equal(ui!.stroke, '#0f62fe');
  assert.ok(api!.x > ui!.x);
  assert.equal(first.doc.edges[0]!.sourceId, ui!.id);
  assert.equal(first.doc.footnotes?.[0]?.targetId, ui!.id);

  const second = addToDiagram(first.doc, [{ key: 'db', label: 'Database', kind: 'process', colour: 'purple', footnote: false }],
    [{ from: 'API', to: 'db', label: '', dashed: true }, { from: 'Nowhere', to: 'db', label: '', dashed: false }]);
  assert.equal(second.doc.nodes.length, 3);
  assert.ok(second.doc.nodes[2]!.x > api!.x);
  assert.equal(second.doc.edges.length, 2);
  assert.deepEqual(second.problems, ['Shape "Nowhere" not found.']);
  assert.equal(first.doc.nodes.length, 2, 'original document is not mutated');
});

test('projects, Discover sources, articles and Sparks can be changed', async () => {
  const db = await database();

  const created = await executeAssetTool(db, 'create_project', { name: 'Contoso Pilot', importance: 'high', goal: 'Land the pilot', tags: ['azure', 'azure'] }) as Record<string, unknown>;
  assert.equal(created['success'], true);
  assert.deepEqual(created['project'], { id: 'contoso-pilot', name: 'Contoso Pilot' });
  const dup = await executeAssetTool(db, 'create_project', { name: 'contoso pilot' }) as Record<string, unknown>;
  assert.match(String(dup['error']), /already exists/);
  const updated = await executeAssetTool(db, 'update_project', { projectId: 'Contoso Pilot', priority: 'high', lifecycleState: 'paused', importance: 'bogus' }) as Record<string, unknown>;
  assert.deepEqual(updated['changed'], ['priority', 'lifecycle_state']);
  const project = (await db.query<{ priority: string; lifecycle_state: string; importance: string; tags: string[] }>(`SELECT priority, lifecycle_state, importance, tags FROM projects`)).rows[0];
  assert.deepEqual(project, { priority: 'high', lifecycle_state: 'paused', importance: 'high', tags: ['azure'] });

  await db.query(`INSERT INTO discovery_sources (title, feed_url, is_active, last_error) VALUES ('Azure Blog', 'https://azure.example/feed', false, 'timeout')`);
  const source = await executeAssetTool(db, 'update_discover_source', { sourceId: 'azure blog', active: true, groupName: 'Microsoft' }) as Record<string, unknown>;
  assert.deepEqual(source['source'], { id: (source['source'] as { id: string }).id, title: 'Azure Blog', group: 'Microsoft', active: true });
  assert.equal((await db.query<{ last_error: string | null }>(`SELECT last_error FROM discovery_sources`)).rows[0]?.last_error, null);
  const badFeed = await executeAssetTool(db, 'add_discover_source', { title: 'x', feedUrl: 'not a url' }) as Record<string, unknown>;
  assert.ok('error' in badFeed);

  await db.query(`INSERT INTO content_items (source, title, url, workflow_state) VALUES ('discovered-article', 'Agents GA', 'https://news.example/agents', 'shelved')`);
  const restored = await executeAssetTool(db, 'set_discover_item_state', { itemId: 'https://news.example/agents/', state: 'to-review' }) as Record<string, unknown>;
  assert.equal(restored['success'], true);
  const article = (await db.query<{ workflow_state: string; metadata: Record<string, unknown> }>(`SELECT workflow_state, metadata FROM content_items`)).rows[0];
  assert.equal(article?.workflow_state, 'to-review');
  assert.ok(typeof article?.metadata['restoredAt'] === 'string');

  const spark = (await db.query<{ id: string }>(`INSERT INTO sparks (body) VALUES ('old idea') RETURNING id::text`)).rows[0]!;
  const sparked = await executeAssetTool(db, 'update_spark', { sparkId: spark.id, tags: ['imagine'] }) as Record<string, unknown>;
  assert.deepEqual(sparked['spark'], { id: spark.id, body: 'old idea', tags: ['imagine'] });
});

test('the note open beside the chat must go through a reviewed edit', async () => {
  const db = await database();
  const result = await executeAssetTool(db, 'update_note', { noteId: 'n1', content: 'x' }, 'n1') as Record<string, unknown>;
  assert.match(String(result['error']), /propose_note_edit/);
});
