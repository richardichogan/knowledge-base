import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { ContentItem } from '../src/types/contentItem.js';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { searchKnowledgeGraph, graphConnectionsFor, formatGraphConnections, graphTerms } = await import('../src/ai/graphInference.js');

const ID = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

async function graph(): Promise<Pool> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE nodes (id uuid PRIMARY KEY, ref_id text, ref_type text, title text, tags text[] NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT now());
    CREATE TABLE edges (source_node_id uuid, target_node_id uuid, edge_type text, confidence numeric(3,2));
    CREATE TABLE content_items (id uuid PRIMARY KEY, source text, source_id text, project_context text);
    CREATE TABLE tasks (id uuid PRIMARY KEY, project_id text);
    INSERT INTO content_items VALUES ('${ID(101)}', 'note', 'note-1', 'ibm-thought-leadership'),
      ('${ID(102)}', 'github-doc', 'x', 'imagine'), ('${ID(103)}', 'discovered-article', 'y', 'msft-blog');
    INSERT INTO tasks VALUES ('${ID(104)}', 'reckitt');
    INSERT INTO nodes (id, ref_id, ref_type, title, tags) VALUES
      ('${ID(1)}', 'note-1', 'note', 'Designing agent-first platforms', '{}'),
      ('${ID(2)}', '${ID(102)}', 'document', 'IMAGINE PRD', '{}'),
      ('${ID(3)}', '${ID(103)}', 'discover_item', 'Agent platforms on Azure', '{agents}'),
      ('${ID(4)}', '${ID(104)}', 'task', 'Reckitt agent pilot plan', '{}'),
      ('${ID(5)}', 'c1', 'commit', 'fix agent platform build', '{}'),
      ('${ID(6)}', 'other', 'note', 'Unrelated gardening note', '{}');
    INSERT INTO edges VALUES
      ('${ID(1)}', '${ID(2)}', 'thematically_related', 0.85),
      ('${ID(3)}', '${ID(2)}', 'thematically_related', 0.80),
      ('${ID(4)}', '${ID(1)}', 'thematically_related', 0.75),
      ('${ID(3)}', '${ID(5)}', 'tag_overlap', 1.00),
      ('${ID(1)}', '${ID(6)}', 'thematically_related', 0.40);`);
  return pg as unknown as Pool;
}

test('terms drop filler words', () => {
  assert.deepEqual(graphTerms('How does agent-first relate to the IMAGINE platform?'), ['agent-first', 'imagine', 'platform']);
});

test('search ranks connections, spans projects and finds bridges', async () => {
  const db = await graph();
  const result = await searchKnowledgeGraph(db, 'agent platforms', 10) as {
    results: Array<{ title: string; project: string | null; connections: Array<{ title: string; type: string; project: string | null; confidence: number }> }>;
    bridges: Array<{ title: string; project: string | null; links: string[] }>;
    projectsSpanned: string[];
  };
  const titles = result.results.map((r) => r.title);
  assert.equal(titles[0], 'Agent platforms on Azure', 'whole-phrase match first');
  assert.ok(titles.includes('Designing agent-first platforms'), 'every word matches');
  assert.ok(!titles.includes('Unrelated gardening note'));
  const azure = result.results.find((r) => r.title === 'Agent platforms on Azure')!;
  assert.equal(azure.project, 'msft-blog');
  assert.equal(azure.connections[0]?.title, 'IMAGINE PRD', 'own material before commit noise');
  assert.equal(azure.connections.at(-1)?.type, 'commit');
  assert.ok(result.projectsSpanned.includes('imagine'));

  const linked = await searchKnowledgeGraph(db, 'platforms', 10) as typeof result;
  const prd = linked.bridges.find((b) => b.title === 'IMAGINE PRD');
  assert.ok(prd !== undefined, 'the PRD links two matches');
  assert.equal(prd.project, 'imagine');
  assert.equal(prd.links.length, 2);
  const note = linked.results.find((r) => r.title === 'Designing agent-first platforms')!;
  assert.equal(note.project, 'ibm-thought-leadership');
  assert.ok(!note.connections.some((c) => c.title === 'Unrelated gardening note'), 'weak links are dropped');
  assert.equal(note.connections.find((c) => c.type === 'task')?.project, 'reckitt');
});

test('retrieved items bring their graph neighbours from other projects into context', async () => {
  const db = await graph();
  const items = [{ id: ID(101), source: 'note', sourceId: 'note-1', title: 'Designing agent-first platforms' }] as unknown as ContentItem[];
  const connections = await graphConnectionsFor(db, items);
  assert.deepEqual(connections.map((c) => c.title), ['Reckitt agent pilot plan', 'IMAGINE PRD']);
  const text = formatGraphConnections(connections);
  assert.match(text, /document: "IMAGINE PRD" \[project: imagine\] — linked to "Designing agent-first platforms"/);
  assert.equal(formatGraphConnections([]), '');
});
