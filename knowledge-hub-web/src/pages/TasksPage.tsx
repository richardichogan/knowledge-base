/**
 * TasksPage — Kanban board.
 * Columns: Backlog | In Progress | Blocked | Awaiting Feedback | Completed
 */

import React, { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  InlineLoading, InlineNotification,
  Modal, TextInput, TextArea, Select, SelectItem,
} from '@carbon/react';
import { Add, Launch, OverflowMenuVertical } from '@carbon/icons-react';
import { api } from '../services/api';
import { PROJECTS } from '../config/projects';
import { useFlatTags } from '../hooks/useTaxonomy';
import { TagPicker } from '../components/TagPicker';
// ── Types ─────────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  projectId: string;
  tags: string[];
  priority: TaskPriority;
  dueDate: string | null;
  externalUrl: string | null;
  linkedTagId: string | null;
  taxonomyTagIds: string[];
  createdAt: string;
}

type TaskStatus = 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

// ── Config ────────────────────────────────────────────────────────────────────

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog',           label: 'Backlog' },
  { id: 'in-progress',       label: 'In Progress' },
  { id: 'blocked',           label: 'Blocked' },
  { id: 'awaiting-feedback', label: 'Awaiting Feedback' },
  { id: 'completed',         label: 'Completed' },
];

// Left-border colour per priority (like Linear)
const PRIORITY_BORDER: Record<TaskPriority, string> = {
  urgent: '#fa4d56',
  high:   '#f1c21b',
  normal: '#4589ff',
  low:    '#525252',
};

// Priority badge — shown for all priorities
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high:   'High',
  normal: 'Normal',
  low:    'Low',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getProjectName(id: string): string {
  return PROJECTS.find((p) => p.id === id)?.name ?? id;
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function isDueOverdue(iso: string): boolean {
  return new Date(iso) < new Date();
}

// ── Card overflow menu ────────────────────────────────────────────────────────

const CardMenu: React.FC<{
  task: Task;
  onMove: (s: TaskStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ task, onMove, onEdit, onDelete }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="kb-menu-anchor" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="kb-menu-trigger" title="Options" onClick={() => setOpen((v) => !v)}>
        <OverflowMenuVertical size={16} />
      </button>
      {open && (
        <ul className="kb-menu" role="menu">
          <li className="kb-menu__label">Move to</li>
          {COLUMNS.filter((c) => c.id !== task.status).map((c) => (
            <li key={c.id} role="menuitem">
              <button className="kb-menu__item" onClick={() => { onMove(c.id); setOpen(false); }}>
                {c.label}
              </button>
            </li>
          ))}
          <li className="kb-menu__sep" role="separator" />
          <li role="menuitem">
            <button className="kb-menu__item" onClick={() => { onEdit(); setOpen(false); }}>
              Edit
            </button>
          </li>
          {task.externalUrl != null && (
            <li role="menuitem">
              <a className="kb-menu__item" href={task.externalUrl} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                Open link&nbsp;<Launch size={12} />
              </a>
            </li>
          )}
          <li role="menuitem">
            <button className="kb-menu__item kb-menu__item--danger" onClick={() => { onDelete(); setOpen(false); }}>
              Delete
            </button>
          </li>
        </ul>
      )}
    </div>
  );
};

// ── Task card ─────────────────────────────────────────────────────────────────

