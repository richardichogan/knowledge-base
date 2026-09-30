/**
 * features/canvas/MindMapEditor.tsx — a mind map in Think's Canvas view.
 *
 * The map is a tree with the central idea in the middle and branches either
 * side, always laid out tidily (see mindMap.ts). Editing is keyboard-first:
 *   Tab = add a sub-idea · Enter = add a sibling · F2 / double-click / type = rename
 *   Delete = remove the branch · Space = collapse · arrows = move around
 *   Alt+↑/↓ = reorder · ⌘Z = undo
 * Drag an idea onto another to move it; Alt+drag from one idea to another to
 * cross-link them. Changes show instantly and are saved in order behind the
 * scenes. The side panel has Athena (sees the whole map), Suggestions (related
 * content for the selected idea) and Details.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { ZoomIn, ZoomOut, FitToScreen, Undo, Copy, Close, Link as LinkIcon, CaretRight, CaretLeft, Add } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { CanvasFullApi, CanvasNodeApi, MapOp, MapSide, MapSuggestionApi } from '../../services/api';
import { fetchNotes } from '../../notes/noteStorage';
import type { NoteListItem } from '../../notes/types';
import { SideTabsPanel } from '../../components/SideTabsPanel';
import { ThinkAthenaPanel } from '../../notes/ThinkAthenaPanel';
import type { AthenaPageContext } from '../../context/AthenaContext';
import type { PaneWidthOptions } from '../../hooks/usePersistedState';
import {
  applyOps, inverseOps, layoutMap, rootOf, childrenOf, descendantIds, sideOf, balancedSide, outlineMarkdown,
  type MapState, type Size,
} from './mindMap';
import { readCanvasItem, readPlainText } from './canvasClipboard';
import { MapSuggestionsTab, MapDetailsTab } from './MapSidePanel';
import { SUGGESTION_DRAG_TYPE, refIcon } from './mapVisuals';
import { setActiveMindMap } from './activeMindMap';

const MAP_SIDE_WIDTH: PaneWidthOptions = { compact: 360, wide: 440, min: 280, max: (viewport) => Math.round(viewport * 0.45) };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;
const FIT_PADDING = 80;
const DRAG_THRESHOLD_PX = 5;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const LINK_CURVE = 0.25;
const UNDO_LIMIT = 100;
const MAX_PASTE_LINES = 50;

interface Props {
  canvasId: string;
  /** Open a Think note (switches Think to the note). */
  onOpenNote: (noteId: string) => void;
  /** A note's content changed server-side (branch added to it). */
  onNoteChanged: (noteId: string) => void;
  /** The map was deleted. */
  onDeleted: () => void;
}

export const MindMapEditor: React.FC<Props> = (props) => {
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
  if (isLoading) return <div className="mm-editor mm-editor--status"><InlineLoading description="Loading map…" /></div>;
  if (isError || data === undefined) return <div className="mm-editor mm-editor--status">Couldn’t load this map.</div>;
  return <MindMapCanvas key={props.canvasId} {...props} initial={data} serverMap={data} />;
};

type Drag =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: 'node'; id: string; startX: number; startY: number; moved: boolean; overId: string | null; px: number; py: number }
  | { kind: 'link'; id: string; px: number; py: number; overId: string | null };

