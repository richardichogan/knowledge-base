/**
 * components/graph/GraphNodeDetail.tsx
 * Right-side detail panel shown when a single node is selected.
 * Actions: "Open in hub" and "Start here" (re-centre graph on seed).
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Tag } from '@carbon/react';
import type { GraphNode, GraphEdge } from '../../services/api';

interface GraphNodeDetailProps {
  node: GraphNode;
  edges: GraphEdge[];
  onStartHere: (nodeId: string) => void;
  onClose: () => void;
}

/** Maps ref_type to its native hub route. */
function routeForNode(refType: string, refId: string): string {
  if (refType === 'note')                              return '/think';
  if (refType === 'document')                         return '/library';
  if (refType === 'task')                             return '/plan';
  if (refType === 'discover_item' || refType === 'cfp_item') return '/discover';
  if (refType === 'spark')                            return '/think';
  return `/my-work?highlight=${refId}`;
}

/** Counts edges by type for the summary list. */
function summariseEdges(nodeId: string, edges: GraphEdge[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of edges) {
    if (e.source === nodeId || e.target === nodeId) {
      counts[e.edgeType] = (counts[e.edgeType] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Single-node detail panel. Slides in from the right when a node is clicked.
 */
export const GraphNodeDetail: React.FC<GraphNodeDetailProps> = ({ node, edges, onStartHere, onClose }) => {
  const navigate = useNavigate();
  const edgeSummary = summariseEdges(node.id, edges);
  const createdDate = new Date(node.createdAt).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

  return (
    <div className="graph-detail-panel">
      <div className="graph-detail-panel__header">
        <span className="graph-detail-panel__type">{node.refType}</span>
        <button className="graph-detail-panel__close" onClick={onClose} aria-label="Close detail panel">✕</button>
      </div>

      <h2 className="graph-detail-panel__title">{node.title}</h2>
      <p className="graph-detail-panel__date">Created {createdDate}</p>

      {node.tags.length > 0 && (
        <div className="graph-detail-panel__tags">
          {node.tags.map((t) => <Tag key={t} type="teal" size="sm">{t}</Tag>)}
        </div>
      )}

      <div className="graph-detail-panel__edges">
        <p className="graph-detail-panel__section-label">Connections</p>
        {Object.entries(edgeSummary).map(([type, count]) => (
          <div key={type} className="graph-detail-panel__edge-row">
            <span className="graph-detail-panel__edge-type">{type}</span>
            <span className="graph-detail-panel__edge-count">{count}</span>
          </div>
        ))}
        {Object.keys(edgeSummary).length === 0 && (
          <p className="graph-detail-panel__empty">No connections</p>
        )}
      </div>

      <div className="graph-detail-panel__actions">
        <Button
          kind="primary"
          size="sm"
          onClick={() => { void navigate(routeForNode(node.refType, node.refId)); }}
        >
          Open in hub
        </Button>
        <Button
          kind="tertiary"
          size="sm"
          onClick={() => { onStartHere(node.id); }}
        >
          Start here
        </Button>
      </div>
    </div>
  );
};
