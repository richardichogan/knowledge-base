/**
 * components/graph/GraphCanvas.tsx
 * Renders the force-directed graph using react-force-graph (2D).
 * Handles node colouring, sizing, hover tooltip, click/double-click selection,
 * shift-click multi-select, and background deselect.
 */
import React, { useRef, useCallback, useEffect } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphNode, GraphEdge } from '../../services/api';
import { GraphTooltip } from './GraphTooltip';

const NODE_COLOURS: Record<string, string> = {
  discover_item:   '#3ddbd9',
  note:            '#be95ff',
  document:        '#82cfff',
  spark:           '#f1c21b',
  task:            '#6fdc8c',
  commit:          '#ff7eb6',
  pull_request:    '#ffb784',
  cfp_item:        '#fa4d56',
  blog_post:       '#3ddbd9',
  podcast_episode: '#be95ff',
  canvas:          '#6fdc8c',
};

const EDGE_OPACITY: Record<string, number> = {
  has_spark:            0.8,
  tag_overlap:          0.4,
  references:           0.9,
  produced_in_window:   0.3,
  thematically_related: 0.5,
};

const MIN_RADIUS = 6;
const MAX_RADIUS = 20;
const ACCENT = '#3ddbd9';
const DOUBLE_CLICK_MS = 300;

interface FGNode extends Record<string, unknown> {
  id: string; refType: string; title: string;
  refId: string; tags: string[]; createdAt: string;
  edgeCount: number; x?: number; y?: number;
}
interface FGLink extends Record<string, unknown> {
  source: string | FGNode; target: string | FGNode;
  edgeType: string; confidence: number;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedIds: Set<string>;
  searchQuery: string;
  hoveredId: string | null;
  hoveredPos: { x: number; y: number };
  onNodeHover: (node: GraphNode | null) => void;
  onNodeClick: (node: GraphNode, shiftKey: boolean) => void;
  onNodeDblClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
}

/** Wraps react-force-graph (2D) with visual treatment from the spec. */
export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes, edges, selectedIds, searchQuery, hoveredId, hoveredPos,
  onNodeHover, onNodeClick, onNodeDblClick, onBackgroundClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef   = useRef<HTMLDivElement | null>(null);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);

  const edgeCounts: Record<string, number> = {};
  for (const e of edges) {
    edgeCounts[e.source] = (edgeCounts[e.source] ?? 0) + 1;
    edgeCounts[e.target] = (edgeCounts[e.target] ?? 0) + 1;
  }
  const maxEdges = Math.max(1, ...Object.values(edgeCounts));

  const fgNodes: FGNode[] = nodes.map((n) => ({ ...n, edgeCount: edgeCounts[n.id] ?? 0 }));
  const fgLinks: FGLink[] = edges.map((e) => ({
    source: e.source, target: e.target, edgeType: e.edgeType, confidence: e.confidence,
  }));

  const nodeRadius = useCallback((node: FGNode) =>
    MIN_RADIUS + (node.edgeCount / maxEdges) * (MAX_RADIUS - MIN_RADIUS), [maxEdges]);

  const nodeCanvasObject = useCallback((node: FGNode, ctx: CanvasRenderingContext2D, gs: number) => {
    const r = nodeRadius(node);
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isSelected = selectedIds.has(node.id);
    const isHovered  = hoveredId === node.id;

    let colour = NODE_COLOURS[node.refType] ?? '#8d8d8d';
    if (searchQuery && !node.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      colour = 'rgba(82,82,82,0.2)';
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = colour; ctx.fill();

    if (isSelected || isHovered) {
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 2 / gs; ctx.stroke();
    }
    if (isHovered || isSelected) {
      ctx.font = `9px 'IBM Plex Mono', monospace`;
      ctx.fillStyle = '#8d8d8d'; ctx.textAlign = 'center';
      ctx.fillText(node.title.slice(0, 30), x, y + r + 10 / gs);
    }
  }, [nodeRadius, selectedIds, hoveredId, searchQuery]);

  const linkColor = useCallback((link: FGLink): string => {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (selectedIds.has(s) || selectedIds.has(t)) return ACCENT;
    return `rgba(82,82,82,${EDGE_OPACITY[link.edgeType] ?? 0.4})`;
  }, [selectedIds]);

  const linkWidth = useCallback((link: FGLink) => Math.max(0.5, link.confidence * 2), []);

  useEffect(() => {
    const el = tooltipRef.current;
    if (el) { el.style.left = `${hoveredPos.x + 12}px`; el.style.top = `${hoveredPos.y - 8}px`; }
  });

  const hoveredNode = nodes.find((n) => n.id === hoveredId) ?? null;

  return (
    <div ref={containerRef} className="graph-canvas-wrap">
      <ForceGraph2D
        graphData={{ nodes: fgNodes, links: fgLinks }}
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace' as const}
        linkColor={linkColor}
        linkWidth={linkWidth}
        onNodeHover={(node) => { onNodeHover(node ? (node as unknown as GraphNode) : null); }}
        onNodeClick={(node, event) => {
          const gn = node as unknown as GraphNode;
          const now = Date.now();
          const last = lastClickRef.current;
          if (last?.id === gn.id && now - last.time < DOUBLE_CLICK_MS) {
            onNodeDblClick(gn); lastClickRef.current = null;
          } else {
            lastClickRef.current = { id: gn.id, time: now };
            onNodeClick(gn, event.shiftKey);
          }
        }}
        onBackgroundClick={onBackgroundClick}
        backgroundColor="#161616"
        {...(containerRef.current?.clientWidth !== undefined && { width: containerRef.current.clientWidth })}
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