const MindMapCanvas: React.FC<Props & { initial: CanvasFullApi; serverMap: CanvasFullApi }> = ({ canvasId, initial, serverMap, onOpenNote, onNoteChanged, onDeleted }) => {
  const queryClient = useQueryClient();
  const [map, setMapState] = useState<CanvasFullApi>(initial);
  const mapRef = useRef(map);
  const setMap = useCallback((m: CanvasFullApi): void => { mapRef.current = m; setMapState(m); }, []);

  const root = rootOf(map.nodes);
  const [selectedId, setSelectedId] = useState<string | null>(root?.id ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map());
  const [athenaBusy, setAthenaBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  const undoStack = useRef<MapOp[][]>([]);
  const newNodeId = useRef<string | null>(null);
  const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const fitted = useRef(false);

  // ── Saving ─────────────────────────────────────────────────────────────────

  const reloadFromServer = useCallback(async (): Promise<void> => {
    const r = await api.getCanvas(canvasId);
    if (r.success) setMap(r.data);
  }, [canvasId, setMap]);

  /** Applies changes on screen now and saves them in order. */
  const commit = useCallback((ops: MapOp[], opts: { undoable?: boolean } = {}): void => {
    if (ops.length === 0) return;
    const before = mapRef.current;
    const state: MapState = { nodes: before.nodes, edges: before.edges };
    if (opts.undoable !== false) {
      undoStack.current.push(inverseOps(state, ops, canvasId));
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    }
    const next = applyOps(state, ops, canvasId);
    setMap({ ...before, ...next });
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
        setError(`Couldn’t save that change (${err instanceof Error ? err.message : 'error'}) — the map was reloaded.`);
        void reloadFromServer();
      });
  }, [canvasId, queryClient, reloadFromServer, setMap]);

  // Changes made elsewhere (e.g. Athena applied without the editor) arrive via the query.
  useEffect(() => {
    if (pending.current === 0 && serverMap.updatedAt !== mapRef.current.updatedAt) setMap(serverMap);
  }, [serverMap, setMap]);

  useEffect(() => {
    setActiveMindMap({ canvasId, commit: (ops) => { commit(ops); } });
    return () => { setActiveMindMap(null); };
  }, [canvasId, commit]);

  const undo = useCallback((): void => {
    const inv = undoStack.current.pop();
    if (inv !== undefined) commit(inv, { undoable: false });
  }, [commit]);

  // ── Layout ─────────────────────────────────────────────────────────────────

  const placed = useMemo(() => layoutMap(map.nodes, sizes), [map.nodes, sizes]);
  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map.nodes]);

  // Measure rendered ideas; re-layout when a size changes.
  useLayoutEffect(() => {
    let changed = false;
    const next = new Map(sizes);
    for (const [id, el] of nodeEls.current) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const prev = sizes.get(id);
      if (w > 0 && (prev === undefined || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5)) {
        next.set(id, { w, h });
        changed = true;
      }
    }
    if (changed) setSizes(next);
  });

  const fit = useCallback((): void => {
    const el = containerRef.current;
    if (el === null || placed.size === 0) return;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const p of placed.values()) {
      minX = Math.min(minX, p.x - p.w / 2); maxX = Math.max(maxX, p.x + p.w / 2);
      minY = Math.min(minY, p.y - p.h / 2); maxY = Math.max(maxY, p.y + p.h / 2);
    }
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (el.clientWidth - FIT_PADDING) / (maxX - minX), (el.clientHeight - FIT_PADDING) / (maxY - minY)));
    setView({ zoom, x: el.clientWidth / 2 - ((minX + maxX) / 2) * zoom, y: el.clientHeight / 2 - ((minY + maxY) / 2) * zoom });
  }, [placed]);

  // Fit once the ideas are measured, and again whenever the surface resizes
  // (the page settles after mount) — until the user pans or zooms themselves.
  const userMovedView = useRef(false);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (fitted.current || placed.size === 0 || sizes.size === 0) return;
    fitted.current = true;
    fit();
    containerRef.current?.focus();
  }, [fit, placed, sizes]);
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => { if (!userMovedView.current && fitted.current) fitRef.current(); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  /** Scrolls an idea into view if it's off-screen. */
  const reveal = useCallback((id: string): void => {
    const el = containerRef.current;
    const p = placed.get(id);
    if (el === null || p === undefined) return;
    const sx = view.x + p.x * view.zoom;
    const sy = view.y + p.y * view.zoom;
    const margin = 60;
    // Pan just enough to bring it into view (keeps the rest of the map where it was).
    const halfW = (p.w / 2) * view.zoom;
    const halfH = (p.h / 2) * view.zoom;
    const dx = sx - halfW < margin ? margin - (sx - halfW) : sx + halfW > el.clientWidth - margin ? el.clientWidth - margin - (sx + halfW) : 0;
    const dy = sy - halfH < margin ? margin - (sy - halfH) : sy + halfH > el.clientHeight - margin ? el.clientHeight - margin - (sy + halfH) : 0;
    if (dx !== 0 || dy !== 0) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }, [placed, view]);

  // Reveal a newly selected idea once its real size is known (estimates overshoot).
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => { pendingReveal.current = selectedId; }, [selectedId]);
  useEffect(() => {
    const id = pendingReveal.current;
    if (id === null || !sizes.has(id)) return;
    pendingReveal.current = null;
    reveal(id);
  }, [placed, sizes, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A brand-new map starts by naming its central idea.
  useEffect(() => {
    const r = rootOf(initial.nodes);
    if (initial.nodes.length === 1 && r !== undefined && r.label === 'Central idea') startEditing(r.id, '');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Editing actions ────────────────────────────────────────────────────────

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
    const isNew = newNodeId.current === id;
    newNodeId.current = null;
    if (isNew && (label === '' || !save)) {
      // Abandoned new idea: remove it and its undo entry.
      undoStack.current.pop();
      commit([{ op: 'delete', id }], { undoable: false });
      setSelectedId(n.parentId);
      return;
    }
    // Naming the central idea of an untitled map names the map too.
    if (save && label !== '' && n.parentId === null && mapRef.current.title === 'Untitled map') void renameMap(label);
    if (save && label !== '' && label !== (n.label ?? '')) {
      if (isNew) {
        // Fold the label into the "add" so one ⌘Z removes the new idea.
        commit([{ op: 'update', id, label }], { undoable: false });
      } else {
        commit([{ op: 'update', id, label }]);
      }
    }
  }

  function addIdea(parentId: string, index?: number, label = ''): string {
    const parent = mapRef.current.nodes.find((n) => n.id === parentId);
    const id = crypto.randomUUID();
    const side: MapSide | undefined = parent?.parentId === null ? balancedSide(mapRef.current.nodes) : undefined;
    if (parent?.collapsed === true) commit([{ op: 'update', id: parentId, collapsed: false }]);
    commit([{ op: 'add', id, parentId, label, ...(index !== undefined && { index }), ...(side !== undefined && { side }) }]);
    return id;
  }

  function addChild(of: string): void {
    const id = addIdea(of);
    newNodeId.current = id;
    startEditing(id, '');
  }

  function addSibling(of: string): void {
    const n = mapRef.current.nodes.find((x) => x.id === of);
    if (n === undefined) return;
    if (n.parentId === null) { addChild(of); return; }
    const id = crypto.randomUUID();
    const index = n.sortOrder + 1;
    commit([{ op: 'add', id, parentId: n.parentId, index, label: '', ...(n.side !== null && { side: n.side }) }]);
    newNodeId.current = id;
    startEditing(id, '');
  }

  function removeIdea(id: string): void {
    const n = mapRef.current.nodes.find((x) => x.id === id);
    if (n?.parentId == null) return;
    const siblings = childrenOf(mapRef.current.nodes, n.parentId);
    const next = siblings[siblings.findIndex((s) => s.id === id) + 1] ?? siblings[siblings.findIndex((s) => s.id === id) - 1];
    commit([{ op: 'delete', id }]);
    setSelectedId(next?.id ?? n.parentId);
  }

  function addFromSuggestion(s: MapSuggestionApi, parentId: string): void {
    const parent = mapRef.current.nodes.find((n) => n.id === parentId);
    const side = parent?.parentId === null ? balancedSide(mapRef.current.nodes) : undefined;
    const id = crypto.randomUUID();
    if (parent?.collapsed === true) commit([{ op: 'update', id: parentId, collapsed: false }]);
    commit([{
      op: 'add', id, parentId, label: s.title, refType: s.refType, refId: s.refId,
      ...(s.url !== null && { url: s.url }), ...(side !== undefined && { side }),
    }]);
    setSelectedId(id);
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function navigate(key: string): void {
    const nodes = mapRef.current.nodes;
    const cur = selectedId !== null ? byId.get(selectedId) : undefined;
    if (cur === undefined) { if (root !== undefined) setSelectedId(root.id); return; }
    const side = sideOf(nodes, cur.id);
    const visibleKids = cur.collapsed ? [] : childrenOf(nodes, cur.id);
    const parent = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
    const siblings = cur.parentId === null ? [] : childrenOf(nodes, cur.parentId).filter((s) => parent?.parentId !== null || s.side === cur.side);
    const i = siblings.findIndex((s) => s.id === cur.id);
    const inward = (k: string): boolean => (side === 'left' ? k === 'ArrowRight' : k === 'ArrowLeft');
    if (key === 'ArrowUp' && i > 0) setSelectedId(siblings[i - 1]?.id ?? cur.id);
    else if (key === 'ArrowDown' && i >= 0 && i < siblings.length - 1) setSelectedId(siblings[i + 1]?.id ?? cur.id);
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (cur.parentId === null) {
        const wanted: MapSide = key === 'ArrowLeft' ? 'left' : 'right';
        const first = visibleKids.find((k) => (k.side ?? 'right') === wanted);
        if (first !== undefined) setSelectedId(first.id);
      } else if (inward(key)) {
        setSelectedId(cur.parentId);
      } else if (visibleKids[0] !== undefined) {
        setSelectedId(visibleKids[0].id);
      }
    }
  }

  function reorder(dir: -1 | 1): void {
    const cur = selectedId !== null ? byId.get(selectedId) : undefined;
    if (cur?.parentId == null) return;
    const siblings = childrenOf(mapRef.current.nodes, cur.parentId);
    const target = cur.sortOrder + dir;
    if (target < 0 || target >= siblings.length) return;
    commit([{ op: 'move', id: cur.id, parentId: cur.parentId, index: target, ...(cur.side !== null && { side: cur.side }) }]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (editingId !== null) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]') !== null && target !== containerRef.current) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (selectedLinkId !== null && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      commit([{ op: 'unlink', id: selectedLinkId }]);
      setSelectedLinkId(null);
      return;
    }
    const id = selectedId;
    if (e.key === 'Escape') { setSelectedId(null); setSelectedLinkId(null); return; }
    if (id === null) {
      if (root !== undefined && (e.key.startsWith('Arrow') || e.key === 'Enter')) { e.preventDefault(); setSelectedId(root.id); }
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); addChild(id); return; }
    if (e.key === 'Enter') { e.preventDefault(); addSibling(id); return; }
    if (e.key === 'F2') { e.preventDefault(); startEditing(id); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeIdea(id); return; }
    if (e.key === ' ') {
      e.preventDefault();
      const n = byId.get(id);
      if (n !== undefined && childrenOf(mapRef.current.nodes, id).length > 0) commit([{ op: 'update', id, collapsed: !n.collapsed }]);
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); reorder(e.key === 'ArrowUp' ? -1 : 1); return; }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); navigate(e.key); return; }
    if (e.key.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEditing(id, e.key); }
  }

  // Paste: a hub item (Discover "copy to canvas") or text lines become sub-ideas of the selection.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (editingId !== null || document.activeElement !== containerRef.current) return;
      const parentId = selectedId ?? root?.id;
      if (parentId === undefined) return;
      const item = readCanvasItem(e);
      e.preventDefault();
      if (item !== null) {
        const refType = (['discover_item', 'spark', 'note', 'content_item', 'ai_session'] as const).find((t) => t === item.refType);
        addFromSuggestion({
          kind: 'document', refType: refType ?? 'content_item', refId: item.id, title: item.label,
          excerpt: '', date: null, url: item.url ?? null, via: 'search',
        }, parentId);
        return;
      }
      const lines = readPlainText(e).split('\n').map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter((l) => l !== '').slice(0, MAX_PASTE_LINES);
      const side = byId.get(parentId)?.parentId === null ? balancedSide(mapRef.current.nodes) : undefined;
      commit(lines.map((label) => ({ op: 'add' as const, id: crypto.randomUUID(), parentId, label, ...(side !== undefined && { side }) })));
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('paste', onPaste); };
  });

  // ── Pointer: pan, drag to move, Alt+drag to link ──────────────────────────

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - view.x) / view.zoom, y: (clientY - (rect?.top ?? 0) - view.y) / view.zoom };
  }

  function nodeAt(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-node-id]');
    return el?.dataset['nodeId'] ?? null;
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
    if ((e.target as HTMLElement).closest('.mm-no-drag') !== null) return;
    containerRef.current?.focus();
    containerRef.current?.setPointerCapture(e.pointerId);
    if (nodeEl === null) {
      setSelectedLinkId(null);
      userMovedView.current = true;
      setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y });
      return;
    }
    const id = nodeEl.dataset['nodeId'] ?? '';
    if (editingId !== null && editingId !== id) finishEditing(true);
    setSelectedId(id);
    setSelectedLinkId(null);
    const w = toWorld(e.clientX, e.clientY);
    if (e.altKey) setDrag({ kind: 'link', id, px: w.x, py: w.y, overId: null });
    else setDrag({ kind: 'node', id, startX: e.clientX, startY: e.clientY, moved: false, overId: null, px: w.x, py: w.y });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (drag === null) return;
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, x: drag.viewX + e.clientX - drag.startX, y: drag.viewY + e.clientY - drag.startY }));
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    const over = nodeAt(e.clientX, e.clientY);
    if (drag.kind === 'link') {
      setDrag({ ...drag, px: w.x, py: w.y, overId: over !== drag.id ? over : null });
      return;
    }
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD_PX;
    const invalid = over === null || over === drag.id || descendantIds(mapRef.current.nodes, drag.id).has(over);
    setDrag({ ...drag, moved, px: w.x, py: w.y, overId: moved && !invalid ? over : null });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    containerRef.current?.releasePointerCapture(e.pointerId);
    const d = drag;
    setDrag(null);
    if (d === null || d.kind === 'pan') return;
    if (d.kind === 'link') {
      if (d.overId !== null) {
        const id = crypto.randomUUID();
        commit([{ op: 'link', id, sourceId: d.id, targetId: d.overId }]);
        setSelectedLinkId(id);
      }
      return;
    }
    if (!d.moved || d.overId === null) return;
    const node = byId.get(d.id);
    const target = byId.get(d.overId);
    if (node === undefined || target === undefined || node.parentId === null) return;
    const side: MapSide | undefined = target.parentId === null ? (d.px < 0 ? 'left' : 'right') : undefined;
    commit([{ op: 'move', id: node.id, parentId: target.id, ...(side !== undefined && { side }) }]);
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    userMovedView.current = true;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    if (e.ctrlKey || e.metaKey) {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY * 4)));
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => ({ zoom, x: mx - ((mx - v.x) / v.zoom) * zoom, y: my - ((my - v.y) / v.zoom) * zoom }));
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  }

  // Native non-passive wheel listener so ⌘/pinch-zoom doesn't zoom the page.
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

  // ── Map-level actions ──────────────────────────────────────────────────────

  async function renameMap(title: string): Promise<void> {
    const t = title.trim();
    if (t === '' || t === mapRef.current.title) return;
    setMap({ ...mapRef.current, title: t });
    await api.updateCanvas(canvasId, { title: t });
    void queryClient.invalidateQueries({ queryKey: ['canvases'] });
  }

  async function linkNote(noteId: string): Promise<void> {
    const r = await api.linkCanvasNote(canvasId, noteId);
    if (r.success) { setMap(r.data); void queryClient.invalidateQueries({ queryKey: ['canvases'] }); }
  }

  async function unlinkNote(noteId: string): Promise<void> {
    const r = await api.unlinkCanvasNote(canvasId, noteId);
    if (r.success) { setMap(r.data); void queryClient.invalidateQueries({ queryKey: ['canvases'] }); }
  }

  async function branchToNote(nodeId: string, noteId?: string): Promise<void> {
    await chain.current; // make sure every change is saved first
    const r = await api.canvasBranchToNote(canvasId, nodeId, noteId);
    if (!r.success) { setError(r.error.message); return; }
    onNoteChanged(r.data.noteId);
    void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    if (r.data.created) await reloadFromServer();
  }

  async function deleteMap(): Promise<void> {
    if (!window.confirm(`Delete the map “${map.title}”? This cannot be undone.`)) return;
    await api.deleteCanvas(canvasId);
    void queryClient.invalidateQueries({ queryKey: ['canvases'] });
    onDeleted();
  }

  function openRef(node: CanvasNodeApi): void {
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

  async function copyOutline(): Promise<void> {
    await navigator.clipboard.writeText(outlineMarkdown(map.title, map.nodes));
    setError(null);
    setCopied(true);
    window.setTimeout(() => { setCopied(false); }, 1500);
  }
  const [copied, setCopied] = useState(false);

  // ── Athena context ─────────────────────────────────────────────────────────

  const selected = selectedId !== null ? byId.get(selectedId) : undefined;
  const onMapRefs = useMemo(() => new Set(map.nodes.flatMap((n) => (n.refId !== null ? [n.refId] : []))), [map.nodes]);
  const selectedLabel = selected?.label ?? '';
  const athenaContext = useMemo<AthenaPageContext>(() => ({
    type: 'map',
    title: map.title,
    id: `map:${canvasId}`,
    detail: `Mind map with ${map.nodes.length.toString()} ideas.${selectedId !== null ? ` Selected idea: "${selectedLabel}".` : ''} The full outline is provided separately.`,
    ...(selectedId !== null && { selectedId }),
    ...(map.project !== null && { projectId: map.project }),
  }), [canvasId, map.title, map.nodes.length, map.project, selectedId, selectedLabel]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const hiddenCount = (id: string): number => descendantIds(map.nodes, id).size;
  const dragNodeId = drag?.kind === 'node' && drag.moved ? drag.id : null;

  const connectors = map.nodes.flatMap((n) => {
    if (n.parentId === null) return [];
    const c = placed.get(n.id);
    const p = placed.get(n.parentId);
    if (c === undefined || p === undefined) return [];
    const dir = c.x >= p.x ? 1 : -1;
    const x1 = p.x + (dir * p.w) / 2;
    const x2 = c.x - (dir * c.w) / 2;
    const mx = (x1 + x2) / 2;
    return [<path key={n.id} className={`mm-connector mm-connector--d${Math.min(c.depth, 3).toString()}`} d={`M${x1.toString()},${p.y.toString()} C${mx.toString()},${p.y.toString()} ${mx.toString()},${c.y.toString()} ${x2.toString()},${c.y.toString()}`} />];
  });

  const links = map.edges.flatMap((e) => {
    const a = placed.get(e.sourceId);
    const b = placed.get(e.targetId);
    if (a === undefined || b === undefined) return [];
    const mx = (a.x + b.x) / 2 - (b.y - a.y) * LINK_CURVE;
    const my = (a.y + b.y) / 2 + (b.x - a.x) * LINK_CURVE;
    const d = `M${a.x.toString()},${a.y.toString()} Q${mx.toString()},${my.toString()} ${b.x.toString()},${b.y.toString()}`;
    const lx = 0.25 * a.x + 0.5 * mx + 0.25 * b.x;
    const ly = 0.25 * a.y + 0.5 * my + 0.25 * b.y;
    return [{ edge: e, d, lx, ly }];
  });
  const selectedLink = links.find((l) => l.edge.id === selectedLinkId);

  return (
    <div className="mm-editor">
      <div className="mm-main">
        <MapHeader
          map={map}
          onRename={(t) => { void renameMap(t); }}
          onLinkNote={(id) => { void linkNote(id); }}
          onUnlinkNote={(id) => { void unlinkNote(id); }}
          onOpenNote={onOpenNote}
        />
        <div
          ref={containerRef}
          className={`mm-surface${drag?.kind === 'pan' ? ' mm-surface--panning' : ''}`}
          tabIndex={0}
          role="application"
          aria-label={`Mind map ${map.title}. Tab adds a sub-idea, Enter a sibling, F2 renames, Delete removes, arrows move around.`}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(SUGGESTION_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropTargetId(nodeAt(e.clientX, e.clientY));
          }}
          onDragLeave={() => { setDropTargetId(null); }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(SUGGESTION_DRAG_TYPE);
            setDropTargetId(null);
            if (raw === '') return;
            e.preventDefault();
            const target = nodeAt(e.clientX, e.clientY) ?? selectedId ?? root?.id;
            if (target !== undefined && target !== null) addFromSuggestion(JSON.parse(raw) as MapSuggestionApi, target);
          }}
        >
          <div className="mm-world" style={{ transform: `translate(${view.x.toString()}px, ${view.y.toString()}px) scale(${view.zoom.toString()})` }}>
            <svg className="mm-lines" width="1" height="1" aria-hidden="true">
              {connectors}
              {links.map((l) => (
                <g key={l.edge.id}>
                  <path className={`mm-link${l.edge.id === selectedLinkId ? ' mm-link--selected' : ''}`} d={l.d} />
                  <path
                    className="mm-link-hit mm-no-drag"
                    d={l.d}
                    onPointerDown={(ev) => { ev.stopPropagation(); setSelectedLinkId(l.edge.id); setSelectedId(null); containerRef.current?.focus(); }}
                  />
                </g>
              ))}
              {drag?.kind === 'link' && (() => {
                const a = placed.get(drag.id);
                return a !== undefined ? <path className="mm-link mm-link--draft" d={`M${a.x.toString()},${a.y.toString()} L${drag.px.toString()},${drag.py.toString()}`} /> : null;
              })()}
            </svg>

            {links.filter((l) => l.edge.label !== null && l.edge.id !== selectedLinkId).map((l) => (
              <span key={l.edge.id} className="mm-link-label" style={{ left: l.lx, top: l.ly }}>{l.edge.label}</span>
            ))}

            {map.nodes.map((n) => {
              const p = placed.get(n.id);
              if (p === undefined) return null;
              const isRoot = n.parentId === null;
              const kids = childrenOf(map.nodes, n.id).length;
              const RefIcon = n.refType !== null ? refIcon(n.refType) : null;
              const classes = [
                'mm-node',
                isRoot ? 'mm-node--root' : `mm-node--d${Math.min(p.depth, 3).toString()}`,
                n.refType !== null ? 'mm-node--ref' : '',
                n.id === selectedId ? 'mm-node--selected' : '',
                n.id === dragNodeId ? 'mm-node--dragging' : '',
                (drag?.kind !== 'pan' && drag !== null && drag.overId === n.id) || dropTargetId === n.id ? 'mm-node--drop' : '',
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={n.id}
                  ref={(el) => { if (el !== null) nodeEls.current.set(n.id, el); else nodeEls.current.delete(n.id); }}
                  data-node-id={n.id}
                  className={classes}
                  style={{ left: p.x - p.w / 2, top: p.y - p.h / 2 }}
                  onDoubleClick={() => { startEditing(n.id); }}
                  title={n.body ?? undefined}
                >
                  {RefIcon !== null && <RefIcon size={14} className="mm-node__icon" />}
                  {editingId === n.id ? (
                    <textarea
                      className="mm-node__input mm-no-drag"
                      autoFocus
                      rows={1}
                      value={draftLabel}
                      placeholder={isRoot ? 'Central idea' : 'New idea'}
                      onFocus={(e) => { const v = e.currentTarget.value; e.currentTarget.setSelectionRange(v.length, v.length); }}
                      onChange={(e) => { setDraftLabel(e.target.value); }}
                      onBlur={() => { finishEditing(true); }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Escape') { e.preventDefault(); finishEditing(false); return; }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const id = n.id;
                          finishEditing(true);
                          if (draftLabel.trim() !== '') addSibling(id);
                          return;
                        }
                        if (e.key === 'Tab') {
                          e.preventDefault();
                          const id = n.id;
                          finishEditing(true);
                          if (draftLabel.trim() !== '') addChild(id);
                        }
                      }}
                    />
                  ) : (
                    <span className="mm-node__label">{n.label !== null && n.label !== '' ? n.label : <em className="mm-node__empty">Untitled</em>}</span>
                  )}
                  {n.body !== null && n.body.trim() !== '' && editingId !== n.id && <span className="mm-node__has-note" aria-label="Has a note" />}
                  {kids > 0 && !isRoot && (
                    <button
                      type="button"
                      className={`mm-node__toggle mm-no-drag mm-node__toggle--${p.side ?? 'right'}`}
                      title={n.collapsed ? `Show ${hiddenCount(n.id).toString()} hidden ideas` : 'Collapse branch'}
                      aria-label={n.collapsed ? 'Expand branch' : 'Collapse branch'}
                      onClick={(ev) => { ev.stopPropagation(); commit([{ op: 'update', id: n.id, collapsed: !n.collapsed }]); }}
                    >
                      {n.collapsed ? hiddenCount(n.id) : (p.side === 'left' ? <CaretLeft size={12} /> : <CaretRight size={12} />)}
                    </button>
                  )}
                </div>
              );
            })}

            {dragNodeId !== null && drag?.kind === 'node' && (
              <div className="mm-ghost" style={{ left: drag.px + 12, top: drag.py + 12 }}>{byId.get(dragNodeId)?.label}</div>
            )}

            {selectedLink !== undefined && (
              <div className="mm-link-editor mm-no-drag" style={{ left: selectedLink.lx, top: selectedLink.ly }} onPointerDown={(e) => { e.stopPropagation(); }}>
                <LinkIcon size={14} />
                <input
                  key={selectedLink.edge.id}
                  className="mm-link-editor__input"
                  defaultValue={selectedLink.edge.label ?? ''}
                  placeholder="Label, e.g. supports"
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => {
                    const label = e.target.value;
                    if (label !== (selectedLink.edge.label ?? '')) commit([{ op: 'relabel_link', id: selectedLink.edge.id, label }]);
                    containerRef.current?.focus();
                  }}
                />
                <button type="button" className="mm-icon-btn" title="Remove link" aria-label="Remove link" onClick={() => { commit([{ op: 'unlink', id: selectedLink.edge.id }]); setSelectedLinkId(null); }}>
                  <Close size={14} />
                </button>
              </div>
            )}
          </div>

          <div className="mm-toolbar mm-no-drag" onPointerDown={(e) => { e.stopPropagation(); }}>
            <button type="button" className="mm-icon-btn" title="Add a sub-idea (Tab)" aria-label="Add a sub-idea" disabled={selectedId === null} onClick={() => { if (selectedId !== null) addChild(selectedId); }}><Add size={16} /></button>
            <span className="mm-toolbar__sep" />
            <button type="button" className="mm-icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => { zoomBy(1 / ZOOM_STEP); }}><ZoomOut size={16} /></button>
            <span className="mm-toolbar__zoom">{Math.round(view.zoom * 100)}%</span>
            <button type="button" className="mm-icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => { zoomBy(ZOOM_STEP); }}><ZoomIn size={16} /></button>
            <button type="button" className="mm-icon-btn" title="Fit the whole map" aria-label="Fit the whole map" onClick={fit}><FitToScreen size={16} /></button>
            <span className="mm-toolbar__sep" />
            <button type="button" className="mm-icon-btn" title="Undo (⌘Z)" aria-label="Undo" onClick={undo}><Undo size={16} /></button>
            <button type="button" className="mm-icon-btn" title="Copy as an outline (Markdown)" aria-label="Copy as outline" onClick={() => { void copyOutline(); }}><Copy size={16} /></button>
            {copied && <span className="mm-toolbar__note">Outline copied</span>}
          </div>

          <p className="mm-hint">Tab sub-idea · Enter sibling · F2 rename · Del remove · Space collapse · drag to move · Alt+drag to link</p>

          {error !== null && (
            <div className="mm-error mm-no-drag" role="alert" onPointerDown={(e) => { e.stopPropagation(); }}>
              {error}
              <button type="button" className="mm-icon-btn" aria-label="Dismiss" onClick={() => { setError(null); }}><Close size={14} /></button>
            </div>
          )}
        </div>
      </div>

      <SideTabsPanel
        storageKey="map-side"
        label="Map side panel"
        defaultTab="suggestions"
        width={MAP_SIDE_WIDTH}
        tabs={[
          {
            id: 'athena', label: 'Athena', dot: athenaBusy ? 'busy' : 'idle', keepMounted: true, fill: true,
            content: <ThinkAthenaPanel pageContext={athenaContext} onBusyChange={setAthenaBusy} />,
          },
          {
            id: 'suggestions', label: 'Suggestions',
            content: (
              <MapSuggestionsTab
                canvasId={canvasId}
                node={selected ?? root}
                parentLabel={(selected?.parentId != null ? byId.get(selected.parentId)?.label : null) ?? ''}
                onMap={onMapRefs}
                onAdd={(s) => { addFromSuggestion(s, selectedId ?? root?.id ?? ''); }}
              />
            ),
          },
          {
            id: 'details', label: 'Details',
            content: (
              <MapDetailsTab
                map={map}
                node={selected}
                onUpdate={(id, patch) => { commit([{ op: 'update', id, ...patch }]); }}
                onDelete={removeIdea}
                onOpenRef={openRef}
                onBranchToNote={branchToNote}
                onDeleteMap={() => { void deleteMap(); }}
              />
            ),
          },
        ]}
      />
    </div>
  );
};

