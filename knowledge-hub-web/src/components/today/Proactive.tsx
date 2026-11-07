/**
 * components/today/Proactive.tsx — Phase 2/3 proactive Athena: the Imagine deal desk, meeting prep with promises,
 * chases and keep-in-touch nudges, content packages, the CFP shortlist and Athena's self-report.
 * Everything reads GET /api/today/proactive and acts through the same actions as Athena's manage_proactive tool.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Renew } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import type { CadenceNudge, ChaseProposal, ContentPackage, PrepCard, ProactiveAction, ProactiveOverview, PromiseProposal } from '../../types/goals';

export const PROACTIVE_KEY = ['today', 'proactive'] as const;
const POLL_MS = 4_000;

const when = (iso: string, withTime = false): string => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleString('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
const noteLink = (id: string): string => `/think?note=${encodeURIComponent(id)}`;
const draftLink = (id: string): string => `/plan?view=drafts&draft=${encodeURIComponent(id)}`;
const taskLink = (id: string): string => `/plan?taskId=${encodeURIComponent(id)}`;

export function useProactive() {
  return useQuery({
    queryKey: PROACTIVE_KEY,
    queryFn: async (): Promise<ProactiveOverview> => requireApiData(await api.getProactive()),
    refetchInterval: q => (q.state.data?.deals.running || q.state.data?.meetingPrep.running
      || q.state.data?.packages.some(p => p.status === 'drafting' || p.status === 'in-review') ? POLL_MS : false),
  });
}

function useProactiveAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, args }: { action: ProactiveAction; args?: Record<string, unknown>; key?: string }) => requireApiData(await api.proactiveAction(action, args)),
    onSuccess: async data => {
      qc.setQueryData(PROACTIVE_KEY, data.overview);
      await Promise.all([qc.invalidateQueries({ queryKey: ['tasks'] }), qc.invalidateQueries({ queryKey: ['work-drafts'] }), qc.invalidateQueries({ queryKey: ['today', 'goals'] })]);
    },
  });
}

/** Compact summary for Athena's page context; manage_proactive status returns the full records. */
export function proactiveContext(data: ProactiveOverview | undefined): string {
  if (!data) return 'Proactive work: not loaded yet; use manage_proactive status.';
  const deals = data.deals.rows.map(d => `- ${d.name} [${d.projectId}]${d.noteId ? ` brief note ${d.noteId}` : ' no brief yet'}${d.latest ? `; latest change ${when(d.latest.createdAt, true)}: ${d.latest.summary}${d.latest.undoneAt ? ' (undone)' : ''} [update ${d.latest.id}]` : ''}`);
  const prep = data.meetingPrep;
  const open = <T extends { status: string }>(xs: T[]): T[] => xs.filter(x => x.status === 'proposed');
  const lines = [
    `Deal desk${data.deals.running ? ' (updating now)' : ''}:\n${deals.join('\n')}`,
    `Meeting prep${prep.reportDate ? ` from the ${prep.reportDate} briefing` : ''}: ${prep.cards.map(c => `${c.time} ${c.meeting} [${c.id}]`).join('; ') || 'no cards'}.`,
    `Promises awaiting a decision: ${open(prep.promises).map(p => `[${p.id}] ${p.owner === 'richard' ? 'Richard' : p.who} — ${p.text}`).join('; ') || 'none'}.`,
    `Chases: ${open(prep.chases).map(c => `[${c.id}] ${c.taskTitle} (${c.waitingOn ? `waiting on ${c.waitingOn}, ` : ''}${c.workingDays} working days)`).join('; ') || 'none'}.`,
    `Keep-in-touch: ${open(prep.cadence).map(c => `[${c.id}] ${c.person}, ${c.workingDays} working days`).join('; ') || 'none'}.`,
    `Content packages: ${data.packages.map(p => `[${p.id}] ${p.title} (${p.status})`).join('; ') || 'none'}.`,
    `CFP shortlist: ${data.cfps.shortlist.map(c => `[${c.id}] ${c.conference}, deadline ${when(c.deadline)}`).join('; ') || 'none'}. Scheduled: ${data.cfps.scheduled.map(s => `${s.conference} abstract due ${when(s.dueAt)}`).join('; ') || 'none'}.`,
    `Athena's proposals since ${when(data.ledger.since)}: ${data.ledger.proposed} proposed, ${data.ledger.accepted} accepted, ${data.ledger.open} awaiting a decision, ${data.ledger.ignored} ignored, ${data.ledger.dismissed} rejected. Stopped: ${data.ledger.stopped.map(s => s.label).join(', ') || 'none'}.`,
  ];
  return `Proactive work (manage_proactive status returns everything):\n${lines.join('\n')}`;
}

