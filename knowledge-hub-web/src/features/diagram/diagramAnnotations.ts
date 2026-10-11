/**
 * features/diagram/diagramAnnotations.ts — pure helpers for the diagram's
 * annotation layer: footnotes, the colour key, collapsed containers, named
 * version comparison, text tidy-ups and presentation steps.
 */
import type { DiagramDocument, DiagramEdge, DiagramFootnote, DiagramLegend, DiagramLegendEntry, DiagramNode, DiagramPoint } from './diagramTypes';
import { containerHeader, edgeLabelCenter, edgeLabelLayout, edgeRoute, isContainerKind, linePoints, nodeMap } from './diagramGeometry';

type Doc = DiagramDocument;

// ── Footnotes ─────────────────────────────────────────────────────────────────

export const footnotesOf = (doc: Pick<Doc, 'footnotes'>): DiagramFootnote[] => doc.footnotes ?? [];

export interface ElementInfo { kind: 'shape' | 'connector'; label: string; description: string }

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Human description of a shape or connector, for lists and captions. */
export function elementInfo(doc: Pick<Doc, 'nodes' | 'edges'>, id: string): ElementInfo | null {
  const n = doc.nodes.find((x) => x.id === id);
  if (n !== undefined) return { kind: 'shape', label: clean(n.label) || kindName(n), description: n.description ?? '' };
  const e = doc.edges.find((x) => x.id === id);
  if (e === undefined) return null;
  if (clean(e.label) !== '') return { kind: 'connector', label: clean(e.label), description: e.description ?? '' };
  const s = doc.nodes.find((x) => x.id === e.sourceId);
  const t = doc.nodes.find((x) => x.id === e.targetId);
  const name = (x: DiagramNode | undefined): string => (x === undefined ? '?' : clean(x.label) || kindName(x));
  return { kind: 'connector', label: `${name(s)} → ${name(t)}`, description: e.description ?? '' };
}

function kindName(n: DiagramNode): string {
  return n.kind === 'terminator' ? 'Start / end' : n.kind.charAt(0).toUpperCase() + n.kind.slice(1);
}

/** The text a footnote shows: its target's description, or its own custom text. */
export function footnoteText(doc: Pick<Doc, 'nodes' | 'edges'>, fn: DiagramFootnote): string {
  if (fn.source === 'custom') return fn.text ?? '';
  return elementInfo(doc, fn.targetId)?.description ?? '';
}

export function addFootnote(doc: Doc, targetId: string, id: string): Doc {
  const list = footnotesOf(doc);
  if (list.some((f) => f.targetId === targetId)) return doc;
  const info = elementInfo(doc, targetId);
  if (info === null) return doc;
  const fn: DiagramFootnote = info.description.trim() !== '' ? { id, targetId, source: 'description' } : { id, targetId, source: 'custom', text: '' };
  return { ...doc, footnotes: [...list, fn] };
}

