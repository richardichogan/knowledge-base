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
import { createPortal } from 'react-dom';
import { diagramTextLayout } from './diagramText';
import { calloutLayout, DIAGRAM_CALLOUTS } from './diagramCallouts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  Undo, Redo, ZoomIn, ZoomOut, FitToScreen, Grid, Download, TrashCan, Copy, Edit, ColorPalette, Image as ImageIcon,
  Upload, Close, BringToFront, SendToBack, BringForward, SendBackward, AlignHorizontalLeft, AlignHorizontalCenter,
  AlignHorizontalRight, AlignVerticalTop, AlignVerticalCenter, AlignVerticalBottom, DistributeHorizontalCenter,
  DistributeVerticalCenter, Layers, Group, Renew, Reset, CheckmarkFilled, ErrorFilled, WarningAlt, InProgress,
  ChevronDown, ChevronRight, ChevronLeft, PresentationFile, RecentlyViewed, SpellCheck, ListNumbered, Chat, Legend,
  Bot, Policy, ArrangeVertical, Help,
} from '@carbon/icons-react';
import { api } from '../../services/api';
import { confirmDialog } from '../../services/appDialogs';
import { DiagramChatProvider, DiagramChatTarget, useDiagramChatScope } from './DiagramChatScope';
import type { AthenaPageContext } from '../../context/AthenaContext';
import type { CanvasFullApi } from '../../services/api';
import {
  emptyDiagram, DIAGRAM_CALLOUT_TYPES, DIAGRAM_ICON_KINDS, DIAGRAM_ICON_NAMES, type DiagramIconName, type DiagramArrowDirection, type DiagramCalloutType, type DiagramDocument, type DiagramEdge, type DiagramKind, type DiagramNode, type DiagramPoint,
  type DiagramPort, type DiagramSnapshot,
} from './diagramTypes';
import {
  PORTS, RESIZE_HANDLES, MIN_NODE_SIZE, containerHeader, SWIMLANE_HEADER, isContainerKind, nodeRect, boundsOf,
  documentBounds, diagramBounds, normalizeRect, rectContainsRect, portPoint, nearestPort, nodeMap, withDescendants, topLevelSelection,
  canParent, setParent, renderOrder, containerAt, translateNodes, resizeRect, snap, distance, edgeRoute, roundedRoutePath, decisionShapePath, hexagonShapePath,
  pointAlong, insertWaypoint, hitTestNode, hitTestEdge, nodesInRect, alignNodes, distributeNodes, reorderNodes,
  cloneSelection, removeSelection, normalizeDocument, screenToWorld, worldToScreen, clampZoom, zoomAt, fitViewport,
  wrapText, edgeLabelLayout, edgeLabelCenter, fitSize, documentShapePath, arrowShapePath, arrowAxis, lineGeometry, linePoints, type Rect, type ResizeHandle, type AlignMode, type OrderOp, type Viewport,
} from './diagramGeometry';
import { diagramLineJumpGeometry } from './diagramLineJumps';
import { DiagramIconPicker } from './DiagramIconPicker';
import { EntityLinks } from '../../components/connections/EntityLinks';
import { DiagramMetadata } from './DiagramMetadata';
import { DiagramDescriptionEditor } from './DiagramDescriptionEditor';
import { descriptionPlainText, descriptionRuns, formatDescription, styledLines } from './diagramMarkdown';
import { DIAGRAM_FILLS as FILLS, DIAGRAM_STROKES as STROKES, DIAGRAM_TEXT_COLOURS as TEXT_COLOURS } from './diagramPalette';
import { applyDiagramSelectionStyle, applyDiagramEdgeStyle, commonStyleValue, type DiagramNodeStyle, type DiagramEdgeStyle } from './diagramSelectionStyle';
import { DiagramDrilldown } from './DiagramDrilldown';
import { exportDiagram, diagramExportBlob, exportFileName, type DiagramExportFormat } from './diagramExport';
import { ShareEmailModal } from '../../components/ShareEmailModal';
import type { ShareEmailContent } from '../../types/shareEmail';
import { diagramMural } from './diagramMural';
import { MURAL_QUERY, loadMuralStatus } from '../../components/MuralIntegration';
import { MuralExportDestination } from '../../components/MuralExportDestination';
import { SettingsLink } from '../../navigation/SettingsLink';
import {
  addFootnote, collapseView, fixTextIssues, footnoteAnchor, footnoteBlock, footnoteHref, footnotesOf, presentationSteps, pruneFootnotes, setLegend,
  DEFAULT_LEGEND, FOOTNOTE_RADIUS, NOTE_FONT, NOTE_HEADING_FONT, type FootnoteBlock, type PresentationStep,
} from './diagramAnnotations';
import { DiagramFootnoteControls } from './DiagramFootnoteControls';
import { DiagramLegend } from './DiagramLegend';
import { DiagramVersions } from './DiagramVersions';
import { DiagramTextCheck } from './DiagramTextCheck';
import { diagramEditorNodeColours, diagramNodeRadius, diagramNodeShadow, diagramNodeStrokeWidth, diagramEdgeAppearance, DIAGRAM_SHADOWS } from './diagramTheme';
import { DiagramRoleBadge, diagramRoleLayout, DIAGRAM_ROLES, DIAGRAM_SHAPE_ICONS } from './DiagramRoleBadge';
import { diagramBorderDash } from './diagramStroke';
import { checkAiFlow, defaultGate, layoutAiFlow, nextLaneOrder, EDGE_STYLES, STEP_STYLES, STEP_TYPE_LABELS, type AiFlowSeverity } from './aiFlow';
import { AI_FLOW_STEP_TYPES, type AiFlowStepType, type DiagramType } from './diagramTypes';
import {
  aiEdgeChip, aiEdgeFindingAnchor, aiFindingAnchor, aiLaneOwnerLayout, aiStepChips, findingsByTarget, AI_CHIP_COLOURS, AI_CHIP_FONT,
  AI_FINDING_RADIUS, AI_SEVERITY_COLOURS, STEP_TYPE_SHORT, type AiChip,
} from './diagramAiFlowBadges';
import { AiFlowProperties, AiFlowGovernance, AiFlowKey } from './DiagramAiFlowPanels';
import './diagram.scss';
import { IconBtn, Segmented, Swatches, SnapControls, CANVAS_SIDE_WIDTH } from './DiagramControls';
import { DrawingGuides } from './DrawingGuides';
import { SideTabsPanel } from '../../components/SideTabsPanel';
import { diagramGridSize, gridSnapEnabled, shapeSnapEnabled, snapMovingBounds, type AlignmentGuide, type SpacingIndicator } from './diagramAlignment';
import { isCanvasPanGesture } from './canvasPan';
import { pasteReadableText } from '../../utils/clipboardText';
import { useAnchoredPopovers } from '../../hooks/useAnchoredPopovers';
import { ImageViewer, type ImagePreview } from '../../components/ImageViewer';
import { copyImage } from '../../utils/imageClipboard';

// ── Constants ─────────────────────────────────────────────────────────────────

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

const EDGE_COLOURS = STROKES.filter((c) => c !== 'none');
const DEFAULT_EDGE_STROKE = '#525252';
const FONT_MIN = 10;
const FONT_MAX = 36;

const KIND_LABEL: Record<DiagramKind, string> = {
  process: 'Process', decision: 'Decision', hexagon: 'Hexagon', terminator: 'Start / end', document: 'Document', arrow: 'Arrow', line: 'Line', text: 'Text', image: 'Image',
  container: 'Container', swimlane: 'Swimlane',
};

const DEFAULTS: Record<DiagramKind, Pick<DiagramNode, 'label' | 'width' | 'height' | 'fill' | 'stroke' | 'textColor' | 'fontSize'>> = {
  process: { label: 'Process', width: 140, height: 64, fill: 'none', stroke: '#161616', textColor: '#161616', fontSize: 16 },
  decision: { label: 'Decision?', width: 120, height: 80, fill: '#fcf4d6', stroke: '#b28600', textColor: '#161616', fontSize: 16 },
  hexagon: { label: 'Output', width: 160, height: 80, fill: 'none', stroke: '#161616', textColor: '#161616', fontSize: 16 },
  terminator: { label: 'Start', width: 140, height: 52, fill: '#edf5ff', stroke: '#0f62fe', textColor: '#161616', fontSize: 16 },
  document: { label: 'Document', width: 140, height: 80, fill: 'none', stroke: '#161616', textColor: '#161616', fontSize: 16 },
  arrow: { label: '', width: 160, height: 80, fill: '#edf5ff', stroke: '#0f62fe', textColor: '#161616', fontSize: 16 },
  line: { label: '', width: 140, height: 24, fill: 'none', stroke: '#525252', textColor: '#161616', fontSize: 16 },
  text: { label: 'Text', width: 140, height: 40, fill: 'none', stroke: 'none', textColor: '#161616', fontSize: 16 },
  image: { label: '', width: 96, height: 96, fill: 'none', stroke: 'none', textColor: '#161616', fontSize: 16 },
  container: { label: 'Group', width: 320, height: 220, fill: 'none', stroke: '#525252', textColor: '#161616', fontSize: 18 },
  swimlane: { label: 'Lane', width: 560, height: 180, fill: 'none', stroke: '#525252', textColor: '#161616', fontSize: 18 },
};

const PALETTE: readonly DiagramKind[] = ['process', 'decision', 'hexagon', 'terminator', 'document', 'arrow', 'text', 'image', 'container', 'swimlane'];

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
  const colours = diagramEditorNodeColours({ ...d, kind });
  const width = extra.width ?? d.width;
  const height = extra.height ?? d.height;
  return {
    id: newId(), kind, parentId: null, assetId: null, ...d, ...colours, fontSize: 14, ...extra,
    width, height, x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2),
  };
}

function makeEdge(sourceId: string, sourcePort: DiagramPort, targetId: string, targetPort: DiagramPort): DiagramEdge {
  return {
    id: newId(), sourceId, targetId, sourcePort, targetPort, route: 'orthogonal', waypoints: [], label: '',
    stroke: DEFAULT_EDGE_STROKE, dashed: false, arrows: 'end',
  };
}

/** Keep semantic defaults in the document; the shared theme supplies its modern appearance. */
function aiStepNode(type: AiFlowStepType): { kind: DiagramKind; extra: Partial<DiagramNode> } {
  const s = STEP_STYLES[type];
  return {
    kind: s.kind,
    extra: { label: STEP_TYPE_LABELS[type], width: s.width, height: s.height, fill: s.fill, stroke: s.stroke, textColor: '#161616', fontSize: 14, flow: type === 'decision_gate' ? { stepType: type, gate: defaultGate() } : { stepType: type } },
  };
}

/** New connectors in an AI flow start as primary flow. */
function aiEdgeExtra(doc: DiagramDocument): Partial<DiagramEdge> {
  if (doc.diagramType !== 'ai-flow') return {};
  return { flow: { edgeType: 'primary_flow' }, stroke: EDGE_STYLES.primary_flow.stroke, dashed: EDGE_STYLES.primary_flow.dashed };
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
  designPanel?: React.ReactNode;
  parentContext?: AthenaPageContext | undefined;
  onDeleted?: (() => void) | undefined;
  onOpenNote?: ((noteId: string) => void) | undefined;
  onNoteChanged?: ((noteId: string) => void) | undefined;
  openTab?: string | undefined;
  /** Footnote number to show when the diagram opens (from a /think?mapId=…&footnote=n link). */
  initialFootnote?: number | undefined;
  onSaveReady?: ((save: (() => Promise<boolean>) | null) => void) | undefined;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: DiagramSnapshot };

const EMPTY_NOTE = 'No description yet. Add one in Properties.';

/** The numbered notes drawn on the sheet, beneath or beside the shapes. */
function notesBlockOf(d: DiagramDocument, hidden: boolean): FootnoteBlock | null {
  if (hidden || footnotesOf(d).length === 0) return null;
  const shown = collapseView(d);
  return footnoteBlock(d, diagramBounds({ nodes: shown.nodes, edges: shown.edges }, 0), d.notesPanel ?? 'bottom', EMPTY_NOTE);
}

export const DiagramEditor: React.FC<DiagramEditorProps> = props => {
  const scope = useDiagramChatScope();
  return scope ? <DiagramEditorBody {...props} /> : <DiagramChatProvider><DiagramEditorBody {...props} /></DiagramChatProvider>;
};

