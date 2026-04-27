/**
 * CommandPalette — Cmd+K global search/navigation overlay.
 *
 * Sections (in order):
 *   Navigation   — the 5 main routes
 *   Notes        — full-text search via /api/search?source=note
 *   Tasks        — tasks from local DB
 *   Documents    — /api/search?source=github-doc
 *
 * Opens on Cmd+K (Mac) / Ctrl+K (Win). Closes on Esc or backdrop click.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import {
  Compass, CalendarTools, Portfolio, Idea, Book,
  Document, Notebook, CheckmarkOutline, ArrowRight,
} from '@carbon/icons-react';
import { api } from '../services/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaletteItem {
  id: string;
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
  action: () => void;
}

interface PaletteSection {
  title: string;
  items: PaletteItem[];
}

// ── Nav items (static) ────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { path: '/discover', label: 'Discover', Icon: Compass },
  { path: '/plan',     label: 'Plan',     Icon: CalendarTools },
  { path: '/my-work',  label: 'My Work',  Icon: Portfolio },
  { path: '/think',    label: 'Think',    Icon: Idea },
  { path: '/library',  label: 'Library',  Icon: Book },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export const CommandPalette: React.FC<Props> = ({ open, onClose }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => { inputRef.current?.focus(); }, 30);
    }
  }, [open]);

  // Search results — only fire when query is non-empty
  const searchQuery = useQuery({
    queryKey: ['palette-search', query],
    queryFn: () => api.search({ q: query, pageSize: 8 }),
    enabled: query.trim().length >= 2,
    staleTime: 10_000,
  });

  const go = useCallback(
    (path: string) => {
      navigate(path);
      onClose();
    },
    [navigate, onClose],
  );

  // Build sections
  const sections: PaletteSection[] = [];

  // Nav section — always shown, filtered by query
  const navItems = NAV_ITEMS.filter(
    (n) => query === '' || n.label.toLowerCase().includes(query.toLowerCase()),
  ).map((n) => ({
    id: `nav-${n.path}`,
    label: n.label,
    icon: <n.Icon size={16} />,
    action: () => { go(n.path); },
  }));
  if (navItems.length > 0) {
    sections.push({ title: 'Navigate', items: navItems });
  }

  // Search results section
  if (query.trim().length >= 2) {
    const results = searchQuery.data?.success ? searchQuery.data.data.items : [];
    if (results.length > 0) {
      sections.push({
        title: 'Results',
        items: results.map((item) => ({
          id: `result-${item.id}`,
          label: item.title,
          sublabel: item.source,
          icon: item.source === 'note' ? <Notebook size={16} /> :
                item.source.startsWith('github') || item.source.startsWith('gitlab') ? <Document size={16} /> :
                <CheckmarkOutline size={16} />,
          action: () => {
            if (item.url) { window.open(item.url, '_blank', 'noreferrer'); }
            onClose();
          },
        })),
      });
    }
  }

  // Flatten all items for keyboard nav
  const allItems = sections.flatMap((s) => s.items);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, allItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        allItems[activeIndex]?.action();
      }
    },
    [allItems, activeIndex, onClose],
  );

  // Reset active index when results change
  useEffect(() => { setActiveIndex(0); }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  let globalIndex = 0;

  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <div
        className="cmd-panel"
        onClick={(e) => { e.stopPropagation(); }}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Input */}
        <div className="cmd-input-row">
          <ArrowRight size={16} className="cmd-input-icon" />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="Search or navigate…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            aria-label="Command palette search"
          />
          {searchQuery.isFetching && <InlineLoading className="cmd-loading" />}
          <kbd className="cmd-esc">esc</kbd>
        </div>

        {/* Results list */}
        <div className="cmd-list" ref={listRef}>
          {allItems.length === 0 && query.trim().length >= 2 && !searchQuery.isFetching && (
            <div className="cmd-empty">No results for &ldquo;{query}&rdquo;</div>
          )}
          {sections.map((section) => (
            <div key={section.title} className="cmd-section">
              <div className="cmd-section-title">{section.title}</div>
              {section.items.map((item) => {
                const idx = globalIndex++;
                return (
                  <button
                    key={item.id}
                    data-index={idx}
                    className={`cmd-item${activeIndex === idx ? ' cmd-item--active' : ''}`}
                    onClick={item.action}
                    onMouseEnter={() => { setActiveIndex(idx); }}
                  >
                    <span className="cmd-item-icon">{item.icon}</span>
                    <span className="cmd-item-label">{item.label}</span>
                    {item.sublabel !== undefined && (
                      <span className="cmd-item-sub">{item.sublabel}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="cmd-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
};
