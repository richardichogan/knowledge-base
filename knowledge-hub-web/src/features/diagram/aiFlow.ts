/**
 * AI flow / governance diagrams: display labels, step and connector styling,
 * governance checks and a lane-aware layout. Pure and dependency-free.
 * Mirrored in knowledge-hub-backend/src/services/aiFlow.ts and
 * knowledge-hub-web/src/features/diagram/aiFlow.ts; only the import path differs.
 */
import {
  AI_FLOW_STEP_KINDS, type AiAgentMode, type AiAssertionLevel, type AiFlowEdgeType, type AiFlowGate, type AiFlowInteraction, type AiFlowState, type AiFlowStep, type AiFlowStepType, type AiFlowVolume,
  type AiGateAcceptanceFailure, type AiGateDelegationFailure, type AiGateEvaluation, type AiGateKind, type AiGateOutcome, type AiMemoryScope, type DataSensitivity, type DiagramDocument, type DiagramKind, type DiagramNode, type DiagramPort,
} from './diagramTypes';

// ─── Labels ─────────────────────────────────────────────────────────────────

export const STEP_TYPE_LABELS: Record<AiFlowStepType, string> = {
  channel_interaction: 'Channel Interaction', human_task: 'Human Task', digital_steward: 'Digital Steward', digital_worker: 'Digital Worker', specialist_agent: 'Specialist Agent', decision_gate: 'Decision Gate',
  decision_rules: 'Decision Rules', integration: 'Integration', data_operation: 'Data Operation', external_party: 'External Party',
};
export const AGENT_MODE_LABELS: Record<AiAgentMode, string> = {
  assistive: 'Assistive', semi_autonomous: 'Semi-autonomous', supervised_autonomous: 'Supervised autonomous', autonomous: 'Autonomous',
};
/** Short badge text for the autonomy level. */
export const AGENT_MODE_BADGES: Record<AiAgentMode, string> = { assistive: 'A1', semi_autonomous: 'A2', supervised_autonomous: 'A3', autonomous: 'A4' };
export const ASSERTION_LABELS: Record<AiAssertionLevel, string> = { signal: 'Signal', advisory: 'Advisory', authoritative: 'Authoritative' };
export const SENSITIVITY_LABELS: Record<DataSensitivity, string> = {
  public: 'Public', internal: 'Internal', confidential: 'Confidential', pii: 'PII', medical: 'Medical', pci: 'PCI',
};
export const EDGE_TYPE_LABELS: Record<AiFlowEdgeType, string> = {
  primary_flow: 'Primary flow', supporting_flow: 'Supporting flow', conditional_flow: 'Conditional flow', dependency: 'Dependency', control: 'Control',
};
export const INTERACTION_LABELS: Record<AiFlowInteraction, string> = {
  sync: 'Synchronous', async: 'Asynchronous', agent_handoff: 'Agent hand-off', human_handoff: 'Human hand-off',
};
export const STATE_LABELS: Record<AiFlowState, string> = { existing: 'Existing', future: 'Future', both: 'Existing and future' };
export const MEMORY_LABELS: Record<AiMemoryScope, string> = { none: 'None', session: 'Session', case: 'Case', customer: 'Customer' };
export const VOLUME_LABELS: Record<AiFlowVolume, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const GATE_KIND_LABELS: Record<AiGateKind, string> = {
  delegation_acceptance: 'Delegation and acceptance', acceptance: 'Acceptance only (consolidation)', action_authorisation: 'Action authorisation',
};
/** Direction chip text for each gate kind. */
export const GATE_KIND_SHORT: Record<AiGateKind, string> = { delegation_acceptance: 'DEL · ACC', acceptance: 'ACC', action_authorisation: 'AUTH' };
export const GATE_DELEGATION_FAILURE_LABELS: Record<AiGateDelegationFailure, string> = { block: 'Block', clarify: 'Ask for clarification', escalate: 'Escalate to a human' };
export const GATE_ACCEPTANCE_FAILURE_LABELS: Record<AiGateAcceptanceFailure, string> = { rework: 'Return for rework', hold: 'Hold', escalate: 'Escalate to a human' };
export const GATE_EVALUATION_LABELS: Record<AiGateEvaluation, string> = { delegation: 'Delegation', acceptance: 'Acceptance', action_authorisation: 'Action authorisation' };
export const GATE_OUTCOME_LABELS: Record<AiGateOutcome, string> = {
  pass: 'Pass', block: 'Block', clarify: 'Clarify', rework: 'Rework', hold: 'Hold', escalate: 'Escalate', re_evaluate: 'Re-evaluate',
};

