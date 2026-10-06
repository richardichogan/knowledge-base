export interface DiagramPoint { x: number; y: number }
export type DiagramPort = 'top' | 'right' | 'bottom' | 'left';
export type DiagramKind = 'process' | 'decision' | 'terminator' | 'text' | 'image' | 'container' | 'swimlane';
export interface DiagramNode {
  id: string;
  kind: DiagramKind;
  label: string;
  description?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
  fill: string;
  stroke: string;
  textColor: string;
  fontSize: number;
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
  description?: string;
  stroke: string;
  dashed: boolean;
  arrows: 'none' | 'end' | 'both';
}
export interface DiagramDocument {
  version: 1;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  grid: boolean;
  viewport: { x: number; y: number; zoom: number };
}
export interface DiagramSnapshot { revision: number; document: DiagramDocument }
export interface DiagramAsset { id: string; name: string; contentType: string }

export const emptyDiagram = (): DiagramDocument => ({
  version: 1, nodes: [], edges: [], grid: true, viewport: { x: 0, y: 0, zoom: 1 },
});
