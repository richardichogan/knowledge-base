/**
 * services/diagramValidation.ts
 * Pure validation for diagram canvases (no database access):
 *  - validateDiagramDocument: strict shape/limits/reference checks for a saved document.
 *  - validateAssetUpload: PNG (signature, chunk structure, CRCs, dimensions) and
 *    SVG (parsed with fast-xml-parser, element/attribute allowlist).
 * Unsafe or malformed input is rejected with a ValidationError (HTTP 422), never
 * silently sanitised.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ValidationError } from '../types/errors.js';
import {
  AI_AGENT_MODES, AI_ASSERTION_LEVELS, AI_FLOW_EDGE_TYPES, AI_FLOW_INTERACTIONS, AI_FLOW_STATES, AI_FLOW_STEP_KINDS, AI_FLOW_STEP_TYPES,
  AI_FLOW_VOLUMES, AI_GATE_ACCEPTANCE_FAILURES, AI_GATE_DELEGATION_FAILURES, AI_GATE_EVALUATIONS, AI_GATE_KINDS, AI_GATE_OUTCOMES,
  AI_MEMORY_SCOPES, DATA_SENSITIVITIES, DIAGRAM_ARROW_DIRECTIONS, DIAGRAM_CALLOUT_TYPES, DIAGRAM_TYPES,
} from '../types/diagram.js';
import type {
  AiFlowAgent, AiFlowControls, AiFlowEdge, AiFlowGate, AiFlowGateAcceptance, AiFlowGateDelegation, AiFlowGateShared, AiFlowLane, AiFlowOperations, AiFlowStep, AiFlowStepType,
  DiagramDocument, DiagramEdge, DiagramFootnote, DiagramKind, DiagramLegend, DiagramLegendEntry, DiagramNode, DiagramPoint, DiagramPort,
} from '../types/diagram.js';

export const DIAGRAM_LIMITS = {
  maxNodes: 1000,
  maxEdges: 2000,
  maxWaypointsPerEdge: 100,
  /** |x|, |y| of nodes and waypoints. */
  maxCoordinate: 1_000_000,
  minNodeSize: 1,
  maxNodeSize: 100_000,
  maxNodeLabelChars: 2000,
  maxEdgeLabelChars: 500,
  maxDescriptionChars: 10_000,
  maxFootnotes: 200,
  maxLegendEntries: 50,
  maxLegendLabelChars: 120,
  maxLabelOffset: 10_000,
  /** AI-flow free-text fields (actor, role, payload, SLA ...). */
  maxFlowTextChars: 500,
  /** AI-flow lists (tools, systems, guardrails ...). */
  maxFlowListItems: 30,
  maxFlowListItemChars: 200,
  maxLaneOrder: 10_000,
  minFontSize: 6,
  maxFontSize: 200,
  /** |x|, |y| of the viewport pan. */
  maxViewportOffset: 100_000_000,
  minZoom: 0.05,
  maxZoom: 10,
  maxRevision: 2_147_483_647,
  maxAssetBytes: 5 * 1024 * 1024,
  maxAssetsPerCanvas: 200,
  maxAssetNameChars: 200,
  maxPngDimension: 16_384,
  maxPngPixels: 40_000_000,
  maxSvgElements: 20_000,
  maxSvgDepth: 64,
} as const;

export const ASSET_CONTENT_TYPES = ['image/png', 'image/svg+xml'] as const;
export type AssetContentType = typeof ASSET_CONTENT_TYPES[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Step types renamed to the Imagine agent types (migration 079); still accepted on input. */
const LEGACY_STEP_TYPES: Readonly<Record<string, AiFlowStepType>> = { ai_orchestration: 'digital_steward', ai_agent_task: 'digital_worker' };
export const currentStepType = (v: unknown): unknown => (typeof v === 'string' ? LEGACY_STEP_TYPES[v] ?? v : v);
const COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|none)$/i;
// Labels may contain line breaks and tabs, but no other control characters.
// eslint-disable-next-line no-control-regex
const LABEL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const NAME_CONTROL_RE = /[\u0000-\u001f\u007f]/;

const KINDS: readonly DiagramKind[] = ['process', 'decision', 'terminator', 'document', 'arrow', 'line', 'text', 'image', 'container', 'swimlane'];
const PARENT_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>(['container', 'swimlane']);
const PORTS: readonly DiagramPort[] = ['top', 'right', 'bottom', 'left'];
const ROUTES: readonly DiagramEdge['route'][] = ['straight', 'orthogonal'];
const ARROWS: readonly DiagramEdge['arrows'][] = ['none', 'start', 'end', 'both'];

const DOC_KEYS = ['version', 'nodes', 'edges', 'grid', 'viewport'] as const;
const DOC_OPTIONAL_KEYS = ['footnotes', 'legend', 'notesPanel', 'diagramType', 'gridSize', 'snapToGrid', 'snapToShapes'] as const;
const GRID_FINEST = 5;
const GRID_FINE = 10;
const GRID_STANDARD = 20;
const GRID_COARSE = 40;
const FOOTNOTE_KEYS = ['id', 'targetId', 'source'] as const;
const LEGEND_KEYS = ['visible', 'position', 'entries'] as const;
const LEGEND_ENTRY_KEYS = ['colour', 'label'] as const;
const LEGEND_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const VIEWPORT_KEYS = ['x', 'y', 'zoom'] as const;
const POINT_KEYS = ['x', 'y'] as const;
const NODE_KEYS = ['id', 'kind', 'label', 'x', 'y', 'width', 'height', 'parentId', 'fill', 'stroke', 'textColor', 'fontSize', 'assetId'] as const;
const EDGE_KEYS = ['id', 'sourceId', 'targetId', 'sourcePort', 'targetPort', 'route', 'waypoints', 'label', 'stroke', 'dashed', 'arrows'] as const;
const FLOW_STEP_KEYS = ['stepType'] as const;
const FLOW_STEP_OPTIONAL_KEYS = ['state', 'actor', 'systems', 'dataIn', 'dataOut', 'agent', 'controls', 'operations', 'gate'] as const;
const FLOW_GATE_KEYS = ['gateKind'] as const;
const FLOW_GATE_OPTIONAL_KEYS = ['delegation', 'acceptance', 'shared'] as const;
const FLOW_GATE_DELEGATION_KEYS = ['permittedWork', 'authorityLimits', 'requiredInputs', 'obligations', 'approvalConditions', 'evidence', 'onFail'] as const;
const FLOW_GATE_ACCEPTANCE_KEYS = ['requiredOutputs', 'validationCriteria', 'uncertaintyHandling', 'humanReviewConditions', 'evidence', 'onFail'] as const;
const FLOW_GATE_SHARED_KEYS = ['accountableOwner', 'controlRefs', 'enforcedBy', 'overrideAuthority', 'pendingBehaviour', 'recordRequirements'] as const;
const FLOW_AGENT_KEYS = ['role', 'mode', 'assertion', 'orchestrator', 'tools', 'knowledge', 'guardrails', 'escalationPath', 'decisionBoundary', 'confidenceThreshold', 'memory', 'model', 'promptVersion'] as const;
const FLOW_CONTROL_KEYS = ['sensitivity', 'authRequired', 'authModel', 'auditLogging', 'humanApproval', 'regulatoryTags'] as const;
const FLOW_OPERATION_KEYS = ['volume', 'sla', 'failureHandling', 'monitoring'] as const;
const FLOW_LANE_KEYS = ['order'] as const;
const FLOW_LANE_OPTIONAL_KEYS = ['owner', 'description'] as const;
const FLOW_EDGE_KEYS = ['edgeType'] as const;
const FLOW_EDGE_OPTIONAL_KEYS = ['interaction', 'payload', 'sensitivity', 'auth', 'condition', 'gateEvaluation', 'gateOutcome'] as const;
const FLOW_STEP_KIND_SET: ReadonlySet<DiagramKind> = new Set<DiagramKind>(AI_FLOW_STEP_KINDS);

