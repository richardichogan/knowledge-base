import type { DiagramDocument, DiagramEdge, DiagramKind, DiagramNode, DiagramPoint, DiagramPort } from './diagramTypes';

/** Pure geometry helpers for the diagram editor. All coordinates are absolute world coordinates. */

export interface Rect { x: number; y: number; width: number; height: number }
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type OrderOp = 'front' | 'back' | 'forward' | 'backward';

export const PORTS: readonly DiagramPort[] = ['top', 'right', 'bottom', 'left'];
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const MIN_NODE_SIZE = 24;
export const ORTHO_STUB = 20;
export const CONTAINER_HEADER = 28;
export const SWIMLANE_HEADER = 32;

const EPS = 1e-6;

export const isContainerKind = (kind: DiagramKind): boolean => kind === 'container' || kind === 'swimlane';

export const documentWaveDepth = (height: number): number => Math.min(12, height * 0.15);

export function documentShapePath(r: Rect): string {
  const bottom = r.y + r.height - documentWaveDepth(r.height);
  const depth = documentWaveDepth(r.height);
  return `M${r.x},${r.y} H${r.x + r.width} V${bottom} Q${r.x + r.width * 0.75},${bottom - depth * 2} ${r.x + r.width / 2},${bottom} Q${r.x + r.width * 0.25},${bottom + depth * 2} ${r.x},${bottom} Z`;
}

// ── Rects ────────────────────────────────────────────────────────────────────

export function nodeRect(n: Pick<DiagramNode, 'x' | 'y' | 'width' | 'height'>): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

export function rectCenter(r: Rect): DiagramPoint {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounds of nodes plus edge bend points. */
export function documentBounds(doc: Pick<DiagramDocument, 'nodes' | 'edges'>): Rect | null {
  const rects: Rect[] = doc.nodes.map(nodeRect);
  for (const e of doc.edges) for (const w of e.waypoints) rects.push({ x: w.x, y: w.y, width: 0, height: 0 });
  return boundsOf(rects);
}

export function normalizeRect(a: DiagramPoint, b: DiagramPoint): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function rectContainsPoint(r: Rect, p: DiagramPoint, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
    && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function insetRect(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, width: Math.max(0, r.width - 2 * d), height: Math.max(0, r.height - 2 * d) };
}

// ── Ports ────────────────────────────────────────────────────────────────────

export function portPoint(r: Rect, port: DiagramPort, kind?: DiagramKind): DiagramPoint {
  switch (port) {
    case 'top': return { x: r.x + r.width / 2, y: r.y };
    case 'right': return { x: r.x + r.width, y: r.y + r.height / 2 };
    case 'bottom': return { x: r.x + r.width / 2, y: r.y + r.height - (kind === 'document' ? documentWaveDepth(r.height) : 0) };
    case 'left': return { x: r.x, y: r.y + r.height / 2 };
  }
}

export function portVector(port: DiagramPort): DiagramPoint {
  switch (port) {
    case 'top': return { x: 0, y: -1 };
    case 'right': return { x: 1, y: 0 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
  }
}

export function nearestPort(r: Rect, p: DiagramPoint, kind?: DiagramKind): DiagramPort {
  let best: DiagramPort = 'top';
  let bestD = Infinity;
  for (const port of PORTS) {
    const d = distance(portPoint(r, port, kind), p);
    if (d < bestD) { bestD = d; best = port; }
  }
  return best;
}

/** Facing ports for a fresh connection between two boxes. */
export function facingPorts(a: Rect, b: Rect): [DiagramPort, DiagramPort] {
  const ca = rectCenter(a); const cb = rectCenter(b);
  const dx = cb.x - ca.x; const dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

// ── Hierarchy ────────────────────────────────────────────────────────────────

export function nodeMap(nodes: readonly DiagramNode[]): Map<string, DiagramNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

export function childrenOf(nodes: readonly DiagramNode[]): Map<string | null, DiagramNode[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string | null, DiagramNode[]>();
  for (const n of nodes) {
    const key = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
    const list = out.get(key);
    if (list) list.push(n); else out.set(key, [n]);
  }
  return out;
}

export function descendantIds(nodes: readonly DiagramNode[], id: string): Set<string> {
  const kids = childrenOf(nodes);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const c of kids.get(cur) ?? []) {
      if (out.has(c.id) || c.id === id) continue;
      out.add(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

export function withDescendants(nodes: readonly DiagramNode[], ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const d of descendantIds(nodes, id)) out.add(d);
  }
  return out;
}

export function ancestorIds(nodes: readonly DiagramNode[], id: string): string[] {
  const byId = nodeMap(nodes);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id)?.parentId ?? null;
  while (cur !== null && !seen.has(cur)) {
    const p = byId.get(cur);
    if (!p) break;
    out.push(cur);
    seen.add(cur);
    cur = p.parentId;
  }
  return out;
}

/** Selected ids whose ancestors are not also selected (so a move translates each node exactly once). */
export function topLevelSelection(nodes: readonly DiagramNode[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestorIds(nodes, id).some((a) => set.has(a)));
}

export function canParent(nodes: readonly DiagramNode[], childId: string, parentId: string | null): boolean {
  if (parentId === null) return true;
  if (childId === parentId) return false;
  const parent = nodes.find((n) => n.id === parentId);
  if (!parent || !isContainerKind(parent.kind)) return false;
  return !descendantIds(nodes, childId).has(parentId);
}

export function setParent(nodes: readonly DiagramNode[], ids: readonly string[], parentId: string | null): DiagramNode[] {
  const allowed = new Set(ids.filter((id) => canParent(nodes, id, parentId)));
  return nodes.map((n) => (allowed.has(n.id) ? { ...n, parentId } : n));
}

/** Paint order: every node after its ancestors, siblings in array order. */
export function renderOrder(nodes: readonly DiagramNode[]): DiagramNode[] {
  const kids = childrenOf(nodes);
  const out: DiagramNode[] = [];
  const seen = new Set<string>();
  const visit = (n: DiagramNode): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
    for (const c of kids.get(n.id) ?? []) visit(c);
  };
  for (const root of kids.get(null) ?? []) visit(root);
  for (const n of nodes) visit(n); // cycles: anything not yet reached
  return out;
}

/** Topmost container (not excluded) containing point p. */
export function containerAt(nodes: readonly DiagramNode[], p: DiagramPoint, excludeIds: ReadonlySet<string> = new Set()): DiagramNode | null {
  const ordered = renderOrder(nodes);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const n = ordered[i] as DiagramNode;
    if (!isContainerKind(n.kind) || excludeIds.has(n.id)) continue;
    if (rectContainsPoint(nodeRect(n), p)) return n;
  }
  return null;
}

