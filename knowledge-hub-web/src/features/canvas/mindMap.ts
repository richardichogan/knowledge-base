/**
 * features/canvas/mindMap.ts — pure mind-map logic, no React:
 *   - applyOps: the same changes the server applies (so edits show instantly)
 *   - inverseOps: the changes that undo a batch
 *   - layoutMap: the tidy layout (central idea in the middle, branches either side)
 */
import type { CanvasEdgeApi, CanvasFullApi, CanvasNodeApi, MapOp, MapSide } from '../../services/api';

export type MapState = Pick<CanvasFullApi, 'nodes' | 'edges'>;

export function rootOf(nodes: CanvasNodeApi[]): CanvasNodeApi | undefined {
  return nodes.find((n) => n.parentId === null);
}

export function childrenOf(nodes: CanvasNodeApi[], parentId: string): CanvasNodeApi[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function descendantIds(nodes: CanvasNodeApi[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string): void => {
    for (const c of nodes) if (c.parentId === pid && !out.has(c.id)) { out.add(c.id); walk(c.id); }
  };
  walk(id);
  return out;
}

/** Which side of the map an idea is on (its top-level ancestor's side). */
export function sideOf(nodes: CanvasNodeApi[], id: string): MapSide | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let node = byId.get(id);
  while (node !== undefined && node.parentId !== null) {
    const parent = byId.get(node.parentId);
    if (parent === undefined) return null;
    if (parent.parentId === null) return node.side ?? 'right';
    node = parent;
  }
  return null;
}

/** The side with fewer branches (new central-idea children go there). */
export function balancedSide(nodes: CanvasNodeApi[]): MapSide {
  const root = rootOf(nodes);
  if (root === undefined) return 'right';
  const kids = childrenOf(nodes, root.id);
  const right = kids.filter((k) => (k.side ?? 'right') === 'right').length;
  return right <= kids.length - right ? 'right' : 'left';
}

function renumber(nodes: CanvasNodeApi[], parentId: string, movingId?: string, index?: number): CanvasNodeApi[] {
  const ids = childrenOf(nodes, parentId).map((n) => n.id).filter((id) => id !== movingId);
  if (movingId !== undefined) {
    const at = index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length));
    ids.splice(at, 0, movingId);
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return nodes.map((n) => (order.has(n.id) && n.parentId === parentId ? { ...n, sortOrder: order.get(n.id) ?? 0 } : n));
}

function applyOne(state: MapState, op: MapOp, canvasId: string): MapState {
  const { nodes, edges } = state;
  switch (op.op) {
    case 'add': {
      if (nodes.some((n) => n.id === op.id)) return state;
      const parent = nodes.find((n) => n.id === op.parentId);
      if (parent === undefined) return state;
      const node: CanvasNodeApi = {
        id: op.id, canvasId, nodeType: op.nodeType ?? (op.refType !== undefined ? 'hub_ref' : 'text'),
        refType: op.refType ?? null, refId: op.refId ?? null, label: op.label ?? '', body: op.body ?? null,
        url: op.url ?? null, tags: null, parentId: parent.id, sortOrder: Number.MAX_SAFE_INTEGER,
        side: parent.parentId === null ? op.side ?? 'right' : null, collapsed: false, createdAt: new Date().toISOString(),
      };
      return { nodes: renumber([...nodes, node], parent.id, op.id, op.index), edges };
    }
    case 'update':
      return {
        nodes: nodes.map((n) => (n.id !== op.id ? n : {
          ...n,
          ...(op.label !== undefined && { label: op.label }),
          ...(op.body !== undefined && { body: op.body }),
          ...(op.collapsed !== undefined && { collapsed: op.collapsed }),
        })),
        edges,
      };
    case 'move': {
      const node = nodes.find((n) => n.id === op.id);
      const parent = nodes.find((n) => n.id === op.parentId);
      if (node === undefined || parent === undefined || node.parentId === null) return state;
      if (node.id === parent.id || descendantIds(nodes, node.id).has(parent.id)) return state;
      const oldParent = node.parentId;
      let next = nodes.map((n) => (n.id === node.id ? { ...n, parentId: parent.id, side: parent.parentId === null ? op.side ?? 'right' : null } : n));
      next = renumber(next, parent.id, node.id, op.index);
      if (oldParent !== parent.id) next = renumber(next, oldParent);
      return { nodes: next, edges };
    }
    case 'delete': {
      const node = nodes.find((n) => n.id === op.id);
      if (node === undefined || node.parentId === null) return state;
      const gone = descendantIds(nodes, node.id);
      gone.add(node.id);
      return {
        nodes: renumber(nodes.filter((n) => !gone.has(n.id)), node.parentId),
        edges: edges.filter((e) => !gone.has(e.sourceId) && !gone.has(e.targetId)),
      };
    }
    case 'link': {
      if (edges.some((e) => e.id === op.id)) return state;
      const edge: CanvasEdgeApi = { id: op.id, canvasId, sourceId: op.sourceId, targetId: op.targetId, label: op.label ?? null, createdAt: new Date().toISOString() };
      return { nodes, edges: [...edges, edge] };
    }
    case 'relabel_link':
      return { nodes, edges: edges.map((e) => (e.id === op.id ? { ...e, label: op.label.trim() === '' ? null : op.label } : e)) };
    case 'unlink':
      return { nodes, edges: edges.filter((e) => e.id !== op.id) };
  }
}

