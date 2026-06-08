/**
 * CanvasSidebar.tsx
 * Collapsible right-hand panel listing recent hub items.
 * Items can be clicked to add them as hub_ref nodes at canvas centre.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { Spark, DiscoverItem } from '../../services/api';

interface SidebarItem {
  id: string;
  refType: string;
  label: string;
  meta: string;
}

interface Props {
  onAddItem: (item: SidebarItem) => void;
}

function useHubItems(): { items: SidebarItem[]; isLoading: boolean } {
  const sparksQ = useQuery<Spark[]>({
    queryKey: ['canvas-sidebar-sparks'],
    queryFn: async () => {
      const r = await api.listSparks({ limit: 30 });
      return r.success && r.data ? r.data : [];
    },
    staleTime: 60_000,
  });

  const discoverQ = useQuery<DiscoverItem[]>({
    queryKey: ['canvas-sidebar-discover'],
    queryFn: async () => {
      const r = await api.getDiscoverFeed('saved', undefined, 1, 30);
      return r.success && r.data ? r.data.items : [];
    },
    staleTime: 60_000,
  });

  const items: SidebarItem[] = [
    ...(sparksQ.data ?? []).map((s: Spark) => ({
      id: s.id,
      refType: 'spark' as const,
      label: s.body.slice(0, 80),
      meta: 'Spark',
    })),
    ...(discoverQ.data ?? []).map((d: DiscoverItem) => ({
      id: d.id,
      refType: 'discover_item' as const,
      label: d.title ?? '(article)',
      meta: d.sourceTitle ?? 'Discover',
    })),
  ];

  return {
    items,
    isLoading: sparksQ.isLoading || discoverQ.isLoading,
  };
}

export const CanvasSidebar: React.FC<Props> = ({ onAddItem }) => {
  const [query, setQuery] = useState('');
  const { items, isLoading } = useHubItems();

  const filtered = query.trim()
    ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()))
    : items;

  return (
    <div className="cv-sidebar">
      <div className="cv-sidebar__header">
        <span className="cv-sidebar__title">Hub Items</span>
        <p className="cv-sidebar__hint">Click to add to canvas</p>
      </div>

      <div className="cv-sidebar__search">
        <Search size={14} />
        <input
          className="cv-sidebar__search-input"
          placeholder="Search…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
        />
      </div>

      <div className="cv-sidebar__list">
        {isLoading && <p className="cv-sidebar__loading">Loading…</p>}
        {!isLoading && filtered.length === 0 && (
          <p className="cv-sidebar__empty">No items found</p>
        )}
        {filtered.map((item) => (
          <button
            key={`${item.refType}-${item.id}`}
            className="cv-sidebar__item"
            onClick={() => { onAddItem(item); }}
          >
            <span className="cv-sidebar__item-type">{item.meta}</span>
            <span className="cv-sidebar__item-label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