// ── Movement & resizing ──────────────────────────────────────────────────────

/** Move nodes and all their descendants exactly once; bends of edges wholly inside the moved set follow. */
export function translateNodes<T extends Pick<DiagramDocument, 'nodes' | 'edges'>>(doc: T, ids: Iterable<string>, dx: number, dy: number): T {
  if (dx === 0 && dy === 0) return doc;
  const moved = withDescendants(doc.nodes, ids);
  if (moved.size === 0) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (moved.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    edges: doc.edges.map((e) => (moved.has(e.sourceId) && moved.has(e.targetId) && e.waypoints.length > 0
      ? { ...e, waypoints: e.waypoints.map((w) => ({ x: w.x + dx, y: w.y + dy })) }
      : e)),
  };
}

export function resizeRect(r: Rect, handle: ResizeHandle, p: DiagramPoint, opts: { min?: number; keepAspect?: boolean } = {}): Rect {
  const min = opts.min ?? MIN_NODE_SIZE;
  let left = r.x; let top = r.y; let right = r.x + r.width; let bottom = r.y + r.height;
  if (handle.includes('w')) left = Math.min(p.x, right - min);
  if (handle.includes('e')) right = Math.max(p.x, left + min);
  if (handle.includes('n')) top = Math.min(p.y, bottom - min);
  if (handle.includes('s')) bottom = Math.max(p.y, top + min);
  let width = right - left; let height = bottom - top;
  if (opts.keepAspect === true && r.width > 0 && r.height > 0) {
    const ratio = r.width / r.height;
    const horizontal = handle.includes('e') || handle.includes('w');
    const vertical = handle.includes('n') || handle.includes('s');
    if (horizontal && (!vertical || width / ratio >= height)) height = Math.max(min, width / ratio);
    else width = Math.max(min, height * ratio);
    if (handle.includes('w')) left = right - width;
    if (handle.includes('n')) top = bottom - height;
    if (!horizontal) left = r.x + (r.width - width) / 2;
    if (!vertical) top = r.y + (r.height - height) / 2;
  }
  return { x: left, y: top, width, height };
}