export function updateFootnote(doc: Doc, id: string, patch: Partial<Pick<DiagramFootnote, 'source' | 'text'>>): Doc {
  return withFootnotes(doc, footnotesOf(doc).map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

export function removeFootnote(doc: Doc, id: string): Doc {
  return withFootnotes(doc, footnotesOf(doc).filter((f) => f.id !== id));
}

export function moveFootnote(doc: Doc, id: string, delta: -1 | 1): Doc {
  const list = [...footnotesOf(doc)];
  const i = list.findIndex((f) => f.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return doc;
  const a = list[i]!;
  list[i] = list[j]!;
  list[j] = a;
  return withFootnotes(doc, list);
}

function withFootnotes(doc: Doc, footnotes: DiagramFootnote[]): Doc {
  const { footnotes: _old, ...rest } = doc;
  return footnotes.length > 0 ? { ...rest, footnotes } : rest;
}

/** Drop footnotes whose shape or connector no longer exists (the server rejects them). */
export function pruneFootnotes(doc: Doc): Doc {
  const list = doc.footnotes;
  if (list === undefined) return doc;
  const ids = new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
  const kept = list.filter((f) => ids.has(f.targetId));
  return kept.length === list.length ? doc : withFootnotes(doc, kept);
}

/** Copy footnotes onto pasted clones (only for targets copied together). */
export function cloneFootnotes(doc: Doc, idMap: ReadonlyMap<string, string>, makeId: () => string): DiagramFootnote[] {
  return footnotesOf(doc).flatMap((f) => {
    const target = idMap.get(f.targetId);
    return target === undefined ? [] : [{ ...f, id: makeId(), targetId: target }];
  });
}

export const FOOTNOTE_RADIUS = 10;

/** Where a footnote marker sits: a shape's top-right corner, or beside a connector's label/midpoint. */
export function footnoteAnchor(doc: Pick<Doc, 'nodes' | 'edges'>, targetId: string, byId: ReadonlyMap<string, DiagramNode> = nodeMap(doc.nodes)): DiagramPoint | null {
  const n = byId.get(targetId);
  if (n !== undefined) {
    if (n.kind === 'line') {
      const [a, b] = linePoints(n);
      return a.x >= b.x ? a : b;
    }
    if (n.kind === 'decision') return { x: n.x + n.width * 0.75, y: n.y + n.height * 0.25 - FOOTNOTE_RADIUS * 0.6 };
    return { x: n.x + n.width - 2, y: n.y + 2 };
  }
  const e = doc.edges.find((x) => x.id === targetId);
  if (e === undefined) return null;
  const route = edgeRoute(e, byId);
  if (route === null || route.length < 2) return null;
  const c = edgeLabelCenter(route, e);
  const layout = edgeLabelLayout(e);
  if (layout.lines.length === 0) return { x: c.x + FOOTNOTE_RADIUS + 4, y: c.y - FOOTNOTE_RADIUS - 2 };
  return { x: c.x + layout.width / 2 + 2, y: c.y - layout.height / 2 - 2 };
}

/** Relative link that opens this diagram on a footnote. */
export function footnoteHref(canvasId: string, number: number): string {
  return `/think?mapId=${encodeURIComponent(canvasId)}&footnote=${number}`;
}

// ── Colour key (border colours only) ──────────────────────────────────────────

export interface LegendRow { colour: string; label: string; hidden: boolean; count: number }

const keyed = (n: DiagramNode): boolean => n.kind !== 'line' && n.stroke !== 'none' && n.stroke !== '';

/** Border colours in use (most used first) merged with saved labels. */
export function legendRows(doc: Pick<Doc, 'nodes' | 'legend'>): LegendRow[] {
  const counts = new Map<string, number>();
  for (const n of doc.nodes) if (keyed(n)) counts.set(n.stroke.toLowerCase(), (counts.get(n.stroke.toLowerCase()) ?? 0) + 1);
  const saved = new Map((doc.legend?.entries ?? []).map((e) => [e.colour.toLowerCase(), e] as const));
  return [...counts].sort((a, b) => b[1] - a[1]).map(([colour, count]) => ({
    colour, count, label: saved.get(colour)?.label ?? '', hidden: saved.get(colour)?.hidden === true,
  }));
}

export const DEFAULT_LEGEND: DiagramLegend = { visible: true, position: 'bottom-right', entries: [] };

export function setLegend(doc: Doc, patch: Partial<DiagramLegend>): Doc {
  return { ...doc, legend: { ...(doc.legend ?? DEFAULT_LEGEND), ...patch } };
}

export function setLegendEntry(doc: Doc, colour: string, patch: Partial<Pick<DiagramLegendEntry, 'label' | 'hidden'>>): Doc {
  const legend = doc.legend ?? { ...DEFAULT_LEGEND, visible: false };
  const key = colour.toLowerCase();
  const found = legend.entries.some((e) => e.colour.toLowerCase() === key);
  const entries = found
    ? legend.entries.map((e) => (e.colour.toLowerCase() === key ? { ...e, ...patch } : e))
    : [...legend.entries, { colour: key, label: '', ...patch }];
  const tidy = entries.map((e) => (e.hidden === true ? e : { colour: e.colour, label: e.label }));
  return { ...doc, legend: { ...legend, entries: tidy } };
}

/** Saved key entries for colours no longer used are kept (the colour may come back) but capped. */
export function legendLabel(doc: Pick<Doc, 'legend'>, colour: string): string {
  return doc.legend?.entries.find((e) => e.colour.toLowerCase() === colour.toLowerCase())?.label ?? '';
}

// ── Collapsed containers ──────────────────────────────────────────────────────

export function collapsedHeight(n: DiagramNode): number {
  return n.kind === 'swimlane' ? Math.max(36, Math.ceil(n.fontSize * 1.25 + 16)) : containerHeader(n).height;
}

export interface CollapsedView {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Visible stand-in for each hidden node (its outermost collapsed ancestor). */
  hiddenBy: Map<string, string>;
  /** Number of hidden descendants for each collapsed container. */
  hiddenCount: Map<string, number>;
}

/** What is drawn when some containers are collapsed: their contents hidden, connectors rerouted to them. */
export function collapseView(doc: Pick<Doc, 'nodes' | 'edges'>): CollapsedView {
  const hiddenBy = new Map<string, string>();
  const hiddenCount = new Map<string, number>();
  if (!doc.nodes.some((n) => n.collapsed === true && isContainerKind(n.kind))) {
    return { nodes: doc.nodes as DiagramNode[], edges: doc.edges as DiagramEdge[], hiddenBy, hiddenCount };
  }
  const byId = nodeMap(doc.nodes);
  for (const n of doc.nodes) {
    let rep: string | null = null;
    const seen = new Set<string>([n.id]);
    let cur = n.parentId;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const p = byId.get(cur);
      if (p === undefined) break;
      if (p.collapsed === true && isContainerKind(p.kind)) rep = p.id;
      cur = p.parentId;
    }
    if (rep !== null) {
      hiddenBy.set(n.id, rep);
      hiddenCount.set(rep, (hiddenCount.get(rep) ?? 0) + 1);
    }
  }
  const nodes = doc.nodes.filter((n) => !hiddenBy.has(n.id)).map((n) => (
    n.collapsed === true && isContainerKind(n.kind) ? { ...n, height: Math.min(n.height, collapsedHeight(n)) } : n));
  const seenPairs = new Set<string>();
  const edges: DiagramEdge[] = [];
  for (const e of doc.edges) {
    const s = hiddenBy.get(e.sourceId) ?? e.sourceId;
    const t = hiddenBy.get(e.targetId) ?? e.targetId;
    if (s === e.sourceId && t === e.targetId) { edges.push(e); continue; }
    if (s === t) continue;
    const key = `${s}>${t}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    edges.push({ ...e, sourceId: s, targetId: t, waypoints: [] });
  }
  return { nodes, edges, hiddenBy, hiddenCount };
}

// ── Named version comparison ──────────────────────────────────────────────────

export interface VersionChange { id: string; label: string; change: 'added' | 'removed' | 'changed' | 'moved' }

/** What differs going from `from` (the saved version) to `to` (the current diagram). */
export function diffDocuments(from: Pick<Doc, 'nodes' | 'edges'>, to: Pick<Doc, 'nodes' | 'edges'>): VersionChange[] {
  const out: VersionChange[] = [];
  const label = (d: Pick<Doc, 'nodes' | 'edges'>, id: string): string => elementInfo(d, id)?.label ?? id;
  const a = new Map(from.nodes.map((n) => [n.id, n] as const));
  const b = new Map(to.nodes.map((n) => [n.id, n] as const));
  for (const [id, n] of b) {
    const old = a.get(id);
    if (old === undefined) { out.push({ id, label: label(to, id), change: 'added' }); continue; }
    const { x: ox, y: oy, ...oRest } = old;
    const { x: nx, y: ny, ...nRest } = n;
    if (JSON.stringify(oRest) !== JSON.stringify(nRest)) out.push({ id, label: label(to, id), change: 'changed' });
    else if (ox !== nx || oy !== ny) out.push({ id, label: label(to, id), change: 'moved' });
  }
  for (const id of a.keys()) if (!b.has(id)) out.push({ id, label: label(from, id), change: 'removed' });
  const ea = new Map(from.edges.map((e) => [e.id, e] as const));
  const eb = new Map(to.edges.map((e) => [e.id, e] as const));
  for (const [id, e] of eb) {
    const old = ea.get(id);
    if (old === undefined) out.push({ id, label: label(to, id), change: 'added' });
    else if (JSON.stringify(old) !== JSON.stringify(e)) out.push({ id, label: label(to, id), change: 'changed' });
  }
  for (const id of ea.keys()) if (!eb.has(id)) out.push({ id, label: label(from, id), change: 'removed' });
  return out;
}

// ── Text tidy-up: likely misspellings and stray spaces ────────────────────────

/** Common misspellings, including ones seen in architecture diagrams. */
const MISSPELLINGS: Record<string, string> = {
  accomodate: 'accommodate', achitecture: 'architecture', acheive: 'achieve', adress: 'address', architecure: 'architecture',
  authenication: 'authentication', authorisaton: 'authorisation', begining: 'beginning', buisness: 'business', calender: 'calendar',
  cntrol: 'control', cntrols: 'controls', commited: 'committed', complience: 'compliance', compliace: 'compliance',
  contorl: 'control', contorls: 'controls', definately: 'definitely', dependancy: 'dependency', dependancies: 'dependencies',
  dependant: 'dependent', deployement: 'deployment', enviroment: 'environment', enviroments: 'environments', existance: 'existence',
  goverance: 'governance', govenance: 'governance', governence: 'governance', implmentation: 'implementation',
  implementaion: 'implementation', independant: 'independent', infrastucture: 'infrastructure', intergrate: 'integrate',
  intergration: 'integration', maintainance: 'maintenance', maintenence: 'maintenance', managment: 'management',
  monitering: 'monitoring', neccessary: 'necessary', occassion: 'occasion', occurance: 'occurrence', occured: 'occurred',
  persistant: 'persistent', priviledge: 'privilege', proccess: 'process', processs: 'process', publically: 'publicly',
  recieve: 'receive', refered: 'referred', relevent: 'relevant', requirment: 'requirement', requirments: 'requirements',
  responsability: 'responsibility', seperate: 'separate', seperation: 'separation', stratergy: 'strategy', strategey: 'strategy',
  succesful: 'successful', sucessful: 'successful', tommorow: 'tomorrow', untill: 'until', wich: 'which', workflwo: 'workflow',
};

export interface TextIssue {
  key: string;
  targetId: string;
  field: 'label' | 'description' | 'footnote';
  kind: 'spelling' | 'spacing' | 'repeat';
  found: string;
  fix: string;
  message: string;
}

const matchCase = (word: string, fix: string): string => {
  if (word === word.toUpperCase()) return fix.toUpperCase();
  if (word[0] === word[0]?.toUpperCase()) return fix.charAt(0).toUpperCase() + fix.slice(1);
  return fix;
};

function issuesIn(text: string, targetId: string, field: TextIssue['field']): TextIssue[] {
  const out: TextIssue[] = [];
  const base = `${targetId}:${field}`;
  for (const m of text.matchAll(/[A-Za-z][A-Za-z']*/g)) {
    const word = m[0];
    const fix = MISSPELLINGS[word.toLowerCase()];
    if (fix !== undefined) out.push({ key: `${base}:sp:${word}`, targetId, field, kind: 'spelling', found: word, fix: matchCase(word, fix), message: `“${word}” → “${matchCase(word, fix)}”` });
  }
  for (const m of text.matchAll(/\b([A-Za-z]+)\s+\1\b/gi)) {
    if (m[1] !== undefined && m[1].length > 1 && m[0].split(/\s+/)[0]?.toLowerCase() === m[0].split(/\s+/)[1]?.toLowerCase()) {
      out.push({ key: `${base}:rp:${m[0]}`, targetId, field, kind: 'repeat', found: m[0], fix: m[1], message: `Repeated word “${m[1]}”` });
    }
  }
  if (text !== text.trim() || / {2,}/.test(text)) {
    out.push({ key: `${base}:ws`, targetId, field, kind: 'spacing', found: text, fix: tidySpaces(text), message: 'Extra spaces' });
  }
  return out;
}

const tidySpaces = (text: string): string => text.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n').trim();

export function textIssues(doc: Pick<Doc, 'nodes' | 'edges' | 'footnotes'>): TextIssue[] {
  const out: TextIssue[] = [];
  for (const n of doc.nodes) {
    out.push(...issuesIn(n.label, n.id, 'label'));
    if (n.description !== undefined) out.push(...issuesIn(n.description, n.id, 'description'));
  }
  for (const e of doc.edges) {
    out.push(...issuesIn(e.label, e.id, 'label'));
    if (e.description !== undefined) out.push(...issuesIn(e.description, e.id, 'description'));
  }
  for (const f of footnotesOf(doc)) if (f.source === 'custom' && f.text !== undefined) out.push(...issuesIn(f.text, f.id, 'footnote'));
  return out;
}

function applyFix(text: string, issue: TextIssue): string {
  if (issue.kind === 'spacing') return tidySpaces(text);
  const escaped = issue.found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), issue.fix);
}

export function fixTextIssues(doc: Doc, issues: readonly TextIssue[]): Doc {
  let next = doc;
  for (const issue of issues) {
    const edit = (s: string): string => applyFix(s, issue);
    if (issue.field === 'footnote') {
      next = { ...next, footnotes: footnotesOf(next).map((f) => (f.id === issue.targetId ? { ...f, text: edit(f.text ?? '') } : f)) };
      continue;
    }
    const field = issue.field;
    next = {
      ...next,
      nodes: next.nodes.map((n) => (n.id !== issue.targetId ? n : field === 'label' ? { ...n, label: edit(n.label) } : { ...n, description: edit(n.description ?? '') })),
      edges: next.edges.map((e) => (e.id !== issue.targetId ? e : field === 'label' ? { ...e, label: edit(e.label) } : { ...e, description: edit(e.description ?? '') })),
    };
  }
  return next;
}

// ── Presentation ──────────────────────────────────────────────────────────────

export interface PresentationStep { targetId: string | null; number: number | null; title: string; text: string }

/** Walk the footnotes in order; without footnotes, walk the top-level containers; otherwise the whole diagram. */
export function presentationSteps(doc: Pick<Doc, 'nodes' | 'edges' | 'footnotes'>): PresentationStep[] {
  const fns = footnotesOf(doc);
  if (fns.length > 0) {
    return fns.map((f, i) => ({ targetId: f.targetId, number: i + 1, title: elementInfo(doc, f.targetId)?.label ?? '', text: footnoteText(doc, f) }));
  }
  const groups = doc.nodes.filter((n) => n.parentId === null && isContainerKind(n.kind));
  if (groups.length > 0) {
    return groups.map((n) => ({ targetId: n.id, number: null, title: clean(n.label) || kindName(n), text: n.description ?? '' }));
  }
  return [{ targetId: null, number: null, title: 'Whole diagram', text: '' }];
}
