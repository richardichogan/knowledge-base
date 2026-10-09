/**
 * features/diagram/DiagramEditor.tsx — a Think diagram: an SVG sheet of shapes,
 * images, containers and swimlanes joined by straight or orthogonal connectors.
 *
 *   Click or drag a palette shape onto the sheet · drag from a side port onto
 *   another shape to connect · drag shapes (containers carry their contents),
 *   resize with the handles (Shift keeps aspect) · Shift+click / marquee (Alt
 *   on a shape) multi-selects · double-click edits a label · Space or middle
 *   button drags to pan, Ctrl+wheel zooms · Ctrl+Z / Ctrl+Shift+Z undo/redo ·
 *   Ctrl+C / Ctrl+V / Ctrl+D copy, paste, duplicate · Delete removes.
 *
 * World coordinates are absolute (children too). The full document is saved
 * after a short debounce, one request at a time, against the last revision;
 * conflicts and failures keep the local copy and surface Retry / Reload.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diagramTextLayout } from './diagramText';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  Undo, Redo, ZoomIn, ZoomOut, FitToScreen, Grid, Download, TrashCan, Copy, Edit, ColorPalette, Image as ImageIcon,
  Upload, Close, BringToFront, SendToBack, BringForward, SendBackward, AlignHorizontalLeft, AlignHorizontalCenter,
  AlignHorizontalRight, AlignVerticalTop, AlignVerticalCenter, AlignVerticalBottom, DistributeHorizontalCenter,
  DistributeVerticalCenter, Layers, Group, Renew, Reset, CheckmarkFilled, ErrorFilled, WarningAlt, InProgress,
} from '@carbon/icons-react';
import { api } from '../../services/api';
import { confirmDialog } from '../../services/appDialogs';
import type { CanvasFullApi } from '../../services/api';
import {
  emptyDiagram, type DiagramDocument, type DiagramEdge, type DiagramKind, type DiagramNode, type DiagramPoint,
  type DiagramPort, type DiagramSnapshot,
} from './diagramTypes';
import {
  PORTS, RESIZE_HANDLES, MIN_NODE_SIZE, CONTAINER_HEADER, SWIMLANE_HEADER, isContainerKind, nodeRect, boundsOf,
  documentBounds, normalizeRect, rectContainsRect, portPoint, nearestPort, nodeMap, withDescendants, topLevelSelection,
  canParent, setParent, renderOrder, containerAt, translateNodes, resizeRect, snap, distance, edgeRoute, pathD,
  pointAlong, insertWaypoint, hitTestNode, hitTestEdge, nodesInRect, alignNodes, distributeNodes, reorderNodes,
  cloneSelection, removeSelection, normalizeDocument, screenToWorld, worldToScreen, clampZoom, zoomAt, fitViewport,
  wrapText, fitSize, documentShapePath, type Rect, type ResizeHandle, type AlignMode, type OrderOp, type Viewport,
} from './diagramGeometry';
import { DiagramIconPicker } from './DiagramIconPicker';
import { DiagramNoteLinks } from './DiagramNoteLinks';
import { exportDiagram } from './diagramExport';
import { diagramEditorFill, diagramEditorInk, diagramEditorNodeColours } from './diagramTheme';
import { diagramBorderDash } from './diagramStroke';
import './diagram.scss';

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const FIT_PADDING = 48;
const SAVE_DELAY_MS = 800;
const VIEW_SAVE_DELAY_MS = 1500;
const HISTORY_LIMIT = 100;
const DRAG_THRESHOLD_PX = 3;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PASTE_OFFSET = 20;
const SHAPE_MIME = 'application/x-kh-diagram-shape';
const CLIP_TYPE = 'kh-diagram/v1';
const INFO_TIMEOUT_MS = 5000;

const FILLS = ['#262626', '#1c2d4a', '#173b27', '#3d3215', 'none'] as const;
const STROKES = ['#161616', '#525252', '#0f62fe', '#198038', '#b28600', '#da1e28', '#8a3ffc', 'none'] as const;
const TEXT_COLOURS = ['#161616', '#525252', '#ffffff', '#0f62fe', '#198038', '#da1e28'] as const;
const EDGE_COLOURS = STROKES.filter((c) => c !== 'none');
const DEFAULT_EDGE_STROKE = '#525252';
const FONT_MIN = 10;
const FONT_MAX = 36;

const KIND_LABEL: Record<DiagramKind, string> = {
  process: 'Process', decision: 'Decision', terminator: 'Start / end', document: 'Document', text: 'Text', image: 'Image',
  container: 'Container', swimlane: 'Swimlane',
};

const DEFAULTS: Record<DiagramKind, Pick<DiagramNode, 'label' | 'width' | 'height' | 'fill' | 'stroke' | 'textColor' | 'fontSize'>> = {
  process: { label: 'Process', width: 140, height: 64, fill: '#ffffff', stroke: '#161616', textColor: '#161616', fontSize: 16 },
  decision: { label: 'Decision?', width: 120, height: 80, fill: '#fcf4d6', stroke: '#b28600', textColor: '#161616', fontSize: 16 },
  terminator: { label: 'Start', width: 140, height: 52, fill: '#edf5ff', stroke: '#0f62fe', textColor: '#161616', fontSize: 16 },
  document: { label: 'Document', width: 140, height: 80, fill: '#ffffff', stroke: '#161616', textColor: '#161616', fontSize: 16 },
  text: { label: 'Text', width: 140, height: 40, fill: 'none', stroke: 'none', textColor: '#161616', fontSize: 16 },
  image: { label: '', width: 96, height: 96, fill: 'none', stroke: 'none', textColor: '#161616', fontSize: 16 },
  container: { label: 'Group', width: 320, height: 220, fill: '#f4f4f4', stroke: '#525252', textColor: '#161616', fontSize: 18 },
  swimlane: { label: 'Lane', width: 560, height: 180, fill: '#ffffff', stroke: '#525252', textColor: '#161616', fontSize: 18 },
};

const PALETTE: readonly DiagramKind[] = ['process', 'decision', 'terminator', 'document', 'text', 'image', 'container', 'swimlane'];

// ── Small helpers ─────────────────────────────────────────────────────────────

type P = DiagramPoint;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `dg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function captionHeight(n: Pick<DiagramNode, 'fontSize'>): number {
  return Math.round(n.fontSize * 1.3 + 10);
}

/** The box the picture itself occupies inside an image node (above its caption). */
function imageBox(n: DiagramNode): Rect {
  const cap = n.label.trim() === '' ? 0 : captionHeight(n);
  return { x: n.x + 4, y: n.y + 4, width: Math.max(1, n.width - 8), height: Math.max(1, n.height - cap - 8) };
}

function makeNode(kind: DiagramKind, center: P, extra: Partial<DiagramNode> = {}): DiagramNode {
  const d = DEFAULTS[kind];
  const colours = diagramEditorNodeColours(d);
  const width = extra.width ?? d.width;
  const height = extra.height ?? d.height;
  return {
    id: newId(), kind, parentId: null, assetId: null, ...d, ...colours, ...extra,
    width, height, x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2),
  };
}

function makeEdge(sourceId: string, sourcePort: DiagramPort, targetId: string, targetPort: DiagramPort): DiagramEdge {
  return {
    id: newId(), sourceId, targetId, sourcePort, targetPort, route: 'orthogonal', waypoints: [], label: '',
    stroke: DEFAULT_EDGE_STROKE, dashed: false, arrows: 'end',
  };
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

function captionFromFileName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeUrl(text: string): boolean {
  return /^(https?:|data:|blob:)/i.test(text.trim());
}

interface ErrorInfo { message: string; conflict: boolean; notFound: boolean }

function describeError(err: unknown): ErrorInfo {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = typeof body?.error?.code === 'string' ? body.error.code : '';
    const message = typeof body?.error?.message === 'string' ? body.error.message : err.message;
    return { message, conflict: status === 409 || /CONFLICT|REVISION/i.test(code), notFound: status === 404 || /NOT_FOUND/i.test(code) };
  }
  return { message: err instanceof Error ? err.message : String(err), conflict: false, notFound: false };
}

function failure(code: string, message: string): ErrorInfo {
  return { message, conflict: /CONFLICT|REVISION/i.test(code), notFound: /NOT_FOUND/i.test(code) };
}

function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 }); };
    img.onerror = () => { reject(new Error('The browser could not decode this image. Upload a valid PNG or SVG.')); };
    img.src = url;
  });
}

// ── Public component: loads the snapshot, then mounts the surface ─────────────

export interface DiagramEditorProps {
  canvasId: string;
  onDeleted?: (() => void) | undefined;
  onOpenNote?: ((noteId: string) => void) | undefined;
  onNoteChanged?: ((noteId: string) => void) | undefined;
  openTab?: string | undefined;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: DiagramSnapshot };

export const DiagramEditor: React.FC<DiagramEditorProps> = ({ canvasId, onDeleted, onOpenNote }) => {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad({ status: 'loading' });
    api.getDiagram(canvasId).then((r) => {
      if (!alive) return;
      if (r.success) {
        if (r.data.document.version !== 1) throw new Error('This diagram version is not supported by this editor.');
        setLoad({ status: 'ready', snapshot: r.data });
        return;
      }
      const info = failure(r.error.code, r.error.message);
      setLoad({ status: 'error', message: info.message });
    }).catch((err: unknown) => {
      if (!alive) return;
      const info = describeError(err);
      setLoad({ status: 'error', message: info.message });
    });
    return () => { alive = false; };
  }, [canvasId, attempt]);

  const reload = useCallback(() => { setAttempt((a) => a + 1); }, []);

  if (load.status === 'loading') {
    return <div className="dg-editor dg-editor--status" role="status"><InProgress size={16} className="dg-spin" /> Loading diagram…</div>;
  }
  if (load.status === 'error') {
    return (
      <div className="dg-editor dg-editor--status" role="alert">
        <ErrorFilled size={16} className="dg-editor__status-icon dg-editor__status-icon--error" />
        <span>Couldn’t load this diagram: {load.message}</span>
        <button type="button" className="dg-text-btn" onClick={reload}><Renew size={16} /> Retry</button>
      </div>
    );
  }
  return <DiagramSurface key={`${canvasId}:${attempt}`} canvasId={canvasId} initial={load.snapshot} onReload={reload} onDeleted={onDeleted} onOpenNote={onOpenNote} />;
};

// ── Surface ───────────────────────────────────────────────────────────────────

interface Selection { nodes: string[]; edges: string[] }
const EMPTY_SEL: Selection = { nodes: [], edges: [] };

type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

interface Notice {
  id: string;
  kind: 'error' | 'info';
  message: string;
  key?: string | undefined;
  action?: { label: string; run: () => void } | undefined;
}

type AssetState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; message: string };

type Drag =
  | { kind: 'pan'; pointerId: number; start: P; origin: Viewport }
  | { kind: 'marquee'; pointerId: number; start: P; current: P; additive: boolean; base: Selection }
  | { kind: 'move'; pointerId: number; startScreen: P; start: P; current: P; before: DiagramDocument; ids: string[]; origin: Rect; moved: boolean; clickId: string | null }
  | { kind: 'resize'; pointerId: number; id: string; handle: ResizeHandle; before: DiagramDocument; origin: Rect }
  | { kind: 'connect'; pointerId: number; sourceId: string; sourcePort: DiagramPort; current: P; targetId: string | null; targetPort: DiagramPort | null }
  | { kind: 'endpoint'; pointerId: number; edgeId: string; end: 'source' | 'target'; before: DiagramDocument; current: P; targetId: string | null; targetPort: DiagramPort | null }
  | { kind: 'bend'; pointerId: number; edgeId: string; index: number; before: DiagramDocument };

type Menu = 'style' | 'arrange' | 'edge-colour' | 'export' | 'image' | null;

interface EditingLabel { kind: 'node' | 'edge'; id: string; value: string }

interface SurfaceProps {
  canvasId: string;
  initial: DiagramSnapshot;
  onReload: () => void;
  onDeleted?: (() => void) | undefined;
  onOpenNote?: ((id: string) => void) | undefined;
}

