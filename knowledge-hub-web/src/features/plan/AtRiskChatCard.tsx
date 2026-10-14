/**
 * Shown when a new Athena chat opens: the one or two Plan items most likely being forgotten
 * (overdue, repeatedly pushed back, or gone quiet), with one-click settle actions.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { toISODateString } from '../../utils/dates';
import type { CheckinAction } from '../../types/task';
import { nextWorkingDay, settleTask } from './settleTask';

const HIDDEN_KEY = 'athena.atRisk.hidden';

function hiddenToday(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null') as { day: string; ids: string[] } | null;
    return saved?.day === toISODateString(new Date()) ? saved.ids : [];
  } catch { return []; }
}

function hideForToday(id: string): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ day: toISODateString(new Date()), ids: [...hiddenToday(), id] }));
  } catch { /* storage unavailable — it just shows again next time */ }
}

export const AtRiskChatCard: React.FC = () => {
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<string[]>(hiddenToday);
  const [settled, setSettled] = useState<Record<string, CheckinAction>>({});
  const { data = [] } = useQuery({
    queryKey: ['at-risk-tasks'],
    queryFn: async () => {
      const res = await api.getAtRiskTasks();
      return res.success ? res.data : [];
    },
    staleTime: 5 * 60_000,
  });
  const settle = useMutation({
    mutationFn: async ({ taskId, action }: { taskId: string; action: CheckinAction }) => {
      await settleTask(taskId, action);
      return { taskId, action };
    },
    onSuccess: ({ taskId, action }) => {
      setSettled((prev) => ({ ...prev, [taskId]: action }));
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['day-checkin'] });
    },
  });

  const items = data.filter((t) => !hidden.includes(t.id));
  if (items.length === 0) return null;
  const next = nextWorkingDay();

  return (
    <section className="ai-at-risk" aria-label="Plan items at risk">
      <p className="ai-at-risk__heading">Before we start — {items.length === 1 ? 'this keeps' : 'these keep'} slipping</p>
      <ul className="ai-at-risk__list">
        {items.map((t) => (
          <li key={t.id} className="ai-at-risk__item">
            <div className="ai-at-risk__info">
              <span className="ai-at-risk__title">{t.title}</span>
              <span className="ai-at-risk__reason">{t.reason}</span>
            </div>
            {settled[t.id] ? (
              <span className="ai-at-risk__done">{settled[t.id] === 'done' ? 'Marked done' : `Moved to ${next.label.toLowerCase()}`}</span>
            ) : (
              <div className="ai-at-risk__actions">
                <button type="button" className="day-checkin__btn day-checkin__btn--done" disabled={settle.isPending}
                  onClick={() => { settle.mutate({ taskId: t.id, action: 'done' }); }}>Done</button>
                <button type="button" className="day-checkin__btn" disabled={settle.isPending}
                  onClick={() => { settle.mutate({ taskId: t.id, action: 'tomorrow' }); }}>{next.label}</button>
                <Link className="day-checkin__btn" to={`/plan?taskId=${encodeURIComponent(t.id)}`}>Open</Link>
                <button type="button" className="day-checkin__btn day-checkin__btn--quiet"
                  onClick={() => { hideForToday(t.id); setHidden((prev) => [...prev, t.id]); }}>Not now</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {settle.isError && <p className="ai-at-risk__error">Couldn't update that task. Try again from Plan.</p>}
    </section>
  );
};
