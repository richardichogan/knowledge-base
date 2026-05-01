/**
 * TasksPage — Kanban board.
 * Columns: Backlog | In Progress | Blocked | Awaiting Feedback | Completed
 */

import React, { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';import {
  InlineLoading, InlineNotification,
  Modal, TextInput, TextArea, Select, SelectItem,
} from '@carbon/react';
import { Add, Launch, OverflowMenuVertical, Repeat, Upload } from '@carbon/icons-react';
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
  startDate: string | null;
  endDate: string | null;
  externalUrl: string | null;
  linkedTagId: string | null;
  taxonomyTagIds: string[];
  recurringCadence: 'daily' | 'weekly' | 'fortnightly' | 'monthly' | null;
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
      <div className="kb-card__footer-right">
        {task.recurringCadence != null && (
          <span className="kb-card__recur" title={`Repeats ${task.recurringCadence}`}>
            <Repeat size={12} />
          </span>
        )}
        {task.recurringCadence == null && task.dueDate != null && (
          <span className={`kb-card__due${isDueOverdue(task.dueDate) ? ' kb-card__due--late' : ''}`}>
            {formatDue(task.dueDate)}
          </span>
        )}
        {task.recurringCadence != null && task.startDate != null && (
          <span className={`kb-card__due${isDueOverdue(task.startDate) ? ' kb-card__due--late' : ''}`}>
            {formatDue(task.startDate)}
          </span>
        )}
      </div>
    </div>
    </article>
  );
};

// ── Task activity section (log + linked items) ────────────────────────────────

interface TaskNote { id: string; body: string; createdAt: string; }
interface TaskLink { id: string; targetType: string; targetId: string; targetTitle: string; targetUrl: string; }

