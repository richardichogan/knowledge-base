/**
 * CommandPalette — Cmd+K global search/navigation overlay.
 *
 * Sections: Main, grouped Tools, and existing knowledge-base search results.
 *
 * Opens on Cmd+K (Mac) / Ctrl+K (Win). Closes on Esc or backdrop click.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import {
  Document, Notebook, CheckmarkOutline, ArrowRight,
} from '@carbon/icons-react';
import { api } from '../services/api';
import { PRIMARY_DESTINATIONS, TOOL_GROUPS, type NavigationDestination } from '../navigation/destinations';

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

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigationAction?: ((item: NavigationDestination) => void) | undefined;
}

export const CommandPalette: React.FC<Props> = ({ open, onClose, onNavigationAction }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      const previousFocus = document.activeElement;
      const dialog = dialogRef.current;
      setQuery('');
      setActiveIndex(0);
      dialog?.showModal();
      inputRef.current?.focus();
      return () => {
        dialog?.close();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      };
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
  for (const group of [{ label: 'Main', items: PRIMARY_DESTINATIONS }, ...TOOL_GROUPS]) {
    const items = group.items.filter((item) =>
      (item.path !== undefined || onNavigationAction !== undefined) &&
      (query === '' || item.label.toLowerCase().includes(query.toLowerCase())),
    ).map((item) => ({
      id: `nav-${item.id}`, label: item.label,
      ...(item.description ? { sublabel: item.description } : {}),
      icon: <item.icon size={16} />,
      action: () => {
        if (item.path) go(item.path);
        else { onNavigationAction?.(item); onClose(); }
      },
    }));
    if (items.length > 0) sections.push({ title: group.label === 'Main' ? 'Main' : `Tools / ${group.label}`, items });
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
      e.stopPropagation();
      if (e.key === 'Tab') {
        const controls = [inputRef.current, ...Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          .filter((control): control is HTMLInputElement | HTMLButtonElement => control !== null);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        return;
      }
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, Math.min(i + 1, allItems.length - 1)));
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
    <dialog ref={dialogRef} className="cmd-backdrop" aria-label="Command palette"
      onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={onClose}>
      <div
        className="cmd-panel"
        onClick={(e) => { e.stopPropagation(); }}
        onKeyDown={handleKeyDown}
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
    </dialog>
  );
};
