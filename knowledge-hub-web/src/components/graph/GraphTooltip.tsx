/**
 * components/graph/GraphTooltip.tsx
 * Hover tooltip rendered over the graph canvas.
 * Shows node title, ref_type badge, tag count, and edge count.
 * Positioned via data-x / data-y attributes — CSS uses attr() to place it.
 * Parent must be position:relative.
 */
import React, { forwardRef, useImperativeHandle, useState } from 'react';
import type { GraphNode, GraphEdge } from '../../services/api';

interface GraphTooltipProps {
  node: GraphNode | null;
  edges: GraphEdge[];
  x: number;
  y: number;
}

export interface TooltipHostHandle {
  setNode: (node: GraphNode | null) => void;
}

/**
 * Wrapper that owns its own state so it can update without re-rendering GraphCanvas.
 * GraphCanvas calls `ref.current.setNode(node)` imperatively on hover.
 */
export const TooltipHost = forwardRef<TooltipHostHandle, { edges: GraphEdge[] }>(
  ({ edges }, ref) => {
    const [node, setNode] = useState<GraphNode | null>(null);
    useImperativeHandle(ref, () => ({ setNode }), []);
    if (!node) return null;
    return <GraphTooltip node={node} edges={edges} x={0} y={0} />;
  },
);
TooltipHost.displayName = 'TooltipHost';

/**
 * Renders a tooltip absolutely positioned at (x, y) inside the graph canvas.
 */
export const GraphTooltip: React.FC<GraphTooltipProps> = ({ node, edges, x, y }) => {
  if (!node) return null;
  const edgeCount = edges.filter(
    (e) => e.source === node.id || e.target === node.id,
  ).length;

  return (
    <div
      className="graph-tooltip"
      data-x={x}
      data-y={y}
      /* Position is applied imperatively in GraphCanvas after mount */
    >
      <span className="graph-tooltip__type">{node.refType}</span>
      <p className="graph-tooltip__title">{node.title}</p>
      <div className="graph-tooltip__meta">
        <span>{node.tags.length} tag{node.tags.length !== 1 ? 's' : ''}</span>
        <span className="graph-tooltip__sep">·</span>
        <span>{edgeCount} connection{edgeCount !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
};
