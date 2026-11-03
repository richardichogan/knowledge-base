import { randomUUID } from 'node:crypto';
import type { LlmToolDefinition } from '../ai/foundryClient.js';
import { emptyDiagram, type DiagramDocument, type DiagramNode, type DiagramPoint, type DiagramPort } from '../types/diagram.js';
import { ValidationError } from '../types/errors.js';
import { validateDiagramDocument } from './diagramValidation.js';

const KINDS = ['process', 'decision', 'hexagon', 'terminator', 'document', 'text', 'container', 'swimlane', 'image', 'arrow', 'line'] as const;
const COLOURS = {
  grey: { fill: '#ffffff', stroke: '#525252' },
  blue: { fill: '#edf5ff', stroke: '#0f62fe' },
  green: { fill: '#defbe6', stroke: '#198038' },
  yellow: { fill: '#fcf4d6', stroke: '#b28600' },
  red: { fill: '#fff1f1', stroke: '#da1e28' },
  purple: { fill: '#f6f2ff', stroke: '#8a3ffc' },
} as const;
const MAX_NODES = 80;
const MAX_EDGES = 160;
const MAX_DEPTH = 6;
const MAX_GRID = 20;
const PAD = 24;
const HEADER = 64;
const GAP = 88;
const FONT = 16;
const CHAR_WIDTH = 9;
const LINE_HEIGHT = 24;
const MIN_WIDTH = 200;
const MAX_TEXT_WIDTH = 380;
const ROUTE_PAD = 12;
const HALF = 0.5;
const BOTH_SIDES = 2;
const MAX_PLAN_TEXT = 2000;
const MAX_EDGE_LABEL = 500;
const MAX_TITLE = 300;
const MAX_LEGEND_LABEL = 120;

interface PlannedNode {
  key: string;
  originalId: string | null;
  kind: typeof KINDS[number];
  label: string;
  description: string;
  parent: string | null;
  row: number;
  column: number;
  colour: keyof typeof COLOURS;
}
interface PlannedEdge {
  from: string;
  to: string;
  label: string;
  role: 'primary' | 'supporting' | 'feedback';
}
export interface DiagramPlan {
  title: string;
  description: string;
  nodes: PlannedNode[];
  edges: PlannedEdge[];
  legend: Array<{ colour: keyof typeof COLOURS; label: string }>;
}

export const DIAGRAM_PLAN_TOOL: LlmToolDefinition = {
  type: 'function',
  function: {
    name: 'submit_diagram_plan',
    description: 'Submit the complete editable diagram, including spatial grouping. This does not save anything.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, description: { type: 'string' },
        nodes: {
          type: 'array', maxItems: MAX_NODES,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              key: { type: 'string' },
              originalId: { type: ['string', 'null'], description: 'Exact existing shape UUID to retain its metadata and links; null for a new shape.' },
              kind: { type: 'string', enum: [...KINDS] },
              label: { type: 'string', description: 'All text that must be visible. Use line breaks for headings/body. Descriptions are not visible inside shapes.' },
              description: { type: 'string' },
              parent: { type: ['string', 'null'], description: 'Container key, or null for a top-level shape.' },
              row: { type: 'integer', minimum: 0, maximum: MAX_GRID },
              column: { type: 'integer', minimum: 0, maximum: MAX_GRID },
              colour: { type: 'string', enum: Object.keys(COLOURS) },
            },
            required: ['key', 'originalId', 'kind', 'label', 'description', 'parent', 'row', 'column', 'colour'],
          },
        },
        edges: {
          type: 'array', maxItems: MAX_EDGES,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' },
              role: { type: 'string', enum: ['primary', 'supporting', 'feedback'] },
            },
            required: ['from', 'to', 'label', 'role'],
          },
        },
        legend: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { colour: { type: 'string', enum: Object.keys(COLOURS) }, label: { type: 'string' } },
            required: ['colour', 'label'],
          },
        },
      },
      required: ['title', 'description', 'nodes', 'edges', 'legend'],
    },
  },
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Ariadne returned an invalid object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = MAX_PLAN_TEXT): string {
  if (typeof value !== 'string' || value.length > max) throw new ValidationError('Ariadne returned missing or oversized text.');
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError('Ariadne returned an invalid or oversized list.');
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ValidationError('Ariadne returned an unsupported shape, colour or connector role.');
  return value as T;
}

