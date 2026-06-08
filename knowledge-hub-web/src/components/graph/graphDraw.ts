/**
 * graph/graphDraw.ts
 * Canvas painters for nodes and edges in the force-directed graph.
 * Called from GraphCanvas via nodeCanvasObject / linkCanvasObject.
 * No React — pure canvas 2D logic.
 */
import { type NodeShape, drawShape, drawRing } from './graphShapes';

export const ACCENT         = '#3ddbd9';
export const MIN_RADIUS     = 5;
export const MAX_RADIUS     = 22;
/** Opacity for nodes/edges not in the hovered neighbourhood. */
export const DIM_ALPHA      = 0.12;
/** Zoom level past which node labels fade in. */
export const LABEL_ZOOM_THR = 1.6;
/** Duration (ms) of the node fade-in on initial load. */
export const FADE_DURATION  = 1500;

/**
 * Square-root degree scale — keeps high-degree hubs visible but not dominant.
 * @param edgeCount - Number of edges touching this node.
 * @param maxEdges  - Maximum edge count across all nodes (for normalisation).
 */
export function nodeRadius(edgeCount: number, maxEdges: number): number {
  return MIN_RADIUS + Math.sqrt(edgeCount / Math.max(1, maxEdges)) * (MAX_RADIUS - MIN_RADIUS);
}

export interface DrawNodeOpts {
  r: number;
  colour: string;
  shape: NodeShape;
  isSelected: boolean;
  isHovered:  boolean;
  isDimmed:   boolean;
  isPinned:   boolean;
  globalScale: number;
  /** Alpha multiplier for fade-in effect (0 → 1). */
  fadeAlpha:   number;
  label: string;
}

/**
 * Paints a single graph node: shape fill, selection/hover ring, pin indicator, and label.
 * Labels are hidden below LABEL_ZOOM_THR and always shown for selected/hovered nodes.
 */
export function drawNode(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  opts: DrawNodeOpts,
): void {
  const { r, colour, shape, isSelected, isHovered, isDimmed, isPinned, globalScale, fadeAlpha, label } = opts;
  const alpha = (isDimmed ? DIM_ALPHA : 1.0) * fadeAlpha;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  drawShape(ctx, shape, x, y, r);

  // Selection / hover ring
  if (isSelected || isHovered) {
    drawRing(ctx, x, y, r, ACCENT, 2 / globalScale);
  }

  // Pin indicator — small accent dot, offset top-right of the node
  if (isPinned && !isHovered && !isSelected) {
    ctx.beginPath();
    ctx.arc(x + r * 0.7, y - r * 0.7, 2.5 / globalScale, 0, 2 * Math.PI);
    ctx.fillStyle = ACCENT;
    ctx.globalAlpha = 0.7 * fadeAlpha;
    ctx.fill();
  }

  // Label: always for selected/hovered; fade in past zoom threshold otherwise
  const showLabel = isSelected || isHovered || globalScale > LABEL_ZOOM_THR;
  if (showLabel) {
    const labelAlpha = (isSelected || isHovered)
      ? 1.0
      : Math.min(1, (globalScale - LABEL_ZOOM_THR) / 0.4);
    ctx.globalAlpha = alpha * labelAlpha;
    ctx.font = `${9 / globalScale}px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = '#c6c6c6';
    ctx.textAlign = 'center';
    ctx.fillText(label.slice(0, 32), x, y + r + 12 / globalScale);
  }

  ctx.restore();
}

export interface DrawEdgeOpts {
  /** True when source or target is hovered or selected. */
  isHighlit:  boolean;
  isDimmed:   boolean;
  edgeType:   string;
  confidence: number;
  globalScale: number;
}

/**
 * Paints a single graph edge: solid for explicit, dashed for inferred,
 * highlighted or dimmed based on hover/selection state.
 */
export function drawEdge(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  tx: number, ty: number,
  opts: DrawEdgeOpts,
): void {
  const { isHighlit, isDimmed, edgeType, confidence, globalScale } = opts;
  const isInferred = edgeType === 'thematically_related';

  let opacity: number;
  if (isHighlit)      opacity = 1.0;
  else if (isDimmed)  opacity = DIM_ALPHA;
  else if (isInferred) opacity = confidence * 0.5;
  else                opacity = 0.15;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = isHighlit ? ACCENT : '#525252';
  ctx.lineWidth   = (isHighlit ? 2 : 1) / globalScale;

  if (isInferred) {
    const dash = 4 / globalScale;
    ctx.setLineDash([dash, dash]);
  } else {
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.restore();
}
