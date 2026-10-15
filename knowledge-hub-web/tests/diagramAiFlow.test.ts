import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { diagramDrawioXml } from '../src/features/diagram/diagramDrawio';
import { aiEdgeChip, aiLaneOwnerLayout, aiStepChips, applyStepStyle, findingsByTarget, parseAiList } from '../src/features/diagram/diagramAiFlowBadges';
import { checkAiFlow } from '../src/features/diagram/aiFlow';
import { normalizeDocument } from '../src/features/diagram/diagramGeometry';
import type { DiagramDocument, DiagramEdge, DiagramNode } from '../src/features/diagram/diagramTypes';

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id, kind: 'process', label: id, x: 0, y: 0, width: 170, height: 72, parentId: null,
  fill: '#ffffff', stroke: '#161616', textColor: '#161616', fontSize: 14, assetId: null, ...extra,
});
const edge = (id: string, s: string, t: string, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id, sourceId: s, targetId: t, sourcePort: 'right', targetPort: 'left', route: 'orthogonal', waypoints: [],
  label: '', stroke: '#161616', dashed: false, arrows: 'end', ...extra,
});

function aiDoc(): DiagramDocument {
  return {
    version: 1, grid: true, viewport: { x: 0, y: 0, zoom: 1 }, diagramType: 'ai-flow',
    nodes: [
      node('lane', { kind: 'swimlane', label: 'Service desk', x: 0, y: 0, width: 900, height: 200, lane: { order: 1, owner: 'Customer service agent' } }),
      node('triage', {
        label: 'Triage request', x: 80, y: 60, parentId: 'lane',
        flow: {
          stepType: 'ai_agent_task', state: 'future',
          agent: { mode: 'supervised_autonomous', assertion: 'advisory', tools: ['CRM lookup', 'Knowledge search'], guardrails: ['PII redaction'] },
          controls: { sensitivity: 'pii', auditLogging: true, humanApproval: true },
        },
      }),
      node('bot', { label: 'Draft reply', x: 320, y: 60, parentId: 'lane', flow: { stepType: 'ai_agent_task' } }),
    ],
    edges: [edge('e1', 'triage', 'bot', { flow: { edgeType: 'primary_flow', interaction: 'agent_handoff' } })],
  };
}

test('SVG export shows the lane owner and AI step badges', async () => {
  const svg = await diagramSvg(aiDoc(), new Map(), 'white');
  assert.ok(svg.includes('data-ai-lane-owner'), 'lane owner element');
  assert.ok(svg.includes('Customer service agent'), 'lane owner text');
  for (const key of ['type', 'autonomy', 'assertion', 'sensitivity', 'controls', 'state', 'tools']) {
    assert.ok(svg.includes(`data-ai-chip="${key}"`), `${key} chip`);
  }
  assert.ok(svg.includes('>A3<'), 'autonomy badge text');
  assert.ok(svg.includes('data-ai-chip="interaction"'), 'hand-off chip on the connector');
  assert.ok(svg.includes('data-ai-finding="warning"'), 'the step without an autonomy mode is flagged');
});

test('SVG export can leave governance findings out, and general diagrams have no AI badges', async () => {
  const quiet = await diagramSvg(aiDoc(), new Map(), 'white', false, { aiFindings: false });
  assert.ok(!quiet.includes('data-ai-finding'), 'no finding markers when disabled');
  assert.ok(quiet.includes('data-ai-chip="autonomy"'), 'badges still drawn');
  const general = { ...aiDoc() };
  delete general.diagramType;
  const plain = await diagramSvg(general, new Map(), 'white');
  assert.ok(!plain.includes('data-ai-chip') && !plain.includes('data-ai-lane-owner'), 'general diagrams keep the metadata hidden');
});

test('draw.io export keeps step type, autonomy, sensitivity and lane owner', () => {
  const xml = diagramDrawioXml(aiDoc(), new Map());
  assert.match(xml, /aiStepType="AI agent task"/);
  assert.match(xml, /aiAutonomy="A3 [^"]+"/);
  assert.match(xml, /aiSensitivity="PII"/);
  assert.match(xml, /aiLaneOwner="Customer service agent"/);
  assert.match(xml, /aiEdgeType="Primary flow"/);
  assert.ok(xml.includes('tooltip="'), 'step summary tooltip');
});