export function snap(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

// ── Edge routing ─────────────────────────────────────────────────────────────

export function distance(a: DiagramPoint, b: DiagramPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const same = (a: DiagramPoint, b: DiagramPoint): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/** Drop duplicate points and middle points of collinear runs. */
export function simplifyPolyline(points: readonly DiagramPoint[]): DiagramPoint[] {
  const out: DiagramPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && same(last, p)) continue;
    const prev = out[out.length - 2];
    if (last && prev) {
      const cross = (last.x - prev.x) * (p.y - last.y) - (last.y - prev.y) * (p.x - last.x);
      const dot = (last.x - prev.x) * (p.x - last.x) + (last.y - prev.y) * (p.y - last.y);
      if (Math.abs(cross) < EPS && dot >= 0) { out[out.length - 1] = p; continue; }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function axisSegmentHitsRect(a: DiagramPoint, b: DiagramPoint, r: Rect): boolean {
  const inner = insetRect(r, 1);
  if (inner.width <= 0 || inner.height <= 0) return false;
  const minX = Math.min(a.x, b.x); const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y); const maxY = Math.max(a.y, b.y);
  return maxX > inner.x && minX < inner.x + inner.width && maxY > inner.y && minY < inner.y + inner.height;
}

function polylineLength(points: readonly DiagramPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1] as DiagramPoint, points[i] as DiagramPoint);
  return len;
}

/** Connect p→q with axis-aligned segments; `horizontalFirst` picks which elbow. */
function elbow(p: DiagramPoint, q: DiagramPoint, horizontalFirst: boolean): DiagramPoint[] {
  if (Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS) return [q];
  return horizontalFirst ? [{ x: q.x, y: p.y }, q] : [{ x: p.x, y: q.y }, q];
}

const isHorizontalPort = (port: DiagramPort): boolean => port === 'left' || port === 'right';

/**
 * Orthogonal route from s (leaving through sPort) to t (entering through tPort).
 * With waypoints, the route passes through each waypoint; otherwise the cheapest candidate that avoids both boxes wins.
 */
export function orthogonalRoute(
  s: DiagramPoint, sPort: DiagramPort, sRect: Rect | null,
  t: DiagramPoint, tPort: DiagramPort, tRect: Rect | null,
  waypoints: readonly DiagramPoint[] = [],
): DiagramPoint[] {
  const vs = portVector(sPort); const vt = portVector(tPort);
  const a = { x: s.x + vs.x * ORTHO_STUB, y: s.y + vs.y * ORTHO_STUB };
  const b = { x: t.x + vt.x * ORTHO_STUB, y: t.y + vt.y * ORTHO_STUB };

  if (waypoints.length > 0) {
    const pts: DiagramPoint[] = [s, a];
    let horizontal = isHorizontalPort(sPort);
    for (const w of [...waypoints, b]) {
      const prev = pts[pts.length - 1] as DiagramPoint;
      const seg = elbow(prev, w, horizontal);
      pts.push(...seg);
      const last = pts[pts.length - 1] as DiagramPoint;
      const before = pts[pts.length - 2] as DiagramPoint;
      horizontal = Math.abs(last.y - before.y) < EPS;
    }
    pts.push(t);
    return simplifyPolyline(pts);
  }

  const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
  const xs = [mx, Math.max(a.x, b.x), Math.min(a.x, b.x)];
  const ys = [my, Math.max(a.y, b.y), Math.min(a.y, b.y)];
  if (sRect && tRect) {
    const outer = boundsOf([sRect, tRect]) as Rect;
    xs.push(outer.x - ORTHO_STUB, outer.x + outer.width + ORTHO_STUB);
    ys.push(outer.y - ORTHO_STUB, outer.y + outer.height + ORTHO_STUB);
  }
  const candidates: DiagramPoint[][] = [
    [a, { x: b.x, y: a.y }, b],
    [a, { x: a.x, y: b.y }, b],
    ...xs.map((x) => [a, { x, y: a.y }, { x, y: b.y }, b]),
    ...ys.map((y) => [a, { x: a.x, y }, { x: b.x, y }, b]),
  ];

  let best: DiagramPoint[] = candidates[0] as DiagramPoint[];
  let bestScore = Infinity;
  for (const c of candidates) {
    const full = simplifyPolyline([s, ...c, t]);
    let score = polylineLength(full) + full.length * 4;
    for (let i = 1; i < full.length; i++) {
      const p = full[i - 1] as DiagramPoint; const q = full[i] as DiagramPoint;
      if (sRect && i > 1 && axisSegmentHitsRect(p, q, sRect)) score += 10000;
      if (tRect && i < full.length - 1 && axisSegmentHitsRect(p, q, tRect)) score += 10000;
    }
    // Leaving or entering against the port direction looks broken.
    const first = full[1]; const lastInner = full[full.length - 2];
    if (first && (first.x - s.x) * vs.x + (first.y - s.y) * vs.y < -EPS) score += 5000;
    if (lastInner && (lastInner.x - t.x) * vt.x + (lastInner.y - t.y) * vt.y < -EPS) score += 5000;
    if (score < bestScore) { bestScore = score; best = full; }
  }
  return best;
}

