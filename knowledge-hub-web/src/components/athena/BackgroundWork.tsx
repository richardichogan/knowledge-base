import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckmarkFilled, ChevronDown, Close, InProgress, Settings, WarningFilled } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { useBackgroundJobs } from '../../services/agentJobStore';
import { assignmentStatusLabel, isActiveAgentJob, isActiveAssignment, type AssignmentSummary, type BackgroundWorkContext } from '../../types/agentJobs';
import { useAthenaContext } from '../../context/AthenaContext';
import { specialistLink } from '../../navigation/specialistLink';
import { runStatusLabel } from '../jobs/jobPresentation';
import type { JobRun, ManagedJob } from '../../types/jobs';
import { confirmDialog } from '../../services/appDialogs';
import { markJobUpdatesSeen, useJobUpdates, type JobUpdate } from '../../services/jobUpdates';

const ASSIGNMENTS_KEY = ['background-work-assignments'];
const stageLabels: Record<string, string> = {
  research: 'Research', draft: 'Draft', critique: 'Independent critique',
  revision: 'Targeted revision', recheck: 'Independent recheck',
};

interface WorkItem {
  id: string;
  title: string;
  source: string;
  state: string;
  group: 'active' | 'attention' | 'recent';
  tone: 'active' | 'attention' | 'done' | 'muted';
  at: string;
  message: string;
  url: string | null;
  linkLabel: string;
  updates: JobUpdate[];
  assignment?: AssignmentSummary;
  jobId?: string;
  subjectId?: string;
}

function submittedToMetis(run: JobRun | undefined): boolean {
  const capture = run?.artifacts['capture'];
  return !!capture && typeof capture === 'object' && !Array.isArray(capture)
    && 'status' in capture && capture.status === 'queued';
}