const DiagramSurface: React.FC<SurfaceProps> = ({ canvasId, initial, onReload, onDeleted, onOpenNote }) => {
  const queryClient = useQueryClient();
  const markerBase = `dg${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [doc, setDocState] = useState<DiagramDocument>(initial.document);
  const docRef = useRef(doc);
  const [sel, setSelState] = useState<Selection>(EMPTY_SEL);
  const selRef = useRef(sel);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [editing, setEditing] = useState<EditingLabel | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<'png' | 'svg'>('png');
  const [exportBg, setExportBg] = useState<'white' | 'transparent'>('white');
  const [exportGrid, setExportGrid] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [, setHistoryTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const clipboardRef = useRef<{ nodes: DiagramNode[]; edges: DiagramEdge[] } | null>(null);
  const pasteCountRef = useRef(0);
  const fittedRef = useRef(false);

  const setDoc = useCallback((next: DiagramDocument) => { docRef.current = next; setDocState(next); }, []);
  const setSel = useCallback((next: Selection) => { selRef.current = next; setSelState(next); }, []);
  const setDrag = useCallback((next: Drag | null) => { dragRef.current = next; setDragState(next); }, []);

  const byId = useMemo(() => nodeMap(doc.nodes), [doc.nodes]);
  const view = doc.viewport;

  // ── Notices (nothing fails silently) ──────────────────────────────────────

  const dismiss = useCallback((id: string) => { setNotices((list) => list.filter((n) => n.id !== id)); }, []);
  const notify = useCallback((kind: Notice['kind'], message: string, opts: { key?: string; action?: Notice['action'] } = {}) => {
    const id = newId();
    setNotices((list) => [...list.filter((n) => opts.key === undefined || n.key !== opts.key), { id, kind, message, key: opts.key, action: opts.action }].slice(-4));
    if (kind === 'info') window.setTimeout(() => { dismiss(id); }, INFO_TIMEOUT_MS);
  }, [dismiss]);

  // ── Title / delete (canvas record) ─────────────────────────────────────────

  const { data: canvas } = useQuery<CanvasFullApi>({
    queryKey: ['canvas', canvasId],
    queryFn: async () => {
      const r = await api.getCanvas(canvasId);
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const savedTitle = canvas?.title ?? 'Untitled diagram';
  const [title, setTitle] = useState(savedTitle);
  useEffect(() => { setTitle(savedTitle); }, [savedTitle]);

  async function renameDiagram(): Promise<void> {
    const t = title.trim();
    if (t === '') { setTitle(savedTitle); return; }
    if (t === savedTitle) return;
    try {
      const r = await api.updateCanvas(canvasId, { title: t });
      if (!r.success) throw new Error(r.error.message);
      void queryClient.invalidateQueries({ queryKey: ['canvases'] });
      void queryClient.invalidateQueries({ queryKey: ['canvas', canvasId] });
    } catch (err) {
      setTitle(savedTitle);
      notify('error', `Couldn’t rename the diagram: ${describeError(err).message}`, { key: 'rename' });
    }
  }

  async function deleteDiagram(): Promise<void> {
    if (!await confirmDialog(`Delete the diagram “${savedTitle}”? This cannot be undone.`, { title: 'Delete diagram', confirmLabel: 'Delete', tone: 'danger' })) return;
    try {
      await api.deleteCanvas(canvasId);
      save.current.discard = true;
      void queryClient.invalidateQueries({ queryKey: ['canvases'] });
      onDeleted?.();
    } catch (err) {
      notify('error', `Couldn’t delete the diagram: ${describeError(err).message}`, { key: 'delete' });
    }
  }

  // ── Save queue: debounce, one request in flight, latest document wins ─────

  const save = useRef({
    rev: initial.revision, seq: 0, savedSeq: 0, inflight: null as Promise<void> | null,
    timer: null as number | null, blocked: null as 'error' | 'conflict' | null, discard: false,
  });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);

  const flush = useCallback((): void => {
    const s = save.current;
    if (s.timer !== null) { window.clearTimeout(s.timer); s.timer = null; }
    if (s.discard || s.inflight !== null || s.blocked !== null) return;
    if (s.seq === s.savedSeq) { setSaveStatus('saved'); return; }
    const seq = s.seq;
    setSaveStatus('saving');
    s.inflight = (async () => {
      let problem: ErrorInfo | null = null;
      try {
        const r = await api.saveDiagram(canvasId, s.rev, docRef.current);
        if (r.success) { s.rev = r.data.revision; s.savedSeq = Math.max(s.savedSeq, seq); }
        else problem = failure(r.error.code, r.error.message);
      } catch (err) {
        problem = describeError(err);
      }
      s.inflight = null;
      if (s.discard) return;
      if (problem !== null) {
        s.blocked = problem.conflict ? 'conflict' : 'error';
        setSaveStatus(s.blocked);
        setSaveError(problem.message);
        return;
      }
      setSaveError(null);
      if (s.seq > s.savedSeq) flush(); else setSaveStatus('saved');
    })();
  }, [canvasId]);

  const markDirty = useCallback((delay: number) => {
    const s = save.current;
    s.seq += 1;
    if (s.blocked === 'conflict') return; // keep local changes; the user decides
    if (s.blocked === 'error') { s.blocked = null; setSaveError(null); } // the next edit retries
    setSaveStatus((st) => (st === 'saving' ? st : 'pending'));
    if (s.timer !== null) window.clearTimeout(s.timer);
    s.timer = window.setTimeout(flush, delay);
  }, [flush]);

  function retrySave(): void {
    save.current.blocked = null;
    setSaveError(null);
    flush();
  }

  async function overwriteWithMine(): Promise<void> {
    try {
      const r = await api.getDiagram(canvasId);
      if (!r.success) throw new Error(r.error.message);
      save.current.rev = r.data.revision;
      save.current.blocked = null;
      setSaveError(null);
      flush();
    } catch (err) {
      notify('error', `Couldn’t check the latest version: ${describeError(err).message}`, { key: 'overwrite' });
    }
  }

  async function reloadFromServer(): Promise<void> {
    const s = save.current;
    if (s.seq > s.savedSeq && !await confirmDialog('Reload the saved diagram? Your unsaved changes here will be discarded.', { title: 'Discard changes', confirmLabel: 'Reload', tone: 'danger' })) return;
    s.discard = true;
    if (s.timer !== null) window.clearTimeout(s.timer);
    onReload();
  }

  useEffect(() => {
    const s = save.current;
    const beforeUnload = (e: BeforeUnloadEvent): void => { if (!s.discard && s.seq > s.savedSeq) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      if (s.timer !== null) window.clearTimeout(s.timer);
      if (s.discard || s.blocked === 'conflict') return;
      // Final save on unmount (switching canvases): wait for any in-flight save first.
      void (s.inflight ?? Promise.resolve()).then(async () => {
        if (s.seq <= s.savedSeq || s.blocked === 'conflict') return;
        const r = await api.saveDiagram(canvasId, s.rev, docRef.current);
        if (!r.success) console.error('Diagram final save failed:', r.error.message);
      }).catch((err: unknown) => { console.error('Diagram final save failed:', describeError(err).message); });
    };
  }, [canvasId]);

  // ── History (full-document snapshots; viewport excluded) ───────────────────

  const history = useRef<{ past: DiagramDocument[]; future: DiagramDocument[] }>({ past: [], future: [] });

  const commit = useCallback((next: DiagramDocument, before: DiagramDocument = docRef.current) => {
    if (next === before) return;
    const h = history.current;
    h.past = [...h.past, before].slice(-HISTORY_LIMIT);
    h.future = [];
    setHistoryTick((t) => t + 1);
    setDoc(next);
    markDirty(SAVE_DELAY_MS);
  }, [markDirty, setDoc]);

  const pruneSelection = useCallback((d: DiagramDocument) => {
    const ns = new Set(d.nodes.map((n) => n.id));
    const es = new Set(d.edges.map((e) => e.id));
    const s = selRef.current;
    setSel({ nodes: s.nodes.filter((id) => ns.has(id)), edges: s.edges.filter((id) => es.has(id)) });
  }, [setSel]);

  const stepHistory = useCallback((dir: 'undo' | 'redo') => {
    const h = history.current;
    const from = dir === 'undo' ? h.past : h.future;
    const snapshot = from[from.length - 1];
    if (snapshot === undefined) return;
    const cur = docRef.current;
    if (dir === 'undo') { h.past = h.past.slice(0, -1); h.future = [...h.future, cur]; }
    else { h.future = h.future.slice(0, -1); h.past = [...h.past, cur]; }
    const next = { ...snapshot, viewport: cur.viewport, grid: cur.grid };
    setHistoryTick((t) => t + 1);
    setDoc(next);
    pruneSelection(next);
    setEditing(null);
    markDirty(SAVE_DELAY_MS);
  }, [markDirty, pruneSelection, setDoc]);

  // ── Viewport ───────────────────────────────────────────────────────────────

  const setView = useCallback((v: Viewport, persist = true) => {
    const cur = docRef.current;
    const next = { x: v.x, y: v.y, zoom: clampZoom(v.zoom, MIN_ZOOM, MAX_ZOOM) };
    if (next.x === cur.viewport.x && next.y === cur.viewport.y && next.zoom === cur.viewport.zoom) return;
    setDoc({ ...cur, viewport: next });
    if (persist) markDirty(VIEW_SAVE_DELAY_MS);
  }, [markDirty, setDoc]);

  const fit = useCallback((persist = true) => {
    const el = sheetRef.current;
    if (el === null) return;
    const v = fitViewport(documentBounds(docRef.current), el.clientWidth, el.clientHeight, FIT_PADDING, MIN_ZOOM, MAX_ZOOM);
    setView(v, persist);
  }, [setView]);

  function zoomBy(factor: number): void {
    const v = docRef.current.viewport;
    setView(zoomAt(v, { x: size.width / 2, y: size.height / 2 }, clampZoom(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)));
  }

  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (el === null) return undefined;
    const update = (): void => { setSize({ width: el.clientWidth, height: el.clientHeight }); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  useLayoutEffect(() => {
    if (fittedRef.current || size.width === 0) return;
    fittedRef.current = true;
    const v = docRef.current.viewport;
    if (v.x === 0 && v.y === 0 && v.zoom === 1 && docRef.current.nodes.length > 0) fit(false);
  }, [size.width, fit]);

  const viewCenter = useCallback((): P => screenToWorld({ x: size.width / 2, y: size.height / 2 }, docRef.current.viewport), [size]);

  function toWorld(clientX: number, clientY: number): P {
    const r = svgRef.current?.getBoundingClientRect();
    return screenToWorld({ x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) }, docRef.current.viewport);
  }

  function toScreen(clientX: number, clientY: number): P {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }

  // Wheel: pan; Ctrl/⌘+wheel (and pinch) zooms at the pointer. Needs a non-passive listener.
  useEffect(() => {
    const el = svgRef.current;
    if (el === null) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const v = docRef.current.viewport;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const z = clampZoom(v.zoom * Math.exp(-e.deltaY * scale * 0.0015), MIN_ZOOM, MAX_ZOOM);
        setView(zoomAt(v, { x: e.clientX - r.left, y: e.clientY - r.top }, z));
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setView({ ...v, x: v.x - dx * scale, y: v.y - dy * scale });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); };
  }, [setView]);

  // ── Assets: blobs → object URLs (revoked on cleanup) ───────────────────────

  const [assets, setAssets] = useState<Record<string, AssetState>>({});
  const blobsRef = useRef(new Map<string, Blob>());
  const urlsRef = useRef(new Map<string, string>());
  const requestedRef = useRef(new Set<string>());
  const failedRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  const mountedOnceRef = useRef(false);
  const [assetAttempt, setAssetAttempt] = useState(0);

  const registerBlob = useCallback((assetId: string, blob: Blob): string => {
    blobsRef.current.set(assetId, blob);
    requestedRef.current.add(assetId);
    failedRef.current.delete(assetId);
    const old = urlsRef.current.get(assetId);
    if (old !== undefined) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(blob);
    urlsRef.current.set(assetId, url);
    setAssets((a) => ({ ...a, [assetId]: { status: 'ready', url } }));
    return url;
  }, []);

  const retryAssets = useCallback(() => {
    for (const id of failedRef.current) requestedRef.current.delete(id);
    failedRef.current.clear();
    setAssetAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (mountedOnceRef.current) {
      // Remounted (StrictMode / fast refresh): rebuild URLs from the blobs we kept.
      const next: Record<string, AssetState> = {};
      for (const [id, blob] of blobsRef.current) {
        const url = URL.createObjectURL(blob);
        urlsRef.current.set(id, url);
        next[id] = { status: 'ready', url };
      }
      setAssets((a) => ({ ...a, ...next }));
      setAssetAttempt((n) => n + 1);
    }
    mountedOnceRef.current = true;
    const urls = urlsRef.current;
    const requested = requestedRef.current;
    const blobs = blobsRef.current;
    return () => {
      aliveRef.current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      for (const id of [...requested]) if (!blobs.has(id)) requested.delete(id);
    };
  }, []);

  useEffect(() => {
    const ids = new Set(doc.nodes.flatMap((n) => (n.assetId === null ? [] : [n.assetId])));
    for (const id of ids) {
      if (requestedRef.current.has(id)) continue;
      requestedRef.current.add(id);
      setAssets((a) => ({ ...a, [id]: { status: 'loading' } }));
      api.getDiagramAsset(canvasId, id).then((blob) => {
        if (aliveRef.current) registerBlob(id, blob);
      }).catch((err: unknown) => {
        if (!aliveRef.current) return;
        const message = describeError(err).message;
        failedRef.current.add(id);
        setAssets((a) => ({ ...a, [id]: { status: 'error', message } }));
        notify('error', `Some images couldn’t be loaded (${message}).`, { key: 'assets', action: { label: 'Retry', run: retryAssets } });
      });
    }
  }, [doc.nodes, canvasId, assetAttempt, notify, registerBlob, retryAssets]);

  // ── Document operations ────────────────────────────────────────────────────

  const addNodes = useCallback((nodes: DiagramNode[], edges: DiagramEdge[] = []) => {
    const cur = docRef.current;
    commit({ ...cur, nodes: [...cur.nodes, ...nodes], edges: [...cur.edges, ...edges] });
    const ids = new Set(nodes.map((n) => n.id));
    setSel({ nodes: nodes.filter((n) => n.parentId === null || !ids.has(n.parentId)).map((n) => n.id), edges: [] });
  }, [commit, setSel]);

  /** A new node placed at `center`, snapped to the grid and nested in the container under it. */
  const placeNode = useCallback((kind: DiagramKind, center: P, extra: Partial<DiagramNode> = {}): DiagramNode => {
    const cur = docRef.current;
    let node = makeNode(kind, center, extra);
    if (cur.grid) node = { ...node, x: snap(node.x, GRID), y: snap(node.y, GRID) };
    const host = containerAt(cur.nodes, center);
    return host !== null ? { ...node, parentId: host.id } : node;
  }, []);

  function addShape(kind: DiagramKind, center: P = viewCenter()): void {
    if (kind === 'image') { setMenu('image'); return; }
    addNodes([placeNode(kind, center)]);
    rootRef.current?.focus({ preventScroll: true });
  }

  const updateNodes = useCallback((ids: readonly string[], patch: (n: DiagramNode) => DiagramNode) => {
    const set = new Set(ids);
    const cur = docRef.current;
    commit({ ...cur, nodes: cur.nodes.map((n) => (set.has(n.id) ? patch(n) : n)) });
  }, [commit]);

  const updateEdges = useCallback((ids: readonly string[], patch: (e: DiagramEdge) => DiagramEdge) => {
    const set = new Set(ids);
    const cur = docRef.current;
    commit({ ...cur, edges: cur.edges.map((e) => (set.has(e.id) ? patch(e) : e)) });
  }, [commit]);

  function setNodeLabel(n: DiagramNode, value: string): DiagramNode {
    if (n.kind !== 'image') return { ...n, label: value };
    const had = n.label.trim() !== '';
    const has = value.trim() !== '';
    const delta = had === has ? 0 : (has ? captionHeight(n) : -captionHeight(n));
    return { ...n, label: value, height: Math.max(MIN_NODE_SIZE, n.height + delta) };
  }

  function commitLabel(e: EditingLabel): void {
    setEditing(null);
    if (e.kind === 'node') {
      const n = docRef.current.nodes.find((x) => x.id === e.id);
      if (n !== undefined && n.label !== e.value) updateNodes([e.id], (x) => setNodeLabel(x, e.value));
    } else {
      const edge = docRef.current.edges.find((x) => x.id === e.id);
      if (edge !== undefined && edge.label !== e.value) updateEdges([e.id], (x) => ({ ...x, label: e.value }));
    }
    rootRef.current?.focus({ preventScroll: true });
  }

  const startEditing = useCallback(() => {
    const s = selRef.current;
    const cur = docRef.current;
    if (s.nodes.length === 1 && s.nodes[0] !== undefined) {
      const n = cur.nodes.find((x) => x.id === s.nodes[0]);
      if (n !== undefined) setEditing({ kind: 'node', id: n.id, value: n.label });
    } else if (s.nodes.length === 0 && s.edges.length === 1 && s.edges[0] !== undefined) {
      const e = cur.edges.find((x) => x.id === s.edges[0]);
      if (e !== undefined) setEditing({ kind: 'edge', id: e.id, value: e.label });
    }
  }, []);

  const deleteSelected = useCallback(() => {
    const s = selRef.current;
    if (s.nodes.length === 0 && s.edges.length === 0) return;
    commit(removeSelection(docRef.current, s.nodes, s.edges));
    setSel(EMPTY_SEL);
    setMenu(null);
  }, [commit, setSel]);

  const selectionPayload = useCallback((): { nodes: DiagramNode[]; edges: DiagramEdge[] } | null => {
    const s = selRef.current;
    const cur = docRef.current;
    if (s.nodes.length === 0) return null;
    const ids = withDescendants(cur.nodes, s.nodes);
    return {
      nodes: cur.nodes.filter((n) => ids.has(n.id)),
      edges: cur.edges.filter((e) => ids.has(e.sourceId) && ids.has(e.targetId)),
    };
  }, []);

  const pastePayload = useCallback((payload: { nodes: DiagramNode[]; edges: DiagramEdge[] }, offset: number) => {
    const cur = docRef.current;
    const roots = topLevelSelection(payload.nodes, payload.nodes.map((n) => n.id));
    const clone = cloneSelection(payload, roots, offset, offset, newId, cur);
    if (clone.nodes.length > 0) addNodes(clone.nodes, clone.edges);
  }, [addNodes]);

  const duplicate = useCallback(() => {
    const payload = selectionPayload();
    if (payload !== null) pastePayload(payload, PASTE_OFFSET);
  }, [pastePayload, selectionPayload]);

  function nestInto(parentId: string | null): void {
    const cur = docRef.current;
    const top = topLevelSelection(cur.nodes, selRef.current.nodes).filter((id) => canParent(cur.nodes, id, parentId));
    if (top.length === 0) return;
    let next: DiagramDocument = { ...cur, nodes: setParent(cur.nodes, top, parentId) };
    const host = parentId === null ? undefined : next.nodes.find((n) => n.id === parentId);
    if (host !== undefined) {
      // Bring members that sit outside the container inside it, then grow it to fit.
      const left = host.x + (host.kind === 'swimlane' ? SWIMLANE_HEADER : 0) + 16;
      const topY = host.y + (host.kind === 'container' ? CONTAINER_HEADER : 0) + 16;
      let i = 0;
      for (const id of top) {
        const n = next.nodes.find((x) => x.id === id);
        if (n === undefined || rectContainsRect(nodeRect(host), nodeRect(n))) continue;
        next = translateNodes(next, [id], left + i * 16 - n.x, topY + i * 16 - n.y);
        i += 1;
      }
      const members = withDescendants(next.nodes, top);
      const b = boundsOf(next.nodes.filter((n) => members.has(n.id)).map(nodeRect));
      if (b !== null) {
        next = {
          ...next,
          nodes: next.nodes.map((n) => (n.id !== host.id ? n : {
            ...n,
            width: Math.max(n.width, b.x + b.width + 16 - n.x),
            height: Math.max(n.height, b.y + b.height + 16 - n.y),
          })),
        };
      }
    }
    commit(next);
  }

  function wrapInContainer(): void {
    const cur = docRef.current;
    const top = topLevelSelection(cur.nodes, selRef.current.nodes);
    const b = boundsOf(cur.nodes.filter((n) => top.includes(n.id)).map(nodeRect));
    if (b === null) return;
    const parents = new Set(top.map((id) => byId.get(id)?.parentId ?? null));
    const sharedParent = parents.size === 1 ? [...parents][0] ?? null : null;
    const box: DiagramNode = {
      ...makeNode('container', { x: 0, y: 0 }),
      x: b.x - 24, y: b.y - 24 - CONTAINER_HEADER, width: b.width + 48, height: b.height + 48 + CONTAINER_HEADER, parentId: sharedParent,
    };
    const firstIndex = Math.max(0, cur.nodes.findIndex((n) => top.includes(n.id)));
    const nodes = [...cur.nodes.slice(0, firstIndex), box, ...cur.nodes.slice(firstIndex)];
    commit({ ...cur, nodes: setParent(nodes, top, box.id) });
    setSel({ nodes: [box.id], edges: [] });
    setMenu(null);
  }

  function arrange(op: OrderOp): void {
    const cur = docRef.current;
    commit({ ...cur, nodes: reorderNodes(cur.nodes, selRef.current.nodes, op) });
  }

  function align(mode: AlignMode): void { commit(alignNodes(docRef.current, topLevelSelection(docRef.current.nodes, selRef.current.nodes), mode)); }
  function distribute(axis: 'horizontal' | 'vertical'): void { commit(distributeNodes(docRef.current, topLevelSelection(docRef.current.nodes, selRef.current.nodes), axis)); }

  function toggleGrid(): void {
    const cur = docRef.current;
    setDoc({ ...cur, grid: !cur.grid });
    markDirty(SAVE_DELAY_MS);
  }

  // ── Images: upload only through the diagram asset API ──────────────────────

  async function uploadImage(file: File, opts: { at?: P | undefined; replaceId?: string | null | undefined; caption?: string | undefined } = {}): Promise<void> {
    const name = file.name === '' ? 'pasted image' : file.name;
    if (!file.type.startsWith('image/')) {
      notify('error', `“${name}” isn’t an image. Diagrams accept PNG or SVG files.`, { key: `type:${name}` });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      notify('error', `“${name}” is ${(file.size / 1024 / 1024).toFixed(1)} MiB — images must be 5 MiB or smaller.`, { key: `size:${name}` });
      return;
    }
    if (file.type !== 'image/png' && file.type !== 'image/svg+xml') {
      notify('error', `“${name}” has an unsupported format. Upload a PNG or SVG file.`, { key: `type:${name}` });
      return;
    }
    setUploading((n) => n + 1);
    try {
      const r = await api.uploadDiagramAsset(canvasId, file, name);
      if (!r.success) throw new Error(r.error.message);
      if (!aliveRef.current) return;
      const url = registerBlob(r.data.id, file);
      const natural = await measureImage(url);
      const replaceId = opts.replaceId ?? null;
      if (replaceId !== null) {
        if (!docRef.current.nodes.some((n) => n.id === replaceId)) { notify('info', 'The image you were replacing was deleted, so the upload was not used.'); return; }
        updateNodes([replaceId], (n) => {
          const box = fitSize(natural.width, natural.height, Math.max(n.width - 8, 32), 1e6);
          const cap = n.label.trim() === '' ? 0 : captionHeight(n);
          return { ...n, kind: 'image', assetId: r.data.id, height: Math.max(MIN_NODE_SIZE, Math.round(box.height * ((n.width - 8) / box.width) + 8 + cap)) };
        });
        return;
      }
      const caption = opts.caption ?? '';
      const fontSize = DEFAULTS.image.fontSize;
      const box = fitSize(natural.width, natural.height, 160, 120);
      const captionW = caption === '' ? 0 : Math.min(200, Math.ceil(caption.length * fontSize * 0.56) + 16);
      const node = placeNode('image', opts.at ?? viewCenter(), {
        width: Math.max(Math.round(box.width) + 8, captionW),
        height: Math.round(box.height) + 8 + (caption === '' ? 0 : captionHeight({ fontSize })),
        label: caption, assetId: r.data.id,
      });
      addNodes([node]);
    } catch (err) {
      notify('error', `Couldn’t upload “${name}”: ${describeError(err).message}`, {
        key: `upload:${name}`, action: { label: 'Retry', run: () => { void uploadImage(file, opts); } },
      });
    } finally {
      setUploading((n) => n - 1);
    }
  }

  function uploadFiles(files: readonly File[], at?: P, caption?: string): void {
    files.forEach((f, i) => { void uploadImage(f, { at: at === undefined ? undefined : { x: at.x + i * PASTE_OFFSET, y: at.y + i * PASTE_OFFSET }, caption }); });
  }

  function chooseFile(replaceId: string | null = null): void {
    replaceTargetRef.current = replaceId;
    fileInputRef.current?.click();
  }

  function unsupportedPaste(kind: 'url' | 'text'): void {
    notify('info', kind === 'url'
      ? 'Image links can’t be added directly — download the image and upload it, or copy the image itself and paste.'
      : 'Only images can be pasted onto a diagram. Copy an image, or upload one from your computer.', {
      key: 'unsupported-paste', action: { label: 'Upload image…', run: () => { chooseFile(); } },
    });
  }

  async function runExport(): Promise<void> {
    const cur = docRef.current;
    const ids = [...new Set(cur.nodes.flatMap((n) => (n.assetId === null ? [] : [n.assetId])))];
    const missing = ids.filter((id) => !blobsRef.current.has(id));
    if (missing.length > 0) {
      notify('error', `${missing.length} image${missing.length === 1 ? ' is' : 's are'} still loading or failed to load, so the export would be incomplete.`, {
        key: 'export', action: { label: 'Retry images', run: retryAssets },
      });
      return;
    }
    const map = new Map<string, Blob>();
    for (const id of ids) { const b = blobsRef.current.get(id); if (b !== undefined) map.set(id, b); }
    setExporting(true);
    try {
      await exportDiagram(cur, map, exportFormat, exportBg, exportGrid);
      setMenu(null);
    } catch (err) {
      notify('error', `Export failed: ${describeError(err).message}`, { key: 'export' });
    } finally {
      setExporting(false);
    }
  }

  // ── Pointer interaction ────────────────────────────────────────────────────

  const spaceRef = useRef(false);
  const lastPointerRef = useRef<P | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState(false);

  function snapPoint(p: P, on: boolean): P {
    return on ? { x: snap(p.x, GRID), y: snap(p.y, GRID) } : p;
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    setMenu(null);
    rootRef.current?.focus({ preventScroll: true });
    const target = e.target instanceof Element ? e.target.closest('[data-dg]') : null;
    const role = target?.getAttribute('data-dg') ?? null;
    const id = target?.getAttribute('data-id') ?? '';
    const world = toWorld(e.clientX, e.clientY);
    const cur = docRef.current;
    const pointerId = e.pointerId;
    const begin = (d: Drag): void => {
      e.preventDefault();
      svgRef.current?.setPointerCapture(pointerId);
      setDrag(d);
    };
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      begin({ kind: 'pan', pointerId, start: toScreen(e.clientX, e.clientY), origin: cur.viewport });
      return;
    }
    if (e.button !== 0) return;
    const s = selRef.current;
    switch (role) {
      case 'port': {
        const port = target?.getAttribute('data-port') as DiagramPort | null;
        if (port === null || !byId.has(id)) return;
        begin({ kind: 'connect', pointerId, sourceId: id, sourcePort: port, current: world, targetId: null, targetPort: null });
        return;
      }
      case 'resize': {
        const n = byId.get(id);
        const handle = target?.getAttribute('data-handle') as ResizeHandle | null;
        if (n === undefined || handle === null) return;
        begin({ kind: 'resize', pointerId, id, handle, before: cur, origin: nodeRect(n) });
        return;
      }
      case 'endpoint': {
        const end = target?.getAttribute('data-end') === 'source' ? 'source' : 'target';
        begin({ kind: 'endpoint', pointerId, edgeId: id, end, before: cur, current: world, targetId: null, targetPort: null });
        return;
      }
      case 'bend': {
        begin({ kind: 'bend', pointerId, edgeId: id, index: Number(target?.getAttribute('data-index') ?? '0'), before: cur });
        return;
      }
      case 'midpoint': {
        const edge = cur.edges.find((x) => x.id === id);
        const route = edge === undefined ? null : edgeRoute(edge, byId);
        if (edge === undefined || route === null) return;
        const ins = insertWaypoint(route, edge.waypoints, snapPoint(world, cur.grid && !e.altKey));
        setDoc({ ...cur, edges: cur.edges.map((x) => (x.id === id ? { ...x, waypoints: ins.waypoints } : x)) });
        begin({ kind: 'bend', pointerId, edgeId: id, index: ins.index, before: cur });
        return;
      }
      case 'node': {
        if (e.altKey) break;
        let nodes = s.nodes;
        let clickId: string | null = null;
        if (e.shiftKey) {
          if (s.nodes.includes(id)) { setSel({ ...s, nodes: s.nodes.filter((x) => x !== id) }); return; }
          nodes = [...s.nodes, id];
          setSel({ ...s, nodes });
        } else if (!s.nodes.includes(id)) {
          nodes = [id];
          setSel({ nodes, edges: [] });
        } else {
          clickId = id;
        }
        const ids = topLevelSelection(cur.nodes, nodes);
        const origin = boundsOf(cur.nodes.filter((n) => ids.includes(n.id)).map(nodeRect));
        if (origin === null) return;
        begin({ kind: 'move', pointerId, startScreen: toScreen(e.clientX, e.clientY), start: world, current: world, before: cur, ids, origin, moved: false, clickId });
        return;
      }
      case 'edge': {
        e.preventDefault();
        if (e.shiftKey) setSel({ ...s, edges: s.edges.includes(id) ? s.edges.filter((x) => x !== id) : [...s.edges, id] });
        else setSel({ nodes: [], edges: [id] });
        return;
      }
      default:
        break;
    }
    if (!e.shiftKey) setSel(EMPTY_SEL);
    begin({ kind: 'marquee', pointerId, start: world, current: world, additive: e.shiftKey, base: e.shiftKey ? s : EMPTY_SEL });
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>): void {
    const world = toWorld(e.clientX, e.clientY);
    lastPointerRef.current = world;
    const d = dragRef.current;
    if (d === null) {
      const t = e.target instanceof Element ? e.target.closest('[data-dg="node"], [data-dg="port"], [data-dg="resize"]') : null;
      const id = t?.getAttribute('data-id') ?? null;
      if (id !== hoverId) setHoverId(id);
      return;
    }
    if (e.pointerId !== d.pointerId) return;
    const cur = docRef.current;
    const snapOn = cur.grid && !e.altKey;
    switch (d.kind) {
      case 'pan': {
        const sp = toScreen(e.clientX, e.clientY);
        setView({ ...d.origin, x: d.origin.x + sp.x - d.start.x, y: d.origin.y + sp.y - d.start.y });
        return;
      }
      case 'marquee': {
        const rect = normalizeRect(d.start, world);
        const hits = nodesInRect(cur.nodes, rect);
        const hitSet = new Set(hits);
        const edges = cur.edges.filter((x) => hitSet.has(x.sourceId) && hitSet.has(x.targetId)).map((x) => x.id);
        setSel({ nodes: [...new Set([...d.base.nodes, ...hits])], edges: [...new Set([...d.base.edges, ...edges])] });
        setDrag({ ...d, current: world });
        return;
      }
      case 'move': {
        const sp = toScreen(e.clientX, e.clientY);
        if (!d.moved && distance(sp, d.startScreen) < DRAG_THRESHOLD_PX) return;
        const rawX = world.x - d.start.x;
        const rawY = world.y - d.start.y;
        const dx = snapOn ? snap(d.origin.x + rawX, GRID) - d.origin.x : rawX;
        const dy = snapOn ? snap(d.origin.y + rawY, GRID) - d.origin.y : rawY;
        setDoc(translateNodes(d.before, d.ids, dx, dy));
        const host = containerAt(d.before.nodes, world, withDescendants(d.before.nodes, d.ids));
        setDropTargetId(host?.id ?? null);
        setDrag({ ...d, moved: true, current: world });
        return;
      }
      case 'resize': {
        const rect = resizeRect(d.origin, d.handle, snapPoint(world, snapOn), { min: MIN_NODE_SIZE, keepAspect: e.shiftKey });
        setDoc({
          ...d.before,
          nodes: d.before.nodes.map((n) => (n.id === d.id ? { ...n, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : n)),
        });
        return;
      }
      case 'connect':
      case 'endpoint': {
        const exclude = new Set<string>(d.kind === 'connect' ? [d.sourceId] : []);
        const hit = hitTestNode(cur.nodes, world, exclude);
        setDrag({ ...d, current: world, targetId: hit?.id ?? null, targetPort: hit === null ? null : nearestPort(nodeRect(hit), world, hit.kind) });
        return;
      }
      case 'bend': {
        const p = snapPoint(world, snapOn);
        setDoc({
          ...cur,
          edges: cur.edges.map((x) => (x.id !== d.edgeId ? x : { ...x, waypoints: x.waypoints.map((w, i) => (i === d.index ? p : w)) })),
        });
        return;
      }
    }
  }

  function endDrag(e: React.PointerEvent<SVGSVGElement>, cancelled: boolean): void {
    const d = dragRef.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    if (svgRef.current?.hasPointerCapture(e.pointerId) === true) svgRef.current.releasePointerCapture(e.pointerId);
    setDrag(null);
    setDropTargetId(null);
    if (cancelled) {
      if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'bend') setDoc({ ...d.before, viewport: docRef.current.viewport });
      return;
    }
    const cur = docRef.current;
    const world = toWorld(e.clientX, e.clientY);
    switch (d.kind) {
      case 'pan':
      case 'marquee':
        return;
      case 'move': {
        if (!d.moved) {
          if (d.clickId !== null) setSel({ nodes: [d.clickId], edges: [] });
          return;
        }
        const host = containerAt(cur.nodes, world, withDescendants(cur.nodes, d.ids));
        const parentId = host?.id ?? null;
        const changed = d.ids.filter((id) => (cur.nodes.find((n) => n.id === id)?.parentId ?? null) !== parentId && canParent(cur.nodes, id, parentId));
        commit(changed.length > 0 ? { ...cur, nodes: setParent(cur.nodes, changed, parentId) } : cur, d.before);
        return;
      }
      case 'resize':
      case 'bend':
        commit(cur, d.before);
        return;
      case 'connect': {
        const source = byId.get(d.sourceId);
        if (source === undefined) return;
        if (d.targetId !== null && d.targetPort !== null) {
          const edge = makeEdge(d.sourceId, d.sourcePort, d.targetId, d.targetPort);
          commit({ ...cur, edges: [...cur.edges, edge] });
          setSel({ nodes: [], edges: [edge.id] });
          return;
        }
        const from = portPoint(nodeRect(source), d.sourcePort, source.kind);
        if (distance(from, world) < 40) return;
        // Dropped on empty sheet: create a connected shape there.
        const kind: DiagramKind = source.kind === 'decision' || source.kind === 'terminator' ? 'process' : (isContainerKind(source.kind) || source.kind === 'image' || source.kind === 'text') ? 'process' : source.kind;
        const node = placeNode(kind, world);
        const edge = makeEdge(d.sourceId, d.sourcePort, node.id, nearestPort(nodeRect(node), from, node.kind));
        addNodes([node], [edge]);
        return;
      }
      case 'endpoint': {
        if (d.targetId === null || d.targetPort === null) return;
        const targetId = d.targetId;
        const port = d.targetPort;
        commit({
          ...cur,
          edges: cur.edges.map((x) => (x.id !== d.edgeId ? x : d.end === 'source'
            ? { ...x, sourceId: targetId, sourcePort: port, waypoints: [] }
            : { ...x, targetId, targetPort: port, waypoints: [] })),
        });
        return;
      }
    }
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>): void {
    const target = e.target instanceof Element ? e.target.closest('[data-dg]') : null;
    const role = target?.getAttribute('data-dg') ?? null;
    const id = target?.getAttribute('data-id') ?? '';
    const cur = docRef.current;
    if (role === 'bend') {
      const index = Number(target?.getAttribute('data-index') ?? '-1');
      updateEdges([id], (x) => ({ ...x, waypoints: x.waypoints.filter((_, i) => i !== index) }));
      return;
    }
    if (role === 'node' || role === 'resize') {
      const n = byId.get(id);
      if (n === undefined) return;
      setSel({ nodes: [id], edges: [] });
      setEditing({ kind: 'node', id, value: n.label });
      return;
    }
    if (role === 'edge' || role === 'midpoint') {
      const edge = cur.edges.find((x) => x.id === id);
      if (edge === undefined) return;
      setSel({ nodes: [], edges: [id] });
      setEditing({ kind: 'edge', id, value: edge.label });
      return;
    }
    if (role === null) {
      const world = toWorld(e.clientX, e.clientY);
      // Pointer capture can retarget double-clicks to the sheet instead of the shape.
      const hit = hitTestNode(cur.nodes, world);
      if (hit !== null) {
        setSel({ nodes: [hit.id], edges: [] });
        setEditing({ kind: 'node', id: hit.id, value: hit.label });
        return;
      }
      const edge = hitTestEdge(cur.edges, byId, world, 6 / cur.viewport.zoom);
      if (edge !== null) { setSel({ nodes: [], edges: [edge.id] }); setEditing({ kind: 'edge', id: edge.id, value: edge.label }); return; }
      const node = placeNode('process', world);
      addNodes([node]);
      setEditing({ kind: 'node', id: node.id, value: node.label });
    }
  }

  // ── Keyboard (never while typing in a field) ───────────────────────────────

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); stepHistory(e.shiftKey ? 'redo' : 'undo'); return; }
    if (mod && k === 'y') { e.preventDefault(); stepHistory('redo'); return; }
    if (mod && k === 'a') { e.preventDefault(); setSel({ nodes: docRef.current.nodes.map((n) => n.id), edges: docRef.current.edges.map((x) => x.id) }); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
    if (mod || e.altKey) return; // copy / cut / paste arrive as clipboard events
    const onSurface = e.target === rootRef.current;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (selRef.current.nodes.length + selRef.current.edges.length === 0) return;
        e.preventDefault(); deleteSelected(); return;
      case 'Escape':
        if (menu !== null) { setMenu(null); return; }
        if (dragRef.current !== null) return;
        setSel(EMPTY_SEL); return;
      case 'Enter':
      case 'F2':
        if (!onSurface && e.key === 'Enter') return;
        e.preventDefault(); startEditing(); return;
      case ' ':
        if (!onSurface) return;
        e.preventDefault();
        if (!spaceRef.current) { spaceRef.current = true; setSpaceDown(true); }
        return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!onSurface || selRef.current.nodes.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        commit(translateNodes(docRef.current, topLevelSelection(docRef.current.nodes, selRef.current.nodes), dx, dy));
        return;
      }
      default:
    }
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === ' ') { spaceRef.current = false; setSpaceDown(false); }
  }

  useEffect(() => {
    const reset = (): void => { spaceRef.current = false; setSpaceDown(false); };
    window.addEventListener('blur', reset);
    return () => { window.removeEventListener('blur', reset); };
  }, []);

  // ── Clipboard and drop ─────────────────────────────────────────────────────

  function onCopy(e: React.ClipboardEvent<HTMLDivElement>, cut = false): void {
    if (isTypingTarget(e.target)) return;
    const payload = selectionPayload();
    if (payload === null) return;
    e.preventDefault();
    clipboardRef.current = payload;
    pasteCountRef.current = 0;
    e.clipboardData.setData('text/plain', JSON.stringify({ type: CLIP_TYPE, ...payload }));
    if (cut) deleteSelected();
  }

  function parseClip(text: string): { nodes: DiagramNode[]; edges: DiagramEdge[] } | null {
    if (!text.includes(CLIP_TYPE)) return null;
    try {
      const raw = JSON.parse(text) as { type?: unknown; nodes?: unknown; edges?: unknown };
      if (raw.type !== CLIP_TYPE || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
      const clean = normalizeDocument({ ...emptyDiagram(), nodes: raw.nodes as DiagramNode[], edges: raw.edges as DiagramEdge[] });
      return { nodes: clean.nodes, edges: clean.edges };
    } catch {
      return null;
    }
  }

  function pointerOrCenter(): P {
    const p = lastPointerRef.current;
    const v = docRef.current.viewport;
    if (p !== null) {
      const sp = worldToScreen(p, v);
      if (sp.x >= 0 && sp.y >= 0 && sp.x <= size.width && sp.y <= size.height) return p;
    }
    return viewCenter();
  }

  function onPaste(e: React.ClipboardEvent<HTMLDivElement>): void {
    if (isTypingTarget(e.target)) return;
    const dt = e.clipboardData;
    const files = [...dt.files];
    e.preventDefault();
    if (files.length > 0) {
      const images = files.filter((f) => f.type.startsWith('image/'));
      for (const f of files) if (!f.type.startsWith('image/')) notify('error', `“${f.name}” isn’t an image, so it can’t be pasted onto the diagram.`);
      if (images.length > 0) uploadFiles(images, pointerOrCenter());
      return;
    }
    const text = dt.getData('text/plain');
    const clip = parseClip(text) ?? (text === '' ? clipboardRef.current : null);
    if (clip !== null) {
      pasteCountRef.current += 1;
      pastePayload(clip, PASTE_OFFSET * pasteCountRef.current);
      return;
    }
    const uri = dt.getData('text/uri-list');
    if (uri !== '' || looksLikeUrl(text) || /<img\b/i.test(dt.getData('text/html'))) { unsupportedPaste('url'); return; }
    if (text.trim() !== '') { unsupportedPaste('text'); return; }
    notify('info', 'Nothing on the clipboard can be pasted here.', { key: 'unsupported-paste' });
  }

  function acceptsDrop(dt: DataTransfer): boolean {
    return [...dt.types].some((t) => t === SHAPE_MIME || t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropHint) setDropHint(true);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    setDropHint(false);
    if (!acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const kind = e.dataTransfer.getData(SHAPE_MIME);
    if (kind !== '') {
      if ((PALETTE as readonly string[]).includes(kind)) addShape(kind as DiagramKind, at);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length > 0) {
      for (const f of files) if (!f.type.startsWith('image/')) notify('error', `“${f.name}” isn’t an image, so it can’t be added to the diagram.`);
      uploadFiles(files.filter((f) => f.type.startsWith('image/')), at);
      return;
    }
    const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (uri.trim() !== '') unsupportedPaste(looksLikeUrl(uri) ? 'url' : 'text');
  }

  // ── Derived render data ────────────────────────────────────────────────────

  const z = view.zoom;
  const inv = 1 / z;
  const ordered = useMemo(() => renderOrder(doc.nodes), [doc.nodes]);
  const selNodeSet = new Set(sel.nodes);
  const selEdgeSet = new Set(sel.edges);
  const selectedNodes = doc.nodes.filter((n) => selNodeSet.has(n.id));
  const selectedEdges = doc.edges.filter((x) => selEdgeSet.has(x.id));
  const singleNode = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : undefined;
  const singleEdge = selectedNodes.length === 0 && selectedEdges.length === 1 ? selectedEdges[0] : undefined;
  const topSelected = topLevelSelection(doc.nodes, sel.nodes);
  const routes = useMemo(() => new Map(doc.edges.map((x) => [x.id, edgeRoute(x, byId)] as const)), [doc.edges, byId]);
  const markerIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of doc.edges) if (!m.has(x.stroke)) m.set(x.stroke, `${markerBase}-arrow-${m.size}`);
    if (!m.has(DEFAULT_EDGE_STROKE)) m.set(DEFAULT_EDGE_STROKE, `${markerBase}-arrow-${m.size}`);
    return m;
  }, [doc.edges, markerBase]);
  const gridStep = GRID * z < 8 ? GRID * 5 * z : GRID * z;
  const busyDrag = drag !== null && drag.kind !== 'connect' && drag.kind !== 'endpoint';

  const portNodeIds = new Set<string>();
  if (!busyDrag) {
    if (hoverId !== null) portNodeIds.add(hoverId);
    if (singleNode !== undefined) portNodeIds.add(singleNode.id);
  }
  if (drag?.kind === 'connect') { portNodeIds.add(drag.sourceId); if (drag.targetId !== null) portNodeIds.add(drag.targetId); }
  if (drag?.kind === 'endpoint' && drag.targetId !== null) portNodeIds.add(drag.targetId);

  const selectionBounds = boundsOf([
    ...selectedNodes.map(nodeRect),
    ...selectedEdges.flatMap((x) => (routes.get(x.id) ?? []).map((pt) => ({ x: pt.x, y: pt.y, width: 0, height: 0 }))),
  ]);
  let toolbarPos: { left: number; top: number } | null = null;
  if (selectionBounds !== null && drag === null && editing === null && size.width > 0) {
    const a = worldToScreen({ x: selectionBounds.x, y: selectionBounds.y }, view);
    const b = worldToScreen({ x: selectionBounds.x + selectionBounds.width, y: selectionBounds.y + selectionBounds.height }, view);
    const left = Math.min(Math.max((a.x + b.x) / 2, 150), Math.max(150, size.width - 150));
    let top = a.y - 52;
    if (top < 8) top = b.y + 12;
    top = Math.min(Math.max(top, 8), Math.max(8, size.height - 56));
    toolbarPos = { left, top };
  }

  const editorBox = ((): { left: number; top: number; width: number; height: number; fontSize: number } | null => {
    if (editing === null) return null;
    if (editing.kind === 'edge') {
      const route = routes.get(editing.id);
      const edge = doc.edges.find((x) => x.id === editing.id);
      if (route === undefined || route === null || edge === undefined) return null;
      const m = worldToScreen(pointAlong(route, 0.5), view);
      return { left: m.x - 90, top: m.y - 18, width: 180, height: 36, fontSize: Math.max(11, 12 * z) };
    }
    const n = byId.get(editing.id);
    if (n === undefined) return null;
    const tl = worldToScreen({ x: n.x, y: n.y }, view);
    const fontSize = Math.max(11, n.fontSize * z);
    if (n.kind === 'container') return { left: tl.x, top: tl.y, width: n.width * z, height: Math.max(30, CONTAINER_HEADER * z), fontSize };
    if (n.kind === 'image') {
      const h = Math.max(30, captionHeight(n) * z);
      return { left: tl.x, top: tl.y + n.height * z - (n.label.trim() === '' ? 0 : h), width: Math.max(120, n.width * z), height: h, fontSize };
    }
    return { left: tl.x, top: tl.y, width: Math.max(80, n.width * z), height: Math.max(32, n.height * z), fontSize };
  })();

  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;
  const allFills = new Set(selectedNodes.map((n) => n.fill));
  const allStrokes = new Set(selectedNodes.map((n) => n.stroke));
  const allText = new Set(selectedNodes.map((n) => n.textColor));
  const fontSizes = selectedNodes.map((n) => n.fontSize);
  const fontSize = fontSizes.length > 0 ? Math.round(fontSizes.reduce((s, v) => s + v, 0) / fontSizes.length) : 14;
  const parentIds = new Set(topSelected.map((id) => byId.get(id)?.parentId ?? null));
  const commonParent = parentIds.size === 1 ? [...parentIds][0] ?? null : undefined;
  const hostOptions = doc.nodes.filter((n) => isContainerKind(n.kind) && topSelected.length > 0 && topSelected.every((id) => canParent(doc.nodes, id, n.id)));
  const edgeColours = new Set(selectedEdges.map((x) => x.stroke));
  const edgeRoutes = new Set(selectedEdges.map((x) => x.route));
  const edgeArrows = new Set(selectedEdges.map((x) => x.arrows));
  const allDashed = selectedEdges.length > 0 && selectedEdges.every((x) => x.dashed);
  const anyBends = selectedEdges.some((x) => x.waypoints.length > 0);
  const only = <T,>(s: Set<T>): T | undefined => (s.size === 1 ? [...s][0] : undefined);

  const sheetClass = [
    'dg-sheet',
    doc.grid ? 'dg-sheet--grid' : '',
    spaceDown || drag?.kind === 'pan' ? 'dg-sheet--panning' : '',
    drag?.kind === 'connect' || drag?.kind === 'endpoint' ? 'dg-sheet--connecting' : '',
    dropHint ? 'dg-sheet--drop' : '',
  ].filter(Boolean).join(' ');

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={rootRef}
      className="dg-editor"
      tabIndex={0}
      aria-label="Diagram editor"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onCopy={(e) => { onCopy(e); }}
      onCut={(e) => { onCopy(e, true); }}
      onPaste={onPaste}
    >
      <div className="dg-header">
        <input
          className="dg-header__title" value={title} aria-label="Diagram title"
          onChange={(e) => { setTitle(e.target.value); }}
          onBlur={() => { void renameDiagram(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(savedTitle); e.currentTarget.blur(); } }}
        />
        <span className="dg-header__type">Diagram</span>
        <SaveIndicator status={saveStatus} uploading={uploading} />
        <div className="dg-header__actions">
          <IconBtn label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => { stepHistory('undo'); }}><Undo size={16} /></IconBtn>
          <IconBtn label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => { stepHistory('redo'); }}><Redo size={16} /></IconBtn>
          <span className="dg-divider" aria-hidden="true" />
          <IconBtn label={doc.grid ? 'Hide grid and snapping' : 'Show grid and snap to it'} pressed={doc.grid} onClick={toggleGrid}><Grid size={16} /></IconBtn>
          <button type="button" className="dg-text-btn" aria-expanded={propertiesOpen} onClick={() => { setPropertiesOpen(!propertiesOpen); }}>Properties</button>
          <div className="dg-anchor">
            <button type="button" className={`dg-text-btn${menu === 'export' ? ' dg-text-btn--active' : ''}`} aria-expanded={menu === 'export'} aria-haspopup="dialog" onClick={() => { setMenu(menu === 'export' ? null : 'export'); }}>
              <Download size={16} /> Export
            </button>
            {menu === 'export' && (
              <div className="dg-popover dg-popover--end" role="dialog" aria-label="Export diagram">
                <section className="dg-popover__section">
                  <h3 className="dg-popover__heading">Format</h3>
                  <Segmented value={exportFormat} onChange={setExportFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' }]} label="Export format" />
                </section>
                <section className="dg-popover__section">
                  <h3 className="dg-popover__heading">Background</h3>
                  <Segmented value={exportBg} onChange={setExportBg} options={[{ value: 'white', label: 'White' }, { value: 'transparent', label: 'Transparent' }]} label="Export background" />
                  <label className="dg-check">
                    <input type="checkbox" className="dg-check__input" checked={exportGrid} onChange={(e) => { setExportGrid(e.target.checked); }} />
                    <span className="dg-check__label">Include grid</span>
                  </label>
                </section>
                <button type="button" className="dg-primary-btn" disabled={exporting || doc.nodes.length === 0} onClick={() => { void runExport(); }}>
                  {exporting ? <><InProgress size={16} className="dg-spin" /> Exporting…</> : <><Download size={16} /> Export {exportFormat.toUpperCase()}</>}
                </button>
                {doc.nodes.length === 0 && <p className="dg-popover__hint">Add something to the diagram to export it.</p>}
              </div>
            )}
          </div>
          <IconBtn label="Delete diagram" danger onClick={() => { void deleteDiagram(); }}><TrashCan size={16} /></IconBtn>
        </div>
      </div>

      {saveStatus === 'conflict' && (
        <div className="dg-banner dg-banner--warning" role="alert">
          <WarningAlt size={16} className="dg-banner__icon" />
          <span className="dg-banner__text">This diagram was changed somewhere else, so your latest edits haven’t been saved. They’re still here — keep them (replacing the other version) or reload the saved one.</span>
          <button type="button" className="dg-text-btn" onClick={() => { void overwriteWithMine(); }}>Keep my version</button>
          <button type="button" className="dg-text-btn" onClick={reloadFromServer}><Renew size={16} /> Reload saved</button>
        </div>
      )}
      {saveStatus === 'error' && (
        <div className="dg-banner dg-banner--error" role="alert">
          <ErrorFilled size={16} className="dg-banner__icon" />
          <span className="dg-banner__text">Couldn’t save the diagram{saveError === null ? '' : `: ${saveError}`}. Your changes are kept here.</span>
          <button type="button" className="dg-text-btn" onClick={retrySave}><Renew size={16} /> Retry</button>
          <button type="button" className="dg-text-btn" onClick={reloadFromServer}>Reload saved</button>
        </div>
      )}

      <div className="dg-work-area">
      <div className="dg-body">
        <div className="dg-palette" role="toolbar" aria-orientation="vertical" aria-label="Shapes">
          {PALETTE.map((kind) => kind === 'image' ? (
            <div key={kind} className="dg-anchor">
              <button
                type="button" className={`dg-palette__item${menu === 'image' ? ' dg-palette__item--active' : ''}`}
                title="Image or icon" aria-label="Add image or icon" aria-expanded={menu === 'image'} aria-haspopup="dialog"
                onClick={() => { setMenu(menu === 'image' ? null : 'image'); }}
              >
                <ImageIcon size={20} />
              </button>
              {menu === 'image' && (
                <div className="dg-popover dg-popover--side" role="dialog" aria-label="Add image">
                  <h3 className="dg-popover__heading">Add an image</h3>
                  <DiagramIconPicker onPick={(file) => { setMenu(null); uploadFiles([file], viewCenter(), captionFromFileName(file.name)); }} />
                  <button type="button" className="dg-text-btn dg-text-btn--block" onClick={() => { setMenu(null); chooseFile(); }}>
                    <Upload size={16} /> Upload from computer…
                  </button>
                  <p className="dg-popover__hint">Paste an image (Ctrl+V) or drop image files onto the sheet. PNG or SVG up to 5 MiB.</p>
                </div>
              )}
            </div>
          ) : (
            <button
              key={kind} type="button" className="dg-palette__item" draggable
              title={`${KIND_LABEL[kind]} — click to add, or drag onto the sheet`} aria-label={`Add ${KIND_LABEL[kind]}`}
              onClick={() => { addShape(kind); }}
              onDragStart={(e) => { e.dataTransfer.setData(SHAPE_MIME, kind); e.dataTransfer.effectAllowed = 'copy'; }}
            >
              <ShapeGlyph kind={kind} />
            </button>
          ))}
        </div>

        <div ref={sheetRef} className={sheetClass} onDragOver={onDragOver} onDragLeave={() => { setDropHint(false); }} onDrop={onDrop}>
          <svg
            ref={svgRef} className="dg-canvas" role="application" aria-label="Diagram sheet"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={(e) => { endDrag(e, false); }} onPointerCancel={(e) => { endDrag(e, true); }}
            onPointerLeave={() => { if (dragRef.current === null) setHoverId(null); }}
            onDoubleClick={onDoubleClick} onContextMenu={(e) => { if (dragRef.current?.kind === 'pan') e.preventDefault(); }}
          >
            <defs>
              <pattern id={`${markerBase}-grid`} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse" x={(view.x % gridStep) - 1} y={(view.y % gridStep) - 1}>
                <circle cx={1} cy={1} r={1} className="dg-canvas__dot" />
              </pattern>
              {[...markerIds].map(([colour, id]) => (
                <marker key={id} id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={20 / 3} markerHeight={20 / 3} markerUnits="strokeWidth" orient="auto-start-reverse">
                  <path d="M0,1 L10,5 L0,9 z" fill={diagramEditorInk(colour)} />
                </marker>
              ))}
            </defs>
            {doc.grid && <rect className="dg-canvas__grid" x={0} y={0} width="100%" height="100%" fill={`url(#${markerBase}-grid)`} />}
            <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
              {ordered.map((n) => (
                <NodeShape key={n.id} node={n} asset={n.assetId === null ? undefined : assets[n.assetId]} selected={selNodeSet.has(n.id)} editing={editing?.kind === 'node' && editing.id === n.id} />
              ))}
              {doc.edges.map((edge) => {
                const route = routes.get(edge.id);
                if (route === undefined || route === null) return null;
                const d = pathD(route);
                const marker = `url(#${markerIds.get(edge.stroke) ?? ''})`;
                const mid = pointAlong(route, 0.5);
                const lines = edge.label.trim() === '' || (editing?.kind === 'edge' && editing.id === edge.id) ? [] : wrapText(edge.label, 160, 12, 3);
                const labelW = Math.max(...lines.map((l) => l.length), 0) * 12 * 0.56 + 12;
                const labelH = lines.length * 15 + 6;
                return (
                  <g key={edge.id} className={`dg-edge${selEdgeSet.has(edge.id) ? ' dg-edge--selected' : ''}`} data-dg="edge" data-id={edge.id}>
                    <path className="dg-edge__hit" d={d} strokeWidth={Math.max(14 * inv, (edge.strokeWidth ?? 1.5) + 6 * inv)} />
                    <path className="dg-edge__halo" d={d} style={{ strokeWidth: (edge.strokeWidth ?? 1.5) * z + 4 }} />
                    <path
                      className="dg-edge__line" d={d} stroke={diagramEditorInk(edge.stroke)}
                      strokeWidth={edge.strokeWidth ?? 1.5}
                      strokeDasharray={edge.dashed ? '6 4' : undefined}
                      markerEnd={edge.arrows === 'none' ? undefined : marker}
                      markerStart={edge.arrows === 'both' ? marker : undefined}
                    />
                    {lines.length > 0 && (
                      <g className="dg-edge__label">
                        <rect x={mid.x - labelW / 2} y={mid.y - labelH / 2} width={labelW} height={labelH} rx={3} />
                        <text x={mid.x} y={mid.y - labelH / 2 + 3 + 12} fontSize={12} textAnchor="middle" fill={diagramEditorInk(edge.stroke === 'none' ? '#161616' : edge.stroke)}>
                          {lines.map((l, i) => <tspan key={i} x={mid.x} dy={i === 0 ? 0 : 15}>{l}</tspan>)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {dropTargetId !== null && byId.get(dropTargetId) !== undefined && (() => {
                const host = byId.get(dropTargetId);
                return host === undefined ? null : <rect className="dg-drop-target" x={host.x} y={host.y} width={host.width} height={host.height} />;
              })()}
              {selectedNodes.map((n) => (
                <rect key={`sel-${n.id}`} className="dg-selection-box" x={n.x - 3 * inv} y={n.y - 3 * inv} width={n.width + 6 * inv} height={n.height + 6 * inv} />
              ))}
              {singleNode !== undefined && !busyDrag && RESIZE_HANDLES.map((h) => {
                const pt = handlePoint(nodeRect(singleNode), h);
                return <rect key={h} className={`dg-handle dg-handle--${h}`} data-dg="resize" data-id={singleNode.id} data-handle={h} x={pt.x - 4 * inv} y={pt.y - 4 * inv} width={8 * inv} height={8 * inv} />;
              })}
              {[...portNodeIds].map((id) => {
                const n = byId.get(id);
                if (n === undefined) return null;
                const r = nodeRect(n);
                return PORTS.map((port) => {
                  const pt = portPoint(r, port, n.kind);
                  const active = (drag?.kind === 'connect' || drag?.kind === 'endpoint') && drag.targetId === id && drag.targetPort === port;
                  return (
                    <circle
                      key={`${id}-${port}`} className={`dg-port${active ? ' dg-port--active' : ''}`} data-dg="port" data-id={id} data-port={port}
                      cx={pt.x} cy={pt.y} r={5 * inv}
                    ><title>Drag to connect</title></circle>
                  );
                });
              })}
              {singleEdge !== undefined && drag === null && (() => {
                const route = routes.get(singleEdge.id);
                if (route === undefined || route === null || route.length < 2) return null;
                const first = route[0];
                const last = route[route.length - 1];
                const mids: P[] = [];
                for (let i = 0; i < route.length - 1; i += 1) {
                  const a = route[i];
                  const b = route[i + 1];
                  if (a !== undefined && b !== undefined && distance(a, b) * z > 28) mids.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
                }
                return (
                  <g className="dg-edge-handles">
                    {mids.map((m, i) => <circle key={`m${i}`} className="dg-midpoint" data-dg="midpoint" data-id={singleEdge.id} cx={m.x} cy={m.y} r={4 * inv}><title>Drag to add a bend</title></circle>)}
                    {singleEdge.waypoints.map((w, i) => <rect key={`b${i}`} className="dg-bend" data-dg="bend" data-id={singleEdge.id} data-index={i} x={w.x - 5 * inv} y={w.y - 5 * inv} width={10 * inv} height={10 * inv} transform={`rotate(45 ${w.x} ${w.y})`}><title>Drag to move · double-click to remove</title></rect>)}
                    {first !== undefined && <circle className="dg-endpoint" data-dg="endpoint" data-id={singleEdge.id} data-end="source" cx={first.x} cy={first.y} r={6 * inv}><title>Drag onto a shape to reconnect</title></circle>}
                    {last !== undefined && <circle className="dg-endpoint" data-dg="endpoint" data-id={singleEdge.id} data-end="target" cx={last.x} cy={last.y} r={6 * inv}><title>Drag onto a shape to reconnect</title></circle>}
                  </g>
                );
              })()}
              {drag?.kind === 'marquee' && (() => {
                const r = normalizeRect(drag.start, drag.current);
                return <rect className="dg-marquee" x={r.x} y={r.y} width={r.width} height={r.height} />;
              })()}
              {(drag?.kind === 'connect' || drag?.kind === 'endpoint') && (() => {
                let from: P | null = null;
                if (drag.kind === 'connect') {
                  const s = byId.get(drag.sourceId);
                  if (s !== undefined) from = portPoint(nodeRect(s), drag.sourcePort, s.kind);
                } else {
                  const route = routes.get(drag.edgeId);
                  if (route !== undefined && route !== null) from = (drag.end === 'source' ? route[route.length - 1] : route[0]) ?? null;
                }
                const t = drag.targetId === null ? undefined : byId.get(drag.targetId);
                const to = t !== undefined && drag.targetPort !== null ? portPoint(nodeRect(t), drag.targetPort, t.kind) : drag.current;
                return from === null ? null : <line className="dg-preview-line" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
              })()}
            </g>
          </svg>

          {doc.nodes.length === 0 && (
            <div className="dg-empty">
              <p className="dg-empty__title">Start your diagram</p>
              <p className="dg-empty__text">Click a shape on the left, drag it onto the sheet, or double-click anywhere. Paste or drop images to add icons.</p>
            </div>
          )}

          {toolbarPos !== null && selectedNodes.length > 0 && (
            <div className="dg-context" role="toolbar" aria-label="Shape actions" style={{ left: toolbarPos.left, top: toolbarPos.top }} onPointerDown={(e) => { e.stopPropagation(); }}>
              {singleNode !== undefined && <IconBtn label={singleNode.kind === 'image' ? 'Edit caption (Enter)' : 'Edit label (Enter)'} onClick={startEditing}><Edit size={16} /></IconBtn>}
              <div className="dg-anchor">
                <IconBtn label="Style" pressed={menu === 'style'} onClick={() => { setMenu(menu === 'style' ? null : 'style'); }}><ColorPalette size={16} /></IconBtn>
                {menu === 'style' && (
                  <div className="dg-popover dg-popover--context" role="dialog" aria-label="Shape style">
                    <Swatches label="Fill" colours={FILLS} value={diagramEditorFill(only(allFills) ?? '')} onPick={(c) => { updateNodes(sel.nodes, (n) => ({ ...n, textColor: diagramEditorNodeColours(n).textColor, fill: c })); }} />
                    <Swatches label="Border" colours={STROKES} value={only(allStrokes)} onPick={(c) => { updateNodes(sel.nodes, (n) => ({ ...n, stroke: c })); }} />
                    <Swatches label="Text" colours={TEXT_COLOURS} value={only(allText)} onPick={(c) => { updateNodes(sel.nodes, (n) => ({ ...n, textColor: c })); }} />
                    <div className="dg-stepper">
                      <span className="dg-stepper__label">Text size</span>
                      <button type="button" className="dg-stepper__btn" aria-label="Smaller text" disabled={fontSize <= FONT_MIN} onClick={() => { updateNodes(sel.nodes, (n) => ({ ...n, fontSize: Math.max(FONT_MIN, n.fontSize - 1) })); }}>−</button>
                      <output className="dg-stepper__value" aria-live="polite">{fontSize}</output>
                      <button type="button" className="dg-stepper__btn" aria-label="Larger text" disabled={fontSize >= FONT_MAX} onClick={() => { updateNodes(sel.nodes, (n) => ({ ...n, fontSize: Math.min(FONT_MAX, n.fontSize + 1) })); }}>+</button>
                    </div>
                  </div>
                )}
              </div>
              <div className="dg-anchor">
                <IconBtn label="Arrange and nest" pressed={menu === 'arrange'} onClick={() => { setMenu(menu === 'arrange' ? null : 'arrange'); }}><Layers size={16} /></IconBtn>
                {menu === 'arrange' && (
                  <div className="dg-popover dg-popover--context" role="dialog" aria-label="Arrange">
                    <section className="dg-popover__section">
                      <h3 className="dg-popover__heading">Order</h3>
                      <div className="dg-popover__row">
                        <IconBtn label="Bring to front" onClick={() => { arrange('front'); }}><BringToFront size={16} /></IconBtn>
                        <IconBtn label="Bring forward" onClick={() => { arrange('forward'); }}><BringForward size={16} /></IconBtn>
                        <IconBtn label="Send backward" onClick={() => { arrange('backward'); }}><SendBackward size={16} /></IconBtn>
                        <IconBtn label="Send to back" onClick={() => { arrange('back'); }}><SendToBack size={16} /></IconBtn>
                      </div>
                    </section>
                    {topSelected.length >= 2 && (
                      <section className="dg-popover__section">
                        <h3 className="dg-popover__heading">Align</h3>
                        <div className="dg-popover__row">
                          <IconBtn label="Align left" onClick={() => { align('left'); }}><AlignHorizontalLeft size={16} /></IconBtn>
                          <IconBtn label="Align centres horizontally" onClick={() => { align('center'); }}><AlignHorizontalCenter size={16} /></IconBtn>
                          <IconBtn label="Align right" onClick={() => { align('right'); }}><AlignHorizontalRight size={16} /></IconBtn>
                          <IconBtn label="Align top" onClick={() => { align('top'); }}><AlignVerticalTop size={16} /></IconBtn>
                          <IconBtn label="Align middles vertically" onClick={() => { align('middle'); }}><AlignVerticalCenter size={16} /></IconBtn>
                          <IconBtn label="Align bottom" onClick={() => { align('bottom'); }}><AlignVerticalBottom size={16} /></IconBtn>
                        </div>
                      </section>
                    )}
                    {topSelected.length >= 3 && (
                      <section className="dg-popover__section">
                        <h3 className="dg-popover__heading">Distribute</h3>
                        <div className="dg-popover__row">
                          <IconBtn label="Distribute horizontally" onClick={() => { distribute('horizontal'); }}><DistributeHorizontalCenter size={16} /></IconBtn>
                          <IconBtn label="Distribute vertically" onClick={() => { distribute('vertical'); }}><DistributeVerticalCenter size={16} /></IconBtn>
                        </div>
                      </section>
                    )}
                    <section className="dg-popover__section">
                      <h3 className="dg-popover__heading">Nesting</h3>
                      <label className="dg-field">
                        <span className="dg-field__label">Inside</span>
                        <select
                          className="dg-select" value={commonParent === undefined ? '__mixed' : commonParent ?? ''}
                          onChange={(e) => { if (e.target.value !== '__mixed') nestInto(e.target.value === '' ? null : e.target.value); }}
                        >
                          {commonParent === undefined && <option value="__mixed" disabled>Mixed</option>}
                          <option value="">Nothing (top level)</option>
                          {hostOptions.map((n) => <option key={n.id} value={n.id}>{n.label.trim() === '' ? KIND_LABEL[n.kind] : n.label} ({KIND_LABEL[n.kind].toLowerCase()})</option>)}
                        </select>
                      </label>
                      <button type="button" className="dg-text-btn dg-text-btn--block" onClick={wrapInContainer}><Group size={16} /> Group in a container</button>
                    </section>
                  </div>
                )}
              </div>
              {singleNode?.kind === 'image' && <IconBtn label="Replace image" onClick={() => { chooseFile(singleNode.id); }}><Upload size={16} /></IconBtn>}
              <span className="dg-divider" aria-hidden="true" />
              <IconBtn label="Duplicate (Ctrl+D)" onClick={duplicate}><Copy size={16} /></IconBtn>
              <IconBtn label="Delete (Del)" danger onClick={deleteSelected}><TrashCan size={16} /></IconBtn>
            </div>
          )}

          {toolbarPos !== null && selectedNodes.length === 0 && selectedEdges.length > 0 && (
            <div className="dg-context" role="toolbar" aria-label="Connector actions" style={{ left: toolbarPos.left, top: toolbarPos.top }} onPointerDown={(e) => { e.stopPropagation(); }}>
              {singleEdge !== undefined && <IconBtn label="Edit label (Enter)" onClick={startEditing}><Edit size={16} /></IconBtn>}
              <Segmented
                label="Connector route" value={only(edgeRoutes) ?? ''} compact
                options={[{ value: 'straight', label: 'Straight', glyph: <LineGlyph kind="straight" /> }, { value: 'orthogonal', label: 'Elbow', glyph: <LineGlyph kind="orthogonal" /> }]}
                onChange={(v) => { updateEdges(sel.edges, (x) => ({ ...x, route: v })); }}
              />
              <Segmented
                label="Arrowheads" value={only(edgeArrows) ?? ''} compact
                options={[{ value: 'none', label: 'No arrows', glyph: <LineGlyph kind="none" /> }, { value: 'end', label: 'Arrow at end', glyph: <LineGlyph kind="end" /> }, { value: 'both', label: 'Arrows at both ends', glyph: <LineGlyph kind="both" /> }]}
                onChange={(v) => { updateEdges(sel.edges, (x) => ({ ...x, arrows: v })); }}
              />
              <IconBtn label={allDashed ? 'Solid line' : 'Dashed line'} pressed={allDashed} onClick={() => { updateEdges(sel.edges, (x) => ({ ...x, dashed: !allDashed })); }}><LineGlyph kind="dashed" /></IconBtn>
              <div className="dg-anchor">
                <IconBtn label="Line colour" pressed={menu === 'edge-colour'} onClick={() => { setMenu(menu === 'edge-colour' ? null : 'edge-colour'); }}>
                  <span className="dg-colour-dot" style={{ background: only(edgeColours) ?? 'transparent' }} />
                </IconBtn>
                {menu === 'edge-colour' && (
                  <div className="dg-popover dg-popover--context" role="dialog" aria-label="Line colour">
                    <Swatches label="Line colour" colours={EDGE_COLOURS} value={only(edgeColours)} onPick={(c) => { updateEdges(sel.edges, (x) => ({ ...x, stroke: c })); }} />
                  </div>
                )}
              </div>
              {anyBends && <IconBtn label="Remove bends" onClick={() => { updateEdges(sel.edges, (x) => ({ ...x, waypoints: [] })); }}><Reset size={16} /></IconBtn>}
              <span className="dg-divider" aria-hidden="true" />
              <IconBtn label="Delete (Del)" danger onClick={deleteSelected}><TrashCan size={16} /></IconBtn>
            </div>
          )}

          {editing !== null && editorBox !== null && (
            <LabelEditor
              key={`${editing.kind}:${editing.id}`} initial={editing.value} box={editorBox}
              multiline={editing.kind === 'node' && byId.get(editing.id)?.kind !== 'image'}
              onCommit={(value) => { commitLabel({ ...editing, value }); }}
              onCancel={() => { setEditing(null); rootRef.current?.focus({ preventScroll: true }); }}
            />
          )}

          <div className="dg-zoom" role="toolbar" aria-label="Zoom">
            <IconBtn label="Zoom out" disabled={z <= MIN_ZOOM} onClick={() => { zoomBy(1 / ZOOM_STEP); }}><ZoomOut size={16} /></IconBtn>
            <button type="button" className="dg-zoom__value" title="Reset zoom to 100%" onClick={() => { setView(zoomAt(view, { x: size.width / 2, y: size.height / 2 }, 1)); }}>{Math.round(z * 100)}%</button>
            <IconBtn label="Zoom in" disabled={z >= MAX_ZOOM} onClick={() => { zoomBy(ZOOM_STEP); }}><ZoomIn size={16} /></IconBtn>
            <IconBtn label="Fit diagram to view" disabled={doc.nodes.length === 0} onClick={() => { fit(); }}><FitToScreen size={16} /></IconBtn>
          </div>

          {notices.length > 0 && (
            <div className="dg-notices">
              {notices.map((n) => (
                <div key={n.id} className={`dg-notice dg-notice--${n.kind}`} role={n.kind === 'error' ? 'alert' : 'status'}>
                  {n.kind === 'error' ? <ErrorFilled size={16} className="dg-notice__icon" /> : <WarningAlt size={16} className="dg-notice__icon" />}
                  <span className="dg-notice__text">{n.message}</span>
                  {n.action !== undefined && (
                    <button type="button" className="dg-notice__action" onClick={() => { n.action?.run(); dismiss(n.id); }}>{n.action.label}</button>
                  )}
                  <button type="button" className="dg-notice__close" aria-label="Dismiss" onClick={() => { dismiss(n.id); }}><Close size={16} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {propertiesOpen && <aside className="dg-properties" aria-label="Diagram properties">
        <div className="dg-properties__heading"><h3>Properties</h3><IconBtn label="Close properties" onClick={() => { setPropertiesOpen(false); }}><Close size={16} /></IconBtn></div>
        {singleNode !== undefined || singleEdge !== undefined ? <DiagramProperties
          key={singleNode?.id ?? singleEdge?.id}
          item={(singleNode ?? singleEdge)!}
          kind={singleNode === undefined ? 'Connector' : KIND_LABEL[singleNode.kind]}
          titleLimit={singleNode === undefined ? 500 : 2000}
          onFontSizeChange={(fontSize) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, fontSize }));
          }}
          onBackgroundChange={(fill) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, textColor: diagramEditorNodeColours(n).textColor, fill }));
          }}
          onBorderChange={(border) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, ...border }));
          }}
          onThicknessChange={(strokeWidth) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, strokeWidth }));
            else if (singleEdge !== undefined) updateEdges([singleEdge.id], edge => ({ ...edge, strokeWidth }));
          }}
          onAlignmentChange={(alignment) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, ...alignment }));
          }}
          onChange={(field, value, first) => {
            const current = docRef.current;
            const id = singleNode?.id ?? singleEdge?.id;
            const next = singleNode !== undefined
              ? { ...current, nodes: current.nodes.map((n) => n.id !== id ? n : field === 'label' ? setNodeLabel(n, value) : { ...n, description: value }) }
              : { ...current, edges: current.edges.map((edge) => edge.id !== id ? edge : { ...edge, [field]: value }) };
            if (first) commit(next);
            else { setDoc(next); markDirty(SAVE_DELAY_MS); }
          }}
        /> : <p className="dg-properties__empty">{sel.nodes.length + sel.edges.length > 1 ? 'Select one shape or connector to edit its properties.' : 'Select a shape or connector to edit its title and description.'}</p>}
        <DiagramNoteLinks canvasId={canvasId} notes={canvas?.linkedNotes ?? []} onOpenNote={onOpenNote} />
      </aside>}
      </div>

      <input
        ref={fileInputRef} type="file" accept="image/png,image/svg+xml" multiple hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          const replaceId = replaceTargetRef.current;
          replaceTargetRef.current = null;
          e.target.value = '';
          if (replaceId !== null && files[0] !== undefined) { void uploadImage(files[0], { replaceId }); return; }
          uploadFiles(files, viewCenter());
        }}
      />
    </div>
  );
};

