/**
 * components/athena/BackgroundTaskCard.tsx — a request Athena is still working
 * on in the background. It sits under the message that asked for it; the reply
 * lands at the bottom of the chat when the task finishes.
 */
import React, { useEffect, useState } from 'react';
import { progressLabel } from './LiveReply';

interface BackgroundTaskCardProps {
  activity: string;
  startedAt: number;
  stopping: boolean;
  onCancel: () => void;
}

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toString()}s`;
  const m = Math.floor(seconds / 60);
  return `${m.toString()}m ${(seconds % 60).toString().padStart(2, '0')}s`;
}

export const BackgroundTaskCard: React.FC<BackgroundTaskCardProps> = ({ activity, startedAt, stopping, onCancel }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className="ai-task-card" role="status" aria-live="polite">
      <span className="ai-task-card__pulse" aria-hidden="true" />
      <div className="ai-task-card__body">
        <span className="ai-task-card__title">{stopping ? 'Stopping this one…' : 'Still on it in the background'}</span>
        <span className="ai-task-card__activity">
          {progressLabel(activity)} · {elapsed(seconds)}
        </span>
      </div>
      <button type="button" className="ai-task-card__cancel" disabled={stopping} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
};