const DiagramEditorBody: React.FC<DiagramEditorProps> = ({ canvasId, onDeleted, onOpenNote, initialFootnote, onSaveReady, parentContext, designPanel }) => {
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
  return <DiagramSurface key={`${canvasId}:${attempt}`} canvasId={canvasId} initial={load.snapshot} onReload={reload} onDeleted={onDeleted} onOpenNote={onOpenNote} initialFootnote={initialFootnote} onSaveReady={onSaveReady} parentContext={parentContext} designPanel={designPanel} />;
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
  | { kind: 'draw-line'; pointerId: number; start: P; current: P }
  | { kind: 'line-end'; pointerId: number; id: string; end: number; before: DiagramDocument; fixed: P }
  | { kind: 'pan'; pointerId: number; start: P; origin: Viewport }
  | { kind: 'marquee'; pointerId: number; start: P; current: P; additive: boolean; base: Selection }
  | { kind: 'move'; pointerId: number; startScreen: P; start: P; current: P; before: DiagramDocument; ids: string[]; origin: Rect; moved: boolean; clickId: string | null }
  | { kind: 'resize'; pointerId: number; id: string; handle: ResizeHandle; before: DiagramDocument; origin: Rect }
  | { kind: 'connect'; pointerId: number; sourceId: string; sourcePort: DiagramPort; current: P; targetId: string | null; targetPort: DiagramPort | null }
  | { kind: 'endpoint'; pointerId: number; edgeId: string; end: 'source' | 'target'; before: DiagramDocument; current: P; targetId: string | null; targetPort: DiagramPort | null }
  | { kind: 'bend'; pointerId: number; edgeId: string; index: number; before: DiagramDocument }
  | { kind: 'label'; pointerId: number; edgeId: string; startScreen: P; start: P; origin: P; before: DiagramDocument; moved: boolean };

type Menu = 'style' | 'arrange' | 'edge-colour' | 'export' | 'image' | 'versions' | 'text-check' | 'ai-step' | 'governance' | 'ai-key' | null;

interface EditingLabel { kind: 'node' | 'edge'; id: string; value: string }

interface SurfaceProps {
  canvasId: string;
  designPanel?: React.ReactNode;
  parentContext?: AthenaPageContext | undefined;
  initial: DiagramSnapshot;
  onReload: () => void;
  onDeleted?: (() => void) | undefined;
  onOpenNote?: ((id: string) => void) | undefined;
  initialFootnote?: number | undefined;
  onSaveReady?: DiagramEditorProps['onSaveReady'];
}

const LABEL_OFFSET_MAX = 10000;

const DiagramSurface: React.FC<SurfaceProps> = ({ canvasId, initial, onReload, onDeleted, onOpenNote, initialFootnote, onSaveReady, parentContext, designPanel }) => {
  const queryClient = useQueryClient();
  const markerBase = `dg${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [doc, setDocState] = useState<DiagramDocument>(initial.document);
  const docRef = useRef(doc);
  const GRID = diagramGridSize(doc.gridSize);
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const [spacing, setSpacing] = useState<SpacingIndicator[]>([]);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
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
  const [lineTool, setLineTool] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const [exportError, setExportError] = useState('');
  const [exportFormat, setExportFormat] = useState<DiagramExportFormat | 'mural'>('png');
  const [muralBoardUrl, setMuralBoardUrl] = useState<string | null>(null);
  const [muralResult, setMuralResult] = useState('');
  const [emailContent, setEmailContent] = useState<ShareEmailContent | null>(null);
  const muralQuery = useQuery({ queryKey: MURAL_QUERY, queryFn: loadMuralStatus, enabled: menu === 'export', staleTime: 0 });
  const [exportBg, setExportBg] = useState<'white' | 'transparent'>('white');
  const [exportGrid, setExportGrid] = useState(false);
  const [drilldown, setDrilldown] = useState<{ canvasId: string; shapeTitle: string } | null>(null);
  const [openingDrilldown, setOpeningDrilldown] = useState(false);
  const openingDrilldownRef = useRef(false);
  const [tabRequest, setTabRequest] = useState<{ id: string; seq: number } | undefined>(undefined);
  const requestTab = useCallback((id: string) => { setTabRequest((r) => ({ id, seq: (r?.seq ?? 0) + 1 })); }, []);
  const [athenaPrompt, setAthenaPrompt] = useState<{ prompt: string; sequence: number } | undefined>(undefined);
  const [notesHidden, setNotesHidden] = useState(false);
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [exportFootnotes, setExportFootnotes] = useState(true);
  const [exportLegend, setExportLegend] = useState(true);
  const [presenting, setPresenting] = useState<{ index: number; steps: PresentationStep[]; restore: Viewport } | null>(null);
  const [, setHistoryTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  useAnchoredPopovers(rootRef, menu ? '.dg-popover' : null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const clipboardRef = useRef<{ nodes: DiagramNode[]; edges: DiagramEdge[] } | null>(null);
  const pasteCountRef = useRef(0);
  const fittedRef = useRef(false);

  const setDoc = useCallback((next: DiagramDocument) => { docRef.current = next; setDocState(next); }, []);
  const setSel = useCallback((next: Selection) => { selRef.current = next; setSelState(next); }, []);
  const setDrag = useCallback((next: Drag | null) => {
    dragRef.current = next; setDragState(next);
    if (next === null) { setGuides([]); setSpacing([]); }
  }, []);

  const display = useMemo(() => collapseView(doc), [doc]);
  const byId = useMemo(() => nodeMap(display.nodes), [display.nodes]);
  const remappedEdges = useMemo(() => {
    const original = new Map(doc.edges.map((x) => [x.id, x] as const));
    return new Set(display.edges.filter((x) => original.get(x.id) !== x).map((x) => x.id));
  }, [doc.edges, display.edges]);
  const view = doc.viewport;

  // ── Notices (nothing fails silently) ──────────────────────────────────────

  const dismiss = useCallback((id: string) => { setNotices((list) => list.filter((n) => n.id !== id)); }, []);
  const notify = useCallback((kind: Notice['kind'], message: string, opts: { key?: string; action?: Notice['action'] } = {}) => {
    const id = newId();
    setNotices((list) => [...list.filter((n) => opts.key === undefined || n.key !== opts.key), { id, kind, message, key: opts.key, action: opts.action }].slice(-4));
    if (kind === 'info') window.setTimeout(() => { dismiss(id); }, INFO_TIMEOUT_MS);
  }, [dismiss]);

  // ── Title / delete (canvas record) ─────────────────────────────────────────

  const { data: canvas, error: canvasError, isPending: canvasPending, refetch: refetchCanvas } = useQuery<CanvasFullApi>({
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
  const drilldowns = useQuery({
    queryKey: ['diagram-drilldowns', canvasId],
    queryFn: async () => {
      const response = await api.listDiagramDrilldowns(canvasId);
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
    retry: false,
  });
  const drilldownIds = new Set(drilldowns.data?.map(item => item.nodeId) ?? []);
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
    if (!await confirmDialog(`Move the diagram “${savedTitle}” to the recycle bin? Its shapes, assets, links and saved revisions will remain available for restoration.`, {
      title: 'Move diagram to recycle bin', confirmLabel: 'Move to recycle bin', tone: 'danger',
    })) return;
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
  const athenaContext = useMemo<AthenaPageContext>(() => ({
    type: 'canvas', id: `map:${canvasId}`, title: savedTitle,
    conversationId: parentContext?.conversationId ?? parentContext?.id ?? `map:${canvasId}`,
    detail: `${parentContext ? `Inside ${parentContext.title} (${parentContext.id}). Parent context: ${parentContext.detail ?? ''}\n` : ''}Editable diagram. Read its saved shapes and connectors, provided separately. ${saveStatus === 'saved' ? 'All editor changes are saved.' : 'Editor changes are not yet saved; do not assume they are in the saved structure.'}`,
    ...(sel.nodes.length === 1 ? { selectedId: sel.nodes[0]! } : sel.edges.length === 1 ? { selectedId: sel.edges[0]! } : {}),
    ...(canvas?.project != null ? { projectId: canvas.project } : parentContext?.projectId != null ? { projectId: parentContext.projectId } : {}),
  }), [canvasId, savedTitle, saveStatus, sel.nodes, sel.edges, canvas?.project, parentContext]);

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

  /** Save immediately and report whether everything is now saved (needed before server-side links to new shapes). */
  const saveNow = useCallback(async (): Promise<boolean> => {
    const s = save.current;
    for (let i = 0; i < 5; i += 1) {
      if (s.inflight !== null) await s.inflight;
      if (s.blocked !== null || s.discard) return false;
      if (s.seq === s.savedSeq) return true;
      flush();
      if (s.inflight !== null) await s.inflight;
    }
    return s.seq === s.savedSeq && s.blocked === null;
  }, [flush]);

  useEffect(() => {
    onSaveReady?.(saveNow);
    return () => { onSaveReady?.(null); };
  }, [onSaveReady, saveNow]);

  async function openShapeDrilldown(node: DiagramNode): Promise<void> {
    if (openingDrilldownRef.current) return;
    openingDrilldownRef.current = true;
    setOpeningDrilldown(true);
    try {
      if (!await saveNow()) throw new Error('Save the parent diagram first. Resolve the save error or conflict above the diagram.');
      const response = await api.openDiagramDrilldown(canvasId, node.id, save.current.rev);
      if (!response.success) throw new Error(response.error.message);
      pointerOverCanvasRef.current = false;
      spaceRef.current = false;
      setSpaceDown(false);
      setDrilldown({ canvasId: response.data.canvasId, shapeTitle: descriptionPlainText(node.label).trim() || 'Untitled shape' });
      void queryClient.invalidateQueries({ queryKey: ['diagram-drilldowns', canvasId] });
      void queryClient.invalidateQueries({ queryKey: ['canvases'] });
    } catch (cause) {
      notify('error', `Could not open drill-down: ${describeError(cause).message}`, { key: 'drilldown' });
    } finally {
      openingDrilldownRef.current = false;
      setOpeningDrilldown(false);
    }
  }

  const beforeElementLink = useCallback(async (): Promise<boolean> => {
    const ok = await saveNow();
    if (!ok) notify('error', 'Save the diagram before managing links — the latest changes haven’t saved yet.', { key: 'element-link-save' });
    return ok;
  }, [saveNow, notify]);

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
    setDoc(pruneFootnotes(next));
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
    const next = { ...snapshot, viewport: cur.viewport, grid: cur.grid,
      snapToGrid: gridSnapEnabled(cur), snapToShapes: shapeSnapEnabled(cur) };
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
    const cur = docRef.current;
    const block = notesBlockOf(cur, notesHidden);
    const content = documentBounds(cur);
    const bounds = block === null ? content : content === null ? block.rect : boundsOf([content, block.rect]);
    const v = fitViewport(bounds, el.clientWidth, el.clientHeight, FIT_PADDING, MIN_ZOOM, MAX_ZOOM);
    setView(v, persist);
  }, [setView, notesHidden]);

  /** Pan (keeping the zoom) so a diagram-space rectangle is on screen. */
  const revealRect = useCallback((r: Rect) => {
    const el = sheetRef.current;
    if (el === null) return;
    const v = docRef.current.viewport;
    const W = el.clientWidth; const H = el.clientHeight; const m = 24;
    const sx = r.x * v.zoom + v.x; const sy = r.y * v.zoom + v.y;
    const sw = r.width * v.zoom; const sh = r.height * v.zoom;
    if (sx >= m && sy >= m && sx + sw <= W - m && sy + sh <= H - m) return;
    const x = sw > W - m * 2 ? m - r.x * v.zoom : W / 2 - (r.x + r.width / 2) * v.zoom;
    const y = sh > H - m * 2 ? m - r.y * v.zoom : H / 2 - (r.y + r.height / 2) * v.zoom;
    setView({ x, y, zoom: v.zoom }, false);
  }, [setView]);

  /** Show the numbered note for a footnote on the sheet. */
  const revealNote = useCallback((footnoteId: string) => {
    const item = notesBlockOf(docRef.current, false)?.items.find((i) => i.id === footnoteId);
    if (item !== undefined) revealRect(item.rect);
  }, [revealRect]);

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
    if (gridSnapEnabled(cur)) node = { ...node, x: snap(node.x, diagramGridSize(cur.gridSize)), y: snap(node.y, diagramGridSize(cur.gridSize)) };
    const host = containerAt(cur.nodes, center);
    return host !== null ? { ...node, parentId: host.id } : node;
  }, []);

  function addShape(kind: DiagramKind, center: P = viewCenter()): void {
    if (kind === 'image') { setMenu('image'); return; }
    const cur = docRef.current;
    const extra: Partial<DiagramNode> = kind === 'swimlane' && cur.diagramType === 'ai-flow' ? { lane: { order: nextLaneOrder(cur) } } : {};
    addNodes([placeNode(kind, center, extra)]);
    rootRef.current?.focus({ preventScroll: true });
  }

  function addAiStep(type: AiFlowStepType, center: P = viewCenter()): void {
    const { kind, extra } = aiStepNode(type);
    addNodes([placeNode(kind, center, extra)]);
    setMenu(null);
    rootRef.current?.focus({ preventScroll: true });
  }

  function setDiagramType(type: DiagramType): void {
    const cur = docRef.current;
    if ((cur.diagramType ?? 'general') === type) return;
    const next: DiagramDocument = { ...cur, diagramType: type };
    if (type === 'general') delete next.diagramType;
    commit(next);
    if (type === 'general') setMenu(null);
  }

  function arrangeLanes(): void {
    const cur = docRef.current;
    const next = layoutAiFlow(cur);
    if (next === cur) { notify('info', 'Add a swimlane and put steps in it, then arrange the lanes.', { key: 'ai-arrange' }); return; }
    commit(next);
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
      const value = e.value.replace(/[ \t]+$/gm, '').replace(/^\s+|\s+$/g, '');
      const n = docRef.current.nodes.find((x) => x.id === e.id);
      if (n !== undefined && n.label !== value) updateNodes([e.id], (x) => setNodeLabel(x, value));
    } else {
      const value = e.value.trim();
      const edge = docRef.current.edges.find((x) => x.id === e.id);
      if (edge !== undefined && edge.label !== value) updateEdges([e.id], (x) => ({ ...x, label: value }));
    }
    rootRef.current?.focus({ preventScroll: true });
  }

  const startEditing = useCallback(() => {
    const s = selRef.current;
    const cur = docRef.current;
    if (s.nodes.length === 1 && s.nodes[0] !== undefined) {
      const n = cur.nodes.find((x) => x.id === s.nodes[0]);
      if (n !== undefined && n.kind !== 'line') setEditing({ kind: 'node', id: n.id, value: n.label });
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
      const topY = host.y + (host.kind === 'container' ? containerHeader(host).height : 0) + 16;
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
    const template = makeNode('container', { x: 0, y: 0 });
    const headerHeight = containerHeader({ ...template, width: b.width + 48 }).height;
    const box: DiagramNode = {
      ...template,
      x: b.x - 24, y: b.y - 24 - headerHeight, width: b.width + 48, height: b.height + 48 + headerHeight, parentId: sharedParent,
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
  function matchSize(dimension: 'width' | 'height'): void {
    const cur = docRef.current;
    const ids = topLevelSelection(cur.nodes, selRef.current.nodes);
    const first = cur.nodes.find((n) => n.id === selRef.current.nodes.find((id) => ids.includes(id)));
    if (first === undefined || ids.length < 2) return;
    const value = first[dimension];
    updateNodes(ids.filter((id) => id !== first.id), (n) => (n.kind === 'line' ? n : { ...n, [dimension]: value }));
  }

  // ── Footnotes, key, collapse, Athena ───────────────────────────────────────

  const addFootnoteFor = useCallback((targetId: string) => {
    const cur = docRef.current;
    const existing = footnotesOf(cur).find((f) => f.targetId === targetId);
    if (existing !== undefined) { setNotesHidden(false); return; }
    const id = newId();
    commit(addFootnote(cur, targetId, id));
    setNotesHidden(false);
  }, [commit]);

  const changeAnnotations = useCallback((next: DiagramDocument, withHistory: boolean) => {
    if (withHistory) { commit(next); return; }
    setDoc(next);
    markDirty(SAVE_DELAY_MS);
  }, [commit, markDirty, setDoc]);

  const toggleCollapsed = useCallback((id: string) => {
    const n = docRef.current.nodes.find((x) => x.id === id);
    if (n === undefined || !isContainerKind(n.kind)) return;
    updateNodes([id], (x) => ({ ...x, collapsed: x.collapsed === true ? undefined : true } as DiagramNode));
    const hidden = new Set(withDescendants(docRef.current.nodes, [id]));
    hidden.delete(id);
    const s = selRef.current;
    if (n.collapsed !== true) setSel({ nodes: s.nodes.filter((x) => !hidden.has(x)), edges: s.edges });
  }, [setSel, updateNodes]);

  const askAthena = useCallback((targetId: string) => {
    const cur = docRef.current;
    const node = cur.nodes.find((n) => n.id === targetId);
    const edge = node === undefined ? cur.edges.find((x) => x.id === targetId) : undefined;
    const label = (node?.label ?? edge?.label ?? '').trim();
    const description = (node?.description ?? edge?.description ?? '').trim();
    const what = node !== undefined ? `the “${label || 'unlabelled'}” shape` : `the “${label || 'unlabelled'}” connector`;
    const prompt = `Tell me about ${what} in this diagram${description === '' ? '' : ` (described as: ${description})`}. What does it connect to, what might be missing, and how could it be explained better?`;
    setSel(node !== undefined ? { nodes: [targetId], edges: [] } : { nodes: [], edges: [targetId] });
    requestTab('athena');
    setAthenaPrompt((p) => ({ prompt, sequence: (p?.sequence ?? 0) + 1 }));
  }, [setSel, requestTab]);

  function selectFootnoteTarget(targetId: string): void {
    const cur = docRef.current;
    if (cur.nodes.some((n) => n.id === targetId)) setSel({ nodes: [targetId], edges: [] });
    else if (cur.edges.some((x) => x.id === targetId)) setSel({ nodes: [], edges: [targetId] });
  }

  function selectAndRevealTarget(targetId: string): void {
    selectFootnoteTarget(targetId);
    const shown = collapseView(docRef.current);
    const map = nodeMap(shown.nodes);
    const node = map.get(shown.hiddenBy.get(targetId) ?? targetId);
    const edge = node === undefined ? shown.edges.find((x) => x.id === targetId) : undefined;
    const route = edge === undefined ? null : edgeRoute(edge, map);
    const target = node !== undefined ? nodeRect(node) : route === null ? null : boundsOf(route.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
    if (target !== null) revealRect(target);
  }

  function focusTarget(targetId: string | null, persist: boolean): void {
    const el = sheetRef.current;
    if (el === null) return;
    const cur = docRef.current;
    const shown = collapseView(cur);
    let bounds = documentBounds(shown);
    if (targetId !== null) {
      const map = nodeMap(shown.nodes);
      const node = map.get(shown.hiddenBy.get(targetId) ?? targetId);
      const edge = node === undefined ? shown.edges.find((x) => x.id === targetId) : undefined;
      const route = edge === undefined ? null : edgeRoute(edge, map);
      if (node !== undefined) bounds = nodeRect(node);
      else if (route !== null) bounds = boundsOf(route.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
    }
    if (bounds === null) return;
    const pad = Math.max(bounds.width, bounds.height) * 0.25 + 40;
    const padded = { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 };
    setView(fitViewport(padded, el.clientWidth, el.clientHeight, FIT_PADDING, MIN_ZOOM, Math.min(MAX_ZOOM, 2)), persist);
  }

  // ── Presentation mode ──────────────────────────────────────────────────────

  function startPresentation(): void {
    const steps = presentationSteps(docRef.current);
    setMenu(null);
    setEditing(null);
    setSel(EMPTY_SEL);
    setPresenting({ index: 0, steps, restore: docRef.current.viewport });
    const root = rootRef.current;
    if (root !== null && document.fullscreenElement === null && typeof root.requestFullscreen === 'function') {
      void root.requestFullscreen().catch(() => { /* windowed presentation still works */ });
    }
  }

  const stopPresentation = useCallback(() => {
    setPresenting((p) => {
      if (p !== null) window.setTimeout(() => { setView(p.restore, false); }, 0);
      return null;
    });
    if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => { /* already closed */ });
  }, [setView]);

  function stepPresentation(delta: number): void {
    setPresenting((p) => (p === null ? p : { ...p, index: Math.max(0, Math.min(p.steps.length - 1, p.index + delta)) }));
  }

  const presentStep = presenting === null ? null : presenting.steps[presenting.index] ?? null;
  useEffect(() => {
    if (presenting === null) return;
    const step = presenting.steps[presenting.index];
    if (step === undefined) return;
    const t = window.setTimeout(() => { focusTarget(step.targetId, false); }, 60);
    return () => { window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting?.index, presenting?.steps, size.width, size.height]);

  useEffect(() => {
    if (presenting === null) return undefined;
    const onFs = (): void => { if (document.fullscreenElement === null) stopPresentation(); };
    document.addEventListener('fullscreenchange', onFs);
    return () => { document.removeEventListener('fullscreenchange', onFs); };
  }, [presenting, stopPresentation]);

  // ── Deep link to a footnote (/think?mapId=…&footnote=n) ─────────────────────

  const deepLinkedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (initialFootnote === undefined || deepLinkedRef.current === initialFootnote || size.width === 0) return;
    deepLinkedRef.current = initialFootnote;
    const fn = footnotesOf(docRef.current)[initialFootnote - 1];
    if (fn === undefined) { notify('info', `Footnote ${initialFootnote} no longer exists on this diagram.`, { key: 'footnote-link' }); return; }
    setNotesHidden(false);
    selectFootnoteTarget(fn.targetId);
    window.setTimeout(() => { revealNote(fn.id); }, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFootnote, size.width]);

  function distribute(axis: 'horizontal' | 'vertical'): void { commit(distributeNodes(docRef.current, topLevelSelection(docRef.current.nodes, selRef.current.nodes), axis)); }

  function toggleGrid(): void {
    const cur = docRef.current;
    setDoc({ ...cur, grid: !cur.grid, snapToGrid: gridSnapEnabled(cur) });
    markDirty(SAVE_DELAY_MS);
  }

  function toggleSnap(kind: 'grid' | 'shapes'): void {
    const cur = docRef.current;
    setDoc(kind === 'grid' ? { ...cur, snapToGrid: !gridSnapEnabled(cur) }
      : { ...cur, snapToShapes: !shapeSnapEnabled(cur) });
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

  async function runExport(shareDrawio = false, destination?: string): Promise<void> {
    if (exportingRef.current) return;
    setExportError('');
    const cur = docRef.current;
    const ids = [...new Set(cur.nodes.flatMap((n) => (n.assetId === null ? [] : [n.assetId])))];
    const missing = ids.filter((id) => !blobsRef.current.has(id));
    if (missing.length > 0) {
      const message = `${missing.length} image${missing.length === 1 ? ' is' : 's are'} still loading or failed to load, so the export would be incomplete.`;
      setExportError(message);
      notify('error', message, {
        key: 'export', action: { label: 'Retry images', run: retryAssets },
      });
      return;
    }
    const map = new Map<string, Blob>();
    for (const id of ids) { const b = blobsRef.current.get(id); if (b !== undefined) map.set(id, b); }
    exportingRef.current = true;
    setExporting(true);
    setMuralResult('');
    try {
      const options = { footnotes: exportFootnotes, legend: exportLegend && cur.legend?.visible === true, name: canvas?.title };
      if (shareDrawio) {
        const blob = await diagramExportBlob(cur, map, 'drawio', 'transparent', false, options);
        if (blob.size > 4 * 1024 * 1024) throw new Error('The draw.io email attachment exceeds 4 MiB. Export a smaller diagram.');
        setEmailContent({ title: canvas?.title ?? 'Athena diagram',
          attachment: { filename: exportFileName(canvas?.title, 'drawio'), xml: await blob.text() } });
        setMenu(null);
      } else if (exportFormat === 'mural') {
        const payload = await diagramMural(cur, map, {
          boardUrl: destination ?? muralBoardUrl ?? muralQuery.data?.boardUrl ?? '', title: (canvas?.title ?? 'Athena diagram').slice(0, 300),
          footnotes: exportFootnotes, legend: exportLegend && cur.legend?.visible === true,
        });
        const response = await api.exportMuralDiagram(payload);
        if (!response.success) throw new Error(response.error.message);
        setMuralResult(response.data.boardUrl);
        notify('info', `Added ${response.data.objects} editable objects and ${response.data.connectors} connectors to Mural.`, { key: 'export' });
      } else {
        await exportDiagram(cur, map, exportFormat, exportBg, exportGrid, options);
        setMenu(null);
      }
    } catch (err) {
      const message = `Export failed: ${describeError(err).message}`;
      setExportError(message);
      notify('error', message, { key: 'export' });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }

  // ── Pointer interaction ────────────────────────────────────────────────────

  const spaceRef = useRef(false);
  const pointerOverCanvasRef = useRef(false);
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
    if (isCanvasPanGesture(e.button, spaceRef.current)) {
      begin({ kind: 'pan', pointerId, start: toScreen(e.clientX, e.clientY), origin: cur.viewport });
      return;
    }
    if (e.button !== 0) return;
    if (lineTool) {
      const start = snapPoint(world, gridSnapEnabled(cur) && !e.altKey);
      begin({ kind: 'draw-line', pointerId, start, current: start });
      return;
    }
    const s = selRef.current;
    if (presenting !== null) {
      if (role === 'footnote' || role === 'footnote-item') {
        const index = presenting.steps.findIndex((st) => st.number !== null && footnotesOf(cur)[st.number - 1]?.id === id);
        if (index >= 0) setPresenting({ ...presenting, index });
        return;
      }
      begin({ kind: 'pan', pointerId, start: toScreen(e.clientX, e.clientY), origin: cur.viewport });
      return;
    }
    switch (role) {
      case 'footnote': {
        e.preventDefault();
        const fn = footnotesOf(cur).find((f) => f.id === id);
        if (fn === undefined) return;
        setNotesHidden(false);
        selectFootnoteTarget(fn.targetId);
        window.setTimeout(() => { revealNote(fn.id); }, 0);
        return;
      }
      case 'footnote-item': {
        e.preventDefault();
        const fn = footnotesOf(cur).find((f) => f.id === id);
        if (fn === undefined) return;
        selectAndRevealTarget(fn.targetId);
        return;
      }
      case 'collapse': {
        e.preventDefault();
        toggleCollapsed(id);
        return;
      }
      case 'edge-label': {
        if (remappedEdges.has(id)) return;
        const edge = cur.edges.find((x) => x.id === id);
        if (edge === undefined) return;
        if (e.shiftKey) { setSel({ ...s, edges: s.edges.includes(id) ? s.edges.filter((x) => x !== id) : [...s.edges, id] }); return; }
        setSel({ nodes: [], edges: [id] });
        begin({ kind: 'label', pointerId, edgeId: id, startScreen: toScreen(e.clientX, e.clientY), start: world, origin: edge.labelOffset ?? { x: 0, y: 0 }, before: cur, moved: false });
        return;
      }
      case 'line-end': {
        const node = byId.get(id);
        if (node === undefined) return;
        const end = Number(target?.getAttribute('data-end'));
        const points = linePoints(node);
        begin({ kind: 'line-end', pointerId, id, end, before: cur, fixed: points[end === 0 ? 1 : 0] });
        return;
      }
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
        const ins = insertWaypoint(route, edge.waypoints, snapPoint(world, gridSnapEnabled(cur) && !e.altKey));
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
        if (remappedEdges.has(id)) return;
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
    pointerOverCanvasRef.current = true;
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
    const snapOn = gridSnapEnabled(cur) && !e.altKey;
    switch (d.kind) {
      case 'draw-line':
        setDrag({ ...d, current: snapPoint(world, snapOn) });
        return;
      case 'line-end': {
        const moving = snapPoint(world, snapOn);
        const geometry = d.end === 0 ? lineGeometry(moving, d.fixed) : lineGeometry(d.fixed, moving);
        setDoc({ ...cur, nodes: cur.nodes.map(n => n.id === d.id ? { ...n, ...geometry } : n) });
        return;
      }
      case 'pan': {
        const sp = toScreen(e.clientX, e.clientY);
        setView({ ...d.origin, x: d.origin.x + sp.x - d.start.x, y: d.origin.y + sp.y - d.start.y });
        return;
      }
      case 'marquee': {
        const rect = normalizeRect(d.start, world);
        const hits = nodesInRect(collapseView(cur).nodes, rect);
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
        const moving = withDescendants(d.before.nodes, d.ids);
        const others = collapseView(d.before).nodes.filter(node => !moving.has(node.id) && !isContainerKind(node.kind) && node.kind !== 'line');
        const snapping = shapeSnapEnabled(cur) && !e.altKey;
        const spaced = snapMovingBounds(d.origin, others, { x: rawX, y: rawY },
          { zoom: cur.viewport.zoom, gridSize: snapOn ? GRID : null, shapeSnapping: snapping });
        setGuides(e.altKey ? [] : spaced.guides);
        setSpacing(e.altKey ? [] : spaced.indicators);
        setDoc(translateNodes(d.before, d.ids, spaced.delta.x, spaced.delta.y));
        const host = containerAt(d.before.nodes, world, withDescendants(d.before.nodes, d.ids));
        setDropTargetId(host?.id ?? null);
        setDrag({ ...d, moved: true, current: world });
        return;
      }
      case 'resize': {
        const snapping = shapeSnapEnabled(cur) && !e.altKey && !e.shiftKey;
        const alignment = snapMovingBounds({ x: 0, y: 0, width: 0, height: 0 },
          collapseView(d.before).nodes.filter(node => node.id !== d.id && !isContainerKind(node.kind) && node.kind !== 'line'),
          world, { zoom: cur.viewport.zoom, gridSize: snapOn ? GRID : null, shapeSnapping: snapping, spacing: false });
        const activeGuides = e.altKey || e.shiftKey ? [] : alignment.guides.filter(guide =>
          guide.axis === 'x' ? /[ew]/.test(d.handle) : /[ns]/.test(d.handle));
        const point = alignment.delta;
        setGuides(activeGuides);
        const rect = resizeRect(d.origin, d.handle, point, { min: MIN_NODE_SIZE, keepAspect: e.shiftKey });
        setDoc({
          ...d.before,
          nodes: d.before.nodes.map((n) => (n.id === d.id ? { ...n, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : n)),
        });
        return;
      }
      case 'connect':
      case 'endpoint': {
        const exclude = new Set<string>(d.kind === 'connect' ? [d.sourceId] : []);
        const hit = hitTestNode(collapseView(cur).nodes.filter(n => n.kind !== 'line'), world, exclude);
        setDrag({ ...d, current: world, targetId: hit?.id ?? null, targetPort: hit === null ? null : nearestPort(nodeRect(hit), world, hit.kind, hit.arrowDirection) });
        return;
      }
      case 'label': {
        const sp = toScreen(e.clientX, e.clientY);
        if (!d.moved && distance(sp, d.startScreen) < DRAG_THRESHOLD_PX) return;
        const clamp = (v: number): number => Math.max(-LABEL_OFFSET_MAX, Math.min(LABEL_OFFSET_MAX, Math.round(v)));
        const offset = { x: clamp(d.origin.x + world.x - d.start.x), y: clamp(d.origin.y + world.y - d.start.y) };
        setDoc({ ...cur, edges: cur.edges.map((x) => (x.id === d.edgeId ? { ...x, labelOffset: offset } : x)) });
        if (!d.moved) setDrag({ ...d, moved: true });
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
    setGuides([]);
    setDropTargetId(null);
    if (cancelled) {
      if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'bend' || d.kind === 'line-end' || d.kind === 'label') setDoc({ ...d.before, viewport: docRef.current.viewport });
      return;
    }
    const cur = docRef.current;
    const world = toWorld(e.clientX, e.clientY);
    switch (d.kind) {
      case 'draw-line': {
        const end = snapPoint(world, gridSnapEnabled(cur) && !e.altKey);
        if (distance(d.start, end) * cur.viewport.zoom < DRAG_THRESHOLD_PX) return;
        addNodes([makeNode('line', d.start, lineGeometry(d.start, end))]);
        setLineTool(false);
        return;
      }
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
      case 'line-end':
        commit(cur, d.before);
        return;
      case 'label':
        if (d.moved) commit(cur, d.before);
        return;
      case 'connect': {
        const source = byId.get(d.sourceId);
        if (source === undefined) return;
        if (d.targetId !== null && d.targetPort !== null) {
          const edge = { ...makeEdge(d.sourceId, d.sourcePort, d.targetId, d.targetPort), ...aiEdgeExtra(cur) };
          commit({ ...cur, edges: [...cur.edges, edge] });
          setSel({ nodes: [], edges: [edge.id] });
          return;
        }
        const from = portPoint(nodeRect(source), d.sourcePort, source.kind, source.arrowDirection);
        if (distance(from, world) < 40) return;
        // Dropped on empty sheet: create a connected shape there (in an AI flow, another step of the same type).
        const kind: DiagramKind = source.kind === 'decision' || source.kind === 'terminator' ? 'process' : (isContainerKind(source.kind) || source.kind === 'image' || source.kind === 'text' || source.kind === 'arrow') ? 'process' : source.kind;
        const step = cur.diagramType === 'ai-flow' && source.flow !== undefined ? aiStepNode(source.flow.stepType) : null;
        const node = step !== null ? placeNode(step.kind, world, step.extra) : placeNode(kind, world);
        const edge = { ...makeEdge(d.sourceId, d.sourcePort, node.id, nearestPort(nodeRect(node), from, node.kind, node.arrowDirection)), ...aiEdgeExtra(cur) };
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
      if (n.kind === 'line') return;
      setEditing({ kind: 'node', id, value: n.label });
      return;
    }
    if (role === 'footnote' || role === 'footnote-item' || role === 'collapse') return;
    if (role === 'edge' || role === 'midpoint' || role === 'edge-label') {
      if (remappedEdges.has(id)) return;
      const edge = cur.edges.find((x) => x.id === id);
      if (edge === undefined) return;
      setSel({ nodes: [], edges: [id] });
      setEditing({ kind: 'edge', id, value: edge.label });
      return;
    }
    if (role === null) {
      const world = toWorld(e.clientX, e.clientY);
      // Pointer capture can retarget double-clicks to the sheet instead of the shape.
      const shown = collapseView(cur);
      const hit = hitTestNode(shown.nodes, world);
      if (hit !== null) {
        setSel({ nodes: [hit.id], edges: [] });
        if (hit.kind === 'line') return;
        setEditing({ kind: 'node', id: hit.id, value: hit.label });
        return;
      }
      const edge = hitTestEdge(shown.edges.filter((x) => !remappedEdges.has(x.id)), byId, world, 6 / cur.viewport.zoom);
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
    if (presenting !== null) {
      if (e.key === 'Escape') { e.preventDefault(); stopPresentation(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); stepPresentation(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); stepPresentation(-1); }
      else if (e.key === 'Home') { e.preventDefault(); setPresenting({ ...presenting, index: 0 }); }
      else if (e.key === 'End') { e.preventDefault(); setPresenting({ ...presenting, index: presenting.steps.length - 1 }); }
      return;
    }
    if (e.key === 'Escape' && lineTool) {
      e.preventDefault(); setLineTool(false);
      const active = dragRef.current;
      if (active?.kind === 'draw-line') {
        if (svgRef.current?.hasPointerCapture(active.pointerId)) svgRef.current.releasePointerCapture(active.pointerId);
        setDrag(null);
      }
      return;
    }
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
    const keyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey
        || !pointerOverCanvasRef.current || isTypingTarget(event.target)
        || !(event.target instanceof Element) || event.target.closest('.dg-editor') !== rootRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      spaceRef.current = true;
      setSpaceDown(true);
    };
    const keyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space' || event.key === ' ') reset();
    };
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', reset);
    };
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
      if (kind.startsWith('ai:')) {
        const type = kind.slice(3);
        if ((AI_FLOW_STEP_TYPES as readonly string[]).includes(type)) addAiStep(type as AiFlowStepType, at);
        return;
      }
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
  const ordered = useMemo(() => renderOrder(display.nodes), [display.nodes]);
  const selNodeSet = new Set(sel.nodes);
  const selEdgeSet = new Set(sel.edges);
  const selectedNodes = doc.nodes.filter((n) => selNodeSet.has(n.id));
  const selectedEdges = doc.edges.filter((x) => selEdgeSet.has(x.id));
  const singleNode = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : undefined;
  const singleEdge = selectedNodes.length === 0 && selectedEdges.length === 1 ? selectedEdges[0] : undefined;
  const topSelected = topLevelSelection(doc.nodes, sel.nodes);
  const routes = useMemo(() => new Map(display.edges.map((x) => [x.id, edgeRoute(x, byId)] as const)), [display.edges, byId]);
  const isAiFlow = doc.diagramType === 'ai-flow';
  const aiFindings = useMemo(() => (doc.diagramType === 'ai-flow' ? checkAiFlow(doc) : []), [doc]);
  const aiFindingMap = useMemo(() => findingsByTarget(aiFindings), [aiFindings]);
  const lineJumps = useMemo(() => diagramLineJumpGeometry(display, routes), [display, routes]);
  const jumpBounds = useMemo(() => diagramBounds(display, 24), [display]);
  const footnotes = footnotesOf(doc);
  const notesPosition = doc.notesPanel ?? 'bottom';
  const showNotes = footnotes.length > 0 && !notesHidden;
  const notesBlock = useMemo(() => notesBlockOf(doc, notesHidden), [doc, notesHidden]);
  const keyDim = (stroke: string | undefined): boolean => keyFilter !== null && (stroke ?? '').toLowerCase() !== keyFilter;
  const footnoteR = FOOTNOTE_RADIUS * Math.max(1, 0.75 / z);
  const singleId = singleNode?.id ?? singleEdge?.id;
  const singleFootnote = singleId === undefined ? undefined : footnotes.find((f) => f.targetId === singleId);
  const markerIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of doc.edges) {
      const colour = diagramEdgeAppearance(x).stroke;
      if (!m.has(colour)) m.set(colour, `${markerBase}-arrow-${m.size}`);
    }
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
      const m = worldToScreen(edgeLabelCenter(route, edge), view);
      const fontSize = Math.max(11, (edge.fontSize ?? 12) * z);
      const height = Math.max(36, fontSize * 1.25 + 12);
      return { left: m.x - 90, top: m.y - height / 2, width: 180, height, fontSize };
    }
    const n = byId.get(editing.id);
    if (n === undefined || n.kind === 'line') return null;
    const tl = worldToScreen({ x: n.x, y: n.y }, view);
    const fontSize = Math.max(11, n.fontSize * z);
    if (n.kind === 'container') return { left: tl.x, top: tl.y, width: n.width * z, height: Math.max(30, containerHeader(n).height * z), fontSize };
    if (n.kind === 'image') {
      const h = Math.max(30, captionHeight(n) * z);
      return { left: tl.x, top: tl.y + n.height * z - (n.label.trim() === '' ? 0 : h), width: Math.max(120, n.width * z), height: h, fontSize };
    }
    const callout = calloutLayout(n);
    if (callout !== null) return { left: tl.x, top: tl.y + callout.height * z, width: Math.max(80, n.width * z), height: Math.max(32, (n.height - callout.height) * z), fontSize };
    return { left: tl.x, top: tl.y, width: Math.max(80, n.width * z), height: Math.max(32, n.height * z), fontSize };
  })();

  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;
  const allStrokes = new Set(selectedNodes.map((n) => n.stroke));
  const allText = new Set(selectedNodes.map((n) => n.textColor));
  const fontSizes = selectedNodes.map((n) => n.fontSize);
  const fontSize = fontSizes.length > 0 ? Math.round(fontSizes.reduce((s, v) => s + v, 0) / fontSizes.length) : 14;
  const parentIds = new Set(topSelected.map((id) => byId.get(id)?.parentId ?? null));
  const commonParent = parentIds.size === 1 ? [...parentIds][0] ?? null : undefined;
  const hostOptions = doc.nodes.filter((n) => isContainerKind(n.kind) && topSelected.length > 0 && topSelected.every((id) => canParent(doc.nodes, id, n.id)));
  const edgeColours = new Set(selectedEdges.map((x) => diagramEdgeAppearance(x).stroke));
  const edgeRoutes = new Set(selectedEdges.map((x) => x.route));
  const edgeArrows = new Set(selectedEdges.map((x) => x.arrows));
  const allDashed = selectedEdges.length > 0 && selectedEdges.every((x) => diagramEdgeAppearance(x).dash !== undefined);
  const anyBends = selectedEdges.some((x) => x.waypoints.length > 0);
  const only = <T,>(s: Set<T>): T | undefined => (s.size === 1 ? [...s][0] : undefined);
  const selectionStyle = <DiagramSelectionStyle nodes={selectedNodes} edges={selectedEdges}
    onChange={(nodes, edges) => { commit(applyDiagramSelectionStyle(docRef.current, sel, nodes, edges)); }} />;

  const sheetClass = [
    'dg-sheet',
    doc.grid ? 'dg-sheet--grid' : '',
    spaceDown || drag?.kind === 'pan' ? 'dg-sheet--panning' : '',
    lineTool || drag?.kind === 'connect' || drag?.kind === 'endpoint' ? 'dg-sheet--connecting' : '',
    dropHint ? 'dg-sheet--drop' : '',
  ].filter(Boolean).join(' ');

  // ── Render ─────────────────────────────────────────────────────────────────

  // Connectors marked "behind" render beneath shapes; the rest sit on top.
  const renderEdge = (edge: DiagramEdge): React.ReactElement | null => {
                const route = routes.get(edge.id);
                if (route === undefined || route === null) return null;
                const appearance = diagramEdgeAppearance(edge);
                const d = lineJumps.paths.get(edge.id) ?? roundedRoutePath(route);
                const marker = `url(#${markerIds.get(appearance.stroke) ?? ''})`;
                const mid = edgeLabelCenter(route, edge);
                const { lines: labelLines, width: labelW, height: labelH, fontSize: labelFont, lineHeight } = edgeLabelLayout(edge);
                const lines = editing?.kind === 'edge' && editing.id === edge.id ? [] : labelLines;
                const remapped = remappedEdges.has(edge.id);
                const edgeCls = ['dg-edge', selEdgeSet.has(edge.id) ? 'dg-edge--selected' : '', remapped ? 'dg-edge--collapsed' : '', keyFilter !== null ? 'dg-edge--dimmed' : ''].filter(Boolean).join(' ');
                return (
                  <g key={edge.id} className={edgeCls} data-dg={remapped ? undefined : 'edge'} data-id={edge.id}>
                    <path className="dg-edge__hit" d={d} strokeWidth={Math.max(14 * inv, appearance.width + 6 * inv)} />
                    <path className="dg-edge__halo" d={d} style={{ strokeWidth: appearance.width * z + 4 }} />
                    <path
                      className="dg-edge__line" d={d} stroke={appearance.stroke}
                      strokeWidth={appearance.width} strokeLinecap="round" strokeLinejoin="round"
                      strokeDasharray={appearance.dash}
                      markerEnd={edge.arrows === 'none' || edge.arrows === 'start' ? undefined : marker}
                      markerStart={edge.arrows === 'both' || edge.arrows === 'start' ? marker : undefined}
                      mask={lineJumps.masks.has(edge.id) ? `url(#${markerBase}-jump-${edge.id})` : undefined}
                    />
                    {lines.length > 0 && (
                      <g className="dg-edge__label" data-dg={remapped ? undefined : 'edge-label'} data-id={edge.id}>
                        {!remapped && <title>Drag to move the label</title>}
                        <rect x={mid.x - labelW / 2} y={mid.y - labelH / 2} width={labelW} height={labelH} rx={labelH / 2} stroke={appearance.labelBorder} />
                        <text x={mid.x} y={mid.y - labelH / 2 + 3 + labelFont} fontSize={labelFont} fontWeight={600} textAnchor="middle" fill={appearance.label}>
                          {styledTspans(edge.label, lines).map((runs, i) => <tspan key={i} x={mid.x} dy={i === 0 ? 0 : lineHeight}>{runs}</tspan>)}
                        </text>
                      </g>
                    )}
                  </g>
                );
  };

  return (<>
    {imagePreview && <ImageViewer image={imagePreview} onClose={() => { setImagePreview(null); }} />}
    {emailContent && <ShareEmailModal content={emailContent} onClose={() => { setEmailContent(null); }} />}
    <div className={`dg-layout${presenting !== null ? ' dg-layout--presenting' : ''}`}>
    <div
      ref={rootRef}
      className={`dg-editor${presenting !== null ? ' dg-editor--presenting' : ''}`}
      tabIndex={0}
      aria-label="Diagram editor"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onCopy={(e) => { onCopy(e); }}
      onCut={(e) => { onCopy(e, true); }}
      onPaste={onPaste}
      onPasteCapture={pasteReadableText}
    >
      <div className="dg-header">
        <div className="dg-header__row">
        <div className="dg-header__main">
        <input
          className="dg-header__title" value={title} aria-label="Diagram title"
          onChange={(e) => { setTitle(e.target.value); }}
          onBlur={() => { void renameDiagram(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(savedTitle); e.currentTarget.blur(); } }}
        />
        <div className="dg-header__type-switch">
          <Segmented compact label="Diagram type" value={doc.diagramType ?? 'general'} onChange={setDiagramType}
            options={[{ value: 'general', label: 'General' }, { value: 'ai-flow', label: 'AI flow' }]} />
        </div>
        <SaveIndicator status={saveStatus} uploading={uploading} />
        </div>
        <div className="dg-header__toolbar">
        <div className="dg-header__actions kh-command-row" role="toolbar" aria-label="Diagram tools">
          <div className="dg-header__group kh-command-row">
          <IconBtn label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => { stepHistory('undo'); }}><Undo size={16} /></IconBtn>
          <IconBtn label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => { stepHistory('redo'); }}><Redo size={16} /></IconBtn>
          </div>
          <div className="dg-header__group kh-command-row">
          <IconBtn label={doc.grid ? 'Hide grid' : 'Show grid'} pressed={doc.grid} onClick={toggleGrid}><Grid size={16} /></IconBtn>
          <SnapControls grid={gridSnapEnabled(doc)} shapes={shapeSnapEnabled(doc)} gridSize={GRID} onToggle={toggleSnap}
            onOpen={() => { setMenu(null); }}
            onGridSize={gridSize => { commit({ ...docRef.current, gridSize }); }} />
          <IconBtn label={doc.legend?.visible === true ? 'Hide colour key' : 'Show colour key'} pressed={doc.legend?.visible === true}
            onClick={() => { const visible = doc.legend?.visible !== true; changeAnnotations(setLegend(doc, { ...(doc.legend ?? DEFAULT_LEGEND), visible }), true); if (!visible) setKeyFilter(null); }}>
            <Legend size={16} />
          </IconBtn>
          <IconBtn label={footnotes.length === 0 ? 'Notes — add a footnote from a shape or connector toolbar' : showNotes ? 'Hide notes' : 'Show notes'}
            pressed={showNotes} disabled={footnotes.length === 0} onClick={() => { setNotesHidden(showNotes); }}>
            <ListNumbered size={16} />
          </IconBtn>
          </div>
          {isAiFlow && <div className="dg-header__group kh-command-row">
            <IconBtn label="Arrange lanes — stack lanes by order and line steps up in flow order" onClick={arrangeLanes}><ArrangeVertical size={16} /></IconBtn>
            <div className="dg-anchor kh-command-row">
              <button type="button" className={`dg-ai-gov-btn${menu === 'governance' ? ' dg-ai-gov-btn--active' : ''}${aiFindings.length === 0 ? ' dg-ai-gov-btn--clear' : ` dg-ai-gov-btn--${aiFindings[0]?.severity ?? 'info'}`}`}
                aria-expanded={menu === 'governance'} aria-haspopup="dialog"
                title={aiFindings.length === 0 ? 'Governance — no findings' : `Governance — ${aiFindings.length} finding${aiFindings.length === 1 ? '' : 's'}`}
                onClick={() => { setMenu(menu === 'governance' ? null : 'governance'); }}>
                <Policy size={16} /> <span className="dg-ai-gov-btn__label">Governance</span>
                <span className="dg-ai-gov-btn__count" aria-label={`${aiFindings.length} findings`}>{aiFindings.length}</span>
              </button>
              {menu === 'governance' && (
                <div className="dg-popover dg-popover--end dg-popover--wide" role="dialog" aria-label="Governance findings">
                  <AiFlowGovernance findings={aiFindings}
                    onSelect={(targetId) => { selectAndRevealTarget(targetId); requestTab('properties'); }} />
                </div>
              )}
            </div>
            <div className="dg-anchor kh-command-row">
              <IconBtn label="AI flow key" pressed={menu === 'ai-key'} onClick={() => { setMenu(menu === 'ai-key' ? null : 'ai-key'); }}><Help size={16} /></IconBtn>
              {menu === 'ai-key' && (
                <div className="dg-popover dg-popover--end dg-popover--wide" role="dialog" aria-label="AI flow key">
                  <AiFlowKey />
                </div>
              )}
            </div>
          </div>}
          <div className="dg-header__group kh-command-row">
          <div className="dg-anchor kh-command-row">
            <IconBtn label="Check text" pressed={menu === 'text-check'} onClick={() => { setMenu(menu === 'text-check' ? null : 'text-check'); }}><SpellCheck size={16} /></IconBtn>
            {menu === 'text-check' && (
              <div className="dg-popover dg-popover--end dg-popover--wide" role="dialog" aria-label="Check text">
                <DiagramTextCheck doc={doc}
                  onFix={(issues) => { commit(fixTextIssues(docRef.current, issues)); }}
                  onSelect={(targetId) => {
                    const cur = docRef.current;
                    if (cur.nodes.some((n) => n.id === targetId)) setSel({ nodes: [targetId], edges: [] });
                    else if (cur.edges.some((x) => x.id === targetId)) setSel({ nodes: [], edges: [targetId] });
                    else { const fn = footnotesOf(cur).find((f) => f.id === targetId); if (fn !== undefined) { setNotesHidden(false); selectFootnoteTarget(fn.targetId); } }
                  }} />
              </div>
            )}
          </div>
          <div className="dg-anchor kh-command-row">
            <IconBtn label="Named versions" pressed={menu === 'versions'} onClick={() => { setMenu(menu === 'versions' ? null : 'versions'); }}><RecentlyViewed size={16} /></IconBtn>
            {menu === 'versions' && (
              <div className="dg-popover dg-popover--end dg-popover--wide" role="dialog" aria-label="Named versions">
                <DiagramVersions canvasId={canvasId} doc={doc} assets={blobsRef.current} flush={saveNow}
                  notify={(message) => { notify('info', message, { key: 'versions' }); }}
                  onRestore={(version) => {
                    const cur = docRef.current;
                    const next = { ...normalizeDocument(version.document), viewport: cur.viewport, grid: cur.grid,
                      snapToGrid: gridSnapEnabled(cur), snapToShapes: shapeSnapEnabled(cur) };
                    commit(next);
                    pruneSelection(next);
                    setMenu(null);
                    notify('info', `Restored “${version.name}”. Undo (Ctrl+Z) to go back.`, { key: 'versions' });
                  }} />
              </div>
            )}
          </div>
          <IconBtn label="Present" disabled={doc.nodes.length === 0} onClick={startPresentation}><PresentationFile size={16} /></IconBtn>
          </div>
        </div>
        <div className="dg-header__panels">
          <div className="dg-anchor">
            <button type="button" className={`dg-text-btn${menu === 'export' ? ' dg-text-btn--active' : ''}`} aria-expanded={menu === 'export'} aria-haspopup="dialog" onClick={() => { setMenu(menu === 'export' ? null : 'export'); }}>
              <Download size={16} /> Export
            </button>
            {menu === 'export' && createPortal(
              <div className="dg-popover dg-popover--end dg-export" role="dialog" aria-label="Export diagram">
                <div className="dg-export__header">
                  <h2 className="dg-export__title">Export diagram</h2>
                  <IconBtn label="Close export" onClick={() => { setMenu(null); }}><Close size={16} /></IconBtn>
                </div>
                <div className="dg-export__body">
                <section className="dg-popover__section">
                  <h3 className="dg-popover__heading">Format</h3>
                  <Segmented value={exportFormat} onChange={value => { setExportFormat(value); setMuralResult(''); }} options={[{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' }, { value: 'drawio', label: 'draw.io' }, { value: 'mural', label: 'Mural' }]} label="Export format" />
                  {exportFormat === 'drawio' && <p className="dg-popover__hint">An editable file for draw.io (diagrams.net). Shapes, connectors, groups and icons stay editable; footnotes and the key come across as shapes.</p>}
                  {exportFormat === 'mural' && <div className="mural-integration">
                    <p className="dg-export__description">Continue editing in Mural with native shapes, text and attached connectors.</p>
                    <p className="dg-popover__hint">Groups and swimlanes become areas, exported expanded. Icons stay separate images. Mural may adjust fonts, shape borders and routing; line jumps are not transferred. Each export adds a new copy, not a synced diagram.</p>
                    {muralQuery.isPending && <p className="dg-popover__hint" role="status">Checking Mural connection...</p>}
                    {muralQuery.isError && <p className="connection-tokens__error" role="alert">Could not check Mural. <button type="button" className="dg-text-btn" onClick={() => { void muralQuery.refetch(); }}>Retry</button></p>}
                    {!muralQuery.data?.connected && <p className="dg-popover__hint"><SettingsLink to="/my-work?sync=1">Set up or reconnect Mural in Connections and sync</SettingsLink></p>}
                    {muralQuery.data?.connected && <MuralExportDestination value={muralBoardUrl ?? muralQuery.data.boardUrl}
                      title={canvas?.title ?? 'Athena diagram'}
                      disabled={exporting || doc.nodes.length === 0}
                      onChange={url => { setMuralBoardUrl(url); setMuralResult(''); }}
                      onCreated={url => runExport(false, url)} />}
                    {muralResult && <>
                      <p className="dg-popover__hint mural-integration__result" role="status">Editable diagram exported. <a href={muralResult} target="_blank" rel="noreferrer">Open board in Mural</a></p>
                      <button type="button" className="dg-text-btn" onClick={() => {
                        setEmailContent({ title: canvas?.title ?? 'Athena diagram', url: muralResult }); setMenu(null);
                      }}>Share Mural link by email</button>
                    </>}
                  </div>}
                </section>
                {exportFormat !== 'drawio' && exportFormat !== 'mural' && <section className="dg-popover__section">
                  <h3 className="dg-popover__heading">Background</h3>
                  <Segmented value={exportBg} onChange={setExportBg} options={[{ value: 'white', label: 'White' }, { value: 'transparent', label: 'Transparent' }]} label="Export background" />
                  <label className="dg-check">
                    <input type="checkbox" className="dg-check__input" checked={exportGrid} onChange={(e) => { setExportGrid(e.target.checked); }} />
                    <span className="dg-check__label">Include grid</span>
                  </label>
                </section>}
                <section className="dg-popover__section">
                  <h3 className="dg-popover__heading">Annotations</h3>
                  <label className="dg-check">
                    <input type="checkbox" className="dg-check__input" checked={exportFootnotes} disabled={footnotes.length === 0} onChange={(e) => { setExportFootnotes(e.target.checked); }} />
                    <span className="dg-check__label">Include footnotes</span>
                  </label>
                  <label className="dg-check">
                    <input type="checkbox" className="dg-check__input" checked={exportLegend} disabled={doc.legend?.visible !== true} onChange={(e) => { setExportLegend(e.target.checked); }} />
                    <span className="dg-check__label">Include colour key</span>
                  </label>
                </section>
                </div>
                <div className="dg-export__actions">
                {exportError && <p className="connection-tokens__error" role="alert">{exportError}</p>}
                <button type="button" className="dg-primary-btn" disabled={exporting || doc.nodes.length === 0 || (exportFormat === 'mural' && (!muralQuery.data?.connected || !(muralBoardUrl ?? muralQuery.data.boardUrl).trim()))} onClick={() => { void runExport(); }}>
                  {exporting ? <><InProgress size={16} className="dg-spin" /> Exporting…</> : <><Download size={16} /> {exportFormat === 'mural' ? 'Send editable diagram to Mural' : `Export ${exportFormat === 'drawio' ? 'draw.io' : exportFormat.toUpperCase()}`}</>}
                </button>
                {doc.nodes.length === 0 && <p className="dg-popover__hint">Add something to the diagram to export it.</p>}
                <button type="button" className="dg-text-btn" disabled={exporting || doc.nodes.length === 0} onClick={() => { void runExport(true); }}>
                  Share draw.io attachment by email
                </button>
                </div>
              </div>, document.body,
            )}
          </div>
          <IconBtn label="Delete diagram" danger onClick={() => { void deleteDiagram(); }}><TrashCan size={16} /></IconBtn>
        </div>
        </div>
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
          <button type="button" className={`dg-palette__item${lineTool ? ' dg-palette__item--active' : ''}`}
            aria-label="Draw line" title="Line - click, then drag on the canvas (Escape cancels)" aria-pressed={lineTool}
            onClick={() => { setLineTool(!lineTool); setMenu(null); }}>
            <ShapeGlyph kind="line" />
          </button>
          {!isAiFlow && <button type="button" className="dg-palette__item" title="Agent - add an AI agent to this standard diagram" aria-label="Add Agent"
            onClick={() => { addAiStep('specialist_agent'); }}><Bot size={20} /></button>}
          {isAiFlow && (
            <div className="dg-anchor dg-anchor--ai-steps">
              <button
                type="button" className={`dg-palette__item dg-palette__item--ai${menu === 'ai-step' ? ' dg-palette__item--active' : ''}`}
                title="AI flow step" aria-label="Add AI flow step" aria-expanded={menu === 'ai-step'} aria-haspopup="dialog"
                onClick={() => { setMenu(menu === 'ai-step' ? null : 'ai-step'); }}
              >
                <Bot size={20} />
              </button>
              {menu === 'ai-step' && (
                <div className="dg-popover dg-popover--side dg-ai-steps" role="dialog" aria-label="Add AI flow step">
                  <h3 className="dg-popover__heading">Add a step</h3>
                  <div className="dg-ai-steps__list">
                    {AI_FLOW_STEP_TYPES.map((t) => {
                      return (
                        <button key={t} type="button" className="dg-ai-steps__item" draggable
                          title={`${STEP_TYPE_LABELS[t]} — click to add, or drag onto the sheet`}
                          onClick={() => { addAiStep(t); }}
                          onDragStart={(e) => { e.dataTransfer.setData(SHAPE_MIME, `ai:${t}`); e.dataTransfer.effectAllowed = 'copy'; }}>
                          <span className="dg-ai-steps__swatch" style={{ background: DIAGRAM_ROLES[t].tint, borderColor: DIAGRAM_ROLES[t].colour }} aria-hidden="true">{STEP_TYPE_SHORT[t].code}</span>
                          <span className="dg-ai-steps__name">{STEP_TYPE_LABELS[t]}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="dg-popover__hint">Drop a step inside a lane to give it an owner. Swimlanes added now are numbered for Arrange lanes.</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dg-stage">
        <div ref={sheetRef} className={sheetClass} onDragOver={onDragOver} onDragLeave={() => { setDropHint(false); }} onDrop={onDrop}>
          <svg
            ref={svgRef} className="dg-canvas" role="application" aria-label="Diagram sheet"
            aria-description="Hold Space and drag to pan the canvas. Middle mouse drag also pans."
            onPointerEnter={() => { pointerOverCanvasRef.current = true; }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={(e) => { endDrag(e, false); }} onPointerCancel={(e) => { endDrag(e, true); }}
            onPointerLeave={() => { pointerOverCanvasRef.current = false; if (dragRef.current === null) setHoverId(null); }}
            onDoubleClick={onDoubleClick} onContextMenu={(e) => { if (dragRef.current?.kind === 'pan') e.preventDefault(); }}
          >
            <defs>
              <filter id={`${markerBase}-shadow`} x="-20%" y="-30%" width="140%" height="180%">
                {DIAGRAM_SHADOWS.map((shadow, index) => <feDropShadow key={index} {...shadow} />)}
              </filter>
              <pattern id={`${markerBase}-grid`} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse" x={(view.x % gridStep) - 1} y={(view.y % gridStep) - 1}>
                <circle cx={1} cy={1} r={1} className="dg-canvas__dot" />
              </pattern>
              {[...markerIds].map(([colour, id]) => (
                <marker key={id} id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={20 / 3} markerHeight={20 / 3} markerUnits="strokeWidth" orient="auto-start-reverse">
                  <path d="M0,1 L10,5 L0,9 z" fill={colour} />
                </marker>
              ))}
              {[...lineJumps.masks].map(([id, masks]) => (
                <mask key={id} id={`${markerBase}-jump-${id}`} maskUnits="userSpaceOnUse"
                  x={jumpBounds.x} y={jumpBounds.y} width={jumpBounds.width} height={jumpBounds.height}>
                  <rect {...jumpBounds} fill="white" />
                  {masks.map((mask, index) => <path key={index} d={mask.d} fill="none" stroke="black" strokeWidth={mask.width} />)}
                </mask>
              ))}
            </defs>
            {doc.grid && <rect className="dg-canvas__grid" x={0} y={0} width="100%" height="100%" fill={`url(#${markerBase}-grid)`} />}
            <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
              {drag?.kind === 'draw-line' && <line className="dg-preview-line" x1={drag.start.x} y1={drag.start.y}
                x2={drag.current.x} y2={drag.current.y} />}
              {display.edges.filter((edge) => edge.behind === true).map(renderEdge)}
              {ordered.map((n) => (
                <NodeShape key={n.id} node={n} shadowId={`${markerBase}-shadow`} asset={n.assetId === null ? undefined : assets[n.assetId]} selected={selNodeSet.has(n.id)} editing={editing?.kind === 'node' && editing.id === n.id}
                  dimmed={n.kind !== 'line' && keyDim(n.stroke)} hiddenCount={display.hiddenCount.get(n.id) ?? 0}
                  lineJumpPath={lineJumps.paths.get(n.id)} lineMask={lineJumps.masks.has(n.id) ? `url(#${markerBase}-jump-${n.id})` : undefined} aiFlow={isAiFlow} />
              ))}
              {ordered.filter(node => drilldownIds.has(node.id)).map(node => (
                <g key={`drilldown-${node.id}`} className="dg-drilldown-marker" role="button" tabIndex={0}
                  aria-label={`Open drill-down for ${descriptionPlainText(node.label).trim() || 'Untitled shape'}`}
                  transform={`translate(${node.x + 16} ${node.y + 16})`}
                  onPointerDown={event => { event.stopPropagation(); }}
                  onDoubleClick={event => { event.stopPropagation(); }}
                  onClick={event => { event.stopPropagation(); void openShapeDrilldown(node); }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault(); event.stopPropagation(); void openShapeDrilldown(node);
                    }
                  }}>
                  <title>Explore internal components</title>
                  <circle r={11} />
                  <path d="M-4,-3 L0,-5 L4,-3 L0,-1 Z M-4,0 L0,2 L4,0 M-4,3 L0,5 L4,3" />
                </g>
              ))}
              {display.edges.filter((edge) => edge.behind !== true).map(renderEdge)}
              {isAiFlow && (
                <g className="dg-ai-overlay" pointerEvents="none">
                  {ordered.map((n) => {
                    const finding = aiFindingMap.get(n.id);
                    const role = diagramRoleLayout(n);
                    const chips = aiStepChips(n, finding !== undefined, n.header !== undefined || (role?.label ?? null) !== null);
                    if (chips.length === 0 && finding === undefined) return null;
                    return (
                      <g key={n.id} data-ai-node={n.id} className={n.kind !== 'line' && keyDim(n.stroke) ? 'dg-ai-overlay--dimmed' : undefined}>
                        {chips.map((c) => <AiChipShape key={c.key} chip={c} />)}
                        {finding !== undefined && <AiFindingMark at={aiFindingAnchor(n)} severity={finding.severity} title={finding.findings.map((f) => f.message).join('\n')} />}
                      </g>
                    );
                  })}
                  {display.edges.map((edge) => {
                    const route = routes.get(edge.id);
                    if (route === undefined || route === null) return null;
                    const chip = aiEdgeChip(edge, route);
                    const finding = aiFindingMap.get(edge.id);
                    if (chip === null && finding === undefined) return null;
                    return (
                      <g key={edge.id} data-ai-edge={edge.id}>
                        {chip !== null && <AiChipShape chip={chip} />}
                        {finding !== undefined && <AiFindingMark at={aiEdgeFindingAnchor(route)} severity={finding.severity} title={finding.findings.map((f) => f.message).join('\n')} />}
                      </g>
                    );
                  })}
                </g>
              )}
              {footnotes.map((fn, i) => {
                if (display.hiddenBy.has(fn.targetId)) return null;
                const at = footnoteAnchor(display, fn.targetId, byId);
                if (at === null) return null;
                const target = byId.get(fn.targetId);
                const dimmed = target !== undefined ? target.kind !== 'line' && keyDim(target.stroke) : keyFilter !== null;
                const cls = dimmed ? 'dg-marker dg-marker--dimmed' : 'dg-marker';
                return (
                  <g key={fn.id} className={cls} data-dg="footnote" data-id={fn.id} role="link" aria-label={`Footnote ${i + 1}`}>
                    <title>{`Footnote ${i + 1} — show its note`}</title>
                    <circle cx={at.x} cy={at.y} r={footnoteR} />
                    <text x={at.x} y={at.y} fontSize={footnoteR * (i + 1 >= 10 ? 1 : 1.2)} textAnchor="middle" dominantBaseline="central">{i + 1}</text>
                  </g>
                );
              })}
              {notesBlock !== null && (
                <g className="dg-noteblock" aria-label="Diagram notes">
                  <rect className="dg-noteblock__frame" x={notesBlock.rect.x} y={notesBlock.rect.y} width={notesBlock.rect.width} height={notesBlock.rect.height} rx={4} />
                  <line className="dg-noteblock__divider" x1={notesBlock.divider.x} x2={notesBlock.divider.x + notesBlock.divider.width}
                    y1={notesBlock.divider.y} y2={notesBlock.divider.y} aria-hidden="true" />
                  <text className="dg-noteblock__heading" x={notesBlock.heading.x} y={notesBlock.heading.y} fontSize={NOTE_HEADING_FONT} dominantBaseline="hanging">Notes</text>
                  {notesBlock.items.map((item) => {
                    return (
                      <a key={item.id} id={`dg-footnote-${item.number}`} className="dg-noteblock__item" data-dg="footnote-item" data-id={item.id}
                        href={footnoteHref(canvasId, item.number)} aria-label={`Note ${item.number}: show it on the diagram`}
                        onClick={(e) => { e.preventDefault(); }}>
                        <rect className="dg-noteblock__hit" x={item.rect.x} y={item.rect.y} width={item.rect.width} height={item.rect.height} rx={3} />
                        <g className="dg-marker">
                          <circle cx={item.marker.x} cy={item.marker.y} r={FOOTNOTE_RADIUS} />
                          <text x={item.marker.x} y={item.marker.y} fontSize={item.number >= 10 ? FOOTNOTE_RADIUS : FOOTNOTE_RADIUS * 1.2} textAnchor="middle" dominantBaseline="central">{item.number}</text>
                        </g>
                        <text className="dg-noteblock__text" fontSize={NOTE_FONT}>
                          {item.lines.map((line, j) => (
                            <tspan key={j} x={line.x} y={line.y} fontWeight={line.bold ? 600 : 400}
                              className={line.muted ? 'dg-noteblock__muted' : undefined}>{line.runs === undefined ? line.text : line.runs.map((run, k) =>
                                <tspan key={k} fontWeight={run.bold ? 600 : 400} fontStyle={run.italic ? 'italic' : 'normal'}>{run.text}</tspan>)}</tspan>
                          ))}
                        </text>
                      </a>
                    );
                  })}
                </g>
              )}
              {singleNode?.kind === 'line' && !busyDrag && linePoints(singleNode).map((point, index) => (
                <circle key={`line-end-${index}`} className="dg-endpoint" data-dg="line-end" data-id={singleNode.id}
                  data-end={index} cx={point.x} cy={point.y} r={5 * inv}><title>Drag line endpoint</title></circle>
              ))}

              {dropTargetId !== null && byId.get(dropTargetId) !== undefined && (() => {
                const host = byId.get(dropTargetId);
                return host === undefined ? null : <rect className="dg-drop-target" x={host.x} y={host.y} width={host.width} height={host.height} />;
              })()}
              {selectedNodes.map((raw) => {
                const n = byId.get(raw.id) ?? raw;
                return <rect key={`sel-${n.id}`} className="dg-selection-box" x={n.x - 3 * inv} y={n.y - 3 * inv} width={n.width + 6 * inv} height={n.height + 6 * inv} />;
              })}
              {singleNode !== undefined && singleNode.kind !== 'line' && singleNode.collapsed !== true && !busyDrag && RESIZE_HANDLES.map((h) => {
                const pt = handlePoint(nodeRect(singleNode), h);
                return <rect key={h} className={`dg-handle dg-handle--${h}`} data-dg="resize" data-id={singleNode.id} data-handle={h} x={pt.x - 4 * inv} y={pt.y - 4 * inv} width={8 * inv} height={8 * inv} />;
              })}
              {[...portNodeIds].map((id) => {
                const n = byId.get(id);
                if (n === undefined || n.kind === 'line') return null;
                const r = nodeRect(n);
                return PORTS.map((port) => {
                  const pt = portPoint(r, port, n.kind, n.arrowDirection);
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
                  if (s !== undefined) from = portPoint(nodeRect(s), drag.sourcePort, s.kind, s.arrowDirection);
                } else {
                  const route = routes.get(drag.edgeId);
                  if (route !== undefined && route !== null) from = (drag.end === 'source' ? route[route.length - 1] : route[0]) ?? null;
                }
                const t = drag.targetId === null ? undefined : byId.get(drag.targetId);
                const to = t !== undefined && drag.targetPort !== null ? portPoint(nodeRect(t), drag.targetPort, t.kind, t.arrowDirection) : drag.current;
                return from === null ? null : <line className="dg-preview-line" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
              })()}
              <DrawingGuides guides={guides} spacing={spacing} view={{ ...view, zoom: z }} width={size.width} height={size.height} />
            </g>
          </svg>

          {doc.nodes.length === 0 && (
            <div className="dg-empty">
              <p className="dg-empty__title">Start your diagram</p>
              <p className="dg-empty__text">Click a shape on the left, drag it onto the sheet, or double-click anywhere. Paste or drop images to add icons.</p>
            </div>
          )}

          <DiagramLegend doc={doc} filter={keyFilter} onFilter={setKeyFilter} onChange={changeAnnotations} readOnly={presenting !== null} />

          {presenting !== null && (
            <div className="dg-present" role="region" aria-label="Presentation" onPointerDown={(e) => { e.stopPropagation(); }}>
              <div className="dg-present__caption">
                <p className="dg-present__step">{presentStep?.number !== null && presentStep?.number !== undefined ? `Note ${presentStep.number}` : 'Step'} · {presenting.index + 1} of {presenting.steps.length}</p>
                {presentStep !== null && presentStep.title !== '' && <h3 className="dg-present__title">{presentStep.title}</h3>}
                {presentStep !== null && presentStep.text !== '' && <p className="dg-present__text">{descriptionRuns(presentStep.text).map((run, index) =>
                  <span key={index} className={`${run.bold ? 'dg-description-run--bold' : ''}${run.italic ? ' dg-description-run--italic' : ''}`}>{run.text}</span>)}</p>}
              </div>
              <div className="dg-present__controls">
                <IconBtn label="Previous (←)" disabled={presenting.index === 0} onClick={() => { stepPresentation(-1); }}><ChevronLeft size={16} /></IconBtn>
                <IconBtn label="Next (→)" disabled={presenting.index >= presenting.steps.length - 1} onClick={() => { stepPresentation(1); }}><ChevronRight size={16} /></IconBtn>
                <IconBtn label="Show whole diagram" onClick={() => { focusTarget(null, false); }}><FitToScreen size={16} /></IconBtn>
                <button type="button" className="dg-text-btn" onClick={stopPresentation}>Exit (Esc)</button>
              </div>
            </div>
          )}

          {toolbarPos !== null && selectedNodes.length > 0 && (
            <div className="dg-context" role="toolbar" aria-label="Shape actions" style={{ left: toolbarPos.left, top: toolbarPos.top }} onPointerDown={(e) => { e.stopPropagation(); }}>
              {singleNode !== undefined && singleNode.kind !== 'line' && <IconBtn label={singleNode.kind === 'image' ? 'Edit caption (Enter)' : 'Edit label (Enter)'} onClick={startEditing}><Edit size={16} /></IconBtn>}
              <div className="dg-anchor">
                <IconBtn label="Style" pressed={menu === 'style'} onClick={() => { setMenu(menu === 'style' ? null : 'style'); }}><ColorPalette size={16} /></IconBtn>
                {menu === 'style' && (
                  <div className="dg-popover dg-popover--context" role="dialog" aria-label="Shape style">
                    {selectedNodes.length + selectedEdges.length > 1 ? selectionStyle : <>
                    {singleNode?.kind !== 'line' && <Swatches label="Fill" colours={FILLS} value={commonStyleValue(selectedNodes.map(n => diagramEditorNodeColours(n).fill))} onPick={(c) => { updateNodes(sel.nodes, (n) => ({ ...n, ...diagramEditorNodeColours(n), fill: c })); }} />}
                    <Swatches label="Border" colours={STROKES} value={only(allStrokes)} onPick={(c) => { updateNodes(sel.nodes, (n) => ({ ...n, stroke: c })); }} />
                    <Swatches label="Text" colours={TEXT_COLOURS} value={only(allText)} onPick={(c) => { updateNodes(sel.nodes, (n) => ({ ...n, textColor: c })); }} />
                    <div className="dg-stepper">
                      <span className="dg-stepper__label">Text size</span>
                      <button type="button" className="dg-stepper__btn" aria-label="Smaller text" disabled={fontSize <= FONT_MIN} onClick={() => { updateNodes(sel.nodes, (n) => ({ ...n, fontSize: Math.max(FONT_MIN, n.fontSize - 1) })); }}>−</button>
                      <output className="dg-stepper__value" aria-live="polite">{fontSize}</output>
                      <button type="button" className="dg-stepper__btn" aria-label="Larger text" disabled={fontSize >= FONT_MAX} onClick={() => { updateNodes(sel.nodes, (n) => ({ ...n, fontSize: Math.min(FONT_MAX, n.fontSize + 1) })); }}>+</button>
                    </div>
                    <ThicknessField value={singleNode === undefined ? undefined : diagramNodeStrokeWidth(singleNode)}
                      onChange={strokeWidth => { updateNodes(sel.nodes, n => ({ ...n, strokeWidth })); }} />
                    </>}
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
                    {topSelected.length >= 2 && (
                      <section className="dg-popover__section">
                        <h3 className="dg-popover__heading">Match size (to first selected)</h3>
                        <div className="dg-popover__row">
                          <button type="button" className="dg-text-btn" onClick={() => { matchSize('width'); }}>Same width</button>
                          <button type="button" className="dg-text-btn" onClick={() => { matchSize('height'); }}>Same height</button>
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
                          {hostOptions.map((n) => <option key={n.id} value={n.id}>{descriptionPlainText(n.label).trim() === '' ? KIND_LABEL[n.kind] : descriptionPlainText(n.label)} ({KIND_LABEL[n.kind].toLowerCase()})</option>)}
                        </select>
                      </label>
                      <button type="button" className="dg-text-btn dg-text-btn--block" onClick={wrapInContainer}><Group size={16} /> Group in a container</button>
                    </section>
                  </div>
                )}
              </div>
              {singleNode?.kind === 'image' && <IconBtn label="Replace image" onClick={() => { chooseFile(singleNode.id); }}><Upload size={16} /></IconBtn>}
              {singleNode !== undefined && isContainerKind(singleNode.kind) && (
                <IconBtn label={singleNode.collapsed === true ? 'Expand container' : 'Collapse container'} pressed={singleNode.collapsed === true} onClick={() => { toggleCollapsed(singleNode.id); }}>
                  {singleNode.collapsed === true ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </IconBtn>
              )}
              {singleNode !== undefined && <>
                <IconBtn label={singleFootnote === undefined ? 'Add footnote' : `Show footnote ${footnotes.indexOf(singleFootnote) + 1}`} pressed={singleFootnote !== undefined} onClick={() => { addFootnoteFor(singleNode.id); }}><ListNumbered size={16} /></IconBtn>
                <IconBtn label="Ask Athena about this shape" onClick={() => { askAthena(singleNode.id); }}><Chat size={16} /></IconBtn>
              </>}
              <span className="dg-divider" aria-hidden="true" />
              <IconBtn label="Duplicate (Ctrl+D)" onClick={duplicate}><Copy size={16} /></IconBtn>
              <IconBtn label="Delete (Del)" danger onClick={deleteSelected}><TrashCan size={16} /></IconBtn>
            </div>
          )}

          {toolbarPos !== null && selectedNodes.length === 0 && selectedEdges.length > 0 && (
            <div className="dg-context" role="toolbar" aria-label="Connector actions" style={{ left: toolbarPos.left, top: toolbarPos.top }} onPointerDown={(e) => { e.stopPropagation(); }}>
              {singleEdge !== undefined && <IconBtn label="Edit label (Enter)" onClick={startEditing}><Edit size={16} /></IconBtn>}
              {singleEdge !== undefined && <>
                <IconBtn label={singleFootnote === undefined ? 'Add footnote' : `Show footnote ${footnotes.indexOf(singleFootnote) + 1}`} pressed={singleFootnote !== undefined} onClick={() => { addFootnoteFor(singleEdge.id); }}><ListNumbered size={16} /></IconBtn>
                <IconBtn label="Ask Athena about this connector" onClick={() => { askAthena(singleEdge.id); }}><Chat size={16} /></IconBtn>
                {singleEdge.labelOffset !== undefined && <IconBtn label="Reset label position" onClick={() => { updateEdges([singleEdge.id], (x) => { const { labelOffset: _drop, ...rest } = x; return rest; }); }}><Reset size={16} /></IconBtn>}
              </>}
              <Segmented
                label="Connector route" value={only(edgeRoutes) ?? ''} compact
                options={[{ value: 'straight', label: 'Straight', glyph: <LineGlyph kind="straight" /> }, { value: 'orthogonal', label: 'Elbow', glyph: <LineGlyph kind="orthogonal" /> }]}
                onChange={(v) => { updateEdges(sel.edges, (x) => ({ ...x, route: v })); }}
              />
              <Segmented
                label="Arrowheads" value={only(edgeArrows) ?? ''} compact
                options={[{ value: 'none', label: 'No arrows', glyph: <LineGlyph kind="none" /> }, { value: 'end', label: 'Arrow at end', glyph: <LineGlyph kind="end" /> }, { value: 'start', label: 'Arrow at start', glyph: <LineGlyph kind="start" /> }, { value: 'both', label: 'Arrows at both ends', glyph: <LineGlyph kind="both" /> }]}
                onChange={(v) => { updateEdges(sel.edges, (x) => ({ ...x, arrows: v })); }}
              />
              <IconBtn label={allDashed ? 'Solid line' : 'Dashed line'} pressed={allDashed} onClick={() => { updateEdges(sel.edges, (x) => applyDiagramEdgeStyle(x, { dashed: !allDashed })); }}><LineGlyph kind="dashed" /></IconBtn>
              <div className="dg-anchor">
                <IconBtn label="Connector style" pressed={menu === 'edge-colour'} onClick={() => { setMenu(menu === 'edge-colour' ? null : 'edge-colour'); }}>
                  <span className="dg-colour-dot" style={{ background: only(edgeColours) ?? 'transparent' }} />
                </IconBtn>
                {menu === 'edge-colour' && (
                  <div className="dg-popover dg-popover--context" role="dialog" aria-label="Connector style">
                    <Swatches label="Line colour" colours={EDGE_COLOURS} value={only(edgeColours)} onPick={(c) => { updateEdges(sel.edges, (x) => applyDiagramEdgeStyle(x, { stroke: c })); }} />
                    <ThicknessField value={commonStyleValue(selectedEdges.map(edge => diagramEdgeAppearance(edge).width))}
                      onChange={strokeWidth => { updateEdges(sel.edges, edge => applyDiagramEdgeStyle(edge, { strokeWidth })); }} />
                    <label className="dg-field">
                      <span className="dg-field__label">Text size</span>
                      <select className="dg-select" aria-label="Connector text size"
                        value={only(new Set(selectedEdges.map(edge => edge.fontSize ?? 12))) ?? ''}
                        onChange={(event) => { const fontSize = Number(event.target.value); updateEdges(sel.edges, edge => ({ ...edge, fontSize })); }}>
                        <option value="" disabled>Mixed</option>
                        {Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i)
                          .map(size => <option key={size} value={size}>{size} px</option>)}
                      </select>
                    </label>
                  </div>
                )}
              </div>
              {anyBends && <IconBtn label="Remove bends" onClick={() => { updateEdges(sel.edges, (x) => ({ ...x, waypoints: [] })); }}><Reset size={16} /></IconBtn>}
              <span className="dg-divider" aria-hidden="true" />
              <IconBtn label="Bring to front" pressed={selectedEdges.every((x) => x.behind !== true)}
                onClick={() => { updateEdges(sel.edges, (x) => { const next = { ...x }; delete next.behind; return next; }); }}><BringToFront size={16} /></IconBtn>
              <IconBtn label="Send to back (behind shapes)" pressed={selectedEdges.every((x) => x.behind === true)}
                onClick={() => { updateEdges(sel.edges, (x) => ({ ...x, behind: true })); }}><SendToBack size={16} /></IconBtn>
              <span className="dg-divider" aria-hidden="true" />
              <IconBtn label="Delete (Del)" danger onClick={deleteSelected}><TrashCan size={16} /></IconBtn>
            </div>
          )}

          {editing !== null && editorBox !== null && (
            <LabelEditor
              key={`${editing.kind}:${editing.id}`} initial={editing.value} box={editorBox} limit={editing.kind === 'node' ? 2000 : 500}
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
      </div>

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
      {drilldown !== null && <DiagramDrilldown canvasId={drilldown.canvasId} shapeTitle={drilldown.shapeTitle}
        parentTitle={savedTitle} parentContext={athenaContext} onOpenNote={onOpenNote} onClose={() => {
          setDrilldown(null);
          void queryClient.invalidateQueries({ queryKey: ['diagram-drilldowns', canvasId] });
          rootRef.current?.focus({ preventScroll: true });
        }} />}
    </div>
    <SideTabsPanel
      storageKey="diagram-side"
      label="Diagram side panel"
      defaultTab="properties"
      width={CANVAS_SIDE_WIDTH}
      selectTab={tabRequest}
      tabs={[
        {
          id: 'athena', label: 'Athena', keepMounted: true, fill: true,
          content: <div className="dg-athena">
            <p className="dg-athena__hint">{saveStatus === 'saved'
              ? 'Athena reads saved shapes, descriptions and connectors, and can compare other diagrams.'
              : 'Changes are not saved yet. Athena can only read the last saved diagram.'}</p>
            <DiagramChatTarget context={athenaContext} prompt={athenaPrompt} visible />
          </div>,
        },
        {
          id: 'properties', label: 'Properties',
          content: <div className="dg-properties">
        {canvas !== undefined && <DiagramMetadata canvas={canvas} onSaved={(summary) => {
          queryClient.setQueryData<CanvasFullApi>(['canvas', canvasId], current => current === undefined ? undefined : { ...current, ...summary });
          void queryClient.invalidateQueries({ queryKey: ['canvases'] });
        }} />}
        {canvasPending && <p className="dg-properties__empty" role="status">Loading diagram properties…</p>}
        {canvasError !== null && <div className="dg-metadata__error" role="alert">
          Could not load diagram properties: {canvasError.message}
          <button type="button" className="dg-text-btn" onClick={() => { void refetchCanvas(); }}>Retry diagram properties</button>
        </div>}
        <details className="dg-section" open>
        <summary className="dg-section__summary">Shape or connector properties</summary>
        {singleNode !== undefined || singleEdge !== undefined ? <DiagramProperties
          aiFlow={isAiFlow}
          onIconChange={icon => {
            if (singleNode !== undefined) updateNodes([singleNode.id], node => {
              const rest = { ...node };
              delete rest.icon;
              return icon === undefined ? rest : { ...rest, icon };
            });
          }}
          onResetHeader={() => {
            if (singleNode !== undefined) updateNodes([singleNode.id], node => {
              const rest = { ...node };
              delete rest.header;
              return rest;
            });
          }}
          key={singleNode?.id ?? singleEdge?.id}
          item={(singleNode ?? singleEdge)!}
          kind={singleNode === undefined ? 'Connector' : KIND_LABEL[singleNode.kind]}
          titleLimit={singleNode === undefined ? 500 : 2000}
          onArrowDirectionChange={(arrowDirection) => {
            if (singleNode?.kind !== 'arrow') return;
            updateNodes([singleNode.id], n => {
              const turned = arrowAxis(n.arrowDirection) !== arrowAxis(arrowDirection);
              return { ...n, arrowDirection, ...(turned ? { width: n.height, height: n.width } : {}) };
            });
          }}
          onCalloutTypeChange={(calloutType) => {
            if (singleNode?.kind !== 'text') return;
            updateNodes([singleNode.id], n => {
              const { calloutType: previous, ...plain } = n;
              return calloutType === undefined ? { ...plain, height: Math.max(MIN_NODE_SIZE, n.height - (calloutLayout(n)?.height ?? 0)) } : { ...n, calloutType,
                height: previous === undefined ? Math.max(n.height + 32, 64) : n.height };
            });
          }}
          onFontSizeChange={(fontSize) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, fontSize }));
            else if (singleEdge !== undefined) updateEdges([singleEdge.id], edge => ({ ...edge, fontSize }));
          }}
          onBackgroundChange={(fill) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, ...diagramEditorNodeColours(n), fill }));
          }}
          onBorderChange={(border) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, ...diagramEditorNodeColours(n), ...border }));
          }}
          onThicknessChange={(strokeWidth) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, strokeWidth }));
            else if (singleEdge !== undefined) updateEdges([singleEdge.id], edge => applyDiagramEdgeStyle(edge, { strokeWidth }));
          }}
          onEdgeStyleChange={(patch) => {
            if (singleEdge !== undefined) updateEdges([singleEdge.id], edge => applyDiagramEdgeStyle(edge, patch));
          }}
          onAlignmentChange={(alignment) => {
            if (singleNode !== undefined) updateNodes([singleNode.id], n => ({ ...n, ...alignment }));
          }}
          onChange={(field, value, first) => {
            const current = docRef.current;
            const id = singleNode?.id ?? singleEdge?.id;
            const next = singleNode !== undefined
              ? { ...current, nodes: current.nodes.map((n) => n.id !== id ? n : field === 'label' ? setNodeLabel(n, value) : { ...n, [field]: value }) }
              : { ...current, edges: current.edges.map((edge) => edge.id !== id ? edge : { ...edge, [field]: value }) };
            if (first) commit(next);
            else { setDoc(next); markDirty(SAVE_DELAY_MS); }
          }}
        /> : selectedNodes.length + selectedEdges.length > 1 ? selectionStyle
          : <p className="dg-properties__empty">Select a shape or connector to edit its title and description.</p>}
        {isAiFlow && singleId !== undefined && <AiFlowProperties
          key={`ai-${singleId}`} node={singleNode} edge={singleEdge} nextLaneOrder={nextLaneOrder(doc)}
          gateConnector={singleEdge !== undefined && doc.nodes.some((n) => (n.id === singleEdge.sourceId || n.id === singleEdge.targetId) && n.flow?.stepType === 'decision_gate')}
          onNodeChange={(next, first) => {
            const current = docRef.current;
            const updated = { ...current, nodes: current.nodes.map((n) => n.id === next.id ? next : n) };
            if (first) commit(updated);
            else { setDoc(updated); markDirty(SAVE_DELAY_MS); }
          }}
          onEdgeChange={(next, first) => {
            const current = docRef.current;
            const updated = { ...current, edges: current.edges.map((x) => x.id === next.id ? next : x) };
            if (first) commit(updated);
            else { setDoc(updated); markDirty(SAVE_DELAY_MS); }
          }}
        />}
        {singleNode?.kind === 'image' && <div className="dg-properties__actions">
          <button type="button" className="dg-text-btn" onClick={() => {
            const asset = singleNode.assetId ? assets[singleNode.assetId] : undefined;
            if (asset?.status !== 'ready') { notify('error', 'Wait for the image to load, or retry the image.'); return; }
            setImagePreview({ source: asset.url, title: singleNode.label || 'Diagram image' });
          }}><ZoomIn size={16} /> Open image full screen</button>
          <button type="button" className="dg-text-btn" onClick={() => {
            const asset = singleNode.assetId ? assets[singleNode.assetId] : undefined;
            if (asset?.status !== 'ready') { notify('error', 'Wait for the image to load, or retry the image.'); return; }
            void copyImage(asset.url).then(() => { notify('info', 'Image copied.'); }).catch((cause: unknown) => {
              notify('error', `Could not copy image: ${describeError(cause).message}`);
            });
          }}><Copy size={16} /> Copy image</button>
        </div>}
        {singleId !== undefined && <EntityLinks
          key={`links-${singleId}`} source={{ type: 'diagram', id: canvasId, elementId: singleId }} title="Shape links"
          onOpenNote={onOpenNote} beforeChange={beforeElementLink}
        />}
        {singleFootnote !== undefined && <DiagramFootnoteControls canvasId={canvasId} doc={doc} footnoteId={singleFootnote.id}
          onChange={changeAnnotations} onCopied={(message) => { notify('info', message, { key: 'footnote-copy' }); }} />}
        {singleNode !== undefined && <div className="dg-drilldown-control">
          <button type="button" className="dg-text-btn dg-text-btn--block" disabled={openingDrilldown || drilldowns.isPending || drilldowns.isError}
            onClick={() => { void openShapeDrilldown(singleNode); }}>
            <Layers size={16} /> {openingDrilldown ? 'Opening…' : drilldowns.isPending ? 'Loading drill-down…'
              : drilldownIds.has(singleNode.id) ? 'Open drill-down' : 'Add drill-down diagram'}
          </button>
          <p>Explore this shape's internal components in a separate diagram.</p>
        </div>}
        {drilldowns.error !== null && <div className="dg-metadata__error" role="alert">
          Could not load drill-downs: {drilldowns.error.message}
          <button type="button" className="dg-text-btn" onClick={() => { void drilldowns.refetch(); }}>Retry drill-downs</button>
        </div>}
        {singleId !== undefined && <div className="dg-properties__actions">
          {singleFootnote === undefined && <button type="button" className="dg-text-btn" onClick={() => { addFootnoteFor(singleId); }}>
            <ListNumbered size={16} /> Add footnote
          </button>}
          <button type="button" className="dg-text-btn" onClick={() => { askAthena(singleId); }}><Chat size={16} /> Ask Athena</button>
        </div>}
        </details>
        <EntityLinks key={canvasId} source={{ type: 'diagram', id: canvasId }} title="Diagram links" onOpenNote={onOpenNote} beforeChange={beforeElementLink} />
          </div>,
        },
        ...(designPanel ? [{ id: 'design', label: 'Design', content: <div className="dg-properties">{designPanel}</div> }] : []),
      ]}
    />
    </div>
  </>);
};

