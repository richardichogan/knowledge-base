/**
 * AI flow / governance badges: the chips drawn on step shapes, the lane owner
 * line in a swimlane header and connector interaction tags. One layout for the
 * editor canvas and the SVG/PNG export so both show the same information.
 */
import type { AiFlowFinding, AiFlowSeverity } from './aiFlow';
import {
  AGENT_MODE_BADGES, AGENT_MODE_LABELS, ASSERTION_LABELS, INTERACTION_LABELS, SENSITIVITY_LABELS, STATE_LABELS, STEP_TYPE_LABELS,
  GATE_KIND_LABELS, GATE_KIND_SHORT, STEP_STYLES, controlCount, defaultGate, isAiStep, isRestricted, isSensitive,
} from './aiFlow';
import type { AiAssertionLevel, AiFlowInteraction, AiFlowStepType, DiagramDocument, DiagramEdge, DiagramNode, DiagramPoint } from './diagramTypes';
import { SWIMLANE_HEADER, documentWaveDepth, pointAlong, wrapText } from './diagramGeometry';

export const AI_CHIP_FONT = 9;
export const AI_CHIP_HEIGHT = 14;
const CHIP_GAP = 4;
const CHIP_PAD = 5;
const CHAR_W = AI_CHIP_FONT * 0.6;
const FINDING_RESERVE = 16;
export const AI_FINDING_RADIUS = 7;
export const AI_LANE_OWNER_FONT = 10;
const LANE_TITLE_SHIFT = -7;
const LANE_OWNER_SHIFT = 8;

export type AiChipTone =
  | 'type' | 'autonomy-1' | 'autonomy-2' | 'autonomy-3' | 'autonomy-4' | 'assertion'
  | 'sensitive' | 'restricted' | 'data' | 'controls' | 'tools' | 'future' | 'interaction';

export interface AiChip { key: string; text: string; title: string; tone: AiChipTone; x: number; y: number; width: number; height: number }

/** Chip colours; solid enough to read on both the light export and the dark editor sheet. */
export const AI_CHIP_COLOURS: Record<AiChipTone, { fill: string; stroke: string; text: string; dashed?: boolean }> = {
  type: { fill: '#f4f4f4', stroke: '#6f6f6f', text: '#161616' },
  'autonomy-1': { fill: '#198038', stroke: '#198038', text: '#ffffff' },
  'autonomy-2': { fill: '#0f62fe', stroke: '#0f62fe', text: '#ffffff' },
  'autonomy-3': { fill: '#8a3ffc', stroke: '#8a3ffc', text: '#ffffff' },
  'autonomy-4': { fill: '#da1e28', stroke: '#da1e28', text: '#ffffff' },
  assertion: { fill: '#393939', stroke: '#393939', text: '#ffffff' },
  sensitive: { fill: '#da1e28', stroke: '#da1e28', text: '#ffffff' },
  restricted: { fill: '#ff832b', stroke: '#ff832b', text: '#161616' },
  data: { fill: '#e0e0e0', stroke: '#8d8d8d', text: '#161616' },
  controls: { fill: '#198038', stroke: '#198038', text: '#ffffff' },
  tools: { fill: '#e8daff', stroke: '#8a3ffc', text: '#491d8b' },
  future: { fill: '#ffffff', stroke: '#0f62fe', text: '#0043ce', dashed: true },
  interaction: { fill: '#ffffff', stroke: '#6f6f6f', text: '#161616' },
};

export const AI_SEVERITY_COLOURS: Record<AiFlowSeverity, { fill: string; text: string }> = {
  high: { fill: '#da1e28', text: '#ffffff' },
  warning: { fill: '#f1c21b', text: '#161616' },
  info: { fill: '#0f62fe', text: '#ffffff' },
};
export const AI_SEVERITY_LABELS: Record<AiFlowSeverity, string> = { high: 'High', warning: 'Warning', info: 'Info' };
const SEVERITY_RANK: Record<AiFlowSeverity, number> = { high: 0, warning: 1, info: 2 };

