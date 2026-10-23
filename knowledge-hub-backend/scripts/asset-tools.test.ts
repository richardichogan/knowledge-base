import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { DiagramDocument } from '../src/types/diagram.js';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { addToDiagram, applyDiagramUpdate, executeAssetTool, getAssetToolDefinitions, isAssetTool, layoutColumns, ASSET_WRITE_TOOLS } = await import('../src/ai/assetTools.js');
const { validateDiagramDocument } = await import('../src/services/diagramValidation.js');
const { emptyDiagram } = await import('../src/types/diagram.js');

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

test('an AI flow gets lanes, steps placed in them, sanitised metadata and a valid document', () => {
  const { doc, problems } = applyDiagramUpdate(emptyDiagram(), {
    diagramType: 'ai-flow',
    addLanes: [{ key: 'cust', label: 'Customer', owner: 'Policyholder' }, { key: 'ai', label: 'AI agents', owner: 'Claims AI team' }, { label: 'Handlers' }],
    addNodes: [
      { key: 'fnol', label: 'Report claim', lane: 'cust', stepType: 'channel_interaction' },
      { key: 'triage', label: 'Triage claim', lane: 'ai', stepType: 'digital_worker', colour: 'red',
        agent: { mode: 'semi_autonomous', assertion: 'bogus', tools: ['Policy API', '', 'x'.repeat(400)], confidenceThreshold: 85, role: 'r'.repeat(900) },
        controls: { sensitivity: 'pii', authRequired: true, auditLogging: 'yes' } },
      { key: 'review', label: 'Review', lane: 'handlers', stepType: 'human_task' },
      { key: 'orphan', label: 'Lost', lane: 'Nowhere', stepType: 'integration' },
    ],
    addEdges: [{ from: 'fnol', to: 'triage' }, { from: 'triage', to: 'review', edgeType: 'control', interaction: 'human_handoff' }],
  });
  assert.deepEqual(problems, ['Lane "Nowhere" not found; "Lost" is outside the lanes.']);
  assert.equal(doc.diagramType, 'ai-flow');
  const lanes = doc.nodes.filter((n) => n.kind === 'swimlane');
  assert.deepEqual(lanes.map((l) => [l.label, l.lane?.order, l.lane?.owner]), [['Customer', 1, 'Policyholder'], ['AI agents', 2, 'Claims AI team'], ['Handlers', 3, undefined]]);
  const byLabel = (label: string) => doc.nodes.find((n) => n.label === label)!;
  assert.equal(byLabel('Report claim').parentId, lanes[0]!.id);
  assert.equal(byLabel('Review').parentId, lanes[2]!.id, 'lanes resolve by label as well as key');
  assert.equal(byLabel('Lost').parentId, null);
  assert.equal(byLabel('Report claim').kind, 'terminator', 'step type sets the default shape');
  const triage = byLabel('Triage claim');
  assert.equal(triage.stroke, '#da1e28', 'an explicit colour wins over the step style');
  assert.deepEqual(triage.flow?.agent, { role: 'r'.repeat(500), mode: 'semi_autonomous', tools: ['Policy API', 'x'.repeat(200)], confidenceThreshold: 0.85 });
  assert.deepEqual(triage.flow?.controls, { sensitivity: 'pii', authRequired: true });
  for (const step of doc.nodes.filter((n) => n.parentId !== null)) {
    const lane = doc.nodes.find((n) => n.id === step.parentId)!;
    assert.ok(step.y >= lane.y && step.y + step.height <= lane.y + lane.height && step.x >= lane.x, `${step.label} sits inside its lane`);
  }
  assert.deepEqual(doc.edges.map((e) => [e.flow?.edgeType, e.dashed]), [['primary_flow', false], ['control', true]]);
  assert.doesNotThrow(() => validateDiagramDocument(JSON.parse(JSON.stringify(doc)), new Set()));

  const next = applyDiagramUpdate(doc, {
    updateNodes: [
      { node: 'Triage claim', controls: { auditLogging: true, regulatoryTags: 'GDPR' }, agent: { escalationPath: 'Senior handler' } },
      { node: 'Handlers', owner: 'Claims operations', order: 0 },
      { node: 'Report claim', lane: 'AI agents' },
      { node: 'Lost', agent: { mode: 'autonomous' } },
    ],
    updateEdges: [{ from: 'fnol', to: 'Triage claim', edgeType: 'conditional_flow', condition: 'Claim over £10k' }],
  });
  assert.deepEqual(next.problems, ['Shape "fnol" not found.'], 'keys only live for one call');
  const after = (label: string) => next.doc.nodes.find((n) => n.label === label)!;
  assert.deepEqual(after('Triage claim').flow?.controls, { sensitivity: 'pii', authRequired: true, auditLogging: true, regulatoryTags: ['GDPR'] });
  assert.equal(after('Triage claim').flow?.agent?.mode, 'semi_autonomous', 'merging keeps earlier agent details');
  assert.equal(after('Triage claim').flow?.agent?.escalationPath, 'Senior handler');
  assert.equal(after('Handlers').lane?.owner, 'Claims operations');
  assert.ok(after('Handlers').y < after('Customer').y, 'reordered lanes are laid out again');
  assert.equal(after('Report claim').parentId, after('AI agents').id);
  assert.doesNotThrow(() => validateDiagramDocument(JSON.parse(JSON.stringify(next.doc)), new Set()));

  const edge = applyDiagramUpdate(next.doc, { updateEdges: [{ from: 'Report claim', to: 'Triage claim', edgeType: 'conditional_flow', condition: 'Claim over £10k' }] });
  assert.deepEqual(edge.problems, []);
  assert.deepEqual(edge.doc.edges[0]!.flow, { edgeType: 'conditional_flow', condition: 'Claim over £10k' });
  assert.equal(edge.doc.edges[0]!.stroke, '#b28600');
  assert.equal(doc.nodes.find((n) => n.label === 'Triage claim')!.flow?.controls?.auditLogging, undefined, 'the input document is not mutated');

  const general = applyDiagramUpdate(emptyDiagram(), { addNodes: [{ label: 'A' }], relayout: true });
  assert.equal(general.doc.diagramType, undefined);
  assert.deepEqual(general.problems, []);
});