// ─── Document ───────────────────────────────────────────────────────────────

function fail(path: string, reason: string): never {
  throw new ValidationError(`Invalid diagram: ${path} ${reason}`, { [path]: reason });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function exactObject(v: unknown, keys: readonly string[], path: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlainObject(v)) fail(path, 'must be an object');
  const allowed = new Set([...keys, ...optional]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) fail(`${path}.${k}`, 'is not an allowed property');
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) fail(`${path}.${k}`, 'is required');
  return v;
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  if (v < min || v > max) fail(path, `must be between ${min} and ${max}`);
  return v === 0 ? 0 : v; // normalise -0
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') fail(path, 'must be a string');
  if (v.length > max) fail(path, `must be at most ${max} characters`);
  if (LABEL_CONTROL_RE.test(v)) fail(path, 'must not contain control characters');
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be a boolean');
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(path, `must be one of ${allowed.join(', ')}`);
  return v as T;
}

function uuid(v: unknown, path: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) fail(path, 'must be a UUID');
  return v;
}

function color(v: unknown, path: string): string {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(path, 'must be a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa), "transparent" or "none"');
  return v;
}

function array(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  if (v.length > max) fail(path, `must have at most ${max} items`);
  return v;
}

export function validateRevision(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > DIAGRAM_LIMITS.maxRevision) {
    fail('revision', 'must be a non-negative integer');
  }
  return v;
}

function labelOffset(v: unknown, path: string): DiagramPoint {
  const o = exactObject(v, POINT_KEYS, path);
  const m = DIAGRAM_LIMITS.maxLabelOffset;
  return { x: num(o['x'], `${path}.x`, -m, m), y: num(o['y'], `${path}.y`, -m, m) };
}

function validatePoint(v: unknown, path: string): DiagramPoint {
  const o = exactObject(v, POINT_KEYS, path);
  const c = DIAGRAM_LIMITS.maxCoordinate;
  return { x: num(o['x'], `${path}.x`, -c, c), y: num(o['y'], `${path}.y`, -c, c) };
}

function validateNode(v: unknown, path: string): DiagramNode {
  const o = exactObject(v, NODE_KEYS, path, ['description', 'textAlign', 'textVerticalAlign', 'strokeWidth', 'strokeStyle', 'lineStart', 'lineEnd', 'arrowDirection', 'collapsed', 'calloutType', 'flow', 'lane']);
  const c = DIAGRAM_LIMITS.maxCoordinate;
  const kind = oneOf(o['kind'], KINDS, `${path}.kind`);
  const assetId = o['assetId'] === null ? null : uuid(o['assetId'], `${path}.assetId`);
  if (assetId !== null && kind !== 'image') fail(`${path}.assetId`, 'is only allowed on image nodes');
  if (o['calloutType'] !== undefined && kind !== 'text') fail(`${path}.calloutType`, 'is only allowed on text nodes');
  if (o['arrowDirection'] !== undefined && kind !== 'arrow') fail(`${path}.arrowDirection`, 'is only allowed on arrow nodes');
  const linePoint = (value: unknown, field: string): DiagramPoint => {
    if (kind !== 'line') fail(`${path}.${field}`, 'is only allowed on lines');
    const point = exactObject(value, POINT_KEYS, `${path}.${field}`);
    return { x: num(point['x'], `${path}.${field}.x`, 0, 1), y: num(point['y'], `${path}.${field}.y`, 0, 1) };
  };
  return {
    id: uuid(o['id'], `${path}.id`),
    kind,
    ...(o['lineStart'] !== undefined ? { lineStart: linePoint(o['lineStart'], 'lineStart') } : {}),
    ...(o['lineEnd'] !== undefined ? { lineEnd: linePoint(o['lineEnd'], 'lineEnd') } : {}),
    ...(o['arrowDirection'] !== undefined ? { arrowDirection: oneOf(o['arrowDirection'], DIAGRAM_ARROW_DIRECTIONS, `${path}.arrowDirection`) } : {}),
    label: str(o['label'], `${path}.label`, DIAGRAM_LIMITS.maxNodeLabelChars),
    ...(o['description'] !== undefined ? { description: str(o['description'], `${path}.description`, DIAGRAM_LIMITS.maxDescriptionChars) } : {}),
    x: num(o['x'], `${path}.x`, -c, c),
    y: num(o['y'], `${path}.y`, -c, c),
    width: num(o['width'], `${path}.width`, DIAGRAM_LIMITS.minNodeSize, DIAGRAM_LIMITS.maxNodeSize),
    height: num(o['height'], `${path}.height`, DIAGRAM_LIMITS.minNodeSize, DIAGRAM_LIMITS.maxNodeSize),
    parentId: o['parentId'] === null ? null : uuid(o['parentId'], `${path}.parentId`),
    fill: color(o['fill'], `${path}.fill`),
    stroke: color(o['stroke'], `${path}.stroke`),
    ...(o['strokeWidth'] !== undefined ? { strokeWidth: num(o['strokeWidth'], `${path}.strokeWidth`, 0.5, 6) } : {}),
    ...(o['strokeStyle'] !== undefined ? { strokeStyle: oneOf(o['strokeStyle'], ['solid', 'dashed', 'dotted'] as const, `${path}.strokeStyle`) } : {}),
    textColor: color(o['textColor'], `${path}.textColor`),
    fontSize: num(o['fontSize'], `${path}.fontSize`, DIAGRAM_LIMITS.minFontSize, DIAGRAM_LIMITS.maxFontSize),
    ...(o['textAlign'] !== undefined ? { textAlign: oneOf(o['textAlign'], ['left', 'center', 'right'] as const, `${path}.textAlign`) } : {}),
    ...(o['textVerticalAlign'] !== undefined ? { textVerticalAlign: oneOf(o['textVerticalAlign'], ['top', 'middle', 'bottom'] as const, `${path}.textVerticalAlign`) } : {}),
    ...(o['collapsed'] !== undefined ? { collapsed: collapsedFlag(o['collapsed'], kind, `${path}.collapsed`) } : {}),
    ...(o['calloutType'] !== undefined ? { calloutType: oneOf(o['calloutType'], DIAGRAM_CALLOUT_TYPES, `${path}.calloutType`) } : {}),
    ...(o['flow'] !== undefined ? { flow: validateFlowStep(o['flow'], kind, `${path}.flow`) } : {}),
    ...(o['lane'] !== undefined ? { lane: validateFlowLane(o['lane'], kind, `${path}.lane`) } : {}),
    assetId,
  };
}