function ThicknessField({ value, onChange }: { value: number | undefined; onChange: (width: number) => void }): React.ReactElement {
  const widths = [0.5, 1, 1.25, 1.5, 2, 3, 4, 6];
  return <label className="dg-properties__field">Line / border thickness
    <select aria-label="Line / border thickness" value={value ?? ''} onChange={event => { onChange(Number(event.target.value)); }}>
      <option value="" disabled>Mixed</option>
      {widths.map(width => <option key={width} value={width}>{width} px</option>)}
      {value !== undefined && !widths.includes(value) && <option value={value}>{value} px</option>}
    </select>
  </label>;
}

function DiagramSelectionStyle({ nodes, edges, onChange }: {
  nodes: readonly DiagramNode[]; edges: readonly DiagramEdge[];
  onChange: (nodes: DiagramNodeStyle, edges: DiagramEdgeStyle) => void;
}): React.ReactElement {
  const items = [...nodes, ...edges];
  const filledNodes = nodes.filter(node => node.kind !== 'line');
  return <div className="dg-properties__fields">
    <p className="dg-properties__kind">{items.length} selected</p>
    <p className="dg-properties__hint">Mixed values are left unchanged until you choose a style. Titles and descriptions remain individual.</p>
    {filledNodes.length > 0 && <Swatches label="Background colour" colours={FILLS}
      value={commonStyleValue(filledNodes.map(node => diagramEditorNodeColours(node).fill))}
      onPick={fill => { onChange({ fill }, {}); }} />}
    <Swatches label="Line / border colour" colours={STROKES}
      value={commonStyleValue(items.map(item => 'kind' in item ? diagramEditorNodeColours(item).stroke : diagramEdgeAppearance(item).stroke))}
      onPick={stroke => { onChange({ stroke }, { stroke }); }} />
    {nodes.length > 0 && <Swatches label="Text colour" colours={TEXT_COLOURS}
      value={commonStyleValue(nodes.map(node => diagramEditorNodeColours(node).textColor))}
      onPick={textColor => { onChange({ textColor }, {}); }} />}
    <ThicknessField value={commonStyleValue(items.map(item => 'kind' in item ? diagramNodeStrokeWidth(item) : diagramEdgeAppearance(item).width))}
      onChange={strokeWidth => { onChange({ strokeWidth }, { strokeWidth }); }} />
    {nodes.length > 0 && <div className="dg-properties__field">
      <span>Border style (shapes)</span>
      <Segmented label="Selected shape border style" value={commonStyleValue(nodes.map(node => node.strokeStyle ?? 'solid')) ?? ''}
        options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }]}
        onChange={strokeStyle => { onChange({ strokeStyle }, {}); }} />
    </div>}
    {edges.length > 0 && <div className="dg-properties__field">
      <span>Line style (connectors)</span>
      <Segmented label="Selected connector line style" value={commonStyleValue(edges.map(edge => diagramEdgeAppearance(edge).dash !== undefined ? 'dashed' : 'solid')) ?? ''}
        options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }]}
        onChange={value => { onChange({}, { dashed: value === 'dashed' }); }} />
      <span>Arrowheads (connectors)</span>
      <Segmented label="Selected connector arrowheads" value={commonStyleValue(edges.map(edge => edge.arrows)) ?? ''}
        options={[{ value: 'none', label: 'None' }, { value: 'end', label: 'End' }, { value: 'start', label: 'Start' }, { value: 'both', label: 'Both' }]}
        onChange={arrows => { onChange({}, { arrows }); }} />
    </div>}
    <label className="dg-properties__field">Text size
      <select aria-label="Selected text size" value={commonStyleValue(items.map(item => item.fontSize ?? 12)) ?? ''}
        onChange={event => { const fontSize = Number(event.target.value); onChange({ fontSize }, { fontSize }); }}>
        <option value="" disabled>Mixed</option>
        {Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i).map(size => <option key={size} value={size}>{size} px</option>)}
      </select>
    </label>
  </div>;
}