function DiagramProperties({ item, kind, titleLimit, onChange, onAlignmentChange, onThicknessChange, onBorderChange, onBackgroundChange, onFontSizeChange }: {
  item: DiagramNode | DiagramEdge; kind: string; titleLimit: number;
  onChange: (field: 'label' | 'description', value: string, first: boolean) => void;
  onAlignmentChange: (alignment: Partial<Pick<DiagramNode, 'textAlign' | 'textVerticalAlign'>>) => void;
  onThicknessChange: (strokeWidth: number) => void;
  onBorderChange: (border: Partial<Pick<DiagramNode, 'stroke' | 'strokeStyle'>>) => void;
  onBackgroundChange: (fill: string) => void;
  onFontSizeChange: (fontSize: number) => void;
}): React.ReactElement {
  const firstEdit = useRef(true);
  const change = (field: 'label' | 'description', value: string): void => {
    onChange(field, value, firstEdit.current);
    firstEdit.current = false;
  };
  return <div className="dg-properties__fields">
    <p className="dg-properties__kind">{kind}</p>
    <label className="dg-properties__field">Title
      <textarea aria-label="Shape or connector title" rows={2} maxLength={titleLimit} value={item.label}
        onFocus={() => { firstEdit.current = true; }} onChange={(e) => { change('label', e.target.value); }} />
    </label>
    <div className="dg-properties__border">
    {'kind' in item && <>
      <Swatches label="Background colour" colours={FILLS} value={diagramEditorFill(item.fill)}
        onPick={onBackgroundChange} />
      <Swatches label="Border colour" colours={STROKES} value={item.stroke}
        onPick={(stroke) => { onBorderChange({ stroke }); }} />
      <div className="dg-properties__field">
        <span>Border style</span>
        <Segmented label="Border style" value={item.strokeStyle ?? 'solid'}
          options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }]}
          onChange={(strokeStyle) => { onBorderChange({ strokeStyle }); }} />
      </div>
    </>}
    <label className="dg-properties__field">{'kind' in item ? 'Border thickness' : 'Line thickness'}
      <select aria-label={'kind' in item ? 'Border thickness' : 'Line thickness'} value={item.strokeWidth ?? 1.5}
        onChange={(event) => { onThicknessChange(Number(event.target.value)); }}>
        {[0.5, 1, 1.5, 2, 3, 4, 6].map(width => <option key={width} value={width}>{width} px</option>)}
        {item.strokeWidth !== undefined && ![0.5, 1, 1.5, 2, 3, 4, 6].includes(item.strokeWidth)
          && <option value={item.strokeWidth}>{item.strokeWidth} px</option>}
      </select>
    </label>
    </div>
    <label className="dg-properties__field">Description
      <textarea aria-label="Shape or connector description" rows={8} maxLength={10000} value={item.description ?? ''}
        onFocus={() => { firstEdit.current = true; }} onChange={(e) => { change('description', e.target.value); }} />
    </label>
    {'kind' in item && <div className="dg-properties__alignment">
      <label className="dg-properties__field">Text size
        <select aria-label="Text size" value={item.fontSize}
          onChange={(event) => { onFontSizeChange(Number(event.target.value)); }}>
          {Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i)
            .map(size => <option key={size} value={size}>{size} px</option>)}
        </select>
      </label>
      <span>Horizontal text alignment</span>
      <Segmented label="Text horizontal alignment" value={item.textAlign ?? (item.kind === 'container' ? 'left' : 'center')}
        options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]}
        onChange={(value) => { onAlignmentChange({ textAlign: value }); }} />
      <span>Vertical text alignment</span>
      <Segmented label="Text vertical alignment" value={item.textVerticalAlign ?? 'middle'}
        options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]}
        onChange={(value) => { onAlignmentChange({ textVerticalAlign: value }); }} />
    </div>}
    <p className="dg-properties__hint">Title is shown on the diagram. Description is saved with this item but not displayed on the drawing. Changes save automatically.</p>
  </div>;
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function handlePoint(r: Rect, h: ResizeHandle): P {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2;
  return { x, y };
}