// ─── AI flow metadata ───────────────────────────────────────────────────────

/** Spreads `{ [key]: parsed }` only when the key is present. */
function opt<K extends string, T>(o: Record<string, unknown>, key: K, path: string, parse: (v: unknown, at: string) => T): { [P in K]?: T } {
  return (o[key] === undefined ? {} : { [key]: parse(o[key], `${path}.${key}`) }) as { [P in K]?: T };
}

const flowText = (v: unknown, path: string): string => str(v, path, DIAGRAM_LIMITS.maxFlowTextChars);
const flowList = (v: unknown, path: string): string[] =>
  array(v, path, DIAGRAM_LIMITS.maxFlowListItems).map((s, i) => str(s, `${path}[${i}]`, DIAGRAM_LIMITS.maxFlowListItemChars));

function validateFlowAgent(v: unknown, path: string): AiFlowAgent {
  const o = exactObject(v, [], path, FLOW_AGENT_KEYS);
  return {
    ...opt(o, 'role', path, flowText),
    ...opt(o, 'mode', path, (x, at) => oneOf(x, AI_AGENT_MODES, at)),
    ...opt(o, 'assertion', path, (x, at) => oneOf(x, AI_ASSERTION_LEVELS, at)),
    ...opt(o, 'orchestrator', path, flowText),
    ...opt(o, 'tools', path, flowList),
    ...opt(o, 'knowledge', path, flowList),
    ...opt(o, 'guardrails', path, flowList),
    ...opt(o, 'escalationPath', path, flowText),
    ...opt(o, 'decisionBoundary', path, flowText),
    ...opt(o, 'confidenceThreshold', path, (x, at) => num(x, at, 0, 1)),
    ...opt(o, 'memory', path, (x, at) => oneOf(x, AI_MEMORY_SCOPES, at)),
    ...opt(o, 'model', path, flowText),
    ...opt(o, 'promptVersion', path, flowText),
  };
}

function validateFlowControls(v: unknown, path: string): AiFlowControls {
  const o = exactObject(v, [], path, FLOW_CONTROL_KEYS);
  return {
    ...opt(o, 'sensitivity', path, (x, at) => oneOf(x, DATA_SENSITIVITIES, at)),
    ...opt(o, 'authRequired', path, bool),
    ...opt(o, 'authModel', path, flowText),
    ...opt(o, 'auditLogging', path, bool),
    ...opt(o, 'humanApproval', path, bool),
    ...opt(o, 'regulatoryTags', path, flowList),
  };
}

function validateFlowOperations(v: unknown, path: string): AiFlowOperations {
  const o = exactObject(v, [], path, FLOW_OPERATION_KEYS);
  return {
    ...opt(o, 'volume', path, (x, at) => oneOf(x, AI_FLOW_VOLUMES, at)),
    ...opt(o, 'sla', path, flowText),
    ...opt(o, 'failureHandling', path, flowText),
    ...opt(o, 'monitoring', path, flowText),
  };
}

function validateGateDelegation(v: unknown, path: string): AiFlowGateDelegation {
  const o = exactObject(v, [], path, FLOW_GATE_DELEGATION_KEYS);
  return {
    ...opt(o, 'permittedWork', path, flowText),
    ...opt(o, 'authorityLimits', path, flowText),
    ...opt(o, 'requiredInputs', path, flowList),
    ...opt(o, 'obligations', path, flowList),
    ...opt(o, 'approvalConditions', path, flowText),
    ...opt(o, 'evidence', path, flowList),
    ...opt(o, 'onFail', path, (x, at) => oneOf(x, AI_GATE_DELEGATION_FAILURES, at)),
  };
}

function validateGateAcceptance(v: unknown, path: string): AiFlowGateAcceptance {
  const o = exactObject(v, [], path, FLOW_GATE_ACCEPTANCE_KEYS);
  return {
    ...opt(o, 'requiredOutputs', path, flowList),
    ...opt(o, 'validationCriteria', path, flowText),
    ...opt(o, 'uncertaintyHandling', path, flowText),
    ...opt(o, 'humanReviewConditions', path, flowText),
    ...opt(o, 'evidence', path, flowList),
    ...opt(o, 'onFail', path, (x, at) => oneOf(x, AI_GATE_ACCEPTANCE_FAILURES, at)),
  };
}