function DiagramProperties({ item, kind, titleLimit, aiFlow, onIconChange, onResetHeader, onChange, onAlignmentChange, onThicknessChange, onEdgeStyleChange, onBorderChange, onBackgroundChange, onFontSizeChange, onCalloutTypeChange, onArrowDirectionChange }: {
  item: DiagramNode | DiagramEdge; kind: string; titleLimit: number;
  aiFlow: boolean;
  onIconChange: (icon: DiagramIconName | null | undefined) => void;
  onResetHeader: () => void;
  onChange: (field: 'label' | 'description' | 'header', value: string, first: boolean) => void;
  onAlignmentChange: (alignment: Partial<Pick<DiagramNode, 'textAlign' | 'textVerticalAlign'>>) => void;
  onThicknessChange: (strokeWidth: number) => void;
  onEdgeStyleChange: (patch: Partial<Pick<DiagramEdge, 'dashed' | 'arrows'>>) => void;
  onBorderChange: (border: Partial<Pick<DiagramNode, 'stroke' | 'strokeStyle'>>) => void;
  onBackgroundChange: (fill: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  onCalloutTypeChange: (calloutType: DiagramCalloutType | undefined) => void;
  onArrowDirectionChange: (direction: DiagramArrowDirection) => void;
}): React.ReactElement {
  const firstEdit = useRef(true);
  const change = (field: 'label' | 'description' | 'header', value: string): void => {
    onChange(field, value, firstEdit.current);
    firstEdit.current = false;
  };
  const supportsAppearance = 'kind' in item && DIAGRAM_ICON_KINDS.includes(item.kind);
  const titleField = <label className="dg-properties__field">Title
    <textarea aria-label="Shape or connector title" rows={2} maxLength={titleLimit} value={item.label} spellCheck
      onFocus={() => { firstEdit.current = true; }} onChange={(e) => { change('label', e.target.value); }}
      onKeyDown={(e) => { formatTitleKey(e, item.label, titleLimit, (value) => { firstEdit.current = true; change('label', value); }); }} />
  </label>;
  return <div className="dg-properties__fields">
    <p className="dg-properties__kind">{kind}</p>
    {supportsAppearance && titleField}
    {'kind' in item && DIAGRAM_ICON_KINDS.includes(item.kind) && <>
      <div className="dg-properties__field">
        <label className="dg-properties__field">Header
          <input aria-label="Shape header" maxLength={80} value={item.header ?? (aiFlow && item.flow ? DIAGRAM_ROLES[item.flow.stepType].label : '')}
            placeholder="No header" onFocus={() => { firstEdit.current = true; }}
            onChange={event => { change('header', event.target.value); }} />
        </label>
        <div className="dg-shape-presets" role="group" aria-label="Header presets">
          {['Agent', 'Human', 'Pipeline', 'System', ''].map(header => <button type="button" className="dg-text-btn" key={header}
            aria-pressed={item.header === header} onClick={() => {
              firstEdit.current = true;
              change('header', header);
              if (header === 'System') onIconChange('system');
            }}>
            {header || 'None'}
          </button>)}
          {aiFlow && item.flow && <button type="button" className="dg-text-btn" onClick={onResetHeader}
            disabled={item.header === undefined}>Use step type</button>}
        </div>
        <p className="dg-properties__hint">Display text only; does not change the step type.</p>
      </div>
      <details className="dg-shape-icons">
        <summary>Icon: {item.icon === undefined ? 'Automatic' : item.icon === null ? 'None' : DIAGRAM_SHAPE_ICONS[item.icon].label}</summary>
        <div className="dg-shape-icons__options" role="group" aria-label="Shape icon">
          <button type="button" aria-pressed={item.icon === undefined} onClick={() => { onIconChange(undefined); }}>Automatic</button>
          <button type="button" aria-pressed={item.icon === null} onClick={() => { onIconChange(null); }}>None</button>
          {DIAGRAM_ICON_NAMES.map(name => {
            const choice = DIAGRAM_SHAPE_ICONS[name];
            const Icon = choice.icon;
            return <button type="button" key={name} aria-pressed={item.icon === name} onClick={() => { onIconChange(name); }}>
              <Icon size={20} aria-hidden="true" /><span>{choice.label}</span>
            </button>;
          })}
        </div>
        <p className="dg-properties__hint">Automatic uses the header preset or AI step type. Choose None to hide just the icon.</p>
      </details>
    </>}
    {'kind' in item && item.kind === 'text' && <label className="dg-properties__field">Callout type
      <select aria-label="Callout type" value={item.calloutType ?? ''}
        onChange={event => {
          const value = DIAGRAM_CALLOUT_TYPES.find(type => type === event.target.value);
          onCalloutTypeChange(value);
        }}>
        <option value="">Plain text</option>
        {DIAGRAM_CALLOUT_TYPES.map(type => <option key={type} value={type}>{DIAGRAM_CALLOUTS[type].label}</option>)}
      </select>
      <span className="dg-properties__hint">Adds a type label and icon. The title remains your callout text.</span>
    </label>}
    {'kind' in item && item.kind === 'arrow' && <div className="dg-properties__field dg-properties__arrow-direction">
      <span>Direction</span>
      <Segmented label="Arrow direction" value={item.arrowDirection ?? 'right'}
        options={[{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }, { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' },
          { value: 'left-right', label: 'Double-headed horizontal' }, { value: 'up-down', label: 'Double-headed vertical' }]}
        onChange={onArrowDirectionChange} />
    </div>}
    {!supportsAppearance && titleField}
    <div className="dg-properties__border">
    {'kind' in item && <>
      {item.kind !== 'line' && <Swatches label="Background colour" colours={FILLS} value={diagramEditorNodeColours(item).fill}
        onPick={onBackgroundChange} />}
      <Swatches label={item.kind === 'line' ? 'Line colour' : 'Border colour'} colours={STROKES} value={diagramEditorNodeColours(item).stroke}
        onPick={(stroke) => { onBorderChange({ stroke }); }} />
      <div className="dg-properties__field">
        <span>{item.kind === 'line' ? 'Line style' : 'Border style'}</span>
        <Segmented label={item.kind === 'line' ? 'Line style' : 'Border style'} value={item.strokeStyle ?? 'solid'}
          options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }]}
          onChange={(strokeStyle) => { onBorderChange({ strokeStyle }); }} />
      </div>
    </>}
    {!('kind' in item) && <>
      <div className="dg-properties__field">
        <span>Line style</span>
        <Segmented label="Connector line style" value={diagramEdgeAppearance(item).dash !== undefined ? 'dashed' : 'solid'}
          options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }]}
          onChange={(value) => { onEdgeStyleChange({ dashed: value === 'dashed' }); }} />
      </div>
      <div className="dg-properties__field">
        <span>Arrowheads</span>
        <Segmented label="Connector arrowheads" value={item.arrows}
          options={[{ value: 'none', label: 'None' }, { value: 'end', label: 'End' }, { value: 'start', label: 'Start' }, { value: 'both', label: 'Both' }]}
          onChange={(value) => { onEdgeStyleChange({ arrows: value }); }} />
      </div>
    </>}
    <label className="dg-properties__field">{'kind' in item && item.kind !== 'line' ? 'Border thickness' : 'Line thickness'}
      <select aria-label={'kind' in item && item.kind !== 'line' ? 'Border thickness' : 'Line thickness'} value={'kind' in item ? diagramNodeStrokeWidth(item) : diagramEdgeAppearance(item).width}
        onChange={(event) => { onThicknessChange(Number(event.target.value)); }}>
        {[0.5, 1, 1.25, 1.5, 2, 3, 4, 6].map(width => <option key={width} value={width}>{width} px</option>)}
        {item.strokeWidth !== undefined && ![0.5, 1, 1.25, 1.5, 2, 3, 4, 6].includes(item.strokeWidth)
          && <option value={item.strokeWidth}>{item.strokeWidth} px</option>}
      </select>
    </label>
    </div>
    <DiagramDescriptionEditor key={item.id} value={item.description ?? ''}
      onFocus={() => { firstEdit.current = true; }}
      onChange={(value, first) => {
        if (first) { onChange('description', value, true); firstEdit.current = true; }
        else change('description', value);
      }} />
    {(!('kind' in item) || item.kind !== 'line') && <div className="dg-properties__alignment">
      <label className="dg-properties__field">Text size
        <select aria-label="Text size" value={item.fontSize ?? 12}
          onChange={(event) => { onFontSizeChange(Number(event.target.value)); }}>
          {Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i)
            .map(size => <option key={size} value={size}>{size} px</option>)}
        </select>
      </label>
      {'kind' in item && <>
      <span>Horizontal text alignment</span>
      <Segmented label="Text horizontal alignment" value={item.textAlign ?? (item.kind === 'container' ? 'left' : 'center')}
        options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]}
        onChange={(value) => { onAlignmentChange({ textAlign: value }); }} />
      <span>Vertical text alignment</span>
      <Segmented label="Text vertical alignment" value={item.textVerticalAlign ?? 'middle'}
        options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]}
        onChange={(value) => { onAlignmentChange({ textVerticalAlign: value }); }} />
      </>}
    </div>}
    <p className="dg-properties__hint">{'kind' in item && item.kind === 'line' ? 'Title and description are saved but not displayed on the line.' : 'Title is shown on the diagram. Description is saved with this item but not displayed on the drawing.'} Changes save automatically.</p>
  </div>;
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function handlePoint(r: Rect, h: ResizeHandle): P {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2;
  return { x, y };
}

