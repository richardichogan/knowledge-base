/**
 * features/canvas/CanvasEditor.tsx — a canvas in Think: a network of cards
 * (Think notes, documents, meetings, chats and your own ideas) joined by typed
 * connections.
 *
 *   Drag a card to move it (it stays put) · drag from the dot on a card's edge
 *   (or Alt+drag) onto another card to connect them · click a connection to
 *   set its type/label · Tab adds an idea connected to the selected card ·
 *   F2 / double-click renames an idea · double-click a content card to preview
 *   it · Delete removes · ⌘Z undoes.
 *
 * New cards are placed automatically near what they connect to; changes show
 * instantly and are saved in order behind the scenes. The side panel has
 * Athena (who reads everything on the canvas), Preview, Suggestions and Details.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { ZoomIn, ZoomOut, FitToScreen, Undo, Copy, Close, Add, TrashCan, ChartNetwork, Pin } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { CanvasFullApi, CanvasNodeApi, MapOp, MapSuggestionApi } from '../../services/api';
import { fetchNotes } from '../../notes/noteStorage';
import type { NoteListItem } from '../../notes/types';
import { SideTabsPanel } from '../../components/SideTabsPanel';
import { ThinkAthenaPanel } from '../../notes/ThinkAthenaPanel';
import type { AthenaPageContext } from '../../context/AthenaContext';
import type { PaneWidthOptions } from '../../hooks/usePersistedState';
import {
  applyOps, inverseOps, placeNear, initialPositions, arrange, estimateSize, connectedIds, canvasMarkdown,
  LINK_TYPES, linkStyle, DEFAULT_LINK_TYPE, type GraphState, type Point, type Size,
} from './canvasGraph';
import { readCanvasItem, readPlainText } from './canvasClipboard';
import { CanvasPreviewTab, CanvasSuggestionsTab, CanvasDetailsTab } from './CanvasSidePanel';
import { KIND_LABEL, SUGGESTION_DRAG_TYPE, cardIcon, cardKindLabel } from './mapVisuals';
import { setActiveCanvas } from './activeCanvas';

const SIDE_WIDTH: PaneWidthOptions = { compact: 380, wide: 460, min: 300, max: (viewport) => Math.round(viewport * 0.45) };
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;
const FIT_PADDING = 100;
const DRAG_THRESHOLD_PX = 5;
const WHEEL_ZOOM_SENSITIVITY = 0.006;
const UNDO_LIMIT = 100;
const MAX_PASTE_LINES = 30;
const ARROW_SIZE = 8;
const PRESET_TYPES = Object.keys(LINK_TYPES);
const MARKER_COLOURS = [...new Set([...Object.values(LINK_TYPES).map((s) => s.colour), linkStyle('custom').colour])];

interface Props {
  canvasId: string;
  /** Open a Think note (switches Think to the note). */
  onOpenNote: (noteId: string) => void;
  /** A note's content changed server-side (a summary was added to it). */
  onNoteChanged: (noteId: string) => void;
  /** The canvas was deleted. */
  onDeleted: () => void;
  /** Side-panel tab to show when the canvas opens (e.g. Suggestions for a new canvas). */
  openTab?: string | undefined;
}