function validateGateShared(v: unknown, path: string): AiFlowGateShared {
  const o = exactObject(v, [], path, FLOW_GATE_SHARED_KEYS);
  return {
    ...opt(o, 'accountableOwner', path, flowText),
    ...opt(o, 'controlRefs', path, flowList),
    ...opt(o, 'enforcedBy', path, flowText),
    ...opt(o, 'overrideAuthority', path, flowText),
    ...opt(o, 'pendingBehaviour', path, flowText),
    ...opt(o, 'recordRequirements', path, flowList),
  };
}

function validateFlowGate(v: unknown, path: string): AiFlowGate {
  const o = exactObject(v, FLOW_GATE_KEYS, path, FLOW_GATE_OPTIONAL_KEYS);
  return {
    gateKind: oneOf(o['gateKind'], AI_GATE_KINDS, `${path}.gateKind`),
    ...opt(o, 'delegation', path, validateGateDelegation),
    ...opt(o, 'acceptance', path, validateGateAcceptance),
    ...opt(o, 'shared', path, validateGateShared),
  };
}

function validateFlowStep(v: unknown, kind: DiagramKind, path: string): AiFlowStep {
  if (!FLOW_STEP_KIND_SET.has(kind)) fail(path, `is only allowed on ${AI_FLOW_STEP_KINDS.join(', ')} shapes`);
  const o = exactObject(v, FLOW_STEP_KEYS, path, FLOW_STEP_OPTIONAL_KEYS);
  const stepType = oneOf(currentStepType(o['stepType']), AI_FLOW_STEP_TYPES, `${path}.stepType`);
  if (o['gate'] !== undefined && stepType !== 'decision_gate') fail(`${path}.gate`, 'is only allowed on decision_gate steps');
  return {
    stepType,
    ...opt(o, 'state', path, (x, at) => oneOf(x, AI_FLOW_STATES, at)),
    ...opt(o, 'actor', path, flowText),
    ...opt(o, 'systems', path, flowList),
    ...opt(o, 'dataIn', path, flowList),
    ...opt(o, 'dataOut', path, flowList),
    ...opt(o, 'agent', path, validateFlowAgent),
    ...opt(o, 'controls', path, validateFlowControls),
    ...opt(o, 'operations', path, validateFlowOperations),
    ...opt(o, 'gate', path, validateFlowGate),
  };
}

function validateFlowLane(v: unknown, kind: DiagramKind, path: string): AiFlowLane {
  if (kind !== 'swimlane') fail(path, 'is only allowed on swimlanes');
  const o = exactObject(v, FLOW_LANE_KEYS, path, FLOW_LANE_OPTIONAL_KEYS);
  return {
    order: num(o['order'], `${path}.order`, -DIAGRAM_LIMITS.maxLaneOrder, DIAGRAM_LIMITS.maxLaneOrder),
    ...opt(o, 'owner', path, flowText),
    ...opt(o, 'description', path, (x, at) => str(x, at, DIAGRAM_LIMITS.maxDescriptionChars)),
  };
}

function validateFlowEdge(v: unknown, path: string): AiFlowEdge {
  const o = exactObject(v, FLOW_EDGE_KEYS, path, FLOW_EDGE_OPTIONAL_KEYS);
  return {
    edgeType: oneOf(o['edgeType'], AI_FLOW_EDGE_TYPES, `${path}.edgeType`),
    ...opt(o, 'interaction', path, (x, at) => oneOf(x, AI_FLOW_INTERACTIONS, at)),
    ...opt(o, 'payload', path, flowText),
    ...opt(o, 'sensitivity', path, (x, at) => oneOf(x, DATA_SENSITIVITIES, at)),
    ...opt(o, 'auth', path, flowText),
    ...opt(o, 'condition', path, flowText),
    ...opt(o, 'gateEvaluation', path, (x, at) => oneOf(x, AI_GATE_EVALUATIONS, at)),
    ...opt(o, 'gateOutcome', path, (x, at) => oneOf(x, AI_GATE_OUTCOMES, at)),
  };
}

function collapsedFlag(v: unknown, kind: DiagramKind, path: string): boolean {
  if (!PARENT_KINDS.has(kind)) fail(path, 'is only allowed on containers and swimlanes');
  return bool(v, path);
}

function validateFootnote(v: unknown, path: string): DiagramFootnote {
  const o = exactObject(v, FOOTNOTE_KEYS, path, ['text']);
  const source = oneOf(o['source'], ['description', 'custom'] as const, `${path}.source`);
  return {
    id: uuid(o['id'], `${path}.id`),
    targetId: uuid(o['targetId'], `${path}.targetId`),
    source,
    ...(o['text'] !== undefined ? { text: str(o['text'], `${path}.text`, DIAGRAM_LIMITS.maxDescriptionChars) } : {}),
  };
}

function validateLegend(v: unknown, path: string): DiagramLegend {
  const o = exactObject(v, LEGEND_KEYS, path);
  const colours = new Set<string>();
  const entries = array(o['entries'], `${path}.entries`, DIAGRAM_LIMITS.maxLegendEntries).map((e, i): DiagramLegendEntry => {
    const at = `${path}.entries[${i}]`;
    const entry = exactObject(e, LEGEND_ENTRY_KEYS, at, ['hidden']);
    const colour = color(entry['colour'], `${at}.colour`);
    if (colours.has(colour.toLowerCase())) fail(`${at}.colour`, 'is a duplicate colour');
    colours.add(colour.toLowerCase());
    return {
      colour,
      label: str(entry['label'], `${at}.label`, DIAGRAM_LIMITS.maxLegendLabelChars),
      ...(entry['hidden'] !== undefined ? { hidden: bool(entry['hidden'], `${at}.hidden`) } : {}),
    };
  });
  return { visible: bool(o['visible'], `${path}.visible`), position: oneOf(o['position'], LEGEND_POSITIONS, `${path}.position`), entries };
}

