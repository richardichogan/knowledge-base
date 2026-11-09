/**
 * components/today/Decide.tsx — Today's Decide queue: everything waiting on Richard's decision in one list, oldest first.
 * Publishing picks, open chat decisions, proactive proposals (held ones included), unsent drafts and waiting tasks with
 * nobody named. Each item opens in the detail pane with its actions, which use the same endpoints and services as their
 * home screens; Athena reads and acts on the queue with manage_decide_queue.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { TopicReview } from '../discover/DiscoverPublishing';
import { PROACTIVE_KEY } from './Proactive';
import type { DecideAction, DecideItem, DecideKind, ProactiveAction } from '../../types/goals';
import type { PublishingDraft, PublishingFeed } from '../../types/publishing';

export const DECIDE_KEY = ['today', 'decide'] as const;

export function useDecide() {
  return useQuery({ queryKey: DECIDE_KEY, queryFn: async (): Promise<DecideItem[]> => requireApiData(await api.getDecideQueue()), refetchInterval: 60_000 });
}

const KIND_LABEL: Record<DecideKind, string> = {
  publishing: 'Publishing', decision: 'Open question', promise: 'Promise', chase: 'Chase', cadence: 'Keep in touch',
  cfp: 'CFP', paused: 'Paused', email: 'Unsent draft', waiting: 'Waiting on',
};
const day = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function decideMeta(item: DecideItem): string {
  return [KIND_LABEL[item.kind], item.source.replace(/^[^·]*·\s*/, '') || null, item.held ? 'Held' : null, day(item.createdAt)].filter(Boolean).join(' · ');
}

/** Compact queue for Athena's page context; refIds work with manage_decide_queue, manage_proactive and manage_publishing_feeds. */
export function decideContext(items: DecideItem[] | undefined): string {
  if (!items) return 'Decide queue: not loaded yet; use manage_decide_queue list.';
  if (items.length === 0) return 'Decide queue: empty.';
  return `Decide queue (${items.length}, oldest first; manage_decide_queue list returns every item):\n${items.map(i =>
    `- [${i.kind} ${i.refId}] ${i.title}${i.held ? ' (held)' : ''} — ${i.source}, ${day(i.createdAt)}${i.kind === 'waiting' ? ` · task: ${String(i.meta.taskTitle)}` : ''}`).join('\n')}`;
}

type Run = { kind: 'decide'; action: DecideAction; waitingOn?: string } | { kind: 'proactive'; action: ProactiveAction };

function useDecideAction(item: DecideItem) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (run: Run) => run.kind === 'decide'
      ? requireApiData(await api.decideAction(run.action, { id: item.refId, ...(run.waitingOn ? { waitingOn: run.waitingOn } : {}) }))
      : requireApiData(await api.proactiveAction(run.action, { id: item.refId })),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: DECIDE_KEY }), qc.invalidateQueries({ queryKey: PROACTIVE_KEY }),
        qc.invalidateQueries({ queryKey: ['tasks'] }), qc.invalidateQueries({ queryKey: ['work-drafts'] }), qc.invalidateQueries({ queryKey: ['today'] })]);
    },
  });
}

function Buttons({ m, buttons }: { m: ReturnType<typeof useDecideAction>; buttons: Array<{ label: string; busy: string; run: Run; primary?: boolean }> }): React.ReactElement {
  const pending = (r: Run): boolean => m.isPending && m.variables?.action === r.action;
  return <div className="today-brief__actions">
    {buttons.map(b => <button key={b.label} type="button" className={b.primary ? 'today-brief__primary' : 'today-brief__quiet'} disabled={m.isPending}
      onClick={() => { m.mutate(b.run); }}>{pending(b.run) ? b.busy : b.label}</button>)}
  </div>;
}

function WaitingDetail({ item, m }: { item: DecideItem; m: ReturnType<typeof useDecideAction> }): React.ReactElement {
  const [who, setWho] = useState(str(item.meta.suggestion) ?? '');
  const inputId = `decide-waiting-${item.refId}`;
  return <>
    <p className="today-brief__reason">{str(item.meta.suggestion) ? 'Athena suggests this from the task and its notes. Confirm, change it, or skip.' : 'Athena found no name in the task or its notes. Add who you are waiting on, or skip.'}</p>
    <form className="today-goals__record" onSubmit={e => { e.preventDefault(); if (who.trim()) m.mutate({ kind: 'decide', action: 'waiting-on', waitingOn: who.trim() }); }}>
      <label className="today-brief__sr" htmlFor={inputId}>Waiting on</label>
      <input id={inputId} value={who} maxLength={200} placeholder="Person, team or organisation" onChange={e => { setWho(e.target.value); }} />
      <button type="submit" className="today-brief__primary" disabled={m.isPending || !who.trim()}>{m.isPending && m.variables?.action === 'waiting-on' ? 'Saving...' : 'Confirm'}</button>
      <button type="button" className="today-brief__quiet" disabled={m.isPending} onClick={() => { m.mutate({ kind: 'decide', action: 'waiting-skip' }); }}>Skip</button>
    </form>
    <div className="today-brief__actions"><Link className="today-brief__quiet" to={`/plan?taskId=${encodeURIComponent(item.refId)}`}>Open task <ArrowRight size={16} /></Link></div>
  </>;
}

