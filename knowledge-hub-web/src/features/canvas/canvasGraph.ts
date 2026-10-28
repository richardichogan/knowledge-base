/**
 * features/canvas/canvasGraph.ts — pure canvas logic, no React:
 *   - connection types (presets, colours, direction)
 *   - applyOps: the same changes the server applies (so edits show instantly)
 *   - inverseOps: the changes that undo a batch
 *   - placeInBranches: keep new cards within their parent's mind-map group
 *   - radialLayout: evenly spread main branches and fan descendants outward
 */
import type { CanvasEdgeApi, CanvasFullApi, CanvasNodeApi, MapOp } from '../../services/api';
import { canvasCardTier } from './canvasStyle';

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
    style: op.style ?? null,
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
          ...(op.style !== undefined && { style: op.style }),
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
            ...(op.style !== undefined && { style: n.style ?? null }),
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
              ...(n.style != null && { style: n.style }),
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

/** Position a complete batch using the drawn parent groups, including new parents. */
export function positionNewCards(state: GraphState, ops: MapOp[], canvasId: string, selectedId: string | null, sizes: Map<string, Size>): MapOp[] {
  const next = applyOps(state, ops, canvasId);
  const root = next.nodes[0];
  const tree = root !== undefined ? cardTree(next.nodes, next.edges, root.id) : null;
  const automatic = new Set(ops.flatMap(op => op.op === 'add' && (op.x === undefined || op.y === undefined) ? [op.id] : []));
  const positions = placeInBranches(next.nodes, next.edges, automatic, node => {
    const estimate = estimateSize(node, tree?.depth.get(node.id) ?? 1);
    const measured = sizes.get(node.id);
    return measured?.w === estimate.w ? measured : estimate;
  });
  const added = new Set(ops.flatMap(op => op.op === 'add' ? [op.id] : []));
  const positioned = ops.map(op => {
    const point = op.op === 'add' && automatic.has(op.id) ? positions.get(op.id) : undefined;
    return point !== undefined ? { ...op, x: Math.round(point.x), y: Math.round(point.y) } : op;
  });
  for (const [id, point] of positions) {
    const before = state.nodes.find(node => node.id === id);
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (!added.has(id) && before !== undefined && (x !== before.x || y !== before.y)) positioned.push({ op: 'position', id, x, y });
  }
  return positioned;
}

// ── Placement ─────────────────────────────────────────────────────────────────

export const CARD_W = 240;
export const CARD_H = 96;
export const IDEA_W = 190;
export const IDEA_H = 56;