/** Title text with its **bold** and *italic* Markdown runs; `lines` are wrapped from the plain text of `source`. */
function styledTspans(source: string, lines: string[]): React.ReactElement[][] {
  return styledLines(source, lines).map((runs) => runs.map((run, j) => (
    <tspan key={j} fontWeight={run.bold ? 700 : undefined} fontStyle={run.italic ? 'italic' : undefined}>{run.text}</tspan>
  )));
}

function TextLines({ lines, source, cx, cy, fontSize, color, anchorX, anchor = 'middle', weight }: {
  lines: string[]; source: string; cx: number; cy: number; fontSize: number; color: string; anchorX?: number | undefined;
  anchor?: 'start' | 'middle' | 'end' | undefined; weight?: number | undefined;
}): React.ReactElement | null {
  if (lines.length === 0) return null;
  const lineH = fontSize * 1.25;
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  const x = anchorX ?? cx;
  const styled = styledTspans(source, lines);
  return (
    <text className="dg-node__label" x={x} y={startY} fontSize={fontSize} fill={color} textAnchor={anchor} dominantBaseline="central" fontWeight={weight}>
      {lines.map((_, i) => <tspan key={i} x={x} y={startY + i * lineH}>{styled[i]}</tspan>)}
    </text>
  );
}

interface NodeShapeProps { node: DiagramNode; shadowId: string; asset: AssetState | undefined; selected: boolean; editing: boolean; dimmed?: boolean; hiddenCount?: number; lineJumpPath?: string | undefined; lineMask?: string | undefined; aiFlow?: boolean }

