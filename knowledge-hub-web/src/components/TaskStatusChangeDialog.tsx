import React, { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppDialog } from './AppDialog';
import { describeApiError } from '../services/apiError';
import {
  currentTaskStatusRequest, finishTaskStatusRequest, subscribeTaskStatusRequests, type TaskStatusRequest,
} from '../services/taskStatusChanges';

function StatusDialog({ request }: { request: TaskStatusRequest }): React.ReactElement {
  const cache = useQueryClient();
  const [note, setNote] = useState(request.initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => { if (!busy) finishTaskStatusRequest(request.id, true); };
  const submit = async (): Promise<void> => {
    if (busy || !note.trim()) return;
    setBusy(true); setError(null);
    try {
      await request.apply(note.trim());
      finishTaskStatusRequest(request.id);
    } catch (err) {
      console.error('[Task status change]', err);
      setError(describeApiError(err));
    } finally {
      setBusy(false);
      for (const key of ['tasks', 'task-notes', 'task-assistance', 'today', 'today-tasks', 'at-risk-tasks']) {
        void cache.invalidateQueries({ queryKey: [key] });
      }
    }
  };
  return <AppDialog title="Task status change" onClose={close} actions={<>
    <button type="button" className="kh-dialog__button" disabled={busy} onClick={close}>Cancel</button>
    <button type="button" className="kh-dialog__button kh-dialog__button--primary" disabled={busy || !note.trim()}
      onClick={() => { void submit(); }}>{busy ? 'Saving...' : 'Submit'}</button>
  </>}>
    <div className="kh-task-status-note">
      <ul className="kh-task-status-note__moves">{request.moves.map(move => <li key={move.taskId}>
        <strong>{move.title}</strong><span>{move.from} &rarr; {move.to}</span>
      </li>)}</ul>
      <label>Quick note <span>(required)</span>
        <textarea data-dialog-autofocus rows={4} maxLength={3000} value={note} disabled={busy}
          onChange={event => { setNote(event.target.value); }} />
      </label>
      <p>The note and status change are saved together in the task's timestamped activity.</p>
      {request.moves.length > 1 && <p>This note will be saved against every task shown.</p>}
      {error && <p className="kh-task-status-note__error" role="alert">{error}</p>}
    </div>
  </AppDialog>;
}

export function TaskStatusChangeDialogHost(): React.ReactElement | null {
  const request = useSyncExternalStore(subscribeTaskStatusRequests, currentTaskStatusRequest, () => null);
  return request ? <StatusDialog key={request.id} request={request} /> : null;
}
