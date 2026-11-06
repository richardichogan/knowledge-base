/**
 * TasksPage — the Plan's task views.
 * The Board groups projects into collapsible swim lanes across Backlog,
 * In Progress, Blocked, Waiting and Completed. Athena-created tasks wait in
 * the Inbox tray above until accepted or dismissed. Focus regroups open tasks
 * by what needs attention next.
 */

import React, { useRef, useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  InlineLoading, InlineNotification,
  Modal, TextInput, TextArea, Select, SelectItem,
} from '@carbon/react';
import { Add, ArrowRight, ChatLaunch, Checkmark, ChevronDown, Close, Edit, Launch, OverflowMenuVertical, Repeat, Upload } from '@carbon/icons-react';
import { api } from '../services/api';
import { useProjects, type ProjectRecord } from '../services/useProjects';
import { ProjectOptions } from '../components/ProjectOptions';
import { useUseCases } from '../hooks/useUseCases';
import { PRODUCT_KIND_LABELS, STAGE_LABELS, type UseCase } from '../types/useCases';
import { boardColumnForUseCase } from '../features/useCases/useCaseView';
import { TagPicker } from '../components/TagPicker';
import { EntityChip } from '../identity';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import { EntityLinks, useEntityRelationships } from '../components/connections/EntityLinks';
import type { PlanTask as Task, TaskStatus, TaskPriority, ChecklistItem } from '../types/task';
import { TaskChecklist } from '../features/plan/TaskChecklist';
import { FOCUS_GROUPS, focusDate, groupForFocus, isRecentlyCompleted, originHref, originLabel, taskHealth, RECENT_COMPLETED_DAYS, type FocusGroupId } from '../features/plan/taskInsights';
import { dateOnlyToLocal, localDateKey } from '../utils/dateOnly';
import { requireApiData, requireApiSuccess, describeApiError } from '../services/apiError';
import { DataNotice } from '../components/DataNotice';
import type { ApiSuccess, PaginatedList } from '../types/apiResponse';
import { TaskDetail } from '../features/plan/TaskDetail';
import { ReviewWorkspace } from '../components/ReviewWorkspace';
import { confirmDialog } from '../services/appDialogs';
import { TaskDescription } from '../components/TaskDescription';
// ── Types ─────────────────────────────────────────────────────────────────────

// ── Config ────────────────────────────────────────────────────────────────────

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog',     label: 'Backlog' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'blocked',     label: 'Blocked' },
  { id: 'waiting',     label: 'Waiting' },
  { id: 'completed',   label: 'Completed' },
];

interface WorkstreamLane {
  key: string;
  projectId: string | null;
  name: string;
  tasks: Map<TaskStatus, Task[]>;
  useCases: Map<TaskStatus, UseCase[]>;
  openCount: number;
  completedCount: number;
}

export type TasksView = 'board' | 'focus';

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high:   'High',
  normal: 'Normal',
  low:    'Low',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getProjectName(id: string, projects: ProjectRecord[]): string {
  return projects.find((p) => p.id === id)?.name ?? id;
}

function workstreamKey(projectId: string | null, projectName: string | null = null): string {
  if (projectId !== null && projectId !== '' && projectId !== 'personal') return `project:${projectId}`;
  const name = projectName?.trim();
  return name ? `name:${name.toLocaleLowerCase('en-GB')}` : 'unassigned';
}

function emptyWorkstreamLane(key: string, projectId: string | null, name: string): WorkstreamLane {
  return { key, projectId, name, tasks: new Map(), useCases: new Map(), openCount: 0, completedCount: 0 };
}

function addToGroup<T>(groups: Map<TaskStatus, T[]>, status: TaskStatus, item: T): void {
  groups.set(status, [...(groups.get(status) ?? []), item]);
}

