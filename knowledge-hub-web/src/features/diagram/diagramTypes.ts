export interface DiagramPoint { x: number; y: number }
export type DiagramPort = 'top' | 'right' | 'bottom' | 'left';
export type DiagramKind = 'process' | 'decision' | 'terminator' | 'document' | 'line' | 'text' | 'image' | 'container' | 'swimlane';
export const DIAGRAM_CALLOUT_TYPES = ['question', 'risk', 'issue', 'assumption', 'decision', 'action'] as const;
export type DiagramCalloutType = typeof DIAGRAM_CALLOUT_TYPES[number];
export interface DiagramNode {
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
  textColor: string;
  fontSize: number;
  textAlign?: 'left' | 'center' | 'right';
  textVerticalAlign?: 'top' | 'middle' | 'bottom';
  /** Containers and swimlanes only: children hidden, header shown. */
  collapsed?: boolean;
  assetId: string | null;
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
}
export interface DiagramDocument {
  version: 1;
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
export interface DiagramDrilldownLink { nodeId: string; canvasId: string; title: string }
export interface DiagramAsset { id: string; name: string; contentType: string }

export const emptyDiagram = (): DiagramDocument => ({
  version: 1, nodes: [], edges: [], grid: true, viewport: { x: 0, y: 0, zoom: 1 },
});
