/**
 * features/canvas/canvasGraph.ts — pure canvas logic, no React:
 *   - connection types (presets, colours, direction)
 *   - applyOps: the same changes the server applies (so edits show instantly)
 *   - inverseOps: the changes that undo a batch
 *   - placeNear: where a new card goes (a free spot around the card it's added to)
 *   - arrange: a force-directed tidy-up for cards without a saved position
 */
import type { CanvasEdgeApi, CanvasFullApi, CanvasNodeApi, MapOp } from '../../services/api';

export type GraphState = Pick<CanvasFullApi, 'nodes' | 'edges'>;
export interface Point { x: number; y: number }
export interface Size { w: number; h: number }

// ── Connection types ──────────────────────────────────────────────────────────

export interface LinkTypeStyle { colour: string; directed: boolean; dashed: boolean }

export const LINK_TYPES: Record<string, LinkTypeStyle> = {
  related:      { colour: '#8d8d8d', directed: false, dashed: false },
  supports:     { colour: '#42be65', directed: true,  dashed: false },
  contradicts:  { colour: '#fa4d56', directed: true,  dashed: true },
  'depends on': { colour: '#f1c21b', directed: true,  dashed: false },
  'part of':    { colour: '#4589ff', directed: true,  dashed: false },
  'leads to':   { colour: '#be95ff', directed: true,  dashed: false },
  'example of': { colour: '#3ddbd9', directed: true,  dashed: true },
};
export const DEFAULT_LINK_TYPE = 'related';
const CUSTOM_LINK_STYLE: LinkTypeStyle = { colour: '#ff7eb6', directed: true, dashed: false };

export function linkStyle(type: string): LinkTypeStyle {
  return LINK_TYPES[type] ?? CUSTOM_LINK_STYLE;
}

// ── Changes ───────────────────────────────────────────────────────────────────

function newNode(op: Extract<MapOp, { op: 'add' }>, canvasId: string): CanvasNodeApi {
  const placed = op.x !== undefined && op.y !== undefined;
  return {
    id: op.id, canvasId, nodeType: op.nodeType ?? (op.refType !== undefined ? 'hub_ref' : 'text'),
    refType: op.refType ?? null, refId: op.refId ?? null, label: op.label ?? '', body: op.body ?? null,
    url: op.url ?? null, tags: op.tags ?? null, x: op.x ?? 0, y: op.y ?? 0, placed, createdAt: new Date().toISOString(),
  };
}

function newEdge(id: string, sourceId: string, targetId: string, type: string | undefined, label: string | undefined, canvasId: string): CanvasEdgeApi {
  return {
    id, canvasId, sourceId, targetId, type: type !== undefined && type.trim() !== '' ? type.trim().toLowerCase() : DEFAULT_LINK_TYPE,
    label: label !== undefined && label.trim() !== '' ? label.trim() : null, createdAt: new Date().toISOString(),
  };
}

function applyOne(state: GraphState, op: MapOp, canvasId: string): GraphState {
  const { nodes, edges } = state;
  switch (op.op) {
    case 'add': {
      if (nodes.some((n) => n.id === op.id)) return state;
      const next = { nodes: [...nodes, newNode(op, canvasId)], edges };
      if (op.connectTo === undefined || !nodes.some((n) => n.id === op.connectTo?.nodeId)) return next;
      return { nodes: next.nodes, edges: [...edges, newEdge(op.connectTo.edgeId, op.connectTo.nodeId, op.id, op.connectTo.type, undefined, canvasId)] };
    }
    case 'update':
      return {
        nodes: nodes.map((n) => (n.id !== op.id ? n : {
          ...n,
          ...(op.label !== undefined && { label: op.label }),
          ...(op.body !== undefined && { body: op.body.trim() === '' ? null : op.body }),
        })),
        edges,
      };
    case 'position':
      return { nodes: nodes.map((n) => (n.id === op.id ? { ...n, x: op.x, y: op.y, placed: true } : n)), edges };
    case 'delete':
      return { nodes: nodes.filter((n) => n.id !== op.id), edges: edges.filter((e) => e.sourceId !== op.id && e.targetId !== op.id) };
    case 'link':
      if (edges.some((e) => e.id === op.id) || op.sourceId === op.targetId) return state;
      return { nodes, edges: [...edges, newEdge(op.id, op.sourceId, op.targetId, op.type, op.label, canvasId)] };
    case 'update_link':
      return {
        nodes,
        edges: edges.map((e) => (e.id !== op.id ? e : {
          ...e,
          ...(op.type !== undefined && { type: op.type.trim() === '' ? DEFAULT_LINK_TYPE : op.type.trim().toLowerCase() }),
          ...(op.label !== undefined && { label: op.label.trim() === '' ? null : op.label.trim() }),
        })),
      };
    case 'unlink':
      return { nodes, edges: edges.filter((e) => e.id !== op.id) };
  }
}

