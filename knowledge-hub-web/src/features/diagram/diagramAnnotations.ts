/**
 * features/diagram/diagramAnnotations.ts — pure helpers for the diagram's
 * annotation layer: footnotes, the colour key, collapsed containers, named
 * version comparison, text tidy-ups and presentation steps.
 */
import type { DiagramDocument, DiagramEdge, DiagramFootnote, DiagramLegend, DiagramLegendEntry, DiagramNode, DiagramPoint } from './diagramTypes';
import type { Rect } from './diagramGeometry';
import { containerHeader, edgeLabelCenter, edgeLabelLayout, edgeRoute, isContainerKind, linePoints, nodeMap, wrapText } from './diagramGeometry';
import { descriptionPlainText, wrapDescription, type DescriptionRun } from './diagramDescription';

type Doc = DiagramDocument;

// ── Footnotes ─────────────────────────────────────────────────────────────────

export const footnotesOf = (doc: Pick<Doc, 'footnotes'>): DiagramFootnote[] => doc.footnotes ?? [];

export interface ElementInfo { kind: 'shape' | 'connector'; label: string; description: string }

const clean = (s: string): string => descriptionPlainText(s).replace(/\s+/g, ' ').trim();

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

/** A footnote always shows its shape's or connector's description. */
export function footnoteText(doc: Pick<Doc, 'nodes' | 'edges'>, fn: DiagramFootnote): string {
  return elementInfo(doc, fn.targetId)?.description ?? '';
}

export function addFootnote(doc: Doc, targetId: string, id: string): Doc {
  const list = footnotesOf(doc);
  if (list.some((f) => f.targetId === targetId)) return doc;
  const info = elementInfo(doc, targetId);
  if (info === null) return doc;
  return { ...doc, footnotes: [...list, { id, targetId, source: 'description' }] };
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

// ── Footnote block drawn on the sheet (and in exports) ───────────────────────

export const NOTE_FONT = 12;
export const NOTE_LINE = NOTE_FONT * 1.35;
export const NOTE_HEADING_FONT = 14;
const BLOCK_GAP = 40;
const BLOCK_PAD = 12;
const TEXT_INDENT = 30;

export interface FootnoteBlockLine { text: string; x: number; y: number; bold: boolean; muted: boolean; runs?: DescriptionRun[] }
export interface FootnoteBlockItem { id: string; targetId: string; number: number; marker: DiagramPoint; lines: FootnoteBlockLine[]; rect: Rect }
export interface FootnoteBlock { rect: Rect; divider: Rect; heading: DiagramPoint; items: FootnoteBlockItem[] }

/**
 * Lay out the numbered notes as part of the diagram, beside (`right`) or
 * beneath (`bottom`) the content bounds. Coordinates are in diagram space so
 * the block pans, zooms and exports with the shapes. `emptyText` is shown for
 * notes without text (the editor uses it; exports omit it).
 */
export function footnoteBlock(doc: Pick<Doc, 'nodes' | 'edges' | 'footnotes'>, content: Rect, position: 'bottom' | 'right', emptyText?: string): FootnoteBlock | null {
  const list = footnotesOf(doc);
  if (list.length === 0) return null;
  const columnWidth = position === 'right' ? 360 : 420;
  const columnGap = 32;
  const columnCount = Math.ceil(list.length / 4);
  const width = columnCount * columnWidth + (columnCount - 1) * columnGap;
  const x = position === 'right' ? content.x + content.width + BLOCK_GAP : content.x;
  const y = position === 'right' ? content.y : content.y + content.height + BLOCK_GAP;
  const textWidth = columnWidth - BLOCK_PAD * 2 - TEXT_INDENT;
  const firstRow = y + BLOCK_PAD + NOTE_HEADING_FONT + 12;
  let cursor = firstRow;
  let bottom = firstRow;
  const items = list.map((fn, i): FootnoteBlockItem => {
    if (i % 4 === 0) cursor = firstRow;
    const columnX = x + Math.floor(i / 4) * (columnWidth + columnGap);
    const textX = columnX + BLOCK_PAD + TEXT_INDENT;
    const title = elementInfo(doc, fn.targetId)?.label ?? 'Missing item';
    const body = footnoteText(doc, fn).trim();
    const raw: Array<{ text: string; bold: boolean; muted: boolean; runs?: DescriptionRun[] }> = [
      ...wrapText(title, textWidth, NOTE_FONT, 2).map((text) => ({ text, bold: true, muted: false })),
      ...(body !== ''
        ? wrapDescription(body, textWidth, NOTE_FONT).map(line => ({ ...line, bold: false, muted: false }))
        : emptyText !== undefined ? [{ text: emptyText, bold: false, muted: true }] : []),
    ];
    const top = cursor;
    const lines = raw.map((l, j) => ({ ...l, x: textX, y: top + NOTE_FONT + j * NOTE_LINE }));
    const height = Math.max(FOOTNOTE_RADIUS * 2, raw.length * NOTE_LINE) + 4;
    cursor += height + 10;
    bottom = Math.max(bottom, cursor - 10);
    return {
      id: fn.id, targetId: fn.targetId, number: i + 1, lines,
      marker: { x: columnX + BLOCK_PAD + FOOTNOTE_RADIUS, y: top + FOOTNOTE_RADIUS - 2 },
      rect: { x: columnX + 4, y: top - 5, width: columnWidth - 8, height: height + 10 },
    };
  });
  return {
    rect: { x, y, width: Math.max(width, content.width), height: bottom - y + BLOCK_PAD },
    divider: { x, y, width: content.width, height: 0 },
    heading: { x: x + BLOCK_PAD, y: y + BLOCK_PAD }, items,
  };
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

export interface KeyLayoutItem { x: number; y: number; colour: string; text: string }
export interface KeyLayout { heading: DiagramPoint; items: KeyLayoutItem[]; rect: Rect }

/** The colour key as laid out in exports: a "Key" heading, then swatches flowing left to right beneath `above`. */
export function keyLayout(rows: readonly LegendRow[], above: Rect, left: number): KeyLayout {
  const keyWidth = Math.max(420, above.width);
  const top = above.y + above.height + 32;
  let cursor = top + 22;
  let x = left;
  const items = rows.map((r): KeyLayoutItem => {
    const text = r.label.trim() !== '' ? r.label.trim() : r.colour;
    const w = 28 + Math.min(260, text.length * 6.6) + 20;
    if (x > left && x + w > left + keyWidth) { x = left; cursor += 22; }
    const item = { x, y: cursor, colour: r.colour, text };
    x += w;
    return item;
  });
  return { heading: { x: left, y: top }, items, rect: { x: left, y: top, width: keyWidth, height: cursor + 16 - top } };
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
  field: 'label' | 'description';
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

export function textIssues(doc: Pick<Doc, 'nodes' | 'edges'>): TextIssue[] {
  const out: TextIssue[] = [];
  for (const n of doc.nodes) {
    out.push(...issuesIn(n.label, n.id, 'label'));
    if (n.description !== undefined) out.push(...issuesIn(n.description, n.id, 'description'));
  }
  for (const e of doc.edges) {
    out.push(...issuesIn(e.label, e.id, 'label'));
    if (e.description !== undefined) out.push(...issuesIn(e.description, e.id, 'description'));
  }
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
