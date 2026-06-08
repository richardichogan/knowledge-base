/**
 * canvasTypes.ts
 * Shared types for the custom canvas feature.
 * No imports from React or external libs — pure data shapes.
 */

export type NodeType = 'hub_ref' | 'text' | 'ai_output';
export type RefType  = 'discover_item' | 'spark' | 'note' | 'content_item' | 'ai_session';
export type EdgeType = 'relates-to' | 'supports' | 'contradicts' | 'leads-to' | 'part-of';

export interface Viewport {
  x: number;    // pan offset x (screen pixels)
  y: number;    // pan offset y (screen pixels)
  zoom: number; // scale factor (0.1 – 3.0)
}

export interface CanvasNode {
  id: string;
  canvasId: string;
  nodeType: NodeType;
  refType: RefType | null;
  refId: string | null;
  label: string | null;
  body: string | null;
  url: string | null;
  tags: string[] | null;
  x: number;       // world-space
  y: number;       // world-space
  width: number;   // world-space
  height: number;  // world-space
  colour: string | null;
  createdAt: string;
}

export interface CanvasEdge {
  id: string;
  canvasId: string;
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  label: string | null;
  createdAt: string;
}

export interface CanvasSummary {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasFull extends CanvasSummary {
  viewport: Viewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** A node being actively dragged — carries its drag start offsets. */
export interface DragState {
  nodeId: string;
  startPointerX: number;  // screen px
  startPointerY: number;
  startNodeX: number;     // world px
  startNodeY: number;
}

/** Edge being drawn from a connection handle before it's dropped. */
export interface PendingEdge {
  sourceId: string;
  currentX: number; // screen px
  currentY: number;
}

export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
  'relates-to':  'Relates to',
  'supports':    'Supports',
  'contradicts': 'Contradicts',
  'leads-to':    'Leads to',
  'part-of':     'Part of',
};
