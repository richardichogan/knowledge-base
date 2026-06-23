/**
 * components/graph/GraphCanvas.tsx
 * Force-directed graph canvas. Wraps react-force-graph-2d with:
 * - Square-root degree scaling, dashed inferred edges (via graphDraw.ts)
 * - Hover spotlight: hovered node + 1-hop neighbours at full alpha, rest dimmed
 * - Gentle 2.5s settle animation with node fade-in over 1.5s
 * - Node pinning on drag; full freeze on engine stop; release-all-pins signal
 * - Labels fade in past zoom threshold (1.6)
 */
import React, { useRef, useCallback, useEffect, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphNode, GraphEdge } from '../../services/api';
import { GraphTooltip } from './GraphTooltip';
import { FADE_DURATION, nodeRadius, drawNode, drawEdge } from './graphDraw';
import { nodeColour, type ColourMode } from './graphColour';
import { TYPE_TO_SHAPE } from './graphShapes';

const DOUBLE_CLICK_MS = 300;

interface FGNode extends Record<string, unknown> {
  id: string; refType: string; title: string;
  refId: string; tags: string[]; createdAt: string;
  conceptParent: string | null;
  edgeCount: number; x?: number; y?: number; fx?: number; fy?: number;
}
interface FGLink extends Record<string, unknown> {
  source: string | FGNode; target: string | FGNode;
  edgeType: string; confidence: number;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedIds: Set<string>;
  searchQuery: string;
  colourMode: ColourMode;
  onNodeHover?: (node: GraphNode | null) => void;
  onNodeClick: (node: GraphNode, shiftKey: boolean) => void;
  onNodeDblClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  /** Increment to release all pinned nodes and let the graph re-settle. */
  releasePinsSignal?: number;
}

/** Builds a bidirectional adjacency map from edge list. */
function buildAdjacency(edges: GraphEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!map.has(e.source)) map.set(e.source, new Set());
    if (!map.has(e.target)) map.set(e.target, new Set());
    map.get(e.source)!.add(e.target);
    map.get(e.target)!.add(e.source);
  }
  return map;
}

