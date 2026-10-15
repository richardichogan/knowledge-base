import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { checkAiFlow, controlCount, layoutAiFlow, nextLaneOrder, AI_FLOW_LAYOUT, STEP_STYLES } from '../src/services/aiFlow.js';
import { validateDiagramDocument } from '../src/services/diagramValidation.js';
import { AI_FLOW_STEP_TYPES, emptyDiagram, type AiFlowStep, type DiagramDocument, type DiagramEdge, type DiagramNode } from '../src/types/diagram.js';

function node(over: Partial<DiagramNode> = {}): DiagramNode {
  return {
    id: randomUUID(), kind: 'process', label: 'Step', x: 0, y: 0, width: 160, height: 64, parentId: null,
    fill: '#ffffff', stroke: '#333333', textColor: '#111111', fontSize: 14, assetId: null, ...over,
  };
}
function lane(label: string, order: number, owner?: string): DiagramNode {
  return node({ kind: 'swimlane', label, width: 600, height: 160, lane: { order, ...(owner !== undefined ? { owner } : {}) } });
}
function step(parent: DiagramNode | null, label: string, flow?: AiFlowStep, over: Partial<DiagramNode> = {}): DiagramNode {
  return node({ parentId: parent?.id ?? null, label, ...(flow !== undefined ? { flow } : {}), ...over });
}
function edge(a: DiagramNode, b: DiagramNode, over: Partial<DiagramEdge> = {}): DiagramEdge {
  return {
    id: randomUUID(), sourceId: a.id, targetId: b.id, sourcePort: 'top', targetPort: 'top', route: 'straight',
    waypoints: [{ x: 1, y: 2 }], label: '', stroke: '#525252', dashed: false, arrows: 'end', ...over,
  };
}
function doc(nodes: DiagramNode[], edges: DiagramEdge[] = []): DiagramDocument {
  return { ...emptyDiagram(), diagramType: 'ai-flow', nodes, edges };
}
const codes = (d: DiagramDocument, targetId?: string): string[] =>
  checkAiFlow(d).filter((f) => targetId === undefined || f.targetId === targetId).map((f) => f.code).sort();

test('the backend and web AI flow modules are identical apart from the import path', () => {
  const strip = (path: string): string => readFileSync(resolve(import.meta.dirname, path), 'utf8').replace(/\r\n/g, '\n').replace(/\} from '[^']+';/, "} from '<types>';");
  assert.equal(strip('../src/services/aiFlow.ts'), strip('../../knowledge-hub-web/src/features/diagram/aiFlow.ts'));
  const types = (path: string): string => {
    const text = readFileSync(resolve(import.meta.dirname, path), 'utf8').replace(/\r\n/g, '\n');
    return text.slice(text.indexOf('/** A diagram\'s semantic mode.'), text.indexOf('export interface DiagramNode'));
  };
  assert.notEqual(types('../src/types/diagram.ts'), '');
  assert.equal(types('../src/types/diagram.ts'), types('../../knowledge-hub-web/src/features/diagram/diagramTypes.ts'));
});

test('a well-governed agent step raises no findings', () => {
  const l = lane('Claims', 1, 'Claims operations');
  const s = step(l, 'Triage', {
    stepType: 'ai_agent_task',
    agent: { mode: 'supervised_autonomous', assertion: 'authoritative', guardrails: ['No payments'], escalationPath: 'Handler', confidenceThreshold: 0.8, tools: ['lookup'] },
    controls: { sensitivity: 'pii', auditLogging: true, authRequired: true, humanApproval: true },
    operations: { failureHandling: 'Queue for a human' },
  });
  assert.deepEqual(checkAiFlow(doc([l, s])), []);
  assert.equal(controlCount(s.flow), 4);
});

test('governance checks flag unchecked autonomy, missing controls and ownership gaps', () => {
  const l = lane('Agents', 1);
  const risky = step(l, 'Approve payment', {
    stepType: 'ai_agent_task', agent: { mode: 'autonomous', assertion: 'authoritative', tools: ['pay'] }, controls: { sensitivity: 'pci' },
  });
  const bare = step(l, 'Summarise', { stepType: 'ai_orchestration' });
  const loose = step(null, 'Loose step', { stepType: 'human_task', controls: { sensitivity: 'confidential' } });
  const untyped = step(l, 'Untyped');
  const human = step(l, 'Review', { stepType: 'human_task' });
  const d = doc([l, risky, bare, loose, untyped, human], [
    edge(risky, human, { flow: { edgeType: 'primary_flow', sensitivity: 'pci', interaction: 'agent_handoff' } }),
    edge(bare, risky, { flow: { edgeType: 'control', interaction: 'human_handoff', auth: 'mTLS' } }),
  ]);
  assert.deepEqual(codes(d, risky.id), [
    'agent-no-escalation', 'agent-no-failure-handling', 'agent-no-guardrails', 'agent-no-threshold', 'agent-tools-unauthenticated',
    'agent-unchecked-authority', 'restricted-no-auth', 'sensitive-no-audit',
  ]);
  assert.deepEqual(codes(d, bare.id), ['agent-mode-missing', 'agent-no-escalation', 'agent-no-failure-handling', 'agent-no-guardrails']);
  assert.deepEqual(codes(d, loose.id), ['restricted-no-auth', 'step-no-lane']);
  assert.deepEqual(codes(d, untyped.id), ['step-type-missing']);
  assert.deepEqual(codes(d, l.id), ['lane-no-owner']);
  assert.deepEqual(codes(d, d.edges[0]!.id), ['edge-sensitive-no-auth', 'handoff-not-agent']);
  assert.deepEqual(codes(d, d.edges[1]!.id), ['handoff-not-human']);
  const all = checkAiFlow(d);
  assert.equal(all[0]?.severity, 'high', 'most severe first');
  assert.ok(all.every((f, i) => i === 0 || ['high', 'warning', 'info'].indexOf(all[i - 1]!.severity) <= ['high', 'warning', 'info'].indexOf(f.severity)));
  assert.match(all.find((f) => f.code === 'agent-unchecked-authority')!.message, /"Approve payment".*autonomously.*no human approval/);
});