export function parseDiagramPlan(value: unknown): DiagramPlan {
  const raw = object(value);
  const nodes = list(raw['nodes'], MAX_NODES).map(item => {
    const n = object(item);
    const position = (name: string): number => {
      const v = n[name];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_GRID) throw new ValidationError('Ariadne returned an invalid grid position.');
      return v;
    };
    return {
      key: text(n['key']), originalId: n['originalId'] === null ? null : text(n['originalId']),
      kind: choice(n['kind'], KINDS), label: text(n['label']), description: text(n['description']),
      parent: n['parent'] === null ? null : text(n['parent']),
      row: position('row'), column: position('column'), colour: choice(n['colour'], Object.keys(COLOURS) as Array<keyof typeof COLOURS>),
    };
  });
  if (!nodes.length || nodes.some(n => !n.key.trim() || !n.label.trim()) || new Set(nodes.map(n => n.key)).size !== nodes.length) {
    throw new ValidationError('Ariadne must supply nonempty shapes with unique keys.');
  }
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const slots = new Set<string>();
  const originals = new Set<string>();
  for (const n of nodes) {
    const slot = JSON.stringify([n.parent, n.row, n.column]);
    if (slots.has(slot)) throw new ValidationError(`Ariadne put two sibling shapes in the same grid cell: ${n.label}.`);
    slots.add(slot);
    if (n.originalId && originals.has(n.originalId)) throw new ValidationError('Ariadne reused an original shape more than once.');
    if (n.originalId) originals.add(n.originalId);
    const seen = new Set([n.key]);
    let parent = n.parent;
    while (parent !== null) {
      const p = byKey.get(parent);
      if (!p || !['container', 'swimlane'].includes(p.kind) || seen.has(parent) || seen.size > MAX_DEPTH) {
        throw new ValidationError('Ariadne returned a missing, cyclic or excessively nested container.');
      }
      seen.add(parent);
      parent = p.parent;
    }
  }
  const edges = list(raw['edges'], MAX_EDGES).map(item => {
    const e = object(item);
    const from = text(e['from']);
    const to = text(e['to']);
    if (!byKey.has(from) || !byKey.has(to)) throw new ValidationError('Ariadne returned a connector to a missing shape.');
    return { from, to, label: text(e['label'], MAX_EDGE_LABEL), role: choice(e['role'], ['primary', 'supporting', 'feedback'] as const) };
  });
  const title = text(raw['title'], MAX_TITLE).trim();
  if (!title) throw new ValidationError('Ariadne must supply a diagram title.');
  return {
    title, description: text(raw['description']),
    nodes, edges,
    legend: list(raw['legend'], Object.keys(COLOURS).length).map(item => {
      const e = object(item);
      return { colour: choice(e['colour'], Object.keys(COLOURS) as Array<keyof typeof COLOURS>), label: text(e['label'], MAX_LEGEND_LABEL) };
    }),
  };
}

interface Rect { x: number; y: number; width: number; height: number }
function crosses(a: DiagramPoint, b: DiagramPoint, r: Rect): boolean {
  return a.x === b.x
    ? a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height
    : a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width;
}
function port(node: DiagramNode, side: DiagramPort): DiagramPoint {
  return {
    x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width * HALF),
    y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : node.height * HALF),
  };
}

/** Search a rectilinear visibility grid only when simple doglegs intersect shapes. */
function route(a: DiagramPoint, b: DiagramPoint, obstacles: Rect[]): DiagramPoint[] {
  const clear = (points: DiagramPoint[]): boolean => points.every((p, i) => i === 0 || !obstacles.some(r => crosses(points[i - 1]!, p, r)));
  const middleX = (a.x + b.x) * HALF;
  const middleY = (a.y + b.y) * HALF;
  const simple = [
    [a, { x: middleX, y: a.y }, { x: middleX, y: b.y }, b],
    [a, { x: a.x, y: middleY }, { x: b.x, y: middleY }, b],
    [a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b],
  ].find(clear);
  if (simple) return simple;
  const xs = [...new Set([a.x, b.x, ...obstacles.flatMap(r => [r.x, r.x + r.width])])].sort((x, y) => x - y);
  const ys = [...new Set([a.y, b.y, ...obstacles.flatMap(r => [r.y, r.y + r.height])])].sort((x, y) => x - y);
  const index = (x: number, y: number): number => y * xs.length + x;
  const point = (i: number): DiagramPoint => ({ x: xs[i % xs.length]!, y: ys[Math.floor(i / xs.length)]! });
  const start = index(xs.indexOf(a.x), ys.indexOf(a.y));
  const end = index(xs.indexOf(b.x), ys.indexOf(b.y));
  const previous = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    if (current === end) break;
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    for (const [nx, ny] of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]]) {
      if (nx! < 0 || nx! >= xs.length || ny! < 0 || ny! >= ys.length) continue;
      const next = index(nx!, ny!);
      if (previous.has(next) || !clear([point(current), point(next)])) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(end)) throw new ValidationError('Ariadne could not route a connector without crossing a shape. More separation is needed.');
  const path: DiagramPoint[] = [];
  for (let at = end; at !== -1; at = previous.get(at)!) path.unshift(point(at));
  return path.filter((p, i) => i === 0 || i === path.length - 1
    || !((path[i - 1]!.x === p.x && path[i + 1]!.x === p.x) || (path[i - 1]!.y === p.y && path[i + 1]!.y === p.y)));
}

