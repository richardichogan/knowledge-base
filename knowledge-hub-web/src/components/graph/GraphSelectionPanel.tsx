/**
 * components/graph/GraphSelectionPanel.tsx
 * Right-side panel shown when two or more nodes are selected (Shift+click).
 * Shows count by type and shared tags.
 */
import React from 'react';
import { Tag } from '@carbon/react';
import type { GraphNode } from '../../services/api';

interface GraphSelectionPanelProps {
  nodes: GraphNode[];
  onClose: () => void;
}

/** Returns tags that appear in every node's tag list. */
function sharedTags(nodes: GraphNode[]): string[] {
  if (nodes.length === 0) return [];
  const [first, ...rest] = nodes;
  return (first?.tags ?? []).filter((t) => rest.every((n) => n.tags.includes(t)));
}

/** Counts nodes by ref_type. */
function countByType(nodes: GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    counts[n.refType] = (counts[n.refType] ?? 0) + 1;
  }
  return counts;
}

export const GraphSelectionPanel: React.FC<GraphSelectionPanelProps> = ({ nodes, onClose }) => {
  const shared = sharedTags(nodes);
  const byType = countByType(nodes);

  return (
    <div className="graph-detail-panel">
      <div className="graph-detail-panel__header">
        <span className="graph-detail-panel__type">{nodes.length} nodes selected</span>
        <button className="graph-detail-panel__close" onClick={onClose} aria-label="Close selection panel">✕</button>
      </div>

      <div className="graph-detail-panel__edges">
        <p className="graph-detail-panel__section-label">Types</p>
        {Object.entries(byType).map(([type, count]) => (
          <div key={type} className="graph-detail-panel__edge-row">
            <span className="graph-detail-panel__edge-type">{type}</span>
            <span className="graph-detail-panel__edge-count">{count}</span>
          </div>
        ))}
      </div>

      {shared.length > 0 && (
        <div className="graph-detail-panel__tags">
          <p className="graph-detail-panel__section-label">Shared tags</p>
          {shared.map((t) => <Tag key={t} type="teal" size="sm">{t}</Tag>)}
        </div>
      )}
    </div>
  );
};
