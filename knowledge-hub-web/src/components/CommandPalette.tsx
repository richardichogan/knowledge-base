/**
 * CommandPalette — Cmd+K global search, actions and navigation overlay.
 *
 * Sections: Recent (empty query), Actions, Athena items (notes, projects,
 * sparks, diagrams, tasks, use cases, articles), Athena chats, library
 * sources, then Main and grouped Tools destinations.
 *
 * Opens on Cmd+K (Mac) / Ctrl+K (Win). Closes on Esc or backdrop click.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import {
  Document, Notebook, ArrowRight, Chat, ChatLaunch, Idea, Folder, ChartNetwork, Task, Catalog, Launch, Time,
} from '@carbon/icons-react';
import { api } from '../services/api';
import { PRIMARY_DESTINATIONS, TOOL_GROUPS, type NavigationDestination } from '../navigation/destinations';
import { settingsLinkState, settingsView } from '../navigation/settings';
import {
  PALETTE_KIND_LABELS, chatHref, isExternalHref, pushRecent, readRecent, type PaletteTarget,
} from './commandPaletteItems';

function kindIcon(kind: PaletteTarget['kind']): React.ReactNode {
  switch (kind) {
    case 'note': return <Notebook size={16} />;
    case 'project': return <Folder size={16} />;
    case 'spark': return <Idea size={16} />;
    case 'diagram': return <ChartNetwork size={16} />;
    case 'task': return <Task size={16} />;
    case 'usecase': return <Catalog size={16} />;
    case 'article': return <Launch size={16} />;
    case 'chat': return <Chat size={16} />;
    case 'source': return <Document size={16} />;
  }
}

function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

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
  onSparkCapture?: (() => void) | undefined;
  onAskAthena?: (() => void) | undefined;
}

export const CommandPalette: React.FC<Props> = ({ open, onClose, onNavigationAction, onSparkCapture, onAskAthena }) => {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<PaletteTarget[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      const previousFocus = document.activeElement;
      const dialog = dialogRef.current;
      setQuery('');
      setActiveIndex(0);
      setRecent(readRecent(browserStorage()));
      dialog?.showModal();
      inputRef.current?.focus();
      return () => {
        dialog?.close();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      };
    }
  }, [open]);

  const term = query.trim();
  const searching = term.length >= 2;
  const needle = term.toLowerCase();

  // All three searches only fire for 2+ characters and run in parallel.
  const entityQuery = useQuery({
    queryKey: ['palette-entities', term],
    queryFn: () => api.getLinkTargets(term),
    enabled: searching,
    staleTime: 10_000,
  });
  const chatQuery = useQuery({
    queryKey: ['palette-chats', term],
    queryFn: () => api.searchChatSessions(term),
    enabled: searching,
    staleTime: 10_000,
  });
  const searchQuery = useQuery({
    queryKey: ['palette-search', term],
    queryFn: () => api.search({ q: term, pageSize: 8 }),
    enabled: searching,
    staleTime: 10_000,
  });
  const fetching = entityQuery.isFetching || chatQuery.isFetching || searchQuery.isFetching;

  const go = useCallback(
    (path: string) => {
      const [pathname, search] = path.split('?');
      navigate(path, { state: pathname && settingsView(pathname, search) ? settingsLinkState(location) : undefined });
      onClose();
    },
    [navigate, onClose, location],
  );

  const openTarget = useCallback((target: PaletteTarget) => {
    setRecent(pushRecent(browserStorage(), target));
    if (isExternalHref(target.href)) {
      window.open(target.href, '_blank', 'noopener,noreferrer');
      onClose();
    } else {
      go(target.href);
    }
  }, [go, onClose]);

  const targetItem = (target: PaletteTarget, prefix: string): PaletteItem => ({
    id: `${prefix}-${target.kind}-${target.id}`,
    label: target.title,
    sublabel: PALETTE_KIND_LABELS[target.kind],
    icon: kindIcon(target.kind),
    action: () => { openTarget(target); },
  });

  // Build sections
  const sections: PaletteSection[] = [];

  if (!searching && recent.length > 0) {
    sections.push({ title: 'Recent', items: recent.map((target) => ({ ...targetItem(target, 'recent'), icon: <Time size={16} /> })) });
  }

  const actions: PaletteItem[] = [
    ...(onSparkCapture ? [{ id: 'action-spark', label: 'Capture a Spark', sublabel: 'Quick idea', icon: <Idea size={16} />,
      action: () => { onClose(); onSparkCapture(); } }] : []),
    ...(onAskAthena ? [{ id: 'action-athena', label: 'Ask Athena about this page', sublabel: 'Uses the current page', icon: <ChatLaunch size={16} />,
      action: () => { onClose(); onAskAthena(); } }] : []),
    { id: 'action-chat', label: 'Open Athena chats', sublabel: 'All conversations', icon: <Chat size={16} />, action: () => { go('/chat'); } },
    { id: 'action-think', label: 'Go to Think', sublabel: 'Notes and canvases', icon: <Notebook size={16} />, action: () => { go('/think'); } },
  ].filter((item) => !searching || item.label.toLowerCase().includes(needle));
  if (actions.length > 0) sections.push({ title: 'Actions', items: actions });

  if (searching) {
    const entities = entityQuery.data?.success ? entityQuery.data.data : [];
    if (entities.length > 0) {
      sections.push({ title: 'Athena items', items: entities.map((item) => targetItem({ kind: item.type, id: item.id, title: item.title, href: item.href }, 'item')) });
    }
    const chats = chatQuery.data?.success ? chatQuery.data.data.sessions ?? [] : [];
    if (chats.length > 0) {
      sections.push({ title: 'Athena chats', items: chats.slice(0, 6).map((chat) =>
        targetItem({ kind: 'chat', id: chat.id, title: chat.title || 'Untitled chat', href: chatHref(chat.id) }, 'chat')) });
    }
    // Notes are covered by Athena items; library entries without a link cannot be opened.
    const sources = (searchQuery.data?.success ? searchQuery.data.data.items : [])
      .filter((item) => item.source !== 'note' && typeof item.url === 'string' && item.url !== '');
    if (sources.length > 0) {
      sections.push({ title: 'Library', items: sources.map((item) => ({
        ...targetItem({ kind: 'source', id: item.id, title: item.title, href: item.url ?? '' }, 'source'),
        sublabel: item.source,
      })) });
    }
  }

  // Nav section — always shown, filtered by query
  for (const group of [{ label: 'Main', items: PRIMARY_DESTINATIONS }, ...TOOL_GROUPS]) {
    const items = group.items.filter((item) =>
      (item.path !== undefined || onNavigationAction !== undefined) &&
      (term === '' || item.label.toLowerCase().includes(needle)),
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
            placeholder="Search notes, projects, tasks, chats… or run an action"
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            aria-label="Command palette search"
          />
          {fetching && <InlineLoading className="cmd-loading" />}
          <kbd className="cmd-esc">esc</kbd>
        </div>

        {/* Results list */}
        <div className="cmd-list" ref={listRef}>
          {allItems.length === 0 && searching && !fetching && (
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