function ActionError({ m }: { m: ReturnType<typeof useProactiveAction> }): React.ReactElement | null {
  return m.isError ? <p className="today-brief__error" role="alert">{describeApiError(m.error)}</p> : null;
}
const busy = (m: ReturnType<typeof useProactiveAction>, key: string): boolean => m.isPending && m.variables?.key === key;

/** Imagine goal: one row per opportunity with its latest logged change, Undo and Open brief. */
export function DealDesk(): React.ReactElement {
  const q = useProactive();
  const act = useProactiveAction();
  const data = q.data?.deals;
  const running = Boolean(data?.running) || busy(act, 'run');
  return (
    <section className="today-goals__section" aria-labelledby="deal-desk">
      <h4 id="deal-desk">Deal desk</h4>
      {q.isPending && <p className="today-brief__meta" role="status">Loading deal briefs...</p>}
      {q.isError && <p className="today-brief__error" role="alert">{describeApiError(q.error)}</p>}
      {data && <ul className="today-proactive__rows">{data.rows.map(row => {
        const u = row.latest;
        return <li key={row.projectId} className="today-proactive__row">
          <div className="today-goals__measure-top"><span className="today-goals__measure-label">{row.name}</span>
            {u && <span className="today-brief__meta">{when(u.createdAt, true)}</span>}</div>
          <p className="today-brief__reason">{u ? (u.undoneAt ? `Undone: ${u.summary}` : u.summary) : row.noteId ? 'No changes logged yet.' : 'No brief yet. Athena creates it on the next run.'}</p>
          {u && u.changes.length > 0 && !u.undoneAt && <p className="today-brief__meta">Changed: {u.changes.map(c => c.section).join(', ')}</p>}
          <div className="today-brief__actions">
            {row.noteId && <Link className="today-brief__quiet" to={noteLink(row.noteId)}>Open brief <ArrowRight size={16} /></Link>}
            {u?.draftId && <Link className="today-brief__quiet" to={draftLink(u.draftId)}>Open follow-up draft <ArrowRight size={16} /></Link>}
            {u?.canUndo && <button type="button" className="today-brief__quiet" disabled={act.isPending}
              onClick={() => { act.mutate({ action: 'undo-deal-update', args: { updateId: u.id }, key: `undo:${u.id}` }); }}>
              {busy(act, `undo:${u.id}`) ? 'Undoing...' : 'Undo'}</button>}
          </div>
        </li>;
      })}</ul>}
      <div className="today-brief__actions">
        <button type="button" className="today-brief__quiet" disabled={running} onClick={() => { act.mutate({ action: 'run-deal-desk', key: 'run' }); }}>
          <Renew size={16} /> {running ? 'Athena is updating the briefs...' : 'Update deal briefs now'}</button>
      </div>
      <p className="today-brief__meta">Athena edits each brief directly every weekday at 10:30 and logs every change. Follow-ups are drafts; nothing is sent.</p>
      <ActionError m={act} />
    </section>
  );
}

