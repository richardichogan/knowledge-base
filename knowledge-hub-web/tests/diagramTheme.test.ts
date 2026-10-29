import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramEditorFill, diagramEditorInk, diagramEditorNodeColours, diagramEdgeAppearance, diagramNodeRadius } from '../src/features/diagram/diagramTheme';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { emptyDiagram, type DiagramNode, type DiagramEdge } from '../src/features/diagram/diagramTypes';
import { diagramRoleLayout } from '../src/features/diagram/DiagramRoleBadge';
import { diagramTextLayout } from '../src/features/diagram/diagramText';
import { STEP_STYLES } from '../src/features/diagram/aiFlow';
import { applyDiagramSelectionStyle, applyDiagramEdgeStyle } from '../src/features/diagram/diagramSelectionStyle';

const step = (extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id: 'step', kind: 'process', label: 'Review evidence', x: 0, y: 0, width: 170, height: 72,
  parentId: null, assetId: null, fill: 'none', stroke: '#161616', textColor: '#161616', fontSize: 14, ...extra,
});
const connector = (extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id: 'edge', sourceId: 'step', targetId: 'target', sourcePort: 'right', targetPort: 'left',
  route: 'orthogonal', waypoints: [], label: '', stroke: '#525252', dashed: false, arrows: 'end', ...extra,
});

test('light sheet maps dark-authored colours and keeps custom colours', () => {
  assert.equal(diagramEditorInk('#f4f4f4'), '#161616');
  assert.equal(diagramEditorInk('#78a9ff'), '#0f62fe');
  assert.equal(diagramEditorInk('#abcdef'), '#abcdef');
  assert.equal(diagramEditorFill('#262626'), '#ffffff');
  assert.equal(diagramEditorFill('none'), 'none');
});

test('shipped defaults share the modern appearance in the editor and exports without mutation', async () => {
  const document = emptyDiagram();
  document.nodes.push({ id: 'legacy', kind: 'process', label: 'Original', x: 0, y: 0,
    width: 140, height: 64, parentId: null, assetId: null, fill: '#ffffff',
    stroke: '#161616', textColor: '#161616', fontSize: 14 });
  const svg = await diagramSvg(document, new Map(), 'transparent');
  assert.ok(svg.includes('fill="#ffffff" stroke="#e0e0e0"'));
  assert.ok(svg.includes('rx="12"'));
  assert.ok(svg.includes('filter="url(#diagram-shadow)"'));
  assert.ok(svg.includes('fill="#161616" text-anchor'));
  assert.equal(document.nodes[0]!.stroke, '#161616');
});

test('semantic defaults become white cards, tinted decisions and rounded groups', () => {
  assert.deepEqual(diagramEditorNodeColours(step()), { fill: '#ffffff', stroke: '#e0e0e0', textColor: '#161616' });
  for (const type of ['human_task', 'digital_steward', 'digital_worker', 'specialist_agent'] as const) {
    const node = step({ ...STEP_STYLES[type], flow: { stepType: type } });
    assert.equal(diagramEditorNodeColours(node).fill, '#ffffff');
    assert.equal(diagramRoleLayout(node)?.type, type);
  }
  assert.equal(diagramEditorNodeColours(step({ ...STEP_STYLES.decision_gate, flow: { stepType: 'decision_gate' } })).fill, '#fff1f1');
  assert.equal(diagramEditorNodeColours(step({ kind: 'decision', fill: '#fcf4d6', stroke: '#b28600' })).fill, '#fffbeb');
  assert.equal(diagramEditorNodeColours(step({ kind: 'container', stroke: '#525252' })).fill, '#f7f4ff');
  assert.equal(diagramNodeRadius(step({ kind: 'container' })), 20);
  assert.equal(diagramRoleLayout(step()), null, 'ordinary shapes do not acquire invented actors');
});

