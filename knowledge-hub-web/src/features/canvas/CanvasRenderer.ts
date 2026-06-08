/**
 * CanvasRenderer.ts
 * Imperative canvas renderer — owns the <canvas> element's draw lifecycle.
 *
 * React mounts/unmounts this class; all drawing is done via 2D context calls.
 * Uses a dirty-flag pattern: requestAnimationFrame only fires when needed.
 *
 * NOTE: This file intentionally exceeds 200 lines due to the self-contained
 * nature of a canvas renderer. Each section is clearly delimited.
 */

import type { CanvasNode, CanvasEdge, Viewport, PendingEdge } from './canvasTypes';
import {
  worldToScreen, screenToWorld, zoomAroundPoint, clampZoom,
  edgeEndpoints, bezierControlPoints, bezierMidpoint, bezierHitTest,
  hitTestNode, hitTestHandle, getNodeHandles,
} from './canvasGeometry';

// ── Colour tokens (CSS vars resolved once on init) ────────────────────────────

interface Palette {
  bg: string;
  layer01: string;
  layer02: string;
  borderSubtle: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  accentBg: string;
  aiNode: string;
}

function resolvePalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    bg:           v('--cds-background',        '#161616'),
    layer01:      v('--cds-layer-01',          '#262626'),
    layer02:      v('--cds-layer-02',          '#393939'),
    borderSubtle: v('--cds-border-subtle-01',  '#525252'),
    borderStrong: v('--cds-border-strong-01',  '#6f6f6f'),
    textPrimary:  v('--cds-text-primary',       '#f4f4f4'),
    textSecondary:v('--cds-text-secondary',     '#c6c6c6'),
    accent:       v('--kh-accent',              '#3ddbd9'),
    accentBg:     v('--kh-accent-bg',           'rgba(61,219,217,0.08)'),
    aiNode:       '#be84ff',
  };
}

// ── Render constants ──────────────────────────────────────────────────────────

const NODE_RADIUS        = 6;
const NODE_PADDING_X     = 14;
const NODE_PADDING_TOP   = 10;
const FONT_TITLE         = '600 14px "IBM Plex Sans", sans-serif';
const FONT_META          = '11px "IBM Plex Sans", sans-serif';
const FONT_BODY          = '13px "IBM Plex Sans", sans-serif';
const LINE_HEIGHT_TITLE  = 20;
const LINE_HEIGHT_BODY   = 18;
const HANDLE_RADIUS      = 5;
const HANDLE_SHOW_DIST   = 60; // world-space px from pointer to show handles
const ARROW_SIZE         = 8;
const EDGE_HIT_THRESHOLD = 36;
const GRID_SPACING       = 24;

// ── Callbacks the host component can subscribe to ─────────────────────────────

export interface RendererCallbacks {
  onNodeDragEnd:    (nodeId: string, x: number, y: number) => void;
  onNodeResizeEnd:  (nodeId: string, width: number, height: number) => void;
  onEdgeCreate:     (sourceId: string, targetId: string) => void;
  onNodeDoubleClick:(nodeId: string) => void;
  onNodeContextMenu:(nodeId: string, sx: number, sy: number) => void;
  onEdgeContextMenu:(edgeId: string, sx: number, sy: number) => void;
  onEmptyDoubleClick:(wx: number, wy: number) => void;
  onSelectionChange:(ids: string[]) => void;
}