function TextLines({ lines, cx, cy, fontSize, color, anchorX, anchor = 'middle', weight }: {
  lines: string[]; cx: number; cy: number; fontSize: number; color: string; anchorX?: number | undefined;
  anchor?: 'start' | 'middle' | 'end' | undefined; weight?: number | undefined;
}): React.ReactElement | null {
  if (lines.length === 0) return null;
  const lineH = fontSize * 1.25;
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  const x = anchorX ?? cx;
  return (
    <text className="dg-node__label" x={x} y={startY} fontSize={fontSize} fill={color} textAnchor={anchor} dominantBaseline="central" fontWeight={weight}>
      {lines.map((l, i) => <tspan key={i} x={x} y={startY + i * lineH}>{l}</tspan>)}
    </text>
  );
}

interface NodeShapeProps { node: DiagramNode; asset: AssetState | undefined; selected: boolean; editing: boolean }

const NodeShape = React.memo(function NodeShape({ node: n, asset, selected, editing }: NodeShapeProps): React.ReactElement {
  const { x, y, width: w, height: h, fontSize: fs } = n;
  const { fill, stroke, textColor: color } = diagramEditorNodeColours(n);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const label = editing ? '' : n.label;
  const border = { strokeDasharray: diagramBorderDash(n), strokeLinecap: n.strokeStyle === 'dotted' ? 'round' as const : 'butt' as const };
  const common = { className: 'dg-node__body', fill, stroke, strokeWidth: n.strokeWidth ?? 1.5, ...border, pointerEvents: 'all' as const };
  let body: React.ReactNode;
  let text: React.ReactNode = null;
  const maxLines = (avail: number): number => Math.max(1, Math.floor(avail / (fs * 1.25)));
  switch (n.kind) {
    case 'document':
      body = <path {...common} d={documentShapePath(n)} />;
      break;
    case 'process':
      body = <rect {...common} x={x} y={y} width={w} height={h} rx={6} />;
      text = <TextLines lines={wrapText(label, w - 16, fs, maxLines(h - 8))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'decision':
      body = <polygon {...common} points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`} />;
      text = <TextLines lines={wrapText(label, w * 0.62, fs, maxLines(h * 0.6))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'terminator':
      body = <rect {...common} x={x} y={y} width={w} height={h} rx={Math.min(h, w) / 2} />;
      text = <TextLines lines={wrapText(label, w - h * 0.6, fs, maxLines(h - 8))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'text':
      body = <rect {...common} x={x} y={y} width={w} height={h} rx={2} />;
      text = <TextLines lines={wrapText(label, w - 8, fs, maxLines(h))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'image': {
      const box = imageBox(n);
      let picture: React.ReactNode;
      if (asset?.status === 'ready') {
        picture = <image className="dg-node__image" href={asset.url} x={box.x} y={box.y} width={box.width} height={box.height} preserveAspectRatio="xMidYMid meet" />;
      } else {
        const msg = n.assetId === null ? 'No image' : asset?.status === 'error' ? 'Image unavailable' : 'Loading image…';
        picture = (
          <g className={`dg-node__placeholder${asset?.status === 'error' ? ' dg-node__placeholder--error' : ''}`}>
            <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={4} />
            <text x={box.x + box.width / 2} y={box.y + box.height / 2} fontSize={11} textAnchor="middle" dominantBaseline="central">{msg}</text>
          </g>
        );
      }
      body = <>{<rect {...common} x={x} y={y} width={w} height={h} rx={4} />}{picture}</>;
      if (label.trim() !== '') {
        const capH = captionHeight(n);
        text = <TextLines lines={wrapText(label, w - 4, fs, 1)} cx={cx} cy={y + h - capH / 2 - 2} fontSize={fs} color={color} />;
      }
      break;
    }
    case 'container':
      body = (
        <>
          <rect {...common} x={x} y={y} width={w} height={h} rx={4} />
          <line className="dg-node__divider" x1={x} y1={y + CONTAINER_HEADER} x2={x + w} y2={y + CONTAINER_HEADER} stroke={stroke} strokeWidth={n.strokeWidth ?? 1} {...border} />
        </>
      );
      text = <TextLines lines={wrapText(label, w - 20, fs, 1)} cx={cx} cy={y + CONTAINER_HEADER / 2} anchorX={x + 10} anchor="start" fontSize={fs} color={color} weight={600} />;
      break;
    case 'swimlane': {
      const bandX = x + SWIMLANE_HEADER / 2;
      const lines = wrapText(label, h - 16, fs, 1);
      body = (
        <>
          <rect {...common} x={x} y={y} width={w} height={h} />
          <rect className="dg-node__band" x={x} y={y} width={SWIMLANE_HEADER} height={h} fill={stroke === 'none' ? '#e0e0e0' : stroke} fillOpacity={0.1} stroke={stroke} strokeWidth={n.strokeWidth ?? 1.5} {...border} pointerEvents="none" />
        </>
      );
      text = lines.length === 0 ? null : (
        <text className="dg-node__label" x={bandX} y={cy} fontSize={fs} fill={color} textAnchor="middle" dominantBaseline="central" fontWeight={600} transform={`rotate(-90 ${bandX} ${cy})`}>{lines[0]}</text>
      );
      break;
    }
  }
  if (n.kind === 'document' || n.textAlign !== undefined || n.textVerticalAlign !== undefined) {
    const layout = diagramTextLayout({ ...n, label });
    text = <TextLines lines={layout.lines} cx={layout.x} cy={layout.y} anchor={layout.anchor} fontSize={fs} color={color} weight={layout.weight} />;
  }
  return (
    <g className={`dg-node dg-node--${n.kind}${n.stroke === 'none' ? ' dg-node--borderless' : ''}${selected ? ' dg-node--selected' : ''}`} data-dg="node" data-id={n.id}>
      {body}
      {text}
    </g>
  );
});

function ShapeGlyph({ kind }: { kind: DiagramKind }): React.ReactElement {
  let shape: React.ReactNode;
  switch (kind) {
    case 'process': shape = <rect x={2} y={5} width={16} height={10} rx={2} />; break;
    case 'decision': shape = <polygon points="10,2 18,10 10,18 2,10" />; break;
    case 'terminator': shape = <rect x={2} y={5} width={16} height={10} rx={5} />; break;
    case 'document': shape = <path d={documentShapePath({ x: 2, y: 3, width: 16, height: 14 })} />; break;
    case 'text': shape = <path d="M4 5h12M10 5v11M8 16h4" />; break;
    case 'image': shape = <><rect x={2} y={3} width={16} height={14} rx={1} /><path d="M4 15l4-5 3 3 2-2 3 4" /></>; break;
    case 'container': shape = <><rect x={2} y={3} width={16} height={14} rx={1} /><path d="M2 7h16" /></>; break;
    case 'swimlane': shape = <><rect x={2} y={4} width={16} height={12} /><path d="M6 4v12" /></>; break;
  }
  return <svg className="dg-glyph" width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">{shape}</svg>;
}

function LineGlyph({ kind }: { kind: 'straight' | 'orthogonal' | 'none' | 'end' | 'both' | 'dashed' }): React.ReactElement {
  let shape: React.ReactNode;
  switch (kind) {
    case 'straight': shape = <path d="M2 14L14 2" />; break;
    case 'orthogonal': shape = <path d="M2 13h6V3h6" />; break;
    case 'none': shape = <path d="M2 8h12" />; break;
    case 'end': shape = <><path d="M2 8h11" /><path className="dg-glyph__fill" d="M14 8l-4-3v6z" /></>; break;
    case 'both': shape = <><path d="M3 8h10" /><path className="dg-glyph__fill" d="M14 8l-4-3v6z" /><path className="dg-glyph__fill" d="M2 8l4-3v6z" /></>; break;
    case 'dashed': shape = <path d="M1 8h3M6.5 8h3M12 8h3" />; break;
  }
  return <svg className="dg-glyph" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">{shape}</svg>;
}

function IconBtn({ label, onClick, disabled, pressed, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean | undefined; pressed?: boolean | undefined; danger?: boolean | undefined; children: React.ReactNode;
}): React.ReactElement {
  const cls = ['dg-btn', pressed === true ? 'dg-btn--active' : '', danger === true ? 'dg-btn--danger' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, compact }: {
  label: string; value: string; options: readonly { value: T; label: string; glyph?: React.ReactNode }[];
  onChange: (value: T) => void; compact?: boolean | undefined;
}): React.ReactElement {
  return (
    <div className={`dg-segment${compact === true ? ' dg-segment--compact' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.label} aria-label={o.label}
          className={`dg-segment__option${value === o.value ? ' dg-segment__option--selected' : ''}`}
          onClick={() => { onChange(o.value); }}
        >
          {o.glyph ?? o.label}
        </button>
      ))}
    </div>
  );
}

