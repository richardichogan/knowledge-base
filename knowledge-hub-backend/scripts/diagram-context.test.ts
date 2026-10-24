import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobClient } from '@azure/storage-blob';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PGlite } from '@electric-sql/pglite';
import { diagramEvidence, findDiagramContext, readDiagramPage, DIAGRAM_READING_GUIDANCE } from '../src/services/diagramContext.js';
import { DIAGRAM_CALLOUT_TYPES, emptyDiagram, type DiagramNode, type DiagramDocument } from '../src/types/diagram.js';
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

test('Athena sees callout categories as annotations rather than task or approval states', () => {
  const nodes = DIAGRAM_CALLOUT_TYPES.map(type => ({ ...makeNode(`callout-${type}`, 'text', 'Review this'), calloutType: type }));
  const evidence = JSON.parse(diagramEvidence({ ...emptyDiagram(), nodes }));
  assert.deepEqual(evidence.shapes.map((n: DiagramNode) => n.calloutType), DIAGRAM_CALLOUT_TYPES);
  assert.match(DIAGRAM_READING_GUIDANCE, /not workflow states/);
  assert.match(DIAGRAM_READING_GUIDANCE, /not prove approval/);
});

test('SQL retrieves saved structure across diagrams, matches metadata and notes, enforces project scope, and never writes', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE canvases (id text, title text, description text, project text, canvas_type text, updated_at timestamptz, deleted_at timestamptz);
      CREATE TABLE canvas_diagrams (canvas_id text, revision integer, document jsonb, updated_at timestamptz);
      CREATE TABLE canvas_notes (canvas_id text, note_id text, created_at timestamptz);
      CREATE TABLE diagram_element_notes (canvas_id text, element_id text, note_id text, created_at timestamptz);
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
    const withCallout = { ...diagram, nodes: [...diagram.nodes, { ...makeNode('annotation', 'text', 'Review this'), calloutType: 'assumption' }] };
    await pg.query('UPDATE canvas_diagrams SET document = $1 WHERE canvas_id = $2', [JSON.stringify(withCallout), a]);
    const classified = await findDiagramContext(db, { query: 'assumption', projectId: 'imagine' });
    assert.deepEqual(classified.results.map(r => r.id), [a]);
    assert.match(classified.results[0]!.content, /"calloutType":"assumption"/);
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
    const { executeToolCall } = await import('../src/ai/chatTools.js');
    const clientSearch = await executeToolCall(db, 'search_diagrams', '{"query":"Claims platform"}', 'ikea') as typeof found;
    assert.equal(clientSearch.resultCount, 3);
    assert.ok(clientSearch.results.every(item => item.content.length <= 1000));
    assert.ok(JSON.stringify(clientSearch).length < 12_000, 'discovery must leave context for reading');
    const reference = await executeToolCall(db, 'read_diagram', JSON.stringify({ diagramId: a }), 'ikea') as typeof found;
    assert.equal(reference.results[0]?.project, 'imagine');
    assert.match(reference.results[0]!.content, /Decision artefact/);
    const excludedReference = await executeToolCall(db, 'read_diagram', JSON.stringify({ diagramId: a }), 'ikea', { excludedIds: new Set([a]) });
    assert.deepEqual(excludedReference, { error: 'Saved diagram not found or excluded from this conversation.' });

    const large = { ...diagram, nodes: [{ ...makeNode(a, 'process', 'Full source'), description: `${'Long diagram detail. '.repeat(6000)}TAIL-DETAIL-973` }] };
    await pg.query('UPDATE canvas_diagrams SET document=$1 WHERE canvas_id=$2', [JSON.stringify(large), a]);
    const first = await readDiagramPage(db, { diagramId: a, sessionId: b });
    assert.ok('record' in first && first.record.nextCursor !== null);
    const cursor = first.record.nextCursor;
    assert.equal(first.record.content.length, 12_000);
    assert.ok(first.record.totalChars > 48_000);
    let combined = first.record.content;
    let next = cursor;
    while (next !== null) {
      const page = await readDiagramPage(db, { diagramId: a, sessionId: b, cursor: next });
      assert.ok('record' in page);
      assert.ok(page.record.content.length <= 12_000);
      combined += page.record.content;
      next = page.record.nextCursor;
    }
    assert.equal(combined.length, first.record.totalChars);
    assert.match(combined, /TAIL-DETAIL-973/);
    await assert.rejects(readDiagramPage(db, { diagramId: a, sessionId: c, cursor }), /Cursor is invalid/);
    await assert.rejects(readDiagramPage(db, { diagramId: b, sessionId: b, cursor }), /Cursor is invalid/);
    await assert.rejects(readDiagramPage(db, { diagramId: a, sessionId: b, cursor: `${cursor}x` }), /Cursor is invalid/);
    const excludedPage = await readDiagramPage(db, { diagramId: a, sessionId: b, excludedIds: new Set([a]) });
    assert.deepEqual(excludedPage, { status: 'excluded' });
    await pg.query('UPDATE canvas_diagrams SET revision=revision+1 WHERE canvas_id=$1', [a]);
    const changed = await readDiagramPage(db, { diagramId: a, sessionId: b, cursor });
    assert.ok(changed.status === 'unavailable' && changed.code === 'version_changed');
    await pg.query('UPDATE canvases SET deleted_at=now() WHERE id=$1', [a]);
    assert.deepEqual(await readDiagramPage(db, { diagramId: a, sessionId: b }), { status: 'not_found' });
  } finally { await pg.close(); }
});

