/**
 * Quick actions shared by the end-of-day check-in and Athena's at-risk chat card.
 */
import { api } from '../../services/api';
import { addWorkingDays, toISODateString } from '../../utils/dates';
import type { CheckinAction } from '../../types/task';

/** The next working day, plus a label: "Tomorrow", or the weekday when it skips a weekend. */
export function nextWorkingDay(now = new Date()): { iso: string; label: string } {
  const next = addWorkingDays(now, 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const iso = toISODateString(next);
  return { iso, label: iso === toISODateString(tomorrow) ? 'Tomorrow' : next.toLocaleDateString('en-GB', { weekday: 'long' }) };
}

export async function settleTask(taskId: string, action: CheckinAction, date?: string): Promise<void> {
  const res = action === 'done' ? await api.updateTask(taskId, { status: 'completed' })
    : action === 'drop' ? await api.archiveTask(taskId)
      : await api.updateTask(taskId, { dueDate: action === 'tomorrow' ? nextWorkingDay().iso : date });
  if (!res.success) throw new Error(res.error.message);
}

/** "Overdue 3 days", "Due today", "In progress" … for a check-in row. */
export function dueLabel(dueDate: string | null, status: string, today: string): string {
  if (dueDate !== null && dueDate < today) {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
    return `Overdue ${days} day${days === 1 ? '' : 's'}`;
  }
  if (dueDate === today) return 'Due today';
  return status === 'in-progress' ? 'In progress' : 'Open';
}