const TaskActivitySection: React.FC<{ taskId: string }> = ({ taskId }) => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'activity' | 'linked'>('activity');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ id: string; title: string; source: string; url?: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: notesData } = useQuery({ queryKey: ['task-notes', taskId], queryFn: () => api.getTaskNotes(taskId), staleTime: 0 });
  const { data: linksData } = useQuery({ queryKey: ['task-links', taskId], queryFn: () => api.getTaskLinks(taskId), staleTime: 0 });

  const notes: TaskNote[] = (notesData as { success: boolean; data?: TaskNote[] } | undefined)?.success ? (notesData as { data: TaskNote[] }).data : [];
  const links: TaskLink[] = (linksData as { success: boolean; data?: TaskLink[] } | undefined)?.success ? (linksData as { data: TaskLink[] }).data : [];

  const addNote = useMutation({
    mutationFn: (body: string) => api.addTaskNote(taskId, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['task-notes', taskId] }); setDraft(''); },
  });

  const addLink = useMutation({
    mutationFn: (link: { targetType: string; targetId: string; targetTitle: string; targetUrl: string }) => api.addTaskLink(taskId, link),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['task-links', taskId] }); setSearch(''); setSearchResults([]); },
  });

  const removeLink = useMutation({
    mutationFn: (linkId: string) => api.removeTaskLink(taskId, linkId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['task-links', taskId] }),
  });

  const handleSearchChange = (val: string): void => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!val.trim()) { setSearchResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      const res = await api.search({ q: val.trim(), pageSize: 6 });
      const items = (res as { success: boolean; data?: { items: { id: string; title: string; source: string; url?: string }[] } }).success
        ? (res as { data: { items: { id: string; title: string; source: string; url?: string }[] } }).data.items : [];
      setSearchResults(items);
    }, 300);
  };

  const linkedIds = new Set(links.map((l) => l.targetId));

  return (
    <div className="kb-task-activity">
      <hr className="kb-task-activity__divider" />

      {/* Tab bar */}
      <div className="kb-task-activity__tabs">
        <button
          type="button"
          className={`kb-task-activity__tab${tab === 'activity' ? ' kb-task-activity__tab--active' : ''}`}
          onClick={() => setTab('activity')}
        >
          Activity {notes.length > 0 && <span className="kb-task-activity__tab-badge">{notes.length}</span>}
        </button>
        <button
          type="button"
          className={`kb-task-activity__tab${tab === 'linked' ? ' kb-task-activity__tab--active' : ''}`}
          onClick={() => setTab('linked')}
        >
          Linked items {links.length > 0 && <span className="kb-task-activity__tab-badge">{links.length}</span>}
        </button>
      </div>

      {/* Activity tab */}
      {tab === 'activity' && (
        <div className="kb-task-activity__panel">
          {notes.length > 0 && (
            <div className="kb-task-activity__log">
              {notes.map((n) => (
                <div key={n.id} className="kb-task-activity__entry">
                  <span className="kb-task-activity__time">
                    {new Date(n.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <p className="kb-task-activity__body">{n.body}</p>
                </div>
              ))}
            </div>
          )}
          <div className="kb-task-activity__add">
            <textarea
              className="kb-task-activity__input"
              placeholder="Add a note…"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className="kb-task-activity__btn"
              disabled={!draft.trim() || addNote.isPending}
              onClick={() => { if (draft.trim()) addNote.mutate(draft.trim()); }}
            >
              {addNote.isPending ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </div>
      )}

      {/* Linked items tab */}
      {tab === 'linked' && (
        <div className="kb-task-activity__panel">
          {links.length > 0 && (
            <ul className="kb-task-activity__link-list">
              {links.map((l) => (
                <li key={l.id} className="kb-task-activity__link-item">
                  <a
                    className="kb-task-activity__link-title"
                    href={l.targetUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {l.targetTitle || l.targetId}
                  </a>
                  <span className="kb-task-activity__link-type">{l.targetType}</span>
                  <button type="button" className="kb-task-activity__chip-remove" title="Remove link" onClick={() => removeLink.mutate(l.id)}>×</button>
                </li>
              ))}
            </ul>
          )}
          <input
            className="kb-task-activity__search"
            placeholder="Search notes and documents to link…"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {searchResults.length > 0 && (
            <ul className="kb-task-activity__results">
              {searchResults.map((item) => (
                <li key={item.id} className="kb-task-activity__result">
                  <span className="kb-task-activity__result-title">{item.title}</span>
                  {linkedIds.has(item.id)
                    ? <span className="kb-task-activity__result-linked">✓ Linked</span>
                    : <button
                        type="button"
                        className="kb-task-activity__result-btn"
                        onClick={() => addLink.mutate({ targetType: item.source === 'note' ? 'note' : 'document', targetId: item.id, targetTitle: item.title, targetUrl: item.url ?? '' })}
                      >Link</button>
                  }
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

// ── Podcast Import Modal ──────────────────────────────────────────────────────

interface ImportedTask {
  title: string;
  body: string;
  dueDate: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  projectId: string;
}

const PodcastImportModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onTasksCreated: () => void;
}> = ({ open, onClose, onTasksCreated }) => {
  const [step, setStep]         = useState<'upload' | 'review'>('upload');
  const [mdContent, setMdContent] = useState('');
  const [suggestions, setSuggestions] = useState<ImportedTask[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = (): void => {
    setStep('upload');
    setMdContent('');
    setSuggestions([]);
    setSelected(new Set());
    setGenerating(false);
    setSaving(false);
    setError(null);
  };

  const handleClose = (): void => { reset(); onClose(); };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setMdContent((ev.target?.result as string) ?? '');
    reader.readAsText(file);
  };

  const handleGenerate = async (): Promise<void> => {
    if (!mdContent.trim()) { setError('Please paste or upload show notes first.'); return; }
    setGenerating(true);
    setError(null);
    try {
      const res = await api.importTasks(mdContent, 'podcast');
      const typed = res as { success: boolean; data?: ImportedTask[] };
      if (!typed.success || !typed.data) throw new Error('No suggestions returned');
      setSuggestions(typed.data);
      setSelected(new Set(typed.data.map((_, i) => i)));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed — please try again');
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    const toCreate = suggestions.filter((_, i) => selected.has(i));
    if (toCreate.length === 0) { setError('Select at least one task to create.'); return; }
    setSaving(true);
    setError(null);
    try {
      for (const t of toCreate) {
        await api.createTask(t as never);
      }
      onTasksCreated();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tasks');
    } finally {
      setSaving(false);
    }
  };

  const toggleAll = (): void => {
    if (selected.size === suggestions.length) setSelected(new Set());
    else setSelected(new Set(suggestions.map((_, i) => i)));
  };

  return (
    <Modal
      open={open}
      modalHeading="Import Podcast Episode Tasks"
      primaryButtonText={step === 'upload' ? (generating ? 'Generating…' : 'Generate Tasks') : (saving ? 'Creating…' : `Create ${selected.size} task${selected.size !== 1 ? 's' : ''}`)}
      secondaryButtonText={step === 'review' ? 'Back' : 'Cancel'}
      primaryButtonDisabled={generating || saving || (step === 'upload' && !mdContent.trim())}
      onRequestClose={handleClose}
      onRequestSubmit={() => { void (step === 'upload' ? handleGenerate() : handleSave()); }}
      onSecondarySubmit={() => { if (step === 'review') { setStep('upload'); } else { handleClose(); } }}
      size="md"
    >
      <div className="kb-modal-form">
        {error && <InlineNotification kind="error" title="Error" subtitle={error} lowContrast hideCloseButton />}

        {step === 'upload' && (
          <>
            <p className="kb-import__hint">
              Upload or paste the show notes markdown for a podcast episode. The AI will generate all the tasks needed — show notes, socials, blog post and more.
            </p>
            <div className="kb-import__file-row">
              <input
                ref={fileRef}
                type="file"
                accept=".md,.txt"
                title="Upload show notes markdown file"
                className="kb-import__file-input"
                onChange={handleFile}
              />
              <button type="button" className="kb-import__file-btn" onClick={() => fileRef.current?.click()}>
                <Upload size={16} /> Upload .md file
              </button>
              {mdContent && <span className="kb-import__file-ok">✓ File loaded ({mdContent.split('\n').length} lines)</span>}
            </div>
            <TextArea
              id="import-md"
              labelText="Or paste show notes here"
              rows={10}
              value={mdContent}
              onChange={(e) => setMdContent(e.target.value)}
              placeholder="# Episode Title&#10;Date: 2026-05-05&#10;&#10;## Show Notes&#10;..."
            />
          </>
        )}

        {step === 'review' && (
          <>
            <div className="kb-import__review-header">
              <p className="kb-import__hint">Review the suggested tasks. Uncheck any you don&apos;t want to create.</p>
              <button type="button" className="kb-import__toggle-all" onClick={toggleAll}>
                {selected.size === suggestions.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <ul className="kb-import__task-list">
              {suggestions.map((t, i) => (
                <li
                  key={i}
                  className={`kb-import__task-item${selected.has(i) ? ' kb-import__task-item--selected' : ''}`}
                  onClick={() => setSelected((prev) => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s; })}
                >
                  <input
                    type="checkbox"
                    className="kb-import__task-check"
                    title={`Include task: ${t.title}`}
                    checked={selected.has(i)}
                    onChange={() => {}}
                  />
                  <div className="kb-import__task-content">
                    <div className="kb-import__task-title">{t.title}</div>
                    <div className="kb-import__task-meta">
                      <span className={`kb-import__task-priority kb-import__task-priority--${t.priority}`}>{t.priority}</span>
                      {t.dueDate && <span className="kb-import__task-due">Due {t.dueDate}</span>}
                    </div>
                    {t.body && <p className="kb-import__task-body">{t.body}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
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
  const [startDate,   setStartDate]   = useState('');
  const [endDate,     setEndDate]     = useState('');
  const [dueDate,     setDueDate]     = useState('');
  const [linkedTagIds, setLinkedTagIds] = useState<string[]>([]);
  const [recurringCadence, setRecurringCadence] = useState<string>('none');

  const flatTags = useFlatTags();

  React.useEffect(() => {
    setTitle(initial?.title ?? '');
    setBody(initial?.body ?? '');
    setStatus(initial?.status ?? defaultStatus);
    setProjectId(initial?.projectId ?? 'personal');
    setPriority(initial?.priority ?? 'normal');
    setStartDate(initial?.startDate ?? '');
    setEndDate(initial?.endDate ?? '');
    setDueDate(initial?.dueDate ?? '');
    setLinkedTagIds(initial?.taxonomyTagIds?.length ? initial.taxonomyTagIds : initial?.linkedTagId ? [initial.linkedTagId] : []);
    setRecurringCadence(initial?.recurringCadence ?? 'none');
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
          startDate: startDate || null,
          endDate: endDate || null,
          dueDate: dueDate || null,
          tags: [],
          taxonomyTagIds: linkedTagIds,
          recurringCadence: recurringCadence === 'none' ? null : recurringCadence as Task['recurringCadence'],
        });
      }}
      primaryButtonDisabled={saving || !title.trim()}
      size="md"
    >
      <div className="kb-modal-form">
        {error != null && (
          <InlineNotification kind="error" title="Save failed" subtitle={error} lowContrast hideCloseButton />
        )}

        {/* Title — full width */}
        <TextInput id="t-title" labelText="Title *" value={title} onChange={(e) => setTitle(e.target.value)} />

        {/* Notes — full width */}
        <TextArea id="t-body" labelText="Notes" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />

        {/* Project + Status — side by side */}
        <div className="kb-modal-form__row">
          <Select id="t-project" labelText="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {PROJECTS.map((p) => <SelectItem key={p.id} value={p.id} text={p.name} />)}
          </Select>
          <Select id="t-status" labelText="Status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            {COLUMNS.map((c) => <SelectItem key={c.id} value={c.id} text={c.label} />)}
          </Select>
        </div>

        {/* Priority + Repeats — side by side */}
        <div className="kb-modal-form__row">
          <Select id="t-pri" labelText="Priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            <SelectItem value="urgent" text="Urgent" />
            <SelectItem value="high"   text="High" />
            <SelectItem value="normal" text="Normal" />
            <SelectItem value="low"    text="Low" />
          </Select>
          <Select id="t-recur" labelText="Repeats" value={recurringCadence} onChange={(e) => setRecurringCadence(e.target.value)}>
            <SelectItem value="none"        text="Does not repeat" />
            <SelectItem value="daily"       text="Daily" />
            <SelectItem value="weekly"      text="Weekly" />
            <SelectItem value="fortnightly" text="Fortnightly" />
            <SelectItem value="monthly"     text="Monthly" />
          </Select>
        </div>

        {/* Dates — due date alone (half width) or start+end side by side */}
        {recurringCadence === 'none'
          ? <div className="kb-modal-form__row kb-modal-form__row--half-left">
              <TextInput id="t-due" labelText="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          : <div className="kb-modal-form__row">
              <TextInput id="t-start" labelText="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <TextInput id="t-end"   labelText="End date"   type="date" value={endDate}   onChange={(e) => setEndDate(e.target.value)} />
            </div>
        }

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

        {/* Activity log + linked items — only shown when editing an existing task */}
        {initial != null && (
          <TaskActivitySection taskId={initial.id} />
        )}
      </div>
    </Modal>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const TasksPage: React.FC<{ onImportOpen?: () => void; importOpen?: boolean; onImportClose?: () => void }> = ({ onImportOpen, importOpen: importOpenProp, onImportClose }) => {
  const queryClient = useQueryClient();
  const [modalOpen,      setModalOpen]      = useState(false);
  const [importOpenLocal, setImportOpenLocal] = useState(false);
  const importOpen = importOpenProp ?? importOpenLocal;
  const closeImport = (): void => { if (onImportClose) { onImportClose(); } else { setImportOpenLocal(false); } };
  const openImport = (): void => { if (onImportOpen) { onImportOpen(); } else { setImportOpenLocal(true); } };
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
          <button
            type="button"
            className="kb-import-btn"
            onClick={() => openImport()}
            title="Import tasks from a podcast episode"
          >
            <Upload size={16} /> Import episode
          </button>
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

      <PodcastImportModal
        open={importOpen}
        onClose={closeImport}
        onTasksCreated={() => void queryClient.invalidateQueries({ queryKey: ['tasks'] })}
      />

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