import type { GraphEdge, GraphNode } from '../../services/api';
import { DAY_MS, isInferred } from './atlasModel';

export interface AtlasType { label: string; one: string; color: string }
export interface AtlasItem {
  id: string; name: string; type: string; project: string | null; hub: boolean; island: number; last: number;
}
export interface AtlasConnection {
  id: string; a: string; b: string; rel: string; kind: 'member' | 'internal' | 'cross' | 'island'; inferred: boolean;
}
export interface AtlasData {
  types: Record<string, AtlasType>; nodes: AtlasItem[]; edges: AtlasConnection[]; islandCount: number;
}

const TYPES: Record<string, AtlasType> = {
  project: { label: 'Projects', one: 'Project', color: '#08bdba' },
  person: { label: 'People', one: 'Person', color: '#ff7eb6' },
  idea: { label: 'Ideas', one: 'Idea', color: '#be95ff' },
  doc: { label: 'Documents', one: 'Document', color: '#78a9ff' },
  meeting: { label: 'Meetings', one: 'Meeting', color: '#ffb784' },
  company: { label: 'Companies', one: 'Company', color: '#82cfff' },
  note: { label: 'Notes', one: 'Note', color: '#a6c8ff' },
  tag: { label: 'Tags', one: 'Tag', color: '#be95ff' },
  usecase: { label: 'Use Cases', one: 'Use Case', color: '#be95ff' },
  canvas: { label: 'Canvases', one: 'Canvas', color: '#be95ff' },
  spark_theme: { label: 'Spark themes', one: 'Spark theme', color: '#be95ff' },
  build_spec: { label: 'Build specs', one: 'Build spec', color: '#42be65' },
  chat_output: { label: 'Chat outputs', one: 'Chat output', color: '#33b1ff' },
  question: { label: 'Questions', one: 'Question', color: '#ffb784' },
  register_issue: { label: 'Project issues', one: 'Project issue', color: '#ff8389' },
  task: { label: 'Tasks', one: 'Task', color: '#42be65' },
  decision: { label: 'Decisions', one: 'Decision', color: '#d4bbff' },
  chat: { label: 'Conversations', one: 'Conversation', color: '#33b1ff' },
  risk: { label: 'Risks', one: 'Risk', color: '#ff8389' },
};
const typeOf = (type: string): string => type === 'spark' ? 'idea'
  : ['document', 'content_item', 'article', 'discover_item', 'email', 'github_issue', 'github_pr'].includes(type) ? 'doc' : type;

export function atlasAdjacency(data: AtlasData): Map<string, Array<{ id: string; edge: AtlasConnection }>> {
  const result = new Map(data.nodes.map(n => [n.id, [] as Array<{ id: string; edge: AtlasConnection }>]));
  for (const edge of data.edges) {
    result.get(edge.a)?.push({ id: edge.b, edge });
    result.get(edge.b)?.push({ id: edge.a, edge });
  }
  return result;
}

export function buildAtlasData(nodes: GraphNode[], edges: GraphEdge[], now = Date.now()): AtlasData {
  const projects = new Set(nodes.filter(n => n.refType === 'project').map(n => n.id));
  const items: AtlasItem[] = [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map(node => {
    const updated = Date.parse(node.updatedAt ?? node.createdAt);
    return {
      id: node.id, name: node.title, type: typeOf(node.refType), hub: node.refType === 'project',
      project: node.refType === 'project' ? node.id
        : [...(node.projectIds ?? [])].sort().map(id => `project:${id}`).find(id => projects.has(id)) ?? null,
      island: -1, last: Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / DAY_MS)) : 9999,
    };
  });
  const by = new Map(items.map(n => [n.id, n]));
  // Indexed entities can have a recorded project edge without projectIds metadata.
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (isInferred(edge) || !['belongs_to', 'works_on'].includes(edge.edgeType)) continue;
    const a = by.get(edge.source), b = by.get(edge.target);
    if (a && b) {
      if (a.hub && !b.hub && !b.project) b.project = a.id;
      if (b.hub && !a.hub && !a.project) a.project = b.id;
    }
  }
  const connections: AtlasConnection[] = edges.flatMap(edge => {
    const a = by.get(edge.source), b = by.get(edge.target);
    if (!a || !b || a.id === b.id) return [];
    const kind = a.hub && b.project === a.id || b.hub && a.project === b.id ? 'member'
      : a.project && a.project === b.project ? 'internal'
        : !a.project && !b.project ? 'island' : 'cross';
    return [{ id: edge.id, a: a.id, b: b.id, rel: edge.edgeType.replaceAll('_', ' '), kind, inferred: isInferred(edge) }];
  });
  const data: AtlasData = { types: {}, nodes: items, edges: connections, islandCount: 0 };
  const adjacency = atlasAdjacency(data);
  for (const node of items) {
    const type = node.type;
    data.types[type] = TYPES[type] ?? { label: type.replaceAll('_', ' '), one: type.replaceAll('_', ' '), color: '#c6c6c6' };
    if (node.hub) {
      const members = items.filter(n => !n.hub && n.project === node.id);
      if (members.length) node.last = Math.min(...members.map(n => n.last));
    }
    if (node.project || node.island >= 0) continue;
    const queue = [node]; node.island = data.islandCount++;
    for (const current of queue) {
      for (const link of adjacency.get(current.id) ?? []) {
        const neighbour = by.get(link.id);
        if (neighbour && !neighbour.project && neighbour.island < 0) {
          neighbour.island = node.island; queue.push(neighbour);
        }
      }
    }
  }
  return data;
}

