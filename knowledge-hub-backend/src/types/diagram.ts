/**
 * types/diagram.ts
 * Diagram canvas document. Mirrors knowledge-hub-web/src/features/diagram/diagramTypes.ts
 * exactly: keep both files in step.
 */
export interface DiagramPoint { x: number; y: number }
export type DiagramPort = 'top' | 'right' | 'bottom' | 'left';
export type DiagramKind = 'process' | 'decision' | 'terminator' | 'document' | 'arrow' | 'line' | 'text' | 'image' | 'container' | 'swimlane';
export const DIAGRAM_ARROW_DIRECTIONS = ['right', 'left', 'up', 'down'] as const;
export type DiagramArrowDirection = typeof DIAGRAM_ARROW_DIRECTIONS[number];
export const DIAGRAM_CALLOUT_TYPES = ['question', 'risk', 'issue', 'assumption', 'decision', 'action'] as const;
export type DiagramCalloutType = typeof DIAGRAM_CALLOUT_TYPES[number];
/** A diagram's semantic mode. Absent means 'general'. */
export const DIAGRAM_TYPES = ['general', 'ai-flow'] as const;
export type DiagramType = typeof DIAGRAM_TYPES[number];
export const AI_FLOW_STEP_TYPES = ['channel_interaction', 'human_task', 'ai_agent_task', 'ai_orchestration', 'decision_rules', 'integration', 'data_operation', 'external_party'] as const;
export type AiFlowStepType = typeof AI_FLOW_STEP_TYPES[number];
export const AI_FLOW_STATES = ['existing', 'future', 'both'] as const;
export type AiFlowState = typeof AI_FLOW_STATES[number];
export const AI_AGENT_MODES = ['assistive', 'semi_autonomous', 'supervised_autonomous', 'autonomous'] as const;
export type AiAgentMode = typeof AI_AGENT_MODES[number];
export const AI_ASSERTION_LEVELS = ['signal', 'advisory', 'authoritative'] as const;
export type AiAssertionLevel = typeof AI_ASSERTION_LEVELS[number];
export const AI_MEMORY_SCOPES = ['none', 'session', 'case', 'customer'] as const;
export type AiMemoryScope = typeof AI_MEMORY_SCOPES[number];
export const DATA_SENSITIVITIES = ['public', 'internal', 'confidential', 'pii', 'medical', 'pci'] as const;
export type DataSensitivity = typeof DATA_SENSITIVITIES[number];
export const AI_FLOW_VOLUMES = ['low', 'medium', 'high'] as const;
export type AiFlowVolume = typeof AI_FLOW_VOLUMES[number];
export const AI_FLOW_EDGE_TYPES = ['primary_flow', 'supporting_flow', 'conditional_flow', 'dependency', 'control'] as const;
export type AiFlowEdgeType = typeof AI_FLOW_EDGE_TYPES[number];
export const AI_FLOW_INTERACTIONS = ['sync', 'async', 'agent_handoff', 'human_handoff'] as const;
export type AiFlowInteraction = typeof AI_FLOW_INTERACTIONS[number];
/** Node kinds that may carry AI-flow step metadata. */
export const AI_FLOW_STEP_KINDS = ['process', 'decision', 'terminator', 'document'] as const;
export interface AiFlowAgent {
  role?: string;
  mode?: AiAgentMode;
  assertion?: AiAssertionLevel;
  orchestrator?: string;
  tools?: string[];
  knowledge?: string[];
  guardrails?: string[];
  escalationPath?: string;
  decisionBoundary?: string;
  /** 0–1. */
  confidenceThreshold?: number;
  memory?: AiMemoryScope;
  model?: string;
  promptVersion?: string;
}
export interface AiFlowControls {
  sensitivity?: DataSensitivity;
  authRequired?: boolean;
  authModel?: string;
  auditLogging?: boolean;
  humanApproval?: boolean;
  regulatoryTags?: string[];
}
export interface AiFlowOperations {
  volume?: AiFlowVolume;
  sla?: string;
  failureHandling?: string;
  monitoring?: string;
}
/** AI flow / governance metadata for a process step. */
export interface AiFlowStep {
  stepType: AiFlowStepType;
  state?: AiFlowState;
  actor?: string;
  systems?: string[];
  dataIn?: string[];
  dataOut?: string[];
  agent?: AiFlowAgent;
  controls?: AiFlowControls;
  operations?: AiFlowOperations;
}
/** AI flow metadata for a swimlane. */
export interface AiFlowLane {
  /** Lower first; lanes are stacked top to bottom. */
  order: number;
  /** Free-text owner or persona shown in the lane header. */
  owner?: string;
  description?: string;
}
export interface AiFlowEdge {
  edgeType: AiFlowEdgeType;
  interaction?: AiFlowInteraction;
  payload?: string;
  sensitivity?: DataSensitivity;
  auth?: string;
  condition?: string;
}export interface DiagramNode {
  id: string;
  kind: DiagramKind;
  label: string;
  description?: string;
  /** Text shapes only: a semantic annotation with an icon and type label. */
  calloutType?: DiagramCalloutType;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
  fill: string;
  stroke: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  lineStart?: DiagramPoint;
  lineEnd?: DiagramPoint;
  /** Arrow shapes only; absent means 'right'. */
  arrowDirection?: DiagramArrowDirection;
  textColor: string;
  fontSize: number;
  textAlign?: 'left' | 'center' | 'right';
  textVerticalAlign?: 'top' | 'middle' | 'bottom';
  /** Containers and swimlanes only: children hidden, header shown. */
  collapsed?: boolean;
  assetId: string | null;
  /** AI-flow step metadata (process, decision, terminator, document). */
  flow?: AiFlowStep;
  /** Swimlanes only: AI-flow lane metadata. */
  lane?: AiFlowLane;
}
export interface DiagramEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourcePort: DiagramPort;
  targetPort: DiagramPort;
  route: 'straight' | 'orthogonal';
  waypoints: DiagramPoint[];
  label: string;
  /** Label offset from the route midpoint, in diagram units. */
  labelOffset?: DiagramPoint;
  fontSize?: number;
  description?: string;
  stroke: string;
  strokeWidth?: number;
  dashed: boolean;
  arrows: 'none' | 'start' | 'end' | 'both';
  /** AI-flow connector metadata. */
  flow?: AiFlowEdge;
}
export interface DiagramDocument {
  version: 1;
  /** Absent means 'general'. */
  diagramType?: DiagramType;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  grid: boolean;
  viewport: { x: number; y: number; zoom: number };
  /** Optional numbered notes; the array order is the footnote number. */
  footnotes?: DiagramFootnote[];
  legend?: DiagramLegend;
  notesPanel?: 'bottom' | 'right';
}
export interface DiagramFootnote {
  id: string;
  /** Node or edge id the marker sits on. */
  targetId: string;
  source: 'description' | 'custom';
  text?: string;
}
export type DiagramLegendPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface DiagramLegendEntry { colour: string; label: string; hidden?: boolean }
export interface DiagramLegend {
  visible: boolean;
  position: DiagramLegendPosition;
  /** Labels for border colours; colours in use without an entry show unlabelled. */
  entries: DiagramLegendEntry[];
}
export interface DiagramSnapshot { revision: number; document: DiagramDocument }
export interface DiagramAsset { id: string; name: string; contentType: string }

export const emptyDiagram = (): DiagramDocument => ({
  version: 1, nodes: [], edges: [], grid: true, viewport: { x: 0, y: 0, zoom: 1 },
});

export type CanvasType = 'brainstorm' | 'diagram';
export const CANVAS_TYPES: readonly CanvasType[] = ['brainstorm', 'diagram'];