/** Voice goal: 3–5 CFPs worth Richard's time, plus confirmed CFPs with their abstract schedule. */
export function CfpShortlist(): React.ReactElement {
  const q = useProactive();
  const act = useProactiveAction();
  const cfps = q.data?.cfps;
  return (
    <section className="today-goals__section" aria-labelledby="cfp-shortlist">
      <h4 id="cfp-shortlist">CFP shortlist</h4>
      {q.isPending && <p className="today-brief__meta" role="status">Loading CFPs...</p>}
      {q.isError && <p className="today-brief__error" role="alert">{describeApiError(q.error)}</p>}
      {cfps && (cfps.shortlist.length === 0
        ? <p className="today-brief__empty">No open CFP is a strong enough fit right now.</p>
        : <ul className="today-proactive__rows">{cfps.shortlist.map(c => <li key={c.id} className="today-proactive__row">
          <div className="today-goals__measure-top"><a className="today-goals__tidy-title" href={c.cfpUrl} target="_blank" rel="noreferrer">{c.conference}</a>
            <span className="today-brief__meta">Deadline {when(c.deadline)}</span></div>
          <p className="today-brief__reason">{c.fit || 'Strong fit for your themes.'}</p>
          <p className="today-brief__meta">{[c.isVirtual ? 'Virtual' : c.location, c.eventStart ? `Event ${when(c.eventStart)}` : null].filter(Boolean).join(' · ')}</p>
          <div className="today-brief__actions">
            <button type="button" className="today-brief__primary" disabled={act.isPending} onClick={() => { act.mutate({ action: 'confirm-cfp', args: { id: c.id }, key: `confirm:${c.id}` }); }}>
              {busy(act, `confirm:${c.id}`) ? 'Confirming...' : 'Confirm'}</button>
            <button type="button" className="today-brief__quiet" disabled={act.isPending} onClick={() => { act.mutate({ action: 'dismiss-cfp', args: { id: c.id }, key: `dismiss:${c.id}` }); }}>Not this one</button>
          </div>
        </li>)}</ul>)}
      {cfps && cfps.scheduled.length > 0 && <>
        <div className="today-goals__eyebrow">Confirmed</div>
        <ul className="today-proactive__rows">{cfps.scheduled.map(s => <li key={s.cfpId} className="today-proactive__row">
          <span className="today-goals__measure-label">{s.conference}</span>
          <p className="today-brief__meta">{s.error ? <span className="today-goals__failed">{s.error}</span>
            : s.noteId ? 'Abstract drafted.' : `Athena drafts the abstract on ${when(s.dueAt)}.`} Deadline {when(s.deadline)}.</p>
          <div className="today-brief__actions">
            {s.noteId && <Link className="today-brief__quiet" to={noteLink(s.noteId)}>Open abstract <ArrowRight size={16} /></Link>}
            {s.taskId && <Link className="today-brief__quiet" to={taskLink(s.taskId)}>Open task <ArrowRight size={16} /></Link>}
          </div>
        </li>)}</ul>
      </>}
      <p className="today-brief__meta">Confirming schedules an abstract and a submission task three weeks before the deadline. Athena never submits.</p>
      <ActionError m={act} />
    </section>
  );
}

function PrepCardView({ card }: { card: PrepCard }): React.ReactElement {
  const list = (label: string, xs: string[]): React.ReactElement | null => xs.length ? <div className="today-proactive__list">
    <span className="today-proactive__label">{label}</span><ul>{xs.map(x => <li key={x}>{x}</li>)}</ul></div> : null;
  return (
    <li className="today-proactive__card">
      <div className="today-goals__measure-top"><span className="today-goals__measure-label">{card.meeting}</span><span className="today-brief__meta">{card.time}</span></div>
      {card.attendees.length > 0 && <p className="today-brief__meta">With {card.attendees.join(', ')}</p>}
      {card.lastExchange && <p className="today-brief__reason"><span className="today-proactive__label">Last exchange</span> {card.lastExchange}</p>}
      {list('You promised', card.ourPromises)}
      {list('They promised', card.theirPromises)}
      {list('Talking points', card.talkingPoints)}
      {card.dealNoteId && <div className="today-brief__actions"><Link className="today-brief__quiet" to={noteLink(card.dealNoteId)}>Open deal brief <ArrowRight size={16} /></Link></div>}
    </li>
  );
}

function Decision({ p, act, accept, dismiss, acceptLabel, children }: {
  p: PromiseProposal | CadenceNudge | ChaseProposal; act: ReturnType<typeof useProactiveAction>;
  accept?: ProactiveAction; dismiss: ProactiveAction; acceptLabel?: string; children: React.ReactNode;
}): React.ReactElement {
  const taskId = 'taskId' in p && p.status !== 'proposed' ? p.taskId : null;
  return (
    <li className="today-goals__date">
      {children}
      {p.status === 'proposed'
        ? <div className="today-brief__actions">
          {accept && <button type="button" className="today-brief__primary" disabled={act.isPending} onClick={() => { act.mutate({ action: accept, args: { id: p.id }, key: `a:${p.id}` }); }}>
            {busy(act, `a:${p.id}`) ? 'Creating...' : acceptLabel}</button>}
          {'draftId' in p && p.draftId && !accept && <Link className="today-brief__quiet" to={draftLink(p.draftId)}>Open draft <ArrowRight size={16} /></Link>}
          <button type="button" className="today-brief__quiet" disabled={act.isPending} onClick={() => { act.mutate({ action: dismiss, args: { id: p.id }, key: `d:${p.id}` }); }}>
            {busy(act, `d:${p.id}`) ? 'Saving...' : 'Dismiss'}</button>
        </div>
        : <div className="today-brief__actions"><span className="today-goals__decided">{p.status === 'accepted' ? 'Accepted' : 'Dismissed'}</span>
          {taskId && <Link className="today-brief__quiet" to={taskLink(taskId)}>Open task <ArrowRight size={16} /></Link>}
          {'draftId' in p && p.draftId && p.status === 'accepted' && <Link className="today-brief__quiet" to={draftLink(p.draftId)}>Open draft <ArrowRight size={16} /></Link>}
        </div>}
    </li>
  );
}