test('assistive agents need no escalation path or confidence threshold', () => {
  const l = lane('Desk', 1, 'Agents');
  const s = step(l, 'Draft reply', { stepType: 'ai_agent_task', agent: { mode: 'assistive', guardrails: ['Human sends'] }, operations: { failureHandling: 'Manual' } });
  assert.deepEqual(codes(doc([l, s])), []);
});

test('lane layout stacks lanes by order and places steps in flow columns', () => {
  const ops = lane('Operations', 2, 'Ops');
  const customer = lane('Customer', 1, 'Policyholder');
  const start = step(customer, 'Submit claim', { stepType: 'channel_interaction' }, { y: 999 });
  const triage = step(ops, 'Triage', { stepType: 'ai_agent_task' }, { width: 200, height: 90 });
  const review = step(ops, 'Review', { stepType: 'human_task' });
  const notify = step(customer, 'Notify', { stepType: 'channel_interaction' });
  const group = node({ kind: 'container', label: 'Group', parentId: ops.id, width: 200, height: 120 });
  const note = node({ kind: 'text', label: 'inner note', parentId: group.id, x: 10, y: 10 });
  const outside = step(null, 'Outside', undefined, { x: 5000, y: 5000 });
  const flowEdges = [
    edge(start, triage), edge(triage, review, { labelOffset: { x: 3, y: 4 } }), edge(review, notify),
    edge(notify, start, { flow: { edgeType: 'control' } }),
  ];
  const input = doc([ops, customer, start, triage, review, notify, group, note, outside], flowEdges);
  const out = layoutAiFlow(input);
  const at = (n: DiagramNode): DiagramNode => out.nodes.find((m) => m.id === n.id)!;

  assert.ok(at(customer).y < at(ops).y, 'lanes ordered by lane.order');
  assert.equal(at(ops).y, at(customer).y + at(customer).height, 'lanes are contiguous');
  assert.equal(at(customer).width, at(ops).width, 'lanes share a width');
  assert.equal(at(customer).x, at(ops).x);
  const centre = (n: DiagramNode): number => at(n).x + at(n).width / 2;
  assert.ok(centre(start) < centre(triage) && centre(triage) < centre(review) && centre(review) < centre(notify), 'columns follow the flow');
  for (const [s, l] of [[start, customer], [triage, ops], [review, ops], [notify, customer]] as const) {
    assert.ok(at(s).x >= at(l).x + AI_FLOW_LAYOUT.header && at(s).x + at(s).width <= at(l).x + at(l).width, `${s.label} inside its lane horizontally`);
    assert.ok(at(s).y >= at(l).y && at(s).y + at(s).height <= at(l).y + at(l).height, `${s.label} inside its lane vertically`);
  }
  assert.deepEqual({ x: at(note).x - at(group).x, y: at(note).y - at(group).y }, { x: note.x - group.x, y: note.y - group.y }, 'nested shapes move with their parent');
  assert.deepEqual(at(outside), outside, 'shapes outside lanes are untouched');
  const e1 = out.edges[1]!;
  assert.deepEqual([e1.sourcePort, e1.targetPort, e1.route, e1.waypoints, e1.labelOffset], ['right', 'left', 'orthogonal', [], undefined]);
  assert.deepEqual([out.edges[3]!.sourcePort, out.edges[3]!.targetPort], ['bottom', 'bottom'], 'backward control edge routes underneath');
  assert.deepEqual(validateDiagramDocument(JSON.parse(JSON.stringify(out)), new Set()), out, 'layout output is a valid document');
  assert.deepEqual(layoutAiFlow(out), out, 'layout is stable');
});

test('layout copes with cycles, stacked steps and lane-less diagrams', () => {
  const l = lane('Loop', 1);
  const a = step(l, 'A', { stepType: 'human_task' });
  const b = step(l, 'B', { stepType: 'human_task' });
  const c = step(l, 'C', { stepType: 'human_task' });
  const out = layoutAiFlow(doc([l, a, b, c], [edge(a, b), edge(b, a), edge(a, c)]));
  const at = (n: DiagramNode): DiagramNode => out.nodes.find((m) => m.id === n.id)!;
  assert.ok(out.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  const overlaps = (p: DiagramNode, q: DiagramNode): boolean => p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
  assert.ok(!overlaps(at(a), at(b)) && !overlaps(at(a), at(c)) && !overlaps(at(b), at(c)), 'no overlapping steps');
  const plain = doc([node(), node()]);
  assert.equal(layoutAiFlow(plain), plain);
  assert.equal(nextLaneOrder(doc([l, lane('Two', 7)])), 8);
  assert.equal(nextLaneOrder(plain), 1);
});

test('every step type has a valid default style', () => {
  for (const t of AI_FLOW_STEP_TYPES) {
    const s = STEP_STYLES[t];
    const n = node({ kind: s.kind, fill: s.fill, stroke: s.stroke, width: s.width, height: s.height, flow: { stepType: t } });
    assert.doesNotThrow(() => validateDiagramDocument(doc([n]), new Set()));
  }
});