function PublishingDetail({ item }: { item: DecideItem }): React.ReactElement {
  const qc = useQueryClient();
  const feeds = useQuery({ queryKey: ['publishing', 'feeds'], queryFn: () => api.publishing<PublishingFeed[]>('/feeds') });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const act = async (path: string, method: 'POST' | 'PUT', body: unknown): Promise<boolean> => {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.publishing<unknown>(path, method, body);
      await Promise.all([qc.invalidateQueries({ queryKey: ['publishing'] }), qc.invalidateQueries({ queryKey: DECIDE_KEY })]);
      setMessage(path.endsWith('/decision') ? 'Decision saved. Approved posts appear in Discover › Publishing › Scheduling.' : 'Saved.');
      return true;
    } catch (err) { setError(describeApiError(err)); return false; } finally { setBusy(false); }
  };
  const topicId = str(item.meta.topicId);
  return <>
    <p className="today-brief__reason"><strong>Why today:</strong> {item.detail}</p>
    {message && <p className="today-brief__meta" role="status">{message}</p>}
    {error && <p className="today-brief__error" role="alert">{error}</p>}
    {topicId && <div className="kh-publishing today-decide__review"><TopicReview key={item.refId} id={topicId} act={act} busy={busy} feeds={feeds.data ?? []}
      initialDestination={(str(item.meta.destination) as PublishingDraft['destination'] | null) ?? null} /></div>}
  </>;
}

export function DecideDetail({ item, onAsk }: { item: DecideItem; onAsk: () => void }): React.ReactElement {
  const m = useDecideAction(item);
  const draftId = str(item.meta.draftId);
  const d = (action: DecideAction, label: string, busy: string, primary = false) => ({ label, busy, run: { kind: 'decide', action } as Run, primary });
  const p = (action: ProactiveAction, label: string, busy: string, primary = false) => ({ label, busy, run: { kind: 'proactive', action } as Run, primary });
  return (
    <article className="today-decide__detail" aria-label={KIND_LABEL[item.kind]}>
      <p className="today-goals__eyebrow">{KIND_LABEL[item.kind]}{item.held ? ' · held for your next peak window' : ''}</p>
      <h3 className="today-decide__title">{item.title}</h3>
      <p className="today-brief__meta">{item.source} · {day(item.createdAt)}</p>
      {item.detail && item.kind !== 'publishing' && <p className="today-brief__reason">{item.detail}</p>}
      {item.kind === 'publishing' && <PublishingDetail item={item} />}
      {item.kind === 'waiting' && <WaitingDetail key={item.refId} item={item} m={m} />}
      {item.kind === 'decision' && <>
        <Buttons m={m} buttons={[d('decision-decided', 'Mark decided', 'Saving...', true), d('decision-task', 'Make a task', 'Creating...'),
          d('decision-note', 'Make a note', 'Creating...'), d('decision-spark', 'Make a Spark', 'Creating...'), d('decision-drop', 'Drop', 'Dropping...')]} />
        <div className="today-brief__actions"><Link className="today-brief__quiet" to={`/chat?session=${encodeURIComponent(String(item.meta.sessionId))}`}>Open the chat <ArrowRight size={16} /></Link></div>
      </>}
      {item.kind === 'promise' && <Buttons m={m} buttons={[p('accept-promise', item.meta.owner === 'richard' ? 'Accept: make a task and draft' : 'Accept: track as waiting on', 'Accepting...', true), p('dismiss-promise', 'Dismiss', 'Dismissing...')]} />}
      {item.kind === 'chase' && <Buttons m={m} buttons={[p('accept-chase', draftId ? 'Accept chase' : 'Accept: create draft', 'Accepting...', true), p('dismiss-chase', 'Dismiss chase', 'Dismissing...')]} />}
      {item.kind === 'cadence' && <Buttons m={m} buttons={[p('accept-cadence', 'Accept: make a task and draft', 'Accepting...', true), p('dismiss-cadence', 'Dismiss', 'Dismissing...')]} />}
      {item.kind === 'cfp' && <>
        <Buttons m={m} buttons={[p('confirm-cfp', 'Confirm: schedule abstract', 'Confirming...', true), p('dismiss-cfp', 'Dismiss', 'Dismissing...')]} />
        {str(item.meta.cfpUrl) && <div className="today-brief__actions"><a className="today-brief__quiet" href={String(item.meta.cfpUrl)} target="_blank" rel="noreferrer">Open CFP <ArrowRight size={16} /></a></div>}
      </>}
      {item.kind === 'paused' && <Buttons m={m} buttons={[p('resume-paused', 'Try again', 'Resuming...', true), p('stop-paused', 'Leave stopped', 'Saving...')]} />}
      {item.kind === 'email' && <Buttons m={m} buttons={[d('draft-delete', 'Delete draft', 'Deleting...')]} />}
      {(item.kind === 'email' || draftId) && <div className="today-brief__actions">
        <Link className="today-brief__quiet" to={`/plan?view=drafts&draft=${encodeURIComponent(item.kind === 'email' ? item.refId : draftId ?? '')}`}>Open draft <ArrowRight size={16} /></Link></div>}
      {str(item.meta.taskId) && item.kind !== 'waiting' && <div className="today-brief__actions">
        <Link className="today-brief__quiet" to={`/plan?taskId=${encodeURIComponent(String(item.meta.taskId))}`}>Open task <ArrowRight size={16} /></Link></div>}
      {m.isError && <p className="today-brief__error" role="alert">{describeApiError(m.error)}</p>}
      <div className="today-brief__actions"><button type="button" className="today-brief__quiet" onClick={onAsk}>Ask Athena</button></div>
    </article>
  );
}