/** Delegation rules apply to delegation and action-authorisation gates. */
export const gateChecksDelegation = (kind: AiGateKind): boolean => kind !== 'acceptance';
/** Acceptance rules apply to delegation-and-acceptance and acceptance-only gates. */
export const gateChecksAcceptance = (kind: AiGateKind): boolean => kind !== 'action_authorisation';
export const defaultGate = (): AiFlowGate => ({ gateKind: 'delegation_acceptance' });

export const isAiStep = (type: AiFlowStepType | undefined): boolean => type === 'digital_steward' || type === 'digital_worker' || type === 'specialist_agent';
const SENSITIVE: ReadonlySet<DataSensitivity> = new Set<DataSensitivity>(['pii', 'medical', 'pci']);
/** Personal, medical or payment data. */
export const isSensitive = (s: DataSensitivity | undefined): boolean => s !== undefined && SENSITIVE.has(s);
/** Confidential or more sensitive. */
export const isRestricted = (s: DataSensitivity | undefined): boolean => s === 'confidential' || isSensitive(s);

// ─── Styling ────────────────────────────────────────────────────────────────

export interface AiFlowStepStyle { kind: AiFlowStepKind; fill: string; stroke: string; width: number; height: number }
export type AiFlowStepKind = typeof AI_FLOW_STEP_KINDS[number];

/** Default shape and colours for each step type; text stays dark on the light fills. */
export const STEP_STYLES: Record<AiFlowStepType, AiFlowStepStyle> = {
  channel_interaction: { kind: 'terminator', fill: '#d9fbfb', stroke: '#007d79', width: 170, height: 56 },
  human_task: { kind: 'process', fill: '#edf5ff', stroke: '#0f62fe', width: 170, height: 72 },
  digital_steward: { kind: 'process', fill: '#fff0f7', stroke: '#d02670', width: 170, height: 72 },
  digital_worker: { kind: 'process', fill: '#f6f2ff', stroke: '#8a3ffc', width: 170, height: 72 },
  specialist_agent: { kind: 'process', fill: '#fff2e8', stroke: '#ba4e00', width: 170, height: 72 },
  decision_gate: { kind: 'decision', fill: '#fff1f1', stroke: '#da1e28', width: 150, height: 96 },
  decision_rules: { kind: 'decision', fill: '#fcf4d6', stroke: '#b28600', width: 150, height: 96 },
  integration: { kind: 'process', fill: '#f4f4f4', stroke: '#525252', width: 170, height: 64 },
  data_operation: { kind: 'document', fill: '#defbe6', stroke: '#198038', width: 170, height: 76 },
  external_party: { kind: 'terminator', fill: '#ffffff', stroke: '#6f6f6f', width: 170, height: 56 },
};

export const EDGE_STYLES: Record<AiFlowEdgeType, { stroke: string; dashed: boolean }> = {
  primary_flow: { stroke: '#525252', dashed: false },
  supporting_flow: { stroke: '#8d8d8d', dashed: true },
  conditional_flow: { stroke: '#b28600', dashed: false },
  dependency: { stroke: '#8a3ffc', dashed: true },
  control: { stroke: '#da1e28', dashed: true },
};

/** Governance controls in place on a step: auth, audit, human approval, guardrails and regulatory tags. */
export function controlCount(flow: AiFlowStep | undefined): number {
  const c = flow?.controls;
  return (c?.authRequired === true ? 1 : 0) + (c?.auditLogging === true ? 1 : 0) + (c?.humanApproval === true ? 1 : 0)
    + (c?.regulatoryTags?.length ?? 0) + (flow?.agent?.guardrails?.length ?? 0);
}