export function straightRoute(s: DiagramPoint, t: DiagramPoint, waypoints: readonly DiagramPoint[] = []): DiagramPoint[] {
  return [s, ...waypoints.map((w) => ({ x: w.x, y: w.y })), t];
}

export function edgeEndpoints(edge: DiagramEdge, byId: ReadonlyMap<string, DiagramNode>): { s: DiagramPoint; t: DiagramPoint; sRect: Rect; tRect: Rect } | null {
  const src = byId.get(edge.sourceId); const tgt = byId.get(edge.targetId);
  if (!src || !tgt) return null;
  const sRect = nodeRect(src); const tRect = nodeRect(tgt);
  return { s: portPoint(sRect, edge.sourcePort, src.kind), t: portPoint(tRect, edge.targetPort, tgt.kind), sRect, tRect };
}

/** The rendered polyline for an edge, attached to the current node geometry. */
export function edgeRoute(edge: DiagramEdge, byId: ReadonlyMap<string, DiagramNode>): DiagramPoint[] | null {
  const ends = edgeEndpoints(edge, byId);
  if (!ends) return null;
  return edge.route === 'orthogonal'
    ? orthogonalRoute(ends.s, edge.sourcePort, ends.sRect, ends.t, edge.targetPort, ends.tRect, edge.waypoints)
    : straightRoute(ends.s, ends.t, edge.waypoints);
}