function Swatches({ label, colours, value, onPick }: { label: string; colours: readonly string[]; value: string | undefined; onPick: (c: string) => void }): React.ReactElement {
  return (
    <div className="dg-swatches">
      <span className="dg-swatches__label">{label}</span>
      <div className="dg-swatches__row" role="radiogroup" aria-label={label}>
        {colours.map((c) => (
          <button
            key={c} type="button" role="radio" aria-checked={value === c} title={c === 'none' ? 'None' : c} aria-label={c === 'none' ? 'None' : c}
            className={`dg-swatch${c === 'none' ? ' dg-swatch--none' : ''}${value === c ? ' dg-swatch--selected' : ''}`}
            style={c === 'none' ? undefined : { background: c }}
            onClick={() => { onPick(c); }}
          />
        ))}
      </div>
    </div>
  );
}

function SaveIndicator({ status, uploading }: { status: SaveStatus; uploading: number }): React.ReactElement {
  const text: Record<SaveStatus, string> = { saved: 'Saved', pending: 'Unsaved changes', saving: 'Saving…', error: 'Not saved', conflict: 'Conflict — not saved' };
  return (
    <span className="dg-status-group">
      <span className={`dg-status dg-status--${status}`} role="status" aria-live="polite">
        {status === 'saved' && <CheckmarkFilled size={16} className="dg-status__icon" />}
        {status === 'pending' && <span className="dg-status__dot" aria-hidden="true" />}
        {status === 'saving' && <InProgress size={16} className="dg-status__icon dg-spin" />}
        {status === 'error' && <ErrorFilled size={16} className="dg-status__icon" />}
        {status === 'conflict' && <WarningAlt size={16} className="dg-status__icon" />}
        {text[status]}
      </span>
      {uploading > 0 && (
        <span className="dg-status dg-status--saving" role="status">
          <InProgress size={16} className="dg-status__icon dg-spin" /> Uploading {uploading} image{uploading === 1 ? '' : 's'}…
        </span>
      )}
    </span>
  );
}

function LabelEditor({ initial, box, multiline, onCommit, onCancel }: {
  initial: string; box: { left: number; top: number; width: number; height: number; fontSize: number };
  multiline: boolean; onCommit: (value: string) => void; onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value); else onCancel();
  };
  return (
    <textarea
      ref={ref} className={`dg-label-editor${multiline ? '' : ' dg-label-editor--single'}`} aria-label="Label" value={value}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height, fontSize: box.fontSize }}
      onChange={(e) => { setValue(e.target.value); }}
      onBlur={() => { finish(true); }}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && (!multiline || !e.shiftKey)) { e.preventDefault(); finish(true); }
      }}
    />
  );
}