const NodeShape = React.memo(function NodeShape({ node: n, shadowId, asset, selected, editing, dimmed = false, hiddenCount = 0, lineJumpPath, lineMask, aiFlow = false }: NodeShapeProps): React.ReactElement {
  const { x, y, width: w, height: h, fontSize: fs } = n;
  const { fill, stroke, textColor: color } = diagramEditorNodeColours(n);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const source = editing ? '' : n.label;
  const label = descriptionPlainText(source);
  const border = { strokeDasharray: diagramBorderDash(n), strokeLinecap: n.strokeStyle === 'dotted' ? 'round' as const : 'butt' as const };
  const common = { className: 'dg-node__body', fill, stroke, strokeWidth: diagramNodeStrokeWidth(n), ...border, pointerEvents: 'all' as const };
  const role = diagramRoleLayout(n, aiFlow);
  const radius = diagramNodeRadius(n);
  let body: React.ReactNode;
  let text: React.ReactNode = null;
  const maxLines = (avail: number): number => Math.max(1, Math.floor(avail / (fs * 1.25)));
  switch (n.kind) {
    case 'line': {
      const [start, end] = linePoints(n);
      body = lineJumpPath !== undefined ? <>
        <path className="dg-line__hit" d={lineJumpPath} />
        <path {...common} fill="none" d={lineJumpPath} mask={lineMask} />
      </> : <>
        <line className="dg-line__hit" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
        <line {...common} fill="none" x1={start.x} y1={start.y} x2={end.x} y2={end.y} mask={lineMask} />
      </>;
      break;
    }
    case 'document':
      body = <path {...common} d={documentShapePath(n)} />;
      break;
    case 'arrow': {
      body = <path {...common} strokeLinejoin="round" d={arrowShapePath(n, n.arrowDirection)} />;
      const layout = diagramTextLayout({ ...n, label: source });
      text = <TextLines source={source} lines={layout.lines} cx={layout.x} cy={layout.y} anchor={layout.anchor} fontSize={fs} color={color} />;
      break;
    }
    case 'process':
      body = <rect {...common} x={x} y={y} width={w} height={h} rx={radius} />;
      text = <TextLines source={source} lines={wrapText(label, w - 16, fs, maxLines(h - 8))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'decision':
      body = <path {...common} d={decisionShapePath(n)} />;
      text = <TextLines source={source} lines={wrapText(label, w * 0.62, fs, maxLines(h * 0.6))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'hexagon':
      body = <path {...common} strokeLinejoin="round" d={hexagonShapePath(n)} />;
      break;
    case 'terminator':
      body = <rect {...common} x={x} y={y} width={w} height={h} rx={Math.min(h, w) / 2} />;
      text = <TextLines source={source} lines={wrapText(label, w - h * 0.6, fs, maxLines(h - 8))} cx={cx} cy={cy} fontSize={fs} color={color} />;
      break;
    case 'text':
      body = <rect {...common} x={x} y={y} width={w} height={h} rx={radius} />;
      text = <TextLines source={source} lines={wrapText(label, w - 8, fs, maxLines(h))} cx={cx} cy={cy} fontSize={fs} color={color} />;
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
        text = <TextLines source={source} lines={wrapText(label, w - 4, fs, 1)} cx={cx} cy={y + h - capH / 2 - 2} fontSize={fs} color={color} />;
      }
      break;
    }
    case 'container':
      body = (
        <>
          <rect {...common} x={x} y={y} width={w} height={h} rx={radius} />
          <line className="dg-node__divider" x1={x} y1={y + containerHeader(n).height} x2={x + w} y2={y + containerHeader(n).height} stroke={stroke} strokeWidth={n.strokeWidth ?? 1} {...border} />
        </>
      );
      break;
    case 'swimlane': {
      const owner = aiFlow ? aiLaneOwnerLayout(n) : null;
      const bandX = x + SWIMLANE_HEADER / 2 + (owner?.titleShift ?? 0);
      const lines = wrapText(label, h - 16, fs, 1);
      body = (
        <>
          <rect {...common} x={x} y={y} width={w} height={h} />
          <rect className="dg-node__band" x={x} y={y} width={SWIMLANE_HEADER} height={h} fill={stroke === 'none' ? '#e0e0e0' : stroke} fillOpacity={0.1} stroke={stroke} strokeWidth={n.strokeWidth ?? 1.5} {...border} pointerEvents="none" />
          {owner !== null && (
            <text className="dg-node__label dg-node__lane-owner" data-ai-lane-owner="true" x={owner.x} y={owner.y} fontSize={owner.fontSize} fill={color}
              textAnchor="middle" dominantBaseline="central" transform={owner.rotation}>{owner.text}</text>
          )}
        </>
      );
      text = lines.length === 0 ? null : (
        <text className="dg-node__label" x={bandX} y={cy} fontSize={fs} fill={color} textAnchor="middle" dominantBaseline="central" fontWeight={600} transform={`rotate(-90 ${bandX} ${cy})`}>{styledTspans(source, lines)[0]}</text>
      );
      break;
    }
  }
  const callout = calloutLayout(n);
  if (n.kind !== 'line' && (role !== null || callout !== null || n.kind === 'container' || n.kind === 'document' || n.kind === 'hexagon' || n.textAlign !== undefined || n.textVerticalAlign !== undefined)) {
    const layout = diagramTextLayout({ ...n, label: source }, role);
    text = <TextLines source={source} lines={layout.lines} cx={layout.x} cy={layout.y} anchor={layout.anchor} fontSize={fs} color={color} weight={layout.weight} />;
  }
  const collapsible = n.kind === 'container' || n.kind === 'swimlane';
  const collapsed = collapsible && n.collapsed === true;
  let extra: React.ReactNode = null;
  if (collapsed) {
    const badge = hiddenCount > 0 ? `+${hiddenCount}` : '';
    body = <rect {...common} x={x} y={y} width={w} height={h} rx={radius} />;
    text = <TextLines source={source} lines={wrapText(label, Math.max(20, w - 76), fs, 1)} cx={x + 30} cy={y + h / 2} anchor="start" fontSize={fs} color={color} weight={600} />;
    extra = badge === '' ? null : (
      <g className="dg-collapse-badge" pointerEvents="none">
        <rect x={x + w - 44} y={y + h / 2 - 9} width={36} height={18} rx={9} />
        <text x={x + w - 26} y={y + h / 2} fontSize={11} textAnchor="middle" dominantBaseline="central">{badge}</text>
      </g>
    );
  }
  const toggle = collapsible && (collapsed || selected) ? (() => {
    const cx0 = x + 15;
    const cy0 = collapsed ? y + h / 2 : n.kind === 'swimlane' ? y + 14 : y + Math.min(containerHeader(n).height, h) / 2;
    return (
      <g className="dg-collapse" data-dg="collapse" data-id={n.id}>
        <title>{collapsed ? 'Expand' : 'Collapse'}</title>
        <rect x={cx0 - 9} y={cy0 - 9} width={18} height={18} rx={3} />
        <path d={collapsed ? `M${cx0 - 2} ${cy0 - 4} L${cx0 + 3} ${cy0} L${cx0 - 2} ${cy0 + 4}` : `M${cx0 - 4} ${cy0 - 2} L${cx0} ${cy0 + 3} L${cx0 + 4} ${cy0 - 2}`} />
      </g>
    );
  })() : null;
  const cls = ['dg-node', `dg-node--${n.kind}`, n.stroke === 'none' ? 'dg-node--borderless' : '', selected ? 'dg-node--selected' : '', dimmed ? 'dg-node--dimmed' : '', collapsed ? 'dg-node--collapsed' : ''].filter(Boolean).join(' ');
  return (
    <g className={cls} data-dg="node" data-id={n.id}>
      <g filter={diagramNodeShadow(n) ? `url(#${shadowId})` : undefined}>{body}</g>
      {text}
      {role !== null && <DiagramRoleBadge layout={role} />}
      {callout !== null && <g className="dg-callout" data-callout-type={callout.type} pointerEvents="none">
        <title>{callout.label} callout</title>
        <rect x={callout.icon.x - 4} y={callout.icon.y - 4} width={callout.icon.size + 8} height={callout.icon.size + 8} rx={7} fill="#fcf4d6" />
        <path className="dg-callout__icon" d={callout.path} stroke="#8e6a00"
          transform={`translate(${callout.icon.x} ${callout.icon.y}) scale(${callout.icon.size / 20})`} />
        <text className="dg-callout__type" x={callout.text.x} y={callout.text.y} fontSize={callout.text.fontSize} fill={color}
          dominantBaseline="central">{callout.label}</text>
      </g>}
      {extra}
      {toggle}
    </g>
  );
});