/** Short step-type text for the chip; the code is used when the shape is too narrow. */
export const STEP_TYPE_SHORT: Record<AiFlowStepType, { text: string; code: string }> = {
  channel_interaction: { text: 'Channel', code: 'CH' },
  human_task: { text: 'Human', code: 'HU' },
  digital_steward: { text: 'Steward', code: 'DS' },
  digital_worker: { text: 'Worker', code: 'DW' },
  specialist_agent: { text: 'Specialist', code: 'SA' },
  decision_gate: { text: 'Gate', code: 'DG' },
  decision_rules: { text: 'Rules', code: 'RU' },
  integration: { text: 'Integration', code: 'IN' },
  data_operation: { text: 'Data', code: 'DA' },
  external_party: { text: 'External', code: 'EX' },
};
export const ASSERTION_SHORT: Record<AiAssertionLevel, string> = { signal: 'SIG', advisory: 'ADV', authoritative: 'AUTH' };
export const INTERACTION_SHORT: Record<AiFlowInteraction, string> = { sync: 'Sync', async: 'Async', agent_handoff: 'Agent hand-off', human_handoff: 'Human hand-off' };

export const chipWidth = (text: string): number => Math.ceil(text.length * CHAR_W + CHIP_PAD * 2);

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface ChipSpec { key: string; text: string; title: string; tone: AiChipTone; short?: string }

function rowInset(n: DiagramNode): number {
  return n.kind === 'terminator' ? Math.min(n.width, n.height) * 0.35 : n.kind === 'decision' ? 6 : 8;
}

/** Lays chips left to right (or right to left) from `start`, dropping trailing chips that do not fit in `room`. */
function placeRow(specs: ChipSpec[], start: number, room: number, cy: number, align: 'start' | 'end'): AiChip[] {
  const sized = specs.map((s) => ({ ...s, width: chipWidth(s.text) }));
  const total = (): number => sized.reduce((sum, s) => sum + s.width, 0) + Math.max(0, sized.length - 1) * CHIP_GAP;
  while (sized.length > 0 && total() > room) {
    const shortenable = sized.findIndex((s) => s.short !== undefined && s.short !== s.text);
    if (shortenable >= 0) {
      const s = sized[shortenable]!;
      sized[shortenable] = { ...s, text: s.short!, width: chipWidth(s.short!) };
      continue;
    }
    sized.pop();
  }
  const out: AiChip[] = [];
  let x = align === 'start' ? start : start - total();
  for (const s of sized) {
    out.push({ key: s.key, text: s.text, title: s.title, tone: s.tone, x, y: cy - AI_CHIP_HEIGHT / 2, width: s.width, height: AI_CHIP_HEIGHT });
    x += s.width + CHIP_GAP;
  }
  return out;
}

