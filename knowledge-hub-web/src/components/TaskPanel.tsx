/**
 * TaskPanel — slide-in right panel showing task details, activity log,
 * and linked notes/documents.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Close, Edit, TrashCan, Document, Notebook } from '@carbon/icons-react';
import { api } from '../services/api';
import type { ContentItemSummary } from '../types/contentItem';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PanelTask {
  id: string;
  title: string;
  body: string;
  status: string;
  projectId: string;
  priority: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  recurringCadence: string | null;
  taxonomyTagIds: string[];
}

interface TaskNote {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
}

interface TaskLink {
  id: string;
  taskId: string;
  targetType: 'note' | 'document';
  targetId: string;
  targetTitle: string;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

const ActivityLog: React.FC<{ taskId: string }> = ({ taskId }) => {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data } = useQuery({
    queryKey: ['task-notes', taskId],
    queryFn: () => api.getTaskNotes(taskId),
    staleTime: 0,
  });

  const notes: TaskNote[] = (data as { success: boolean; data?: TaskNote[] } | undefined)?.success
    ? (data as { data: TaskNote[] }).data
    : [];

  const addNote = useMutation({
    mutationFn: (body: string) => api.addTaskNote(taskId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-notes', taskId] });
      setDraft('');
    },
  });

  return (
    <section className="tp-section">
      <h3 className="tp-section__heading">Activity</h3>

      {notes.length === 0 && (
        <p className="tp-empty">No notes yet.</p>
      )}

      <div className="tp-log">
        {notes.map((n) => (
          <div key={n.id} className="tp-log__entry">
            <span className="tp-log__time">{formatDateTime(n.createdAt)}</span>
            <p className="tp-log__body">{n.body}</p>
          </div>
        ))}
      </div>

      <div className="tp-add-note">
        <textarea
          ref={textareaRef}
          className="tp-add-note__input"
          placeholder="Add a note…"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
              addNote.mutate(draft.trim());
            }
          }}
        />
        <button
          className="tp-add-note__btn"
          disabled={!draft.trim() || addNote.isPending}
          onClick={() => { if (draft.trim()) addNote.mutate(draft.trim()); }}
        >
          {addNote.isPending ? 'Saving…' : 'Add note'}
        </button>
        <span className="tp-add-note__hint">⌘↵ to save</span>
      </div>
    </section>
  );
};

const LinkedItems: React.FC<{ taskId: string }> = ({ taskId }) => {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ContentItemSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: linksData } = useQuery({
    queryKey: ['task-links', taskId],
    queryFn: () => api.getTaskLinks(taskId),
    staleTime: 0,
  });

  const links: TaskLink[] = (linksData as { success: boolean; data?: TaskLink[] } | undefined)?.success
    ? (linksData as { data: TaskLink[] }).data
    : [];

  const addLink = useMutation({
    mutationFn: (link: { targetType: string; targetId: string; targetTitle: string }) =>
      api.addTaskLink(taskId, link),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-links', taskId] });
      setQuery('');
      setSearchResults([]);
    },
  });

  const removeLink = useMutation({
    mutationFn: (linkId: string) => api.removeTaskLink(taskId, linkId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['task-links', taskId] }),
  });

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setSearchResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.search({ q: query.trim(), pageSize: 8 });
        const items = (res as { success: boolean; data?: { items: ContentItemSummary[] } }).success
          ? (res as { data: { items: ContentItemSummary[] } }).data.items
          : [];
        setSearchResults(items);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [query]);

  const linkedIds = new Set(links.map((l) => l.targetId));

  return (
    <section className="tp-section">
      <h3 className="tp-section__heading">Linked items</h3>

      {links.length > 0 && (
        <div className="tp-links">
          {links.map((l) => (
            <div key={l.id} className="tp-link-chip">
              {l.targetType === 'note'
                ? <Notebook size={12} className="tp-link-chip__icon" />
                : <Document size={12} className="tp-link-chip__icon" />
              }
              <span className="tp-link-chip__title">{l.targetTitle || l.targetId}</span>
              <button
                className="tp-link-chip__remove"
                title="Remove link"
                onClick={() => removeLink.mutate(l.id)}
              >
                <Close size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="tp-link-search">
        <input
          className="tp-link-search__input"
          placeholder="Search notes and documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {searching && <span className="tp-link-search__hint">Searching…</span>}
        {searchResults.length > 0 && (
          <ul className="tp-link-results">
            {searchResults.map((item) => {
              const alreadyLinked = linkedIds.has(item.id);
              const targetType = item.source === 'note' ? 'note' : 'document';
              return (
                <li key={item.id} className={`tp-link-results__item${alreadyLinked ? ' tp-link-results__item--linked' : ''}`}>
                  {targetType === 'note'
                    ? <Notebook size={12} />
                    : <Document size={12} />
                  }
                  <span className="tp-link-results__title">{item.title}</span>
                  {!alreadyLinked && (
                    <button
                      className="tp-link-results__add"
                      onClick={() => addLink.mutate({ targetType, targetId: item.id, targetTitle: item.title })}
                    >
                      Link
                    </button>
                  )}
                  {alreadyLinked && <span className="tp-link-results__linked">Linked</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};

// ── TaskPanel ─────────────────────────────────────────────────────────────────

export const TaskPanel: React.FC<{
  task: PanelTask | null;
  onClose: () => void;
  onEdit: (task: PanelTask) => void;
  onDelete: (id: string) => void;
}> = ({ task, onClose, onEdit, onDelete }) => {
  // Trap focus when open
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (task) panelRef.current?.focus();
  }, [task?.id]);

  if (!task) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="tp-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="tp-panel"
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        {/* Header */}
        <div className="tp-header">
          <h2 className="tp-header__title">{task.title}</h2>
          <div className="tp-header__actions">
            <button className="tp-icon-btn" title="Edit task" onClick={() => onEdit(task)}>
              <Edit size={16} />
            </button>
            <button
              className="tp-icon-btn tp-icon-btn--danger"
              title="Delete task"
              onClick={() => { onDelete(task.id); onClose(); }}
            >
              <TrashCan size={16} />
            </button>
            <button className="tp-icon-btn" title="Close" onClick={onClose}>
              <Close size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="tp-body">
          {task.body && (
            <p className="tp-task-body">{task.body}</p>
          )}

          <ActivityLog taskId={task.id} />
          <LinkedItems taskId={task.id} />
        </div>
      </div>
    </>
  );
};
