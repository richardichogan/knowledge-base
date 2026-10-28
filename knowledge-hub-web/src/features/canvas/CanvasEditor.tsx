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
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { ZoomIn, ZoomOut, FitToScreen, Undo, Redo, Copy, Close, Add, TrashCan, ChartNetwork, Pin, Rocket, Subtract, Download, InProgress, Grid, ChevronDown } from '@carbon/icons-react';
import { UseCaseLauncher } from '../useCases/UseCaseLauncher';
import { api } from '../../services/api';
import { confirmDialog } from '../../services/appDialogs';
import type { BrainstormSettings, CanvasFullApi, CanvasNodeApi, MapOp, MapSuggestionApi } from '../../services/api';
import { fetchNotes } from '../../notes/noteStorage';
import type { NoteListItem } from '../../notes/types';
import { SideTabsPanel } from '../../components/SideTabsPanel';
import { CANVAS_SIDE_WIDTH, IconBtn, Segmented } from '../diagram/DiagramControls';
import { download, exportFileName } from '../diagram/diagramExport';
import { snapMovingBounds, type AlignmentGuide, type SpacingIndicator } from '../diagram/diagramAlignment';
import { diagramMural } from '../diagram/diagramMural';
import { MURAL_QUERY, loadMuralStatus } from '../../components/MuralIntegration';
import { MuralExportDestination } from '../../components/MuralExportDestination';
import { SettingsLink } from '../../navigation/SettingsLink';
import { canvasExportBlob, canvasDiagramDocument } from './canvasExport';
import '../diagram/diagram.scss';
import { ThinkAthenaPanel } from '../../notes/ThinkAthenaPanel';
import type { AthenaPageContext } from '../../context/AthenaContext';
import {
  applyOps, inverseOps, positionNewCards, branchSide, initialPositions, twoSidedLayout, cardTree, hiddenCards, descendants, elbowPath, estimateSize, connectedIds, canvasMarkdown,
  LINK_TYPES, linkStyle, DEFAULT_LINK_TYPE, type GraphState, type Point, type Size,
} from './canvasGraph';
import { readCanvasItem, readPlainText } from './canvasClipboard';
import { CanvasPreviewTab, CanvasSuggestionsTab, CanvasDetailsTab } from './CanvasSidePanel';
import { KIND_LABEL, SUGGESTION_DRAG_TYPE, cardIcon, cardKindLabel, ideaCardType, hasFootnote } from './mapVisuals';
import { setActiveCanvas } from './activeCanvas';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;
const FIT_PADDING = 100;
const NOTES_GAP = 48;
const NOTES_MIN_WIDTH = 320;
const DRAG_THRESHOLD_PX = 5;
const WHEEL_ZOOM_SENSITIVITY = 0.006;
const UNDO_LIMIT = 100;
const MAX_PASTE_LINES = 30;
const ARROW_SIZE = 8;
const PRESET_TYPES = Object.keys(LINK_TYPES);
const MARKER_COLOURS = [...new Set([...Object.values(LINK_TYPES).map((s) => s.sheet), linkStyle('custom').sheet])];

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
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const [spacing, setSpacing] = useState<SpacingIndicator[]>([]);
  const [snapOpen, setSnapOpen] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map());
  const [athenaBusy, setAthenaBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'png' | 'svg' | 'mural'>('png');
  const [exportBg, setExportBg] = useState<'white' | 'transparent'>('white');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [muralBoardUrl, setMuralBoardUrl] = useState<string | null>(null);
  const [muralResult, setMuralResult] = useState('');
  const muralQuery = useQuery({ queryKey: MURAL_QUERY, queryFn: loadMuralStatus, enabled: exportOpen, staleTime: 0 });
  const [tabRequest, setTabRequest] = useState<{ id: string; seq: number } | undefined>(openTab !== undefined ? { id: openTab, seq: 1 } : undefined);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const undoStack = useRef<MapOp[][]>([]);
  const redoStack = useRef<MapOp[][]>([]);
  const newIdeaId = useRef<string | null>(null);
  /** Set while the card being named is dragged, so the drag doesn't end naming (which discards an unnamed new idea). */
  const draggingEdited = useRef(false);
  const pending = useRef(0);
  const needsReload = useRef(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const fitted = useRef(false);
  const userMovedView = useRef(false);

  const syncHistory = useCallback((): void => {
    setHistory({ canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 });
  }, []);
  const requestTab = (id: string): void => { setTabRequest((t) => ({ id, seq: (t?.seq ?? 0) + 1 })); };
  const sizeOf = useCallback((n: CanvasNodeApi): Size => sizes.get(n.id) ?? estimateSize(n), [sizes]);

  // ── Saving ─────────────────────────────────────────────────────────────────

  const reloadFromServer = useCallback(async (): Promise<void> => {
    const r = await api.getCanvas(canvasId);
    if (r.success) setMap(r.data);
    else setError(`Couldn’t reload the canvas (${r.error.message}).`);
  }, [canvasId, setMap]);

  const withPositions = useCallback((ops: MapOp[]): MapOp[] => {
    return positionNewCards(mapRef.current, ops, canvasId, selectedId, sizes);
  }, [canvasId, selectedId, sizes]);

  /** Applies changes on screen now and saves them in order. */
  const commit = useCallback((rawOps: MapOp[], opts: { undoable?: boolean; history?: 'undo' | 'redo' } = {}): void => {
    if (rawOps.length === 0) return;
    const ops = withPositions(rawOps);
    const before = mapRef.current;
    const state: GraphState = { nodes: before.nodes, edges: before.edges };
    if (opts.history !== undefined) {
      // Undoing makes the change redoable; redoing makes it undoable again.
      const stack = opts.history === 'undo' ? redoStack : undoStack;
      stack.current.push(inverseOps(state, ops, canvasId));
      if (stack.current.length > UNDO_LIMIT) stack.current.shift();
      syncHistory();
    } else if (opts.undoable !== false) {
      undoStack.current.push(inverseOps(state, ops, canvasId));
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      syncHistory();
    }
    setMap({ ...before, ...applyOps(state, ops, canvasId) });
    pending.current++;
    chain.current = chain.current
      .then(async () => {
        const r = await api.applyCanvasOps(canvasId, ops);
        if (!r.success) throw new Error(r.error.message);
        pending.current--;
        if (pending.current === 0) {
          needsReload.current = false;
          setMap(r.data);
          void queryClient.invalidateQueries({ queryKey: ['canvases'] });
        }
      })
      .catch((err: unknown) => {
        pending.current--;
        needsReload.current = true;
        undoStack.current = [];
        redoStack.current = [];
        syncHistory();
        setError(`Couldn’t save that change (${err instanceof Error ? err.message : 'error'}) — the canvas was reloaded.`);
        if (pending.current === 0) { needsReload.current = false; void reloadFromServer(); }
      });
  }, [canvasId, queryClient, reloadFromServer, setMap, withPositions, syncHistory]);

  const changeSettings = (patch: Partial<BrainstormSettings>): void => {
    const settings = { ...mapRef.current.brainstormSettings, ...patch };
    setMap({ ...mapRef.current, brainstormSettings: settings });
    pending.current++;
    chain.current = chain.current.then(async () => {
      const r = await api.updateCanvas(canvasId, { brainstormSettings: settings });
      if (!r.success) throw new Error(r.error.message);
      pending.current--;
      if (pending.current === 0 && needsReload.current) { needsReload.current = false; void reloadFromServer(); }
    }).catch((err: unknown) => {
      pending.current--;
      needsReload.current = true;
      setError(`Couldn’t save snapping settings (${err instanceof Error ? err.message : 'error'}) — the canvas was reloaded.`);
      if (pending.current === 0) { needsReload.current = false; void reloadFromServer(); }
    });
  };

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
    if (inv !== undefined) commit(inv, { history: 'undo' });
  }, [commit]);
  const redo = useCallback((): void => {
    const again = redoStack.current.pop();
    if (again !== undefined) commit(again, { history: 'redo' });
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
  const rootId = map.nodes[0]?.id;
  const tree = useMemo(() => (rootId !== undefined ? cardTree(map.nodes, map.edges, rootId) : null), [map.nodes, map.edges, rootId]);
  const hidden = useMemo(() => (tree !== null ? hiddenCards(map.nodes, tree) : new Set<string>()), [map.nodes, tree]);
  /** Footnote numbers, in card order. */
  const footnoteNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    for (const n of map.nodes) if (hasFootnote(n)) numbers.set(n.id, numbers.size + 1);
    return numbers;
  }, [map.nodes]);
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
      if (hidden.has(n.id)) continue;
      const s = sizeOf(n);
      minX = Math.min(minX, n.x - s.w / 2); maxX = Math.max(maxX, n.x + s.w / 2);
      minY = Math.min(minY, n.y - s.h / 2); maxY = Math.max(maxY, n.y + s.h / 2);
    }
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (el.clientWidth - FIT_PADDING) / (maxX - minX), (el.clientHeight - FIT_PADDING) / (maxY - minY)));
    setView({ zoom, x: el.clientWidth / 2 - ((minX + maxX) / 2) * zoom, y: el.clientHeight / 2 - ((minY + maxY) / 2) * zoom });
  }, [map.nodes, sizeOf, hidden]);

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
      syncHistory();
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

  async function tidy(): Promise<void> {
    if (!await confirmDialog('Tidy as a two-sided tree? Every card except the first is rearranged around it: typed connections on the left, related cards on the right (⌘Z undoes it).', { title: 'Tidy canvas', confirmLabel: 'Tidy' })) return;
    const nodes = mapRef.current.nodes;
    const root = nodes[0];
    if (root === undefined) return;
    const next = twoSidedLayout(nodes, mapRef.current.edges, root.id, { x: root.x, y: root.y }, sizeOf);
    commit(nodes.slice(1).map((n) => {
      const p = next.get(n.id) ?? { x: 0, y: 0 };
      return { op: 'position' as const, id: n.id, x: Math.round(p.x), y: Math.round(p.y) };
    }));
    window.setTimeout(() => { fitRef.current(); }, 50);
  }

  function toggleCollapse(id: string): void {
    const n = byId.get(id);
    if (n === undefined) return;
    if (!n.collapsed && tree !== null && selectedId !== null && descendants(tree, id).includes(selectedId)) setSelectedId(id);
    commit([{ op: 'update', id, collapsed: !n.collapsed }]);
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
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
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
    const grabbingEdited = cardEl !== null && cardEl.dataset['cardId'] === editingId;
    if (grabbingEdited) { draggingEdited.current = true; e.preventDefault(); } else containerRef.current?.focus();
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
    if (!moved) return;
    const node = byId.get(drag.id);
    if (node === undefined) return;
    const size = sizeOf(node);
    const raw = { x: (e.clientX - drag.startX) / view.zoom, y: (e.clientY - drag.startY) / view.zoom };
    const settings = mapRef.current.brainstormSettings;
    const result = snapMovingBounds(
      { x: drag.from.x - size.w / 2, y: drag.from.y - size.h / 2, width: size.w, height: size.h },
      map.nodes.filter(n => n.id !== drag.id && !hidden.has(n.id)).map(n => {
        const s = sizeOf(n);
        return { x: n.x - s.w / 2, y: n.y - s.h / 2, width: s.w, height: s.h };
      }),
      raw, { zoom: view.zoom, gridSize: settings.snapToGrid && !e.altKey ? settings.gridSize : null, shapeSnapping: settings.snapToShapes && !e.altKey },
    );
    setGuides(e.altKey ? [] : result.guides);
    setSpacing(e.altKey ? [] : result.indicators);
    setDrag({ ...drag, moved, at: { x: drag.from.x + result.delta.x, y: drag.from.y + result.delta.y } });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    containerRef.current?.releasePointerCapture(e.pointerId);
    const d = drag;
    setDrag(null);
    setGuides([]);
    setSpacing([]);
    if (d === null || d.kind === 'pan') return;
    if (d.kind === 'link') { if (d.overId !== null) connect(d.id, d.overId); return; }
    const edited = draggingEdited.current && d.id === editingId;
    draggingEdited.current = false;
    // A new idea's move is undone with it, so it isn't a separate undo step.
    if (d.moved) commit([{ op: 'position', id: d.id, x: Math.round(d.at.x), y: Math.round(d.at.y) }], { undoable: !(edited && newIdeaId.current === d.id) });
    if (edited) cardEls.current.get(d.id)?.querySelector('textarea')?.focus();
    else if (!d.moved) requestTab('properties');
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
    if (!await confirmDialog(`Move the canvas “${map.title}” to the recycle bin? Its cards, connections and linked notes will remain available for restoration.`, {
      title: 'Move canvas to recycle bin', confirmLabel: 'Move to recycle bin', tone: 'danger',
    })) return;
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

  async function runExport(destination?: string): Promise<void> {
    if (exporting) return;
    setExportError('');
    setMuralResult('');
    setExporting(true);
    try {
      if (exportFormat === 'mural') {
        const payload = await diagramMural(canvasDiagramDocument(mapRef.current, sizeOf), new Map(), {
          boardUrl: destination ?? muralBoardUrl ?? muralQuery.data?.boardUrl ?? '', title: mapRef.current.title.slice(0, 300), footnotes: false, legend: false,
        });
        const response = await api.exportMuralDiagram(payload);
        if (!response.success) throw new Error(response.error.message);
        setMuralResult(response.data.boardUrl);
      } else {
        const blob = await canvasExportBlob(mapRef.current, sizeOf, exportFormat, exportBg);
        download(blob, exportFileName(mapRef.current.title, exportFormat));
        setExportOpen(false);
      }
    } catch (err) {
      setExportError(`Export failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setExporting(false);
    }
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
    if (hidden.has(e.sourceId) || hidden.has(e.targetId)) return [];
    const a = byId.get(e.sourceId);
    const b = byId.get(e.targetId);
    if (a === undefined || b === undefined) return [];
    const style = linkStyle(e.type);
    const { d, mid } = elbowPath(posOf(a), sizeOf(a), posOf(b), sizeOf(b), style.directed ? ARROW_SIZE : 0);
    return [{ edge: e, d, mid, style }];
  });
  const selectedLink = links.find((l) => l.edge.id === selectedLinkId);
  const draftFrom = drag?.kind === 'link' ? byId.get(drag.id) : undefined;

  return (
    <div className="mm-editor">
      <div className="mm-main">
        <CanvasHeader map={map} onDelete={() => { void deleteCanvas(); }} onRename={(t) => { void renameCanvas(t); }}
          onPin={(id) => { void pinNote(id); }} onUnpin={(id) => { void unpinNote(id); }} onOpenNote={onOpenNote}
          tools={(
            <div className="dg-header__actions kh-command-row" role="toolbar" aria-label="Brainstorm tools">
              <div className="dg-header__group kh-command-row">
                <IconBtn label="Undo (⌘Z)" disabled={!history.canUndo} onClick={undo}><Undo size={16} /></IconBtn>
                <IconBtn label="Redo (⇧⌘Z)" disabled={!history.canRedo} onClick={redo}><Redo size={16} /></IconBtn>
              </div>
              <div className="dg-header__group kh-command-row">
                <IconBtn label="Add an idea (Tab), connected to the selected card" onClick={() => { addIdea(selectedId); }}><Add size={16} /></IconBtn>
              </div>
              <div className="dg-header__group kh-command-row">
                <IconBtn label={map.brainstormSettings.grid ? 'Hide grid' : 'Show grid'} pressed={map.brainstormSettings.grid}
                  onClick={() => { changeSettings({ grid: !mapRef.current.brainstormSettings.grid }); }}><Grid size={16} /></IconBtn>
                <div className="dg-anchor">
                  <button type="button" className="dg-text-btn dg-snap-toggle" aria-label="Snapping options" aria-haspopup="dialog"
                    aria-expanded={snapOpen} title="Hold Alt while dragging to bypass snapping and guides."
                    onClick={() => { setSnapOpen(v => !v); }}>Snap <ChevronDown size={12} /></button>
                  {snapOpen && <div className="dg-popover" role="dialog" aria-label="Snapping options"
                    onKeyDown={event => { if (event.key === 'Escape') setSnapOpen(false); }}>
                    <label className="dg-check">
                      <input className="dg-check__input" type="checkbox" checked={map.brainstormSettings.snapToGrid}
                        onChange={event => { changeSettings({ snapToGrid: event.target.checked }); }} />
                      <span className="dg-check__label">Grid snap</span>
                    </label>
                    <label className="dg-check">
                      <input className="dg-check__input" type="checkbox" checked={map.brainstormSettings.snapToShapes}
                        onChange={event => { changeSettings({ snapToShapes: event.target.checked }); }} />
                      <span className="dg-check__label">Shape and equal-spacing snap</span>
                    </label>
                    <p className="dg-popover__hint">Grid visibility is separate. Hold Alt while dragging to move freely without guides.</p>
                  </div>}
                </div>
                <select className="dg-grid-size" aria-label="Grid spacing" value={map.brainstormSettings.gridSize}
                  onChange={event => {
                    const value = Number(event.target.value);
                    if (value === 5 || value === 10 || value === 20 || value === 40) changeSettings({ gridSize: value });
                  }}>
                  {[5, 10, 20, 40].map(value => <option key={value} value={value}>{value} units</option>)}
                </select>
              </div>
              <div className="dg-header__group kh-command-row">
                <IconBtn label="Zoom out" onClick={() => { zoomBy(1 / ZOOM_STEP); }}><ZoomOut size={16} /></IconBtn>
                <span className="mm-zoom-readout" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
                <IconBtn label="Zoom in" onClick={() => { zoomBy(ZOOM_STEP); }}><ZoomIn size={16} /></IconBtn>
                <IconBtn label="Fit the whole brainstorm" onClick={() => { userMovedView.current = false; fit(); }}><FitToScreen size={16} /></IconBtn>
              </div>
              <div className="dg-header__group kh-command-row">
                <IconBtn label="Tidy the layout" onClick={tidy}><ChartNetwork size={16} /></IconBtn>
                <IconBtn label={copied ? 'Copied as Markdown' : 'Copy as Markdown'} pressed={copied} onClick={() => { void copyMarkdown(); }}><Copy size={16} /></IconBtn>
              </div>
            </div>
          )}
          exportControl={(
            <div className="dg-anchor">
              <button type="button" className={`dg-text-btn${exportOpen ? ' dg-text-btn--active' : ''}`} aria-expanded={exportOpen} aria-haspopup="dialog"
                onClick={() => { setExportOpen((v) => !v); setExportError(''); setMuralResult(''); }}>
                <Download size={16} /> Export
              </button>
              {exportOpen && createPortal(
                <div className="dg-popover dg-popover--end dg-export" role="dialog" aria-label="Export brainstorm"
                  onKeyDown={(e) => { if (e.key === 'Escape') setExportOpen(false); }}>
                  <div className="dg-export__header">
                    <h2 className="dg-export__title">Export brainstorm</h2>
                    <IconBtn label="Close export" onClick={() => { setExportOpen(false); }}><Close size={16} /></IconBtn>
                  </div>
                  <div className="dg-export__body">
                    <section className="dg-popover__section">
                      <h3 className="dg-popover__heading">Format</h3>
                      <Segmented label="Export format" value={exportFormat} onChange={(v) => { setExportFormat(v); setExportError(''); setMuralResult(''); }}
                        options={[{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' }, { value: 'mural', label: 'Mural' }]} />
                      {exportFormat !== 'mural' && <p className="dg-popover__hint">Exports what is shown: cards inside a collapsed branch are left out, and footnotes are listed under Notes.</p>}
                      {exportFormat === 'mural' && (
                        <div className="mural-integration">
                          <p className="dg-export__description">Continue in Mural with the cards as editable shapes and the connections as connectors.</p>
                          <p className="dg-popover__hint">Cards inside a collapsed branch and footnotes are not sent. Each export adds a new copy, not a synced brainstorm.</p>
                          {muralQuery.isPending && <p className="dg-popover__hint" role="status">Checking Mural connection...</p>}
                          {muralQuery.isError && <p className="connection-tokens__error" role="alert">Could not check Mural. <button type="button" className="dg-text-btn" onClick={() => { void muralQuery.refetch(); }}>Retry</button></p>}
                          {muralQuery.data !== undefined && !muralQuery.data.connected && <p className="dg-popover__hint"><SettingsLink to="/my-work?sync=1">Set up or reconnect Mural in Connections and sync</SettingsLink></p>}
                          {muralQuery.data?.connected === true && (
                            <MuralExportDestination value={muralBoardUrl ?? muralQuery.data.boardUrl} title={map.title}
                              disabled={exporting || map.nodes.length === 0}
                              onChange={(url) => { setMuralBoardUrl(url); setMuralResult(''); }}
                              onCreated={(url) => runExport(url)} />
                          )}
                          {muralResult !== '' && <p className="dg-popover__hint mural-integration__result" role="status">Brainstorm exported. <a href={muralResult} target="_blank" rel="noreferrer">Open board in Mural</a></p>}
                        </div>
                      )}
                    </section>
                    {exportFormat !== 'mural' && (
                      <section className="dg-popover__section">
                        <h3 className="dg-popover__heading">Background</h3>
                        <Segmented label="Export background" value={exportBg} onChange={setExportBg} options={[{ value: 'white', label: 'White' }, { value: 'transparent', label: 'Transparent' }]} />
                      </section>
                    )}
                  </div>
                  <div className="dg-export__actions">
                    {exportError !== '' && <p className="connection-tokens__error" role="alert">{exportError}</p>}
                    <button type="button" className="dg-primary-btn"
                      disabled={exporting || map.nodes.length === 0 || (exportFormat === 'mural' && (muralQuery.data?.connected !== true || (muralBoardUrl ?? muralQuery.data.boardUrl).trim() === ''))}
                      onClick={() => { void runExport(); }}>
                      {exporting ? <><InProgress size={16} className="dg-spin" /> Exporting…</> : <><Download size={16} /> {exportFormat === 'mural' ? 'Send to Mural' : `Export ${exportFormat.toUpperCase()}`}</>}
                    </button>
                    {map.nodes.length === 0 && <p className="dg-popover__hint">Add a card to export the brainstorm.</p>}
                  </div>
                </div>, document.body,
              )}
            </div>
          )} />
        <div
          ref={containerRef}
          className={`mm-surface${drag?.kind === 'pan' ? ' mm-surface--panning' : ''}`}
          style={{
            backgroundImage: map.brainstormSettings.grid ? undefined : 'none',
            backgroundSize: `${map.brainstormSettings.gridSize * view.zoom}px ${map.brainstormSettings.gridSize * view.zoom}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          tabIndex={0}
          role="application"
          aria-label={`Canvas ${map.title}. Tab adds an idea connected to the selected card; drag from a card's edge dot to connect; Delete removes.`}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { setDrag(null); setGuides([]); setSpacing([]); draggingEdited.current = false; }}
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
                  <path
                    className={`cv-link${l.edge.type === DEFAULT_LINK_TYPE ? ' cv-link--untyped' : ''}${l.edge.id === selectedLinkId ? ' cv-link--selected' : ''}`}
                    d={l.d}
                    stroke={l.style.sheet}
                    strokeDasharray={l.style.dashed ? '6 5' : undefined}
                    markerEnd={l.style.directed ? `url(#${markerId(l.style.sheet)})` : undefined}
                  />
                  <path
                    className="mm-link-hit mm-no-drag"
                    d={l.d}
                    onPointerDown={(ev) => { ev.stopPropagation(); setSelectedLinkId(l.edge.id); containerRef.current?.focus(); }}
                  />
                </g>
              ))}
              {drag?.kind === 'link' && draftFrom !== undefined && (
                <line className="cv-link cv-link--draft" x1={draftFrom.x} y1={draftFrom.y} x2={drag.at.x} y2={drag.at.y} />
              )}
              <g className="dg-drawing-guides" aria-hidden="true">
                {guides.map(guide => <line key={`${guide.axis}:${guide.value}`}
                  className={`dg-alignment-guide dg-alignment-guide--${guide.kind}`}
                  x1={guide.axis === 'x' ? guide.value : -view.x / view.zoom}
                  x2={guide.axis === 'x' ? guide.value : ((containerRef.current?.clientWidth ?? 0) - view.x) / view.zoom}
                  y1={guide.axis === 'y' ? guide.value : -view.y / view.zoom}
                  y2={guide.axis === 'y' ? guide.value : ((containerRef.current?.clientHeight ?? 0) - view.y) / view.zoom} />)}
                {spacing.filter(indicator => indicator.gap > 0.5).map((indicator, index) => {
                  const { axis, start, end, position } = indicator;
                  const horizontal = axis === 'x';
                  const x1 = horizontal ? start : position; const y1 = horizontal ? position : start;
                  const x2 = horizontal ? end : position; const y2 = horizontal ? position : end;
                  const cap = 4 / view.zoom;
                  const label = `${indicator.equal ? '= ' : ''}${Math.round(indicator.gap * 10) / 10}`;
                  const labelWidth = label.length * 7 + 10;
                  return <g key={`${axis}:${index}`} className={`dg-spacing${indicator.equal ? ' dg-spacing--equal' : ''}`}>
                    {indicator.startCross !== undefined && <line className="dg-spacing__witness"
                      x1={horizontal ? start : indicator.startCross} y1={horizontal ? indicator.startCross : start} x2={x1} y2={y1} />}
                    {indicator.endCross !== undefined && <line className="dg-spacing__witness"
                      x1={horizontal ? end : indicator.endCross} y1={horizontal ? indicator.endCross : end} x2={x2} y2={y2} />}
                    <line x1={x1} y1={y1} x2={x2} y2={y2} />
                    <line x1={x1 - (horizontal ? 0 : cap)} x2={x1 + (horizontal ? 0 : cap)}
                      y1={y1 - (horizontal ? cap : 0)} y2={y1 + (horizontal ? cap : 0)} />
                    <line x1={x2 - (horizontal ? 0 : cap)} x2={x2 + (horizontal ? 0 : cap)}
                      y1={y2 - (horizontal ? cap : 0)} y2={y2 + (horizontal ? cap : 0)} />
                    <g transform={`translate(${(x1 + x2) / 2} ${(y1 + y2) / 2}) scale(${1 / view.zoom})`}>
                      <rect x={-labelWidth / 2} y={-9} width={labelWidth} height={18} rx={2} />
                      <text textAnchor="middle" dominantBaseline="central">{label}</text>
                    </g>
                  </g>;
                })}
              </g>
            </svg>

            {links.filter((l) => l.edge.id !== selectedLinkId && (l.edge.type !== DEFAULT_LINK_TYPE || l.edge.label !== null)).map((l) => (
              <span key={l.edge.id} className="cv-link-label" style={{ left: l.mid.x, top: l.mid.y, color: l.style.sheet }}>
                {l.edge.type !== DEFAULT_LINK_TYPE ? l.edge.type : ''}{l.edge.type !== DEFAULT_LINK_TYPE && l.edge.label !== null ? ' · ' : ''}{l.edge.label}
              </span>
            ))}

            {map.nodes.map((n) => {
              if (hidden.has(n.id)) return null;
              const p = posOf(n);
              const s = sizeOf(n);
              const isIdea = n.refType === null;
              const isRoot = n.id === map.nodes[0]?.id;
              const Icon = cardIcon(n, isRoot);
              const type = ideaCardType(n, isRoot);
              const footnote = footnoteNumbers.get(n.id);
              const below = !isRoot && tree !== null ? descendants(tree, n.id).length : 0;
              const root = rootId === undefined ? undefined : byId.get(rootId);
              const outerSide = root !== undefined && tree !== null && branchSide(n, root, tree, byId) === -1 ? 'left' : 'right';
              const pinned = n.refType === 'note' && n.refId !== null && pinnedNoteIds.has(n.refId);
              const classes = [
                'cv-card', isIdea ? 'cv-card--idea' : 'cv-card--content', `cv-card--${n.refType ?? 'idea'}`, isRoot ? 'cv-card--root' : '', pinned ? 'cv-card--pinned' : '',
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
                  style={{
                    left: p.x - s.w / 2, top: p.y - s.h / 2,
                    ...(type !== null && { '--cv-tint': type.tint, '--cv-icon': type.colour, '--cv-ink': type.ink } as React.CSSProperties),
                  }}
                  onDoubleClick={() => { if (isIdea) startEditing(n.id); else requestTab('preview'); }}
                >
                  {!isRoot && <span className="cv-card__tile" aria-hidden="true"><Icon size={16} /></span>}
                  <div className="cv-card__body">
                    <div className="cv-card__kind">
                      {isRoot && <Icon size={14} />}
                      <span>{cardKindLabel(n, isRoot)}</span>
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
                        onBlur={() => { if (!draggingEdited.current) finishEditing(true); }}
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
                  </div>
                  <span className="cv-card__handle mm-handle" data-handle title="Drag to another card to connect" />
                  {footnote !== undefined && (
                    <button type="button" className="cv-card__footnote mm-no-drag" title={`Footnote ${footnote.toString()}`} aria-label={`Show footnote ${footnote.toString()}`}
                      onPointerDown={(ev) => { ev.stopPropagation(); }}
                      onClick={(ev) => { ev.stopPropagation(); setSelectedId(n.id); requestTab('properties'); }}>
                      {footnote}
                    </button>
                  )}
                  {below > 0 && (
                    <button type="button" className={`cv-card__collapse cv-card__collapse--${outerSide}${n.collapsed ? ' cv-card__collapse--collapsed' : ''} mm-no-drag`}
                      title={n.collapsed ? `Expand: show ${below.toString()} hidden card${below === 1 ? '' : 's'}` : 'Collapse the cards below this one'}
                      aria-label={n.collapsed ? `Expand ${below.toString()} hidden card${below === 1 ? '' : 's'}` : 'Collapse the cards below this one'}
                      aria-expanded={!n.collapsed}
                      onPointerDown={(ev) => { ev.stopPropagation(); }}
                      onClick={(ev) => { ev.stopPropagation(); toggleCollapse(n.id); }}>
                      {n.collapsed ? below : <Subtract size={12} />}
                    </button>
                  )}
                </div>
              );
            })}

            {footnoteNumbers.size > 0 && (() => {
              const visible = map.nodes.filter((n) => !hidden.has(n.id));
              const left = Math.min(...visible.map((n) => n.x - sizeOf(n).w / 2));
              const right = Math.max(...visible.map((n) => n.x + sizeOf(n).w / 2));
              const bottom = Math.max(...visible.map((n) => n.y + sizeOf(n).h / 2));
              return (
                <section className="cv-notes" aria-label="Footnotes" style={{ left, top: bottom + NOTES_GAP, width: Math.max(right - left, NOTES_MIN_WIDTH) }}>
                  <h3 className="cv-notes__heading">Notes</h3>
                  <ol className="cv-notes__list">
                    {map.nodes.filter(hasFootnote).map((n) => (
                      <li key={n.id}>
                        <button type="button" className="cv-notes__item mm-no-drag" onPointerDown={(ev) => { ev.stopPropagation(); }}
                          onClick={() => { setSelectedId(n.id); requestTab('properties'); }}>
                          <span className="cv-notes__marker">{footnoteNumbers.get(n.id)}</span>
                          <span className="cv-notes__text"><strong>{n.label !== null && n.label !== '' ? n.label : 'Untitled'}:</strong> {n.footnote}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })()}

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

          <p className="mm-hint">Drag cards to arrange · drag from a card’s edge dot to connect · click a connection to type it · Tab adds an idea · Del removes · ⌘Z undo · ⇧⌘Z redo</p>

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
        width={CANVAS_SIDE_WIDTH}
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
            id: 'properties', label: 'Properties',
            content: (
              <CanvasDetailsTab
                map={map}
                node={selected}
                isRoot={selected !== undefined && selected.id === map.nodes[0]?.id}
                footnoteNumber={selected !== undefined ? footnoteNumbers.get(selected.id) : undefined}
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
  tools: React.ReactNode;
  exportControl: React.ReactNode;
}

const CanvasHeader: React.FC<HeaderProps> = ({ map, onDelete, onRename, onPin, onUnpin, onOpenNote, tools, exportControl }) => {
  const [title, setTitle] = useState(map.title);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [useCaseOpen, setUseCaseOpen] = useState(false);
  useEffect(() => { setTitle(map.title); }, [map.title]);
  const { data: notes = [] } = useQuery<NoteListItem[]>({ queryKey: ['notes-list'], queryFn: fetchNotes, staleTime: 30_000, enabled: picking });
  const pinned = new Set(map.linkedNotes.map((n) => n.id));
  const q = query.trim().toLowerCase();
  const matches = notes.filter((n) => !pinned.has(n.id) && (q === '' || n.title.toLowerCase().includes(q))).slice(0, 12);

  return (
    <div className="dg-header mm-header">
      <div className="dg-header__row">
        <div className="dg-header__main">
          <input className="dg-header__title" value={title} aria-label="Canvas title"
            onChange={(e) => { setTitle(e.target.value); }}
            onBlur={() => { onRename(title); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </div>
        <div className="dg-header__toolbar">
          {tools}
          <div className="dg-header__panels">
            {exportControl}
            <IconBtn label="Make a use case from this canvas" onClick={() => { setUseCaseOpen(true); }}><Rocket size={16} /></IconBtn>
            <IconBtn label="Delete canvas" danger onClick={onDelete}><TrashCan size={16} /></IconBtn>
          </div>
        </div>
      </div>
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
      {useCaseOpen && (
        <UseCaseLauncher onClose={() => { setUseCaseOpen(false); }} launch={{
          title: map.title, sources: [{ sourceType: 'canvas', sourceId: map.id }], sourceLabel: `Canvas “${map.title}”`,
        }} />
      )}
    </div>
  );
};