// ─── Governance checks ──────────────────────────────────────────────────────

export type AiFlowSeverity = 'high' | 'warning' | 'info';
export interface AiFlowFinding { code: string; severity: AiFlowSeverity; targetId: string; message: string }
const SEVERITY_RANK: Record<AiFlowSeverity, number> = { high: 0, warning: 1, info: 2 };
const STEP_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>(AI_FLOW_STEP_KINDS);
const MAX_STEP_LABEL_CHARS = 60;
const TRUNCATED_STEP_LABEL_CHARS = 57;
const LAYOUT_CENTER_DIVISOR = 2;

const named = (label: string): string => {
  const text = label.replace(/\s+/g, ' ').trim();
  return text === '' ? 'Untitled step' : `"${text.length > MAX_STEP_LABEL_CHARS ? `${text.slice(0, TRUNCATED_STEP_LABEL_CHARS)}...` : text}"`;
};

/**
 * Governance warnings for an AI flow diagram. Advisory only: nothing here blocks
 * saving. Sorted most severe first.
 */
export function checkAiFlow(doc: DiagramDocument): AiFlowFinding[] {
  const out: AiFlowFinding[] = [];
  const add = (code: string, severity: AiFlowSeverity, targetId: string, message: string): void => { out.push({ code, severity, targetId, message }); };
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const inLane = (n: DiagramNode): boolean => {
    const seen = new Set<string>();
    for (let p = n.parentId === null ? undefined : byId.get(n.parentId); p !== undefined && !seen.has(p.id); p = p.parentId === null ? undefined : byId.get(p.parentId)) {
      if (p.kind === 'swimlane') return true;
      seen.add(p.id);
    }
    return false;
  };
  const filled = (s: string | undefined): boolean => (s ?? '').trim() !== '';
  const checkGate = (n: DiagramNode, gate: AiFlowGate): void => {
    const name = named(n.label);
    const d = gate.delegation ?? {};
    const a = gate.acceptance ?? {};
    const s = gate.shared ?? {};
    if (!filled(s.accountableOwner)) add('gate-no-owner', 'high', n.id, `Decision gate ${name} has no accountable owner.`);
    if (gateChecksDelegation(gate.gateKind) && !filled(d.permittedWork) && !filled(d.authorityLimits) && (d.obligations ?? []).length === 0) {
      add('gate-no-delegation-rules', 'warning', n.id, `Decision gate ${name} has no delegation rules (permitted work, authority limits or obligations).`);
    }
    if (gateChecksAcceptance(gate.gateKind) && (a.requiredOutputs ?? []).length === 0 && !filled(a.validationCriteria)) {
      add('gate-no-acceptance-rules', 'warning', n.id, `Decision gate ${name} has no acceptance rules (required outputs or validation criteria).`);
    }
    if ((s.recordRequirements ?? []).length === 0) add('gate-no-record', 'warning', n.id, `Decision gate ${name} does not say what decision record must be kept.`);
    if (!filled(s.enforcedBy)) add('gate-no-enforcer', 'warning', n.id, `Decision gate ${name} does not say what enforces it.`);
    const escalations = doc.edges.filter((e) => (e.sourceId === n.id || e.targetId === n.id) && e.flow?.gateOutcome === 'escalate');
    if (escalations.length === 0) {
      add('gate-no-escalation', 'warning', n.id, `Decision gate ${name} has no escalate connector to a human task.`);
    }
    for (const e of escalations) {
      const other = byId.get(e.sourceId === n.id ? e.targetId : e.sourceId);
      if (other?.flow !== undefined && other.flow.stepType !== 'human_task') {
        add('gate-escalates-to-agent', 'warning', e.id, `Decision gate ${name} escalates to ${named(other.label)}, which is not a human task.`);
      }
    }
  };

  for (const n of doc.nodes) {
    if (n.kind === 'swimlane') {
      if (n.parentId === null && (n.lane?.owner ?? '').trim() === '') add('lane-no-owner', 'info', n.id, `Lane ${named(n.label)} has no owner or persona.`);
      continue;
    }
    if (!STEP_KINDS.has(n.kind)) continue;
    const flow = n.flow;
    const name = named(n.label);
    if (flow === undefined) { add('step-type-missing', 'info', n.id, `${name} has no step type.`); continue; }
    if (!inLane(n)) add('step-no-lane', 'info', n.id, `${name} is not in a lane, so nobody owns it.`);
    const controls = flow.controls ?? {};
    if (isSensitive(controls.sensitivity) && controls.auditLogging !== true) {
      add('sensitive-no-audit', 'high', n.id, `${name} handles ${SENSITIVITY_LABELS[controls.sensitivity!]} data without audit logging.`);
    }
    if (isRestricted(controls.sensitivity) && controls.authRequired !== true) {
      add('restricted-no-auth', 'warning', n.id, `${name} handles ${SENSITIVITY_LABELS[controls.sensitivity!]} data without required authentication.`);
    }
    if (flow.stepType === 'decision_gate') { checkGate(n, flow.gate ?? defaultGate()); continue; }
    if (!isAiStep(flow.stepType)) continue;
    const agent = flow.agent ?? {};
    const mode = agent.mode;
    if (mode === undefined) add('agent-mode-missing', 'warning', n.id, `${name} has no autonomy level.`);
    if ((mode === 'autonomous' || mode === 'supervised_autonomous') && agent.assertion === 'authoritative' && controls.humanApproval !== true) {
      add('agent-unchecked-authority', 'high', n.id, `${name} makes authoritative decisions ${mode === 'autonomous' ? 'autonomously' : 'with supervised autonomy'} and has no human approval.`);
    }
    if ((agent.guardrails ?? []).length === 0) add('agent-no-guardrails', 'warning', n.id, `${name} has no guardrails.`);
    if (mode !== 'assistive' && (agent.escalationPath ?? '').trim() === '') add('agent-no-escalation', 'warning', n.id, `${name} has no escalation path.`);
    if ((agent.tools ?? []).length > 0 && controls.authRequired !== true) add('agent-tools-unauthenticated', 'warning', n.id, `${name} calls tools but authentication is not required.`);
    if (mode !== undefined && mode !== 'assistive' && agent.confidenceThreshold === undefined) {
      add('agent-no-threshold', 'info', n.id, `${name} acts on its own but has no confidence threshold.`);
    }
    if ((flow.operations?.failureHandling ?? '').trim() === '') add('agent-no-failure-handling', 'info', n.id, `${name} has no failure handling.`);
  }

  for (const e of doc.edges) {
    const flow = e.flow;
    if (flow === undefined) continue;
    const from = byId.get(e.sourceId);
    const to = byId.get(e.targetId);
    const route = `${named(from?.label ?? '')} to ${named(to?.label ?? '')}`;
    if (isSensitive(flow.sensitivity) && (flow.auth ?? '').trim() === '') {
      add('edge-sensitive-no-auth', 'warning', e.id, `The ${route} connector carries ${SENSITIVITY_LABELS[flow.sensitivity!]} data with no authentication noted.`);
    }
    if (flow.interaction === 'human_handoff' && to?.flow !== undefined && to.flow.stepType !== 'human_task') {
      add('handoff-not-human', 'info', e.id, `The ${route} connector is a human hand-off, but the target is not a human task.`);
    }
    if (flow.interaction === 'agent_handoff' && to?.flow !== undefined && !isAiStep(to.flow.stepType) && to.flow.stepType !== 'decision_gate') {
      add('handoff-not-agent', 'info', e.id, `The ${route} connector is an agent hand-off, but the target is not an AI step.`);
    }
    const ends = new Set([from?.flow?.stepType, to?.flow?.stepType]);
    if (ends.has('digital_steward') && ends.has('digital_worker') && RANKING_EDGES.has(flow.edgeType)) {
      add('delegation-ungoverned', 'info', e.id, `The ${route} connector delegates between a Digital Steward and a Digital Worker with no decision gate between them.`);
    }
    if ((flow.gateEvaluation !== undefined || flow.gateOutcome !== undefined) && !ends.has('decision_gate')) {
      add('gate-route-no-gate', 'info', e.id, `The ${route} connector has a gate evaluation or outcome but is not connected to a decision gate.`);
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export const AI_FLOW_LAYOUT = {
  origin: 80,
  /** Must match the swimlane header width used by the renderer. */
  header: 32,
  padX: 40,
  padY: 24,
  columnGap: 70,
  minColumnPitch: 230,
  rowGap: 44,
  minRowPitch: 120,
  minLaneHeight: 160,
} as const;

/** Connector types that define the left-to-right order of steps. */
const RANKING_EDGES: ReadonlySet<AiFlowEdgeType | undefined> = new Set<AiFlowEdgeType | undefined>([undefined, 'primary_flow', 'supporting_flow', 'conditional_flow']);

/** Next free lane order, one after the highest used. */
export function nextLaneOrder(doc: DiagramDocument): number {
  return doc.nodes.reduce((max, n) => (n.lane !== undefined ? Math.max(max, n.lane.order) : max), 0) + 1;
}

/** Ignore DFS feedback edges when ranking; return/rework paths must not push the main flow rightwards. */
export function rankFlowNodes(keys: readonly string[], links: ReadonlyArray<{ from: string; to: string }>): Map<string, number> {
  const outgoing = new Map(keys.map(key => [key, new Set<string>()]));
  const incoming = new Map(keys.map(key => [key, 0]));
  for (const { from, to } of links) {
    const targets = outgoing.get(from);
    if (from === to || !targets || !incoming.has(to) || targets.has(to)) continue;
    targets.add(to);
    incoming.set(to, incoming.get(to)! + 1);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const forward = new Map(keys.map(key => [key, [] as string[]]));
  const visit = (key: string): void => {
    visiting.add(key);
    for (const target of outgoing.get(key)!) {
      if (visiting.has(target)) continue;
      forward.get(key)!.push(target);
      if (!visited.has(target)) visit(target);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of [...keys.filter(key => incoming.get(key) === 0), ...keys]) {
    if (!visited.has(key)) visit(key);
  }
  const remaining = new Map(keys.map(key => [key, 0]));
  for (const targets of forward.values()) for (const target of targets) remaining.set(target, remaining.get(target)! + 1);
  const queue = keys.filter(key => remaining.get(key) === 0);
  const columns = new Map(keys.map(key => [key, 0]));
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]!;
    for (const target of forward.get(key)!) {
      columns.set(target, Math.max(columns.get(target)!, columns.get(key)! + 1));
      remaining.set(target, remaining.get(target)! - 1);
      if (remaining.get(target) === 0) queue.push(target);
    }
  }
  return columns;
}

/**
 * Lays an AI flow out as swimlanes: top-level lanes stacked by `lane.order`,
 * their direct children in columns by longest flow path (cycles tolerated),
 * all lanes the same width. Nested content moves with its parent; shapes
 * outside lanes are left where they are. Connectors between moved shapes get
 * fresh orthogonal routes.
 */
export function layoutAiFlow(doc: DiagramDocument): DiagramDocument {
  const L = AI_FLOW_LAYOUT;
  const lanes = doc.nodes
    .filter((n) => n.kind === 'swimlane' && n.parentId === null)
    .sort((a, b) => (a.lane?.order ?? Number.MAX_SAFE_INTEGER) - (b.lane?.order ?? Number.MAX_SAFE_INTEGER) || a.y - b.y);
  if (lanes.length === 0) return doc;
  const laneIds = new Set(lanes.map((l) => l.id));
  const steps = doc.nodes.filter((n) => n.parentId !== null && laneIds.has(n.parentId) && n.kind !== 'line');
  const stepIds = new Set(steps.map((s) => s.id));

  const ranking = doc.edges.filter((e) => RANKING_EDGES.has(e.flow?.edgeType) && e.sourceId !== e.targetId && stepIds.has(e.sourceId) && stepIds.has(e.targetId));
  const column = rankFlowNodes(steps.map(s => s.id), ranking.map(e => ({ from: e.sourceId, to: e.targetId })));
  const columns = steps.length === 0 ? 1 : Math.max(...column.values()) + 1;
  const columnPitch = Math.max(L.minColumnPitch, ...steps.map((s) => s.width + L.columnGap));
  const cellWidth = columnPitch - L.columnGap;
  const laneWidth = L.header + L.padX * LAYOUT_CENTER_DIVISOR + columns * columnPitch - L.columnGap;
  const originX = Math.min(...lanes.map((l) => l.x));
  const originY = Math.min(...lanes.map((l) => l.y));

  const moved = new Map<string, { x: number; y: number; width?: number; height?: number }>();
  const row = new Map<string, number>();
  let y = originY;
  for (const lane of lanes) {
    const children = steps.filter((s) => s.parentId === lane.id).sort((a, b) => a.y - b.y || a.x - b.x);
    const perColumn = new Map<number, number>();
    for (const s of children) {
      const c = column.get(s.id)!;
      const r = perColumn.get(c) ?? 0;
      perColumn.set(c, r + 1);
      row.set(s.id, r);
    }
    const rows = Math.max(1, ...perColumn.values());
    const rowPitch = Math.max(L.minRowPitch, ...children.map((s) => s.height + L.rowGap));
    const height = Math.max(L.minLaneHeight, L.padY * LAYOUT_CENTER_DIVISOR + rows * rowPitch);
    const top = y + (height - rows * rowPitch) / LAYOUT_CENTER_DIVISOR;
    moved.set(lane.id, { x: originX, y, width: laneWidth, height });
    for (const s of children) {
      const cx = originX + L.header + L.padX + column.get(s.id)! * columnPitch + cellWidth / LAYOUT_CENTER_DIVISOR;
      const cy = top + row.get(s.id)! * rowPitch + rowPitch / LAYOUT_CENTER_DIVISOR;
      moved.set(s.id, { x: Math.round(cx - s.width / LAYOUT_CENTER_DIVISOR), y: Math.round(cy - s.height / LAYOUT_CENTER_DIVISOR) });
    }
    y += height;
  }

  // Shapes nested inside a moved step travel with it.
  const delta = new Map<string, { dx: number; dy: number }>();
  for (const n of doc.nodes) {
    const m = moved.get(n.id);
    if (m !== undefined) delta.set(n.id, { dx: m.x - n.x, dy: m.y - n.y });
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const inherited = (n: DiagramNode): { dx: number; dy: number } | undefined => {
    const seen = new Set<string>();
    for (let p = n.parentId === null ? undefined : byId.get(n.parentId); p !== undefined && !seen.has(p.id); p = p.parentId === null ? undefined : byId.get(p.parentId)) {
      if (stepIds.has(p.id)) return delta.get(p.id);
      seen.add(p.id);
    }
    return undefined;
  };

  const nodes = doc.nodes.map((n) => {
    const m = moved.get(n.id);
    if (m !== undefined) return { ...n, x: m.x, y: m.y, ...(m.width !== undefined ? { width: m.width } : {}), ...(m.height !== undefined ? { height: m.height } : {}) };
    const d = stepIds.has(n.id) ? undefined : inherited(n);
    return d === undefined ? n : { ...n, x: n.x + d.dx, y: n.y + d.dy };
  });
  const placed = new Map(nodes.map((n) => [n.id, n]));
  const edges = doc.edges.map((e) => {
    if (!stepIds.has(e.sourceId) || !stepIds.has(e.targetId)) return e;
    const a = placed.get(e.sourceId)!;
    const b = placed.get(e.targetId)!;
    const dc = column.get(e.targetId)! - column.get(e.sourceId)!;
    const [sourcePort, targetPort]: [DiagramPort, DiagramPort] = dc > 0 ? ['right', 'left']
      : dc < 0 ? ['bottom', 'bottom']
        : b.y >= a.y ? ['bottom', 'top'] : ['top', 'bottom'];
    const rest = { ...e };
    delete rest.labelOffset;
    return { ...rest, sourcePort, targetPort, route: 'orthogonal' as const, waypoints: [] };
  });
  return { ...doc, nodes, edges };
}