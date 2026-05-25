/**
 * components/connections/ConnectionsPanel.tsx
 * Collapsible panel showing all graph edges for a content item.
 * Sits below metadata fields on any detail view.
 *
 * Usage:
 *   <ConnectionsPanel refId={item.id} refType="discover_item" />
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ConnectionGroup } from './ConnectionGroup';
import { api } from '../../services/api';
import type { ConnectionEdge } from '../../services/api';

interface ConnectionsPanelProps {
  refId: string;
  refType: string;
}

/** Edge type display order (top to bottom as per spec). */
const EDGE_ORDER = [
  'has_spark',
  'references',
  'tag_overlap',
  'thematically_related',
];

/** Route to navigate to when a connected item is clicked. */
function routeForNode(refType: string, refId: string): string {
  if (refType === 'note')        return '/think';
  if (refType === 'document')    return '/library';
  if (refType === 'task')        return '/plan';
  if (refType === 'discover_item' || refType === 'cfp_item') return '/discover';
  if (refType === 'spark')       return '/think';
  return `/my-work?highlight=${refId}`;
}

export const ConnectionsPanel: React.FC<ConnectionsPanelProps> = ({ refId, refType }) => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['connections', refId, refType],
    queryFn: () => api.getConnections(refId, refType),
    staleTime: 60_000,
  });

  const grouped = data?.success === true ? data.data : {};
  const totalCount = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);

  const orderedKeys = [
    ...EDGE_ORDER.filter((k) => k in grouped),
    ...Object.keys(grouped).filter((k) => !EDGE_ORDER.includes(k)),
  ];

  const handleItemClick = (edge: ConnectionEdge): void => {
    const route = routeForNode(edge.connectedNode.refType, edge.connectedNode.refId);
    void navigate(route);
  };

  return (
    <div className="conn-panel">
      <button
        className="conn-panel__header"
        onClick={() => { setCollapsed((v) => !v); }}
        aria-expanded={!collapsed ? 'true' : 'false'}
      >
        <span className="conn-panel__title">CONNECTIONS{totalCount > 0 ? ` · ${totalCount}` : ''}</span>
        <span className="conn-panel__chevron">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="conn-panel__body">
          {isLoading && <p className="conn-panel__loading">Loading connections…</p>}

          {!isLoading && totalCount === 0 && (
            <p className="conn-panel__empty">No connections yet</p>
          )}

          {orderedKeys.map((key) => (
            <ConnectionGroup
              key={key}
              edgeType={key}
              edges={grouped[key] ?? []}
              onItemClick={handleItemClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};