/** Today › Meeting preparation: prep cards from the Daily Briefing, then promises, chases and keep-in-touch nudges. */
export function MeetingPrepPanel(): React.ReactElement {
  const q = useProactive();
  const act = useProactiveAction();
  const prep = q.data?.meetingPrep;
  const running = Boolean(prep?.running) || busy(act, 'refresh');
  const promises = prep?.promises.filter(p => p.status === 'proposed' || p.reportDate === prep.reportDate) ?? [];
  const chases = prep?.chases.filter(c => c.status === 'proposed') ?? [];
  const cadence = prep?.cadence.filter(c => c.status === 'proposed') ?? [];
  return (
    <div className="today-proactive">
      {q.isPending && <p className="today-brief__meta" role="status">Loading meeting prep...</p>}
      {q.isError && <p className="today-brief__error" role="alert">{describeApiError(q.error)}</p>}
      {prep && <>
        <p className="today-brief__meta">{prep.generatedAt ? `Prepared ${when(prep.generatedAt, true)} from the ${prep.reportDate ? when(prep.reportDate) : 'latest'} Daily Briefing.` : 'Athena prepares this after each Daily Briefing.'}</p>
        {prep.cards.length > 0
          ? <ul className="today-proactive__cards" aria-label="Prep cards">{prep.cards.map(c => <PrepCardView key={c.id} card={c} />)}</ul>
          : <p className="today-brief__empty">No meetings to prepare from the latest briefing.</p>}
        <section className="today-goals__section" aria-labelledby="prep-promises">
          <h4 id="prep-promises">Promises</h4>
          {promises.length === 0 ? <p className="today-brief__empty">No new promises in the latest briefing.</p>
            : <ul className="today-goals__dates">{promises.map(p => <Decision key={p.id} p={p} act={act} accept="accept-promise" dismiss="dismiss-promise"
              acceptLabel={p.owner === 'richard' ? 'Create task and draft' : 'Track as Waiting on'}>
              <span className="today-goals__tidy-title">{p.owner === 'richard' ? 'You' : p.who}: {p.text}</span>
              <span className="today-brief__meta">{p.due ? `By ${when(p.due)}` : 'No date given'}{p.draft ? ` · Draft to ${p.draft.to || 'recipient'} on accept` : ''}</span>
            </Decision>)}</ul>}
        </section>
        <section className="today-goals__section" aria-labelledby="prep-chases">
          <h4 id="prep-chases">Chases</h4>
          {chases.length === 0 ? <p className="today-brief__empty">Nothing has been waiting five working days.</p>
            : <ul className="today-goals__dates">{chases.map(c => <Decision key={c.id} p={c} act={act} dismiss="dismiss-chase">
              <Link className="today-goals__tidy-title" to={taskLink(c.taskId)}>{c.taskTitle}</Link>
              <span className="today-brief__meta">{c.waitingOn ? `Waiting on ${c.waitingOn}` : 'Waiting'} for {c.workingDays} working days. A chase draft is ready.</span>
            </Decision>)}</ul>}
        </section>
        <section className="today-goals__section" aria-labelledby="prep-cadence">
          <h4 id="prep-cadence">Keep in touch</h4>
          {cadence.length === 0 ? <p className="today-brief__empty">No one is overdue a note worth sending.</p>
            : <ul className="today-goals__dates">{cadence.map(c => <Decision key={c.id} p={c} act={act} accept="accept-cadence" dismiss="dismiss-cadence" acceptLabel="Create task and draft">
              <span className="today-goals__tidy-title">{c.person}</span>
              <span className="today-brief__meta">{c.workingDays} working days since {c.lastSeen ? when(c.lastSeen) : 'you last spoke'}. {c.reason}</span>
            </Decision>)}</ul>}
        </section>
        <div className="today-brief__actions">
          <button type="button" className="today-brief__quiet" disabled={running} onClick={() => { act.mutate({ action: 'refresh-meeting-prep', key: 'refresh' }); }}>
            <Renew size={16} /> {running ? 'Athena is preparing...' : 'Refresh meeting prep'}</button>
        </div>
        <p className="today-brief__meta">Nothing is sent and no task is created until you accept.</p>
      </>}
      <ActionError m={act} />
    </div>
  );
}

