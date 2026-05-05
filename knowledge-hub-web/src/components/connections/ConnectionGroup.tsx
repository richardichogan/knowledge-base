/**
 * components/connections/ConnectionGroup.tsx
 * A labelled group of connection edges with "Show all" expansion.
 */
import React, { useState } from 'react';
import { ConnectionItem } from './ConnectionItem';
import type { ConnectionEdge } from '../../services/api';

interface ConnectionGroupProps {
  edgeType: string;
  edges: ConnectionEdge[];
  onItemClick: (edge: ConnectionEdge) => void;
}

const DEFAULT_VISIBLE = 5;

const GROUP_LABELS: Record<string, string> = {
  has_spark:            'Sparks',
  references:           'References',
  tag_overlap:          'Shared tags',
  produced_in_window:   'Co-temporal',
  thematically_related: 'Thematically related',
};

export const ConnectionGroup: React.FC<ConnectionGroupProps> = ({ edgeType, edges, onItemClick }) => {
  const [expanded, setExpanded] = useState(false);
  const label = GROUP_LABELS[edgeType] ?? edgeType;
  const visible = expanded ? edges : edges.slice(0, DEFAULT_VISIBLE);

  return (
    <div className="conn-group">
      <p className="conn-group__label">{label}</p>
      {visible.map((edge) => (
        <ConnectionItem key={edge.edgeId} edge={edge} onClick={() => { onItemClick(edge); }} />
      ))}
      {edges.length > DEFAULT_VISIBLE && !expanded && (
        <button className="conn-group__show-all" onClick={() => { setExpanded(true); }}>
          Show all ({edges.length})
        </button>
      )}
    </div>
  );
};
