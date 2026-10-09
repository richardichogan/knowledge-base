import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobClient } from '@azure/storage-blob';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PGlite } from '@electric-sql/pglite';
import { diagramEvidence, findDiagramContext, DIAGRAM_READING_GUIDANCE } from '../src/services/diagramContext.js';
import { emptyDiagram, type DiagramNode, type DiagramDocument } from '../src/types/diagram.js';
import { selectRequiredToolChoice } from '../src/ai/toolRouting.js';
import { emptyContextUsed, filterExcluded, recordToolSources } from '../src/ai/contextUsage.js';

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const makeNode = (id: string, kind: DiagramNode['kind'], label: string, parentId: string | null = null): DiagramNode => ({
  id, kind, label, parentId, description: `${label} description`, x: 20, y: 20, width: 100, height: 100,
  fill: '#262626', stroke: '#aaa', textColor: '#fff', fontSize: 16, assetId: null,
});
const diagram: DiagramDocument = {
  ...emptyDiagram(), nodes: [makeNode(a, 'container', 'Claims platform'), makeNode(b, 'document', 'Decision artefact', a),
    makeNode(c, 'line', 'Decoration')],
  edges: ['end', 'both', 'none'].map((arrows, i) => ({
    id: `edge-${i}`, sourceId: a, targetId: b, sourcePort: 'bottom', targetPort: 'top',
    route: 'straight', waypoints: [], label: 'Produces', description: 'Approved result', stroke: '#fff',
    dashed: false, arrows: arrows as 'end' | 'both' | 'none',
  })),
};

test('structured evidence preserves artefacts, containment, direction, selection and decorative lines', () => {
  const evidence = JSON.parse(diagramEvidence(diagram, 24_000, b));
  assert.equal(evidence.shapes.find((n: DiagramNode) => n.id === b).parentId, a);
  assert.equal(evidence.shapes.find((n: DiagramNode) => n.id === b).kind, 'document');
  assert.equal(evidence.shapes[0].selected, true);
  assert.deepEqual(evidence.connectors.map((e: { arrows: string }) => e.arrows), ['end', 'both', 'none']);
  assert.equal(evidence.connectors[0].description, 'Approved result');
  assert.equal(evidence.shapes.find((n: DiagramNode) => n.id === c).kind, 'line');
  assert.equal(evidence.omittedShapes, 0);
  assert.equal(evidence.omittedConnectors, 0);
  assert.match(DIAGRAM_READING_GUIDANCE, /not connectors/);
  assert.match(DIAGRAM_READING_GUIDANCE, /pixels have not been analysed/);
  assert.match(DIAGRAM_READING_GUIDANCE, /cannot modify diagrams/);
  const selectedEdge = JSON.parse(diagramEvidence(diagram, 24_000, 'edge-1'));
  assert.equal(selectedEdge.connectors[1].selected, true);
});

test('bounded evidence flags missing records and shortened text without breaking JSON', () => {
  const large = { ...diagram, nodes: Array.from({ length: 100 }, (_, i) => ({
    ...makeNode(`node-${i}`, 'process', 'Very long '.repeat(1000)), description: 'Details '.repeat(2000),
  })) };
  const text = diagramEvidence(large, 2500, 'node-99');
  assert.ok(text.length <= 2500);
  const evidence = JSON.parse(text);
  assert.ok(evidence.omittedShapes > 0);
  assert.equal(evidence.truncatedDetails, true);
  const empty = JSON.parse(diagramEvidence(emptyDiagram()));
  assert.deepEqual(empty.shapes, []);
  assert.deepEqual(empty.connectors, []);
});

