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

/** `colour` is for dark surfaces (side panel); `sheet` is the same hue for the light canvas sheet. */
export interface LinkTypeStyle { colour: string; sheet: string; directed: boolean; dashed: boolean }

export const LINK_TYPES: Record<string, LinkTypeStyle> = {
  related:      { colour: '#8d8d8d', sheet: '#a8a8a8', directed: false, dashed: false },
  supports:     { colour: '#42be65', sheet: '#198038', directed: true,  dashed: false },
  contradicts:  { colour: '#fa4d56', sheet: '#da1e28', directed: true,  dashed: true },
  'depends on': { colour: '#f1c21b', sheet: '#b28600', directed: true,  dashed: false },
  'part of':    { colour: '#4589ff', sheet: '#0f62fe', directed: true,  dashed: false },
  'leads to':   { colour: '#be95ff', sheet: '#8a3ffc', directed: true,  dashed: false },
  'example of': { colour: '#3ddbd9', sheet: '#007d79', directed: true,  dashed: true },
};
export const DEFAULT_LINK_TYPE = 'related';
const CUSTOM_LINK_STYLE: LinkTypeStyle = { colour: '#ff7eb6', sheet: '#d02670', directed: true, dashed: false };

export function linkStyle(type: string): LinkTypeStyle {
  return LINK_TYPES[type] ?? CUSTOM_LINK_STYLE;
}

// ── Changes ───────────────────────────────────────────────────────────────────