export const CanvasEditor: React.FC<Props> = (props) => {
  const { data, isLoading, isError } = useQuery<CanvasFullApi>({
    queryKey: ['canvas', props.canvasId],
    queryFn: async () => {
      const r = await api.getCanvas(props.canvasId);
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  if (isLoading) return <div className="mm-editor mm-editor--status"><InlineLoading description="Loading canvas…" /></div>;
  if (isError || data === undefined) return <div className="mm-editor mm-editor--status">Couldn’t load this canvas.</div>;
  return <CanvasSurface key={props.canvasId} {...props} initial={data} serverMap={data} />;
};

type Drag =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: 'card'; id: string; startX: number; startY: number; from: Point; moved: boolean; at: Point }
  | { kind: 'link'; id: string; at: Point; overId: string | null };

/** Where the line from `c` towards `towards` leaves a w×h box centred on `c`. */
function clipToBox(c: Point, towards: Point, s: Size): Point {
  const dx = towards.x - c.x;
  const dy = towards.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(dx === 0 ? Infinity : (s.w / 2) / Math.abs(dx), dy === 0 ? Infinity : (s.h / 2) / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function markerId(colour: string): string {
  return `cv-arrow-${colour.replace('#', '')}`;
}

const CanvasSurface: React.FC<Props & { initial: CanvasFullApi; serverMap: CanvasFullApi }> = ({
  canvasId, initial, serverMap, onOpenNote, onNoteChanged, onDeleted, openTab,
}) => {
  const queryClient = useQueryClient();
  const [map, setMapState] = useState<CanvasFullApi>(initial);
  const mapRef = useRef(map);
  const setMap = useCallback((m: CanvasFullApi): void => { mapRef.current = m; setMapState(m); }, []);

  const [selectedId, setSelectedId] = useState<string | null>(initial.nodes[0]?.id ?? null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map());
  const [athenaBusy, setAthenaBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tabRequest, setTabRequest] = useState<{ id: string; seq: number } | undefined>(openTab !== undefined ? { id: openTab, seq: 1 } : undefined);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const undoStack = useRef<MapOp[][]>([]);
  const newIdeaId = useRef<string | null>(null);
  const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const fitted = useRef(false);
  const userMovedView = useRef(false);

  const requestTab = (id: string): void => { setTabRequest((t) => ({ id, seq: (t?.seq ?? 0) + 1 })); };
  const sizeOf = useCallback((n: CanvasNodeApi): Size => sizes.get(n.id) ?? estimateSize(n), [sizes]);

  // ── Saving ─────────────────────────────────────────────────────────────────

  const reloadFromServer = useCallback(async (): Promise<void> => {
    const r = await api.getCanvas(canvasId);
    if (r.success) setMap(r.data);
  }, [canvasId, setMap]);

  /** New cards without a position get a free spot near what they connect to (or the selected card). */
  const withPositions = useCallback((ops: MapOp[]): MapOp[] => {
    const nodes = mapRef.current.nodes;
    const positions = new Map<string, Point>(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const sz = new Map<string, Size>(nodes.map((n) => [n.id, sizes.get(n.id) ?? estimateSize(n)]));
    return ops.map((op) => {
      if (op.op !== 'add') return op;
      const size = estimateSize({ refType: op.refType ?? null } as CanvasNodeApi);
      sz.set(op.id, size);
      if (op.x !== undefined && op.y !== undefined) { positions.set(op.id, { x: op.x, y: op.y }); return op; }
      const anchorId = op.connectTo?.nodeId ?? selectedId ?? nodes[0]?.id;
      const anchor = (anchorId !== undefined ? positions.get(anchorId) : undefined) ?? { x: 0, y: 0 };
      const p = positions.size === 0 ? { x: 0, y: 0 } : placeNear(anchor, size, positions, sz);
      positions.set(op.id, p);
      return { ...op, x: Math.round(p.x), y: Math.round(p.y) };
    });
  }, [selectedId, sizes]);

  /** Applies changes on screen now and saves them in order. */
  const commit = useCallback((rawOps: MapOp[], opts: { undoable?: boolean } = {}): void => {
    if (rawOps.length === 0) return;
    const ops = withPositions(rawOps);
    const before = mapRef.current;
    const state: GraphState = { nodes: before.nodes, edges: before.edges };
    if (opts.undoable !== false) {
      undoStack.current.push(inverseOps(state, ops, canvasId));
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    }
    setMap({ ...before, ...applyOps(state, ops, canvasId) });
    pending.current++;
    chain.current = chain.current
      .then(async () => {
        const r = await api.applyCanvasOps(canvasId, ops);
        pending.current--;
        if (!r.success) throw new Error(r.error.message);
        if (pending.current === 0) {
          setMap(r.data);
          void queryClient.invalidateQueries({ queryKey: ['canvases'] });
        }
      })
      .catch((err: unknown) => {
        pending.current = 0;
        undoStack.current = [];
        setError(`Couldn’t save that change (${err instanceof Error ? err.message : 'error'}) — the canvas was reloaded.`);
        void reloadFromServer();
      });
  }, [canvasId, queryClient, reloadFromServer, setMap, withPositions]);

  // Changes made elsewhere (e.g. Athena applied without the editor) arrive via the query.
  useEffect(() => {
    if (pending.current === 0 && serverMap.updatedAt !== mapRef.current.updatedAt) setMap(serverMap);
  }, [serverMap, setMap]);

  useEffect(() => {
    setActiveCanvas({ canvasId, commit: (ops) => { commit(ops); } });
    return () => { setActiveCanvas(null); };
  }, [canvasId, commit]);

  const undo = useCallback((): void => {
    const inv = undoStack.current.pop();
    if (inv !== undefined) commit(inv, { undoable: false });
  }, [commit]);

  // Cards that have never been placed (older canvases, "Send to Canvas") are arranged once and saved.
  useEffect(() => {
    const unplaced = mapRef.current.nodes.filter((n) => !n.placed);
    if (unplaced.length === 0) return;
    const { positions } = initialPositions(mapRef.current.nodes, mapRef.current.edges, new Map());
    commit(unplaced.map((n) => {
      const p = positions.get(n.id) ?? { x: 0, y: 0 };
      return { op: 'position' as const, id: n.id, x: Math.round(p.x), y: Math.round(p.y) };
    }), { undoable: false });
  }, [serverMap.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Layout ─────────────────────────────────────────────────────────────────

  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map.nodes]);
  const posOf = useCallback((n: CanvasNodeApi): Point => {
    if (drag?.kind === 'card' && drag.id === n.id && drag.moved) return drag.at;
    return { x: n.x, y: n.y };
  }, [drag]);

  // Measure cards so connections meet their edges exactly.
  useLayoutEffect(() => {
    let changed = false;
    const next = new Map(sizes);
    for (const [id, el] of cardEls.current) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const prev = sizes.get(id);
      if (w > 0 && (prev === undefined || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5)) { next.set(id, { w, h }); changed = true; }
    }
    if (changed) setSizes(next);
  });

  const fit = useCallback((): void => {
    const el = containerRef.current;
    if (el === null || map.nodes.length === 0) return;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const n of map.nodes) {
      const s = sizeOf(n);
      minX = Math.min(minX, n.x - s.w / 2); maxX = Math.max(maxX, n.x + s.w / 2);
      minY = Math.min(minY, n.y - s.h / 2); maxY = Math.max(maxY, n.y + s.h / 2);
    }
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (el.clientWidth - FIT_PADDING) / (maxX - minX), (el.clientHeight - FIT_PADDING) / (maxY - minY)));
    setView({ zoom, x: el.clientWidth / 2 - ((minX + maxX) / 2) * zoom, y: el.clientHeight / 2 - ((minY + maxY) / 2) * zoom });
  }, [map.nodes, sizeOf]);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (fitted.current || sizes.size === 0) return;
    fitted.current = true;
    fit();
    containerRef.current?.focus();
  }, [fit, sizes]);
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => { if (!userMovedView.current && fitted.current) fitRef.current(); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  /** Pans just enough to bring a card into view. */
  const reveal = useCallback((id: string): void => {
    const el = containerRef.current;
    const n = mapRef.current.nodes.find((x) => x.id === id);
    if (el === null || n === undefined) return;
    const s = sizeOf(n);
    const margin = 40;
    const left = view.x + (n.x - s.w / 2) * view.zoom;
    const right = view.x + (n.x + s.w / 2) * view.zoom;
    const top = view.y + (n.y - s.h / 2) * view.zoom;
    const bottom = view.y + (n.y + s.h / 2) * view.zoom;
    const dx = left < margin ? margin - left : right > el.clientWidth - margin ? el.clientWidth - margin - right : 0;
    const dy = top < margin ? margin - top : bottom > el.clientHeight - margin ? el.clientHeight - margin - bottom : 0;
    if (dx !== 0 || dy !== 0) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }, [sizeOf, view]);
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => { pendingReveal.current = selectedId; }, [selectedId]);
  useEffect(() => {
    const id = pendingReveal.current;
    if (id === null || !sizes.has(id)) return;
    pendingReveal.current = null;
    reveal(id);
  }, [sizes, selectedId, map.nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A blank canvas starts by naming its first idea.
  useEffect(() => {
    const first = initial.nodes[0];
    if (initial.nodes.length === 1 && first !== undefined && first.refType === null && first.label === 'New idea') startEditing(first.id, '');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Card actions ───────────────────────────────────────────────────────────

  function startEditing(id: string, initialText?: string): void {
    const n = mapRef.current.nodes.find((x) => x.id === id);
    if (n === undefined) return;
    setSelectedId(id);
    setEditingId(id);
    setDraftLabel(initialText ?? n.label ?? '');
  }

  function finishEditing(save: boolean): void {
    const id = editingId;
    if (id === null) return;
    const n = mapRef.current.nodes.find((x) => x.id === id);
    setEditingId(null);
    containerRef.current?.focus();
    if (n === undefined) return;
    const label = draftLabel.trim();
    const isNew = newIdeaId.current === id;
    newIdeaId.current = null;
    if (isNew && (label === '' || !save)) {
      undoStack.current.pop();
      commit([{ op: 'delete', id }], { undoable: false });
      setSelectedId(connectedIds(mapRef.current.edges, id)[0] ?? null);
      return;
    }
    // Naming the first idea of an untitled canvas names the canvas too.
    if (save && label !== '' && mapRef.current.title === 'Untitled canvas' && mapRef.current.nodes[0]?.id === id) void renameCanvas(label);
    if (save && label !== '' && label !== (n.label ?? '')) {
      // For a new idea, fold the title into the "add" so one ⌘Z removes it.
      commit([{ op: 'update', id, label }], { undoable: !isNew });
    }
  }

  /** A new idea card, connected to `from` (if any), ready to name. */
  function addIdea(from: string | null): void {
    const id = crypto.randomUUID();
    commit([{ op: 'add', id, label: '', ...(from !== null && { connectTo: { nodeId: from, edgeId: crypto.randomUUID(), type: DEFAULT_LINK_TYPE } }) }]);
    newIdeaId.current = id;
    startEditing(id, '');
  }

  function removeCard(id: string): void {
    const next = connectedIds(mapRef.current.edges, id)[0] ?? null;
    commit([{ op: 'delete', id }]);
    setSelectedId(next);
  }

  function addContent(s: MapSuggestionApi, connectTo: string | null, at?: Point): void {
    const id = crypto.randomUUID();
    commit([{
      op: 'add', id, label: s.title, refType: s.refType, refId: s.refId, tags: [KIND_LABEL[s.kind]],
      ...(s.url !== null && { url: s.url }),
      ...(at !== undefined && { x: Math.round(at.x), y: Math.round(at.y) }),
      ...(connectTo !== null && { connectTo: { nodeId: connectTo, edgeId: crypto.randomUUID(), type: DEFAULT_LINK_TYPE } }),
    }]);
    setSelectedId(id);
  }

  function connect(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    const existing = mapRef.current.edges.find((e) => (e.sourceId === sourceId && e.targetId === targetId) || (e.sourceId === targetId && e.targetId === sourceId));
    if (existing !== undefined) { setSelectedLinkId(existing.id); return; }
    const id = crypto.randomUUID();
    commit([{ op: 'link', id, sourceId, targetId, type: DEFAULT_LINK_TYPE }]);
    setSelectedLinkId(id);
  }

  function tidy(): void {
    if (!window.confirm('Tidy the layout? Every card except the first will be rearranged (⌘Z undoes it).')) return;
    const nodes = mapRef.current.nodes;
    const start = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const movable = new Set(nodes.slice(1).map((n) => n.id));
    const next = arrange(nodes, mapRef.current.edges, start, new Map(nodes.map((n) => [n.id, sizeOf(n)])), movable);
    commit([...movable].map((id) => {
      const p = next.get(id) ?? { x: 0, y: 0 };
      return { op: 'position' as const, id, x: Math.round(p.x), y: Math.round(p.y) };
    }));
    window.setTimeout(() => { fitRef.current(); }, 50);
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  /** The nearest card in an arrow key's direction. */
  function nearestInDirection(key: string): string | null {
    const cur = selectedId !== null ? byId.get(selectedId) : undefined;
    if (cur === undefined) return mapRef.current.nodes[0]?.id ?? null;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key] as [number, number] | undefined;
    if (dir === undefined) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const n of mapRef.current.nodes) {
      if (n.id === cur.id) continue;
      const dx = n.x - cur.x;
      const dy = n.y - cur.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 0) continue;
      const across = Math.abs(dx * dir[1] - dy * dir[0]);
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = n.id; }
    }
    return best;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (editingId !== null || e.target !== containerRef.current) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Escape') { setSelectedId(null); setSelectedLinkId(null); return; }
    if (selectedLinkId !== null && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      commit([{ op: 'unlink', id: selectedLinkId }]);
      setSelectedLinkId(null);
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); addIdea(selectedId); return; }
    const id = selectedId;
    if (id === null) {
      if (e.key.startsWith('Arrow')) { e.preventDefault(); setSelectedId(mapRef.current.nodes[0]?.id ?? null); }
      return;
    }
    if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); if (byId.get(id)?.refType === null) startEditing(id); else requestTab('preview'); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCard(id); return; }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); const next = nearestInDirection(e.key); if (next !== null) setSelectedId(next); return; }
    if (e.key.length === 1 && !mod && !e.altKey && byId.get(id)?.refType === null) { e.preventDefault(); startEditing(id, e.key); }
  }

  // Paste: a hub item ("copy to canvas") becomes a card; text lines become idea cards — connected to the selection.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (editingId !== null || document.activeElement !== containerRef.current) return;
      const item = readCanvasItem(e);
      e.preventDefault();
      if (item !== null) {
        const refType = (['discover_item', 'spark', 'note', 'content_item', 'ai_session'] as const).find((t) => t === item.refType);
        addContent({ kind: refType === 'note' ? 'note' : 'document', refType: refType ?? 'content_item', refId: item.id, title: item.label, excerpt: '', date: null, url: item.url ?? null, via: 'search' }, selectedId);
        return;
      }
      const lines = readPlainText(e).split('\n').map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter((l) => l !== '').slice(0, MAX_PASTE_LINES);
      commit(lines.map((label) => ({
        op: 'add' as const, id: crypto.randomUUID(), label,
        ...(selectedId !== null && { connectTo: { nodeId: selectedId, edgeId: crypto.randomUUID(), type: DEFAULT_LINK_TYPE } }),
      })));
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('paste', onPaste); };
  });

  // ── Pointer: pan, move cards, draw connections ─────────────────────────────

  function toWorld(clientX: number, clientY: number): Point {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - view.x) / view.zoom, y: (clientY - (rect?.top ?? 0) - view.y) / view.zoom };
  }

  function cardAt(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-card-id]');
    return el?.dataset['cardId'] ?? null;
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.mm-no-drag') !== null) return;
    const cardEl = target.closest<HTMLElement>('[data-card-id]');
    containerRef.current?.focus();
    containerRef.current?.setPointerCapture(e.pointerId);
    if (cardEl === null) {
      setSelectedLinkId(null);
      userMovedView.current = true;
      setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y });
      return;
    }
    const id = cardEl.dataset['cardId'] ?? '';
    if (editingId !== null && editingId !== id) finishEditing(true);
    setSelectedId(id);
    setSelectedLinkId(null);
    const at = toWorld(e.clientX, e.clientY);
    if (e.altKey || target.closest('[data-handle]') !== null) { setDrag({ kind: 'link', id, at, overId: null }); return; }
    const n = byId.get(id);
    if (n !== undefined) setDrag({ kind: 'card', id, startX: e.clientX, startY: e.clientY, from: { x: n.x, y: n.y }, moved: false, at: { x: n.x, y: n.y } });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (drag === null) return;
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, x: drag.viewX + e.clientX - drag.startX, y: drag.viewY + e.clientY - drag.startY }));
      return;
    }
    if (drag.kind === 'link') {
      const over = cardAt(e.clientX, e.clientY);
      setDrag({ ...drag, at: toWorld(e.clientX, e.clientY), overId: over !== drag.id ? over : null });
      return;
    }
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD_PX;
    setDrag({ ...drag, moved, at: { x: drag.from.x + (e.clientX - drag.startX) / view.zoom, y: drag.from.y + (e.clientY - drag.startY) / view.zoom } });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    containerRef.current?.releasePointerCapture(e.pointerId);
    const d = drag;
    setDrag(null);
    if (d === null || d.kind === 'pan') return;
    if (d.kind === 'link') { if (d.overId !== null) connect(d.id, d.overId); return; }
    if (d.moved) commit([{ op: 'position', id: d.id, x: Math.round(d.at.x), y: Math.round(d.at.y) }]);
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    userMovedView.current = true;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    if (e.ctrlKey || e.metaKey) {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY)));
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => ({ zoom, x: mx - ((mx - v.x) / v.zoom) * zoom, y: my - ((my - v.y) / v.zoom) * zoom }));
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  }

  // Native non-passive listener so ⌘/pinch-zoom doesn't zoom the page.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return undefined;
    const block = (e: WheelEvent): void => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    el.addEventListener('wheel', block, { passive: false });
    return () => { el.removeEventListener('wheel', block); };
  }, []);

  function zoomBy(factor: number): void {
    userMovedView.current = true;
    const el = containerRef.current;
    if (el === null) return;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => ({ zoom, x: cx - ((cx - v.x) / v.zoom) * zoom, y: cy - ((cy - v.y) / v.zoom) * zoom }));
  }

  // ── Canvas-level actions ───────────────────────────────────────────────────

  async function renameCanvas(title: string): Promise<void> {
    const t = title.trim();
    if (t === '' || t === mapRef.current.title) return;
    setMap({ ...mapRef.current, title: t });
    await api.updateCanvas(canvasId, { title: t });
    void queryClient.invalidateQueries({ queryKey: ['canvases'] });
  }

  async function pinNote(noteId: string): Promise<void> {
    const r = await api.linkCanvasNote(canvasId, noteId);
    if (r.success) { setMap(r.data); void queryClient.invalidateQueries({ queryKey: ['canvases'] }); }
  }

  async function unpinNote(noteId: string): Promise<void> {
    const r = await api.unlinkCanvasNote(canvasId, noteId);
    if (r.success) { setMap(r.data); void queryClient.invalidateQueries({ queryKey: ['canvases'] }); }
  }

  async function toNote(nodeId: string, noteId?: string): Promise<void> {
    await chain.current; // every change saved first
    const r = await api.canvasBranchToNote(canvasId, nodeId, noteId);
    if (!r.success) { setError(r.error.message); return; }
    onNoteChanged(r.data.noteId);
    void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    if (r.data.created) await reloadFromServer();
  }

  async function deleteCanvas(): Promise<void> {
    if (!window.confirm(`Delete the canvas “${map.title}”? This cannot be undone.`)) return;
    await api.deleteCanvas(canvasId);
    void queryClient.invalidateQueries({ queryKey: ['canvases'] });
    onDeleted();
  }

  function openCard(node: CanvasNodeApi): void {
    if (node.refType === 'note' && node.refId !== null) { onOpenNote(node.refId); return; }
    if (node.refType === 'ai_session' && node.refId !== null) {
      try { window.localStorage.setItem('kh-athena-session-id-standalone', node.refId); } catch { /* storage unavailable */ }
      window.open('/chat', '_blank', 'noopener');
      return;
    }
    if (node.url !== null && /^https?:\/\//.test(node.url)) { window.open(node.url, '_blank', 'noopener'); return; }
    if (node.refType === 'content_item') window.open('/library', '_blank', 'noopener');
    else if (node.refType === 'discover_item') window.open('/discover', '_blank', 'noopener');
  }

  async function copyMarkdown(): Promise<void> {
    await navigator.clipboard.writeText(canvasMarkdown(map.title, map.nodes, map.edges));
    setCopied(true);
    window.setTimeout(() => { setCopied(false); }, 1500);
  }

  // ── Athena context ─────────────────────────────────────────────────────────

  const selected = selectedId !== null ? byId.get(selectedId) : undefined;
  const selectedLabel = selected?.label ?? '';
  const onCanvas = useMemo(() => new Set(map.nodes.flatMap((n) => (n.refId !== null ? [n.refId] : []))), [map.nodes]);
  const pinnedNoteIds = useMemo(() => new Set(map.linkedNotes.map((n) => n.id)), [map.linkedNotes]);
  const athenaContext = useMemo<AthenaPageContext>(() => ({
    type: 'canvas',
    title: map.title,
    id: `map:${canvasId}`,
    detail: `Canvas with ${map.nodes.length.toString()} cards and ${map.edges.length.toString()} connections.${selectedId !== null ? ` Selected card: "${selectedLabel}".` : ''} The cards and their content are provided separately.`,
    ...(selectedId !== null && { selectedId }),
    ...(map.project !== null && { projectId: map.project }),
  }), [canvasId, map.title, map.nodes.length, map.edges.length, map.project, selectedId, selectedLabel]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const links = map.edges.flatMap((e) => {
    const a = byId.get(e.sourceId);
    const b = byId.get(e.targetId);
    if (a === undefined || b === undefined) return [];
    const pa = posOf(a);
    const pb = posOf(b);
    const start = clipToBox(pa, pb, sizeOf(a));
    const style = linkStyle(e.type);
    const end = clipToBox(pb, pa, { w: sizeOf(b).w + (style.directed ? ARROW_SIZE : 0), h: sizeOf(b).h + (style.directed ? ARROW_SIZE : 0) });
    return [{ edge: e, start, end, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, style }];
  });
  const selectedLink = links.find((l) => l.edge.id === selectedLinkId);
  const draftFrom = drag?.kind === 'link' ? byId.get(drag.id) : undefined;

  return (
    <div className="mm-editor">
      <div className="mm-main">
        <CanvasHeader map={map} onDelete={() => { void deleteCanvas(); }} onRename={(t) => { void renameCanvas(t); }}
          onPin={(id) => { void pinNote(id); }} onUnpin={(id) => { void unpinNote(id); }} onOpenNote={onOpenNote} />
        <div
          ref={containerRef}
          className={`mm-surface${drag?.kind === 'pan' ? ' mm-surface--panning' : ''}`}
          tabIndex={0}
          role="application"
          aria-label={`Canvas ${map.title}. Tab adds an idea connected to the selected card; drag from a card's edge dot to connect; Delete removes.`}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(SUGGESTION_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropTargetId(cardAt(e.clientX, e.clientY));
          }}
          onDragLeave={() => { setDropTargetId(null); }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(SUGGESTION_DRAG_TYPE);
            setDropTargetId(null);
            if (raw === '') return;
            e.preventDefault();
            const onto = cardAt(e.clientX, e.clientY);
            // Dropped onto a card: connect to it (placed nearby). Dropped on empty space: placed there, connected to the selection.
            addContent(JSON.parse(raw) as MapSuggestionApi, onto ?? selectedId, onto === null ? toWorld(e.clientX, e.clientY) : undefined);
          }}
        >
          <div className="mm-world" style={{ transform: `translate(${view.x.toString()}px, ${view.y.toString()}px) scale(${view.zoom.toString()})` }}>
            <svg className="mm-lines" width="1" height="1" aria-hidden="true">
              <defs>
                {MARKER_COLOURS.map((c) => (
                  <marker key={c} id={markerId(c)} viewBox="0 0 10 10" refX="1" refY="5" markerWidth={ARROW_SIZE} markerHeight={ARROW_SIZE} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill={c} />
                  </marker>
                ))}
              </defs>
              {links.map((l) => (
                <g key={l.edge.id}>
                  <line
                    className={`cv-link${l.edge.id === selectedLinkId ? ' cv-link--selected' : ''}`}
                    x1={l.start.x} y1={l.start.y} x2={l.end.x} y2={l.end.y}
                    stroke={l.style.colour}
                    strokeDasharray={l.style.dashed ? '6 5' : undefined}
                    markerEnd={l.style.directed ? `url(#${markerId(l.style.colour)})` : undefined}
                  />
                  <line
                    className="mm-link-hit mm-no-drag"
                    x1={l.start.x} y1={l.start.y} x2={l.end.x} y2={l.end.y}
                    onPointerDown={(ev) => { ev.stopPropagation(); setSelectedLinkId(l.edge.id); containerRef.current?.focus(); }}
                  />
                </g>
              ))}
              {drag?.kind === 'link' && draftFrom !== undefined && (
                <line className="cv-link cv-link--draft" x1={draftFrom.x} y1={draftFrom.y} x2={drag.at.x} y2={drag.at.y} />
              )}
            </svg>

            {links.filter((l) => l.edge.id !== selectedLinkId && (l.edge.type !== DEFAULT_LINK_TYPE || l.edge.label !== null)).map((l) => (
              <span key={l.edge.id} className="cv-link-label" style={{ left: l.mid.x, top: l.mid.y, color: l.style.colour }}>
                {l.edge.type !== DEFAULT_LINK_TYPE ? l.edge.type : ''}{l.edge.type !== DEFAULT_LINK_TYPE && l.edge.label !== null ? ' · ' : ''}{l.edge.label}
              </span>
            ))}

            {map.nodes.map((n) => {
              const p = posOf(n);
              const s = sizeOf(n);
              const isIdea = n.refType === null;
              const Icon = cardIcon(n);
              const pinned = n.refType === 'note' && n.refId !== null && pinnedNoteIds.has(n.refId);
              const classes = [
                'cv-card', isIdea ? 'cv-card--idea' : 'cv-card--content', pinned ? 'cv-card--pinned' : '',
                n.id === selectedId ? 'cv-card--selected' : '',
                drag?.kind === 'card' && drag.id === n.id && drag.moved ? 'cv-card--dragging' : '',
                (drag?.kind === 'link' && drag.overId === n.id) || dropTargetId === n.id ? 'cv-card--target' : '',
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={n.id}
                  ref={(el) => { if (el !== null) cardEls.current.set(n.id, el); else cardEls.current.delete(n.id); }}
                  data-card-id={n.id}
                  className={classes}
                  style={{ left: p.x - s.w / 2, top: p.y - s.h / 2 }}
                  onDoubleClick={() => { if (isIdea) startEditing(n.id); else requestTab('preview'); }}
                >
                  <div className="cv-card__kind">
                    <Icon size={14} />
                    <span>{cardKindLabel(n)}</span>
                    {pinned && <span className="cv-card__pin" title="This canvas is pinned to this note"><Pin size={12} /></span>}
                  </div>
                  {editingId === n.id ? (
                    <textarea
                      className="cv-card__input mm-no-drag"
                      autoFocus
                      rows={2}
                      value={draftLabel}
                      placeholder="New idea"
                      onFocus={(ev) => { const v = ev.currentTarget.value; ev.currentTarget.setSelectionRange(v.length, v.length); }}
                      onChange={(ev) => { setDraftLabel(ev.target.value); }}
                      onBlur={() => { finishEditing(true); }}
                      onKeyDown={(ev) => {
                        ev.stopPropagation();
                        if (ev.key === 'Escape') { ev.preventDefault(); finishEditing(false); return; }
                        if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Tab') {
                          ev.preventDefault();
                          const id = n.id;
                          const named = draftLabel.trim() !== '';
                          finishEditing(true);
                          if (named && ev.key === 'Tab') addIdea(id);
                        }
                      }}
                    />
                  ) : (
                    <p className="cv-card__title">{n.label !== null && n.label !== '' ? n.label : <em>Untitled</em>}</p>
                  )}
                  {n.body !== null && n.body.trim() !== '' && editingId !== n.id && <p className="cv-card__note">{n.body}</p>}
                  <span className="cv-card__handle mm-handle" data-handle title="Drag to another card to connect" />
                </div>
              );
            })}

            {selectedLink !== undefined && (
              <LinkEditor
                key={selectedLink.edge.id}
                at={selectedLink.mid}
                type={selectedLink.edge.type}
                label={selectedLink.edge.label}
                onChange={(patch) => { commit([{ op: 'update_link', id: selectedLink.edge.id, ...patch }]); }}
                onDelete={() => { commit([{ op: 'unlink', id: selectedLink.edge.id }]); setSelectedLinkId(null); }}
                onDone={() => { setSelectedLinkId(null); containerRef.current?.focus(); }}
              />
            )}
          </div>

          <div className="mm-toolbar mm-no-drag" onPointerDown={(e) => { e.stopPropagation(); }}>
            <button type="button" className="mm-icon-btn" title="Add an idea (Tab) — connected to the selected card" aria-label="Add an idea" onClick={() => { addIdea(selectedId); }}><Add size={16} /></button>
            <span className="mm-toolbar__sep" />
            <button type="button" className="mm-icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => { zoomBy(1 / ZOOM_STEP); }}><ZoomOut size={16} /></button>
            <span className="mm-toolbar__zoom">{Math.round(view.zoom * 100)}%</span>
            <button type="button" className="mm-icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => { zoomBy(ZOOM_STEP); }}><ZoomIn size={16} /></button>
            <button type="button" className="mm-icon-btn" title="Fit the whole canvas" aria-label="Fit the whole canvas" onClick={() => { userMovedView.current = false; fit(); }}><FitToScreen size={16} /></button>
            <button type="button" className="mm-icon-btn" title="Tidy the layout" aria-label="Tidy the layout" onClick={tidy}><ChartNetwork size={16} /></button>
            <span className="mm-toolbar__sep" />
            <button type="button" className="mm-icon-btn" title="Undo (⌘Z)" aria-label="Undo" onClick={undo}><Undo size={16} /></button>
            <button type="button" className="mm-icon-btn" title="Copy as Markdown" aria-label="Copy as Markdown" onClick={() => { void copyMarkdown(); }}><Copy size={16} /></button>
            {copied && <span className="mm-toolbar__note">Copied</span>}
          </div>

          <p className="mm-hint">Drag cards to arrange · drag from a card’s edge dot to connect · click a connection to type it · Tab adds an idea · Del removes · ⌘Z undo</p>

          {error !== null && (
            <div className="mm-error mm-no-drag" role="alert" onPointerDown={(e) => { e.stopPropagation(); }}>
              {error}
              <button type="button" className="mm-icon-btn" aria-label="Dismiss" onClick={() => { setError(null); }}><Close size={14} /></button>
            </div>
          )}
        </div>
      </div>

      <SideTabsPanel
        storageKey="canvas-side"
        label="Canvas side panel"
        defaultTab="suggestions"
        width={SIDE_WIDTH}
        selectTab={tabRequest}
        tabs={[
          {
            id: 'athena', label: 'Athena', dot: athenaBusy ? 'busy' : 'idle', keepMounted: true, fill: true,
            content: <ThinkAthenaPanel pageContext={athenaContext} onBusyChange={setAthenaBusy} />,
          },
          { id: 'preview', label: 'Preview', content: <CanvasPreviewTab canvasId={canvasId} node={selected} onOpen={openCard} /> },
          {
            id: 'suggestions', label: 'Suggestions',
            content: (
              <CanvasSuggestionsTab
                canvasId={canvasId}
                node={selected ?? map.nodes[0]}
                contextLabels={(selected !== undefined ? connectedIds(map.edges, selected.id) : []).map((id) => byId.get(id)?.label ?? '').join(' ')}
                onCanvas={onCanvas}
                onAdd={(s) => { addContent(s, selectedId ?? map.nodes[0]?.id ?? null); }}
              />
            ),
          },
          {
            id: 'details', label: 'Details',
            content: (
              <CanvasDetailsTab
                map={map}
                node={selected}
                onUpdate={(id, patch) => { commit([{ op: 'update', id, ...patch }]); }}
                onDelete={removeCard}
                onSelect={(id) => { setSelectedId(id); }}
                onRetype={(edgeId, type) => { commit([{ op: 'update_link', id: edgeId, type }]); }}
                onUnlink={(edgeId) => { commit([{ op: 'unlink', id: edgeId }]); }}
                onOpen={openCard}
                onToNote={toNote}
                onDeleteCanvas={() => { void deleteCanvas(); }}
              />
            ),
          },
        ]}
      />
    </div>
  );
};

