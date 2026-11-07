/**
 * components/today/Goals.tsx — "Your goals" on Today: live health for Richard's four goals, the Monday move per goal
 * (with any draft or research Athena prepared), and the Friday scorecard with honest dates and one tidy-up batch.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Renew } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { CfpShortlist, DealDesk, ProposalLedger } from './Proactive';
import type { GoalHealth, GoalMove, GoalStatus, GoalsOverview, MeasureStatus, Scorecard, TidyItem, TidyKind } from '../../types/goals';

export const GOALS_KEY = ['today', 'goals'] as const;
const POLL_MS = 4_000;
const HEALTH: Record<GoalHealth, string> = { 'on-track': 'On track', 'at-risk': 'At risk', slipping: 'Slipping' };
const TIDY_GROUPS: Array<{ kind: TidyKind; label: string }> = [
  { kind: 'archive-task', label: 'Archive stale tasks' },
  { kind: 'drop-decision', label: 'Drop stale decisions' },
  { kind: 'file-note', label: 'File notes' },
  { kind: 'file-chat', label: 'File chats' },
  { kind: 'cull-draft', label: 'Cull stale drafts' },
];

const date = (iso: string, withTime = false): string => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleString('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });

export function useGoals() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: GOALS_KEY,
    queryFn: async (): Promise<GoalsOverview> => requireApiData(await api.getGoals()),
    refetchInterval: q => (q.state.data?.briefRunning || q.state.data?.scorecardRunning ? POLL_MS : false),
  });
  const refresh = useMutation({
    mutationFn: async (which: 'brief' | 'scorecard') => requireApiData(await api.refreshGoals(which)),
    onSuccess: data => { qc.setQueryData(GOALS_KEY, data); },
  });
  return { query, refresh, data: query.data ?? null };
}

function useGoalAction<T>(fn: (input: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: GOALS_KEY }), qc.invalidateQueries({ queryKey: ['tasks'] }), qc.invalidateQueries({ queryKey: ['today'] })]);
    },
  });
}

export function goalMove(data: GoalsOverview | null, goalId: string): GoalMove | null {
  return data?.brief?.current ? data.brief.moves.find(m => m.goalId === goalId) ?? null : null;
}

export function goalsContext(data: GoalsOverview | null): string {
  if (!data) return 'Goals: not loaded yet; use manage_goals status.';
  const lines = data.goals.map(g => {
    const move = goalMove(data, g.id);
    return `- ${g.name} [${g.id}] ${HEALTH[g.health]}: ${g.measures.map(m => `${m.label}: ${m.summary}`).join('; ')}. ${g.openTasks} open, ${g.overdueTasks} overdue.${move ? ` This week's move [${move.id}] (${move.status}): ${move.title}.` : ''}`;
  });
  const card = data.scorecard?.current ? `\nFriday scorecard ${data.scorecard.week}: ${data.scorecard.athena.summary} Tidy-up: ${data.scorecard.tidy.items.length} items${data.scorecard.tidy.appliedAt ? ', applied' : ', awaiting approval'}.` : '';
  return `Your goals (manage_goals status returns full measures, moves, scorecard and tidy items):\n${lines.join('\n')}${card}`;
}

export function goalListMeta(goal: GoalStatus): string {
  const lead = goal.measures.find(m => m.health === goal.health) ?? goal.measures[0];
  return [HEALTH[goal.health], lead?.summary].filter(Boolean).join(' · ');
}

function Health({ health }: { health: GoalHealth }): React.ReactElement {
  return <span className={`today-goals__health today-goals__health--${health}`}><span aria-hidden="true" />{HEALTH[health]}</span>;
}

function Generate({ which, goals }: { which: 'brief' | 'scorecard'; goals: ReturnType<typeof useGoals> }): React.ReactElement {
  const running = (which === 'brief' ? goals.data?.briefRunning : goals.data?.scorecardRunning) ?? false;
  const failed = which === 'brief' ? goals.data?.briefError : goals.data?.scorecardError;
  const pending = running || (goals.refresh.isPending && goals.refresh.variables === which);
  return <>
    <button type="button" className="today-brief__quiet" disabled={pending} onClick={() => { goals.refresh.mutate(which); }}>
      <Renew size={16} /> {pending ? 'Athena is working...' : which === 'brief' ? 'Choose this week\'s moves' : 'Score this week'}
    </button>
    {pending && <p className="today-brief__meta" role="status">{which === 'brief' ? 'Choosing one move per goal and preparing drafts. This takes a minute or two.' : 'Scoring the week and preparing the tidy-up. This takes a minute or two.'}</p>}
    {failed && !pending && <p className="today-brief__error" role="alert">{failed}</p>}
    {goals.refresh.isError && goals.refresh.variables === which && <p className="today-brief__error" role="alert">{describeApiError(goals.refresh.error)}</p>}
  </>;
}

function MeasureRow({ m }: { m: MeasureStatus }): React.ReactElement {
  const [note, setNote] = useState('');
  const record = useGoalAction((input: { count?: number; done?: boolean }) => api.recordGoalProgress({ measureId: m.id, ...input, ...(note.trim() ? { note: note.trim() } : {}) })
    .then(r => { requireApiData(r); setNote(''); }));
  const unit = (m.unit ?? '').replace(/s$/, '');
  return (
    <li className="today-goals__measure">
      <div className="today-goals__measure-top"><span className="today-goals__measure-label">{m.label}</span><Health health={m.health} /></div>
      <p className="today-brief__reason">{m.summary}</p>
      {m.recent[0] && <p className="today-brief__meta">Last recorded {date(m.recent[0].at)}{m.recent[0].note ? ` · ${m.recent[0].note}` : ''}{m.recent[0].actor === 'athena' ? ' · by Athena' : ''}</p>}
      {m.manual && <div className="today-goals__record">
        <label className="today-brief__sr" htmlFor={`goal-note-${m.id}`}>Note for {m.label}</label>
        <input id={`goal-note-${m.id}`} value={note} maxLength={200} placeholder="Optional note, e.g. who it went to" onChange={e => { setNote(e.target.value); }} />
        {m.kind === 'count'
          ? <>
            <button type="button" className="today-brief__primary" disabled={record.isPending} onClick={() => { record.mutate({ count: 1 }); }}>{record.isPending ? 'Saving...' : `Record a ${unit}`}</button>
            <button type="button" className="today-brief__quiet" disabled={record.isPending || !m.value} onClick={() => { record.mutate({ count: -1 }); }}>Undo one</button>
          </>
          : <button type="button" className="today-brief__primary" disabled={record.isPending} onClick={() => { record.mutate({ done: !m.done }); }}>{record.isPending ? 'Saving...' : m.done ? 'Mark not submitted' : 'Mark submitted'}</button>}
      </div>}
      {record.isError && <p className="today-brief__error" role="alert">{describeApiError(record.error)}</p>}
    </li>
  );
}

function MoveBlock({ move }: { move: GoalMove }): React.ReactElement {
  const decide = useGoalAction((decision: 'accept' | 'dismiss') => api.decideGoalMove(move.id, decision).then(requireApiData));
  const taskId = move.acceptedTaskId ?? move.taskId;
  return (
    <section className="today-goals__move" aria-labelledby={`move-${move.id}`}>
      <div className="today-goals__eyebrow">This week's move{move.status !== 'proposed' && <span className="today-goals__decided"> · {move.status === 'accepted' ? 'Accepted' : 'Not this week'}</span>}</div>
      <h4 id={`move-${move.id}`}>{move.title}</h4>
      <p className="today-brief__reason">{move.reason}</p>
      {move.prepDetail && <p className={`today-brief__meta${move.prepStatus === 'failed' ? ' today-goals__failed' : ''}`}>{move.prepDetail}</p>}
      <div className="today-brief__actions">
        {move.status === 'proposed' && <>
          <button type="button" className="today-brief__primary" disabled={decide.isPending} onClick={() => { decide.mutate('accept'); }}>
            {decide.isPending && decide.variables === 'accept' ? 'Accepting...' : move.taskId ? 'Accept and start' : 'Accept and create task'}</button>
          <button type="button" className="today-brief__quiet" disabled={decide.isPending} onClick={() => { decide.mutate('dismiss'); }}>Not this week</button>
        </>}
        {move.draftId && <Link className="today-brief__quiet" to={`/plan?view=drafts&draft=${encodeURIComponent(move.draftId)}`}>Open draft <ArrowRight size={16} /></Link>}
        {taskId && <Link className="today-brief__quiet" to={`/plan?taskId=${encodeURIComponent(taskId)}`}>Open task <ArrowRight size={16} /></Link>}
      </div>
      {decide.isError && <p className="today-brief__error" role="alert">{describeApiError(decide.error)}</p>}
    </section>
  );
}

export function GoalDetail({ goal, goals, onAsk }: { goal: GoalStatus; goals: ReturnType<typeof useGoals>; onAsk: () => void }): React.ReactElement {
  const move = goalMove(goals.data, goal.id);
  const brief = goals.data?.brief;
  return (
    <article className="today-brief__item today-goals">
      <div className="today-brief__item-top"><span className="today-brief__meta">{goal.projects.map(p => p.name).join(' · ') || 'Across all work'}</span><Health health={goal.health} /></div>
      <h3>{goal.name}</h3>
      <p className="today-brief__reason">{goal.why}</p>
      {goal.projects.length > 0 && <p className="today-brief__meta">{goal.openTasks} open task{goal.openTasks === 1 ? '' : 's'}{goal.overdueTasks ? ` · ${goal.overdueTasks} overdue` : ''}</p>}
      <ul className="today-goals__measures" aria-label="Measures">{goal.measures.map(m => <MeasureRow key={m.id} m={m} />)}</ul>
      {move ? <MoveBlock move={move} />
        : <section className="today-goals__move"><div className="today-goals__eyebrow">This week's move</div>
          <p className="today-brief__empty">{brief?.current ? 'Athena found no move worth making for this goal this week.' : 'No moves chosen for this week yet. Athena chooses them on Monday at 08:45.'}</p></section>}
      {goal.id === 'imagine' && <DealDesk />}
      {goal.id === 'voice' && <CfpShortlist />}
      <div className="today-brief__actions">
        <Generate which="brief" goals={goals} />
        <button type="button" className="today-brief__quiet" onClick={onAsk}>Ask Athena</button>
      </div>
      {brief?.current && <p className="today-brief__meta">Moves chosen {date(brief.generatedAt, true)}. Nothing is sent and no task is created until you accept.</p>}
    </article>
  );
}

function TidyBatch({ card }: { card: Scorecard }): React.ReactElement {
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(card.tidy.excluded));
  const apply = useGoalAction(() => api.applyGoalTidy([...excluded]).then(requireApiData));
  const undo = useGoalAction(() => api.undoGoalTidy(card.tidy.batchId ?? '').then(requireApiData));
  const { items, appliedAt, undoneAt } = card.tidy;
  const chosen = items.filter(i => !excluded.has(i.id)).length;
  const toggle = (item: TidyItem): void => { setExcluded(prev => { const next = new Set(prev); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }); };
  return (
    <section className="today-goals__tidy" aria-labelledby="goals-tidy">
      <h4 id="goals-tidy">Tidy-up</h4>
      {card.tidy.note && <p className="today-brief__meta">{card.tidy.note}</p>}
      {items.length === 0 ? <p className="today-brief__empty">Nothing needs tidying this week.</p> : <>
        {appliedAt
          ? <p className="today-brief__reason">{undoneAt ? `Applied ${date(appliedAt, true)} and undone ${date(undoneAt, true)}.` : `Applied ${date(appliedAt, true)}: ${card.tidy.applied} change${card.tidy.applied === 1 ? '' : 's'}.`}</p>
          : <p className="today-brief__reason">Untick anything you want left alone. Nothing changes until you approve, and you can undo for 30 days.</p>}
        {TIDY_GROUPS.map(({ kind, label }) => {
          const group = items.filter(i => i.kind === kind);
          return group.length ? <fieldset key={kind} className="today-goals__tidy-group" disabled={Boolean(appliedAt) || apply.isPending}>
            <legend>{label} <span className="today-brief__meta">({group.length})</span></legend>
            {group.map(item => <label key={item.id} className="today-goals__tidy-item">
              <input type="checkbox" checked={!excluded.has(item.id)} onChange={() => { toggle(item); }} />
              <span><span className="today-goals__tidy-title">{item.title}</span><span className="today-brief__meta">{item.detail}</span></span>
            </label>)}
          </fieldset> : null;
        })}
        <div className="today-brief__actions">
          {!appliedAt && <button type="button" className="today-brief__primary" disabled={apply.isPending || chosen === 0} onClick={() => { apply.mutate(undefined); }}>
            {apply.isPending ? 'Applying...' : `Approve ${chosen} change${chosen === 1 ? '' : 's'}`}</button>}
          {card.undoUntil && <button type="button" className="today-brief__quiet" disabled={undo.isPending} onClick={() => { undo.mutate(undefined); }}>
            {undo.isPending ? 'Undoing...' : `Undo tidy-up (until ${date(card.undoUntil)})`}</button>}
        </div>
      </>}
      {apply.isError && <p className="today-brief__error" role="alert">{describeApiError(apply.error)}</p>}
      {undo.isError && <p className="today-brief__error" role="alert">{describeApiError(undo.error)}</p>}
    </section>
  );
}

function DateRow({ p }: { p: Scorecard['goals'][number]['dateProposals'][number] }): React.ReactElement {
  const decide = useGoalAction((decision: 'accept' | 'dismiss') => api.decideGoalDate(p.id, decision).then(requireApiData));
  return (
    <li className="today-goals__date">
      <Link to={`/plan?taskId=${encodeURIComponent(p.taskId)}`} className="today-goals__tidy-title">{p.taskTitle}</Link>
      <span className="today-brief__meta">Due {date(p.currentDue)} → <strong>{date(p.proposedDue)}</strong>. {p.reason}</span>
      {p.status === 'proposed'
        ? <div className="today-brief__actions">
          <button type="button" className="today-brief__primary" disabled={decide.isPending} onClick={() => { decide.mutate('accept'); }}>{decide.isPending && decide.variables === 'accept' ? 'Saving...' : 'Use this date'}</button>
          <button type="button" className="today-brief__quiet" disabled={decide.isPending} onClick={() => { decide.mutate('dismiss'); }}>Keep current date</button>
        </div>
        : <span className="today-goals__decided">{p.status === 'accepted' ? 'Date changed' : 'Kept current date'}</span>}
      {decide.isError && <p className="today-brief__error" role="alert">{describeApiError(decide.error)}</p>}
    </li>
  );
}

export function ScorecardDetail({ goals, onAsk }: { goals: ReturnType<typeof useGoals>; onAsk: () => void }): React.ReactElement {
  const card = goals.data?.scorecard ?? null;
  return (
    <article className="today-brief__item today-goals">
      <div className="today-brief__item-top"><span className="today-brief__meta">{card ? `Week of ${date(card.week)} · scored ${date(card.generatedAt, true)}` : 'Friday 16:00'}</span></div>
      <h3>Friday scorecard</h3>
      {!card ? <p className="today-brief__empty">No scorecard yet. Athena scores the week on Friday at 16:00, or score it now.</p> : <>
        {!card.current && <p className="today-brief__meta">This scorecard is from a previous week.</p>}
        <ul className="today-goals__scores">{card.goals.map(g => <li key={g.goalId}>
          <div className="today-goals__measure-top"><span className="today-goals__measure-label">{g.goalName}</span>
            <span className="today-goals__trend">{g.healthAtBrief && g.healthAtBrief !== g.health && <span className="today-brief__meta">{HEALTH[g.healthAtBrief]} →</span>}<Health health={g.health} /></span></div>
          <p className="today-brief__reason">{g.summary}</p>
          <p className="today-brief__meta">{g.completedCount} completed this week{g.overdueCount ? ` · ${g.overdueCount} overdue` : ''}{g.move ? ` · Move: ${g.move.done ? 'done' : g.move.status === 'accepted' ? 'accepted, not done' : g.move.status === 'dismissed' ? 'not this week' : 'unanswered'}` : ''}</p>
          {g.dateProposals.length > 0 && <ul className="today-goals__dates" aria-label={`Honest dates for ${g.goalName}`}>{g.dateProposals.map(p => <DateRow key={p.id} p={p} />)}</ul>}
        </li>)}</ul>
        <section className="today-goals__athena" aria-labelledby="goals-athena"><h4 id="goals-athena">Athena's week</h4><p className="today-brief__reason">{card.athena.summary}</p></section>
        <TidyBatch key={`${card.week}:${card.generatedAt}`} card={card} />
      </>}
      <ProposalLedger />
      <div className="today-brief__actions">
        <Generate which="scorecard" goals={goals} />
        <button type="button" className="today-brief__quiet" onClick={onAsk}>Ask Athena</button>
      </div>
    </article>
  );
}