export function buildDesignedDiagram(plan: DiagramPlan, original = emptyDiagram()): DiagramDocument {
  const byKey = new Map<string, DiagramNode>();
  const headers = new Map<string, number>();
  const ids = new Set<string>();
  for (const spec of plan.nodes) {
    const existing = spec.originalId === null ? undefined : original.nodes.find(n => n.id === spec.originalId);
    if (spec.originalId && !existing) throw new ValidationError('Ariadne referenced a shape outside the source diagram.');
    if (spec.kind === 'image' && existing?.kind !== 'image') throw new ValidationError('Ariadne can preserve source images, not invent new image assets.');
    const colour = COLOURS[spec.colour];
    const longest = Math.max(...spec.label.split('\n').map(line => line.length));
    const width = Math.min(MAX_TEXT_WIDTH, Math.max(MIN_WIDTH, longest * CHAR_WIDTH + PAD * BOTH_SIDES));
    const lines = spec.label.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length * CHAR_WIDTH / (width - PAD * BOTH_SIDES))), 0);
    const decision = spec.kind === 'decision';
    const node: DiagramNode = {
      ...existing, id: existing?.id ?? randomUUID(), kind: spec.kind, label: spec.label, description: spec.description,
      x: 0, y: 0, width: spec.kind === 'image' ? existing!.width : decision ? width * BOTH_SIDES : width,
      height: spec.kind === 'image' ? existing!.height : (lines * LINE_HEIGHT + PAD * BOTH_SIDES) * (decision ? BOTH_SIDES : 1),
      parentId: null, ...colour, textColor: '#161616', fontSize: FONT, assetId: spec.kind === 'image' ? existing!.assetId : null,
      textAlign: spec.kind === 'text' ? 'left' : 'center', textVerticalAlign: 'middle',
    };
    // Native metadata is retained only on the same supported shape kind.
    if (existing?.kind !== spec.kind) {
      delete node.flow; delete node.lane; delete node.header; delete node.icon;
      delete node.calloutType; delete node.collapsed;
    }
    if (spec.kind === 'text') { node.fill = 'transparent'; node.stroke = 'transparent'; }
    byKey.set(spec.key, node);
    ids.add(node.id);
  }
  const arrange = (parent: string | null, x: number, y: number): { width: number; height: number } => {
    const children = plan.nodes.filter(n => n.parent === parent);
    if (!children.length) return { width: 0, height: 0 };
    for (const spec of children) {
      const node = byKey.get(spec.key)!;
      if (spec.kind === 'container' || spec.kind === 'swimlane') {
        const content = arrange(spec.key, 0, 0);
        const titleLines = Math.ceil(spec.label.length * CHAR_WIDTH / Math.max(node.width - PAD * BOTH_SIDES, content.width));
        node.width = Math.max(node.width, content.width + PAD * BOTH_SIDES);
        const header = HEADER + titleLines * LINE_HEIGHT;
        headers.set(spec.key, header);
        node.height = content.height + header + PAD * BOTH_SIDES;
      }
    }
    const columns = [...new Set(children.map(n => n.column))].sort((a, b) => a - b);
    const rows = [...new Set(children.map(n => n.row))].sort((a, b) => a - b);
    const widths = columns.map(col => Math.max(...children.filter(n => n.column === col).map(n => byKey.get(n.key)!.width)));
    const heights = rows.map(row => Math.max(...children.filter(n => n.row === row).map(n => byKey.get(n.key)!.height)));
    const shift = (key: string, dx: number, dy: number): void => {
      const node = byKey.get(key)!; node.x += dx; node.y += dy;
      for (const child of plan.nodes.filter(n => n.parent === key)) shift(child.key, dx, dy);
    };
    for (const spec of children) {
      const node = byKey.get(spec.key)!;
      const col = columns.indexOf(spec.column);
      const row = rows.indexOf(spec.row);
      const left = x + widths.slice(0, col).reduce((sum, v) => sum + v + GAP, 0);
      const top = y + heights.slice(0, row).reduce((sum, v) => sum + v + GAP, 0);
      const ownX = node.x; const ownY = node.y;
      shift(spec.key, left - ownX, top - ownY);
      // Children were laid out relative to the container origin before its size was known.
      for (const child of plan.nodes.filter(n => n.parent === spec.key)) shift(child.key, PAD, (headers.get(spec.key) ?? HEADER) + PAD);
      node.parentId = parent === null ? null : byKey.get(parent)!.id;
    }
    return { width: widths.reduce((a, b) => a + b, 0) + (columns.length - 1) * GAP,
      height: heights.reduce((a, b) => a + b, 0) + (rows.length - 1) * GAP };
  };
  arrange(null, GAP, GAP);
  const ancestors = (node: DiagramNode): Set<string> => {
    const found = new Set<string>();
    while (node.parentId) {
      found.add(node.parentId);
      node = [...byKey.values()].find(n => n.id === node.parentId)!;
    }
    return found;
  };
  let feedback = 0;
  const nodes = [...byKey.values()];
  const edges = plan.edges.map(spec => {
    const source = byKey.get(spec.from)!; const target = byKey.get(spec.to)!;
    const horizontal = Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
    const forward = horizontal ? target.x >= source.x : target.y >= source.y;
    const sourcePort: DiagramPort = source.id === target.id ? 'right' : spec.role === 'feedback' ? 'top' : horizontal ? forward ? 'right' : 'left' : forward ? 'bottom' : 'top';
    const targetPort: DiagramPort = spec.role === 'feedback' ? 'top' : horizontal ? forward ? 'left' : 'right' : forward ? 'top' : 'bottom';
    const a = port(source, sourcePort); const b = port(target, targetPort);
    const excluded = new Set([source.id, target.id, ...ancestors(source), ...ancestors(target)]);
    const obstacles = nodes.filter(n => !excluded.has(n.id)).map(n => ({
      x: n.x - ROUTE_PAD, y: n.y - ROUTE_PAD, width: n.width + ROUTE_PAD * BOTH_SIDES, height: n.height + ROUTE_PAD * BOTH_SIDES,
    }));
    let points: DiagramPoint[];
    if (source.id === target.id) {
      const corner = { x: a.x + GAP, y: source.y - GAP - feedback++ * PAD };
      points = [...route(a, { x: corner.x, y: a.y }, obstacles), corner, ...route(corner, b, obstacles).slice(1)];
    } else if (spec.role === 'feedback') {
      const y = Math.min(...nodes.map(n => n.y)) - GAP - feedback++ * PAD;
      const from = { x: a.x, y }; const to = { x: b.x, y };
      points = [...route(a, from, obstacles), to, ...route(to, b, obstacles).slice(1)];
    } else points = route(a, b, obstacles);
    const previous = original.edges.find(e => e.sourceId === source.id && e.targetId === target.id && e.label === spec.label);
    return {
      ...previous, id: previous?.id ?? randomUUID(), sourceId: source.id, targetId: target.id, sourcePort, targetPort,
      route: 'orthogonal' as const, waypoints: points.slice(1, -1), label: spec.label,
      stroke: spec.role === 'primary' ? '#525252' : '#6f6f6f', dashed: spec.role !== 'primary', arrows: 'end' as const,
      ...(previous ? { labelOffset: { x: 0, y: 0 } } : {}),
    };
  });
  const document: DiagramDocument = {
    ...emptyDiagram(), ...(original.diagramType ? { diagramType: original.diagramType } : {}),
    nodes, edges,
    ...(original.footnotes ? { footnotes: original.footnotes.filter(f => ids.has(f.targetId) || edges.some(e => e.id === f.targetId)) } : {}),
    legend: { visible: plan.legend.length > 0, position: 'bottom-left', entries: plan.legend.map(e => ({ colour: COLOURS[e.colour].stroke, label: e.label })) },
  };
  return validateDiagramDocument(document, new Set(original.nodes.flatMap(n => n.assetId ? [n.assetId] : [])));
}