export function applyOps(state: GraphState, ops: MapOp[], canvasId: string): GraphState {
  return ops.reduce((s, op) => applyOne(s, op, canvasId), state);
}

function relinkOp(e: CanvasEdgeApi): MapOp {
  return { op: 'link', id: e.id, sourceId: e.sourceId, targetId: e.targetId, type: e.type, ...(e.label !== null && { label: e.label }) };
}

/** The changes that undo `ops`, given the state before they were applied. */
export function inverseOps(before: GraphState, ops: MapOp[], canvasId: string): MapOp[] {
  const inverses: MapOp[][] = [];
  let state = before;
  for (const op of ops) {
    switch (op.op) {
      case 'add': inverses.push([{ op: 'delete', id: op.id }]); break;
      case 'update': {
        const n = state.nodes.find((x) => x.id === op.id);
        if (n !== undefined) {
          inverses.push([{
            op: 'update', id: n.id,
            ...(op.label !== undefined && { label: n.label ?? '' }),
            ...(op.body !== undefined && { body: n.body ?? '' }),
          }]);
        }
        break;
      }
      case 'position': {
        const n = state.nodes.find((x) => x.id === op.id);
        if (n !== undefined) inverses.push([{ op: 'position', id: n.id, x: n.x, y: n.y }]);
        break;
      }
      case 'delete': {
        const n = state.nodes.find((x) => x.id === op.id);
        if (n !== undefined) {
          inverses.push([
            {
              op: 'add', id: n.id, label: n.label ?? '', nodeType: n.nodeType,
              ...(n.body !== null && { body: n.body }), ...(n.url !== null && { url: n.url }), ...(n.tags !== null && { tags: n.tags }),
              ...(n.refType !== null && n.refId !== null && { refType: n.refType, refId: n.refId }),
              ...(n.placed && { x: n.x, y: n.y }),
            },
            ...state.edges.filter((e) => e.sourceId === n.id || e.targetId === n.id).map(relinkOp),
          ]);
        }
        break;
      }
      case 'link': inverses.push([{ op: 'unlink', id: op.id }]); break;
      case 'update_link': {
        const e = state.edges.find((x) => x.id === op.id);
        if (e !== undefined) inverses.push([{ op: 'update_link', id: e.id, type: e.type, label: e.label ?? '' }]);
        break;
      }
      case 'unlink': {
        const e = state.edges.find((x) => x.id === op.id);
        if (e !== undefined) inverses.push([relinkOp(e)]);
        break;
      }
    }
    state = applyOne(state, op, canvasId);
  }
  return inverses.reverse().flat();
}

export function connectedIds(edges: CanvasEdgeApi[], id: string): string[] {
  return edges.flatMap((e) => (e.sourceId === id ? [e.targetId] : e.targetId === id ? [e.sourceId] : []));
}

// ── Placement ─────────────────────────────────────────────────────────────────

export const CARD_W = 240;
export const CARD_H = 96;
export const IDEA_W = 190;
export const IDEA_H = 56;
const GAP = 40;
const RING_STEP = 150;
const RING_SLOTS = 12;
const MAX_RINGS = 8;

export function estimateSize(node: CanvasNodeApi): Size {
  return node.refType !== null ? { w: CARD_W, h: CARD_H } : { w: IDEA_W, h: IDEA_H };
}

function overlaps(p: Point, s: Size, positions: Map<string, Point>, sizes: Map<string, Size>, ignore?: string): boolean {
  for (const [id, q] of positions) {
    if (id === ignore) continue;
    const t = sizes.get(id) ?? { w: CARD_W, h: CARD_H };
    if (Math.abs(p.x - q.x) < (s.w + t.w) / 2 + GAP && Math.abs(p.y - q.y) < (s.h + t.h) / 2 + GAP) return true;
  }
  return false;
}

/**
 * A free spot for a new card of size `size` near `anchor`: the first slot on
 * rings around it that doesn't overlap another card (right-hand side first).
 */
export function placeNear(anchor: Point, size: Size, positions: Map<string, Point>, sizes: Map<string, Size>): Point {
  for (let ring = 1; ring <= MAX_RINGS; ring++) {
    const radius = ring * RING_STEP + CARD_W / 2;
    const slots = RING_SLOTS * ring;
    for (let i = 0; i < slots; i++) {
      // Start at 0° (right), then alternate outwards: 0, +θ, -θ, +2θ …
      const k = Math.ceil(i / 2) * (i % 2 === 0 ? -1 : 1);
      const angle = (k * 2 * Math.PI) / slots;
      const p = { x: anchor.x + radius * Math.cos(angle), y: anchor.y + radius * Math.sin(angle) * 0.7 };
      if (!overlaps(p, size, positions, sizes)) return p;
    }
  }
  return { x: anchor.x + (MAX_RINGS + 1) * RING_STEP, y: anchor.y };
}