export const BackgroundWork: React.FC = () => {
  const { setBackgroundWork } = useAthenaContext();
  const [open, setOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<{ id: string; action: 'cancel' | 'resume' } | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const live = useBackgroundJobs();
  const updates = useJobUpdates();
  const recent = useQuery({
    queryKey: ['background-work'],
    queryFn: async () => requireApiData(await api.listRecentAgentJobs()),
    staleTime: 30_000, refetchInterval: 30_000,
  });
  const assignments = useQuery({
    queryKey: ASSIGNMENTS_KEY,
    queryFn: async () => requireApiData(await api.listWorkforceAssignments()),
    staleTime: 5_000, refetchInterval: 5_000,
  });
  const assignmentRows = useMemo(() => assignments.data ?? [], [assignments.data]);
  useEffect(() => {
    const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ASSIGNMENTS_KEY }); };
    window.addEventListener('athena-assignment-updated', refresh);
    return () => { window.removeEventListener('athena-assignment-updated', refresh); };
  }, [queryClient]);
  const activeAssignments = assignmentRows.filter(isActiveAssignment);
  const waitingAssignments = assignmentRows.filter(item => item.status === 'waiting');
  const changeAssignment = async (assignment: AssignmentSummary, action: 'cancel' | 'resume'): Promise<void> => {
    if (busy) return;
    setBusy({ id: assignment.id, action });
    setActionError(null);
    try {
      const confirmed = await confirmDialog(action === 'cancel'
        ? 'Stop future work on this assignment? Saved drafts and reviews stay available. This does not undo or repeat any separate delivery.'
        : 'Request resume using the original brief, source versions, deadline and remaining allowance? Athena will check current authority and sources first. No budget or scope will be refreshed.',
      { title: action === 'cancel' ? 'Cancel assignment?' : 'Request resume?', confirmLabel: action === 'cancel' ? 'Cancel assignment' : 'Request resume',
        ...(action === 'cancel' ? { tone: 'danger' as const } : {}) });
      setOpen(true);
      if (!confirmed) return;
      const updated = requireApiData(action === 'cancel'
        ? await api.cancelWorkforceAssignment(assignment.id, assignment.revision)
        : await api.resumeWorkforceAssignment(assignment.id, assignment.revision, crypto.randomUUID()));
      queryClient.setQueryData<AssignmentSummary[]>(ASSIGNMENTS_KEY, rows => rows?.map(row => row.id === updated.id ? updated : row));
      await assignments.refetch();
    } catch (error) {
      setActionError({ id: assignment.id, message: describeApiError(error) });
      await assignments.refetch();
    } finally { setBusy(null); }
  };
  const imports = useQuery({
    queryKey: ['background-work-imports'],
    queryFn: async () => {
      const schedules = (await api.jobs<ManagedJob[]>()).filter(job => job.definition.kind === 'm365-import');
      return Promise.all(schedules.map(async job => {
        const runs = await api.jobs<JobRun[]>(`/runs?${new URLSearchParams({ jobId: job.id })}`);
        return { job, run: runs.find(item => !item.preview) };
      }));
    },
    staleTime: 30_000, refetchInterval: 30_000,
  });
  const { jobs, items } = useMemo(() => {
  const merged = new Map((recent.data ?? []).map(job => [job.id, job]));
  for (const job of live) merged.set(job.id, job);
  const jobs = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const items: WorkItem[] = [
    ...assignmentRows.map((assignment): WorkItem => {
      const running = isActiveAssignment(assignment);
      const attention = assignment.status === 'waiting' || assignment.status === 'failed'
        || assignment.status === 'superseded' || (assignment.status === 'completed' && assignment.readiness === 'blocked');
      return {
        id: `assignment-${assignment.id}`, title: assignment.title, source: 'Blog team',
        state: assignmentStatusLabel(assignment), group: running ? 'active' : attention ? 'attention' : 'recent',
        tone: running ? 'active' : attention ? 'attention' : assignment.status === 'cancelled' ? 'muted' : 'done',
        at: assignment.finishedAt ?? assignment.createdAt,
        message: [
          assignment.currentStep ? `${assignment.currentStep.name} · ${assignment.currentStep.title} · ${stageLabels[assignment.currentStep.key] ?? assignment.currentStep.key}` : '',
          assignment.reason ?? (assignment.status === 'completed' && assignment.readiness === 'ready'
            ? 'Draft and review saved. Publication remains a separate action in the existing editor.'
            : assignment.status === 'cancelled' ? 'Future work stopped. Saved drafts and reviews are retained.' : ''),
        ].filter(Boolean).join('\n'),
        url: assignment.resultUrl, linkLabel: 'Open saved draft',
        updates: updates.filter(update => update.tag === `assignment-${assignment.id}`), assignment,
      };
    }),
    ...jobs.filter(job => !job.isStep || isActiveAgentJob(job) || job.status === 'failed').map((job): WorkItem => ({
      id: job.id, jobId: job.id, subjectId: job.subjectId, title: job.subjectTitle || 'Untitled work',
      source: job.specialistName.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()),
      state: job.status === 'done' ? 'Completed' : job.status === 'failed' ? 'Could not finish' : job.status === 'running' ? 'Working' : 'Queued',
      group: isActiveAgentJob(job) ? 'active' : job.status === 'failed' ? 'attention' : 'recent',
      tone: isActiveAgentJob(job) ? 'active' : job.status === 'failed' ? 'attention' : 'done',
      at: job.finishedAt ?? job.createdAt,
      message: isActiveAgentJob(job) ? job.progress.at(-1) ?? 'Waiting for a worker.'
        : job.status === 'failed' ? job.error ?? 'The job could not finish. Open the source to review it.'
          : job.summary ?? 'The result has been saved. Completion does not imply review or publication.',
      url: typeof job.result?.url === 'string' ? job.result.url : job.subjectUrl,
      linkLabel: job.status === 'done' ? 'Open result' : 'Open source',
      updates: updates.filter(update => update.id === job.id),
    })),
  ];
  const represented = new Set(items.flatMap(item => item.updates.map(update => update.id)));
  for (const update of updates) {
    if (represented.has(update.id)) continue;
    items.push({
      id: `update-${update.id}`, title: update.title, source: 'Background work',
      state: update.ok ? 'Completed' : 'Needs attention', group: update.ok ? 'recent' : 'attention',
      tone: update.ok ? 'done' : 'attention', at: update.at, message: update.body,
      url: update.url === '/' ? null : update.url, linkLabel: 'Open result', updates: [update],
    });
  }
  items.sort((a, b) => Number(b.updates.some(update => !update.seen)) - Number(a.updates.some(update => !update.seen))
    || b.at.localeCompare(a.at));
  return { jobs, items };
  }, [recent.data, live, assignmentRows, updates]);
  const active = jobs.filter(isActiveAgentJob);
  const unseen = items.filter(item => item.updates.some(update => !update.seen)).length;
  const unseenFailures = items.some(item => item.updates.some(update => !update.seen && !update.ok));
  const groups = [
    { id: 'active', title: 'In progress' },
    { id: 'recent', title: 'Recent results' },
    { id: 'attention', title: 'Needs attention' },
  ] as const;
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent): void => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const activeCount = active.length + activeAssignments.length;
  const attentionCount = waitingAssignments.length;
  const detail = [activeCount ? `${activeCount} running or queued` : '', attentionCount ? `${attentionCount} paused for attention` : ''].filter(Boolean).join(', ');
  const status = [detail, unseen ? `${unseen} new ${unseen === 1 ? 'update' : 'updates'}` : ''].filter(Boolean).join(', ');
  const label = status ? `Background work: ${status}` : 'Background work';
  const newLabel = `${unseen} new ${unseenFailures ? (unseen === 1 ? 'update' : 'updates') : (unseen === 1 ? 'result' : 'results')}`;
  const backgroundContext = useMemo<BackgroundWorkContext>(() => ({
    panelOpen: open, activeCount, unreadCount: unseen,
    incomplete: recent.isPending || recent.isError || assignments.isPending || assignments.isError,
    truncated: items.length > 10 || items.some(item => item.title.length > 200 || item.message.length > 800),
    items: items.slice(0, 10).map(item => ({
      id: item.id, ...(item.jobId ? { jobId: item.jobId } : {}),
      ...(item.subjectId ? { subjectId: item.subjectId } : {}),
      ...(item.assignment ? { assignmentId: item.assignment.id } : {}),
      title: item.title.slice(0, 200), status: item.state, summary: item.message.slice(0, 800),
      unread: item.updates.some(update => !update.seen),
    })),
  }), [open, activeCount, unseen, recent.isPending, recent.isError, assignments.isPending, assignments.isError, items]);
  useEffect(() => { setBackgroundWork(backgroundContext); }, [backgroundContext, setBackgroundWork]);
  useEffect(() => () => { setBackgroundWork(null); }, [setBackgroundWork]);
  const acknowledge = (item: WorkItem): void => { markJobUpdatesSeen(item.updates.map(update => update.id)); };
  return <>
    <button type="button" ref={triggerRef} className={`kh-header__utility kh-header__utility--work${open ? ' kh-header__utility--active' : ''}`}
      title={label} aria-label={label} aria-expanded={open} aria-controls={open ? 'kh-background-work' : undefined}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); window.requestAnimationFrame(() => panelRef.current?.focus()); }
      }}
      onClick={() => { setOpen(value => !value); }}>
      <Settings size={20} aria-hidden="true" />
      {activeCount > 0 && <span className="kh-header__badge" aria-hidden="true">{activeCount > 99 ? '99+' : activeCount}</span>}
      {unseen > 0 && <span className={`kh-background-work__indicator${unseenFailures ? ' kh-background-work__indicator--attention' : ''}`} aria-hidden="true">
        {unseenFailures ? <WarningFilled size={14} /> : <CheckmarkFilled size={14} />}
        <span>{newLabel}</span>
      </span>}
    </button>
    <span className="cds--visually-hidden" role="status" aria-live="polite" aria-atomic="true">{unseen > 0 ? `Background work: ${newLabel}.` : ''}</span>
    {open && <div id="kh-background-work" ref={panelRef} className="kh-background-work" role="region" aria-labelledby="kh-background-work-title" tabIndex={-1}>
      <div className="kh-background-work__header">
        <div><h2 id="kh-background-work-title">Background work</h2><p>{detail || 'Saved results and recent activity'}</p></div>
        <button type="button" className="kh-background-work__close" aria-label="Close background work" title="Close background work"
          onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><Close size={20} /></button>
      </div>
      <div className="kh-background-work__body">
        {(recent.isPending || assignments.isPending) && <p className="kh-background-work__notice" role="status">Loading background work...</p>}
        {recent.isError && <p className="kh-background-work__notice kh-background-work__error" role="alert">{describeApiError(recent.error)} <button type="button" className="kh-background-work__action" onClick={() => { void recent.refetch(); }}>Retry jobs</button></p>}
        {assignments.isError && <p className="kh-background-work__notice kh-background-work__error" role="alert">{describeApiError(assignments.error)} <button type="button" className="kh-background-work__action" onClick={() => { void assignments.refetch(); }}>Retry assignments</button></p>}
        {!recent.isPending && !recent.isError && !assignments.isPending && !assignments.isError && !items.length && <p className="kh-background-work__notice">No recent work. Jobs you start will appear here; you can keep working elsewhere.</p>}
        {groups.map(group => {
          let readRows = 0;
          const rows = items.filter(item => item.group === group.id).filter(item =>
            group.id === 'active' || item.updates.some(update => !update.seen) || readRows++ < 8);
          if (!rows.length) return null;
          const collapsible = group.id === 'attention';
          const expanded = !collapsible || attentionOpen;
          const newRows = rows.filter(item => item.updates.some(update => !update.seen)).length;
          return <section key={group.id} className="kh-background-work__section" aria-labelledby={`kh-work-${group.id}`}>
            {collapsible
              ? <h3 id={`kh-work-${group.id}`}><button type="button" className="kh-background-work__toggle" aria-expanded={expanded}
                aria-controls={`kh-work-list-${group.id}`} onClick={() => { setAttentionOpen(value => !value); }}>
                <ChevronDown size={16} aria-hidden="true" className="kh-background-work__chevron" />
                {group.title}<span>{rows.length}{newRows ? ` · ${newRows} new` : ''}</span>
              </button></h3>
              : <h3 id={`kh-work-${group.id}`}>{group.title}<span>{rows.length}</span></h3>}
            {expanded && <ul id={`kh-work-list-${group.id}`} className="kh-background-work__list">{rows.map(item => {
              const unread = item.updates.some(update => !update.seen);
              const assignment = item.assignment;
              return <li key={item.id} className={`kh-background-work__item kh-background-work__item--${item.tone}${unread ? ' kh-background-work__item--unread' : ''}`} aria-busy={busy?.id === assignment?.id && busy !== null}>
                <span className="kh-background-work__icon" aria-hidden="true">{item.tone === 'active' ? <InProgress size={18} /> : item.tone === 'attention' ? <WarningFilled size={18} /> : <CheckmarkFilled size={18} />}</span>
                <div className="kh-background-work__content">
                  <div className="kh-background-work__meta"><span>{item.source}</span><time dateTime={item.at} title={new Date(item.at).toLocaleString('en-GB')}>{new Date(item.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>
                  <p className="kh-background-work__title">{item.title}</p>
                  <div className="kh-background-work__state">{item.state}{unread && <span className="kh-background-work__unread">New</span>}</div>
                  {item.message && <details className="kh-background-work__details"><summary>{item.group === 'active' ? 'Progress' : item.group === 'attention' ? 'What needs attention' : 'Result details'}</summary><p>{item.message}</p></details>}
                  {actionError?.id === assignment?.id && <p className="kh-background-work__error" role="alert">{actionError?.message}</p>}
                  <div className="kh-background-work__actions">
                    {item.url && <Link to={specialistLink(item.url, window.location.href)} onClick={() => { acknowledge(item); setOpen(false); }}>{item.linkLabel}<ArrowRight size={14} aria-hidden="true" /></Link>}
                    {!item.url && unread && <button type="button" className="kh-background-work__action" onClick={() => { acknowledge(item); }}>Mark read</button>}
                    {assignment && (isActiveAssignment(assignment) || assignment.status === 'waiting') && <button type="button"
                      className="kh-background-work__action kh-background-work__action--cancel" disabled={busy !== null || assignments.isError}
                      aria-label={`Cancel assignment: ${assignment.title}`} onClick={() => { void changeAssignment(assignment, 'cancel'); }}>
                      {busy?.id === assignment.id && busy.action === 'cancel' ? 'Cancelling...' : 'Cancel'}
                    </button>}
                    {assignment?.status === 'waiting' && <button type="button" className="kh-background-work__action"
                      disabled={busy !== null || assignments.isError} onClick={() => { void changeAssignment(assignment, 'resume'); }}>
                      {busy?.id === assignment.id && busy.action === 'resume' ? 'Requesting resume...' : 'Request resume'}
                    </button>}
                  </div>
                </div>
              </li>;
            })}</ul>}
          </section>;
        })}
        <details className="kh-background-work__imports">
          <summary>Daily Insights imports</summary>
          {imports.isPending && <p role="status">Loading import status...</p>}
          {imports.isError && <p className="kh-background-work__error" role="alert">{describeApiError(imports.error)} <button type="button" className="kh-background-work__action" onClick={() => { void imports.refetch(); }}>Retry</button></p>}
          {!imports.isPending && !imports.isError && !imports.data?.length && <p>No scheduled import. Local folder sync may still run separately.</p>}
          <ul className="kh-background-work__list">{imports.data?.map(({ job, run }) => <li key={job.id} className="kh-background-work__import">
            <p className="kh-background-work__title">{job.definition.name}</p>
            <p>{run ? submittedToMetis(run) ? 'Handed to Metis; follow its job above.' : runStatusLabel(run) : 'Not run yet'}{!job.enabled ? ' · Schedule paused' : ''}</p>
            {run && <p className="kh-background-work__meta">{new Date(run.scheduledAt).toLocaleString('en-GB', { timeZone: job.definition.schedule.timezone })} · {job.definition.schedule.timezone}</p>}
            {run && ['failed', 'partial', 'rejected', 'missed', 'unconfirmed'].includes(run.status) && typeof run.artifacts.error === 'string' && <p className="kh-background-work__error">{run.artifacts.error}</p>}
            <Link to={`/jobs?${new URLSearchParams({ jobId: job.id, ...(run ? { runId: run.id } : {}) })}`} onClick={() => { setOpen(false); }}>{run ? 'View import run' : 'View schedule'}<ArrowRight size={14} aria-hidden="true" /></Link>
          </li>)}</ul>
        </details>
      </div>
      <div className="kh-background-work__footer">
        <span>{unseen ? newLabel : 'Latest activity · all updates read'}</span>
        <button type="button" className="kh-background-work__action" disabled={!unseen} onClick={() => { markJobUpdatesSeen(); }}>Mark all read</button>
      </div>
    </div>}
  </>;
};