test('diagram tools honour optional filters rather than forced scope, route comparisons and record sources', async () => {
  process.env['DATABASE_URL'] = 'postgresql://isolated.invalid/offline';
  const { executeToolCall } = await import('../src/ai/chatTools.js');
  const params: unknown[][] = [];
  const db = { query: async (_sql: string, values: unknown[]) => {
    params.push(values); return { rows: [] };
  } } as unknown as Pool;
  await executeToolCall(db, 'search_diagrams', '{"query":"claims","projectId":"different","limit":999}', 'imagine');
  assert.deepEqual(params[0], [null, 'different', 'claims', 5, []]);
  await executeToolCall(db, 'search_diagrams', '{"query":"claims"}', 'imagine');
  assert.deepEqual(params[1], [null, null, 'claims', 3, []]);
  const missing = await executeToolCall(db, 'read_diagram', JSON.stringify({ diagramId: a }), 'imagine');
  assert.deepEqual(missing, { error: 'Saved diagram not found or excluded from this conversation.' });
  assert.deepEqual(params[2], [a, null, '', 3, []]);
  assert.ok('error' in (await executeToolCall(db, 'read_diagram', '{}') as object));
  const tools = [{ type: 'function' as const, function: { name: 'search_diagrams', description: 'Search', parameters: {} } }];
  assert.deepEqual(selectRequiredToolChoice('Compare these diagrams', tools, [], null, false, false, true),
    { type: 'function', function: { name: 'search_diagrams' } });
  assert.deepEqual(selectRequiredToolChoice('Find the claims diagram', tools),
    { type: 'function', function: { name: 'search_diagrams' } });
  assert.equal(selectRequiredToolChoice('Explain this diagram', tools, [], null, false, false, true), undefined);
  const createTools = [...tools, { type: 'function' as const, function: { name: 'create_diagram', description: 'Create', parameters: {} } }];
  for (const ask of ['Draw an AI flow for claims triage', 'Create an AI governance diagram for onboarding', 'map out the agentic process for FNOL', 'Build a swimlane diagram of complaints']) {
    assert.deepEqual(selectRequiredToolChoice(ask, createTools), { type: 'function', function: { name: 'create_diagram' } }, ask);
  }
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
        updated_at: '2026-10-09', document: saved, linked_notes: [], element_notes: [], assets: [] }] };
    }
    if (sql.includes('FROM canvases c')) return { rows: [{ id: a, title: 'Claims architecture', canvas_type: 'diagram' }] };
    if (sql.includes('SELECT project_id FROM ai_chat_sessions')) return { rows: [{ project_id: 'ikea' }] };
    if (sql.includes('FROM projects WHERE id')) return { rows: [{ id: 'ikea', name: 'IKEA', links: [], expectedOutputs: [] }] };
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
    const reply = await handleConversationTurn(db, [], 'hello', 'standard', 'general', 'ikea-session', context, undefined, { noteId: `map:${a}` });
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

test('AI flow evidence carries lanes, step metadata, connector types and governance findings', () => {
  const base = emptyDiagram();
  const node = (over: Partial<DiagramNode>): DiagramNode => ({ id: 'x', kind: 'process', label: '', x: 0, y: 0, width: 100, height: 60, parentId: null,
    fill: '#fff', stroke: '#000', textColor: '#000', fontSize: 14, assetId: null, ...over });
  const doc: DiagramDocument = { ...base, diagramType: 'ai-flow', nodes: [
    node({ id: 'lane', kind: 'swimlane', label: 'Agents', width: 600, height: 200, lane: { order: 1, owner: 'AI team' } }),
    node({ id: 'step', label: 'Triage', parentId: 'lane', flow: { stepType: 'digital_worker', agent: { mode: 'autonomous', tools: ['CRM'] }, controls: { sensitivity: 'pii' } } }),
    node({ id: 'other', label: 'Review', parentId: 'lane', flow: { stepType: 'human_task' } }),
  ], edges: [{ id: 'e', sourceId: 'step', targetId: 'other', sourcePort: 'right', targetPort: 'left', route: 'orthogonal', waypoints: [],
    label: '', stroke: '#000', dashed: false, arrows: 'end', flow: { edgeType: 'primary_flow', interaction: 'human_handoff' } }] };
  const evidence = JSON.parse(diagramEvidence(doc)) as Record<string, unknown> & { shapes: Array<Record<string, unknown>>; connectors: Array<Record<string, unknown>>; governanceFindings: Array<{ code: string; severity: string; targetId: string }> };
  assert.equal(evidence['diagramType'], 'ai-flow');
  assert.deepEqual(evidence.shapes[0]!['lane'], { order: 1, owner: 'AI team' });
  assert.deepEqual((evidence.shapes[1]!['flow'] as { agent: unknown }).agent, { mode: 'autonomous', tools: ['CRM'] });
  assert.deepEqual(evidence.connectors[0]!['flow'], { edgeType: 'primary_flow', interaction: 'human_handoff' });
  assert.ok(evidence.governanceFindings.some((f) => f.code === 'sensitive-no-audit' && f.severity === 'high' && f.targetId === 'step'));
  assert.equal(evidence['omittedGovernanceFindings'], 0);
  assert.match(DIAGRAM_READING_GUIDANCE, /governanceFindings are automatic advisory checks/);
  const general = JSON.parse(diagramEvidence(emptyDiagram())) as Record<string, unknown>;
  assert.ok(!('diagramType' in general) && !('governanceFindings' in general));
});