const PACKAGE_STATUS: Record<ContentPackage['status'], string> = {
  drafting: 'Drafting', 'in-review': 'In editorial review', 'ready-to-approve': 'Ready to approve', approved: 'Approved',
  published: 'Published', rejected: 'Rejected', expired: 'Expired', failed: 'Failed',
};

/** Plan › Drafts: one card per content package linking the blog, LinkedIn post, Think note and source. */
export function ContentPackages(): React.ReactElement | null {
  const q = useProactive();
  const act = useProactiveAction();
  const packages = (q.data?.packages ?? []).filter(p => !['rejected', 'expired'].includes(p.status));
  if (q.isError) return <p className="kh-drafts__status" role="alert">Content packages could not be loaded: {describeApiError(q.error)}</p>;
  if (!packages.length) return null;
  return (
    <section aria-labelledby="drafts-packages" className="kh-drafts__packages">
      <h2 id="drafts-packages" className="kh-drafts__group">Content packages <span>{packages.length}</span></h2>
      <ul>{packages.map(p => <li key={p.id} className="kh-drafts__package">
        <span className="kh-drafts__title">{p.blog?.title || p.title}</span>
        <span className="kh-drafts__meta">{PACKAGE_STATUS[p.status]} · {p.trigger === 'competitor' ? 'Competitor move' : 'Strong Imagine fit'} · {when(p.createdAt)}</span>
        {p.angle && <p className="kh-drafts__angle">{p.angle}</p>}
        {p.error && <p className="kh-drafts__meta today-goals__failed">{p.error}</p>}
        <div className="kh-drafts__package-links">
          {(p.blog || p.linkedin) && <Link to="/discover?publishing=1">Blog and LinkedIn in Publishing</Link>}
          {p.noteId && <Link to={noteLink(p.noteId)}>Podcast segment and CFP abstract</Link>}
          <a href={p.url} target="_blank" rel="noreferrer">Source article</a>
          {!['approved', 'published'].includes(p.status) && <button type="button" className="kh-btn-ghost" disabled={act.isPending}
            onClick={() => { act.mutate({ action: 'dismiss-package', args: { id: p.id }, key: p.id }); }}>{busy(act, p.id) ? 'Dismissing...' : 'Dismiss'}</button>}
        </div>
      </li>)}</ul>
      <ActionError m={act} />
    </section>
  );
}

/** Scorecard footer: Athena's own record, and which kinds of proposal it has stopped making. */
export function ProposalLedger(): React.ReactElement | null {
  const q = useProactive();
  const act = useProactiveAction();
  const [open, setOpen] = useState(false);
  const l = q.data?.ledger;
  if (!l) return null;
  return (
    <section className="today-goals__athena" aria-labelledby="goals-ledger">
      <h4 id="goals-ledger">Athena's record</h4>
      <p className="today-brief__reason">{l.proposed} proposed · {l.accepted} accepted · {l.open} open · {l.ignored} ignored · {l.dismissed} rejected <span className="today-brief__meta">since {when(l.since)}</span></p>
      {l.stopped.map(s => <div key={s.type} className="today-goals__date">
        <span className="today-goals__tidy-title">Stopping: {s.label}</span>
        <span className="today-brief__meta">{s.reason}</span>
        <div className="today-brief__actions"><button type="button" className="today-brief__quiet" disabled={act.isPending}
          onClick={() => { act.mutate({ action: 'enable-proposal-type', args: { type: s.type }, key: s.type }); }}>{busy(act, s.type) ? 'Saving...' : 'Start again'}</button></div>
      </div>)}
      <button type="button" className="today-brief__quiet" aria-expanded={open} onClick={() => { setOpen(o => !o); }}>{open ? 'Hide breakdown' : 'Show breakdown'}</button>
      {open && <ul className="today-proactive__rows">{l.byType.filter(t => t.proposed > 0).map(t => <li key={t.type} className="today-proactive__row">
        <div className="today-goals__measure-top"><span className="today-goals__measure-label">{t.label}</span>
          <span className="today-brief__meta">{t.proposed} proposed · {t.accepted} accepted · {t.open} open · {t.ignored} ignored · {t.dismissed} rejected</span></div>
      </li>)}</ul>}
      <ActionError m={act} />
    </section>
  );
}
