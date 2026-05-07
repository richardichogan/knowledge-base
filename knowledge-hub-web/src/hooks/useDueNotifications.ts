/**
 * useDueNotifications.ts
 *
 * Requests browser notification permission on mount, then fires a desktop
 * notification for each task that is due today (or overdue).
 *
 * - Fires once per session (tracked in sessionStorage) so it doesn't spam.
 * - Respects the user's notification permission — silently does nothing if
 *   permission is denied.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

type TaskStatus   = 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
}

const SESSION_KEY = 'kh_due_notif_fired';
const PRIORITY_EMOJI: Record<TaskPriority, string> = {
  urgent: '🔴',
  high:   '🟡',
  normal: '🔵',
  low:    '⚪',
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function useDueNotifications(): void {
  const { data } = useQuery({
    queryKey: ['tasks'],
    queryFn:  () => api.getTasks(),
    staleTime: 0,
  });

  useEffect(() => {
    // Don't fire more than once per browser session
    if (sessionStorage.getItem(SESSION_KEY) === '1') return;
    if (!('Notification' in window)) return;

    const allTasks: Task[] =
      (data as { success: boolean; data?: { items: Task[] } } | undefined)?.success === true
        ? (data as { data: { items: Task[] } }).data.items
        : [];

    const today = todayStr();
    const dueTasks = allTasks.filter(
      (t) => t.status !== 'completed' && t.dueDate !== null && t.dueDate <= today,
    );

    if (dueTasks.length === 0) return;

    const fire = (): void => {
      sessionStorage.setItem(SESSION_KEY, '1');

      if (dueTasks.length === 1) {
        const t = dueTasks[0];
        if (t !== undefined) {
          new Notification('Knowledge Hub — Task due today', {
            body: `${PRIORITY_EMOJI[t.priority]} ${t.title}`,
            icon: '/favicon.ico',
            tag:  `kh-due-${t.id}`,
          });
        }
      } else {
        // Group notification with count
        const urgent   = dueTasks.filter((t) => t.priority === 'urgent').length;
        const overdueCount = dueTasks.filter((t) => t.dueDate !== null && t.dueDate < today).length;
        const lines = [
          `${dueTasks.length} task${dueTasks.length !== 1 ? 's' : ''} due today or overdue`,
          urgent > 0       ? `🔴 ${urgent} urgent` : '',
          overdueCount > 0 ? `⚠️ ${overdueCount} overdue` : '',
        ].filter(Boolean).join(' · ');

        new Notification('Knowledge Hub — Tasks due today', {
          body: lines,
          icon: '/favicon.ico',
          tag:  'kh-due-summary',
        });
      }
    };

    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((perm) => {
        if (perm === 'granted') fire();
      });
    }
    // If 'denied', do nothing silently
  }, [data]);
}