// ── Connection editor (type, label, delete) ───────────────────────────────────

interface LinkEditorProps {
  at: Point;
  type: string;
  label: string | null;
  onChange: (patch: { type?: string; label?: string }) => void;
  onDelete: () => void;
  onDone: () => void;
}

const LinkEditor: React.FC<LinkEditorProps> = ({ at, type, label, onChange, onDelete, onDone }) => {
  const [custom, setCustom] = useState(PRESET_TYPES.includes(type) ? '' : type);
  return (
    <div
      className="cv-link-editor mm-no-drag"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onDone(); }}
    >
      <div className="cv-link-editor__types">
        {PRESET_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`cv-type-chip${t === type ? ' cv-type-chip--active' : ''}`}
            style={{ borderColor: linkStyle(t).colour, color: t === type ? 'var(--cds-background)' : linkStyle(t).colour, background: t === type ? linkStyle(t).colour : 'transparent' }}
            onClick={() => { onChange({ type: t }); }}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="cv-link-editor__row">
        <input
          className="cv-link-editor__input"
          placeholder="Custom type"
          value={custom}
          onChange={(e) => { setCustom(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim() !== '') onChange({ type: custom.trim() }); }}
          onBlur={() => { if (custom.trim() !== '' && custom.trim().toLowerCase() !== type) onChange({ type: custom.trim() }); }}
        />
        <input
          className="cv-link-editor__input"
          placeholder="Label (optional)"
          defaultValue={label ?? ''}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onBlur={(e) => { if (e.target.value !== (label ?? '')) onChange({ label: e.target.value }); }}
        />
      </div>
      <div className="cv-link-editor__row cv-link-editor__row--end">
        <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={onDelete}><TrashCan size={14} /> Remove</button>
        <button type="button" className="kb-import-btn" onClick={onDone}>Done</button>
      </div>
    </div>
  );
};

