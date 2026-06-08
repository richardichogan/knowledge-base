/**
 * useCanvasPersist.ts
 * Debounced save logic for canvas state to the backend API.
 *
 * - Viewport: debounced 1 s after pan/zoom settles
 * - Node position: called on drag-end (immediate, no debounce needed here)
 * - Node body: debounced 500 ms after edit
 * - New nodes/edges: immediate
 * - Deletes: immediate
 */
import { useRef, useCallback } from 'react';
import { api } from '../../services/api';
import type { CanvasNode, CanvasEdge, EdgeType } from './canvasTypes';

const VIEWPORT_DEBOUNCE_MS  = 1_000;
const BODY_DEBOUNCE_MS      = 500;

export function useCanvasPersist(
  canvasId: string,
  onNodeCreated: (node: CanvasNode) => void,
  onEdgeCreated: (edge: CanvasEdge) => void,
) {
  const vpTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyTimers  = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Viewport ───────────────────────────────────────────────────────────────

  const persistViewport = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      if (vpTimerRef.current) clearTimeout(vpTimerRef.current);
      vpTimerRef.current = setTimeout(() => {
        void api.updateCanvas(canvasId, { viewport: vp });
      }, VIEWPORT_DEBOUNCE_MS);
    },
    [api, canvasId],
  );

  // ── Node position (called on drag-end — immediate) ─────────────────────────

  const persistNodePos = useCallback(
    (nodeId: string, x: number, y: number) => {
      void api.updateCanvasNode(canvasId, nodeId, { x, y });
    },
    [api, canvasId],
  );

  // ── Node size (immediate) ──────────────────────────────────────────────────

  const persistNodeSize = useCallback(
    (nodeId: string, width: number, height: number) => {
      void api.updateCanvasNode(canvasId, nodeId, { width, height });
    },
    [api, canvasId],
  );

  // ── Node body (debounced) ──────────────────────────────────────────────────

  const persistNodeBody = useCallback(
    (nodeId: string, patch: { label?: string; body?: string; colour?: string }) => {
      const existing = bodyTimers.current.get(nodeId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        void api.updateCanvasNode(canvasId, nodeId, patch);
        bodyTimers.current.delete(nodeId);
      }, BODY_DEBOUNCE_MS);
      bodyTimers.current.set(nodeId, t);
    },
    [api, canvasId],
  );

  // ── New node (immediate) ───────────────────────────────────────────────────

  const persistNewNode = useCallback(
    async (input: {
      nodeType: string; refType?: string; refId?: string;
      label?: string; body?: string; url?: string; tags?: string[];
      x: number; y: number; width?: number; height?: number; colour?: string;
    }): Promise<void> => {
      const res = await api.createCanvasNode(canvasId, input);
      if (res.success && res.data) onNodeCreated(res.data as CanvasNode);
    },
    [api, canvasId, onNodeCreated],
  );

  // ── Delete node (immediate) ────────────────────────────────────────────────

  const persistDeleteNode = useCallback(
    async (nodeId: string): Promise<void> => {
      await api.deleteCanvasNode(canvasId, nodeId);
    },
    [api, canvasId],
  );

  // ── New edge (immediate) ───────────────────────────────────────────────────

  const persistNewEdge = useCallback(
    async (sourceId: string, targetId: string, edgeType: EdgeType = 'relates-to', label?: string): Promise<void> => {
      const res = await api.createCanvasEdge(canvasId, sourceId, targetId, edgeType, label);
      if (res.success && res.data) onEdgeCreated(res.data as CanvasEdge);
    },
    [api, canvasId, onEdgeCreated],
  );

  // ── Delete edge (immediate) ────────────────────────────────────────────────

  const persistDeleteEdge = useCallback(
    async (edgeId: string): Promise<void> => {
      await api.deleteCanvasEdge(canvasId, edgeId);
    },
    [api, canvasId],
  );

  return {
    persistViewport,
    persistNodePos,
    persistNodeSize,
    persistNodeBody,
    persistNewNode,
    persistDeleteNode,
    persistNewEdge,
    persistDeleteEdge,
  };
}
