/**
 * TaskPanel — slide-in right panel showing task details, activity log,
 * and linked notes/documents.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Close, Edit, TrashCan } from '@carbon/icons-react';
import { api } from '../services/api';
import { EntityLinks } from './connections/EntityLinks';

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
  return <section className="tp-section"><EntityLinks key={taskId} source={{ type: 'task', id: taskId }} /></section>;
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