const TaskCard: React.FC<{
  task: Task;
  onMove: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onEdit: (task: Task) => void;
}> = ({ task, onMove, onDelete, onEdit }) => {
  const [dragging, setDragging] = useState(false);
  const flatTags = useFlatTags();

  // Resolve taxonomy tag names from IDs
  const tagIds = task.taxonomyTagIds?.length ? task.taxonomyTagIds : [];
  const resolvedTags = tagIds
    .map((id) => flatTags.find((t) => t.id === id))
    .filter(Boolean) as { id: string; name: string; colour?: string }[];

  const priorityLabel = PRIORITY_LABEL[task.priority];
  return (
    <article
      className={`kb-card${dragging ? ' kb-card--dragging' : ''}`}
      style={{ borderTopColor: PRIORITY_BORDER[task.priority] }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('taskId', task.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => { setDragging(false); }}
      onClick={() => onEdit(task)}
    >
    <div className="kb-card__header">
      <span className="kb-card__title">{task.title}</span>
      <CardMenu
        task={task}
        onMove={(s) => onMove(task.id, s)}
        onEdit={() => onEdit(task)}
        onDelete={() => onDelete(task.id)}
      />
    </div>

    {task.body !== '' && <p className="kb-card__body">{task.body}</p>}

    {(resolvedTags.length > 0 || priorityLabel !== '') && (
      <div className="kb-card__tags">
        <span className={`kb-card__priority-pill kb-card__priority-pill--${task.priority}`}>
          {priorityLabel}
        </span>
        {resolvedTags.map((t) => (
          <span
            key={t.id}
            className="notes-list-tag-pill"
            style={t.colour ? { background: t.colour } : undefined}
          >
            {t.colour && <span className="notes-list-tag-pill-swatch" />}
            {t.name}
          </span>
        ))}
      </div>
    )}

    <div className="kb-card__footer">
      <span className="kb-card__project">{getProjectName(task.projectId)}</span>
      {task.dueDate != null && (
        <span className={`kb-card__due${isDueOverdue(task.dueDate) ? ' kb-card__due--late' : ''}`}>
          {formatDue(task.dueDate)}
        </span>
      )}
    </div>
    </article>
  );
};

// ── Create / Edit modal ───────────────────────────────────────────────────────

const TaskModal: React.FC<{
  open: boolean;
  initial: Task | null;
  defaultStatus: TaskStatus;
  onClose: () => void;
  onSave: (data: Partial<Task> & { title: string }) => void;
  saving: boolean;
  error: string | null;
}> = ({ open, initial, defaultStatus, onClose, onSave, saving, error }) => {
  const [title,       setTitle]       = useState('');
  const [body,        setBody]        = useState('');
  const [status,      setStatus]      = useState<TaskStatus>(defaultStatus);
  const [projectId,   setProjectId]   = useState('personal');
  const [priority,    setPriority]    = useState<TaskPriority>('normal');
  const [dueDate,     setDueDate]     = useState('');
  const [linkedTagIds, setLinkedTagIds] = useState<string[]>([]);

  const flatTags = useFlatTags();

  React.useEffect(() => {
    setTitle(initial?.title ?? '');
    setBody(initial?.body ?? '');
    setStatus(initial?.status ?? defaultStatus);
    setProjectId(initial?.projectId ?? 'personal');
    setPriority(initial?.priority ?? 'normal');
    setDueDate(initial?.dueDate ?? '');
    setLinkedTagIds(initial?.taxonomyTagIds?.length ? initial.taxonomyTagIds : initial?.linkedTagId ? [initial.linkedTagId] : []);
  }, [initial, open, defaultStatus]);

  return (
    <Modal
      open={open}
      modalHeading={initial != null ? 'Edit Task' : 'New Task'}
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (!title.trim()) return;
        onSave({
          title: title.trim(),
          body: body.trim(),
          status,
          projectId,
          priority,
          dueDate: dueDate || null,
          tags: [],
          taxonomyTagIds: linkedTagIds,
        });
      }}
      primaryButtonDisabled={saving || !title.trim()}
      size="sm"
    >
      <div className="kb-modal-form">
        {error != null && (
          <InlineNotification kind="error" title="Save failed" subtitle={error} lowContrast hideCloseButton />
        )}
        <TextInput id="t-title"   labelText="Title *"                value={title}     onChange={(e) => setTitle(e.target.value)} />
        <TextArea  id="t-body"    labelText="Notes"        rows={3}  value={body}      onChange={(e) => setBody(e.target.value)} />
        <Select    id="t-project" labelText="Project"                value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {PROJECTS.map((p) => <SelectItem key={p.id} value={p.id} text={p.name} />)}
        </Select>
        <Select    id="t-status"  labelText="Status"                 value={status}    onChange={(e) => setStatus(e.target.value as TaskStatus)}>
          {COLUMNS.map((c) => <SelectItem key={c.id} value={c.id} text={c.label} />)}
        </Select>
        <Select    id="t-pri"     labelText="Priority"               value={priority}  onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          <SelectItem value="urgent" text="Urgent" />
          <SelectItem value="high"   text="High" />
          <SelectItem value="normal" text="Normal" />
          <SelectItem value="low"    text="Low" />
        </Select>
        <TextInput id="t-due"     labelText="Due date"   type="date" value={dueDate}   onChange={(e) => setDueDate(e.target.value)} />

        {/* Tags — hierarchical tag picker */}
        <div className="kb-modal-form__field">
          <p className="kb-modal-form__label">Tags</p>
          <div className="kb-modal-tags">
            {linkedTagIds.length > 0 && flatTags.filter((t) => linkedTagIds.includes(t.id)).map((t) => (
              <span key={t.id} className="kb-modal-tags__chip kb-modal-tags__chip--active">
                {t.colour && <span className="kb-modal-tags__dot" style={{ background: t.colour }} />}
                {t.name}
              </span>
            ))}
            <TagPicker
              selectedIds={linkedTagIds}
              onChange={setLinkedTagIds}
              trigger={<button type="button" className="notes-tag-picker-trigger">+ Add tag</button>}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const TasksPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [modalOpen,     setModalOpen]     = useState(false);
  const [editTask,      setEditTask]      = useState<Task | null>(null);
  const [addStatus,     setAddStatus]     = useState<TaskStatus>('backlog');
  const [filterProject, setFilterProject] = useState('');

  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);

  const { data, isPending, isError } = useQuery({
    queryKey: ['tasks', filterProject],
    queryFn:  () => api.getTasks(filterProject ? { projectId: filterProject } : undefined),
    staleTime: 0,
  });

  const tasks: Task[] =
    (data as { success: boolean; data?: { items: Task[] } } | undefined)?.success === true
      ? (data as { data: { items: Task[] } }).data.items
      : [];

  const createMutation = useMutation({
    mutationFn: (input: Partial<Task> & { title: string }) => api.createTask(input as never),
    onSuccess:  () => { void queryClient.invalidateQueries({ queryKey: ['tasks'] }); setModalOpen(false); },
  });

  const [saveError, setSaveError] = useState<string | null>(null);

  // Separate mutations for editing (full save) vs drag-drop (status only)
  const updateMutation = useMutation({
    mutationFn: ({ id, ...input }: Partial<Task> & { id: string }) =>
      api.updateTask(id, input as Record<string, unknown>),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setSaveError(null);
      setModalOpen(false);
      setEditTask(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      console.error('[TasksPage] updateMutation error:', err);
    },
  });

  const moveTaskMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskStatus }) =>
      api.updateTask(id, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const prev = queryClient.getQueryData<unknown>(['tasks', filterProject]);
      queryClient.setQueryData(['tasks', filterProject], (old: unknown) => {
        const typed = old as { success: boolean; data: { items: Task[] } } | undefined;
        if (!typed?.success) return old;
        return { ...typed, data: { ...typed.data, items: typed.data.items.map((t) => t.id === id ? { ...t, status } : t) } };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(['tasks', filterProject], ctx.prev);
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['tasks'] }); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess:  () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  return (
    <div className="kb-page">

      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Tasks</h1>
        </div>
        <div className="page-controls">
          <Select
            id="kb-filter"
            labelText=""
            hideLabel
            size="sm"
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
          >
            <SelectItem value="" text="All projects" />
            {PROJECTS.map((p) => <SelectItem key={p.id} value={p.id} text={p.name} />)}
          </Select>
        </div>
      </div>

      {isPending && <InlineLoading description="Loading…" />}
      {isError   && <InlineNotification kind="error" title="Failed to load tasks" lowContrast />}

      <div className="kb-board">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.id);
          return (
            <div
              key={col.id}
              className={`kb-col${dragOverCol === col.id ? ' kb-col--drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.id); }}
              onDragLeave={() => { setDragOverCol(null); }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverCol(null);
                const taskId = e.dataTransfer.getData('taskId');
                if (taskId) { moveTaskMutation.mutate({ id: taskId, status: col.id }); }
              }}
            >

              <div className="kb-col__head">
                <span className="kb-col__name">{col.label}</span>
                {colTasks.length > 0 && (
                  <span className="kb-col__count">{colTasks.length}</span>
                )}
              </div>

              <div className="kb-col__cards">
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onMove={(id, s) => moveTaskMutation.mutate({ id, status: s })}
                    onDelete={(id) => deleteMutation.mutate(id)}
                    onEdit={(t) => { setEditTask(t); setModalOpen(true); }}
                  />
                ))}
              </div>

              <button
                className="kb-col__add"
                onClick={() => { setEditTask(null); setAddStatus(col.id); setModalOpen(true); }}
              >
                <Add size={16} />
                Add task
              </button>

            </div>
          );
        })}
      </div>

      <TaskModal
        open={modalOpen}
        initial={editTask}
        defaultStatus={addStatus}
        error={saveError}
        onClose={() => { setModalOpen(false); setEditTask(null); setSaveError(null); }}
        onSave={(input) => {
          setSaveError(null);
          if (editTask != null) {
            updateMutation.mutate({ id: editTask.id, ...input });
          } else {
            createMutation.mutate(input);
          }
        }}
        saving={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
};