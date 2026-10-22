import type { GraphEdge, GraphNode } from '../../services/api';

export type AtlasMode = 'map' | 'list';
export interface AtlasPoint { x: number; y: number; z: number }
export interface AtlasCluster { id: string; label: string; x: number; y: number; radius: number; count: number }
export interface AtlasLayout { positions: Map<string, AtlasPoint>; clusters: AtlasCluster[]; width: number; height: number }
export const DAY_MS = 86_400_000;

export function graphNodeHref(node: GraphNode): string {
  const id = encodeURIComponent(node.refId);
  switch (node.refType) {
    case 'note': return `/think?view=notes&noteId=${id}`;
    case 'company': return `/companies?companyId=${id}`;
    case 'person': return `/people?personId=${id}`;
    case 'project': return `/projects?projectId=${id}`;
    case 'canvas': return `/think?mapId=${id}`;
    case 'spark': return '/think?view=sparks';
    case 'task': return '/plan';
    case 'chat': return `/chat?session=${id}`;
    case 'decision': return '/chat';
    case 'risk': return '/projects';
    case 'document': return '/library';
    case 'discover_item': case 'cfp_item': return '/discover';
    default: return `/my-work?highlight=${id}`;
  }
}

export const isInferred = (edge: Pick<GraphEdge, 'origin' | 'edgeType'>): boolean => edge.origin === 'inferred' || edge.edgeType === 'thematically_related';
export const edgeLabel = (edge: GraphEdge): string => edge.edgeType.replaceAll('_', ' ');
export const activityTime = (node: GraphNode): number => Date.parse(node.updatedAt ?? node.createdAt);

/** The force renderer mutates coordinates and link endpoints; never give it cached API objects. */
export function forceGraphData(nodes: GraphNode[], edges: GraphEdge[]): {
  nodes: Array<GraphNode & { x: number; y: number }>; links: GraphEdge[];
} {
  return {
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map((node, i) => ({
      ...node, x: Math.cos(i * 2.399963) * Math.sqrt(i) * 14, y: Math.sin(i * 2.399963) * Math.sqrt(i) * 14,
    })),
    links: edges.map(edge => ({ ...edge })),
  };
}

/** Deterministic project-led islands; filtering repacks the displayed subset rather than leaving empty space. */
export function atlasLayout(nodes: GraphNode[]): AtlasLayout {
  const projectNames = new Map(nodes.filter(n => n.refType === 'project').map(n => [n.refId, n.title]));
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const project = [...(node.projectIds ?? [])].sort()[0];
    const key = project ? `project:${project}` : `concept:${node.conceptParent ?? 'Other connections'}`;
    const group = groups.get(key) ?? [];
    group.push(node); groups.set(key, group);
  }
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const radii = new Map(entries.map(([id, group]) => [id, Math.max(90, Math.sqrt(group.length) * 64 + 45)]));
  const rowWidth = Math.max(600, Math.sqrt(entries.reduce((sum, [id]) => sum + (radii.get(id)! * 2 + 80) ** 2, 0)) * 1.4);
  let cursorX = 0, cursorY = 0, rowHeight = 0, width = 1;
  const positions = new Map<string, AtlasPoint>();
  const clusters = entries.map(([id, group]) => {
    const clusterRadius = radii.get(id)!;
    const diameter = clusterRadius * 2 + 80;
    if (cursorX > 0 && cursorX + diameter > rowWidth) { cursorY += rowHeight; cursorX = 0; rowHeight = 0; }
    const x = cursorX + diameter / 2, y = cursorY + diameter / 2;
    cursorX += diameter; rowHeight = Math.max(rowHeight, diameter); width = Math.max(width, cursorX);
    group.sort((a, b) => Number(b.refType === 'project') - Number(a.refType === 'project') || a.id.localeCompare(b.id));
    group.forEach((node, i) => {
      const radius = i === 0 ? 0 : Math.sqrt(i) * 64;
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      positions.set(node.id, { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius,
        z: node.refType === 'project' ? 0 : ((i % 5) - 2) * 45 });
    });
    return { id, label: id.startsWith('project:') ? projectNames.get(id.slice(8)) ?? id.slice(8) : id.slice(8),
      x, y, radius: clusterRadius, count: group.length };
  });
  return { positions, clusters, width, height: Math.max(1, cursorY + rowHeight) };
}

export function atlasBounds(points: AtlasPoint[], padding = 65): { x: number; y: number; z: number; width: number; height: number; depth: number } {
  if (!points.length) return { x: 0, y: 0, z: 0, width: 200, height: 200, depth: 200 };
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const minZ = Math.min(...points.map(p => p.z)), maxZ = Math.max(...points.map(p => p.z));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2,
    width: maxX - minX + padding * 2, height: maxY - minY + padding * 2, depth: maxZ - minZ + padding * 2 };
}

export interface AtlasLabel { id: string; text: string; x: number; y: number; width: number; height: number }
/** Coordinates and collision boxes are in screen pixels, not graph units. Input order determines priority. */
export function placeAtlasLabels(candidates: Array<{ id: string; text: string; x: number; y: number }>, width: number, height: number): AtlasLabel[] {
  const labels: AtlasLabel[] = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.x + candidate.y) || candidate.x < 0 || candidate.x > width || candidate.y < 0 || candidate.y > height) continue;
    const w = Math.min(184, Math.max(70, candidate.text.length * 7.2 + 16)), h = 26;
    const x = Math.max(8, Math.min(width - w - 8, candidate.x - w / 2)), y = candidate.y + 12;
    if (y < 60 || y + h > height - 30 || x < 0) continue;
    if (labels.some(l => x < l.x + l.width + 8 && x + w + 8 > l.x && y < l.y + l.height + 6 && y + h + 6 > l.y)) continue;
    labels.push({ ...candidate, x, y, width: w, height: h });
    if (labels.length === 30) break;
  }
  return labels;
}

export function neighbourhood(nodes: GraphNode[], edges: GraphEdge[], seed: string, limit = 13, depth = 1): { nodes: GraphNode[]; edges: GraphEdge[]; omitted: number } {
  const connected = new Set([seed]);
  let frontier = new Set([seed]);
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.source) && !connected.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !connected.has(edge.source)) next.add(edge.source);
    }
    next.forEach(id => connected.add(id));
    frontier = next;
  }
  const candidates = nodes.filter(n => connected.has(n.id)).sort((a, b) =>
    Number(b.id === seed) - Number(a.id === seed) || Number(b.refType === 'project') - Number(a.refType === 'project') || a.title.localeCompare(b.title));
  const picked = candidates.slice(0, limit);
  const ids = new Set(picked.map(n => n.id));
  return { nodes: picked, edges: edges.filter(e => ids.has(e.source) && ids.has(e.target)), omitted: Math.max(0, candidates.length - picked.length) };
}

/** Activity is last-recorded activity, never a reconstruction of historical state. */
export function activityWindow(nodes: GraphNode[], edges: GraphEdge[], from: number, to: number): { active: Set<string>; context: Set<string> } {
  const active = new Set(nodes.filter(n => {
    const time = activityTime(n); return Number.isFinite(time) && time >= from && time <= to;
  }).map(n => n.id));
  const context = new Set(active);
  for (const edge of edges) {
    if (active.has(edge.source)) context.add(edge.target);
    if (active.has(edge.target)) context.add(edge.source);
  }
  return { active, context };
}