function newNode(op: Extract<MapOp, { op: 'add' }>, canvasId: string): CanvasNodeApi {
  const placed = op.x !== undefined && op.y !== undefined;
  return {
    id: op.id, canvasId, nodeType: op.nodeType ?? (op.refType !== undefined ? 'hub_ref' : 'text'),
    refType: op.refType ?? null, refId: op.refId ?? null, label: op.label ?? '', body: op.body ?? null,
    url: op.url ?? null, tags: op.tags ?? null,
    cardType: op.cardType !== undefined && op.cardType !== '' ? op.cardType : null,
    footnote: op.footnote !== undefined && op.footnote.trim() !== '' ? op.footnote.trim() : null,
    collapsed: op.collapsed === true, x: op.x ?? 0, y: op.y ?? 0, placed, createdAt: new Date().toISOString(),
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
          ...(op.cardType !== undefined && { cardType: op.cardType === '' ? null : op.cardType }),
          ...(op.footnote !== undefined && { footnote: op.footnote.trim() === '' ? null : op.footnote.trim() }),
          ...(op.collapsed !== undefined && { collapsed: op.collapsed }),
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
            ...(op.cardType !== undefined && { cardType: n.cardType ?? '' }),
            ...(op.footnote !== undefined && { footnote: n.footnote ?? '' }),
            ...(op.collapsed !== undefined && { collapsed: n.collapsed }),
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
              ...(n.cardType !== null && { cardType: n.cardType }), ...(n.footnote !== null && { footnote: n.footnote }), ...(n.collapsed && { collapsed: true }),
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

export function branchSide(node: CanvasNodeApi, root: CanvasNodeApi, tree: CardTree, byId: Map<string, CanvasNodeApi>): -1 | 1 {
  let branch = node;
  while (tree.parent.get(branch.id) !== undefined && tree.parent.get(branch.id) !== root.id) {
    const parent = byId.get(tree.parent.get(branch.id) ?? '');
    if (parent === undefined) break;
    branch = parent;
  }
  return branch.x < root.x ? -1 : 1;
}

/** Assign positions in operation order, so a batch sees the cards it has already added. */
export function positionNewCards(state: GraphState, ops: MapOp[], canvasId: string, selectedId: string | null, sizes: Map<string, Size>): MapOp[] {
  let current = state;
  return ops.map(raw => {
    let op = raw;
    if (raw.op === 'add' && (raw.x === undefined || raw.y === undefined)) {
      const root = current.nodes[0];
      const anchor = current.nodes.find(node => node.id === (raw.connectTo?.nodeId ?? selectedId)) ?? root;
      const childSize = estimateSize({ refType: raw.refType ?? null });
      let point: Point = { x: 0, y: 0 };
      if (root !== undefined && anchor !== undefined) {
        const tree = cardTree(current.nodes, current.edges, root.id);
        const byId = new Map(current.nodes.map(node => [node.id, node]));
        const sizeOf = (node: CanvasNodeApi): Size => sizes.get(node.id) ?? estimateSize(node);
        const rootChildren = (tree.children.get(root.id) ?? []).map(id => byId.get(id)).filter((node): node is CanvasNodeApi => node !== undefined);
        let side: -1 | 1;
        if (anchor.id === root.id) {
          const left = rootChildren.filter(node => node.x < root.x).length;
          side = left < rootChildren.length - left ? -1 : 1;
        } else {
          side = branchSide(anchor, root, tree, byId);
        }
        const anchorSize = sizeOf(anchor);
        const siblings = (tree.children.get(anchor.id) ?? [])
          .map(id => byId.get(id))
          .filter((node): node is CanvasNodeApi => node !== undefined && (anchor.id !== root.id || (node.x < root.x ? -1 : 1) === side));
        point = {
          x: anchor.x + side * (anchorSize.w / 2 + TREE_COLUMN_GAP + childSize.w / 2),
          y: siblings.length === 0 ? anchor.y : Math.max(...siblings.map(node => node.y + sizeOf(node).h / 2)) + TREE_ROW_GAP + childSize.h / 2,
        };
        // Move only the new card down past every obstacle in its column.
        const obstacles = current.nodes.filter(node => Math.abs(point.x - node.x) < (childSize.w + sizeOf(node).w) / 2 + TREE_ROW_GAP)
          .sort((a, b) => a.y - b.y);
        for (const obstacle of obstacles) {
          const minDistance = (childSize.h + sizeOf(obstacle).h) / 2 + TREE_ROW_GAP;
          if (Math.abs(point.y - obstacle.y) < minDistance) point.y = obstacle.y + minDistance;
        }
      }
      op = { ...raw, x: Math.round(point.x), y: Math.round(point.y) };
    }
    current = applyOps(current, [op], canvasId);
    return op;
  });
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

export function estimateSize(node: Pick<CanvasNodeApi, 'refType'>): Size {
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

const ELBOW_RADIUS = 4;

/** A connector between two cards: the path, plus the midpoint of its bend (for its label). */
export interface Elbow { d: string; mid: Point }

/**
 * A right-angled connector with rounded bends, from the side of card `a` that
 * faces card `b` to the facing side of `b`, bending halfway across the gap.
 * Cards that overlap horizontally are joined top/bottom instead. `endGap`
 * leaves room before `b` for an arrowhead.
 */
export function elbowPath(a: Point, as: Size, b: Point, bs: Size, endGap = 0): Elbow {
  const horizontal = Math.abs(b.x - a.x) >= (as.w + bs.w) / 2;
  if (horizontal) {
    const s = b.x > a.x ? 1 : -1;
    const x0 = a.x + (s * as.w) / 2;
    const x1 = b.x - s * (bs.w / 2 + endGap);
    const xm = (a.x + (s * as.w) / 2 + b.x - (s * bs.w) / 2) / 2;
    const mid = { x: xm, y: (a.y + b.y) / 2 };
    if (Math.abs(b.y - a.y) < 1) return { d: `M${x0},${a.y} H${x1}`, mid };
    const d = b.y > a.y ? 1 : -1;
    const r = Math.min(ELBOW_RADIUS, Math.abs(b.y - a.y) / 2, Math.abs(xm - x0), Math.abs(x1 - xm));
    return {
      d: `M${x0},${a.y} H${xm - s * r} Q${xm},${a.y} ${xm},${a.y + d * r} V${b.y - d * r} Q${xm},${b.y} ${xm + s * r},${b.y} H${x1}`,
      mid,
    };
  }
  const s = b.y > a.y ? 1 : -1;
  const y0 = a.y + (s * as.h) / 2;
  const y1 = b.y - s * (bs.h / 2 + endGap);
  const ym = (a.y + (s * as.h) / 2 + b.y - (s * bs.h) / 2) / 2;
  const mid = { x: (a.x + b.x) / 2, y: ym };
  if (Math.abs(b.x - a.x) < 1) return { d: `M${a.x},${y0} V${y1}`, mid };
  const d = b.x > a.x ? 1 : -1;
  const r = Math.min(ELBOW_RADIUS, Math.abs(b.x - a.x) / 2, Math.abs(ym - y0), Math.abs(y1 - ym));
  return {
    d: `M${a.x},${y0} V${ym - s * r} Q${a.x},${ym} ${a.x + d * r},${ym} H${b.x - d * r} Q${b.x},${ym} ${b.x},${ym + s * r} V${y1}`,
    mid,
  };
}

const TREE_COLUMN_GAP = 70;
const TREE_ROW_GAP = 24;

export interface CardTree {
  parent: Map<string, string>;
  children: Map<string, string[]>;
  depth: Map<string, number>;
  /** -1 left of the root (typed connection), 1 right (untyped, or not connected). */
  side: Map<string, -1 | 1>;
}

/**
 * The drawn hierarchy: breadth-first from the root over connections. Cards
 * not connected to the root hang off the root on the right.
 */
export function cardTree(nodes: CanvasNodeApi[], edges: CanvasEdgeApi[], rootId: string): CardTree {
  const known = new Set(nodes.map((n) => n.id));
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>([[rootId, 0]]);
  const side = new Map<string, -1 | 1>();
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    const kids: string[] = [];
    for (const e of edges) {
      const nb = e.sourceId === id ? e.targetId : e.targetId === id ? e.sourceId : null;
      if (nb === null || depth.has(nb) || !known.has(nb)) continue;
      depth.set(nb, (depth.get(id) ?? 0) + 1);
      side.set(nb, id === rootId ? (e.type === DEFAULT_LINK_TYPE ? 1 : -1) : (side.get(id) ?? 1));
      parent.set(nb, id);
      kids.push(nb);
      queue.push(nb);
    }
    children.set(id, kids);
  }
  const rootKids = children.get(rootId) ?? [];
  for (const n of nodes) {
    if (depth.has(n.id)) continue;
    depth.set(n.id, 1);
    side.set(n.id, 1);
    parent.set(n.id, rootId);
    children.set(n.id, []);
    rootKids.push(n.id);
  }
  children.set(rootId, rootKids);
  return { parent, children, depth, side };
}

/** Every card below `id` in the tree. */
export function descendants(tree: CardTree, id: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => { for (const k of tree.children.get(at) ?? []) { out.push(k); walk(k); } };
  walk(id);
  return out;
}

/** Cards hidden because a card above them is collapsed. */
export function hiddenCards(nodes: CanvasNodeApi[], tree: CardTree): Set<string> {
  const hidden = new Set<string>();
  for (const n of nodes) if (n.collapsed && tree.depth.get(n.id) !== 0) for (const d of descendants(tree, n.id)) hidden.add(d);
  return hidden;
}

/**
 * Two-sided card tree: the root stays where it is; cards joined to it by a
 * typed connection stack in a column to its left, cards joined by an untyped
 * ("related") connection stack to its right, and deeper cards sit in further
 * columns on their parent's side, centred on their parent. Cards not
 * connected to the root are added to the bottom of the right-hand column.
 */
export function twoSidedLayout(
  nodes: CanvasNodeApi[],
  edges: CanvasEdgeApi[],
  rootId: string,
  rootAt: Point,
  sizeOf: (n: CanvasNodeApi) => Size,
): Map<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (id: string): Size => {
    const n = byId.get(id);
    return n !== undefined ? sizeOf(n) : { w: CARD_W, h: CARD_H };
  };
  const { children: treeKids, depth, side } = cardTree(nodes, edges, rootId);
  // Collapsed cards take no room for their hidden children.
  const children = new Map([...treeKids].map(([id, kids]) => [id, id !== rootId && byId.get(id)?.collapsed === true ? [] : kids]));
  const rootKids = children.get(rootId) ?? [];

  // Each column is as wide as its widest card; columns step outwards from the root.
  const colWidth = new Map<string, number>();
  for (const [id, d] of depth) {
    if (d === 0) continue;
    const key = `${(side.get(id) ?? 1).toString()}:${d.toString()}`;
    colWidth.set(key, Math.max(colWidth.get(key) ?? 0, size(id).w));
  }
  const colX = (s: -1 | 1, d: number): number => {
    let offset = size(rootId).w / 2;
    for (let k = 1; k <= d; k++) {
      const w = colWidth.get(`${s.toString()}:${k.toString()}`) ?? CARD_W;
      offset += TREE_COLUMN_GAP + (k === d ? w / 2 : w);
    }
    return rootAt.x + s * offset;
  };

  const block = new Map<string, number>();
  const blockOf = (id: string): number => {
    const kids = children.get(id) ?? [];
    const stacked = kids.reduce((sum, k) => sum + blockOf(k), 0) + TREE_ROW_GAP * Math.max(kids.length - 1, 0);
    const h = Math.max(size(id).h, stacked);
    block.set(id, h);
    return h;
  };
  const pos = new Map<string, Point>([[rootId, { ...rootAt }]]);
  const stack = (ids: string[], centreY: number): void => {
    const total = ids.reduce((sum, k) => sum + blockOf(k), 0) + TREE_ROW_GAP * Math.max(ids.length - 1, 0);
    let top = centreY - total / 2;
    for (const id of ids) {
      const h = block.get(id) ?? size(id).h;
      const y = top + h / 2;
      pos.set(id, { x: colX(side.get(id) ?? 1, depth.get(id) ?? 1), y });
      stack(children.get(id) ?? [], y);
      top += h + TREE_ROW_GAP;
    }
  };
  stack(rootKids.filter((id) => side.get(id) === -1), rootAt.y);
  stack(rootKids.filter((id) => side.get(id) !== -1), rootAt.y);
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
  const root = nodes[0];
  if (root === undefined) return { positions, arranged: new Set() };
  if (!positions.has(root.id)) positions.set(root.id, { x: 0, y: 0 });
  const tree = cardTree(nodes, edges, root.id);
  const ordered = unplaced.filter(node => node.id !== root.id)
    .sort((a, b) => (tree.depth.get(a.id) ?? 0) - (tree.depth.get(b.id) ?? 0));
  for (const node of ordered) {
    const available = nodes.flatMap(n => {
      const position = positions.get(n.id);
      return position === undefined ? [] : [{ ...n, ...position, placed: true }];
    });
    const availableIds = new Set(available.map(n => n.id));
    const existingEdges = edges.filter(e => availableIds.has(e.sourceId) && availableIds.has(e.targetId));
    const parent = tree.parent.get(node.id) ?? root.id;
    const op: MapOp = { op: 'add', id: node.id, ...(node.refType !== null && { refType: node.refType }),
      connectTo: { nodeId: parent, edgeId: '' } };
    const placed = positionNewCards({ nodes: available, edges: existingEdges }, [op], node.canvasId, parent, sizes)[0];
    if (placed?.op === 'add' && placed.x !== undefined && placed.y !== undefined) positions.set(node.id, { x: placed.x, y: placed.y });
  }
  const arranged = new Set(unplaced.map((n) => n.id));
  return { positions, arranged };
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
