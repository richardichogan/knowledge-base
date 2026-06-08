/**
 * useCanvasState.ts
 * Central React state for the canvas editor.
 * Manages nodes, edges, viewport, selection, and pending interactions.
 */
import { useState, useCallback } from 'react';
import type { CanvasNode, CanvasEdge, Viewport, EdgeType } from './canvasTypes';

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  selectedIds: string[];
}

export interface CanvasActions {
  setNodes:       (nodes: CanvasNode[]) => void;
  setEdges:       (edges: CanvasEdge[]) => void;
  setViewport:    (vp: Viewport) => void;
  setSelected:    (ids: string[]) => void;
  updateNodePos:  (id: string, x: number, y: number) => void;
  updateNodeSize: (id: string, w: number, h: number) => void;
  updateNodeBody: (id: string, patch: Partial<Pick<CanvasNode, 'label' | 'body' | 'colour'>>) => void;
  addNode:        (node: CanvasNode) => void;
  removeNode:     (id: string) => void;
  addEdge:        (edge: CanvasEdge) => void;
  removeEdge:     (id: string) => void;
}

export function useCanvasState(initial?: Partial<CanvasState>): CanvasState & CanvasActions {
  const [nodes,       setNodes]    = useState<CanvasNode[]>(initial?.nodes       ?? []);
  const [edges,       setEdges]    = useState<CanvasEdge[]>(initial?.edges       ?? []);
  const [viewport,    setViewport] = useState<Viewport>(    initial?.viewport    ?? { x: 0, y: 0, zoom: 1 });
  const [selectedIds, setSelected] = useState<string[]>(    initial?.selectedIds ?? []);

  const updateNodePos = useCallback((id: string, x: number, y: number) => {
    setNodes((prev) => prev.map((n) => n.id === id ? { ...n, x, y } : n));
  }, []);

  const updateNodeSize = useCallback((id: string, w: number, h: number) => {
    setNodes((prev) => prev.map((n) => n.id === id ? { ...n, width: w, height: h } : n));
  }, []);

  const updateNodeBody = useCallback(
    (id: string, patch: Partial<Pick<CanvasNode, 'label' | 'body' | 'colour'>>) => {
      setNodes((prev) => prev.map((n) => n.id === id ? { ...n, ...patch } : n));
    },
    [],
  );

  const addNode = useCallback((node: CanvasNode) => {
    setNodes((prev) => [...prev, node]);
  }, []);

  const removeNode = useCallback((id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.sourceId !== id && e.targetId !== id));
    setSelected((prev) => prev.filter((s) => s !== id));
  }, []);

  const addEdge = useCallback((edge: CanvasEdge) => {
    setEdges((prev) => [...prev, edge]);
  }, []);

  const removeEdge = useCallback((id: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return {
    nodes, edges, viewport, selectedIds,
    setNodes, setEdges, setViewport, setSelected,
    updateNodePos, updateNodeSize, updateNodeBody, addNode, removeNode, addEdge, removeEdge,
  };
}

// Re-export EdgeType for convenience so callers don't need two imports
export type { EdgeType };
