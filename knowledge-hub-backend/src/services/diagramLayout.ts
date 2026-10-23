import type { DiagramDocument, DiagramNode } from '../types/diagram.js';
import { rankFlowNodes } from './aiFlow.js';

const GAP_X = 80;
const GAP_Y = 40;
const PAD = 20;
const HEADER = 60;
const HALF = 0.5;
const GRID_MAX_COLUMNS = 4;
const GRID_ROW_GAP = 16;
const FEEDBACK_GUTTER = 40;
const FEEDBACK_ROUTE_GAP = 24;

/** Lay out siblings together, retaining semantic containers and a separate route for feedback. */
export function layoutGeneralDiagram(doc: DiagramDocument, origin = { x: 80, y: 80 }): DiagramDocument {
  const nodes = doc.nodes.map(node => ({ ...node }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const groups = new Map<string | null, DiagramNode[]>();
  for (const node of nodes) {
    const siblings = groups.get(node.parentId) ?? [];
    siblings.push(node);
    groups.set(node.parentId, siblings);
  }
  const translate = (node: DiagramNode, x: number, y: number): void => {
    const dx = x - node.x;
    const dy = y - node.y;
    const shift = (item: DiagramNode): void => {
      item.x += dx; item.y += dy;
      for (const child of groups.get(item.id) ?? []) shift(child);
    };
    shift(node);
  };
  const layout = (parent: string | null, left: number, top: number): { width: number; height: number } => {
    const siblings = groups.get(parent) ?? [];
    if (siblings.length === 0) return { width: 0, height: 0 };
    for (const node of siblings) {
      if (node.kind !== 'container' && node.kind !== 'swimlane') continue;
      const content = layout(node.id, node.x + PAD, node.y + HEADER);
      node.width = Math.max(node.width, content.width + PAD + PAD);
      node.height = Math.max(node.height, content.height + HEADER + PAD);
    }
    const ids = new Set(siblings.map(node => node.id));
    const owner = (id: string): string | undefined => {
      let node = byId.get(id);
      while (node && !ids.has(node.id)) node = node.parentId === null ? undefined : byId.get(node.parentId);
      return node?.id;
    };
    const links = doc.edges.flatMap(edge => {
      const from = owner(edge.sourceId);
      const to = owner(edge.targetId);
      return from && to && from !== to ? [{ from, to }] : [];
    });
    if (links.length === 0) {
      const cols = Math.min(GRID_MAX_COLUMNS, Math.ceil(Math.sqrt(siblings.length)));
      const widths = Array.from({ length: cols }, (_, col) =>
        Math.max(...siblings.filter((_, index) => index % cols === col).map(node => node.width)));
      const heights = Array.from({ length: Math.ceil(siblings.length / cols) }, (_, row) =>
        Math.max(...siblings.slice(row * cols, (row + 1) * cols).map(node => node.height)));
      siblings.forEach((node, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        translate(node, left + widths.slice(0, col).reduce((sum, width) => sum + width + PAD, 0) + (widths[col]! - node.width) * HALF,
          top + heights.slice(0, row).reduce((sum, height) => sum + height + GRID_ROW_GAP, 0) + (heights[row]! - node.height) * HALF);
      });
      return { width: widths.reduce((sum, width) => sum + width, 0) + (cols - 1) * PAD,
        height: heights.reduce((sum, height) => sum + height, 0) + (heights.length - 1) * GRID_ROW_GAP };
    }
    const columns = rankFlowNodes(siblings.map(node => node.id), links);
    const layers = new Map<number, DiagramNode[]>();
    for (const node of siblings) {
      const col = columns.get(node.id)!;
      const layer = layers.get(col) ?? [];
      layer.push(node); layers.set(col, layer);
    }
    const heightOf = (layer: DiagramNode[]): number => layer.reduce((sum, node) => sum + node.height, 0) + (layer.length - 1) * GAP_Y;
    const height = Math.max(...[...layers.values()].map(heightOf));
    const order = new Map<string, number>();
    let x = left;
    for (const [col, layer] of [...layers.entries()].sort(([a], [b]) => a - b)) {
      const score = (node: DiagramNode): number => {
        const parents = links.filter(link => link.to === node.id && columns.get(link.from)! < col)
          .flatMap(link => order.has(link.from) ? [order.get(link.from)!] : []);
        return parents.length ? parents.reduce((sum, value) => sum + value, 0) / parents.length : siblings.indexOf(node);
      };
      layer.sort((a, b) => score(a) - score(b));
      const width = Math.max(...layer.map(node => node.width));
      let y = top + (height - heightOf(layer)) * HALF;
      layer.forEach((node, index) => {
        translate(node, x + (width - node.width) * HALF, y);
        order.set(node.id, index);
        y += node.height + GAP_Y;
      });
      x += width + GAP_X;
    }
    return { width: x - left - GAP_X, height };
  };
  layout(null, origin.x, origin.y);
  const routeTop = nodes.length ? Math.min(...nodes.map(node => node.y)) - FEEDBACK_GUTTER : origin.y;
  let returnRoute = 0;
  const edges = doc.edges.map(edge => {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    if (!source || !target) return edge;
    const rest = { ...edge };
    delete rest.labelOffset;
    if (source.id === target.id) {
      const x = source.x + source.width + FEEDBACK_GUTTER;
      const y = source.y - FEEDBACK_GUTTER;
      return { ...rest, sourcePort: 'right' as const, targetPort: 'top' as const, route: 'orthogonal' as const,
        waypoints: [{ x, y: source.y + source.height * HALF }, { x, y }, { x: source.x + source.width * HALF, y }] };
    }
    if (target.x >= source.x + source.width) {
      const hasObstacle = nodes.some(node => node.id !== source.id && node.id !== target.id
        && node.parentId === source.parentId && node.x > source.x && node.x < target.x);
      if (!hasObstacle) return { ...rest, sourcePort: 'right' as const, targetPort: 'left' as const, route: 'orthogonal' as const, waypoints: [] };
    } else if (Math.abs(target.x + target.width * HALF - source.x - source.width * HALF) < 1 && target.id !== source.id) {
      const below = target.y > source.y;
      return { ...rest, sourcePort: below ? 'bottom' as const : 'top' as const,
        targetPort: below ? 'top' as const : 'bottom' as const, route: 'orthogonal' as const, waypoints: [] };
    }
    const y = routeTop - returnRoute++ * FEEDBACK_ROUTE_GAP;
    return { ...rest, sourcePort: 'top' as const, targetPort: 'top' as const, route: 'orthogonal' as const,
      waypoints: [{ x: source.x + source.width * HALF, y }, { x: target.x + target.width * HALF, y }] };
  });
  return { ...doc, nodes, edges };
}