export function estimateSize(node: Pick<CanvasNodeApi, 'refType'>, depth = 1): Size {
  return { w: canvasCardTier(depth).width, h: node.refType !== null ? CARD_H : IDEA_H };
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

const TREE_BRANCH_GAP = 70;
const TREE_CARD_GAP = 24;

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

/** Equal-angle main branches with compact, outward-facing parent/child groups. */
export function radialLayout(
  nodes: CanvasNodeApi[],
  edges: CanvasEdgeApi[],
  rootId: string,
  rootAt: Point,
  sizeOf: (n: CanvasNodeApi) => Size,
  branch?: { angle: number; minRadius?: number; obstacles: { at: Point; size: Size }[] },
): Map<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (id: string): Size => {
    const n = byId.get(id);
    return n !== undefined ? sizeOf(n) : { w: CARD_W, h: CARD_H };
  };
  const { children: treeKids } = cardTree(nodes, edges, rootId);
  // Collapsed cards take no room for their hidden children.
  const children = new Map([...treeKids].map(([id, kids]) => [id, id !== rootId && byId.get(id)?.collapsed === true ? [] : kids]));
  const rootKids = children.get(rootId) ?? [];

  const pos = new Map<string, Point>([[rootId, { ...rootAt }]]);
  const dimensions = (id: string, angle: number): Size => {
    const card = size(id);
    const c = Math.abs(Math.cos(angle));
    const s = Math.abs(Math.sin(angle));
    return { w: c * card.w + s * card.h, h: s * card.w + c * card.h };
  };
  const compact = (id: string, angle: number): { points: Map<string, Point>; span: number } => {
    const card = dimensions(id, angle);
    const groups = (children.get(id) ?? []).map(child => ({ id: child, ...compact(child, angle) }));
    const total = groups.reduce((sum, group) => sum + group.span, 0) + Math.max(0, groups.length - 1) * TREE_CARD_GAP;
    const points = new Map<string, Point>([[id, { x: 0, y: 0 }]]);
    let cross = -total / 2;
    for (const group of groups) {
      const child = dimensions(group.id, angle);
      const along = (card.w + child.w) / 2 + TREE_BRANCH_GAP;
      for (const [childId, point] of group.points) {
        points.set(childId, { x: along + point.x, y: cross + group.span / 2 + point.y });
      }
      cross += group.span + TREE_CARD_GAP;
    }
    return { points, span: Math.max(card.h, total) };
  };
  const project = (point: Point, angle: number, radius = 0): Point => ({
    x: rootAt.x + (radius + point.x) * Math.cos(angle) - point.y * Math.sin(angle),
    y: rootAt.y + (radius + point.x) * Math.sin(angle) + point.y * Math.cos(angle),
  });
  if (branch !== undefined) {
    const group = compact(rootId, branch.angle);
    const nearest = Math.min(...rootKids.map(id => group.points.get(id)?.x ?? 0));
    let shift = Math.max(0, (branch.minRadius ?? 0) - nearest);
    const blocked: { start: number; end: number }[] = [];
    for (const [id, point] of group.points) {
      if (id === rootId) continue;
      const at = project(point, branch.angle);
      const card = size(id);
      for (const obstacle of branch.obstacles) {
        let start = -Infinity;
        let end = Infinity;
        for (const axis of ['x', 'y'] as const) {
          const velocity = axis === 'x' ? Math.cos(branch.angle) : Math.sin(branch.angle);
          const distance = at[axis] - obstacle.at[axis];
          const extent = ((axis === 'x' ? card.w + obstacle.size.w : card.h + obstacle.size.h) / 2) + TREE_CARD_GAP;
          if (Math.abs(velocity) < 1e-8) {
            if (Math.abs(distance) >= extent) { end = -Infinity; break; }
          } else {
            const a = (-extent - distance) / velocity;
            const b = (extent - distance) / velocity;
            start = Math.max(start, Math.min(a, b));
            end = Math.min(end, Math.max(a, b));
          }
        }
        if (start < end) blocked.push({ start, end });
      }
    }
    for (const interval of blocked.sort((a, b) => a.start - b.start)) {
      if (shift >= interval.start && shift <= interval.end) shift = interval.end + 1;
    }
    for (const [id, point] of group.points) if (id !== rootId) pos.set(id, project(point, branch.angle, shift));
    return pos;
  }
  const step = 2 * Math.PI / Math.max(1, rootKids.length);
  const groups = rootKids.map((id, i) => ({ id, angle: i * step, ...compact(id, i * step) }));
  const rootSize = size(rootId);
  let radius = Math.hypot(rootSize.w, rootSize.h) / 2 + TREE_BRANCH_GAP;
  const tangent = Math.tan(Math.min(Math.PI, step * 0.8) / 2);
  for (const group of groups) {
    radius = Math.max(radius, (dimensions(rootId, group.angle).w + dimensions(group.id, group.angle).w) / 2 + TREE_BRANCH_GAP);
    // Keep each compact group within its own sector, instead of spreading every depth onto a ring.
    for (const [id, point] of group.points) {
      const card = dimensions(id, group.angle);
      radius = Math.max(radius, (Math.abs(point.y) + card.h / 2 + TREE_CARD_GAP) / tangent - point.x + card.w / 2);
    }
  }
  for (const group of groups) {
    for (const [id, point] of group.points) pos.set(id, project(point, group.angle, radius));
  }
  return pos;
}