test('custom colours and explicit no-fill choices survive the shared theme', async () => {
  const custom = step({ fill: '#123abc', stroke: '#ab1234', textColor: '#ffffff' });
  assert.deepEqual(diagramEditorNodeColours(custom), { fill: custom.fill, stroke: custom.stroke, textColor: custom.textColor });
  const doc = { ...emptyDiagram(), nodes: [step()] };
  const changed = applyDiagramSelectionStyle(doc, { nodes: ['step'], edges: [] }, { fill: 'none' }, {});
  assert.equal(diagramEditorNodeColours(changed.nodes[0]!).fill, 'none', 'explicit no-fill does not turn back into a default card');
  const svg = await diagramSvg({ ...emptyDiagram(), nodes: [custom] }, new Map(), 'transparent');
  assert.ok(svg.includes('fill="#123abc" stroke="#ab1234"'));
});

test('role headings use actual metadata, stay within shapes and preserve explicit alignment', () => {
  const node = step({ flow: { stepType: 'digital_worker' } });
  const role = diagramRoleLayout(node)!;
  const text = diagramTextLayout(node, role);
  assert.ok(role.tile.x >= node.x && role.tile.x + role.tile.width < text.x);
  assert.ok(text.x < node.x + node.width && text.y < node.y + node.height);
  assert.equal(diagramRoleLayout({ ...node, width: 60 }), null);
  assert.equal(diagramRoleLayout({ ...node, textAlign: 'right' }), null);
  assert.equal(diagramRoleLayout({ ...node, kind: 'decision' }), null);
});

test('left-aligned header and title form a vertically centred block beside the icon', () => {
  for (const label of ['Review Issues', 'Plans Work']) {
    const node = step({ label, width: 160, height: 80, fontSize: 16, header: 'Agent' });
    const role = diagramRoleLayout(node, false)!;
    const text = diagramTextLayout(node, role);
    assert.equal(role.content.width, 112);
    assert.equal(text.x, node.x + 40);
    assert.equal(text.anchor, 'start');
    assert.equal(role.tile.width * 22 / 28, 22);
    assert.equal(role.title.x, text.x);
    assert.equal(text.x - role.tile.x - role.tile.width, 4);
    assert.equal(role.tile.y + role.tile.height / 2, node.y + node.height / 2);
    const halfText = ((text.lines.length - 1) * node.fontSize * 1.25 + node.fontSize) / 2;
    assert.equal(((role.title.y - 4.5) + (text.y + halfText)) / 2, node.y + node.height / 2);
  }
  const manual = step({ label: 'Review\nIssues', width: 160, height: 80, fontSize: 16, header: 'Agent' });
  assert.deepEqual(diagramTextLayout(manual, diagramRoleLayout(manual, false)).lines, ['Review', 'Issues']);
});

test('configurable headers and local icons render in standard and AI-flow exports without changing roles', async () => {
  for (const diagramType of ['general', 'ai-flow'] as const) {
    const node = step({ icon: 'rocket', header: 'Pipeline', flow: { stepType: 'digital_worker' } });
    const document = { ...emptyDiagram(), diagramType, nodes: [node] };
    const before = JSON.stringify(document);
    const layout = diagramRoleLayout(node, diagramType === 'ai-flow')!;
    assert.equal(layout.label, 'Pipeline');
    assert.equal(layout.iconName, 'Rocket');
    const svg = await diagramSvg(document, new Map(), 'white');
    assert.match(svg, /data-diagram-icon="Rocket"/);
    assert.match(svg, /PIPELINE/);
    assert.equal(JSON.stringify(document), before);
  }
  const hidden = step({ icon: null, header: '', flow: { stepType: 'digital_worker' } });
  assert.equal(diagramRoleLayout(hidden), null);
  assert.equal(diagramRoleLayout(step({ header: 'Custom header', icon: null }), false)?.label, 'Custom header');
  assert.equal(diagramRoleLayout(step({ header: 'Agent' }), false)?.iconName, 'Bot');
  const decision = step({ kind: 'decision', icon: 'locked', header: 'Approval', textAlign: 'right' });
  const layout = diagramRoleLayout(decision, false)!;
  assert.ok(layout.tile.x >= decision.x && layout.tile.y >= decision.y);
  assert.equal(diagramTextLayout(decision, layout).anchor, 'end');
});