// ── Main renderer class ───────────────────────────────────────────────────────

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr   = window.devicePixelRatio || 1;
  private palette: Palette;

  private nodes: CanvasNode[]  = [];
  private edges: CanvasEdge[]  = [];
  private vp: Viewport         = { x: 0, y: 0, zoom: 1 };
  private selected: Set<string>= new Set();
  private editingNodeId: string | null = null;

  private dirty = false;
  private rafId: number | null = null;

  // Interaction state
  private isPanning       = false;
  private panStartX       = 0;
  private panStartY       = 0;
  private panStartVp      = { x: 0, y: 0 };

  private draggingNodeId: string | null = null;
  private dragOffsetX    = 0;
  private dragOffsetY    = 0;
  private dragMoved      = false;

  private resizingNodeId: string | null = null;
  private resizeStartW   = 0;
  private resizeStartH   = 0;
  private resizeStartSX  = 0;  // screen px where resize drag started
  private resizeStartSY  = 0;

  private hoverNodeId: string | null   = null;
  private hoverPointerX = 0;  // screen px
  private hoverPointerY = 0;

  private pendingEdge: PendingEdge | null = null;

  private callbacks: RendererCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: RendererCallbacks) {
    this.canvas    = canvas;
    this.callbacks = callbacks;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasRenderer: 2d context not available');
    this.ctx     = ctx;
    this.palette = resolvePalette();

    this.attachEvents();
    this.markDirty();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setData(nodes: CanvasNode[], edges: CanvasEdge[]): void {
    // Auto-expand node heights that are too short to show their body text.
    // Each body line of text is ~16 world-units tall; title area is ~60 units.
    for (const n of nodes) {
      if (n.body && n.body.trim().length > 0) {
        const bodyLines = n.body.split(/\r?\n/).reduce((acc, para) => {
          // Rough word-wrap estimate at ~40 chars per line (300px node width)
          return acc + Math.max(1, Math.ceil(para.length / 40));
        }, 0);
        const minH = 80 + bodyLines * 18 + 24; // title area + body lines + bottom pad
        if (n.height < minH) n.height = minH;
      }
    }
    this.nodes = nodes;
    this.edges = edges;
    this.markDirty();
  }

  setViewport(vp: Viewport): void {
    this.vp = vp;
    this.markDirty();
  }

  setSelected(ids: string[]): void {
    this.selected = new Set(ids);
    this.markDirty();
  }

  setEditingNode(id: string | null): void {
    this.editingNodeId = id;
    this.markDirty();
  }

  setPendingEdge(pe: PendingEdge | null): void {
    this.pendingEdge = pe;
    this.markDirty();
  }

  getViewport(): Viewport { return { ...this.vp }; }

  resize(width: number, height: number): void {
    this.dpr           = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(width  * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width  = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.scale(this.dpr, this.dpr);
    this.palette = resolvePalette();
    this.markDirty();
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.detachEvents();
  }

  // ── Dirty / render loop ─────────────────────────────────────────────────────

  private markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => {
      this.dirty = false;
      this.draw();
    });
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  private draw(): void {
    const { ctx, palette } = this;
    const W = this.canvas.width  / this.dpr;
    const H = this.canvas.height / this.dpr;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, W, H);

    // Grid
    this.drawGrid(W, H);

    // Edges
    for (const edge of this.edges) {
      this.drawEdge(edge);
    }

    // Pending edge (being drawn)
    if (this.pendingEdge) this.drawPendingEdge();

    // Nodes
    for (const node of this.nodes) {
      this.drawNode(node);
    }

    // Connection handles on hovered node
    if (this.hoverNodeId && !this.draggingNodeId && !this.resizingNodeId) {
      const n = this.nodes.find((x) => x.id === this.hoverNodeId);
      if (n) this.drawHandles(n);
    }

    // Resize handle on selected nodes
    for (const id of this.selected) {
      const n = this.nodes.find((x) => x.id === id);
      if (n) this.drawResizeHandle(n);
    }
  }

  private drawGrid(W: number, H: number): void {
    const { ctx, vp, palette } = this;
    const spacing = GRID_SPACING * vp.zoom;
    const offX = ((vp.x % spacing) + spacing) % spacing;
    const offY = ((vp.y % spacing) + spacing) % spacing;

    ctx.fillStyle = `${palette.borderSubtle}40`;
    const DOT = Math.max(0.5, vp.zoom * 0.8);
    for (let x = offX; x < W; x += spacing) {
      for (let y = offY; y < H; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, DOT, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawNode(node: CanvasNode): void {
    const { ctx, vp, palette } = this;
    const { x: sx, y: sy } = worldToScreen(node.x, node.y, vp);
    const sw = node.width  * vp.zoom;
    const sh = node.height * vp.zoom;
    const z  = vp.zoom;
    const r  = NODE_RADIUS * z;

    const isSelected = this.selected.has(node.id);
    const isAI       = node.nodeType === 'ai_output';
    const isHubRef   = node.nodeType === 'hub_ref';

    // Detect URL: explicit field OR label that looks like a URL
    const labelIsUrl   = !!node.label && node.label.startsWith('http');
    const effectiveUrl = node.url ?? (labelIsUrl ? node.label : null);
    const isLinkCard   = node.nodeType === 'text' && !!effectiveUrl;

    // For link cards where label IS the url, show hostname as title
    let displayLabel = node.label ?? node.body ?? '(empty)';
    if (isLinkCard && labelIsUrl && !node.url) {
      try { displayLabel = new URL(node.label!).hostname.replace(/^www\./, ''); } catch { /* keep */ }
    }

    // Per-type colours
    const accentColour = isAI       ? '#be84ff'
                       : isLinkCard ? '#78a9ff'
                       :              palette.accent;   // teal for everything else (notes, hub_ref)

    const chipLabel    = isAI       ? 'AI'
                       : isLinkCard ? 'LINK'
                       : isHubRef   ? (node.refType ?? 'HUB').toUpperCase().replace(/_/g, ' ')
                       :              'NOTE';

    // ── Shadow / glow ────────────────────────────────────────────────────────
    if (isSelected) {
      ctx.shadowColor = accentColour;
      ctx.shadowBlur  = 16;
    }

    // ── Card background ───────────────────────────────────────────────────────
    // Use layer02 (#393939) for contrast against the #161616 canvas bg
    ctx.fillStyle = isAI ? `${palette.aiNode}28` : palette.layer02;
    roundRect(ctx, sx, sy, sw, sh, r);
    ctx.fill();

    // Border — accent when selected, subtle grey when not
    ctx.strokeStyle = isSelected ? accentColour : palette.borderSubtle;
    ctx.lineWidth   = isSelected ? 2 : 1;
    roundRect(ctx, sx, sy, sw, sh, r);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ── Clip all content to card bounds ───────────────────────────────────────
    ctx.save();
    roundRect(ctx, sx, sy, sw, sh, r);
    ctx.clip();

    // ── Left accent bar — 8px world-space, min 5px on screen ────────────────
    const barW = Math.max(5, 8 * z);
    ctx.fillStyle = accentColour;
    ctx.save();
    roundRect(ctx, sx, sy, sw, sh, r);
    ctx.clip();
    ctx.fillRect(sx, sy, barW, sh);
    ctx.restore();

    if (sw < 90) {
      const fz = Math.max(8, Math.round(10 * z));
      ctx.font      = `600 ${fz}px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = palette.textPrimary;
      ctx.fillText(displayLabel, sx + barW + 6 * z, sy + (fz + 5) * z, sw - barW - 8 * z);
      return;
    }

    const PAD_L  = barW + 10 * z;
    const PAD_R  = 10 * z;
    const innerW = sw - PAD_L - PAD_R;
    let   cy     = sy + 10 * z;

    // ── Chip pill ────────────────────────────────────────────────────────────
    // When this node is being edited, skip all text rendering — the React overlay covers it.
    const isEditing = node.id === this.editingNodeId;
    if (isEditing) { ctx.restore(); return; }

    if (z > 0.35) {
      const chipFz    = Math.max(7, Math.round(9 * z));
      const chipPadX  = 6 * z;
      const chipPadY  = 2.5 * z;
      const chipH     = chipFz + chipPadY * 2;
      const chipW     = Math.min(ctx.measureText(chipLabel).width + chipPadX * 2, innerW);

      ctx.font      = `600 ${chipFz}px "IBM Plex Sans", sans-serif`;
      // Pill background — very subtle tint
      ctx.fillStyle = `${accentColour}18`;
      roundRect(ctx, sx + PAD_L, cy, chipW, chipH, chipH / 2);
      ctx.fill();
      // Pill border — subtle
      ctx.strokeStyle = `${accentColour}50`;
      ctx.lineWidth   = 0.75;
      roundRect(ctx, sx + PAD_L, cy, chipW, chipH, chipH / 2);
      ctx.stroke();
      // Pill text — accent, readable
      ctx.fillStyle = accentColour;
      ctx.fillText(chipLabel, sx + PAD_L + chipPadX, cy + chipFz + chipPadY - 0.5 * z, chipW - chipPadX * 2);

      cy += chipH + 7 * z;
    } else {
      cy += 4 * z;
    }

    // ── Title ────────────────────────────────────────────────────────────────
    const titleFz = Math.max(10, Math.round(Math.min(14, 14 * z)));
    ctx.font      = `600 ${titleFz}px "IBM Plex Sans", sans-serif`;
    ctx.fillStyle = palette.textPrimary;
    const titleLines = drawWrappedText(
      ctx, displayLabel,
      sx + PAD_L, cy + titleFz,
      innerW, (titleFz + 5) * z, 2,
    );
    cy += titleLines * (titleFz + 5) * z + 6 * z;

    // ── Divider ──────────────────────────────────────────────────────────────
    const hasBody    = !!node.body && node.body.trim().length > 0;
    const hasTags    = !!node.tags?.length;
    const showUrlRow = !!effectiveUrl;
    // hub_ref nodes always show a source row (refType label) even without a URL
    const showSourceRow = isHubRef && !!node.refType;
    if ((hasBody || hasTags || showUrlRow || showSourceRow) && z > 0.35) {
      ctx.beginPath();
      ctx.moveTo(sx + PAD_L, cy);
      ctx.lineTo(sx + sw - PAD_R, cy);
      ctx.strokeStyle = palette.borderSubtle;
      ctx.lineWidth   = 1;
      ctx.stroke();
      cy += 8 * z;
    }

    // ── Body text ────────────────────────────────────────────────────────────
    if (hasBody && z > 0.35) {
      const bodyFz = Math.max(8, Math.round(Math.min(12, 12 * z)));
      ctx.font      = `${bodyFz}px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = palette.textSecondary;
      const bodyLines = drawWrappedText(
        ctx, node.body!, sx + PAD_L, cy + bodyFz,
        innerW, (bodyFz + 4) * z, 50,
      );
      cy += bodyLines * (bodyFz + 4) * z + 6 * z;
    }

    // ── Tag badges ───────────────────────────────────────────────────────────
    if (hasTags && z > 0.4) {
      const badgeFz   = Math.max(7, Math.round(Math.min(10, 10 * z)));
      const badgePadX = 5 * z;
      const badgePadY = 2 * z;
      const badgeH    = badgeFz + badgePadY * 2;
      const badgeGap  = 4 * z;
      ctx.font = `${badgeFz}px "IBM Plex Sans", sans-serif`;
      let bx = sx + PAD_L;
      for (const rawTag of node.tags!.slice(0, 5)) {
        // Tags are encoded as "name|#colour" or just "name"
        const pipeIdx = rawTag.indexOf('|');
        const tagName   = pipeIdx >= 0 ? rawTag.slice(0, pipeIdx) : rawTag;
        const tagColour = pipeIdx >= 0 ? rawTag.slice(pipeIdx + 1) : null;
        const tw = ctx.measureText(tagName).width;
        const bw = tw + badgePadX * 2;
        if (bx + bw > sx + sw - PAD_R) break;
        // Use tag's own colour if available, else muted grey
        const pillColour = tagColour ?? palette.borderStrong;
        ctx.fillStyle = tagColour ? `${tagColour}20` : 'rgba(255,255,255,0.06)';
        roundRect(ctx, bx, cy, bw, badgeH, badgeH / 2);
        ctx.fill();
        ctx.strokeStyle = tagColour ? `${tagColour}70` : palette.borderSubtle;
        ctx.lineWidth = 0.75;
        roundRect(ctx, bx, cy, bw, badgeH, badgeH / 2);
        ctx.stroke();
        ctx.fillStyle = pillColour;
        ctx.fillText(tagName, bx + badgePadX, cy + badgeFz + badgePadY - 0.5 * z, bw - badgePadX * 2);
        bx += bw + badgeGap;
      }
      cy += badgeH + 6 * z;
    }

    // ── Link row ─────────────────────────────────────────────────────────────
    if (showUrlRow && z > 0.35) {
      const linkFz = Math.max(7, Math.round(Math.min(11, 11 * z)));
      ctx.font      = `${linkFz}px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = palette.textSecondary;
      let display = effectiveUrl!;
      try { display = new URL(effectiveUrl!).hostname.replace(/^www\./, ''); } catch { /* raw */ }
      ctx.fillText('@ ' + display, sx + PAD_L, cy + linkFz, innerW);
      cy += (linkFz + 4) * z;
    }

    // ── Source row (hub_ref — shows refType as provenance) ───────────────────
    if (showSourceRow && z > 0.35) {
      const srcFz = Math.max(7, Math.round(Math.min(10, 10 * z)));
      ctx.font      = `${srcFz}px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = palette.borderStrong;
      const srcLabel = '← ' + node.refType!.replace(/_/g, ' ');
      ctx.fillText(srcLabel, sx + PAD_L, cy + srcFz, innerW);
    }

    // ── End card clip ─────────────────────────────────────────────────────────
    ctx.restore();
  }

  private drawHandles(node: CanvasNode): void {
    const { ctx, vp, palette } = this;
    for (const h of getNodeHandles(node)) {
      const { x: sx, y: sy } = worldToScreen(h.x, h.y, vp);
      ctx.beginPath();
      ctx.arc(sx, sy, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = palette.accent;
      ctx.fill();
    }
  }

  private drawResizeHandle(node: CanvasNode): void {
    const { ctx, vp, palette } = this;
    const { x: sx, y: sy } = worldToScreen(node.x + node.width, node.y + node.height, vp);
    const S = Math.max(6, 8 * vp.zoom);
    ctx.fillStyle = palette.accent;
    ctx.strokeStyle = palette.bg;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, S / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  /** Returns true if screen point (sx,sy) is over the resize handle of the given node */
  private hitTestResizeHandle(node: CanvasNode, sx: number, sy: number): boolean {
    const corner = worldToScreen(node.x + node.width, node.y + node.height, this.vp);
    const S = Math.max(10, 12 * this.vp.zoom);  // slightly larger hit zone than drawn
    const dx = sx - corner.x;
    const dy = sy - corner.y;
    return dx * dx + dy * dy <= S * S;
  }

  private drawEdge(edge: CanvasEdge): void {
    const { ctx, vp, palette } = this;
    const src = this.nodes.find((n) => n.id === edge.sourceId);
    const tgt = this.nodes.find((n) => n.id === edge.targetId);
    if (!src || !tgt) return;

    const { x1, y1, x2, y2 } = edgeEndpoints(src, tgt);
    const { x: sx1, y: sy1 } = worldToScreen(x1, y1, vp);
    const { x: sx2, y: sy2 } = worldToScreen(x2, y2, vp);
    const [cp1x, cp1y, cp2x, cp2y] = bezierControlPoints(sx1, sy1, sx2, sy2);

    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, sx2, sy2);
    ctx.strokeStyle = edgeColour(edge.edgeType, palette.accent);
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Arrow head
    drawArrow(ctx, cp2x, cp2y, sx2, sy2, ARROW_SIZE, edgeColour(edge.edgeType, palette.accent));

    // Label
    if (edge.label && vp.zoom > 0.5) {
      const mid = bezierMidpoint(sx1, sy1, cp1x, cp1y, cp2x, cp2y, sx2, sy2);
      ctx.font      = `11px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = palette.textSecondary;
      ctx.textAlign = 'center';
      ctx.fillText(edge.label, mid.x, mid.y - 6);
      ctx.textAlign = 'left';
    }
  }

  private drawPendingEdge(): void {
    if (!this.pendingEdge) return;
    const { ctx, vp, palette } = this;
    const src = this.nodes.find((n) => n.id === this.pendingEdge!.sourceId);
    if (!src) return;
    const sc = worldToScreen(src.x + src.width / 2, src.y + src.height / 2, vp);
    ctx.beginPath();
    ctx.moveTo(sc.x, sc.y);
    ctx.lineTo(this.pendingEdge.currentX, this.pendingEdge.currentY);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  private onWheel   = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    this.vp    = zoomAroundPoint(this.vp, sx, sy, e.deltaY);
    this.markDirty();
  };

  private onPointerDown = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy, this.vp);

    // Check resize handle first (only on selected nodes)
    for (const id of this.selected) {
      const node = this.nodes.find((n) => n.id === id);
      if (node && this.hitTestResizeHandle(node, sx, sy)) {
        this.resizingNodeId = node.id;
        this.resizeStartW   = node.width;
        this.resizeStartH   = node.height;
        this.resizeStartSX  = sx;
        this.resizeStartSY  = sy;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = 'se-resize';
        return;
      }
    }

    // Check handle first (edge creation)
    const handleHit = hitTestHandle(this.nodes, wx, wy);
    if (handleHit) {
      this.pendingEdge = { sourceId: handleHit.node.id, currentX: sx, currentY: sy };
      this.canvas.setPointerCapture(e.pointerId);
      this.markDirty();
      return;
    }

    const node = hitTestNode(this.nodes, wx, wy);

    if (node) {
      // Node drag
      if (!this.selected.has(node.id) && !e.shiftKey) {
        this.selected = new Set([node.id]);
        this.callbacks.onSelectionChange([node.id]);
      } else if (e.shiftKey) {
        if (this.selected.has(node.id)) this.selected.delete(node.id);
        else this.selected.add(node.id);
        this.callbacks.onSelectionChange([...this.selected]);
      }
      this.draggingNodeId = node.id;
      this.dragOffsetX    = wx - node.x;
      this.dragOffsetY    = wy - node.y;
      this.dragMoved      = false;
      this.canvas.setPointerCapture(e.pointerId);
    } else {
      // Pan
      this.isPanning  = true;
      this.panStartX  = e.clientX;
      this.panStartY  = e.clientY;
      this.panStartVp = { x: this.vp.x, y: this.vp.y };
      if (!e.shiftKey) {
        this.selected = new Set();
        this.callbacks.onSelectionChange([]);
      }
    }
    this.markDirty();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy, this.vp);

    this.hoverPointerX = sx;
    this.hoverPointerY = sy;

    if (this.resizingNodeId) {
      const node = this.nodes.find((n) => n.id === this.resizingNodeId);
      if (node) {
        const dsx = sx - this.resizeStartSX;
        const dsy = sy - this.resizeStartSY;
        node.width  = Math.max(120, this.resizeStartW  + dsx / this.vp.zoom);
        node.height = Math.max(60,  this.resizeStartH  + dsy / this.vp.zoom);
        this.markDirty();
      }
      return;
    }

    if (this.pendingEdge) {
      this.pendingEdge = { ...this.pendingEdge, currentX: sx, currentY: sy };
      this.markDirty();
      return;
    }

    if (this.draggingNodeId) {
      this.dragMoved = true;
      const node = this.nodes.find((n) => n.id === this.draggingNodeId);
      if (node) {
        node.x = wx - this.dragOffsetX;
        node.y = wy - this.dragOffsetY;
      }
      this.markDirty();
      return;
    }

    if (this.isPanning) {
      this.vp = {
        ...this.vp,
        x: this.panStartVp.x + (e.clientX - this.panStartX),
        y: this.panStartVp.y + (e.clientY - this.panStartY),
      };
      this.markDirty();
      return;
    }

    // Hover detection + cursor
    const node = hitTestNode(this.nodes, wx, wy);
    const newHover = node?.id ?? null;
    if (newHover !== this.hoverNodeId) {
      this.hoverNodeId = newHover;
      this.markDirty();
    }
    // Resize cursor when over a selected node's resize handle
    let overResize = false;
    for (const id of this.selected) {
      const n = this.nodes.find((x) => x.id === id);
      if (n && this.hitTestResizeHandle(n, sx, sy)) { overResize = true; break; }
    }
    this.canvas.style.cursor = overResize ? 'se-resize' : '';
  };

  private onPointerUp = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy, this.vp);

    if (this.resizingNodeId) {
      const node = this.nodes.find((n) => n.id === this.resizingNodeId);
      if (node) this.callbacks.onNodeResizeEnd(node.id, node.width, node.height);
      this.resizingNodeId = null;
      this.canvas.style.cursor = '';
      this.markDirty();
      return;
    }

    if (this.pendingEdge) {
      const target = hitTestNode(this.nodes, wx, wy);
      if (target && target.id !== this.pendingEdge.sourceId) {
        this.callbacks.onEdgeCreate(this.pendingEdge.sourceId, target.id);
      }
      this.pendingEdge = null;
      this.markDirty();
      return;
    }

    if (this.draggingNodeId && this.dragMoved) {
      const node = this.nodes.find((n) => n.id === this.draggingNodeId);
      if (node) this.callbacks.onNodeDragEnd(node.id, node.x, node.y);
    }

    this.draggingNodeId = null;
    this.isPanning      = false;
    this.markDirty();
  };

  private onDblClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy, this.vp);
    const node = hitTestNode(this.nodes, wx, wy);
    if (node) {
      this.callbacks.onNodeDoubleClick(node.id);
    } else {
      this.callbacks.onEmptyDoubleClick(wx, wy);
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy, this.vp);
    const node = hitTestNode(this.nodes, wx, wy);
    if (node) {
      this.callbacks.onNodeContextMenu(node.id, sx, sy);
      return;
    }
    // Edge hit test
    for (const edge of this.edges) {
      const src = this.nodes.find((n) => n.id === edge.sourceId);
      const tgt = this.nodes.find((n) => n.id === edge.targetId);
      if (!src || !tgt) continue;
      const { x1, y1, x2, y2 } = edgeEndpoints(src, tgt);
      const s1 = worldToScreen(x1, y1, this.vp);
      const s2 = worldToScreen(x2, y2, this.vp);
      const [cp1x, cp1y, cp2x, cp2y] = bezierControlPoints(s1.x, s1.y, s2.x, s2.y);
      if (bezierHitTest(sx, sy, s1.x, s1.y, cp1x, cp1y, cp2x, cp2y, s2.x, s2.y, EDGE_HIT_THRESHOLD)) {
        this.callbacks.onEdgeContextMenu(edge.id, sx, sy);
        return;
      }
    }
  };

  private boundEvents: Array<[string, EventListener]> = [];

  private attachEvents(): void {
    const add = (name: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      this.canvas.addEventListener(name, fn, opts);
      this.boundEvents.push([name, fn]);
    };
    add('wheel',       this.onWheel as EventListener, { passive: false });
    add('pointerdown', this.onPointerDown as EventListener);
    add('pointermove', this.onPointerMove as EventListener);
    add('pointerup',   this.onPointerUp   as EventListener);
    add('dblclick',    this.onDblClick    as EventListener);
    add('contextmenu', this.onContextMenu as EventListener);
  }

  private detachEvents(): void {
    for (const [name, fn] of this.boundEvents) {
      this.canvas.removeEventListener(name, fn);
    }
    this.boundEvents = [];
  }
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number, y: number,
  maxW: number, lineH: number,
  maxLines = 3,
): number {                           // returns number of lines drawn
  // Split on hard newlines first, then word-wrap each paragraph
  const paragraphs = text.split(/\r?\n/);
  let lineNum = 0;

  for (const para of paragraphs) {
    const words = para === '' ? [''] : para.split(' ');
    let line = '';

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y + lineNum * lineH);
        line = word;
        lineNum++;
        if (lineNum >= maxLines) {
          let trunc = word;
          while (ctx.measureText(`${trunc}…`).width > maxW && trunc.length > 0) {
            trunc = trunc.slice(0, -1);
          }
          ctx.fillText(`${trunc}…`, x, y + lineNum * lineH);
          return lineNum + 1;
        }
      } else {
        line = test;
      }
    }
    // Flush remaining line for this paragraph (including blank lines)
    ctx.fillText(line, x, y + lineNum * lineH);
    lineNum++;
    if (lineNum >= maxLines) return lineNum;
  }
  return lineNum;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number, fromY: number,
  toX: number, toY: number,
  size: number,
  colour: string,
): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - size * Math.cos(angle - Math.PI / 6),
    toY - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    toX - size * Math.cos(angle + Math.PI / 6),
    toY - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

function nodeChipLabel(node: CanvasNode): string {
  if (node.nodeType === 'ai_output') return 'AI';
  if (node.nodeType === 'text') return '';
  return node.refType ?? '';
}

function edgeColour(edgeType: string, accent: string): string {
  const MAP: Record<string, string> = {
    'supports':    '#42be65',
    'contradicts': '#fa4d56',
    'leads-to':    '#f1c21b',
    'part-of':     '#be84ff',
    'relates-to':  accent,
  };
  return MAP[edgeType] ?? accent;
}

// Silence unused-variable warnings for render constants that are referenced
// contextually but not always via the linter's view
void FONT_TITLE; void FONT_META; void FONT_BODY;
void LINE_HEIGHT_BODY; void HANDLE_SHOW_DIST;