export function pathD(points: readonly DiagramPoint[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x)} ${round2(p.y)}`).join(' ');
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Point at fraction f (0..1) of the polyline's length. */
export function pointAlong(points: readonly DiagramPoint[], f: number): DiagramPoint {
  const first = points[0];
  if (!first) return { x: 0, y: 0 };
  const total = polylineLength(points);
  if (total === 0) return first;
  let remaining = total * Math.min(1, Math.max(0, f));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as DiagramPoint; const b = points[i] as DiagramPoint;
    const d = distance(a, b);
    if (remaining <= d) {
      const t = d === 0 ? 0 : remaining / d;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= d;
  }
  return points[points.length - 1] as DiagramPoint;
}

/** Arc-length position (0..1) of the point on the polyline nearest p. */
export function fractionAlong(points: readonly DiagramPoint[], p: DiagramPoint): number {
  const total = polylineLength(points);
  if (total === 0) return 0;
  let bestD = Infinity; let bestLen = 0; let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as DiagramPoint; const b = points[i] as DiagramPoint;
    const seg = distance(a, b);
    const t = seg === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (seg * seg)));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = distance(p, q);
    if (d < bestD) { bestD = d; bestLen = acc + seg * t; }
    acc += seg;
  }
  return bestLen / total;
}

/** Insert a waypoint so that waypoints stay ordered along the rendered route; returns the new list and its index. */
export function insertWaypoint(route: readonly DiagramPoint[], waypoints: readonly DiagramPoint[], p: DiagramPoint): { waypoints: DiagramPoint[]; index: number } {
  const f = fractionAlong(route, p);
  const fs = waypoints.map((w) => fractionAlong(route, w));
  let index = fs.findIndex((x) => x > f);
  if (index === -1) index = waypoints.length;
  const next = [...waypoints.slice(0, index), { x: p.x, y: p.y }, ...waypoints.slice(index)];
  return { waypoints: next, index };
}

export function distanceToSegment(p: DiagramPoint, a: DiagramPoint, b: DiagramPoint): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function distanceToPolyline(p: DiagramPoint, points: readonly DiagramPoint[]): number {
  if (points.length === 1) return distance(p, points[0] as DiagramPoint);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, distanceToSegment(p, points[i - 1] as DiagramPoint, points[i] as DiagramPoint));
  return best;
}

// ── Hit testing ──────────────────────────────────────────────────────────────

export function pointInNode(n: DiagramNode, p: DiagramPoint, pad = 0): boolean {
  if (!rectContainsPoint(nodeRect(n), p, pad)) return false;
  if (n.kind !== 'decision') return true;
  const c = rectCenter(n);
  const hw = n.width / 2 + pad; const hh = n.height / 2 + pad;
  if (hw <= 0 || hh <= 0) return false;
  return Math.abs(p.x - c.x) / hw + Math.abs(p.y - c.y) / hh <= 1 + EPS;
}

/** Topmost node under p (children paint above their containers). */
export function hitTestNode(nodes: readonly DiagramNode[], p: DiagramPoint, excludeIds: ReadonlySet<string> = new Set()): DiagramNode | null {
  const ordered = renderOrder(nodes);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const n = ordered[i] as DiagramNode;
    if (!excludeIds.has(n.id) && pointInNode(n, p)) return n;
  }
  return null;
}

export function hitTestEdge(edges: readonly DiagramEdge[], byId: ReadonlyMap<string, DiagramNode>, p: DiagramPoint, tolerance: number): DiagramEdge | null {
  let best: DiagramEdge | null = null; let bestD = tolerance;
  for (const e of edges) {
    const route = edgeRoute(e, byId);
    if (!route) continue;
    const d = distanceToPolyline(p, route);
    if (d <= bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Nodes wholly inside the marquee. */
export function nodesInRect(nodes: readonly DiagramNode[], r: Rect): string[] {
  return nodes.filter((n) => rectContainsRect(r, nodeRect(n))).map((n) => n.id);
}

// ── Arrangement ──────────────────────────────────────────────────────────────

export function alignNodes<T extends Pick<DiagramDocument, 'nodes' | 'edges'>>(doc: T, ids: readonly string[], mode: AlignMode): T {
  const top = topLevelSelection(doc.nodes, ids);
  const byId = nodeMap(doc.nodes);
  const sel = top.map((id) => byId.get(id)).filter((n): n is DiagramNode => n !== undefined);
  const b = boundsOf(sel.map(nodeRect));
  if (!b || sel.length < 2) return doc;
  let out = doc;
  for (const n of sel) {
    let dx = 0; let dy = 0;
    if (mode === 'left') dx = b.x - n.x;
    if (mode === 'center') dx = b.x + b.width / 2 - (n.x + n.width / 2);
    if (mode === 'right') dx = b.x + b.width - (n.x + n.width);
    if (mode === 'top') dy = b.y - n.y;
    if (mode === 'middle') dy = b.y + b.height / 2 - (n.y + n.height / 2);
    if (mode === 'bottom') dy = b.y + b.height - (n.y + n.height);
    out = translateNodes(out, [n.id], dx, dy);
  }
  return out;
}

/** Equal gaps between the outer two nodes along an axis (needs three or more). */
export function distributeNodes<T extends Pick<DiagramDocument, 'nodes' | 'edges'>>(doc: T, ids: readonly string[], axis: 'horizontal' | 'vertical'): T {
  const top = topLevelSelection(doc.nodes, ids);
  const byId = nodeMap(doc.nodes);
  const sel = top.map((id) => byId.get(id)).filter((n): n is DiagramNode => n !== undefined);
  if (sel.length < 3) return doc;
  const pos = (n: DiagramNode): number => (axis === 'horizontal' ? n.x : n.y);
  const size = (n: DiagramNode): number => (axis === 'horizontal' ? n.width : n.height);
  const sorted = [...sel].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0] as DiagramNode; const last = sorted[sorted.length - 1] as DiagramNode;
  const span = pos(last) + size(last) - pos(first);
  const used = sorted.reduce((acc, n) => acc + size(n), 0);
  const gap = (span - used) / (sorted.length - 1);
  let cursor = pos(first);
  let out = doc;
  for (const n of sorted) {
    const d = cursor - pos(n);
    out = translateNodes(out, [n.id], axis === 'horizontal' ? d : 0, axis === 'vertical' ? d : 0);
    cursor += size(n) + gap;
  }
  return out;
}

export function reorderNodes(nodes: readonly DiagramNode[], ids: readonly string[], op: OrderOp): DiagramNode[] {
  const set = new Set(ids);
  if (op === 'front') return [...nodes.filter((n) => !set.has(n.id)), ...nodes.filter((n) => set.has(n.id))];
  if (op === 'back') return [...nodes.filter((n) => set.has(n.id)), ...nodes.filter((n) => !set.has(n.id))];
  const arr = [...nodes];
  if (op === 'forward') {
    for (let i = arr.length - 2; i >= 0; i--) {
      const cur = arr[i] as DiagramNode; const next = arr[i + 1] as DiagramNode;
      if (set.has(cur.id) && !set.has(next.id)) { arr[i] = next; arr[i + 1] = cur; }
    }
  } else {
    for (let i = 1; i < arr.length; i++) {
      const cur = arr[i] as DiagramNode; const prev = arr[i - 1] as DiagramNode;
      if (set.has(cur.id) && !set.has(prev.id)) { arr[i] = prev; arr[i - 1] = cur; }
    }
  }
  return arr;
}

// ── Selection clone / delete ─────────────────────────────────────────────────

/** Copy nodes (with descendants) and edges wholly inside them, with fresh ids, offset by (dx, dy). */
export function cloneSelection(
  source: Pick<DiagramDocument, 'nodes' | 'edges'>, ids: readonly string[], dx: number, dy: number,
  makeId: () => string, target: Pick<DiagramDocument, 'nodes'> = source,
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const all = withDescendants(source.nodes, ids);
  const idMap = new Map<string, string>();
  for (const n of source.nodes) if (all.has(n.id)) idMap.set(n.id, makeId());
  const targetIds = new Set(target.nodes.map((n) => n.id));
  const nodes = source.nodes.filter((n) => all.has(n.id)).map((n) => {
    let parentId: string | null = null;
    if (n.parentId !== null) parentId = idMap.get(n.parentId) ?? (targetIds.has(n.parentId) ? n.parentId : null);
    return { ...n, id: idMap.get(n.id) as string, parentId, x: n.x + dx, y: n.y + dy };
  });
  const edges = source.edges.filter((e) => all.has(e.sourceId) && all.has(e.targetId)).map((e) => ({
    ...e,
    id: makeId(),
    sourceId: idMap.get(e.sourceId) as string,
    targetId: idMap.get(e.targetId) as string,
    waypoints: e.waypoints.map((w) => ({ x: w.x + dx, y: w.y + dy })),
  }));
  return { nodes, edges };
}

/** Remove nodes (with descendants), their edges and the given edges. */
export function removeSelection<T extends Pick<DiagramDocument, 'nodes' | 'edges'>>(doc: T, nodeIds: readonly string[], edgeIds: readonly string[]): T {
  const gone = withDescendants(doc.nodes, nodeIds);
  const goneEdges = new Set(edgeIds);
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !gone.has(n.id)),
    edges: doc.edges.filter((e) => !goneEdges.has(e.id) && !gone.has(e.sourceId) && !gone.has(e.targetId)),
  };
}

/** Repair a loaded document: drop dangling edges, clear missing or cyclic parents. */
export function normalizeDocument(doc: DiagramDocument): DiagramDocument {
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const ids = new Set(nodes.map((n) => n.id));
  let fixed = nodes.map((n) => ({ ...n, parentId: n.parentId !== null && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null }));
  for (const n of fixed) {
    const chain = new Set<string>([n.id]);
    let cur = n.parentId;
    const byId = nodeMap(fixed);
    while (cur !== null) {
      if (chain.has(cur)) { fixed = fixed.map((m) => (m.id === n.id ? { ...m, parentId: null } : m)); break; }
      chain.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
  }
  const edges = (Array.isArray(doc.edges) ? doc.edges : [])
    .filter((e) => ids.has(e.sourceId) && ids.has(e.targetId))
    .map((e) => ({ ...e, waypoints: Array.isArray(e.waypoints) ? e.waypoints : [] }));
  const v = doc.viewport;
  const viewport = v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0 ? v : { x: 0, y: 0, zoom: 1 };
  return { version: 1, nodes: fixed, edges, grid: doc.grid !== false, viewport };
}

// ── Viewport ─────────────────────────────────────────────────────────────────

export interface Viewport { x: number; y: number; zoom: number }

export function screenToWorld(p: DiagramPoint, v: Viewport): DiagramPoint {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

export function worldToScreen(p: DiagramPoint, v: Viewport): DiagramPoint {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

export function clampZoom(z: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, z));
}

/** Zoom about a fixed screen point. */
export function zoomAt(v: Viewport, screen: DiagramPoint, zoom: number): Viewport {
  const world = screenToWorld(screen, v);
  return { x: screen.x - world.x * zoom, y: screen.y - world.y * zoom, zoom };
}

export function fitViewport(bounds: Rect | null, width: number, height: number, padding: number, minZoom: number, maxZoom: number): Viewport {
  if (!bounds || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, zoom: 1 };
  const zx = (width - padding * 2) / Math.max(bounds.width, 1);
  const zy = (height - padding * 2) / Math.max(bounds.height, 1);
  const zoom = clampZoom(Math.min(zx, zy, 1), minZoom, maxZoom);
  return {
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** Approximate word wrap for SVG text (no DOM measuring). */
export function wrapText(text: string, maxWidth: number, fontSize: number, maxLines = Infinity): string[] {
  const charW = fontSize * 0.56;
  const perLine = Math.max(1, Math.floor(maxWidth / charW));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) { lines.push(''); continue; }
    let line = '';
    for (let word of words) {
      while (word.length > perLine) {
        if (line !== '') { lines.push(line); line = ''; }
        lines.push(word.slice(0, perLine));
        word = word.slice(perLine);
      }
      const candidate = line === '' ? word : `${line} ${word}`;
      if (candidate.length <= perLine) line = candidate;
      else { lines.push(line); line = word; }
    }
    if (line !== '') lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, Math.max(1, maxLines));
    const lastIdx = kept.length - 1;
    const last = kept[lastIdx] as string;
    kept[lastIdx] = `${last.slice(0, Math.max(0, perLine - 1))}…`;
    return kept;
  }
  return lines;
}

/** Fit an image of natural size inside a max box, preserving aspect ratio. */
export function fitSize(naturalW: number, naturalH: number, maxW: number, maxH: number): { width: number; height: number } {
  if (!(naturalW > 0) || !(naturalH > 0)) return { width: Math.min(maxW, maxH), height: Math.min(maxW, maxH) };
  const s = Math.min(maxW / naturalW, maxH / naturalH, Math.max(1, 64 / Math.max(naturalW, naturalH)));
  return { width: Math.max(MIN_NODE_SIZE, Math.round(naturalW * s)), height: Math.max(MIN_NODE_SIZE, Math.round(naturalH * s)) };
}

// ── Export helpers (consumed by diagramExport.ts) ────────────────────────────

/** Absolute route of an edge, or [] when either endpoint node is missing. */
export function edgePoints(edge: DiagramEdge, nodes: readonly DiagramNode[]): DiagramPoint[] {
  return edgeRoute(edge, nodeMap(nodes)) ?? [];
}

export const EDGE_LABEL_WIDTH = 160;
export const EDGE_LABEL_FONT = 12;

/** Padded, never-empty bounds of every node, edge route, waypoint and connector label; used as the export viewBox. */
export function diagramBounds(doc: Pick<DiagramDocument, 'nodes' | 'edges'>, padding = 24): Rect {
  const byId = nodeMap(doc.nodes);
  const rects: Rect[] = doc.nodes.map(nodeRect);
  for (const e of doc.edges) {
    const route = edgeRoute(e, byId) ?? [];
    for (const p of route) rects.push({ x: p.x, y: p.y, width: 0, height: 0 });
    for (const w of e.waypoints) rects.push({ x: w.x, y: w.y, width: 0, height: 0 });
    if (route.length >= 2 && e.label.trim() !== '') {
      // Conservative box for the midpoint label (12px text, wrapped at 160px, up to 3 lines).
      const lines = wrapText(e.label, EDGE_LABEL_WIDTH, EDGE_LABEL_FONT, 3);
      const w = Math.max(...lines.map((l) => l.length), 0) * EDGE_LABEL_FONT * 0.6 + 16;
      const h = lines.length * EDGE_LABEL_FONT * 1.25 + 12;
      const m = pointAlong(route, 0.5);
      rects.push({ x: m.x - w / 2, y: m.y - h / 2 - 8, width: w, height: h + 8 });
    }
  }
  const b = boundsOf(rects) ?? { x: 0, y: 0, width: 0, height: 0 };
  return { x: b.x - padding, y: b.y - padding, width: b.width + padding * 2, height: b.height + padding * 2 };
}