function ShapeGlyph({ kind }: { kind: DiagramKind }): React.ReactElement {
  let shape: React.ReactNode;
  switch (kind) {
    case 'process': shape = <rect x={2} y={5} width={16} height={10} rx={2} />; break;
    case 'decision': shape = <polygon points="10,2 18,10 10,18 2,10" />; break;
    case 'hexagon': shape = <path strokeLinejoin="round" d={hexagonShapePath({ x: 2, y: 4, width: 16, height: 12 })} />; break;
    case 'terminator': shape = <rect x={2} y={5} width={16} height={10} rx={5} />; break;
    case 'document': shape = <path d={documentShapePath({ x: 2, y: 3, width: 16, height: 14 })} />; break;
    case 'arrow': shape = <path strokeLinejoin="round" d={arrowShapePath({ x: 2, y: 4, width: 16, height: 12 })} />; break;
    case 'line': shape = <path d="M2 16 L18 4" />; break;
    case 'text': shape = <path d="M4 5h12M10 5v11M8 16h4" />; break;
    case 'image': shape = <><rect x={2} y={3} width={16} height={14} rx={1} /><path d="M4 15l4-5 3 3 2-2 3 4" /></>; break;
    case 'container': shape = <><rect x={2} y={3} width={16} height={14} rx={1} /><path d="M2 7h16" /></>; break;
    case 'swimlane': shape = <><rect x={2} y={4} width={16} height={12} /><path d="M6 4v12" /></>; break;
  }
  return <svg className="dg-glyph" width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">{shape}</svg>;
}