export function applyOps(state: MapState, ops: MapOp[], canvasId: string): MapState {
  return ops.reduce((s, op) => applyOne(s, op, canvasId), state);
}

/** Ops that re-create a deleted idea and its whole branch (plus its cross-links). */
function recreateOps(state: MapState, id: string): MapOp[] {
  const node = state.nodes.find((n) => n.id === id);
  if (node === undefined || node.parentId === null) return [];
  const ops: MapOp[] = [];
  const add = (n: CanvasNodeApi): void => {
    if (n.parentId === null) return;
    ops.push({
      op: 'add', id: n.id, parentId: n.parentId, index: n.sortOrder, label: n.label ?? '',
      nodeType: n.nodeType,
      ...(n.side !== null && { side: n.side }),
      ...(n.body !== null && { body: n.body }),
      ...(n.url !== null && { url: n.url }),
      ...(n.refType !== null && n.refId !== null && { refType: n.refType, refId: n.refId }),
    });
    if (n.collapsed) ops.push({ op: 'update', id: n.id, collapsed: true });
    for (const c of childrenOf(state.nodes, n.id)) add(c);
  };
  add(node);
  const branch = descendantIds(state.nodes, id);
  branch.add(id);
  for (const e of state.edges) {
    if (branch.has(e.sourceId) || branch.has(e.targetId)) {
      ops.push({ op: 'link', id: e.id, sourceId: e.sourceId, targetId: e.targetId, ...(e.label !== null && { label: e.label }) });
    }
  }
  return ops;
}

/** The changes that undo `ops`, given the state before they were applied. */
export function inverseOps(before: MapState, ops: MapOp[], canvasId: string): MapOp[] {
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
            ...(op.collapsed !== undefined && { collapsed: n.collapsed }),
          }]);
        }
        break;
      }
      case 'move': {
        const n = state.nodes.find((x) => x.id === op.id);
        if (n?.parentId != null) inverses.push([{ op: 'move', id: n.id, parentId: n.parentId, index: n.sortOrder, ...(n.side !== null && { side: n.side }) }]);
        break;
      }
      case 'delete': inverses.push(recreateOps(state, op.id)); break;
      case 'link': inverses.push([{ op: 'unlink', id: op.id }]); break;
      case 'relabel_link': {
        const e = state.edges.find((x) => x.id === op.id);
        if (e !== undefined) inverses.push([{ op: 'relabel_link', id: e.id, label: e.label ?? '' }]);
        break;
      }
      case 'unlink': {
        const e = state.edges.find((x) => x.id === op.id);
        if (e !== undefined) inverses.push([{ op: 'link', id: e.id, sourceId: e.sourceId, targetId: e.targetId, ...(e.label !== null && { label: e.label }) }]);
        break;
      }
    }
    state = applyOne(state, op, canvasId);
  }
  return inverses.reverse().flat();
}

