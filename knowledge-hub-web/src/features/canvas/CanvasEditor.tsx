/**
 * CanvasEditor.tsx
 *
 * Split into two components to avoid the stale-ref bug:
 *
 *   CanvasEditor (exported) — fetches data, shows loading/error states.
 *     Once data is ready it renders CanvasEditorInner which always mounts
 *     the canvas element unconditionally, so the renderer useEffect always
 *     fires against a real DOM element.
 *
 *   CanvasEditorInner — receives initial data as props, owns the renderer.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { CanvasRenderer, type RendererCallbacks } from './CanvasRenderer';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasSidebar } from './CanvasSidebar';
import { useCanvasState } from './useCanvasState';
import { useCanvasPersist } from './useCanvasPersist';
import { fitViewport } from './canvasGeometry';
import { readCanvasItem, readPlainText } from './canvasClipboard';
import { api } from '../../services/api';
import type { CanvasNode, CanvasEdge, EdgeType, Viewport } from './canvasTypes';
import type { CanvasFullApi } from '../../services/api';

const NODE_DEFAULT_WIDTH  = 280;
const NODE_DEFAULT_HEIGHT = 80;
const ZOOM_STEP           = 0.2;

// ── Loader wrapper ────────────────────────────────────────────────────────────

interface Props { canvasId: string; onBack?: () => void; }

export const CanvasEditor: React.FC<Props> = ({ canvasId, onBack }) => {
  const { data, isLoading, isError } = useQuery<CanvasFullApi>({
    queryKey: ['canvas', canvasId],
    queryFn: async () => {
      const r = await api.getCanvas(canvasId);
      if (!r.success || !r.data) throw new Error('Failed to load canvas');
      return r.data;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="cv-editor">
        <div className="cv-loading"><InlineLoading description="Loading canvas…" /></div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="cv-editor">
        <div className="cv-error">Failed to load canvas.</div>
      </div>
    );
  }

  return (
    <CanvasEditorInner
      key={`${canvasId}-${data.nodes.length}`}
      canvasId={canvasId}
      initialTitle={data.title}
      initialNodes={data.nodes as CanvasNode[]}
      initialEdges={data.edges as CanvasEdge[]}
      initialViewport={data.viewport}
      {...(onBack !== undefined ? { onBack } : {})}
    />
  );
};

// ── Inner editor — <canvas> is always in the DOM when this mounts ─────────────

interface InnerProps {
  canvasId: string;
  initialTitle: string;
  initialNodes: CanvasNode[];
  initialEdges: CanvasEdge[];
  initialViewport: Viewport;
  onBack?: () => void;
}

const CanvasEditorInner: React.FC<InnerProps> = ({
  canvasId, initialTitle, initialNodes, initialEdges, initialViewport, onBack,
}) => {
  const canvasElRef  = useRef<HTMLCanvasElement>(null);
  const rendererRef  = useRef<CanvasRenderer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient  = useQueryClient();

  const [sidebarOpen,     setSidebarOpen]     = useState(false);
  const [defaultEdgeType, setDefaultEdgeType] = useState<EdgeType>('relates-to');
  const [title,           setTitle]           = useState(initialTitle);
  const [savingTitle,     setSavingTitle]      = useState(false);

  // Inline node editor state — height managed imperatively, no React state for it
  const [editingNodeId,  setEditingNodeId]  = useState<string | null>(null);
  const [editingTitle,   setEditingTitle]   = useState('');
  const [editingBody,    setEditingBody]    = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);

  const state = useCanvasState({
    nodes: initialNodes, edges: initialEdges, viewport: initialViewport,
  });

  // Refs that the renderer callbacks read — always up-to-date, no stale closure
  const stateRef            = useRef(state);
  stateRef.current          = state;
  const persistRef          = useRef<ReturnType<typeof useCanvasPersist> | null>(null);
  const defaultEdgeTypeRef  = useRef(defaultEdgeType);
  defaultEdgeTypeRef.current = defaultEdgeType;

  const persist = useCanvasPersist(
    canvasId,
    useCallback((node) => { stateRef.current.addNode(node); }, []),
    useCallback((edge) => { stateRef.current.addEdge(edge); }, []),
  );
  persistRef.current = persist;

  // ── Mount renderer ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasElRef.current;
    if (!el) return;

    const callbacks: RendererCallbacks = {
      onNodeDragEnd: (nodeId, x, y) => {
        stateRef.current.updateNodePos(nodeId, x, y);
        persistRef.current?.persistNodePos(nodeId, x, y);
      },
      onNodeResizeEnd: (nodeId, width, height) => {
        stateRef.current.updateNodeSize(nodeId, width, height);
        persistRef.current?.persistNodeSize(nodeId, width, height);
      },
      onEdgeCreate: (sourceId, targetId) => {
        void persistRef.current?.persistNewEdge(sourceId, targetId, defaultEdgeTypeRef.current);
      },
      onNodeDoubleClick: (nodeId) => {
        const node = stateRef.current.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        setEditingNodeId(nodeId);
        setEditingTitle(node.label ?? '');
        setEditingBody(node.body ?? '');
        // Grow node to fit content before textarea renders
        const vp = stateRef.current.viewport;
        const minH = Math.max(NODE_DEFAULT_HEIGHT, node.height);
        stateRef.current.updateNodeSize(nodeId, node.width, minH);
        setTimeout(() => {
          titleInputRef.current?.focus();
          titleInputRef.current?.select();
          const ta = bodyTextareaRef.current;
          if (ta) {
            ta.style.height = '0';
            ta.style.height = `${ta.scrollHeight}px`;
            // Grow node to fully show body
            const newH = Math.max(NODE_DEFAULT_HEIGHT, Math.ceil((ta.scrollHeight + 120) / vp.zoom));
            stateRef.current.updateNodeSize(nodeId, node.width, newH);
            rendererRef.current?.setData(stateRef.current.nodes, stateRef.current.edges);
          }
        }, 0);
      },
      onNodeContextMenu: (nodeId) => {
        // Just select the node — delete via keyboard (Delete/Backspace)
        stateRef.current.setSelected([nodeId]);
      },
      onEdgeContextMenu: (edgeId) => {
        stateRef.current.removeEdge(edgeId);
        void persistRef.current?.persistDeleteEdge(edgeId);
      },
      onEmptyDoubleClick: (wx, wy) => {
        void persistRef.current?.persistNewNode({
          nodeType: 'text', label: 'New text', x: wx, y: wy,
          width: NODE_DEFAULT_WIDTH, height: NODE_DEFAULT_HEIGHT,
        });
      },
      onSelectionChange: (ids) => { stateRef.current.setSelected(ids); },
    };

    const renderer = new CanvasRenderer(el, callbacks);
    rendererRef.current = renderer;

    const container = containerRef.current;
    if (container) renderer.resize(container.clientWidth, container.clientHeight);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        renderer.resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    if (container) ro.observe(container);

    return () => { ro.disconnect(); renderer.destroy(); rendererRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state → renderer
  useEffect(() => { rendererRef.current?.setData(state.nodes, state.edges); }, [state.nodes, state.edges]);
  useEffect(() => {
    rendererRef.current?.setViewport(state.viewport);
    persistRef.current?.persistViewport(state.viewport);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.viewport]);
  useEffect(() => { rendererRef.current?.setSelected(state.selectedIds); }, [state.selectedIds]);
  useEffect(() => { rendererRef.current?.setEditingNode(editingNodeId); }, [editingNodeId]);

  // ── Inline node editor ──────────────────────────────────────────────────────
  const commitEdit = useCallback(() => {
    if (!editingNodeId) return;
    const node = stateRef.current.nodes.find((n) => n.id === editingNodeId);
    if (node) {
      const ta  = bodyTextareaRef.current;
      const vp  = stateRef.current.viewport;
      const newH = ta ? Math.max(NODE_DEFAULT_HEIGHT, Math.ceil((ta.scrollHeight + 120) / vp.zoom)) : node.height;
      const patch: { label?: string; body?: string } = {};
      if (editingTitle.trim()) patch.label = editingTitle.trim();
      if (editingBody !== (node.body ?? '')) patch.body = editingBody;
      stateRef.current.updateNodeBody(editingNodeId, patch);
      stateRef.current.updateNodeSize(editingNodeId, node.width, newH);
      persistRef.current?.persistNodeBody(editingNodeId, patch);
      persistRef.current?.persistNodeSize(editingNodeId, node.width, newH);
    }
    setEditingNodeId(null);
  }, [editingNodeId, editingTitle, editingBody]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        stateRef.current.setViewport({ x: 0, y: 0, zoom: 1 });
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'H') {
        const c = containerRef.current;
        if (c) stateRef.current.setViewport(fitViewport(stateRef.current.nodes, c.clientWidth, c.clientHeight));
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement === document.body) {
        for (const id of stateRef.current.selectedIds) {
          stateRef.current.removeNode(id);
          void persistRef.current?.persistDeleteNode(id);
        }
      }
      if (e.key === 'Escape' && editingNodeId) {
        setEditingNodeId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, []);

  // ── Paste handler ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      // Don't intercept pastes inside text inputs / contenteditable
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return;

      const c  = containerRef.current;
      const vp = stateRef.current.viewport;
      // Drop new node at viewport centre
      const wx = ((c?.clientWidth  ?? 600) / 2 - vp.x) / vp.zoom;
      const wy = ((c?.clientHeight ?? 400) / 2 - vp.y) / vp.zoom;

      const hubItem = readCanvasItem(e);
      if (hubItem !== null) {
        e.preventDefault();
        // Calculate taller height to fit body + tags when present
        const hasBody = !!hubItem.body;
        const hasTags = !!hubItem.tags?.length;
        const h = 80 + (hasBody ? 60 : 0) + (hasTags ? 28 : 0) + (hubItem.url ? 20 : 0);
        void persistRef.current?.persistNewNode({
          nodeType: 'hub_ref',
          refType:  hubItem.refType,
          refId:    hubItem.id,
          label:    hubItem.label,
          ...(hubItem.body  ? { body: hubItem.body }   : {}),
          ...(hubItem.url   ? { url:  hubItem.url }    : {}),
          ...(hubItem.tags?.length ? { tags: hubItem.tags } : {}),
          x: wx, y: wy,
          width: 300, height: h,
        });
        return;
      }

      const text = readPlainText(e).trim();
      if (text) {
        e.preventDefault();
        // Detect URLs — create a link card instead of raw text
        let isUrl = false;
        try { new URL(text); isUrl = text.startsWith('http'); } catch { /* not a url */ }
        if (isUrl) {
          let hostname = text;
          try { hostname = new URL(text).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
          void persistRef.current?.persistNewNode({
            nodeType: 'text',
            label:    hostname,
            ...(text ? { url: text } : {}),
            x: wx, y: wy,
            width: 300, height: 72,
          });
        } else {
          void persistRef.current?.persistNewNode({
            nodeType: 'text',
            label:    text.slice(0, 200),
            x: wx, y: wy,
            width: 300, height: 80,
          });
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('paste', onPaste); };
  }, []);

  // ── Toolbar handlers ────────────────────────────────────────────────────────
  const handleZoomIn  = useCallback(() => {
    const vp = stateRef.current.viewport;
    stateRef.current.setViewport({ ...vp, zoom: Math.min(3, vp.zoom + ZOOM_STEP) });
  }, []);

  const handleZoomOut = useCallback(() => {
    const vp = stateRef.current.viewport;
    stateRef.current.setViewport({ ...vp, zoom: Math.max(0.1, vp.zoom - ZOOM_STEP) });
  }, []);

  const handleFit = useCallback(() => {
    const c = containerRef.current;
    if (c) stateRef.current.setViewport(fitViewport(stateRef.current.nodes, c.clientWidth, c.clientHeight));
  }, []);

  const handleAddText = useCallback(() => {
    const c  = containerRef.current;
    const vp = stateRef.current.viewport;
    const wx = ((c?.clientWidth  ?? 600) / 2 - vp.x) / vp.zoom;
    const wy = ((c?.clientHeight ?? 400) / 2 - vp.y) / vp.zoom;
    void persistRef.current?.persistNewNode({ nodeType: 'text', label: 'New text', x: wx, y: wy, width: NODE_DEFAULT_WIDTH, height: NODE_DEFAULT_HEIGHT });
  }, []);

  const handleTitleBlur = useCallback(async () => {
    if (title === initialTitle) return;
    setSavingTitle(true);
    await api.updateCanvas(canvasId, { title });
    await queryClient.invalidateQueries({ queryKey: ['canvases'] });
    setSavingTitle(false);
  }, [title, initialTitle, canvasId, queryClient]);

  const handleAddHubItem = useCallback((item: { id: string; refType: string; label: string }) => {
    const c  = containerRef.current;
    const vp = stateRef.current.viewport;
    const wx = ((c?.clientWidth  ?? 600) / 2 - vp.x) / vp.zoom;
    const wy = ((c?.clientHeight ?? 400) / 2 - vp.y) / vp.zoom;
    void persistRef.current?.persistNewNode({ nodeType: 'hub_ref', refType: item.refType, refId: item.id, label: item.label, x: wx, y: wy });
  }, []);

  // ── Compute textarea overlay position ───────────────────────────────────────
  const editingNode = state.nodes.find((n) => n.id === editingNodeId) ?? null;
  const editOverlayStyle = React.useMemo((): React.CSSProperties => {
    if (!editingNodeId || !editingNode) return { display: 'none' };
    const vp = state.viewport;
    const node = editingNode;
    const sx = node.x * vp.zoom + vp.x;
    const sy = node.y * vp.zoom + vp.y;
    const sw = node.width  * vp.zoom;
    const sh = node.height * vp.zoom;
    const barW = Math.max(4, 8 * vp.zoom);
    const pad  = 10 * vp.zoom;
    const chipH = (vp.zoom > 0.35) ? (21 * vp.zoom + 7 * vp.zoom) : (4 * vp.zoom);
    return {
      position: 'absolute' as const,
      left:   sx + barW + pad,
      top:    sy + pad + chipH,
      width:  sw - barW - pad * 2,
      height: sh - pad - chipH - pad,
      zIndex: 10,
      '--cv-edit-font-size': `${Math.max(10, Math.min(14, 14 * vp.zoom))}px`,
    } as React.CSSProperties;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingNodeId,
      editingNode?.x, editingNode?.y, editingNode?.width, editingNode?.height,
      state.viewport.x, state.viewport.y, state.viewport.zoom]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="cv-editor">
      <CanvasToolbar
        title={title}
        zoom={state.viewport.zoom}
        defaultEdgeType={defaultEdgeType}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFit={handleFit}
        onAddText={handleAddText}
        onEdgeTypeChange={setDefaultEdgeType}
        onTitleChange={setTitle}
        onTitleBlur={() => { void handleTitleBlur(); }}
        onToggleSidebar={() => { setSidebarOpen((v) => !v); }}
        sidebarOpen={sidebarOpen}
        {...(onBack !== undefined ? { onBack } : {})}
      />
      {savingTitle && <span className="cv-saving-indicator">Saving…</span>}
      <div className="cv-editor__body" ref={containerRef}>
        <canvas ref={canvasElRef} className="cv-canvas" />
        {editingNodeId && (
          <div
            className="cv-node-edit-overlay"
            style={editOverlayStyle}
            onMouseDown={(e) => { e.stopPropagation(); }}
          >
            <input
              ref={titleInputRef}
              className="cv-node-edit-title"
              type="text"
              value={editingTitle}
              placeholder="Title…"
              onChange={(e) => { setEditingTitle(e.target.value); }}
              onBlur={(e) => {
                // Only commit if focus is leaving the whole overlay
                if (!e.currentTarget.closest('.cv-node-edit-overlay')?.contains(e.relatedTarget as Node)) {
                  commitEdit();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setEditingNodeId(null); e.stopPropagation(); }
                if (e.key === 'Enter') { bodyTextareaRef.current?.focus(); e.preventDefault(); }
                if (e.key === 'Tab')   { bodyTextareaRef.current?.focus(); e.preventDefault(); }
              }}
            />
            <textarea
              ref={bodyTextareaRef}
              className="cv-node-edit-body"
              value={editingBody}
              placeholder="Body text… (optional)"
              onChange={(e) => {
                setEditingBody(e.target.value);
                const ta = e.target;
                ta.style.height = '0';
                const sh = ta.scrollHeight;
                ta.style.height = `${sh}px`;
                // Resize node to match content — grow and shrink
                const node = stateRef.current.nodes.find((n) => n.id === editingNodeId);
                if (node) {
                  const vp = stateRef.current.viewport;
                  const newH = Math.max(NODE_DEFAULT_HEIGHT, Math.ceil((sh + 120) / vp.zoom));
                  if (newH !== node.height) {
                    node.height = newH;
                    rendererRef.current?.setData(stateRef.current.nodes, stateRef.current.edges);
                  }
                }
              }}
              onBlur={(e) => {
                if (!e.currentTarget.closest('.cv-node-edit-overlay')?.contains(e.relatedTarget as Node)) {
                  commitEdit();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setEditingNodeId(null); e.stopPropagation(); }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { commitEdit(); e.preventDefault(); }
              }}
            />
          </div>
        )}
        {sidebarOpen && <CanvasSidebar onAddItem={handleAddHubItem} />}
      </div>
    </div>
  );
};