const ITERATIONS = 250;
const REPULSION = 90_000;
const SPRING = 0.02;
const SPRING_LENGTH = 320;
const CENTRE_PULL = 0.002;
const MAX_STEP = 30;

/**
 * Tidy arrangement: a force-directed pass (cards repel, connections pull)
 * that only moves the cards in `movable`; the others stay where they are.
 */
export function arrange(
  nodes: CanvasNodeApi[],
  edges: CanvasEdgeApi[],
  start: Map<string, Point>,
  sizes: Map<string, Size>,
  movable: Set<string>,
): Map<string, Point> {
  const pos = new Map<string, Point>(nodes.map((n) => [n.id, { ...(start.get(n.id) ?? { x: 0, y: 0 }) }]));
  if (movable.size === 0) return pos;
  for (let it = 0; it < ITERATIONS; it++) {
    const cooling = 1 - it / ITERATIONS;
    const force = new Map<string, Point>(nodes.map((n) => [n.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a === undefined || b === undefined) continue;
        const pa = pos.get(a.id);
        const pb = pos.get(b.id);
        if (pa === undefined || pb === undefined) continue;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        if (dx === 0 && dy === 0) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const sa = sizes.get(a.id) ?? estimateSize(a);
        const sb = sizes.get(b.id) ?? estimateSize(b);
        const minDist = (Math.max(sa.w, sb.w) + GAP) * 0.9;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        const d = Math.sqrt(d2);
        const f = REPULSION / d2 + (d < minDist ? (minDist - d) * 0.5 : 0);
        const fa = force.get(a.id);
        const fb = force.get(b.id);
        if (fa !== undefined) { fa.x += (dx / d) * f; fa.y += (dy / d) * f; }
        if (fb !== undefined) { fb.x -= (dx / d) * f; fb.y -= (dy / d) * f; }
      }
    }
    for (const e of edges) {
      const pa = pos.get(e.sourceId);
      const pb = pos.get(e.targetId);
      if (pa === undefined || pb === undefined) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const f = SPRING * (d - SPRING_LENGTH);
      const fa = force.get(e.sourceId);
      const fb = force.get(e.targetId);
      if (fa !== undefined) { fa.x += (dx / d) * f; fa.y += (dy / d) * f; }
      if (fb !== undefined) { fb.x -= (dx / d) * f; fb.y -= (dy / d) * f; }
    }
    for (const id of movable) {
      const p = pos.get(id);
      const f = force.get(id);
      if (p === undefined || f === undefined) continue;
      f.x -= p.x * CENTRE_PULL;
      f.y -= p.y * CENTRE_PULL;
      const step = Math.hypot(f.x, f.y);
      const limit = MAX_STEP * cooling + 1;
      const scale = step > limit ? limit / step : 1;
      p.x += f.x * scale;
      p.y += f.y * scale;
    }
  }
  return pos;
}

/**
 * Positions for every card: saved positions for placed cards; unplaced cards
 * start near a connected (or the first) card and are then tidied.
 */
export function initialPositions(nodes: CanvasNodeApi[], edges: CanvasEdgeApi[], sizes: Map<string, Size>): { positions: Map<string, Point>; arranged: Set<string> } {
  const positions = new Map<string, Point>();
  for (const n of nodes) if (n.placed) positions.set(n.id, { x: n.x, y: n.y });
  const unplaced = nodes.filter((n) => !n.placed);
  if (unplaced.length === 0) return { positions, arranged: new Set() };
  for (const n of unplaced) {
    const neighbour = connectedIds(edges, n.id).map((id) => positions.get(id)).find((p) => p !== undefined);
    const anchor = neighbour ?? positions.values().next().value ?? { x: 0, y: 0 };
    positions.set(n.id, positions.size === 0 ? { x: 0, y: 0 } : placeNear(anchor, sizes.get(n.id) ?? estimateSize(n), positions, sizes));
  }
  const arranged = new Set(unplaced.map((n) => n.id));
  return { positions: arrange(nodes, edges, positions, sizes, arranged), arranged };
}

/** The canvas as Markdown (copy / export). */
export function canvasMarkdown(title: string, nodes: CanvasNodeApi[], edges: CanvasEdgeApi[]): string {
  const name = new Map(nodes.map((n) => [n.id, n.label ?? 'Untitled']));
  return [
    `# ${title}`, '', '## Cards',
    ...nodes.map((n) => `- **${n.label ?? 'Untitled'}**${n.body !== null && n.body.trim() !== '' ? ` — ${n.body}` : ''}`),
    '', '## Connections',
    ...(edges.length === 0 ? ['- none'] : edges.map((e) => `- ${name.get(e.sourceId) ?? '?'} → *${e.type}* → ${name.get(e.targetId) ?? '?'}${e.label !== null ? ` (${e.label})` : ''}`)),
  ].join('\n');
}