/** Wraps react-force-graph-2d with the full visual and interaction spec. */
export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes, edges, selectedIds, searchQuery, colourMode,
  onNodeHover, onNodeClick, onNodeDblClick, onBackgroundClick,
  releasePinsSignal,
}) => {
  const containerRef  = useRef<HTMLDivElement>(null);
  const tooltipRef    = useRef<HTMLDivElement | null>(null);
  const lastClickRef  = useRef<{ id: string; time: number } | null>(null);
  const mousePosRef   = useRef({ x: 0, y: 0 });
  const hoveredIdRef  = useRef<string | null>(null);
  const pinnedIdsRef  = useRef<Set<string>>(new Set());
  const mountTimeRef  = useRef(Date.now());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef         = useRef<any>(null);
  const [hoveredNode, setHoveredNode] = React.useState<GraphNode | null>(null);

  const adjacency  = useMemo(() => buildAdjacency(edges), [edges]);
  const edgeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of edges) {
      c[e.source] = (c[e.source] ?? 0) + 1;
      c[e.target] = (c[e.target] ?? 0) + 1;
    }
    return c;
  }, [edges]);
  const maxEdges  = useMemo(() => Math.max(1, ...Object.values(edgeCounts)), [edgeCounts]);
  const fgNodes: FGNode[] = useMemo(
    () => nodes.map((n) => ({ ...n, edgeCount: edgeCounts[n.id] ?? 0 })),
    [nodes, edgeCounts],
  );
  const fgLinks: FGLink[] = useMemo(
    () => edges.map((e) => ({ source: e.source, target: e.target, edgeType: e.edgeType, confidence: e.confidence })),
    [edges],
  );

  // Release all pins when the signal increments
  useEffect(() => {
    if (!releasePinsSignal) return;
    const live: FGNode[] = fgRef.current?.graphData?.()?.nodes ?? [];
    for (const n of live) { delete n.fx; delete n.fy; }
    pinnedIdsRef.current.clear();
    fgRef.current?.d3ReheatSimulation?.();
  }, [releasePinsSignal]);

  // Tooltip positioning — imperative, no state
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const el = tooltipRef.current;
      if (el) { el.style.left = `${mousePosRef.current.x + 12}px`; el.style.top = `${mousePosRef.current.y - 8}px`; }
    };
    // Freeze all nodes the moment the mouse enters the canvas so hover/click is reliable.
    // Nodes are unfrozen again when the user drags or clicks "Release Pins".
    const onEnter = () => {
      const live: FGNode[] = fgRef.current?.graphData?.()?.nodes ?? [];
      for (const n of live) {
        if (n.x !== undefined) n.fx = n.x;
        if (n.y !== undefined) n.fy = n.y;
      }
    };
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseenter', onEnter);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseenter', onEnter);
    };
  }, []);

  const nodeCanvasObject = useCallback((node: FGNode, ctx: CanvasRenderingContext2D, gs: number) => {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const hov        = hoveredIdRef.current;
    const isHovered  = hov === node.id;
    const isSelected = selectedIds.has(node.id);
    const hovNeigh   = hov ? (adjacency.get(hov) ?? new Set<string>()) : new Set<string>();
    const selNeigh   = new Set<string>(
      [...selectedIds].flatMap((id) => [...(adjacency.get(id) ?? [])]),
    );
    const isNeighbour = hovNeigh.has(node.id) || selNeigh.has(node.id);
    const anyActive   = hov !== null || selectedIds.size > 0;
    const isDimmed    = anyActive && !isHovered && !isSelected && !isNeighbour;
    const baseColour  = nodeColour(node.refType, (node.conceptParent as string | null) ?? null, colourMode);
    const colour = (searchQuery && !node.title.toLowerCase().includes(searchQuery.toLowerCase()))
      ? 'rgba(82,82,82,0.3)'
      : baseColour;
    const shape = TYPE_TO_SHAPE[node.refType] ?? 'circle';
    drawNode(ctx, x, y, {
      r: nodeRadius(node.edgeCount, maxEdges),
      colour, shape, isSelected, isHovered, isDimmed,
      isPinned: pinnedIdsRef.current.has(node.id),
      globalScale: gs,
      fadeAlpha: Math.min(1, (Date.now() - mountTimeRef.current) / FADE_DURATION),
      label: node.title,
    });
  }, [selectedIds, searchQuery, adjacency, maxEdges, colourMode]);

  const linkCanvasObject = useCallback((link: FGLink, ctx: CanvasRenderingContext2D, gs: number) => {
    const src = link.source as FGNode;
    const tgt = link.target as FGNode;
    const hov = hoveredIdRef.current;
    const isHighlit = selectedIds.has(src.id) || selectedIds.has(tgt.id)
      || hov === src.id || hov === tgt.id;
    const anyActive = hov !== null || selectedIds.size > 0;
    drawEdge(ctx, src.x ?? 0, src.y ?? 0, tgt.x ?? 0, tgt.y ?? 0, {
      isHighlit, isDimmed: anyActive && !isHighlit,
      edgeType: link.edgeType, confidence: link.confidence, globalScale: gs,
    });
  }, [selectedIds]);

  const setHoveredNodeRef = useRef(setHoveredNode);
  setHoveredNodeRef.current = setHoveredNode;

  // Stable — reads refs only, never changes identity → ForceGraph2D never sees a new prop
  const handleNodeHover = useCallback((node: FGNode | null) => {
    const gn = node ? (node as unknown as GraphNode) : null;
    hoveredIdRef.current = gn?.id ?? null;
    setHoveredNodeRef.current(gn);
    fgRef.current?.refresh?.(); // repaint canvas with updated spotlight state
    onNodeHover?.(gn);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNodeClick = useCallback((node: FGNode, event: MouseEvent) => {
    const gn = node as unknown as GraphNode;
    const now = Date.now();
    const last = lastClickRef.current;
    if (last?.id === gn.id && now - last.time < DOUBLE_CLICK_MS) {
      onNodeDblClick(gn); lastClickRef.current = null;
    } else {
      lastClickRef.current = { id: gn.id, time: now };
      onNodeClick(gn, event.shiftKey);
    }
  }, [onNodeClick, onNodeDblClick]);

  const handleNodeDragEnd = useCallback((node: FGNode) => {
    if (node.x !== undefined) node.fx = node.x;
    if (node.y !== undefined) node.fy = node.y;
    pinnedIdsRef.current.add(node.id);
  }, []);

  const handleEngineStop = useCallback(() => {
    // Freeze every node once the simulation settles — hover can no longer move them
    const live: FGNode[] = fgRef.current?.graphData?.()?.nodes ?? [];
    for (const n of live) {
      if (n.x !== undefined) n.fx = n.x;
      if (n.y !== undefined) n.fy = n.y;
    }
  }, []);

  const canvasObjectMode     = useCallback(() => 'replace' as const, []);
  const linkCanvasObjectMode = useCallback(() => 'replace' as const, []);

  return (
    <div ref={containerRef} className="graph-canvas-wrap">
      <ForceGraph2D
        ref={fgRef}
        graphData={{ nodes: fgNodes, links: fgLinks }}
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={canvasObjectMode}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={linkCanvasObjectMode}
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        onNodeDragEnd={handleNodeDragEnd}
        onEngineStop={handleEngineStop}
        onBackgroundClick={onBackgroundClick}
        backgroundColor="#161616"
        d3AlphaDecay={0.08}
        d3VelocityDecay={0.6}
        cooldownTime={1200}
        {...(containerRef.current?.clientWidth  !== undefined && { width:  containerRef.current.clientWidth  })}
        {...(containerRef.current?.clientHeight !== undefined && { height: containerRef.current.clientHeight })}
      />
      {hoveredNode !== null && (
        <div className="graph-tooltip-wrap" ref={tooltipRef}>
          <GraphTooltip node={hoveredNode} edges={edges} x={0} y={0} />
        </div>
      )}
    </div>
  );
};