// ── Header: title + pinned notes ──────────────────────────────────────────────

interface HeaderProps {
  map: CanvasFullApi;
  onDelete: () => void;
  onRename: (title: string) => void;
  onPin: (noteId: string) => void;
  onUnpin: (noteId: string) => void;
  onOpenNote: (noteId: string) => void;
}

const CanvasHeader: React.FC<HeaderProps> = ({ map, onDelete, onRename, onPin, onUnpin, onOpenNote }) => {
  const [title, setTitle] = useState(map.title);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => { setTitle(map.title); }, [map.title]);
  const { data: notes = [] } = useQuery<NoteListItem[]>({ queryKey: ['notes-list'], queryFn: fetchNotes, staleTime: 30_000, enabled: picking });
  const pinned = new Set(map.linkedNotes.map((n) => n.id));
  const q = query.trim().toLowerCase();
  const matches = notes.filter((n) => !pinned.has(n.id) && (q === '' || n.title.toLowerCase().includes(q))).slice(0, 12);

  return (
    <div className="mm-header">
      <input className="mm-header__title" value={title} aria-label="Canvas title"
        onChange={(e) => { setTitle(e.target.value); }}
        onBlur={() => { onRename(title); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <div className="mm-header__notes">
        {map.linkedNotes.length === 0 && (
          <span className="mm-header__nudge">Not pinned to a note yet — pinning connects this canvas to your notes and the knowledge graph.</span>
        )}
        {map.linkedNotes.map((n) => (
          <span key={n.id} className="mm-chip">
            <Pin size={12} className="mm-chip__icon" />
            <button type="button" className="mm-chip__open" title="Open note" onClick={() => { onOpenNote(n.id); }}>{n.title}</button>
            <button type="button" className="mm-chip__remove" title="Unpin note" aria-label={`Unpin ${n.title}`} onClick={() => { onUnpin(n.id); }}><Close size={12} /></button>
          </span>
        ))}
        <div className="mm-picker-anchor">
          <button type="button" className={`mm-chip mm-chip--add${map.linkedNotes.length === 0 ? ' mm-chip--nudge' : ''}`} onClick={() => { setPicking((v) => !v); setQuery(''); }}>
            <Pin size={12} /> Pin to note
          </button>
          {picking && (
            <div className="mm-picker" role="dialog" aria-label="Pin to a note">
              <input className="mm-picker__search" autoFocus placeholder="Search notes…" value={query}
                onChange={(e) => { setQuery(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Escape') setPicking(false); }} />
              <ul className="mm-picker__list">
                {matches.map((n) => (
                  <li key={n.id}><button type="button" className="mm-picker__item" onClick={() => { onPin(n.id); setPicking(false); }}>{n.title}</button></li>
                ))}
                {matches.length === 0 && <li className="mm-picker__empty">No matching notes</li>}
              </ul>
            </div>
          )}
        </div>
      </div>
      <button type="button" className="mm-icon-btn mm-header__delete" title="Delete canvas" aria-label="Delete canvas" onClick={onDelete}><TrashCan size={16} /></button>
    </div>
  );
};