test('SQL retrieves saved structure across diagrams, matches metadata and notes, enforces project scope, and never writes', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE canvases (id text, title text, description text, project text, canvas_type text, updated_at timestamptz);
      CREATE TABLE canvas_diagrams (canvas_id text, revision integer, document jsonb, updated_at timestamptz);
      CREATE TABLE canvas_notes (canvas_id text, note_id text, created_at timestamptz);
      CREATE TABLE notes (id text, content text, status text, project_id text);
      CREATE TABLE canvas_diagram_assets (canvas_id text, id text, name text);`);
    for (const [id, project, type] of [[a, 'imagine', 'diagram'], [b, 'different', 'diagram'], [c, null, 'diagram'], ['brainstorm', 'imagine', 'brainstorm']]) {
      await pg.query('INSERT INTO canvases VALUES ($1, $2, $3, $4, $5, now())', [id, `Architecture ${id}`, 'Saved architecture', project, type]);
      await pg.query('INSERT INTO canvas_diagrams VALUES ($1, 7, $2, now())', [id, JSON.stringify(diagram)]);
    }
    await pg.query('INSERT INTO notes VALUES ($1, $2, $3, $4)', ['note-one',
      JSON.stringify({ title: 'Underwriting context', contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'Risk review requirements' }] }]) }), 'active', 'imagine']);
    await pg.query('INSERT INTO canvas_notes VALUES ($1, $2, now())', [c, 'note-one']);
    await pg.query('INSERT INTO canvas_diagram_assets VALUES ($1, $2, $3)', [a, 'icon-one', 'Azure Service Bus.svg']);
    const reads: string[] = [];
    const db = { query: async (sql: string, params: unknown[]) => {
      reads.push(sql); return pg.query(sql, params);
    } } as unknown as Pool;
    const found = await findDiagramContext(db, { query: 'Decision artefact', projectId: 'imagine' });
    assert.deepEqual(new Set(found.results.map(r => r.id)), new Set([a, c]));
    assert.equal(found.resultCount, 2);
    assert.equal((await findDiagramContext(db, { query: 'Approved result' })).resultCount, 3);
    const linked = await findDiagramContext(db, { query: 'Underwriting', projectId: 'imagine' });
    assert.equal(linked.resultCount, 1);
    assert.equal(linked.results[0]?.id, c);
    assert.match(linked.results[0]!.content, /Risk review requirements/);
    const one = await findDiagramContext(db, { diagramId: a, projectId: 'imagine', selectedId: b });
    assert.equal(one.results[0]?.url, `/think?mapId=${a}`);
    assert.match(one.results[0]!.content, /Service Bus.svg/);
    assert.match(one.results[0]!.content, /"revision":7/);
    assert.equal((await findDiagramContext(db, { diagramId: b, projectId: 'imagine' })).resultCount, 0);
    assert.equal((await findDiagramContext(db, { query: 'no such phrase' })).resultCount, 0);
    assert.equal((await findDiagramContext(db, { query: '', limit: 1 })).resultCount, 1);
    assert.equal((await findDiagramContext(db, { query: '', excludedIds: new Set([a, b, c]) })).resultCount, 0);
    const withoutNote = await findDiagramContext(db, { diagramId: c, excludedIds: new Set(['note-one']) });
    assert.ok(!withoutNote.results[0]!.content.includes('Risk review requirements'));
    assert.ok(reads.every(sql => /^\s*SELECT/.test(sql)));
  } finally { await pg.close(); }
});

test('diagram tools dispatch project scope, route comparisons, record sources and respect exclusions', async () => {
  process.env['DATABASE_URL'] = 'postgresql://isolated.invalid/offline';
  const { executeToolCall } = await import('../src/ai/chatTools.js');
  const params: unknown[][] = [];
  const db = { query: async (_sql: string, values: unknown[]) => {
    params.push(values); return { rows: [] };
  } } as unknown as Pool;
  await executeToolCall(db, 'search_diagrams', '{"query":"claims","projectId":"different","limit":999}', 'imagine');
  assert.deepEqual(params[0], [null, 'imagine', 'claims', 5, []]);
  const missing = await executeToolCall(db, 'read_diagram', JSON.stringify({ diagramId: a }), 'imagine');
  assert.deepEqual(missing, { error: 'Diagram not found in the current project scope.' });
  assert.ok('error' in (await executeToolCall(db, 'read_diagram', '{}') as object));
  const tools = [{ type: 'function' as const, function: { name: 'search_diagrams', description: 'Search', parameters: {} } }];
  assert.deepEqual(selectRequiredToolChoice('Compare these diagrams', tools, [], null, false, false, true),
    { type: 'function', function: { name: 'search_diagrams' } });
  assert.deepEqual(selectRequiredToolChoice('Find the claims diagram', tools),
    { type: 'function', function: { name: 'search_diagrams' } });
  assert.equal(selectRequiredToolChoice('Explain this diagram', tools, [], null, false, false, true), undefined);
  const result = { results: [{ id: a, title: 'Claims flow', url: `/think?mapId=${a}` }], resultCount: 1 };
  const used = emptyContextUsed();
  recordToolSources(used, 'search_diagrams', result);
  recordToolSources(used, 'read_diagram', result);
  assert.equal(used.found.length, 1);
  assert.equal(used.found[0]?.kind, 'diagram');
  assert.deepEqual(filterExcluded(result, new Set([a])), { results: [], resultCount: 0 });
});

test('actual chat prompt reads the saved diagram afresh and never exposes brainstorm editing', async t => {
  const { FoundryClient } = await import('../src/ai/foundryClient.js');
  const { handleConversationTurn } = await import('../src/ai/conversationService.js');
  const { closeDb } = await import('../src/db/db.js');
  t.mock.method(BlobClient.prototype, 'download', async () => ({ readableStreamBody: Readable.from([]) }));
  t.mock.method(Client.prototype, 'connect', async () => undefined);
  t.mock.method(Client.prototype, 'listTools', async () => ({ tools: [] }));
  let saved = diagram;
  let failReading = false;
  t.mock.method(Pool.prototype, 'query', async (sql: string) => {
    if (sql.includes('FROM canvases c JOIN canvas_diagrams')) {
      if (failReading) throw new Error('Fixture diagram read failure');
      return { rows: [{ id: a, title: 'Claims architecture', project: null, description: null, revision: 7,
        updated_at: '2026-10-09', document: saved, linked_notes: [], assets: [] }] };
    }
    if (sql.includes('FROM canvases c')) return { rows: [{ id: a, title: 'Claims architecture', canvas_type: 'diagram' }] };
    if (sql.includes("kind = 'profile'")) return { rows: [{ content: 'Fixture user profile', status: 'active' }] };
    return { rows: [] };
  });
  let prompt = '';
  t.mock.method(FoundryClient.prototype, 'chatWithTools', async (_model: unknown,
    messages: Array<{ content: string }>, tools: Array<{ function: { name: string } }>) => {
    prompt = messages.map(m => m.content).join('\n');
    assert.ok(tools.some(tool => tool.function.name === 'read_diagram'));
    assert.ok(tools.some(tool => tool.function.name === 'search_diagrams'));
    assert.ok(!tools.some(tool => tool.function.name === 'propose_map_changes'));
    assert.ok(!tools.some(tool => tool.function.name === 'propose_note_edit'));
    return { content: 'Fixture grounded reply', toolCalls: [], finishReason: 'stop' };
  });
  const db = new Pool();
  try {
    const context = { type: 'canvas', title: 'Claims architecture', selectedId: b };
    const reply = await handleConversationTurn(db, [], 'hello', 'standard', 'general', undefined, context, undefined, { noteId: `map:${a}` });
    assert.equal(reply, 'Fixture grounded reply');
    assert.match(prompt, /Decision artefact/);
    assert.match(prompt, /Saved diagram in view/);
    assert.ok(!prompt.includes('You cannot see its contents'));
    saved = { ...diagram, nodes: diagram.nodes.map(n => n.id === b
      ? { ...n, label: 'Changed saved artefact', description: 'Updated artefact description' } : n) };
    await handleConversationTurn(db, [], 'hello', 'standard', 'general', undefined, context, undefined, { noteId: `map:${a}` });
    assert.match(prompt, /Changed saved artefact/);
    assert.ok(!prompt.includes('Decision artefact'));
    await handleConversationTurn(db, [], 'hello', 'standard', 'general', undefined, undefined, undefined, { noteId: `map:${a}` });
    assert.ok(!prompt.includes('Changed saved artefact'), 'Dismissing the canvas context opts out of its contents');
    failReading = true;
    await handleConversationTurn(db, [], 'hello', 'standard', 'general', undefined, context, undefined, { noteId: `map:${a}` });
    assert.match(prompt, /could not be loaded/);
    assert.ok(!prompt.includes('Changed saved artefact'), 'A failed read must not masquerade as loaded evidence');
  } finally {
    await db.end();
    await closeDb();
  }
});