function LineGlyph({ kind }: { kind: 'straight' | 'orthogonal' | 'none' | 'start' | 'end' | 'both' | 'dashed' }): React.ReactElement {
  let shape: React.ReactNode;
  switch (kind) {
    case 'start': shape = <><path d="M5 8h9" /><path className="dg-glyph__fill" d="M2 8l4-3v6z" /></>; break;
    case 'straight': shape = <path d="M2 14L14 2" />; break;
    case 'orthogonal': shape = <path d="M2 13h6V3h6" />; break;
    case 'none': shape = <path d="M2 8h12" />; break;
    case 'end': shape = <><path d="M2 8h11" /><path className="dg-glyph__fill" d="M14 8l-4-3v6z" /></>; break;
    case 'both': shape = <><path d="M3 8h10" /><path className="dg-glyph__fill" d="M14 8l-4-3v6z" /><path className="dg-glyph__fill" d="M2 8l4-3v6z" /></>; break;
    case 'dashed': shape = <path d="M1 8h3M6.5 8h3M12 8h3" />; break;
  }
  return <svg className="dg-glyph" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">{shape}</svg>;
}

function AiChipShape({ chip }: { chip: AiChip }): React.ReactElement {
  const c = AI_CHIP_COLOURS[chip.tone];
  return (
    <g className="dg-ai-chip" data-ai-chip={chip.key}>
      <title>{chip.title}</title>
      <rect x={chip.x} y={chip.y} width={chip.width} height={chip.height} rx={chip.height / 2} fill={c.fill} stroke={c.stroke} strokeWidth={1} strokeDasharray={c.dashed === true ? '3 2' : undefined} />
      <text x={chip.x + chip.width / 2} y={chip.y + chip.height / 2} fontSize={AI_CHIP_FONT} fontWeight={600} fill={c.text} textAnchor="middle" dominantBaseline="central">{chip.text}</text>
    </g>
  );
}

function AiFindingMark({ at, severity, title }: { at: P; severity: AiFlowSeverity; title: string }): React.ReactElement {
  const c = AI_SEVERITY_COLOURS[severity];
  return (
    <g className="dg-ai-finding" data-ai-finding={severity}>
      <title>{title}</title>
      <circle cx={at.x} cy={at.y} r={AI_FINDING_RADIUS} fill={c.fill} stroke="#ffffff" strokeWidth={2} />
      <text x={at.x} y={at.y} fontSize={10} fontWeight={700} fill={c.text} textAnchor="middle" dominantBaseline="central">{severity === 'info' ? 'i' : '!'}</text>
    </g>
  );
}

function SaveIndicator({ status, uploading }: { status: SaveStatus; uploading: number }): React.ReactElement {
  const text: Record<SaveStatus, string> = { saved: 'Saved', pending: 'Unsaved changes', saving: 'Saving…', error: 'Not saved', conflict: 'Conflict — not saved' };
  const uploadingNow = uploading > 0 && status !== 'error' && status !== 'conflict';
  const label = uploadingNow ? `Uploading ${uploading} image${uploading === 1 ? '' : 's'}…` : text[status];
  return (
    <span className="dg-status-group">
      <span className={`dg-status dg-status--${uploadingNow ? 'saving' : status}`} role="status" aria-live="polite" title={label}>
        {status === 'saved' && !uploadingNow && <CheckmarkFilled size={16} className="dg-status__icon" />}
        {status === 'pending' && !uploadingNow && <span className="dg-status__dot" aria-hidden="true" />}
        {(status === 'saving' || uploadingNow) && <InProgress size={16} className="dg-status__icon dg-spin" />}
        {status === 'error' && <ErrorFilled size={16} className="dg-status__icon" />}
        {status === 'conflict' && <WarningAlt size={16} className="dg-status__icon" />}
        <span className="dg-status__text">{label}</span>
      </span>
    </span>
  );
}

/** Cmd/Ctrl+B and Cmd/Ctrl+I in a title field: wraps the selection in Markdown and keeps it selected. */
function formatTitleKey(event: React.KeyboardEvent<HTMLTextAreaElement>, value: string, limit: number, apply: (value: string) => void): boolean {
  const key = event.key.toLowerCase();
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || (key !== 'b' && key !== 'i')) return false;
  event.preventDefault();
  event.stopPropagation();
  const field = event.currentTarget;
  const result = formatDescription(value, field.selectionStart, field.selectionEnd, key === 'b' ? 'bold' : 'italic');
  if (result.text.length > limit) return true;
  apply(result.text);
  requestAnimationFrame(() => { field.setSelectionRange(result.start, result.end); });
  return true;
}

function LabelEditor({ initial, box, limit, multiline, onCommit, onCancel }: {
  initial: string; box: { left: number; top: number; width: number; height: number; fontSize: number }; limit: number;
  multiline: boolean; onCommit: (value: string) => void; onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ value, onCommit, onCancel });
  latest.current = { value, onCommit, onCancel };
  // Focus inside Athena's right-click menu (spelling suggestions, Paste…) is not leaving the
  // label: the menu acts on this field and hands focus back, so stay open until the user
  // clicks or focuses somewhere else.
  const inMenu = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) latest.current.onCommit(latest.current.value); else latest.current.onCancel();
  };
  useEffect(() => {
    const outside = (target: EventTarget | null): boolean =>
      !(target instanceof Node && (ref.current?.contains(target) || (target instanceof Element && target.closest('.gctx'))));
    const onPointerDown = (e: PointerEvent): void => { if (inMenu.current && outside(e.target)) finish(true); };
    const onFocusIn = (e: FocusEvent): void => {
      if (!inMenu.current) return;
      if (e.target === ref.current) inMenu.current = false;
      else if (outside(e.target)) finish(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finish reads refs only
  }, []);
  return (
    <textarea
      ref={ref} spellCheck className={`dg-label-editor${multiline ? '' : ' dg-label-editor--single'}`} aria-label="Label" value={value}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height, fontSize: box.fontSize }}
      onChange={(e) => { setValue(e.target.value); }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.gctx')) { inMenu.current = true; return; }
        finish(true);
      }}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (formatTitleKey(e, value, limit, setValue)) return;
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && (!multiline || !e.shiftKey)) { e.preventDefault(); finish(true); }
      }}
    />
  );
}