function formatDue(iso: string): string {
  return dateOnlyToLocal(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function isDueOverdue(iso: string): boolean {
  return iso < localDateKey(new Date());
}

/** Legacy Blocked / Awaiting-feedback tasks were migrated with placeholder "waiting on" values. */
function waitingText(waitingOn: string | null | undefined): React.ReactNode {
  if (!waitingOn) return 'Waiting on: not set';
  if (waitingOn === 'Blocked') return 'Blocked';
  if (waitingOn === 'Feedback') return 'Waiting on feedback';
  return <>Waiting on <strong>{waitingOn}</strong></>;
}

// ── Card overflow menu ────────────────────────────────────────────────────────

const CardMenu: React.FC<{
  task: Task;
  busy: boolean;
  onMove: (s: TaskStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onAskAthena?: (() => void) | undefined;
}> = ({ task, busy, onMove, onEdit, onDelete, onAskAthena }) => {
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
      <button className="kb-menu-trigger" title="Options" disabled={busy} onClick={() => setOpen((v) => !v)}>
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
          {onAskAthena && (
            <li role="menuitem">
              <button className="kb-menu__item" onClick={() => { onAskAthena(); setOpen(false); }}>
                Ask Athena
              </button>
            </li>
          )}
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
  busy: boolean;
  selected?: boolean;
  projects: ProjectRecord[];
  onMove: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onEdit: (task: Task) => void;
  onSelect: (task: Task) => void;
  onAskAthena?: ((task: Task) => void) | undefined;
}> = ({ task, busy, selected = false, projects, onMove, onDelete, onEdit, onSelect, onAskAthena }) => {
  const [dragging, setDragging] = useState(false);

  const done = task.status === 'completed';
  const showPriority = !done && task.priority === 'urgent';
  const health = done ? null : taskHealth(task);
  const origin = task.origin ?? null;
  const originTo = origin ? originHref(origin) : null;
  return (
    <article
      className={`kb-card kh-priority--${task.priority}${dragging ? ' kb-card--dragging' : ''}${done ? ' kb-card--done' : ''}${selected ? ' kb-card--selected' : ''}`}
      title={done ? undefined : `${PRIORITY_LABEL[task.priority]} priority`}
      draggable={!busy}
      aria-busy={busy}
      onDragStart={(e) => {
        e.dataTransfer.setData('taskId', task.id);
        e.dataTransfer.setData('projectId', task.projectId);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => { setDragging(false); }}
      onClick={() => { if (!busy) onSelect(task); }}
    >
    <div className="kb-card__header">
      <button type="button" className="kb-card__title kb-card__select" disabled={busy}
        aria-pressed={selected}
        onClick={event => { event.stopPropagation(); onSelect(task); }}>{task.title}</button>
      <CardMenu
        task={task}
        busy={busy}
        onMove={(s) => onMove(task.id, s)}
        onEdit={() => onEdit(task)}
        onDelete={() => onDelete(task.id)}
        onAskAthena={onAskAthena ? () => onAskAthena(task) : undefined}
      />
    </div>

    {task.body !== '' && <TaskDescription className="kb-card__body" text={task.body} />}

    {task.status === 'waiting' && (
      <p className={`kb-card__waiting${task.waitingOn ? '' : ' kb-card__waiting--unset'}`}>
        {waitingText(task.waitingOn)}
      </p>
    )}

    {(showPriority || health) && (
      <div className="kb-card__tags">
        {showPriority && (
          <span className={`kb-card__priority-pill kb-card__priority-pill--${task.priority}`}>
            {PRIORITY_LABEL[task.priority]}
          </span>
        )}
        {health && (
          <span className={`kb-card__health kb-card__health--${health.kind}`} title={health.title}>{health.label}</span>
        )}
      </div>
    )}

    {origin && originTo && (
      <Link
        className="kb-card__origin"
        to={originTo}
        title={`Created from ${originLabel(origin)}`}
        onClick={(e) => { e.stopPropagation(); }}
        draggable={false}
      >
        {originLabel(origin)}
      </Link>
    )}

    <div className="kb-card__footer">
      <EntityChip projectId={task.projectId} fallbackLabel={getProjectName(task.projectId, projects)} className="kb-card__project" />
      <div className="kb-card__footer-right">
        {task.recurringCadence != null && (
          <span className="kb-card__recur" title={`Repeats ${task.recurringCadence}`}>
            <Repeat size={12} />
          </span>
        )}
        {task.recurringCadence == null && task.dueDate != null && (
          <span className={`kb-card__due${!done && isDueOverdue(task.dueDate) ? ' kb-card__due--late' : ''}`}>
            {formatDue(task.dueDate)}
          </span>
        )}
        {task.recurringCadence != null && task.startDate != null && (
          <span className={`kb-card__due${!done && isDueOverdue(task.startDate) ? ' kb-card__due--late' : ''}`}>
            {formatDue(task.startDate)}
          </span>
        )}
      </div>
    </div>
    </article>
  );
};

const UseCaseBoardCard: React.FC<{ useCase: UseCase }> = ({ useCase }) => (
  <Link
    className="kb-card kb-card--use-case"
    to={`/plan?view=use-cases&useCase=${encodeURIComponent(useCase.id)}`}
    aria-label={`Use case: ${useCase.title}; ${STAGE_LABELS[useCase.stage]}`}
    draggable={false}
  >
    <div className="kb-card__header">
      <span className="kb-card__title">{useCase.title}</span>
    </div>
    {useCase.summary !== '' && <p className="kb-card__body">{useCase.summary}</p>}
    <div className="kb-card__tags">
      <span className="kb-card__kind">Use case</span>
      <span className={`kh-uc-stage kh-uc-stage--${useCase.stage}`}>{STAGE_LABELS[useCase.stage]}</span>
    </div>
    <div className="kb-card__footer">
      <span className="kb-card__use-case-kind">{PRODUCT_KIND_LABELS[useCase.productKind]}</span>
      {useCase.projectName !== null && <span className="kb-card__project">{useCase.projectName}</span>}
    </div>
  </Link>
);

// ── Inbox tray ────────────────────────────────────────────────────────────────

const InboxTray: React.FC<{
  tasks: Task[];
  busyIds: Set<string>;
  projects: ProjectRecord[];
  onAccept: (task: Task) => void;
  onEdit: (task: Task) => void;
  onSelect: (task: Task) => void;
  onDismiss: (task: Task) => void;
}> = ({ tasks, busyIds, projects, onAccept, onEdit, onSelect, onDismiss }) => {
  const [collapsed, setCollapsed] = useState(false);
  if (tasks.length === 0) return null;
  return (
    <section className="kb-inbox" aria-label="Plan inbox">
      <header className="kb-inbox__head">
        <span className="kb-inbox__title">Inbox</span>
        <span className="kb-inbox__count">{tasks.length}</span>
        <span className="kb-inbox__hint">Suggested by Athena and meeting prep. Accept to add to your backlog, or dismiss.</span>
        <button type="button" className="kb-inbox__toggle" aria-expanded={!collapsed} onClick={() => { setCollapsed((v) => !v); }}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </header>
      {!collapsed && (
        <ul className="kb-inbox__list">
          {tasks.map((task) => {
            const busy = busyIds.has(task.id);
            const origin = task.origin ?? null;
            const originTo = origin ? originHref(origin) : null;
            return (
              <li key={task.id} className={`kb-inbox-card kh-priority--${task.priority}`} aria-busy={busy}>
                <button type="button" className="kb-inbox-card__title" disabled={busy} onClick={() => { onSelect(task); }}>{task.title}</button>
                {task.body !== '' && <TaskDescription className="kb-inbox-card__body" text={task.body} />}
                <p className="kb-inbox-card__meta">
                  <span>{getProjectName(task.projectId, projects)}</span>
                  {task.dueDate != null && (
                    <span className={isDueOverdue(task.dueDate) ? 'kb-inbox-card__due--late' : undefined}>Due {formatDue(task.dueDate)}</span>
                  )}
                  {origin && originTo && (
                    <Link className="kb-inbox-card__origin" to={originTo} title={`Created from ${originLabel(origin)}`}>{originLabel(origin)}</Link>
                  )}
                </p>
                <div className="kb-inbox-card__actions">
                  <button type="button" className="kb-inbox-card__btn kb-inbox-card__btn--primary" disabled={busy} onClick={() => { onAccept(task); }}>
                    <Checkmark size={16} /> Accept
                  </button>
                  <button type="button" className="kb-inbox-card__btn" disabled={busy} onClick={() => { onEdit(task); }}>
                    <Edit size={16} /> Edit
                  </button>
                  <button type="button" className="kb-inbox-card__btn" disabled={busy} title="Remove from Plan (archived, not deleted)" onClick={() => { onDismiss(task); }}>
                    <Close size={16} /> Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

// ── Focus view ────────────────────────────────────────────────────────────────

const FOCUS_COLUMNS: FocusGroupId[][] = [['overdue', 'week', 'next'], ['waiting', 'someday']];

const FocusRow: React.FC<{
  task: Task;
  busy: boolean;
  selected?: boolean;
  projects: ProjectRecord[];
  onComplete: (task: Task) => void;
  onEdit: (task: Task) => void;
  onAskAthena?: ((task: Task) => void) | undefined;
}> = ({ task, busy, selected = false, projects, onComplete, onEdit, onAskAthena }) => {
  const date = focusDate(task);
  const health = taskHealth(task);
  return (
    <li className={`kb-focus-row${selected ? ' kb-focus-row--selected' : ''}`} aria-busy={busy}>
      <span className={`kb-focus-row__bar kb-focus-row__bar--${task.priority}`} aria-hidden="true" />
      <button type="button" className="kb-focus-row__check" disabled={busy} title="Mark complete" aria-label={`Complete ${task.title}`}
        onClick={() => { onComplete(task); }}>
        <Checkmark size={16} />
      </button>
      <button type="button" className="kb-focus-row__main" disabled={busy} aria-pressed={selected} onClick={() => { onEdit(task); }}>
        <span className="kb-focus-row__title">{task.title}</span>
        <span className="kb-focus-row__meta">
          <span>{getProjectName(task.projectId, projects)}</span>
          {task.status === 'in-progress' && <span className="kb-focus-row__tag">In progress</span>}
          {task.status === 'blocked' && <span className="kb-focus-row__tag">Blocked</span>}
          {task.priority === 'urgent' || task.priority === 'high'
            ? <span className={`kb-focus-row__tag kb-focus-row__tag--${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span> : null}
          {date !== null && (
            <span className={isDueOverdue(date) ? 'kb-focus-row__due--late' : undefined}>
              {task.recurringCadence != null ? 'Next' : 'Due'} {formatDue(date)}
            </span>
          )}
          {task.status === 'waiting' && <span className="kb-focus-row__waiting">{waitingText(task.waitingOn)}</span>}
          {health && <span className={`kb-card__health kb-card__health--${health.kind}`} title={health.title}>{health.label}</span>}
        </span>
      </button>
      {onAskAthena && (
        <button type="button" className="kb-focus-row__athena" disabled={busy} title="Ask Athena about this task" aria-label={`Ask Athena about ${task.title}`}
          onClick={() => { onAskAthena(task); }}>
          <ChatLaunch size={16} />
        </button>
      )}
    </li>
  );
};

const FocusView: React.FC<{
  tasks: Task[];
  busyIds: Set<string>;
  selectedTaskId?: string | null;
  projects: ProjectRecord[];
  onComplete: (task: Task) => void;
  onEdit: (task: Task) => void;
  onAskAthena?: ((task: Task) => void) | undefined;
}> = ({ tasks, busyIds, selectedTaskId, projects, onComplete, onEdit, onAskAthena }) => {
  const groups = groupForFocus(tasks, localDateKey(new Date()));
  return (
    <div className="kb-focus">
      {FOCUS_COLUMNS.map((column, index) => {
        const sections = FOCUS_GROUPS.filter((g) => column.includes(g.id) && groups[g.id].length > 0);
        return (
          <div key={column.join('-')} className="kb-focus__col">
            {sections.length === 0 && (
              <p className="kb-focus__empty">{index === 0 ? 'Nothing due or in flight. Pick something from Someday.' : 'Nothing blocked or waiting, and no backlog.'}</p>
            )}
            {sections.map((group) => (
              <section key={group.id} className={`kb-focus__group kb-focus__group--${group.id}`} aria-label={group.label}>
                <header className="kb-focus__head">
                  <span className="kb-focus__name">{group.label}</span>
                  <span className="kb-focus__count">{groups[group.id].length}</span>
                  <span className="kb-focus__hint">{group.hint}</span>
                </header>
                <ul className="kb-focus__list">
                  {groups[group.id].map((task) => (
                    <FocusRow key={task.id} task={task} busy={busyIds.has(task.id)} selected={task.id === selectedTaskId} projects={projects}
                      onComplete={onComplete} onEdit={onEdit} onAskAthena={onAskAthena} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        );
      })}
    </div>
  );
};

// ── Task activity section (log + linked items) ────────────────────────────────

interface TaskNote {
  id: string; body: string; createdAt: string;
  activity?: { actor?: string; action?: string; from?: string; to?: string; proposedBy?: string; specialistId?: string; specialistName?: string } | null;
}
function isTaskNote(value: unknown): value is TaskNote {
  if (typeof value !== 'object' || value === null
    || !('id' in value) || typeof value.id !== 'string'
    || !('body' in value) || typeof value.body !== 'string'
    || !('createdAt' in value) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (!('activity' in value) || value.activity == null) return true;
  return typeof value.activity === 'object' && !Array.isArray(value.activity)
    && Object.entries(value.activity).every(([key, field]) =>
      !['actor', 'action', 'from', 'to', 'proposedBy', 'specialistId', 'specialistName'].includes(key) || typeof field === 'string');
}
const ACTIVITY_ACTIONS: Record<string, string> = {
  'status-changed': 'Status changed', 'note-added': 'Note added', 'research-refreshed': 'Research refreshed',
  'research-prepared': 'Research prepared', 'email-drafted': 'Email draft prepared',
  'task-prepared': 'Task preparation ready', 'email-sent-confirmed': 'Email sending confirmed', 'file-linked': 'File linked',
  'agent-assigned': 'Assigned to agent', 'agent-progress': 'Agent progress',
  'agent-waiting': 'Agent work pending', 'agent-blocked': 'Agent work blocked', 'agent-finished': 'Agent result ready',
};
const STATUS_LABELS: Record<string, string> = {
  inbox: 'Inbox', backlog: 'Backlog', 'in-progress': 'In progress', blocked: 'Blocked', waiting: 'Waiting', completed: 'Completed',
};

export function TaskNoteText({ text, noteLabel = 'Open note in Think' }: { text: string; noteLabel?: string }): React.ReactElement {
  const parts = text.split(/(\/think\?note(?:Id)?=[0-9a-f-]{36}|https?:\/\/[^\s<>]+)/gi);
  return <>{parts.map((part, index) => {
    if (/^\/think\?note(?:Id)?=[0-9a-f-]{36}$/i.test(part)) {
      return <Link key={index} className="kb-task-activity__content-link" to={part}>{noteLabel}</Link>;
    }
    if (/^https?:\/\//i.test(part)) {
      const href = part.replace(/[.,;!?)]+$/, '');
      return <React.Fragment key={index}><a className="kb-task-activity__content-link" href={href} target="_blank" rel="noreferrer">Open source link</a>{part.slice(href.length)}</React.Fragment>;
    }
    return part;
  })}</>;
}

export const TaskActivitySection: React.FC<{ taskId: string }> = ({ taskId }) => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'activity' | 'linked'>('activity');
  const [draft, setDraft] = useState('');

  const notesQuery = useQuery({ queryKey: ['task-notes', taskId, 'validated-activity'], queryFn: async () => {
    const data = requireApiData(await api.getTaskNotes(taskId));
    if (!Array.isArray(data) || !data.every(isTaskNote)) throw new Error('Task activity returned invalid data. Refresh to retry.');
    return data;
  }, staleTime: 0 });
  const { data: links = [] } = useEntityRelationships({ type: 'task', id: taskId });

  const notes: TaskNote[] = [...(notesQuery.data ?? [])]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const addNote = useMutation({
    mutationFn: async (body: string) => requireApiData(await api.addTaskNote(taskId, body)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['task-notes', taskId] }); setDraft(''); },
  });


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
          {notesQuery.isPending && <p className="kb-task-activity__message" role="status">Loading activity...</p>}
          {notesQuery.error && <DataNotice title="Activity could not load" error={notesQuery.error} onRetry={() => { void notesQuery.refetch(); }} />}
          {notesQuery.isSuccess && notes.length === 0 && <p className="kb-task-activity__message">No activity yet. Add a note to record progress.</p>}
          {notes.length > 0 && (
            <div className="kb-task-activity__log">
              {notes.map((n) => {
                const transition = /^Status: ([^\n]+)\n\n/.exec(n.body);
                const text = transition ? n.body.slice(transition[0].length) : n.body;
                const legacyStatuses = transition?.[1]?.split(' -> ');
                const from = n.activity?.from ?? legacyStatuses?.[0];
                const to = n.activity?.to ?? legacyStatuses?.[1];
                const actor = n.activity?.proposedBy === 'athena' && n.activity.actor === 'richard'
                  ? 'Athena proposed · Richard confirmed'
                  : n.activity?.actor === 'richard' ? 'Richard'
                    : n.activity?.actor === 'athena'
                      ? n.activity.specialistId === 'task-email-drafter' ? 'Hermes · Email draft assistant' : 'Athena'
                      : n.activity?.actor === 'system' ? 'System' : 'Earlier activity';
                return (
                <div key={n.id} className="kb-task-activity__entry">
                  <div className="kb-task-activity__entry-header">
                    <span className="kb-task-activity__actor">{actor}</span>
                  <time className="kb-task-activity__time" dateTime={new Date(n.createdAt).toISOString()}>
                    {new Date(n.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </time>
                  </div>
                  {(n.activity?.action || from && to) && <div className="kb-task-activity__action">
                    <span>{ACTIVITY_ACTIONS[n.activity?.action ?? ''] ?? 'Status changed'}</span>
                    {from && to && <span className="kb-task-activity__transition" aria-label={`${STATUS_LABELS[from] ?? from} to ${STATUS_LABELS[to] ?? to}`}>
                      <span className="kb-task-activity__status">{STATUS_LABELS[from] ?? from}</span>
                      <ArrowRight size={16} aria-hidden="true" />
                      <span className={`kb-task-activity__status kb-task-activity__status--${Object.hasOwn(STATUS_LABELS, to) ? to : 'backlog'}`}>{STATUS_LABELS[to] ?? to}</span>
                    </span>}
                  </div>}
                  <p className="kb-task-activity__body"><TaskNoteText text={text} noteLabel={n.activity?.action === 'email-drafted' ? 'Open email draft in Think' : 'Open note in Think'} /></p>
                </div>
                );
              })}
            </div>
          )}
          <div className="kb-task-activity__add">
            <label className="kb-task-activity__field" htmlFor={`task-note-${taskId}`}>New note
            <textarea
              id={`task-note-${taskId}`}
              className="kb-task-activity__input"
              placeholder="Add a note…"
              rows={2}
              value={draft}
              maxLength={3000}
              disabled={addNote.isPending}
              onChange={(e) => setDraft(e.target.value)}
            />
            </label>
            <button
              type="button"
              className="kb-task-activity__btn"
              disabled={!draft.trim() || addNote.isPending}
              onClick={() => { if (draft.trim()) addNote.mutate(draft.trim()); }}
            >
              {addNote.isPending ? 'Saving…' : 'Add note'}
            </button>
          </div>
          {addNote.error && <p className="kb-task-activity__error" role="alert">{describeApiError(addNote.error)}</p>}
        </div>
      )}

      {/* Linked items tab */}
      {tab === 'linked' && (
        <div className="kb-task-activity__panel">
          <EntityLinks key={taskId} source={{ type: 'task', id: taskId }} />
        </div>
      )}
    </div>
  );
};

// ── Task Import Modal ─────────────────────────────────────────────────────────

type ImportDocType = 'podcast' | 'meeting' | 'general';

const DOC_TYPE_OPTIONS: { value: ImportDocType; label: string; hint: string; placeholder: string }[] = [
  {
    value: 'podcast',
    label: 'Podcast episode plan',
    hint: 'Upload the marketing plan for a podcast episode. The AI will extract all the tasks needed to publish and promote it — show notes, social posts, blog post etc.',
    placeholder: '# Episode Title\nDate: 2026-05-07\n\n## Show Notes\n...',
  },
  {
    value: 'meeting',
    label: 'Meeting transcript / notes',
    hint: 'Upload a meeting transcript or notes. The AI will identify every action item, owner and due date mentioned.',
    placeholder: '# Meeting: Project Kick-off\nDate: 2026-05-07\n\nAttendees: ...\n\n## Actions\n- Richard to review the proposal by Friday\n...',
  },
  {
    value: 'general',
    label: 'General document',
    hint: 'Upload any markdown document. The AI will extract everything that looks like a task, action item or to-do.',
    placeholder: '# My Document\n\n- [ ] Task one\n- Action item two\n...',
  },
];

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
  const [step, setStep]           = useState<'upload' | 'review'>('upload');
  const [docType, setDocType]     = useState<ImportDocType>('podcast');
  const [mdContent, setMdContent] = useState('');
  const [suggestions, setSuggestions] = useState<ImportedTask[]>([]);
  const [selected, setSelected]   = useState<Set<number>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = (): void => {
    setStep('upload');
    setDocType('podcast');
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
    if (!mdContent.trim()) { setError('Please paste or upload a markdown file first.'); return; }
    setGenerating(true);
    setError(null);
    try {
      const res = await api.importTasks(mdContent, docType);
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
      modalHeading="Import Tasks from Markdown"
      primaryButtonText={step === 'upload' ? (generating ? 'Extracting…' : 'Extract Tasks') : (saving ? 'Creating…' : `Create ${selected.size} task${selected.size !== 1 ? 's' : ''}`)}
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
            {/* Document type selector */}
            <div className="kb-import__type-row">
              {DOC_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`kb-import__type-btn${docType === opt.value ? ' kb-import__type-btn--active' : ''}`}
                  onClick={() => { setDocType(opt.value); setMdContent(''); }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="kb-import__hint">
              {DOC_TYPE_OPTIONS.find((o) => o.value === docType)?.hint}
            </p>
            <div className="kb-import__file-row">
              <input
                ref={fileRef}
                type="file"
                accept=".md,.txt"
                title="Upload markdown file"
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
              labelText="Or paste markdown here"
              rows={10}
              value={mdContent}
              onChange={(e) => setMdContent(e.target.value)}
              placeholder={DOC_TYPE_OPTIONS.find((o) => o.value === docType)?.placeholder ?? ''}
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

export type TaskEditorInput = Partial<Task> & {
  title: string;
  statusChangeNote?: string;
  expectedStatus?: TaskStatus;
};

interface TaskEditorProps {
  open: boolean;
  initial: Task | null;
  defaultStatus: TaskStatus;
  defaultProjectId?: string;
  projects: ProjectRecord[];
  onClose: () => void;
  onSave: (data: TaskEditorInput) => void;
  saving: boolean;
  error: string | null;
}

export const TaskEditor: React.FC<TaskEditorProps & { inline?: boolean }> = ({
  open, initial, defaultStatus, defaultProjectId = 'personal', projects, onClose, onSave, saving, error, inline = false,
}) => {
  const [title,       setTitle]       = useState('');
  const [body,        setBody]        = useState('');
  const [status,      setStatus]      = useState<TaskStatus>(defaultStatus);
  const [projectId,   setProjectId]   = useState(defaultProjectId);
  const [priority,    setPriority]    = useState<TaskPriority>('normal');
  const [startDate,   setStartDate]   = useState('');
  const [endDate,     setEndDate]     = useState('');
  const [dueDate,     setDueDate]     = useState('');
  const [linkedTagIds, setLinkedTagIds] = useState<string[]>([]);
  const [recurringCadence, setRecurringCadence] = useState<string>('none');
  const [waitingOn, setWaitingOn] = useState('');
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [statusChangeNote, setStatusChangeNote] = useState('');
  const statusChanged = inline && initial != null && status !== initial.status;
  const canSave = !saving && Boolean(title.trim()) && (!statusChanged || Boolean(statusChangeNote.trim()));
  const statusOptions = initial?.status === 'inbox' ? [{ id: 'inbox' as const, label: 'Inbox' }, ...COLUMNS] : COLUMNS;

  React.useEffect(() => {
    setTitle(initial?.title ?? '');
    setBody(initial?.body ?? '');
    setStatus(initial?.status ?? defaultStatus);
    setProjectId(initial?.projectId ?? defaultProjectId);
    setPriority(initial?.priority ?? 'normal');
    setStartDate(initial?.startDate ?? '');
    setEndDate(initial?.endDate ?? '');
    setDueDate(initial?.dueDate ?? '');
    setLinkedTagIds(initial?.taxonomyTagIds?.length ? initial.taxonomyTagIds : initial?.linkedTagId ? [initial.linkedTagId] : []);
    setRecurringCadence(initial?.recurringCadence ?? 'none');
    setWaitingOn(initial?.waitingOn ?? '');
    setChecklist(initial?.checklist ?? []);
    setStatusChangeNote('');
  }, [initial, open, defaultStatus, defaultProjectId]);

  const submit = (): void => {
    if (!canSave) return;
    onSave({
      title: title.trim(),
      body: body.trim(),
      status,
      ...(status === 'waiting' || initial?.waitingOn ? { waitingOn: status === 'waiting' ? waitingOn.trim() || null : null } : {}),
      projectId,
      priority,
      task_type: initial?.task_type ?? 'standard',
      startDate: startDate || null,
      endDate: endDate || null,
      dueDate: dueDate || null,
      tags: inline ? initial?.tags ?? [] : [],
      taxonomyTagIds: linkedTagIds,
      recurringCadence: recurringCadence === 'none' ? null : recurringCadence as Task['recurringCadence'],
      ...(inline || checklist.length > 0 ? { checklist } : {}),
      ...(inline && initial ? { expectedStatus: initial.status, statusChangeNote: statusChanged ? statusChangeNote.trim() : '' } : {}),
    });
  };
  const fields = (
      <fieldset className="kb-modal-form" disabled={saving} aria-label="Task fields">
        {error != null && (
          <InlineNotification kind="error" title="Save failed" subtitle={error} lowContrast hideCloseButton />
        )}

        {/* Title — full width */}
        <TextInput id="t-title" labelText="Title *" value={title} onChange={(e) => setTitle(e.target.value)} />

        {/* Notes — full width */}
        <TextArea id="t-body" labelText={inline ? 'Description' : 'Notes'} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />

        {inline && <TaskChecklist editable idPrefix="t-check" items={checklist} onChange={setChecklist} />}

        {/* Project + Status — side by side */}
        <div className="kb-modal-form__row">
          <Select id="t-project" labelText="Workstream" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projectId !== '' && !projects.some(project => project.id === projectId)
              && <SelectItem value={projectId} text={`Unavailable workstream: ${projectId}`} />}
            <ProjectOptions projects={projects} selected={projectId} />
          </Select>
          <Select id="t-status" labelText="Status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            {statusOptions.map((c) => <SelectItem key={c.id} value={c.id} text={c.label} />)}
          </Select>
        </div>

        {statusChanged && <TextArea id="t-status-note" labelText="Status change message *" rows={3}
          maxLength={3000} required value={statusChangeNote}
          helperText="This message and the stage change are saved together in the task's timestamped activity."
          onChange={event => { setStatusChangeNote(event.target.value); }} />}

        {status === 'waiting' && (
          <TextInput id="t-waiting-on" labelText="Waiting on" placeholder="Who or what, e.g. Feedback from Sarah"
            value={waitingOn} onChange={(e) => setWaitingOn(e.target.value)} />
        )}

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
        {(inline || recurringCadence === 'none') && <div className="kb-modal-form__row kb-modal-form__row--half-left">
          <TextInput id="t-due" labelText="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>}
        {recurringCadence !== 'none' && <div className="kb-modal-form__row">
          <TextInput id="t-start" labelText="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <TextInput id="t-end"   labelText="End date"   type="date" value={endDate}   onChange={(e) => setEndDate(e.target.value)} />
        </div>}

        {/* Tags — hierarchical tag picker */}
        <div className="kb-modal-form__field">
          <p className="kb-modal-form__label">Tags</p>
          <div className="kb-modal-tags">
            {linkedTagIds.map((id) => <EntityChip key={id} tagId={id} size="md" />)}
            <TagPicker
              selectedIds={linkedTagIds}
              disabled={saving}
              onChange={setLinkedTagIds}
              trigger={<button type="button" className="notes-tag-picker-trigger" disabled={saving}>+ Add tag</button>}
            />
          </div>
        </div>

        {/* Activity log + linked items — only shown when editing an existing task */}
        {!inline && initial != null && (
          <TaskActivitySection taskId={initial.id} />
        )}

        {!inline && initial != null && (
          <ConnectionsPanel refId={initial.id} refType="task" />
        )}
      </fieldset>
  );
  if (inline) return <form className="kh-task-detail__editor" aria-label="Edit task"
    onSubmit={event => { event.preventDefault(); submit(); }}>
    <h3>Edit task</h3>
    {fields}
    <div className="kh-task-detail__actions">
      <button type="submit" className="dc-explore__primary" disabled={!canSave}>{saving ? 'Saving...' : 'Save task'}</button>
      <button type="button" className="dc-explore__action" disabled={saving} onClick={onClose}>Cancel</button>
    </div>
  </form>;
  return (
    <Modal
      open={open}
      modalHeading={initial != null ? 'Edit Task' : 'New Task'}
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      onRequestClose={() => { if (!saving) onClose(); }}
      onRequestSubmit={submit}
      primaryButtonDisabled={!canSave}
      size="md"
    >
      {fields}
    </Modal>
  );
};

export const TaskModal: React.FC<TaskEditorProps> = props => <TaskEditor {...props} />;

// ── Page ──────────────────────────────────────────────────────────────────────

export const TasksPage: React.FC<{
  importOpen: boolean;
  onImportClose: () => void;
  filterProject: string;
  filterTag: string;
  view?: TasksView;
  onAskAthena?: (prompt: string) => void;
}> = ({ importOpen, onImportClose, filterProject, filterTag, view = 'board' }) => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalOpen,      setModalOpen]      = useState(false);
  const [editTask,      setEditTask]      = useState<Task | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addStatus,     setAddStatus]     = useState<TaskStatus>('backlog');
  const [addProjectId, setAddProjectId] = useState('personal');
  const [showOlderDone, setShowOlderDone] = useState(false);
  const [collapsedWorkstreams, setCollapsedWorkstreams] = useState<Record<string, boolean>>({});
  const { projects } = useProjects();
  const { data: useCases = [], isPending: useCasesPending, error: useCasesError, refetch: refetchUseCases } = useUseCases();

  const [dragOverWorkstreamCell, setDragOverWorkstreamCell] = useState<string | null>(null);

  const { data, isPending, isError, error: loadError, refetch } = useQuery({
    queryKey: ['tasks', filterProject],
    queryFn: async () => requireApiSuccess(await api.getTasks(filterProject ? { projectId: filterProject } : undefined)),
    staleTime: 0,
  });

  const tasks: Task[] = data?.success === true ? data.data.items : [];
  const selectedDetail = useQuery({
    queryKey: ['task-assistance', selectedTaskId],
    queryFn: async () => {
      if (selectedTaskId === null) throw new Error('Select a task before loading its details.');
      return requireApiData(await api.getTaskAssistance(selectedTaskId));
    },
    enabled: false,
  });
  const scopedTasks = filterTag ? tasks.filter((t) => t.taxonomyTagIds?.includes(filterTag)) : tasks;
  const inboxTasks = scopedTasks.filter((t) => t.status === 'inbox');

  // View-task links open the shared details; editing remains an explicit action.
  useEffect(() => {
    const linkedId = searchParams.get('taskId');
    if (linkedId === null) return;
    setSelectedTaskId(linkedId);
    searchParams.delete('taskId');
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, searchParams]);

  const savePending = useRef(false);
  const createMutation = useMutation({
    mutationFn: async (input: Partial<Task> & { title: string }) => requireApiData(await api.createTask(input)),
    onSuccess: task => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setModalOpen(false);
      if (task.assistanceStatus === 'failed') setSaveError('Task created, but Athena could not queue its help proposal. Open the task and choose Help me to retry.');
    },
    onError: (error) => { setSaveError(describeApiError(error)); },
    onSettled: () => { savePending.current = false; },
  });

  const [saveError, setSaveError] = useState<string | null>(null);
  const taskActions = useRef(new Set<string>());
  const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(() => new Set());
  function beginTaskAction(id: string): boolean {
    if (taskActions.current.has(id)) return false;
    taskActions.current.add(id);
    setBusyTaskIds(new Set(taskActions.current));
    setSaveError(null);
    return true;
  }
  function finishTaskAction(id: string): void {
    taskActions.current.delete(id);
    setBusyTaskIds(new Set(taskActions.current));
  }

  // Separate mutations for editing (full save) vs drag-drop (status only)
  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: Partial<Task> & { id: string }) =>
      requireApiData(await api.updateTask(id, input)),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task-assistance', saved.id] });
      setSaveError(saved.assistanceStatus === 'failed'
        ? 'Task saved, but Athena could not queue its help proposal. Open the task and choose Help me to retry.' : null);
      setModalOpen(false);
      setEditTask(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      console.error('[TasksPage] updateMutation error:', err);
    },
    onSettled: () => { savePending.current = false; },
  });

  const moveTaskMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: TaskStatus }) =>
      requireApiData(await api.updateTask(id, { status })),
    onMutate: async ({ id }) => {
      const queryKey = ['tasks', filterProject] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ApiSuccess<PaginatedList<Task>>>(queryKey)?.data.items.find((task) => task.id === id);
      return { previous, queryKey };
    },
    onSuccess: (saved) => {
      if (saved.assistanceStatus === 'failed') setSaveError('Task saved, but Athena could not queue its help proposal. Open the task and choose Help me to retry.');
      void queryClient.invalidateQueries({ queryKey: ['task-assistance', saved.id] });
      queryClient.setQueriesData<ApiSuccess<PaginatedList<Task>>>({ queryKey: ['tasks'] }, (current) => {
        if (current === undefined || !current.success) return current;
        return {
          ...current,
          data: {
            ...current.data,
            items: current.data.items.map((task) => task.id === saved.id ? { ...saved, origin: task.origin ?? saved.origin ?? null } : task),
          },
        };
      });
    },
    onError: (error, { id }, ctx) => {
      const previous = ctx?.previous;
      if (ctx !== undefined && previous !== undefined) {
        queryClient.setQueryData<ApiSuccess<PaginatedList<Task>>>(ctx.queryKey, (current) => current === undefined ? current : ({
          ...current, data: { ...current.data, items: current.data.items.map((task) => task.id === id ? previous : task) },
        }));
      }
      setSaveError(describeApiError(error));
    },
    onSettled: (saved, _error, { id, status }, ctx) => {
      finishTaskAction(id);
      const spawnedRecurrence = saved !== undefined && status === 'completed'
        && ctx?.previous?.status !== 'completed' && saved.recurringCadence != null;
      void queryClient.invalidateQueries({ queryKey: ['tasks'], refetchType: spawnedRecurrence ? 'active' : 'none' });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (id: string) => requireApiData(await api.archiveTask(id)),
    onSuccess: () => { setSaveError(null); void queryClient.invalidateQueries({ queryKey: ['tasks'] }); },
    onError: (error) => { setSaveError(describeApiError(error)); },
    onSettled: (_data, _error, id) => { finishTaskAction(id); },
  });

  const moveTask = (id: string, status: TaskStatus): void => { if (beginTaskAction(id)) moveTaskMutation.mutate({ id, status }); };
  const openEditor = (task: Task): void => { setEditTask(task); setModalOpen(true); };
  const selectTask = (task: Task): void => { setSelectedTaskId(task.id); };
  const askAthenaAbout = selectTask;

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const task = tasks.find(item => item.id === id);
      if (!await confirmDialog(`Delete "${task?.title ?? 'this task'}"? This cannot be undone.`, {
        title: 'Delete task', confirmLabel: 'Delete task', tone: 'danger',
      })) return;
      return requireApiData(await api.deleteTask(id));
    },
    onSuccess: () => { setSaveError(null); void queryClient.invalidateQueries({ queryKey: ['tasks'] }); },
    onError: (error) => { setSaveError(describeApiError(error)); },
    onSettled: (_data, _error, id) => { finishTaskAction(id); },
  });

  const selectedTask = tasks.find(task => task.id === selectedTaskId) ?? selectedDetail.data?.task;
  const reviewFocusGroups = selectedTaskId && view === 'focus' ? groupForFocus(scopedTasks, localDateKey(new Date())) : null;
  const workstreamLanes = (() => {
    const lanes = new Map<string, WorkstreamLane>();
    const ensureLane = (key: string, projectId: string | null, name: string): WorkstreamLane => {
      let lane = lanes.get(key);
      if (lane === undefined) {
        lane = emptyWorkstreamLane(key, projectId, name);
        lanes.set(key, lane);
      }
      return lane;
    };

    for (const task of scopedTasks) {
      if (task.status === 'inbox') continue;
      const projectId = task.projectId === 'personal' || task.projectId === '' ? null : task.projectId;
      const key = workstreamKey(projectId);
      const name = projectId === null ? 'No workstream' : getProjectName(projectId, projects);
      addToGroup(ensureLane(key, projectId, name).tasks, task.status, task);
    }

    if (filterTag === '') {
      for (const useCase of useCases) {
        const status = boardColumnForUseCase(useCase.stage);
        if (status === null || (filterProject !== '' && useCase.projectId !== filterProject)) continue;
        const projectId = useCase.projectId;
        const name = projectId !== null ? getProjectName(projectId, projects) : useCase.projectName ?? 'No workstream';
        const key = workstreamKey(projectId, useCase.projectName);
        addToGroup(ensureLane(key, projectId, name).useCases, status, useCase);
      }
    }

    const completedId: TaskStatus = 'completed';
    for (const lane of lanes.values()) {
      for (const column of COLUMNS) {
        const laneTasks = lane.tasks.get(column.id) ?? [];
        const count = laneTasks.length + (lane.useCases.get(column.id)?.length ?? 0);
        if (column.id === completedId) {
          lane.completedCount += (showOlderDone ? laneTasks : laneTasks.filter(task => busyTaskIds.has(task.id) || isRecentlyCompleted(task))).length
            + (lane.useCases.get(column.id)?.length ?? 0);
        } else lane.openCount += count;
      }
    }
    return [...lanes.values()].sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name, 'en-GB'));
  })();
  const olderDoneCount = scopedTasks.filter((task) => task.status === 'completed'
    && !busyTaskIds.has(task.id) && !isRecentlyCompleted(task)).length;

  const openAddTask = (status: TaskStatus, projectId = 'personal'): void => {
    setEditTask(null);
    setAddStatus(status);
    setAddProjectId(projectId);
    setModalOpen(true);
  };
  const taskViews = <>
      {isPending && <InlineLoading description="Loading…" />}
      {isError && <DataNotice title="Tasks are unavailable" error={loadError} onRetry={() => { void refetch(); }} />}
      {saveError !== null && !modalOpen && <DataNotice title="Task update needs attention" error={saveError} />}
      {view === 'board' && useCasesError !== null && (
        <DataNotice title="Use cases are unavailable" error={useCasesError} onRetry={() => { void refetchUseCases(); }} />
      )}
      {view === 'board' && filterTag !== '' && useCases.some((useCase) => boardColumnForUseCase(useCase.stage) !== null)
        && <p className="kb-board__notice">Use cases are hidden while a tag filter is active because they do not have task tags.</p>}
      {view === 'board' && filterTag === '' && useCasesPending && <InlineLoading description="Loading use cases…" />}
      {view === 'board' && !isPending && !isError && workstreamLanes.length === 0
        && (filterTag !== '' || (!useCasesPending && useCasesError === null))
        && <p className="kb-workstreams__empty">No tasks or use cases match these filters.</p>}

      <InboxTray
        tasks={inboxTasks}
        busyIds={busyTaskIds}
        projects={projects}
        onAccept={(task) => { moveTask(task.id, 'backlog'); }}
        onEdit={openEditor}
        onSelect={selectTask}
        onDismiss={(task) => { if (beginTaskAction(task.id)) dismissMutation.mutate(task.id); }}
      />

      {view === 'focus' && (
        <>
        <div className="kb-focus__actions">
          <button type="button" className="kb-import-btn" onClick={() => { openAddTask('backlog'); }}>
            <Add size={16} /> Add task
          </button>
        </div>
        <FocusView
          tasks={scopedTasks}
          busyIds={busyTaskIds}
          selectedTaskId={selectedTaskId}
          projects={projects}
          onComplete={(task) => { moveTask(task.id, 'completed'); }}
          onEdit={selectTask}
          onAskAthena={askAthenaAbout}
        />
        </>
      )}

      {view === 'board' && <section className="kb-workstreams" aria-label="Plan tasks grouped by workstream">
        <div className="kb-workstreams__grid">
          {COLUMNS.map((column) => {
            const taskCount = scopedTasks.filter((task) => task.status === column.id).length;
            const useCaseCount = filterTag === '' ? useCases
              .filter((useCase) => filterProject === '' || useCase.projectId === filterProject)
              .filter((useCase) => boardColumnForUseCase(useCase.stage) === column.id).length : 0;
            return (
              <div className="kb-workstreams__column-head" key={column.id}>
                <span className="kb-col__name">{column.label}</span>
                <span className="kb-workstreams__column-meta">
                  <button type="button" className="kb-workstreams__add kb-workstreams__add--column"
                    aria-label={`Add task in ${column.label}`} title={`Add task in ${column.label}`}
                    onClick={() => { openAddTask(column.id); }}>
                    <Add size={16} />
                  </button>
                  {column.id === 'completed' && olderDoneCount > 0 && (
                    <button type="button" className="kb-workstreams__older"
                      aria-expanded={showOlderDone}
                      onClick={() => { setShowOlderDone((value) => !value); }}>
                      {showOlderDone ? `Hide ${olderDoneCount} older` : `Show ${olderDoneCount} older`}
                    </button>
                  )}
                  {taskCount + useCaseCount > 0 && <span className="kb-col__count">{taskCount + useCaseCount}</span>}
                </span>
              </div>
            );
          })}

          {workstreamLanes.map((lane) => {
            const laneSize = lane.openCount + lane.completedCount;
            const collapsed = collapsedWorkstreams[lane.key] ?? (laneSize > 20);
            return (
              <React.Fragment key={lane.key}>
                <div className="kb-workstreams__lane-head">
                  <button type="button" className="kb-workstreams__lane-toggle" aria-expanded={!collapsed}
                    onClick={() => { setCollapsedWorkstreams((current) => ({ ...current, [lane.key]: !(current[lane.key] ?? (laneSize > 20)) })); }}>
                    <ChevronDown size={16} className={`kb-workstreams__caret${collapsed ? ' kb-workstreams__caret--collapsed' : ''}`} />
                    {lane.projectId !== null
                      ? <EntityChip projectId={lane.projectId} fallbackLabel={lane.name} className="kb-workstreams__project" />
                      : <span className="kb-workstreams__lane-name">{lane.name}</span>}
                    <span className="kb-workstreams__lane-count">{lane.openCount} open · {lane.completedCount} completed</span>
                  </button>
                  {(lane.projectId !== null || lane.key === 'unassigned') && (
                    <button type="button" className="kb-workstreams__add" aria-label={`Add task to ${lane.name}`}
                      onClick={() => { openAddTask('backlog', lane.projectId ?? 'personal'); }}>
                      <Add size={16} /><span>Add task</span>
                    </button>
                  )}
                </div>
                {COLUMNS.map((column) => {
                  const allLaneTasks = lane.tasks.get(column.id) ?? [];
                  // Completed tasks auto-archive after 14 days; keep recent completions visible by default.
                  const isRecentDone = (task: Task): boolean => busyTaskIds.has(task.id) || isRecentlyCompleted(task);
                  const olderInLane = column.id === 'completed' ? allLaneTasks.filter((task) => !isRecentDone(task)).length : 0;
                  const laneTasks = column.id === 'completed' && !showOlderDone
                    ? allLaneTasks.filter(isRecentDone)
                    : allLaneTasks;
                  const laneUseCases = [...(lane.useCases.get(column.id) ?? [])]
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
                  const cellKey = `${lane.key}:${column.id}`;
                  const isEmpty = laneTasks.length + laneUseCases.length === 0;
                  return (
                    <div
                      key={column.id}
                      className={`kb-workstreams__cell${isEmpty ? ' kb-workstreams__cell--empty' : ''}${dragOverWorkstreamCell === cellKey ? ' kb-workstreams__cell--drag-over' : ''}`}
                      hidden={collapsed}
                      onDragOver={(event) => { event.preventDefault(); setDragOverWorkstreamCell(cellKey); }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverWorkstreamCell(null);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragOverWorkstreamCell(null);
                        const taskId = event.dataTransfer.getData('taskId');
                        const sourceProjectId = event.dataTransfer.getData('projectId');
                        const sourceLaneKey = workstreamKey(sourceProjectId === 'personal' || sourceProjectId === '' ? null : sourceProjectId);
                        if (sourceLaneKey !== lane.key) {
                          setSaveError('Edit the task to change its workstream; dragging only changes status.');
                        } else if (taskId && beginTaskAction(taskId)) {
                          moveTaskMutation.mutate({ id: taskId, status: column.id });
                        }
                      }}
                    >
                      {laneUseCases.map((useCase) => <UseCaseBoardCard key={useCase.id} useCase={useCase} />)}
                      {laneTasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          busy={busyTaskIds.has(task.id)}
                          selected={selectedTaskId === task.id}
                          projects={projects}
                          onMove={moveTask}
                          onDelete={(id) => { if (beginTaskAction(id)) deleteMutation.mutate(id); }}
                          onEdit={openEditor}
                          onSelect={selectTask}
                          onAskAthena={askAthenaAbout}
                        />
                      ))}
                      {olderInLane > 0 && laneTasks.length === 0 && !showOlderDone && (
                        <p className="kb-workstreams__empty-note">Nothing completed in the last {RECENT_COMPLETED_DAYS} days.</p>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </section>}
      </>;
  return (
    <div className="kb-page">
      {selectedTaskId ? <ReviewWorkspace storageKey="plan-task" label="Plan tasks"
        context={{ type: 'task', id: selectedTaskId, title: selectedTask?.title ?? 'Task',
          ...(selectedTask?.projectId ? { projectId: selectedTask.projectId } : {}),
          detail: `${JSON.stringify(selectedTask)}\nVisible ${view === 'board' ? 'workstream swim lanes across status columns' : `${view} task groups`}, with the same workstream/tag and completed-task filters as the normal Plan view:\n${JSON.stringify({
            filterProject, filterTag, showOlderDone,
            groups: reviewFocusGroups
              ? [{ label: 'Inbox', ids: inboxTasks.map(task => task.id) }, ...FOCUS_GROUPS.map(group => ({
                label: group.label, ids: reviewFocusGroups[group.id].map(task => task.id),
              }))]
              : [{ label: 'Inbox', ids: inboxTasks.map(task => task.id) }, ...COLUMNS.map(column => ({
                label: column.label, ids: scopedTasks.filter(task => task.status === column.id
                  && (task.status !== 'completed' || showOlderDone || busyTaskIds.has(task.id) || isRecentlyCompleted(task))).map(task => task.id),
              }))],
            ...(view === 'board' ? { workstreams: workstreamLanes.map(lane => ({
              name: lane.name,
              collapsed: collapsedWorkstreams[lane.key] ?? (lane.openCount + lane.completedCount > 20),
              taskIds: COLUMNS.flatMap(column => (lane.tasks.get(column.id) ?? [])
                .filter(task => task.status !== 'completed' || showOlderDone || busyTaskIds.has(task.id) || isRecentlyCompleted(task))
                .map(task => task.id)),
              useCaseIds: COLUMNS.flatMap(column => (lane.useCases.get(column.id) ?? []).map(useCase => useCase.id)),
            })) } : {}),
          })}\nHelp me assesses capability before an explicit approval. Do not execute assistance from a casual discussion or complete this task automatically.` }}
        list={<section className="kb-task-review-list" aria-labelledby="plan-task-list-heading">
          <div className="today-brief__section-heading">
            <h2 id="plan-task-list-heading">{view === 'board' ? 'Board' : 'Focus'}</h2>
            <button type="button" className="today-brief__quiet" onClick={() => { setSelectedTaskId(null); }}>Back to {view === 'board' ? 'Board' : 'Focus'}</button>
          </div>
          {taskViews}
        </section>}
        detail={<TaskDetail key={selectedTaskId} taskId={selectedTaskId} onBackToPlan={() => { setSelectedTaskId(null); }} />} />
        : taskViews}

      <PodcastImportModal
        open={importOpen}
        onClose={onImportClose}
        onTasksCreated={() => void queryClient.invalidateQueries({ queryKey: ['tasks'] })}
      />

      {modalOpen && <TaskModal
        open={modalOpen}
        initial={editTask}
        defaultStatus={addStatus}
        defaultProjectId={addProjectId}
        projects={projects}
        error={saveError}
        onClose={() => { setModalOpen(false); setEditTask(null); setSaveError(null); }}
        onSave={(input) => {
          if (savePending.current) return;
          savePending.current = true;
          setSaveError(null);
          if (editTask != null) {
            updateMutation.mutate({ id: editTask.id, ...input });
          } else {
            createMutation.mutate(input);
          }
        }}
        saving={createMutation.isPending || updateMutation.isPending}
      />}
    </div>
  );
};