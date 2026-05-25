/**
 * components/graph/GraphTooltip.tsx
 * Hover tooltip rendered over the graph canvas.
 * Shows node title, ref_type badge, tag count, and edge count.
 * Positioned via data-x / data-y attributes — CSS uses attr() to place it.
 * Parent must be position:relative.
 */
import React from 'react';
import type { GraphNode, GraphEdge } from '../../services/api';

interface GraphTooltipProps {
  node: GraphNode;
  edges: GraphEdge[];
  x: number;
  y: number;
}

/**
 * Renders a tooltip absolutely positioned at (x, y) inside the graph canvas.
 * Uses a wrapper element with data attributes so CSS can read the position.
 */
export const GraphTooltip: React.FC<GraphTooltipProps> = ({ node, edges, x, y }) => {
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
