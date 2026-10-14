/**
 * End-of-day check-in: after 4pm UK, a banner on every page until today's open Plan items are settled
 * (done / next working day / new date / drop) or the day is consciously skipped. Stops tasks rolling over silently.
 */
import React, { useState } from 'react';
import { InlineNotification, Modal } from '@carbon/react';
import { CheckmarkOutline } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { CheckinAction, NudgeTask } from '../../types/task';
import { dueLabel, nextWorkingDay, settleTask } from './settleTask';

const CHECKIN_HOUR = 16;
const REFRESH_MS = 15 * 60_000;
const SETTLED_TEXT: Record<CheckinAction, string> = { done: 'Done', tomorrow: 'Moved', date: 'Rescheduled', drop: 'Dropped' };

const CheckinRow: React.FC<{
  task: NudgeTask; today: string; settled: CheckinAction | undefined;
  onSettle: (action: CheckinAction, date?: string) => void; busy: boolean;
}> = ({ task, today, settled, onSettle, busy }) => {
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState('');
  const next = nextWorkingDay();
  const late = task.dueDate !== null && task.dueDate < today;
  return (
    <li className={`day-checkin__row${settled ? ' day-checkin__row--settled' : ''}`}>
      <div className="day-checkin__info">
        <span className="day-checkin__title">{task.title}</span>
        <span className="day-checkin__meta">
          <span className={late ? 'day-checkin__due day-checkin__due--late' : 'day-checkin__due'}>{dueLabel(task.dueDate, task.status, today)}</span>
          {task.rescheduleCount > 0 && (
            <span className="day-checkin__slips" title="Times this due date has been pushed back">
              Pushed back {task.rescheduleCount}×
            </span>
          )}
        </span>
      </div>
      {settled ? (
        <span className="day-checkin__settled"><CheckmarkOutline size={16} /> {SETTLED_TEXT[settled]}</span>
      ) : picking ? (
        <div className="day-checkin__actions">
          <input type="date" className="day-checkin__date" value={date} min={today} aria-label={`New due date for ${task.title}`}
            onChange={(e) => { setDate(e.target.value); }} />
          <button type="button" className="day-checkin__btn day-checkin__btn--primary" disabled={busy || date === ''}
            onClick={() => { onSettle('date', date); }}>Set</button>
          <button type="button" className="day-checkin__btn" onClick={() => { setPicking(false); }}>Cancel</button>
        </div>
      ) : (
        <div className="day-checkin__actions">
          <button type="button" className="day-checkin__btn day-checkin__btn--done" disabled={busy} onClick={() => { onSettle('done'); }}>Done</button>
          <button type="button" className="day-checkin__btn" disabled={busy} onClick={() => { onSettle('tomorrow'); }}>{next.label}</button>
          <button type="button" className="day-checkin__btn" disabled={busy} onClick={() => { setPicking(true); }}>Pick date</button>
          <button type="button" className="day-checkin__btn day-checkin__btn--drop" disabled={busy} onClick={() => { onSettle('drop'); }}>Drop</button>
        </div>
      )}
    </li>
  );
};

export const DayCheckinBanner: React.FC = () => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState<Record<string, CheckinAction>>({});
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['day-checkin'],
    queryFn: async () => {
      const res = await api.getDayCheckin();
      return res.success ? res.data : null;
    },
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS,
  });

  const settle = useMutation({
    mutationFn: async ({ taskId, action, date }: { taskId: string; action: CheckinAction; date?: string | undefined }) => {
      await settleTask(taskId, action, date);
      return { taskId, action };
    },
    onSuccess: ({ taskId, action }) => {
      setError(null);
      setSettled((prev) => ({ ...prev, [taskId]: action }));
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['at-risk-tasks'] });
    },
    onError: (err) => { setError(err instanceof Error ? err.message : 'Could not update the task.'); },
  });

  const finish = useMutation({
    mutationFn: async (status: 'completed' | 'skipped') => {
      if (!data) return;
      const res = await api.saveDayCheckin(data.day, status, Object.entries(settled).map(([taskId, action]) => ({ taskId, action })));
      if (!res.success) throw new Error(res.error.message);
    },
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['day-checkin'] });
    },
    onError: (err) => { setError(err instanceof Error ? err.message : 'Could not save the check-in.'); },
  });

  if (!data || data.status !== null || data.hour < CHECKIN_HOUR || data.items.length === 0) return null;
  const remaining = data.items.filter((t) => settled[t.id] === undefined).length;

  return (
    <>
      <div className="day-checkin-banner" role="region" aria-label="End of day check-in">
        <span className="day-checkin-banner__text">
          <strong>Wrap up today</strong> — {data.items.length} Plan item{data.items.length === 1 ? '' : 's'} to settle before tomorrow.
        </span>
        <div className="day-checkin-banner__actions">
          <button type="button" className="day-checkin__btn day-checkin__btn--primary" onClick={() => { setError(null); setOpen(true); }}>Start</button>
          <button type="button" className="day-checkin__btn" disabled={finish.isPending} onClick={() => { finish.mutate('skipped'); }}>Not today</button>
        </div>
      </div>
      <Modal
        open={open}
        modalHeading="Wrap up today"
        modalLabel="Plan"
        primaryButtonText={finish.isPending ? 'Saving…' : remaining > 0 ? `Finish (${remaining} left as is)` : 'Finish day'}
        secondaryButtonText="Close"
        primaryButtonDisabled={finish.isPending || settle.isPending}
        onRequestClose={() => { setOpen(false); }}
        onRequestSubmit={() => { finish.mutate('completed'); }}
        size="md"
      >
        <div className="day-checkin">
          <p className="day-checkin__intro">Settle each item so nothing rolls over silently. Anything you leave stays as it is.</p>
          {error !== null && <InlineNotification kind="error" title="Something went wrong" subtitle={error} lowContrast hideCloseButton />}
          <ul className="day-checkin__list">
            {data.items.map((task) => (
              <CheckinRow key={task.id} task={task} today={data.day} settled={settled[task.id]} busy={settle.isPending}
                onSettle={(action, date) => { settle.mutate({ taskId: task.id, action, date }); }} />
            ))}
          </ul>
          {data.completedToday.length > 0 && (
            <div className="day-checkin__wins">
              <span className="day-checkin__wins-label">Done today</span>
              <ul className="day-checkin__wins-list">
                {data.completedToday.map((t) => <li key={t.id}><CheckmarkOutline size={14} /> {t.title}</li>)}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
};