test('chips stay inside the step width and clear of each other at the default size', () => {
  const step = aiDoc().nodes[1]!;
  const chips = aiStepChips(step, true);
  assert.ok(chips.length >= 4, 'chips are laid out');
  for (const c of chips) assert.ok(c.x >= step.x && c.x + c.width <= step.x + step.width, `${c.key} fits the shape`);
  for (const row of [chips.filter((c) => c.y < step.y + 30), chips.filter((c) => c.y >= step.y + 30)]) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i]!.x >= sorted[i - 1]!.x + sorted[i - 1]!.width, `${sorted[i]!.key} does not overlap ${sorted[i - 1]!.key}`);
  }
});

test('lane owner layout sits beside the rotated title and is omitted when blank', () => {
  const lane = aiDoc().nodes[0]!;
  const owner = aiLaneOwnerLayout(lane);
  assert.ok(owner);
  assert.equal(owner.text, 'Customer service agent');
  assert.ok(owner.x > lane.x && owner.x < lane.x + 32, 'inside the header band');
  assert.equal(aiLaneOwnerLayout({ ...lane, lane: { order: 1, owner: '  ' } }), null);
});

test('findings group by target with the worst severity first', () => {
  const findings = checkAiFlow(aiDoc());
  const map = findingsByTarget(findings);
  assert.ok(map.has('bot'), 'the unconfigured AI step is flagged');
  for (const [, entry] of map) assert.ok(entry.findings.every((f) => ['high', 'warning', 'info'].includes(f.severity)));
});

test('normalising keeps the diagram type', () => {
  assert.equal(normalizeDocument(aiDoc()).diagramType, 'ai-flow');
});

test('list fields split on commas and new lines and respect the saved limits', () => {
  assert.deepEqual(parseAiList('CRM, , Search\nEmail ,'), ['CRM', 'Search', 'Email']);
  assert.equal(parseAiList(Array.from({ length: 40 }, (_, i) => `t${i}`).join(',')).length, 30);
  assert.equal(parseAiList('x'.repeat(250))[0]!.length, 200);
});

test('applying a step style keeps the step centred', () => {
  const n = node('n', { x: 100, y: 100, width: 100, height: 40 });
  const styled = applyStepStyle(n, 'decision_rules');
  assert.equal(styled.kind, 'decision');
  assert.equal(styled.x + styled.width / 2, 150);
  assert.equal(styled.y + styled.height / 2, 120);
});

test('interaction chips sit on the longest segment and clear of the connector label', () => {
  const route = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 200 }, { x: 60, y: 200 }];
  const plain = aiEdgeChip(edge('p', 'a', 'b', { flow: { edgeType: 'primary_flow', interaction: 'agent_handoff' } }), route)!;
  assert.equal(plain.x + plain.width / 2, 20, 'chip is on the vertical run');
  assert.equal(plain.y + plain.height / 2, 100, 'unlabelled chip is centred on the run');
  const labelled = aiEdgeChip(edge('l', 'a', 'b', { label: 'Complex', flow: { edgeType: 'conditional_flow', interaction: 'human_handoff' } }), route)!;
  const labelY = 110;
  const centre = labelled.y + labelled.height / 2;
  assert.equal(labelled.x + labelled.width / 2, 20, 'labelled chip is on the vertical run');
  assert.ok(Math.abs(centre - labelY) >= 10 + labelled.height / 2, 'labelled chip clears the label at the route midpoint');
  assert.ok(Math.abs(centre - labelY) <= 30, 'labelled chip stays beside its label');
  assert.ok(labelled.y >= 0 && labelled.y + labelled.height <= 200, 'labelled chip stays on the run');
  assert.equal(aiEdgeChip(edge('n', 'a', 'b', { flow: { edgeType: 'primary_flow' } }), route), null, 'no chip without an interaction');
});
