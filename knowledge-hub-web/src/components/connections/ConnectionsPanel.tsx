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
  /** Omits the panel's own disclosure header when hosted by another one. */
  headerless?: boolean;
}

/** Edge type display order (top to bottom as per spec). */
const EDGE_ORDER = [
  'has_spark',
  'references',
  'tag_overlap',
  'thematically_related',
  'on_map',
];

/** Route to navigate to when a connected item is clicked. */
function routeForNode(refType: string, refId: string): string {
  if (refType === 'note')        return `/think?noteId=${encodeURIComponent(refId)}`;
  if (refType === 'document')    return '/library';
  if (refType === 'task')        return `/plan?taskId=${encodeURIComponent(refId)}`;
  if (refType === 'discover_item' || refType === 'cfp_item') return '/discover';
  if (refType === 'spark')       return '/think?view=sparks';
  if (refType === 'canvas')      return `/think?mapId=${refId}`;
  return `/my-work?highlight=${refId}`;
}

export const ConnectionsPanel: React.FC<ConnectionsPanelProps> = ({ refId, refType, headerless = false }) => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['connections', refId, refType],
    queryFn: async () => {
      const result = await api.getConnections(refId, refType);
      if (!result.success) throw new Error(result.error.message);
      return result;
    },
    staleTime: 60_000,
  });

  const grouped = data?.success === true ? data.data : {};
  const orderedKeys = [
    ...EDGE_ORDER.filter((k) => k in grouped),
    ...Object.keys(grouped).filter((k) => !EDGE_ORDER.includes(k)),
  // A note's maps are already listed above its connections (NoteMaps).
  ].filter((k) => !(refType === 'note' && k === 'on_map'));
  const totalCount = orderedKeys.reduce((sum, key) => sum + (grouped[key]?.length ?? 0), 0);

  const handleItemClick = (edge: ConnectionEdge): void => {
    const { refType: targetType, url } = edge.connectedNode;
    if (['discover_item', 'commit', 'pull_request', 'issue', 'github_item'].includes(targetType)
      && url && /^https?:\/\//i.test(url)) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const route = routeForNode(edge.connectedNode.refType, edge.connectedNode.refId);
    void navigate(route);
  };

  const body = (
    <div className="conn-panel__body">
      <p className="conn-panel__intro">Related notes, tasks, Discover items and GitHub activity, connected by shared context or an explicit link.</p>
      {isLoading && <p className="conn-panel__loading">Loading connections…</p>}

      {isError && <p className="conn-panel__error" role="alert">Could not load connections. <button type="button" onClick={() => { void refetch(); }}>Retry</button></p>}
      {!isLoading && !isError && totalCount === 0 && (
        <p className="conn-panel__empty">No meaningful connections found yet. Contextual suggestions are checked during the scheduled connection sync.</p>
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
  );

  if (headerless) return <div className="conn-panel conn-panel--headerless">{body}</div>;

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
      {!collapsed && body}
    </div>
  );
};
