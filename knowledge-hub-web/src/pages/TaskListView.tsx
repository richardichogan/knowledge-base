/**
 * TaskListView.tsx — date-filtered list view of tasks, shown as a Plan sub-view.
 *
 * Shows all tasks due on a chosen date (default: today).
 * Tasks are grouped by status, sorted by priority.
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DatePicker, DatePickerInput, Tag } from '@carbon/react';
import { CheckmarkFilled, CircleDash, WarningFilled, Time, ChevronRight } from '@carbon/icons-react';
import { api } from '../services/api';
import { PROJECTS } from '../config/projects';

// ── Types (mirror TasksPage — kept local to avoid coupling) ──────────────────

type TaskStatus   = 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

interface Task {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  projectId: string;
  priority: TaskPriority;
  dueDate: string | null;
  startDate: string | null;
  recurringCadence: string | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return toDateStr(new Date());
}

function getProjectName(id: string): string {
  return PROJECTS.find((p) => p.id === id)?.name ?? id;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const STATUS_ORDER: TaskStatus[] = ['in-progress', 'blocked', 'awaiting-feedback', 'backlog', 'completed'];

const STATUS_LABEL: Record<TaskStatus, string> = {
  'in-progress':       'In Progress',
  'blocked':           'Blocked',
  'awaiting-feedback': 'Awaiting Feedback',
  'backlog':           'Backlog',
  'completed':         'Completed',
};

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function StatusIcon({ status }: { status: TaskStatus }): React.ReactElement {
  if (status === 'completed')        return <CheckmarkFilled size={16} style={{ color: '#24a148' }} />;
  if (status === 'blocked')          return <WarningFilled   size={16} style={{ color: '#fa4d56' }} />;
  if (status === 'awaiting-feedback') return <Time           size={16} style={{ color: '#f1c21b' }} />;
  if (status === 'in-progress')      return <ChevronRight   size={16} style={{ color: '#4589ff' }} />;
  return <CircleDash size={16} style={{ color: '#525252' }} />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const TaskListView: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState<string>(todayStr());
  const queryClient = useQueryClient();

  const { data, isPending, isError } = useQuery({
    queryKey: ['tasks'],
    queryFn:  () => api.getTasks(),
    staleTime: 0,
  });

  const allTasks: Task[] =
    (data as { success: boolean; data?: { items: Task[] } } | undefined)?.success === true
      ? (data as { data: { items: Task[] } }).data.items
      : [];

  // Filter to tasks due on the selected date (or overdue if showing today)
  const isToday = selectedDate === todayStr();
  const filtered = allTasks.filter((t) => {
    if (t.status === 'completed') return false;
    if (!t.dueDate) return false;
    if (isToday) return t.dueDate <= selectedDate; // include overdue on today view
    return t.dueDate === selectedDate;
  });

  // Group by status, sorted by priority within each group
  const groups = new Map<TaskStatus, Task[]>();
  for (const s of STATUS_ORDER) groups.set(s, []);
  for (const task of filtered) {
    groups.get(task.status)?.push(task);
  }
  for (const [, list] of groups) {
    list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  }
  const nonEmptyGroups = STATUS_ORDER.filter((s) => (groups.get(s)?.length ?? 0) > 0);

  const markDoneMutation = useMutation({
    mutationFn: (id: string) => api.updateTask(id, { status: 'completed' }),
    onSuccess:  () => { void queryClient.invalidateQueries({ queryKey: ['tasks'] }); },
  });

  return (
    <div className="tl-root">
      {/* Date picker bar */}
      <div className="tl-header">
        <DatePicker
          datePickerType="single"
          dateFormat="Y-m-d"
          value={selectedDate}
          onChange={(dates) => {
            const d = dates[0];
            if (d) setSelectedDate(toDateStr(d));
          }}
        >
          <DatePickerInput
            id="tl-date"
            labelText="Show tasks due on"
            placeholder="YYYY-MM-DD"
            size="sm"
          />
        </DatePicker>
        <div className="tl-header__meta">
          {isToday
            ? <span className="tl-badge tl-badge--today">Today</span>
            : <span className="tl-badge">{formatDate(selectedDate)}</span>}
          <span className="tl-count">{filtered.length} task{filtered.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Task list */}
      {isPending && <p className="tl-empty">Loading…</p>}
      {isError   && <p className="tl-empty tl-empty--error">Failed to load tasks.</p>}

      {!isPending && !isError && filtered.length === 0 && (
        <div className="tl-empty">
          <CheckmarkFilled size={32} style={{ color: '#24a148', marginBottom: 8 }} />
          <p>Nothing due {isToday ? 'today' : `on ${formatDate(selectedDate)}`}.</p>
        </div>
      )}

      {nonEmptyGroups.map((status) => {
        const list = groups.get(status) ?? [];
        return (
          <div key={status} className="tl-group">
            <p className="tl-group__label">
              <StatusIcon status={status} />
              {STATUS_LABEL[status]}
              <span className="tl-group__count">{list.length}</span>
            </p>
            <ul className="tl-list">
              {list.map((task) => (
                <li key={task.id} className={`tl-item tl-item--${task.priority}`}>
                  <span
                    className={`tl-item__priority-bar tl-item__priority-bar--${task.priority}`}
                  />
                  <div className="tl-item__body">
                    <div className="tl-item__title">{task.title}</div>
                    <div className="tl-item__meta">
                      <span className="tl-item__project">{getProjectName(task.projectId)}</span>
                      {task.dueDate && task.dueDate < todayStr() && (
                        <Tag type="red" size="sm">Overdue — {formatDate(task.dueDate)}</Tag>
                      )}
                      {task.dueDate && task.dueDate === todayStr() && (
                        <Tag type="warm-gray" size="sm">Due today</Tag>
                      )}
                      {task.dueDate && task.dueDate > todayStr() && (
                        <Tag type="blue" size="sm">Due {formatDate(task.dueDate)}</Tag>
                      )}
                    </div>
                    {task.body !== '' && <p className="tl-item__desc">{task.body}</p>}
                  </div>
                  <button
                    type="button"
                    className="tl-item__done-btn"
                    title="Mark as completed"
                    onClick={() => { markDoneMutation.mutate(task.id); }}
                  >
                    <CheckmarkFilled size={18} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};
