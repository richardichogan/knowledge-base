import type { DiagramDocument, DiagramPoint } from './diagramTypes';
import { edgeRoute, linePoints, nodeMap, renderOrder } from './diagramGeometry';
import { diagramEdgeAppearance } from './diagramTheme';

export interface StrokeRoute {
  id: string;
  points: readonly DiagramPoint[];
  width: number;
  cornerRadius?: number;
}

interface Segment {
  owner: number;
  index: number;
  a: DiagramPoint;
  dx: number;
  dy: number;
  length: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Jump { start: number; end: number; height: number; under: number[] }
export interface BridgeMask { d: string; width: number }
export interface LineJumpGeometry {
  paths: Map<string, string>;
  masks: Map<string, BridgeMask[]>;
}

const EPSILON = 0.000001;
const MIN_RADIUS = 2;
const BASE_RADIUS = 6;
const END_CLEARANCE = 1;
const round = (n: number): number => Math.round(n * 100) / 100;
const xy = (p: DiagramPoint): string => `${round(p.x)} ${round(p.y)}`;

/** Render-only bridges: later painted strokes jump over earlier ones, never at junctions. */
export function lineJumpGeometry(strokes: readonly StrokeRoute[]): LineJumpGeometry {
  const segments: Segment[] = [];
  const jumps = new Map<number, Map<number, Jump[]>>();
  strokes.forEach((stroke, owner) => {
    for (let index = 0; index < stroke.points.length - 1; index++) {
      const a = stroke.points[index]!;
      const b = stroke.points[index + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < EPSILON) continue;
      segments.push({ owner, index, a, dx, dy, length, minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
    }
  });
  segments.sort((a, b) => a.minX - b.minX);
  let active: Segment[] = [];
  for (const segment of segments) {
    active = active.filter(other => other.maxX >= segment.minX);
    for (const other of active) {
      if (segment.owner === other.owner || other.maxY < segment.minY || other.minY > segment.maxY) continue;
      const over = segment.owner > other.owner ? segment : other;
      const under = over === segment ? other : segment;
      const cross = over.dx * under.dy - over.dy * under.dx;
      if (Math.abs(cross) <= EPSILON * over.length * under.length) continue;
      const x = under.a.x - over.a.x;
      const y = under.a.y - over.a.y;
      const t = (x * under.dy - y * under.dx) / cross;
      const u = (x * over.dy - y * over.dx) / cross;
      if (t <= EPSILON || t >= 1 - EPSILON || u <= EPSILON || u >= 1 - EPSILON) continue;
      const at = t * over.length;
      const radius = Math.min(Math.max(BASE_RADIUS, (strokes[over.owner]!.width + strokes[under.owner]!.width) / 2 + 2),
        at - END_CLEARANCE, over.length - at - END_CLEARANCE);
      if (radius < MIN_RADIUS) continue;
      let owned = jumps.get(over.owner);
      if (owned === undefined) { owned = new Map(); jumps.set(over.owner, owned); }
      const list = owned.get(over.index) ?? [];
      list.push({ start: at - radius, end: at + radius, height: radius, under: [under.owner] });
      owned.set(over.index, list);
    }
    active.push(segment);
  }
  const result = new Map<string, string>();
  const masks = new Map<string, BridgeMask[]>();
  for (const [owner, owned] of jumps) {
    const stroke = strokes[owner]!;
    let d = `M${xy(stroke.points[0]!)}`;
    for (let i = 0; i < stroke.points.length - 1; i++) {
      const a = stroke.points[i]!;
      const b = stroke.points[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      const list = owned.get(i);
      if (list !== undefined) {
        list.sort((left, right) => left.start - right.start);
        const merged: Jump[] = [];
        for (const jump of list) {
          const previous = merged[merged.length - 1];
          if (previous !== undefined && jump.start <= previous.end + END_CLEARANCE) {
            previous.end = Math.max(previous.end, jump.end);
            previous.height = Math.max(previous.height, jump.height);
            previous.under.push(...jump.under);
          } else merged.push({ ...jump, under: [...jump.under] });
        }
        const at = (distance: number): DiagramPoint => ({ x: a.x + dx * distance / length, y: a.y + dy * distance / length });
        // Keep arches on the same screen-space side when a route's direction is reversed.
        const sweep = dx > EPSILON || (Math.abs(dx) <= EPSILON && dy > 0) ? 1 : 0;
        const angle = round(Math.atan2(dy, dx) * 180 / Math.PI);
        for (const jump of merged) {
          const arc = `A${round((jump.end - jump.start) / 2)} ${round(jump.height)} ${angle} 0 ${sweep} ${xy(at(jump.end))}`;
          d += ` L${xy(at(jump.start))} ${arc}`;
          // Cut only the earlier stroke beneath the arch, not the sheet, grid or shapes.
          for (const underneath of new Set(jump.under)) {
            const under = strokes[underneath]!;
            const list = masks.get(under.id) ?? [];
            list.push({ d: `M${xy(at(jump.start))} ${arc}`, width: stroke.width + under.width + 2 });
            masks.set(under.id, list);
          }
        }
      }
      const next = stroke.points[i + 2];
      const nextLength = next === undefined ? 0 : Math.hypot(next.x - b.x, next.y - b.y);
      const nextJumps = owned.get(i + 1);
      const endClearance = list === undefined ? length : length - Math.max(...list.map(jump => jump.end)) - END_CLEARANCE;
      const startClearance = nextJumps === undefined ? nextLength : Math.min(...nextJumps.map(jump => jump.start)) - END_CLEARANCE;
      const cut = Math.max(0, Math.min(stroke.cornerRadius ?? 0, length / 2, nextLength / 2, endClearance, startClearance));
      if (next === undefined || cut === 0) d += ` L${xy(b)}`;
      else d += ` L${xy({ x: b.x - dx * cut / length, y: b.y - dy * cut / length })} Q${xy(b)} ${xy({
        x: b.x + (next.x - b.x) * cut / nextLength, y: b.y + (next.y - b.y) * cut / nextLength,
      })}`;
    }
    result.set(stroke.id, d);
  }
  return { paths: result, masks };
}

/** Uses the same paint order and visible routes as the editor and SVG/PNG exports. */
export function diagramLineJumpGeometry(
  document: Pick<DiagramDocument, 'nodes' | 'edges'>,
  routes?: ReadonlyMap<string, readonly DiagramPoint[] | null>,
): LineJumpGeometry {
  const byId = nodeMap(document.nodes);
  const visible = (stroke: string): boolean => stroke !== 'none' && stroke !== 'transparent';
  const strokes: StrokeRoute[] = renderOrder(document.nodes)
    .filter(node => node.kind === 'line' && visible(node.stroke))
    .map(node => ({ id: node.id, points: linePoints(node), width: node.strokeWidth ?? 1.5 }));
  for (const edge of document.edges) {
    if (!visible(edge.stroke)) continue;
    const points = routes === undefined ? edgeRoute(edge, byId) : routes.get(edge.id);
    if (points !== null && points !== undefined) strokes.push({ id: edge.id, points, width: diagramEdgeAppearance(edge).width, cornerRadius: 10 });
  }
  return lineJumpGeometry(strokes);
}