test('connectors keep Yes/No neutral and distinguish declared sync/control without losing custom styling', () => {
  assert.equal(diagramEdgeAppearance(connector()).stroke, '#8d8d8d');
  const no = diagramEdgeAppearance(connector({ label: 'No' }));
  assert.equal(no.stroke, '#8d8d8d');
  assert.equal(no.dash, undefined);
  assert.equal(diagramEdgeAppearance(connector({ label: 'Yes' })).label, '#525252');
  const sync = diagramEdgeAppearance(connector({ flow: { edgeType: 'primary_flow', interaction: 'sync' } }));
  assert.equal(sync.stroke, '#a8a8a8');
  assert.equal(sync.dash, '4 4');
  const control = diagramEdgeAppearance(connector({ stroke: '#da1e28', dashed: true, flow: { edgeType: 'control', interaction: 'sync' } }));
  assert.equal(control.stroke, '#da1e28');
  assert.equal(control.dash, '5 4');
  const custom = diagramEdgeAppearance(connector({ stroke: '#123abc', strokeWidth: 4, dashed: true }));
  assert.equal(custom.stroke, '#123abc');
  assert.equal(custom.width, 4);
  assert.equal(custom.dash, '4 4');
  const solid = applyDiagramEdgeStyle(connector({ label: 'No' }), { dashed: false });
  assert.equal(diagramEdgeAppearance(solid).dash, undefined, 'explicit line style is not overridden by the branch default');
  const dependency = connector({ stroke: '#8a3ffc', dashed: true, flow: { edgeType: 'dependency' } });
  assert.equal(diagramEdgeAppearance(dependency).stroke, '#8a3ffc', 'unmapped relationship semantics remain distinct');
  assert.notEqual(diagramEdgeAppearance(dependency).dash, undefined);
});

test('modern SVG contains local role icons, tinted chips and the saved grid with no external resources', async () => {
  const node = step({ ...STEP_STYLES.digital_steward, flow: { stepType: 'digital_steward', controls: { sensitivity: 'pii', auditLogging: true }, state: 'future' } });
  const doc = { ...emptyDiagram(), diagramType: 'ai-flow' as const, gridSize: 20,
    nodes: [node, step({ id: 'target', x: 300 })], edges: [connector({ label: 'No' })] };
  const before = JSON.stringify(doc);
  const svg = await diagramSvg(doc, new Map(), 'white', true);
  assert.match(svg, /data-diagram-role="digital_steward"/);
  assert.match(svg, /STEWARD/);
  assert.match(svg, /fill="#fff0f7"/);
  assert.match(svg, /data-ai-chip="sensitivity"/);
  assert.match(svg, /id="export-grid" width="20" height="20"/);
  assert.doesNotMatch(svg, /stroke-dasharray="4 4"/);
  assert.doesNotMatch(svg, /<foreignObject|https:\/\/|fonts\.googleapis|unpkg/);
  assert.equal(JSON.stringify(doc), before);
});

test('dark-authored shapes render light with readable borders and labels', () => {
  assert.deepEqual(diagramEditorNodeColours({ fill: '#1c2d4a', stroke: '#78a9ff', textColor: '#f4f4f4' }),
    { fill: '#a6c8ff', stroke: '#0f62fe', textColor: '#161616' });
  assert.deepEqual(diagramEditorNodeColours({ fill: 'none', stroke: '#c6c6c6', textColor: '#f4f4f4' }),
    { fill: 'none', stroke: '#525252', textColor: '#161616' });
  assert.deepEqual(diagramEditorNodeColours({ fill: '#abcdef', stroke: '#161616', textColor: '#161616' }),
    { fill: '#abcdef', stroke: '#161616', textColor: '#161616' });
});

test('old pale palette fills gain stronger matching hues without changing custom colours', () => {
  for (const [pale, bold] of [
    ['#edf5ff', '#a6c8ff'], ['#f6f2ff', '#d4bbff'], ['#e5f6ff', '#82cfff'],
    ['#d9fbfb', '#3ddbd9'], ['#defbe6', '#6fdc8c'], ['#fff0f7', '#ffafd2'],
    ['#fff1f1', '#ffb3b8'], ['#fcf4d6', '#f1c21b'], ['#fff2e8', '#ffb784'],
  ]) {
    assert.equal(diagramEditorFill(pale), bold);
    assert.equal(diagramEditorFill(bold), bold);
    assert.equal(diagramEditorNodeColours({ fill: pale, stroke: '#161616', textColor: '#161616' }).textColor, '#161616');
  }
  assert.equal(diagramEditorFill('#123abc'), '#123abc');
});
