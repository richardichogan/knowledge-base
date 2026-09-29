/**
 * components/athena/ChatSidebar.tsx — chat history sidebar for the
 * standalone Athena window (/chat).
 *
 * Chats are grouped Pinned / Today / Yesterday / Previous 7 days / Older,
 * can be pinned, renamed inline and deleted, and the always-visible search
 * matches titles, project names and (via the backend) message text.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@carbon/react';
import { Add, ChevronLeft, ChevronRight, Edit, Pin, PinFilled, Search, TrashCan } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { ChatSessionSummary } from '../../types';

interface ChatSidebarProps {
  sessions: ChatSessionSummary[];
  activeSessionId: string | null;
  projectNameById: Map<string, string>;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  onDelete: (id: string, e: React.MouseEvent) => void;
  /** Applies a local change to one session after a successful rename/pin. */
  onSessionPatched: (id: string, patch: Partial<ChatSessionSummary>) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isMobile: boolean;
  mobileOpen: boolean;
}

type GroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

const GROUP_LABELS: Record<GroupKey, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older',
};

const GROUP_ORDER: GroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older'];

/** Which date bucket a session falls into, by its last activity. */
function groupFor(session: ChatSessionSummary, now: Date): GroupKey {
  if (session.pinned === true) return 'pinned';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(session.updatedAt).getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfToday - 86_400_000) return 'yesterday';
  if (t >= startOfToday - 7 * 86_400_000) return 'week';
  return 'older';
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / "12 Aug". */
function formatSessionTime(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins.toString()}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours.toString()}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days.toString()}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  sessions,
  activeSessionId,
  projectNameById,
  onSelect,
  onNewChat,
  newChatDisabled,
  onDelete,
  onSessionPatched,
  collapsed,
  onToggleCollapsed,
  isMobile,
  mobileOpen,
}) => {
  const [query, setQuery] = useState('');
  const [serverMatches, setServerMatches] = useState<Set<string> | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Message-text search runs on the backend (debounced); titles and project
  // names are matched locally so results appear instantly while it runs.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setServerMatches(null); return undefined; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.searchChatSessions(q).then((r) => {
        if (!cancelled && r.success) setServerMatches(new Set(r.data.ids));
      }).catch(() => { /* local matching still applies */ });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.select();
  }, [renamingId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return sessions;
    return sessions.filter((s) => {
      const projectName = s.projectId !== null ? projectNameById.get(s.projectId) ?? '' : '';
      return s.title.toLowerCase().includes(q)
        || projectName.toLowerCase().includes(q)
        || serverMatches?.has(s.id) === true;
    });
  }, [sessions, query, serverMatches, projectNameById]);

  const groups = useMemo(() => {
    const now = new Date();
    const buckets = new Map<GroupKey, ChatSessionSummary[]>();
    for (const s of visible) {
      const key = groupFor(s, now);
      buckets.set(key, [...(buckets.get(key) ?? []), s]);
    }
    return GROUP_ORDER.filter((k) => buckets.has(k)).map((k) => ({ key: k, items: buckets.get(k)! }));
  }, [visible]);

  function startRename(s: ChatSessionSummary, e: React.MouseEvent): void {
    e.stopPropagation();
    setRenamingId(s.id);
    setRenameValue(s.title);
  }

  function commitRename(id: string): void {
    const title = renameValue.trim();
    setRenamingId(null);
    const current = sessions.find((s) => s.id === id);
    if (title === '' || current?.title === title) return;
    onSessionPatched(id, { title });
    void api.renameChatSession(id, title).catch(() => {
      if (current !== undefined) onSessionPatched(id, { title: current.title });
    });
  }

  function togglePin(s: ChatSessionSummary, e: React.MouseEvent): void {
    e.stopPropagation();
    const pinned = s.pinned !== true;
    onSessionPatched(s.id, { pinned });
    void api.setChatSessionPinned(s.id, pinned).catch(() => { onSessionPatched(s.id, { pinned: !pinned }); });
  }

  const className = [
    'kh-chat-sidebar',
    isMobile && mobileOpen ? 'kh-chat-sidebar--open' : '',
    !isMobile && collapsed ? 'kh-chat-sidebar--collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <aside className={className} aria-label="Chat history">
      <div className="kh-chat-sidebar__header">
        <Link to="/" className="kh-chat-sidebar__brand" title="Back to Athena home">
          <img src="/favicon.svg" alt="" className="kh-chat-sidebar__logo" />
          <span>Athena</span>
        </Link>
        {!isMobile && (
          <Button
            size="sm"
            kind="ghost"
            hasIconOnly
            renderIcon={collapsed ? ChevronRight : ChevronLeft}
            iconDescription={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            tooltipPosition="right"
            className="kh-chat-sidebar__collapse-btn"
            onClick={onToggleCollapsed}
          />
        )}
      </div>

      <nav className="kh-chat-sidebar__nav">
        <button type="button" className="kh-chat-sidebar__nav-item" onClick={onNewChat} disabled={newChatDisabled}>
          <Add className="kh-chat-sidebar__nav-icon" />
          New chat
        </button>
      </nav>

      <label className="kh-chat-sidebar__search">
        <Search className="kh-chat-sidebar__search-icon" aria-hidden="true" />
        <input
          type="search"
          className="kh-chat-sidebar__search-input"
          placeholder="Search chats and messages"
          aria-label="Search chats and messages"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
        />
      </label>

      <div className="kh-chat-sidebar__list">
        {sessions.length === 0 && (
          <p className="kh-chat-sidebar__empty">Your past chats with Athena will show up here.</p>
        )}
        {sessions.length > 0 && visible.length === 0 && (
          <p className="kh-chat-sidebar__empty">No chats match "{query}".</p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="kh-chat-sidebar__group" aria-label={GROUP_LABELS[group.key]}>
            <div className="kh-chat-sidebar__section-label">{GROUP_LABELS[group.key]}</div>
            {group.items.map((s) => {
              const projectName = s.projectId !== null ? projectNameById.get(s.projectId) ?? s.projectId : null;
              const isActive = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
                  className={`kh-chat-sidebar__item${isActive ? ' kh-chat-sidebar__item--active' : ''}`}
                  onClick={() => { if (renamingId !== s.id) onSelect(s.id); }}
                  role="button"
                  tabIndex={0}
                  aria-current={isActive ? 'true' : undefined}
                  onKeyDown={(e) => { if (e.key === 'Enter' && renamingId !== s.id) onSelect(s.id); }}
                >
                  <div className="kh-chat-sidebar__item-main">
                    {renamingId === s.id ? (
                      <input
                        ref={renameInputRef}
                        className="kh-chat-sidebar__rename-input"
                        aria-label="Chat name"
                        value={renameValue}
                        onClick={(e) => { e.stopPropagation(); }}
                        onChange={(e) => { setRenameValue(e.target.value); }}
                        onBlur={() => { commitRename(s.id); }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') commitRename(s.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    ) : (
                      <div className="kh-chat-sidebar__item-title" title={s.title}>{s.title}</div>
                    )}
                    <div className="kh-chat-sidebar__item-meta">
                      {projectName !== null && (
                        <span className="kh-chat-sidebar__project" title={projectName}>{projectName}</span>
                      )}
                      <span className="kh-chat-sidebar__item-time">{formatSessionTime(s.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="kh-chat-sidebar__item-actions">
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={s.pinned === true ? PinFilled : Pin}
                      iconDescription={s.pinned === true ? 'Unpin' : 'Pin to top'}
                      tooltipPosition="left"
                      className={`kh-chat-sidebar__item-action${s.pinned === true ? ' kh-chat-sidebar__item-action--on' : ''}`}
                      onClick={(e: React.MouseEvent) => { togglePin(s, e); }}
                    />
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={Edit}
                      iconDescription="Rename"
                      tooltipPosition="left"
                      className="kh-chat-sidebar__item-action"
                      onClick={(e: React.MouseEvent) => { startRename(s, e); }}
                    />
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={TrashCan}
                      iconDescription="Delete chat"
                      tooltipPosition="left"
                      className="kh-chat-sidebar__item-action"
                      onClick={(e: React.MouseEvent) => { onDelete(s.id, e); }}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
};