function validateEdge(v: unknown, path: string): DiagramEdge {
  const o = exactObject(v, EDGE_KEYS, path, ['description', 'strokeWidth', 'fontSize', 'labelOffset', 'behind', 'flow']);
  const waypoints = array(o['waypoints'], `${path}.waypoints`, DIAGRAM_LIMITS.maxWaypointsPerEdge)
    .map((p, i) => validatePoint(p, `${path}.waypoints[${i}]`));
  return {
    id: uuid(o['id'], `${path}.id`),
    sourceId: uuid(o['sourceId'], `${path}.sourceId`),
    targetId: uuid(o['targetId'], `${path}.targetId`),
    sourcePort: oneOf(o['sourcePort'], PORTS, `${path}.sourcePort`),
    targetPort: oneOf(o['targetPort'], PORTS, `${path}.targetPort`),
    route: oneOf(o['route'], ROUTES, `${path}.route`),
    waypoints,
    label: str(o['label'], `${path}.label`, DIAGRAM_LIMITS.maxEdgeLabelChars),
    ...(o['labelOffset'] !== undefined ? { labelOffset: labelOffset(o['labelOffset'], `${path}.labelOffset`) } : {}),
    ...(o['fontSize'] !== undefined ? { fontSize: num(o['fontSize'], `${path}.fontSize`, DIAGRAM_LIMITS.minFontSize, DIAGRAM_LIMITS.maxFontSize) } : {}),
    ...(o['description'] !== undefined ? { description: str(o['description'], `${path}.description`, DIAGRAM_LIMITS.maxDescriptionChars) } : {}),
    stroke: color(o['stroke'], `${path}.stroke`),
    ...(o['strokeWidth'] !== undefined ? { strokeWidth: num(o['strokeWidth'], `${path}.strokeWidth`, 0.5, 6) } : {}),
    dashed: bool(o['dashed'], `${path}.dashed`),
    arrows: oneOf(o['arrows'], ARROWS, `${path}.arrows`),
    ...(o['behind'] !== undefined && bool(o['behind'], `${path}.behind`) ? { behind: true } : {}),
    ...(o['flow'] !== undefined ? { flow: validateFlowEdge(o['flow'], `${path}.flow`) } : {}),
  };
}

/**
 * Validates a whole diagram document and returns a clean copy containing only
 * known properties. `knownAssetIds` are the assets uploaded to this canvas;
 * image nodes may only reference those.
 */