/** Reflow only the parent groups receiving automatically positioned cards. */
export function placeInBranches(
  nodes: CanvasNodeApi[], edges: CanvasEdgeApi[], automatic: Set<string>, sizeOf: (node: CanvasNodeApi) => Size,
): Map<string, Point> {
  const root = nodes[0];
  if (root === undefined || automatic.size === 0) return new Map();
  if (nodes.every(node => automatic.has(node.id))) return radialLayout(nodes, edges, root.id, root, sizeOf);
  const tree = cardTree(nodes, edges, root.id);
  const treeEdges = edges.filter(edge => tree.parent.get(edge.targetId) === edge.sourceId || tree.parent.get(edge.sourceId) === edge.targetId);
  const hidden = hiddenCards(nodes, tree);
  const positions = new Map(nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  const changed = new Map<string, Point>();
  const positioned = new Set(nodes.filter(node => !automatic.has(node.id)).map(node => node.id));
  positioned.add(root.id);
  const at = (id: string): Point => positions.get(id) ?? root;
  const obstacles = (moving: Set<string>): { at: Point; size: Size }[] =>
    nodes.filter(node => positioned.has(node.id) && !hidden.has(node.id) && !moving.has(node.id))
      .map(node => ({ at: at(node.id), size: sizeOf(node) }));
  const remember = (layout: Map<string, Point>): void => {
    for (const [id, point] of layout) {
      positions.set(id, point);
      positioned.add(id);
      changed.set(id, point);
    }
  };
  // Insert new top-level branches into an available angular gap, not a random free spot.
  for (const id of tree.children.get(root.id) ?? []) {
    if (!automatic.has(id)) continue;
    const siblings = (tree.children.get(root.id) ?? []).filter(sibling => positioned.has(sibling));
    const angles = siblings.map(sibling => Math.atan2(at(sibling).y - root.y, at(sibling).x - root.x))
      .sort((a, b) => a - b);
    let angle = 0;
    let largestGap = 0;
    angles.forEach((value, i) => {
      const next = angles[i + 1] ?? angles[0]! + 2 * Math.PI;
      if (next - value > largestGap) { largestGap = next - value; angle = value + largestGap / 2; }
    });
    const moving = new Set([root.id, id]);
    const radii = siblings.map(sibling => Math.hypot(at(sibling).x - root.x, at(sibling).y - root.y)).sort((a, b) => a - b);
    remember(radialLayout(nodes.filter(node => moving.has(node.id)), treeEdges.filter(edge => moving.has(edge.sourceId) && moving.has(edge.targetId)),
      root.id, root, sizeOf, { angle, minRadius: radii[Math.floor(radii.length / 2)] ?? 0, obstacles: obstacles(moving) }));
  }
  const parents = [...new Set([...automatic].flatMap(id => {
    const parent = tree.parent.get(id);
    return parent !== undefined && parent !== root.id ? [parent] : [];
  }))].sort((a, b) => (tree.depth.get(a) ?? 0) - (tree.depth.get(b) ?? 0));
  const reflowed = new Set<string>();
  for (const parent of parents) {
    if (reflowed.has(parent) || hidden.has(parent)) continue;
    const moving = new Set([parent, ...descendants(tree, parent)]);
    const anchor = at(parent);
    const upstream = at(tree.parent.get(parent) ?? root.id);
    const angle = Math.atan2(anchor.y - upstream.y, anchor.x - upstream.x);
    remember(radialLayout(nodes.filter(node => moving.has(node.id)), treeEdges.filter(edge => moving.has(edge.sourceId) && moving.has(edge.targetId)),
      parent, anchor, sizeOf, { angle, obstacles: obstacles(moving) }));
    for (const id of moving) reflowed.add(id);
  }
  return changed;
}

/**
 * Unplaced cards join their parent groups; saved unrelated branches stay fixed.
 */
export function initialPositions(nodes: CanvasNodeApi[], edges: CanvasEdgeApi[], sizes: Map<string, Size>): { positions: Map<string, Point>; arranged: Set<string> } {
  const root = nodes[0];
  const tree = root !== undefined ? cardTree(nodes, edges, root.id) : null;
  const measuredSizes = new Map(nodes.map((n) => [n.id, sizes.get(n.id) ?? estimateSize(n, tree?.depth.get(n.id) ?? 1)]));
  const unplaced = nodes.filter((n) => !n.placed);
  const positions = placeInBranches(nodes, edges, new Set(unplaced.map(node => node.id)), node => measuredSizes.get(node.id) ?? estimateSize(node));
  return { positions, arranged: new Set(positions.keys()) };
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