// ── Header: title + linked notes ──────────────────────────────────────────────

interface HeaderProps {
  map: CanvasFullApi;
  onRename: (title: string) => void;
  onLinkNote: (noteId: string) => void;
  onUnlinkNote: (noteId: string) => void;
  onOpenNote: (noteId: string) => void;
}

const MapHeader: React.FC<HeaderProps> = ({ map, onRename, onLinkNote, onUnlinkNote, onOpenNote }) => {
  const [title, setTitle] = useState(map.title);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => { setTitle(map.title); }, [map.title]);
  const { data: notes = [] } = useQuery<NoteListItem[]>({ queryKey: ['notes-list'], queryFn: fetchNotes, staleTime: 30_000, enabled: picking });
  const linked = new Set(map.linkedNotes.map((n) => n.id));
  const q = query.trim().toLowerCase();
  const matches = notes.filter((n) => !linked.has(n.id) && (q === '' || n.title.toLowerCase().includes(q))).slice(0, 12);

  return (
    <div className="mm-header">
      <input
        className="mm-header__title"
        value={title}
        aria-label="Map title"
        onChange={(e) => { setTitle(e.target.value); }}
        onBlur={() => { onRename(title); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <div className="mm-header__notes">
        {map.linkedNotes.map((n) => (
          <span key={n.id} className="mm-chip">
            <button type="button" className="mm-chip__open" title="Open note" onClick={() => { onOpenNote(n.id); }}>{n.title}</button>
            <button type="button" className="mm-chip__remove" title="Unlink note" aria-label={`Unlink ${n.title}`} onClick={() => { onUnlinkNote(n.id); }}><Close size={12} /></button>
          </span>
        ))}
        <div className="mm-picker-anchor">
          <button type="button" className="mm-chip mm-chip--add" onClick={() => { setPicking((v) => !v); setQuery(''); }}>
            <Add size={12} /> Link note
          </button>
          {picking && (
            <div className="mm-picker" role="dialog" aria-label="Link a note">
              <input className="mm-picker__search" autoFocus placeholder="Search notes…" value={query}
                onChange={(e) => { setQuery(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Escape') setPicking(false); }} />
              <ul className="mm-picker__list">
                {matches.map((n) => (
                  <li key={n.id}>
                    <button type="button" className="mm-picker__item" onClick={() => { onLinkNote(n.id); setPicking(false); }}>{n.title}</button>
                  </li>
                ))}
                {matches.length === 0 && <li className="mm-picker__empty">No matching notes</li>}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