export function validateDiagramDocument(input: unknown, knownAssetIds: ReadonlySet<string>): DiagramDocument {
  const o = exactObject(input, DOC_KEYS, 'document', DOC_OPTIONAL_KEYS);
  if (o['version'] !== 1) fail('document.version', 'must be 1');
  const nodes = array(o['nodes'], 'document.nodes', DIAGRAM_LIMITS.maxNodes).map((n, i) => validateNode(n, `document.nodes[${i}]`));
  const edges = array(o['edges'], 'document.edges', DIAGRAM_LIMITS.maxEdges).map((e, i) => validateEdge(e, `document.edges[${i}]`));
  const vp = exactObject(o['viewport'], VIEWPORT_KEYS, 'document.viewport');
  const off = DIAGRAM_LIMITS.maxViewportOffset;
  const viewport = {
    x: num(vp['x'], 'document.viewport.x', -off, off),
    y: num(vp['y'], 'document.viewport.y', -off, off),
    zoom: num(vp['zoom'], 'document.viewport.zoom', DIAGRAM_LIMITS.minZoom, DIAGRAM_LIMITS.maxZoom),
  };
  const grid = bool(o['grid'], 'document.grid');
  const snapToGrid = o['snapToGrid'] === undefined ? undefined : bool(o['snapToGrid'], 'document.snapToGrid');
  const snapToShapes = o['snapToShapes'] === undefined ? undefined : bool(o['snapToShapes'], 'document.snapToShapes');
  const gridSize = o['gridSize'] === undefined ? undefined : num(o['gridSize'], 'document.gridSize', GRID_FINEST, GRID_COARSE);
  if (gridSize !== undefined && ![GRID_FINEST, GRID_FINE, GRID_STANDARD, GRID_COARSE].includes(gridSize)) fail('document.gridSize', 'must be 5, 10, 20 or 40');
  const footnotes = o['footnotes'] === undefined ? undefined
    : array(o['footnotes'], 'document.footnotes', DIAGRAM_LIMITS.maxFootnotes).map((f, i) => validateFootnote(f, `document.footnotes[${i}]`));
  const legend = o['legend'] === undefined ? undefined : validateLegend(o['legend'], 'document.legend');
  const notesPanel = o['notesPanel'] === undefined ? undefined : oneOf(o['notesPanel'], ['bottom', 'right'] as const, 'document.notesPanel');
  const diagramType = o['diagramType'] === undefined ? undefined : oneOf(o['diagramType'], DIAGRAM_TYPES, 'document.diagramType');

  // Ids are unique across nodes and edges (case-insensitively); references match exactly.
  const seen = new Set<string>();
  const byId = new Map<string, DiagramNode>();
  nodes.forEach((n, i) => {
    const key = n.id.toLowerCase();
    if (seen.has(key)) fail(`document.nodes[${i}].id`, 'is a duplicate id');
    seen.add(key);
    byId.set(n.id, n);
  });
  edges.forEach((e, i) => {
    const key = e.id.toLowerCase();
    if (seen.has(key)) fail(`document.edges[${i}].id`, 'is a duplicate id');
    seen.add(key);
    if (!byId.has(e.sourceId)) fail(`document.edges[${i}].sourceId`, 'references a missing node');
    if (!byId.has(e.targetId)) fail(`document.edges[${i}].targetId`, 'references a missing node');
    if (byId.get(e.sourceId)?.kind === 'line') fail(`document.edges[${i}].sourceId`, 'cannot attach a connector to a standalone line');
    if (byId.get(e.targetId)?.kind === 'line') fail(`document.edges[${i}].targetId`, 'cannot attach a connector to a standalone line');
  });

  nodes.forEach((n, i) => {
    if (n.assetId !== null && !knownAssetIds.has(n.assetId)) fail(`document.nodes[${i}].assetId`, 'references a missing asset');
    if (n.parentId === null) return;
    if (n.parentId === n.id) fail(`document.nodes[${i}].parentId`, 'must not reference the node itself');
    const parent = byId.get(n.parentId);
    if (parent === undefined) fail(`document.nodes[${i}].parentId`, 'references a missing node');
    if (!PARENT_KINDS.has(parent.kind)) fail(`document.nodes[${i}].parentId`, 'must reference a container or swimlane');
  });

  // Parent chains must terminate (no cycles). Each node is resolved at most once.
  const state = new Map<string, 'visiting' | 'done'>();
  nodes.forEach((start, i) => {
    const chain: string[] = [];
    let cur: DiagramNode | undefined = start;
    while (cur !== undefined && state.get(cur.id) !== 'done') {
      if (state.get(cur.id) === 'visiting') fail(`document.nodes[${i}].parentId`, 'creates a parent cycle');
      state.set(cur.id, 'visiting');
      chain.push(cur.id);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    for (const id of chain) state.set(id, 'done');
  });

  if (footnotes !== undefined) {
    const edgeIds = new Set(edges.map(e => e.id));
    const targets = new Set<string>();
    footnotes.forEach((f, i) => {
      const key = f.id.toLowerCase();
      if (seen.has(key)) fail(`document.footnotes[${i}].id`, 'is a duplicate id');
      seen.add(key);
      if (!byId.has(f.targetId) && !edgeIds.has(f.targetId)) fail(`document.footnotes[${i}].targetId`, 'references a missing shape or connector');
      if (targets.has(f.targetId)) fail(`document.footnotes[${i}].targetId`, 'already has a footnote');
      targets.add(f.targetId);
    });
  }

  return {
    version: 1,
    ...(diagramType !== undefined ? { diagramType } : {}),
    nodes, edges, grid, viewport,
    ...(snapToGrid !== undefined ? { snapToGrid } : {}),
    ...(snapToShapes !== undefined ? { snapToShapes } : {}),
    ...(gridSize !== undefined ? { gridSize } : {}),
    ...(footnotes !== undefined ? { footnotes } : {}),
    ...(legend !== undefined ? { legend } : {}),
    ...(notesPanel !== undefined ? { notesPanel } : {}),
  };
}

// ─── Assets ─────────────────────────────────────────────────────────────────

function rejectFile(reason: string): never {
  throw new ValidationError(`Invalid image: ${reason}`, { file: reason });
}

export function normaliseContentType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

export function validateAssetName(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('name query parameter is required', { name: 'required' });
  const name = v.trim();
  if (name === '' || name.length > DIAGRAM_LIMITS.maxAssetNameChars) {
    throw new ValidationError(`name must be 1-${DIAGRAM_LIMITS.maxAssetNameChars} characters`, { name: 'invalid length' });
  }
  if (NAME_CONTROL_RE.test(name)) throw new ValidationError('name must not contain control characters', { name: 'control characters' });
  return name;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_BIT_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Validates the PNG container (signature, IHDR, every chunk CRC, IDAT, IEND, no trailing bytes). */
export function inspectPng(buf: Buffer): { width: number; height: number } {
  if (buf.length < PNG_SIGNATURE.length + 25 + 12 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) rejectFile('not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let first = true;
  for (;;) {
    if (offset + 12 > buf.length) rejectFile('truncated PNG chunk');
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) rejectFile('invalid PNG chunk type');
    const dataEnd = offset + 8 + length;
    if (length > 0x7fffffff || dataEnd + 4 > buf.length) rejectFile('truncated PNG chunk');
    if (crc32(buf, offset + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) rejectFile(`bad CRC in PNG ${type} chunk`);
    if (first) {
      if (type !== 'IHDR' || length !== 13) rejectFile('PNG must start with an IHDR chunk');
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
      const bitDepth = buf[offset + 16]!;
      const colorType = buf[offset + 17]!;
      if (width < 1 || height < 1 || width > DIAGRAM_LIMITS.maxPngDimension || height > DIAGRAM_LIMITS.maxPngDimension) {
        rejectFile(`PNG dimensions must be 1-${DIAGRAM_LIMITS.maxPngDimension} pixels`);
      }
      if (width * height > DIAGRAM_LIMITS.maxPngPixels) rejectFile(`PNG must have at most ${DIAGRAM_LIMITS.maxPngPixels} pixels`);
      if (!(PNG_BIT_DEPTHS[colorType] ?? []).includes(bitDepth)) rejectFile('invalid PNG colour type / bit depth');
      if (buf[offset + 18] !== 0 || buf[offset + 19] !== 0 || (buf[offset + 20] !== 0 && buf[offset + 20] !== 1)) {
        rejectFile('invalid PNG compression, filter or interlace method');
      }
      first = false;
    } else if (type === 'IHDR') {
      rejectFile('duplicate PNG IHDR chunk');
    }
    if (type === 'IDAT') sawIdat = true;
    offset = dataEnd + 4;
    if (type === 'IEND') {
      if (length !== 0) rejectFile('invalid PNG IEND chunk');
      if (offset !== buf.length) rejectFile('unexpected data after PNG IEND');
      break;
    }
  }
  if (!sawIdat) rejectFile('PNG has no image data');
  return { width, height };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Static, non-scriptable, non-fetching SVG — enough for official Azure / Power
// Platform / Fabric icon exports (gradients, masks, clip paths, filters, <style>
// classes, url(#local) paint). Anything else (script, foreignObject, a, image,
// animate/set, feImage, iframe …) is rejected.
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'metadata', 'symbol', 'use', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'marker', 'pattern',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feFlood', 'feComposite',
  'feMerge', 'feMergeNode', 'feDropShadow', 'feMorphology', 'feComponentTransfer', 'feFuncR', 'feFuncG',
  'feFuncB', 'feFuncA', 'feTurbulence', 'feDisplacementMap', 'feConvolveMatrix', 'feTile',
  'feDiffuseLighting', 'feSpecularLighting', 'feDistantLight', 'fePointLight', 'feSpotLight',
]);
const SVG_FORBIDDEN_ATTRS: ReadonlySet<string> = new Set(['src', 'action', 'formaction', 'background', 'lowsrc', 'dynsrc', 'srcset']);
const ATTR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const NCNAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// Local fragment ids; Azure icon ids are often UUIDs, which may start with a digit.
const LOCAL_REF_RE = /^#[A-Za-z0-9_][\w.:-]*$/;
const LOCAL_URL_RE = /url\((['"]?)#[a-z0-9_][\w.:-]*\1\)/g;
// Editor bookkeeping namespaces (Inkscape, Illustrator, Sketch, Serif, RDF metadata).
// Their elements/attributes are ignored by renderers; they may be declared, nothing else may.
const INERT_NAMESPACES: ReadonlySet<string> = new Set([
  'http://www.inkscape.org/namespaces/inkscape',
  'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://purl.org/dc/elements/1.1/',
  'http://creativecommons.org/ns#',
  'http://web.resource.org/cc/',
  'http://www.bohemiancoding.com/sketch/ns',
  'http://www.serif.com/',
  'http://ns.adobe.com/AdobeIllustrator/10.0/',
  'http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/',
  'http://ns.adobe.com/Extensibility/1.0/',
  'http://ns.adobe.com/Flows/1.0/',
  'http://ns.adobe.com/GenericCustomNamespace/1.0/',
  'http://ns.adobe.com/Graphs/1.0/',
  'http://ns.adobe.com/ImageReplacement/1.0/',
  'http://ns.adobe.com/SaveForWeb/1.0/',
  'http://ns.adobe.com/Variables/1.0/',
  'http://ns.adobe.com/XPath/1.0/',
]);
const CSS_FORBIDDEN = ['url(', '@import', '@font-face', '@namespace', 'expression(', 'javascript:', 'vbscript:', 'data:',
  '-moz-binding', 'behavior:', 'image(', 'image-set(', 'cross-fade(', 'element(', 'src(', 'paint('];

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(v: string): string {
  return v.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (_m, ref: string) => {
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff) rejectFile('SVG contains an invalid character reference');
      return String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[ref];
    if (named === undefined) rejectFile('SVG must not use entities');
    return named;
  });
}

/** Rejects any CSS / attribute value that could fetch a resource or run code. Only url(#local) is allowed. */
function checkSvgValue(raw: string, where: string): void {
  const value = decodeXml(raw);
  if (value.includes('\\')) rejectFile(`SVG ${where} must not contain escapes`);
  // Browsers ignore whitespace/control characters inside these tokens, so compare without them.
  // eslint-disable-next-line no-control-regex
  const compact = value.toLowerCase().replace(/[\s\u0000-\u001f\u007f]+/g, '').replace(/\/\*.*?\*\//g, '');
  const withoutLocal = compact.replace(LOCAL_URL_RE, '');
  for (const token of CSS_FORBIDDEN) {
    if (withoutLocal.includes(token)) rejectFile(`SVG ${where} contains a forbidden reference (${token})`);
  }
}

type XmlEntry = Record<string, unknown>;

const svgParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: false,
  processEntities: false,
  htmlEntities: false,
  commentPropName: '#comment',
  cdataPropName: '#cdata',
  ignoreDeclaration: false,
  ignorePiTags: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function entryName(entry: XmlEntry): string {
  const keys = Object.keys(entry).filter((k) => k !== ':@');
  if (keys.length !== 1) rejectFile('SVG could not be parsed safely');
  return keys[0]!;
}

function entryAttrs(entry: XmlEntry): Array<[string, unknown]> {
  const attrs = entry[':@'];
  if (attrs === undefined) return [];
  if (!isPlainObject(attrs)) rejectFile('SVG could not be parsed safely');
  return Object.entries(attrs);
}

function entryChildren(entry: XmlEntry, name: string): XmlEntry[] {
  const children = entry[name];
  if (!Array.isArray(children)) rejectFile('SVG could not be parsed safely');
  return children as XmlEntry[];
}

type PrefixKind = 'xlink' | 'svg' | 'inert';

/**
 * Collects every xmlns:prefix declaration in the document. A prefix may only be
 * bound to the xlink namespace (as "xlink"), the SVG namespace, or an inert
 * editor namespace, and never to two different namespaces — so a prefixed name
 * can never smuggle in XHTML, XML Events or an aliased xlink:href.
 */
function collectPrefixes(entries: XmlEntry[], out: Map<string, PrefixKind>): void {
  for (const entry of entries) {
    const name = entryName(entry);
    if (name === '#text' || name === '#comment' || name === '#cdata' || name.startsWith('?')) continue;
    for (const [attr, value] of entryAttrs(entry)) {
      if (!attr.startsWith('xmlns:')) continue;
      const prefix = attr.slice('xmlns:'.length);
      if (!NCNAME_RE.test(prefix) || typeof value !== 'string') rejectFile(`SVG namespace declaration ${attr} is invalid`);
      const uri = decodeXml(value).trim();
      let kind: PrefixKind;
      if (prefix === 'xlink' && uri === XLINK_NS) kind = 'xlink';
      else if (prefix !== 'xlink' && uri === SVG_NS) kind = 'svg';
      else if (prefix !== 'xlink' && INERT_NAMESPACES.has(uri)) kind = 'inert';
      else rejectFile(`SVG namespace ${attr}="${uri}" is not allowed`);
      const prev = out.get(prefix);
      if (prev !== undefined && prev !== kind) rejectFile(`SVG namespace prefix ${prefix} is declared twice`);
      out.set(prefix, kind);
    }
    collectPrefixes(entryChildren(entry, name), out);
  }
}

/**
 * Counts start tags with a sequential scan (skipping comments, CDATA sections and
 * processing instructions exactly as an XML parser does), so it can be compared
 * with the number of elements actually validated.
 */
function countStartTags(text: string): number {
  let count = 0;
  let i = text.indexOf('<');
  while (i !== -1) {
    let end: number;
    if (text.startsWith('<!--', i)) end = text.indexOf('-->', i + 4);
    else if (text.startsWith('<![CDATA[', i)) end = text.indexOf(']]>', i + 9);
    else if (text.startsWith('<?', i)) end = text.indexOf('?>', i + 2);
    else {
      if (/[A-Za-z_:]/.test(text.charAt(i + 1))) count++;
      end = i + 1;
    }
    if (end === -1) rejectFile('SVG is not well-formed XML');
    i = text.indexOf('<', end);
  }
  return count;
}

/**
 * Validates an SVG upload: UTF-8, well-formed XML (fast-xml-parser), single
 * <svg> root in the SVG namespace, allowlisted elements and attributes, no
 * DTD/entities/CDATA/processing instructions, no event handlers, and no
 * references outside the document (href and url() must be local "#id").
 */
export function validateSvg(buf: Buffer): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    rejectFile('SVG must be UTF-8 text');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) rejectFile('SVG must not contain NUL characters');
  const lower = text.toLowerCase();
  if (lower.includes('<!doctype')) rejectFile('SVG must not contain a DOCTYPE');
  if (lower.includes('<!entity')) rejectFile('SVG must not declare entities');
  if (XMLValidator.validate(text, { allowBooleanAttributes: false }) !== true) rejectFile('SVG is not well-formed XML');

  let doc: unknown;
  try {
    doc = svgParser.parse(text);
  } catch {
    rejectFile('SVG is not well-formed XML');
  }
  if (!Array.isArray(doc)) rejectFile('SVG could not be parsed safely');
  const prefixes = new Map<string, PrefixKind>();
  collectPrefixes(doc as XmlEntry[], prefixes);

  let elements = 0;
  const walk = (entry: XmlEntry, name: string, depth: number, isRoot: boolean): void => {
    if (depth > DIAGRAM_LIMITS.maxSvgDepth) rejectFile('SVG is nested too deeply');
    if (++elements > DIAGRAM_LIMITS.maxSvgElements) rejectFile('SVG has too many elements');
    // Element: an allowlisted SVG element (optionally svg:-prefixed), or an inert editor element
    // (sodipodi:namedview, rdf:RDF …) whose children are still validated with the same rules.
    const colon = name.indexOf(':');
    const elPrefix = colon === -1 ? null : name.slice(0, colon);
    const elLocal = colon === -1 ? name : name.slice(colon + 1);
    const elKind = elPrefix === null ? 'svg' : prefixes.get(elPrefix);
    const inertElement = elKind === 'inert';
    if (!inertElement && (elKind !== 'svg' || !SVG_ELEMENTS.has(elLocal))) rejectFile(`SVG element <${name}> is not allowed`);
    if (inertElement && !NCNAME_RE.test(elLocal)) rejectFile(`SVG element <${name}> is not allowed`);
    for (const [attr, value] of entryAttrs(entry)) {
      if (typeof value !== 'string') rejectFile(`SVG attribute ${attr} is invalid`);
      const parts = attr.split(':');
      if (parts.length > 2) rejectFile(`SVG attribute ${attr} is not allowed`);
      const prefix = parts.length === 2 ? parts[0]! : null;
      const local = parts.length === 2 ? parts[1]! : attr;
      const localLower = local.toLowerCase();
      if (!(prefix === null ? ATTR_NAME_RE : NCNAME_RE).test(local)) rejectFile(`SVG attribute ${attr} is not allowed`);
      if (localLower.startsWith('on')) rejectFile(`SVG event handler attribute ${attr} is not allowed`);
      if (SVG_FORBIDDEN_ATTRS.has(localLower)) rejectFile(`SVG attribute ${attr} is not allowed`);
      const decoded = decodeXml(value);
      if (prefix === null) {
        if (attr === 'xmlns' && decoded !== SVG_NS) rejectFile('SVG must only use the SVG namespace');
      } else if (prefix === 'xmlns') {
        // Already validated by collectPrefixes.
      } else if (prefix === 'xml') {
        if (local !== 'space' && local !== 'lang') rejectFile(`SVG attribute ${attr} is not allowed`);
      } else {
        const kind = prefixes.get(prefix);
        if (kind === 'xlink') {
          if (local !== 'href' && local !== 'title') rejectFile(`SVG attribute ${attr} is not allowed`);
        } else if (kind !== 'inert' || localLower === 'href') {
          rejectFile(`SVG attribute ${attr} is not allowed`);
        }
      }
      const isLink = localLower === 'href' && (prefix === null || prefixes.get(prefix) === 'xlink');
      if (isLink && !LOCAL_REF_RE.test(decoded.trim())) rejectFile('SVG must not reference external resources');
      checkSvgValue(value, `attribute ${attr}`);
    }
    if (isRoot && (name !== 'svg' || entryAttrs(entry).find(([k]) => k === 'xmlns')?.[1] !== SVG_NS)) {
      rejectFile('SVG root must declare the SVG namespace');
    }
    for (const child of entryChildren(entry, name)) {
      const childName = entryName(child);
      if (childName === '#text') {
        // Text content may only use the predefined XML entities / character references.
        if (elLocal === 'style' && !inertElement) checkSvgValue(String(child['#text']), 'style');
        else decodeXml(String(child['#text']));
        continue;
      }
      if (childName === '#comment') continue;
      if (childName === '#cdata') {
        // Illustrator wraps <style> in CDATA; allowed there only, with the same CSS checks.
        if (elLocal !== 'style' || inertElement) rejectFile('SVG must only use CDATA inside <style>');
        const parts = entryChildren(child, '#cdata');
        for (const part of parts) {
          if (entryName(part) !== '#text') rejectFile('SVG could not be parsed safely');
          checkSvgValue(String(part['#text']), 'style');
        }
        continue;
      }
      if (childName.startsWith('?') || childName.startsWith('!')) rejectFile('SVG must not contain processing instructions');
      walk(child, childName, depth + 1, false);
    }
  };

  let roots = 0;
  (doc as XmlEntry[]).forEach((entry, index) => {
    const name = entryName(entry);
    if (name === '#comment') return;
    if (name === '#text') {
      if (String(entry['#text']).trim() !== '') rejectFile('SVG has text outside the root element');
      return;
    }
    if (name === '?xml') {
      if (index !== 0) rejectFile('SVG XML declaration must come first');
      return;
    }
    if (name.startsWith('?') || name.startsWith('!')) rejectFile('SVG must not contain processing instructions');
    if (name !== 'svg') rejectFile('SVG root element must be <svg>');
    roots++;
    walk(entry, name, 0, true);
  });
  if (roots !== 1) rejectFile('SVG must have exactly one <svg> root element');

  // Cross-check: every start tag in the source must have been walked, so the
  // parser cannot have silently dropped an element (e.g. a "__proto__" tag).
  if (countStartTags(text) !== elements) rejectFile('SVG could not be parsed safely');
}

/** Validates an uploaded asset's declared type against its bytes. */
export function validateAssetUpload(buf: unknown, contentTypeHeader: string | undefined): {
  contentType: AssetContentType; width: number | null; height: number | null;
} {
  const contentType = normaliseContentType(contentTypeHeader);
  if (!(ASSET_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new ValidationError('Content-Type must be image/png or image/svg+xml', { contentType: 'unsupported' });
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) rejectFile('request body must be the raw image bytes');
  if (buf.length > DIAGRAM_LIMITS.maxAssetBytes) rejectFile(`image must be at most ${DIAGRAM_LIMITS.maxAssetBytes} bytes`);
  if (contentType === 'image/png') {
    const { width, height } = inspectPng(buf);
    return { contentType, width, height };
  }
  validateSvg(buf);
  return { contentType: 'image/svg+xml', width: null, height: null };
}