// ── Layout ────────────────────────────────────────────────────────────────────

export interface Size { w: number; h: number }
export interface Placed { x: number; y: number; w: number; h: number; side: MapSide | null; depth: number }

const H_GAP = 56;
const V_GAP = 14;
const LABEL_CHAR_PX = 7.4;
const NODE_PAD_PX = 36;
const MIN_NODE_W = 90;
const MAX_NODE_W = 260;
const NODE_H = 38;
const ROOT_MIN_W = 160;
const ROOT_H = 56;

/** Size estimate used until the real rendered size is measured. */
export function estimateSize(node: CanvasNodeApi, isRoot: boolean): Size {
  const text = node.label ?? '';
  const w = Math.min(MAX_NODE_W, Math.max(isRoot ? ROOT_MIN_W : MIN_NODE_W, text.length * LABEL_CHAR_PX + NODE_PAD_PX));
  const lines = Math.max(1, Math.ceil((text.length * LABEL_CHAR_PX + NODE_PAD_PX) / MAX_NODE_W));
  return { w, h: (isRoot ? ROOT_H : NODE_H) + (lines - 1) * 18 };
}

/**
 * Tidy tree layout: the central idea at (0,0); its branches stacked on their
 * side; every sub-branch stacked beside its parent, centred on it. Collapsed
 * branches hide their descendants. Returns centre positions.
 */
export function layoutMap(nodes: CanvasNodeApi[], sizes: Map<string, Size>): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const root = rootOf(nodes);
  if (root === undefined) return placed;
  const size = (n: CanvasNodeApi): Size => sizes.get(n.id) ?? estimateSize(n, n.parentId === null);
  const kids = (n: CanvasNodeApi): CanvasNodeApi[] => (n.collapsed ? [] : childrenOf(nodes, n.id));

  const heightMemo = new Map<string, number>();
  const blockHeight = (n: CanvasNodeApi): number => {
    const cached = heightMemo.get(n.id);
    if (cached !== undefined) return cached;
    const k = kids(n);
    const childrenH = k.reduce((sum, c) => sum + blockHeight(c), 0) + Math.max(0, k.length - 1) * V_GAP;
    const h = Math.max(size(n).h, childrenH);
    heightMemo.set(n.id, h);
    return h;
  };

  const placeChildren = (parent: CanvasNodeApi, list: CanvasNodeApi[], dir: 1 | -1, side: MapSide, depth: number): void => {
    const p = placed.get(parent.id);
    if (p === undefined || list.length === 0) return;
    const total = list.reduce((sum, c) => sum + blockHeight(c), 0) + (list.length - 1) * V_GAP;
    let y = p.y - total / 2;
    for (const c of list) {
      const bh = blockHeight(c);
      const s = size(c);
      placed.set(c.id, { x: p.x + dir * (p.w / 2 + H_GAP + s.w / 2), y: y + bh / 2, w: s.w, h: s.h, side, depth });
      placeChildren(c, kids(c), dir, side, depth + 1);
      y += bh + V_GAP;
    }
  };

  const rs = size(root);
  placed.set(root.id, { x: 0, y: 0, w: rs.w, h: rs.h, side: null, depth: 0 });
  const top = kids(root);
  placeChildren(root, top.filter((c) => (c.side ?? 'right') === 'right'), 1, 'right', 1);
  placeChildren(root, top.filter((c) => c.side === 'left'), -1, 'left', 1);
  return placed;
}

/** Outline text (Markdown bullets) for copying/export. */
export function outlineMarkdown(title: string, nodes: CanvasNodeApi[]): string {
  const root = rootOf(nodes);
  const lines = [`# ${title}`, ''];
  const walk = (n: CanvasNodeApi, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}- ${n.label ?? ''}${n.body !== null && n.body.trim() !== '' ? ` — ${n.body}` : ''}`);
    for (const c of childrenOf(nodes, n.id)) walk(c, depth + 1);
  };
  if (root !== undefined) for (const c of childrenOf(nodes, root.id)) walk(c, 0);
  return lines.join('\n');
}