test('ordinary diagram edits retain positions; relayout is explicit and centres mixed-height steps', () => {
  const first = addToDiagram(emptyDiagram(), [
    { key: 'a', label: 'Start', kind: 'terminator', colour: 'blue', footnote: false },
    { key: 'b', label: 'Gate', kind: 'decision', colour: 'yellow', footnote: false },
  ], [{ from: 'a', to: 'b', label: '', dashed: false }]).doc;
  assert.equal(first.nodes[0]!.y + first.nodes[0]!.height / 2, first.nodes[1]!.y + first.nodes[1]!.height / 2);
  first.nodes[0]!.x = 999;
  const edited = applyDiagramUpdate(first, { updateNodes: [{ node: 'Start', colour: 'green' }] });
  assert.equal(edited.doc.nodes[0]!.x, 999);
  const arranged = applyDiagramUpdate(edited.doc, { relayout: true });
  assert.deepEqual(arranged.problems, []);
  assert.equal(arranged.doc.nodes[0]!.x, 80);
});
test('the note open beside the chat must go through a reviewed edit', async () => {
  const db = await database();
  const result = await executeAssetTool(db, 'update_note', { noteId: 'n1', content: 'x' }, 'n1') as Record<string, unknown>;
  assert.match(String(result['error']), /propose_note_edit/);
});

test('Athena can add a decision gate with its delegation, acceptance and shared governance rules', () => {
  const { doc, problems } = applyDiagramUpdate(emptyDiagram(), {
    diagramType: 'ai-flow',
    addLanes: [{ key: 'ai', label: 'AI agents', owner: 'Claims AI team' }],
    addNodes: [
      { key: 'ds', label: 'Steward', lane: 'ai', stepType: 'digital_steward' },
      { key: 'gate', label: 'May work begin?', lane: 'ai', stepType: 'decision_gate',
        gate: { gateKind: 'bogus', delegation: { permittedWork: 'Triage only', onFail: 'rework' }, acceptance: { requiredOutputs: ['Summary'], onFail: 'hold' },
          shared: { accountableOwner: 'Claims manager', recordRequirements: ['outcome'] } } },
      { key: 'plain', label: 'Rules', lane: 'ai', stepType: 'decision_rules', gate: { gateKind: 'acceptance' } },
      { key: 'review', label: 'Review', lane: 'ai', stepType: 'human_task' },
    ],
    addEdges: [{ from: 'ds', to: 'gate' }, { from: 'gate', to: 'review', gateEvaluation: 'acceptance', gateOutcome: 'escalate' }],
  });
  assert.deepEqual(problems, []);
  const gate = doc.nodes.find((n) => n.label === 'May work begin?')!;
  assert.equal(gate.kind, 'decision');
  assert.deepEqual(gate.flow?.gate, {
    gateKind: 'delegation_acceptance', delegation: { permittedWork: 'Triage only' }, acceptance: { requiredOutputs: ['Summary'], onFail: 'hold' },
    shared: { accountableOwner: 'Claims manager', recordRequirements: ['outcome'] },
  });
  assert.equal(doc.nodes.find((n) => n.label === 'Rules')!.flow?.gate, undefined, 'only decision gates carry gate rules');
  assert.deepEqual(doc.edges.map((e) => [e.flow?.gateEvaluation, e.flow?.gateOutcome]), [[undefined, undefined], ['acceptance', 'escalate']]);
  assert.doesNotThrow(() => validateDiagramDocument(JSON.parse(JSON.stringify(doc)), new Set()));
});
