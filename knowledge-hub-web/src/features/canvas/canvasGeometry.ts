/**
 * canvasGeometry.ts
 * Pure geometry utilities for the canvas renderer.
 * No React, no side-effects — fully testable.
 */

import type { Viewport, CanvasNode } from './canvasTypes';

// ── Coordinate transforms ─────────────────────────────────────────────────────

/** Convert a world-space point to screen-space given the current viewport. */
export function worldToScreen(wx: number, wy: number, vp: Viewport): { x: number; y: number } {
  return {
    x: wx * vp.zoom + vp.x,
    y: wy * vp.zoom + vp.y,
  };
}

/** Convert a screen-space point back to world-space. */
export function screenToWorld(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
  return {
    x: (sx - vp.x) / vp.zoom,
    y: (sy - vp.y) / vp.zoom,
  };
}

// ── Viewport helpers ──────────────────────────────────────────────────────────

/** Clamp zoom to allowed range. */
export function clampZoom(z: number): number {
  const MIN = 0.1;
  const MAX = 3.0;
  return Math.min(MAX, Math.max(MIN, z));
}

/**
 * Produce a new viewport after a scroll-wheel zoom event.
 * Zooms centred on the pointer position (sx, sy) in screen space.
 */
export function zoomAroundPoint(
  vp: Viewport,
  sx: number,
  sy: number,
  deltaY: number,
): Viewport {
  const ZOOM_SENSITIVITY = 0.001;
  const rawZoom = vp.zoom * (1 - deltaY * ZOOM_SENSITIVITY);
  const newZoom = clampZoom(rawZoom);
  const scale   = newZoom / vp.zoom;
  return {
    zoom: newZoom,
    x: sx - (sx - vp.x) * scale,
    y: sy - (sy - vp.y) * scale,
  };
}

/**
 * Return a viewport that fits all nodes within the given canvas dimensions
 * with a small padding margin.
 */
export function fitViewport(nodes: CanvasNode[], canvasW: number, canvasH: number): Viewport {
  const PADDING = 64;
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }

  const worldW = maxX - minX || 1;
  const worldH = maxY - minY || 1;
  const zoom = clampZoom(
    Math.min(
      (canvasW - PADDING * 2) / worldW,
      (canvasH - PADDING * 2) / worldH,
    ),
  );
  return {
    zoom,
    x: PADDING + (canvasW - PADDING * 2 - worldW * zoom) / 2 - minX * zoom,
    y: PADDING + (canvasH - PADDING * 2 - worldH * zoom) / 2 - minY * zoom,
  };
}

// ── Hit testing ───────────────────────────────────────────────────────────────

/**
 * Return the node (if any) that contains the world-space point (wx, wy).
 * Tests in reverse order so top-painted node wins.
 */
export function hitTestNode(
  nodes: CanvasNode[],
  wx: number,
  wy: number,
): CanvasNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) {
      return n;
    }
  }
  return null;
}

// ── Connection handle hit testing ─────────────────────────────────────────────

/** The four cardinal handles on a node (in world space). */
export interface Handle {
  side: 'n' | 's' | 'e' | 'w';
  x: number;
  y: number;
}

const HANDLE_HIT_RADIUS = 10; // world-space pixels

export function getNodeHandles(n: CanvasNode): Handle[] {
  return [
    { side: 'n', x: n.x + n.width / 2, y: n.y },
    { side: 's', x: n.x + n.width / 2, y: n.y + n.height },
    { side: 'e', x: n.x + n.width,     y: n.y + n.height / 2 },
    { side: 'w', x: n.x,               y: n.y + n.height / 2 },
  ];
}

/**
 * Return the handle nearest to (wx, wy) if within HANDLE_HIT_RADIUS,
 * and the node it belongs to.
 */
export function hitTestHandle(
  nodes: CanvasNode[],
  wx: number,
  wy: number,
): { node: CanvasNode; handle: Handle } | null {
  let bestDist = HANDLE_HIT_RADIUS;
  let best: { node: CanvasNode; handle: Handle } | null = null;

  for (const node of nodes) {
    for (const handle of getNodeHandles(node)) {
      const d = Math.hypot(wx - handle.x, wy - handle.y);
      if (d < bestDist) {
        bestDist = d;
        best = { node, handle };
      }
    }
  }
  return best;
}

// ── Edge geometry ─────────────────────────────────────────────────────────────

/** Midpoints of two nodes' nearest facing edges (source → target). */
export function edgeEndpoints(
  source: CanvasNode,
  target: CanvasNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const sx = source.x + source.width  / 2;
  const sy = source.y + source.height / 2;
  const tx = target.x + target.width  / 2;
  const ty = target.y + target.height / 2;

  // Pick connection point on source border facing target
  const x1 = clampToBorder(source, sx, sy, tx, ty);
  const x2 = clampToBorder(target, tx, ty, sx, sy);
  return { x1: x1.x, y1: x1.y, x2: x2.x, y2: x2.y };
}

function clampToBorder(
  n: CanvasNode,
  cx: number, cy: number,
  ox: number, oy: number,
): { x: number; y: number } {
  const dx = ox - cx;
  const dy = oy - cy;
  const hw = n.width  / 2;
  const hh = n.height / 2;
  if (Math.abs(dx) * hh > Math.abs(dy) * hw) {
    // Exit via left or right edge
    const t = hw / Math.abs(dx);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  // Exit via top or bottom edge
  const t = hh / Math.abs(dy || 1);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Control points for a cubic bezier between two edge endpoints.
 * Returns [cp1x, cp1y, cp2x, cp2y].
 */
export function bezierControlPoints(
  x1: number, y1: number,
  x2: number, y2: number,
): [number, number, number, number] {
  const TENSION = 0.4;
  const dx = (x2 - x1) * TENSION;
  return [x1 + dx, y1, x2 - dx, y2];
}

/**
 * Approximate point-to-bezier distance by sampling N points.
 * Returns the minimum squared distance.
 */
export function bezierHitTest(
  px: number, py: number,
  x1: number, y1: number, cp1x: number, cp1y: number,
  cp2x: number, cp2y: number, x2: number, y2: number,
  threshold = 36, // px² (≈ 6px)
  samples = 30,
): boolean {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const bx = mt ** 3 * x1 + 3 * mt ** 2 * t * cp1x + 3 * mt * t ** 2 * cp2x + t ** 3 * x2;
    const by = mt ** 3 * y1 + 3 * mt ** 2 * t * cp1y + 3 * mt * t ** 2 * cp2y + t ** 3 * y2;
    if ((px - bx) ** 2 + (py - by) ** 2 < threshold) return true;
  }
  return false;
}

/** Midpoint of a cubic bezier at t=0.5. */
export function bezierMidpoint(
  x1: number, y1: number, cp1x: number, cp1y: number,
  cp2x: number, cp2y: number, x2: number, y2: number,
): { x: number; y: number } {
  const t = 0.5;
  const mt = 1 - t;
  return {
    x: mt ** 3 * x1 + 3 * mt ** 2 * t * cp1x + 3 * mt * t ** 2 * cp2x + t ** 3 * x2,
    y: mt ** 3 * y1 + 3 * mt ** 2 * t * cp1y + 3 * mt * t ** 2 * cp2y + t ** 3 * y2,
  };
}