export function atlasContextIds(data: AtlasData, hidden: string[], retain = true): Set<string> {
  if (!retain || !hidden.length) return new Set();
  const hiddenTypes = new Set(hidden);
  const primary = new Set(data.nodes.filter(n => !n.hub && !hiddenTypes.has(n.type)).map(n => n.id));
  const context = new Set<string>();
  for (const edge of data.edges) {
    if (primary.has(edge.a)) context.add(edge.b);
    if (primary.has(edge.b)) context.add(edge.a);
  }
  return context;
}

export function shortestAtlasPath(data: AtlasData, from: string, to: string): string[] {
  const adjacency = atlasAdjacency(data);
  if (!adjacency.has(from) || !adjacency.has(to)) return [];
  const previous = new Map<string, string | null>([[from, null]]), queue = [from];
  for (const current of queue) {
    if (current === to) {
      const path: string[] = [];
      for (let id: string | null = to; id !== null; id = previous.get(id) ?? null) path.unshift(id);
      return path;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!previous.has(next.id)) { previous.set(next.id, current); queue.push(next.id); }
    }
  }
  return [];
}

export function atlasPathAnswer(data: AtlasData, from: string, to: string, path: string[]): string {
  const by = new Map(data.nodes.map(n => [n.id, n]));
  const a = by.get(from)?.name ?? from, b = by.get(to)?.name ?? to;
  if (!path.length) return `I couldn't find a link between ${a} and ${b} in the loaded graph. This does not mean no relationship exists.`;
  const middle = path.slice(1, -1).map(id => by.get(id)!.name);
  const summary = path.length === 1 ? `${a} is the same record.`
    : path.length === 2 ? `${a} links directly to ${b}.`
      : `${a} connects to ${b} in ${path.length - 1} steps, through ${middle.join(', ')}.`;
  const quiet = path.map(id => by.get(id)!).filter(n => !n.hub && n.last > 14);
  return [summary, ...quiet.map(n => `${n.name} hasn't been touched in ${n.last} days, so this link may be out of date.`)].join(' ');
}

export interface AtlasInsight { id: string; title: string; text: string; action: string; node?: string; path?: string[]; islands?: boolean }
export function atlasInsights(data: AtlasData): AtlasInsight[] {
  const result: AtlasInsight[] = [], by = new Map(data.nodes.map(n => [n.id, n])), adjacency = atlasAdjacency(data);
  const connectors = data.nodes.filter(n => n.type === 'person').map(n => ({
    node: n, projects: new Set([n.project, ...(adjacency.get(n.id) ?? []).map(e => by.get(e.id)?.project)].filter((id): id is string => !!id)),
  })).filter(c => c.projects.size > 1).sort((a, b) => b.projects.size - a.projects.size || a.node.id.localeCompare(b.node.id));
  const connector = connectors[0];
  if (connector) result.push({ id: 'connector', title: 'Connector', text: `${connector.node.name} connects ${connector.projects.size} loaded projects.`, action: 'Explore connections', node: connector.node.id });
  const pairs = new Map<string, AtlasConnection[]>();
  for (const edge of data.edges.filter(e => e.kind === 'cross' && !e.inferred)) {
    const a = by.get(edge.a)?.project, b = by.get(edge.b)?.project;
    if (!a || !b || a === b) continue;
    const key = [a, b].sort().join(',');
    pairs.set(key, [...(pairs.get(key) ?? []), edge]);
  }
  const single = [...pairs.values()].find(edges => edges.length === 1)?.[0];
  if (single) result.push({ id: 'single', title: 'Single link', text: `${by.get(by.get(single.a)!.project!)!.name} and ${by.get(by.get(single.b)!.project!)!.name} have one recorded cross-link in this view.`, action: 'Show the link', path: [single.a, single.b] });
  const quiet = data.nodes.filter(n => n.hub && n.last > 14).sort((a, b) => b.last - a.last)[0];
  if (quiet) result.push({ id: 'quiet', title: 'Going quiet', text: `${quiet.name} has no loaded activity in ${quiet.last} days.`, action: 'Explore project', node: quiet.id });
  const unlinked = data.nodes.filter(n => !n.project);
  if (unlinked.length) result.push({ id: 'unlinked', title: 'Unlinked', text: `${unlinked.length} items in ${data.islandCount} groups have no project assignment in this view.`, action: 'Show them', islands: true });
  return result;
}

export function mentionedAtlasIds(data: AtlasData, question: string): string[] {
  const matches = data.nodes.flatMap(n => {
    const name = n.name.trim();
    if (name.length < 2) return [];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').exec(question);
    return match ? [{ id: n.id, start: match.index, end: match.index + name.length }] : [];
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  const picked: typeof matches = [];
  for (const match of matches) {
    if (!picked.some(p => match.start < p.end && match.end > p.start)) picked.push(match);
    else if (picked.some(p => p.start === match.start && p.end === match.end)) {
      throw new Error('More than one loaded record has that name. Select the exact endpoints below.');
    }
  }
  return picked.map(m => m.id);
}