/** The chips for one AI flow step: type and autonomy along the top edge, data and controls along the bottom. */
export function aiStepChips(n: DiagramNode, reserveFinding = false): AiChip[] {
  const flow = n.flow;
  if (flow === undefined) return [];
  const inset = rowInset(n);
  const left = n.x + inset;
  const right = n.x + n.width - inset - (reserveFinding ? FINDING_RESERVE : 0);
  const topY = n.y - 1;
  const bottomY = n.kind === 'document' ? n.y + n.height - documentWaveDepth(n.height) : n.y + n.height;
  const agent = flow.agent;
  const controls = flow.controls;

  const topRight: ChipSpec[] = [];
  if (agent?.mode !== undefined) {
    const level = AGENT_MODE_BADGES[agent.mode];
    topRight.push({ key: 'autonomy', text: level, title: `Autonomy ${level}: ${AGENT_MODE_LABELS[agent.mode]}`, tone: `autonomy-${level.slice(1)}` as AiChipTone });
  }
  if (agent?.assertion !== undefined) {
    topRight.push({ key: 'assertion', text: ASSERTION_SHORT[agent.assertion], title: `Assertion: ${ASSERTION_LABELS[agent.assertion]}`, tone: 'assertion' });
  }
  if (flow.stepType === 'decision_gate') {
    const kind = (flow.gate ?? defaultGate()).gateKind;
    topRight.push({ key: 'gate', text: GATE_KIND_SHORT[kind], title: `Gate: ${GATE_KIND_LABELS[kind]}`, tone: 'controls' });
  }
  const type = STEP_TYPE_SHORT[flow.stepType];
  const typeSpec: ChipSpec = { key: 'type', text: type.text, short: type.code, title: `Step type: ${STEP_TYPE_LABELS[flow.stepType]}`, tone: 'type' };
  const rightChips = placeRow(topRight, right, right - left, topY, 'end');
  const rightStart = rightChips.length === 0 ? right : rightChips[0]!.x - CHIP_GAP;
  const top = [...placeRow([typeSpec], left, rightStart - left, topY, 'start'), ...rightChips];

  const bottom: ChipSpec[] = [];
  const sensitivity = controls?.sensitivity;
  if (sensitivity !== undefined) {
    bottom.push({ key: 'sensitivity', text: SENSITIVITY_LABELS[sensitivity], title: `Data sensitivity: ${SENSITIVITY_LABELS[sensitivity]}`,
      tone: isSensitive(sensitivity) ? 'sensitive' : isRestricted(sensitivity) ? 'restricted' : 'data' });
  }
  const count = controlCount(flow);
  if (count > 0) bottom.push({ key: 'controls', text: `${count} ctrl`, short: `${count}c`, title: `${count} governance control${count === 1 ? '' : 's'}`, tone: 'controls' });
  if (flow.state === 'future' || flow.state === 'both') {
    bottom.push({ key: 'state', text: flow.state === 'future' ? 'Future' : 'Now+future', short: flow.state === 'future' ? 'Fut' : 'N+F', title: `State: ${STATE_LABELS[flow.state]}`, tone: 'future' });
  }
  const tools = agent?.tools ?? [];
  if (tools.length > 0) {
    const first = truncate(tools[0]!, 14);
    bottom.push({ key: 'tools', text: tools.length > 1 ? `${first} +${tools.length - 1}` : first, short: `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
      title: `Tools: ${tools.join(', ')}`, tone: 'tools' });
  }
  return [...top, ...placeRow(bottom, left, n.x + n.width - inset - left, bottomY, 'start')];
}

/** Where the governance finding marker sits on a step or lane. */
export function aiFindingAnchor(n: DiagramNode): DiagramPoint {
  return { x: n.x + n.width - rowInset(n) - AI_FINDING_RADIUS + 2, y: n.y - 1 };
}

export interface AiLaneOwnerLayout { text: string; x: number; y: number; rotation: string; fontSize: number; titleShift: number }

/** The owner / persona line in a swimlane header band, beside the rotated title. */
export function aiLaneOwnerLayout(n: DiagramNode): AiLaneOwnerLayout | null {
  if (n.kind !== 'swimlane' || n.collapsed === true) return null;
  const owner = (n.lane?.owner ?? '').trim();
  if (owner === '') return null;
  const line = wrapText(owner, Math.max(20, n.height - 16), AI_LANE_OWNER_FONT, 1)[0];
  if (line === undefined) return null;
  const x = n.x + SWIMLANE_HEADER / 2 + LANE_OWNER_SHIFT;
  const y = n.y + n.height / 2;
  return { text: line, x, y, rotation: `rotate(-90 ${x} ${y})`, fontSize: AI_LANE_OWNER_FONT, titleShift: LANE_TITLE_SHIFT };
}

/** The interaction tag drawn on a connector. */
export function aiEdgeChip(edge: DiagramEdge, route: readonly DiagramPoint[]): AiChip | null {
  const interaction = edge.flow?.interaction;
  if (interaction === undefined || route.length < 2) return null;
  const text = INTERACTION_SHORT[interaction];
  const width = chipWidth(text);
  const at = edgeChipPoint(route, edge.label.trim(), width);
  return { key: 'interaction', text, title: `Interaction: ${INTERACTION_LABELS[interaction]}`, tone: 'interaction',
    x: at.x - width / 2, y: at.y - AI_CHIP_HEIGHT / 2, width, height: AI_CHIP_HEIGHT };
}

const EDGE_LABEL_CHAR_W = 7;
const EDGE_LABEL_HALF_HEIGHT = 10;

/**
 * Puts the interaction chip on the connector's longest segment, where connectors leaving the same
 * port have usually split apart. A labelled connector gets the chip just beside its label.
 */
function edgeChipPoint(route: readonly DiagramPoint[], label: string, chipW: number): DiagramPoint {
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < route.length - 1; i++) {
    const length = Math.hypot(route[i + 1]!.x - route[i]!.x, route[i + 1]!.y - route[i]!.y);
    if (length > bestLength) { best = i; bestLength = length; }
  }
  const a = route[best]!;
  const b = route[best + 1]!;
  if (bestLength <= 0) return a;
  const ux = (b.x - a.x) / bestLength;
  const uy = (b.y - a.y) / bestLength;
  const at = (t: number): DiagramPoint => ({ x: a.x + ux * t, y: a.y + uy * t });
  if (label === '') return at(bestLength / 2);
  const lp = pointAlong(route, 0.5);
  const t = (lp.x - a.x) * ux + (lp.y - a.y) * uy;
  const off = Math.abs((lp.x - a.x) * uy - (lp.y - a.y) * ux);
  if (off > 1 || t < 0 || t > bestLength) return at(bestLength / 2);
  const horizontal = Math.abs(ux) >= Math.abs(uy);
  const gap = horizontal ? (label.length * EDGE_LABEL_CHAR_W) / 2 + 6 + chipW / 2 + CHIP_GAP : EDGE_LABEL_HALF_HEIGHT + AI_CHIP_HEIGHT / 2 + CHIP_GAP;
  const margin = horizontal ? chipW / 2 + CHIP_GAP : AI_CHIP_HEIGHT / 2 + CHIP_GAP;
  const room = (p: number): number => Math.min(p - margin, bestLength - margin - p);
  const forward = t + gap;
  const back = t - gap;
  const pick = room(back) > room(forward) ? back : forward;
  return at(Math.min(Math.max(pick, margin), Math.max(margin, bestLength - margin)));
}

/** Where a connector's finding marker sits: three quarters of the way along its route. */
export function aiEdgeFindingAnchor(route: readonly DiagramPoint[]): DiagramPoint {
  return pointAlong(route, 0.75);
}

export interface AiTargetFindings { severity: AiFlowSeverity; findings: AiFlowFinding[] }

/** Findings grouped by shape or connector, with the worst severity first. */
export function findingsByTarget(findings: readonly AiFlowFinding[]): Map<string, AiTargetFindings> {
  const out = new Map<string, AiTargetFindings>();
  for (const f of findings) {
    const entry = out.get(f.targetId);
    if (entry === undefined) out.set(f.targetId, { severity: f.severity, findings: [f] });
    else {
      entry.findings.push(f);
      if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[entry.severity]) entry.severity = f.severity;
    }
  }
  return out;
}

export const isAiFlowDoc = (doc: Pick<DiagramDocument, 'diagramType'>): boolean => doc.diagramType === 'ai-flow';

/** A one-line summary of a step for tooltips and draw.io metadata. */
export function aiStepSummary(n: DiagramNode): string {
  const flow = n.flow;
  if (flow === undefined) return '';
  const parts = [`Step type: ${STEP_TYPE_LABELS[flow.stepType]}`];
  if (flow.state !== undefined) parts.push(`State: ${STATE_LABELS[flow.state]}`);
  if (flow.actor !== undefined && flow.actor.trim() !== '') parts.push(`Actor: ${flow.actor}`);
  const agent = flow.agent;
  if (agent?.mode !== undefined) parts.push(`Autonomy: ${AGENT_MODE_BADGES[agent.mode]} ${AGENT_MODE_LABELS[agent.mode]}`);
  else if (isAiStep(flow.stepType)) parts.push('Autonomy: not set');
  if (agent?.assertion !== undefined) parts.push(`Assertion: ${ASSERTION_LABELS[agent.assertion]}`);
  if ((agent?.tools ?? []).length > 0) parts.push(`Tools: ${agent!.tools!.join(', ')}`);
  if ((agent?.guardrails ?? []).length > 0) parts.push(`Guardrails: ${agent!.guardrails!.join(', ')}`);
  const controls = flow.controls;
  if (controls?.sensitivity !== undefined) parts.push(`Sensitivity: ${SENSITIVITY_LABELS[controls.sensitivity]}`);
  const count = controlCount(flow);
  if (count > 0) parts.push(`Controls: ${count}`);
  if (controls?.humanApproval === true) parts.push('Human approval');
  if ((controls?.regulatoryTags ?? []).length > 0) parts.push(`Regulatory: ${controls!.regulatoryTags!.join(', ')}`);
  return parts.join(' · ');
}

const LIST_MAX_ITEMS = 30;
const LIST_ITEM_MAX = 200;

/** Splits a comma or newline separated list, trimming and dropping empty items, within the saved limits. */
export function parseAiList(raw: string): string[] {
  return raw.split(/[,\n]/).map((s) => s.trim().slice(0, LIST_ITEM_MAX)).filter((s) => s !== '').slice(0, LIST_MAX_ITEMS);
}

/** True when `n` already has the shape and colours of its step type. */
export function hasStepStyle(n: DiagramNode, type: AiFlowStepType): boolean {
  const s = STEP_STYLES[type];
  return n.kind === s.kind && n.fill.toLowerCase() === s.fill.toLowerCase() && n.stroke.toLowerCase() === s.stroke.toLowerCase();
}

/** Applies the default shape, colours and size of a step type, keeping the step centred where it was. */
export function applyStepStyle(n: DiagramNode, type: AiFlowStepType): DiagramNode {
  const s = STEP_STYLES[type];
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  return { ...n, kind: s.kind, fill: s.fill, stroke: s.stroke, textColor: '#161616', width: s.width, height: s.height, x: Math.round(cx - s.width / 2), y: Math.round(cy - s.height / 2) };
}