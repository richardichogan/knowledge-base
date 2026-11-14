import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckmarkFilled, Close, ErrorFilled, InformationFilled, InProgress, Notification, WarningFilled } from '@carbon/icons-react';
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
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'completed', label: 'Completed' },
  { id: 'information', label: 'Information' },
] as const;
const stageLabels: Record<string, string> = {
  research: 'Research', draft: 'Draft', critique: 'Independent critique',
  revision: 'Targeted revision', recheck: 'Independent recheck',
};

interface WorkItem {
  id: string;
  title: string;
  source: string;
  state: string;
  tone: 'active' | 'attention' | 'failed' | 'done' | 'muted' | 'information';
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
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
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
        state: assignmentStatusLabel(assignment),
        tone: running ? 'active' : assignment.status === 'failed' ? 'failed' : attention ? 'attention' : assignment.status === 'cancelled' ? 'muted' : 'done',
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
      tone: isActiveAgentJob(job) ? 'active' : job.status === 'failed' ? 'failed' : 'done',
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
      state: update.kind === 'information' ? 'Information' : update.ok ? 'Completed' : 'Failed',
      tone: update.kind === 'information' ? 'information' : update.ok ? 'done' : 'failed', at: update.at, message: update.body,
      url: update.url === '/' ? null : update.url, linkLabel: 'Open result', updates: [update],
    });
  }
  for (const { job, run } of imports.data ?? []) {
    const handedOff = submittedToMetis(run);
    const tone: WorkItem['tone'] = !run || handedOff ? 'muted'
      : run.status === 'failed' ? 'failed'
        : ['partial', 'rejected', 'missed', 'unconfirmed', 'awaiting-approval', 'waiting-file', 'waiting-device'].includes(run.status) ? 'attention'
          : run.status === 'succeeded' ? 'done'
            : run.status === 'cancelled' ? 'muted' : 'active';
    items.push({
      id: `import-${run?.id ?? job.id}`, title: job.definition.name, source: 'Daily Insights import',
      state: `${run ? handedOff ? 'Handed to Metis' : runStatusLabel(run) : 'Not run yet'}${!job.enabled ? ' · Schedule paused' : ''}`,
      tone, at: run?.updatedAt ?? job.updatedAt,
      message: typeof run?.artifacts.error === 'string' ? run.artifacts.error
        : handedOff ? 'Submitted to Metis; its background job reports the result separately.' : '',
      url: `/jobs?${new URLSearchParams({ jobId: job.id, ...(run ? { runId: run.id } : {}) })}`,
      linkLabel: run ? 'View import run' : 'View schedule', updates: [],
    });
  }
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { jobs, items };
  }, [recent.data, live, assignmentRows, updates, imports.data]);
  const active = jobs.filter(isActiveAgentJob);
  const unseen = items.filter(item => item.updates.some(update => !update.seen)).length;
  const filteredItems = useMemo(() => items.filter(item => filter === 'all'
    || (filter === 'attention' && (item.tone === 'attention' || item.tone === 'failed'))
    || (filter === 'completed' && item.tone === 'done')
    || (filter === 'information' && item.tone === 'information')), [items, filter]);
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
  const attentionCount = items.filter(item => item.tone === 'attention').length;
  const detail = [activeCount ? `${activeCount} running or queued` : '', attentionCount ? `${attentionCount} paused for attention` : ''].filter(Boolean).join(', ');
  const status = [detail, unseen ? `${unseen} new ${unseen === 1 ? 'update' : 'updates'}` : ''].filter(Boolean).join(', ');
  const label = status ? `Updates: ${status}` : 'Updates';
  const indicators = [
    { tone: 'active', count: activeCount, label: 'running or queued', Icon: InProgress },
    ...([
      { tone: 'done', label: 'completed', Icon: CheckmarkFilled },
      { tone: 'attention', label: 'needing attention', Icon: WarningFilled },
      { tone: 'failed', label: 'failed', Icon: ErrorFilled },
      { tone: 'information', label: 'new information', Icon: InformationFilled },
      { tone: 'muted', label: 'cancelled', Icon: Close },
    ] as const).map(indicator => ({
      ...indicator,
      count: items.filter(item => item.tone === indicator.tone && item.updates.some(update => !update.seen)).length,
    })),
  ].filter(indicator => indicator.count > 0);
  const indicatorLabel = indicators.map(indicator => `${indicator.count} ${indicator.label}`).join(', ');
  const backgroundContext = useMemo<BackgroundWorkContext>(() => ({
    panelOpen: open, activeFilter: filter, activeCount, unreadCount: unseen,
    incomplete: recent.isPending || recent.isError || assignments.isPending || assignments.isError || imports.isPending || imports.isError,
    truncated: filteredItems.length > 10 || filteredItems.some(item => item.title.length > 200 || item.message.length > 800),
    items: filteredItems.slice(0, 10).map(item => ({
      id: item.id, ...(item.jobId ? { jobId: item.jobId } : {}),
      ...(item.subjectId ? { subjectId: item.subjectId } : {}),
      ...(item.assignment ? { assignmentId: item.assignment.id } : {}),
      title: item.title.slice(0, 200), status: item.state, summary: item.message.slice(0, 800),
      unread: item.updates.some(update => !update.seen),
    })),
  }), [open, filter, activeCount, unseen, recent.isPending, recent.isError, assignments.isPending, assignments.isError, imports.isPending, imports.isError, filteredItems]);
  useEffect(() => { setBackgroundWork(backgroundContext); }, [backgroundContext, setBackgroundWork]);
  useEffect(() => () => { setBackgroundWork(null); }, [setBackgroundWork]);
  const acknowledge = (item: WorkItem): void => { markJobUpdatesSeen(item.updates.map(update => update.id)); };
  return <>
    <button type="button" ref={triggerRef} className={`kh-header__utility kh-header__utility--work${open ? ' kh-header__utility--active' : ''}`}
      title={indicatorLabel ? `Updates: ${indicatorLabel}` : label}
      aria-label={indicatorLabel ? `Updates: ${indicatorLabel}` : label} aria-expanded={open} aria-controls={open ? 'kh-background-work' : undefined}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); window.requestAnimationFrame(() => panelRef.current?.focus()); }
      }}
      onClick={() => { setOpen(value => !value); }}>
      <Notification size={20} aria-hidden="true" />
      {indicators.map(({ tone, count, label: stateLabel, Icon }) => <span key={tone}
        className={`kh-background-work__indicator kh-background-work__indicator--${tone}`} aria-hidden="true">
        <Icon size={14} />
        <span>{count} {stateLabel}</span>
      </span>)}
    </button>
    <span className="cds--visually-hidden" role="status" aria-live="polite" aria-atomic="true">{indicatorLabel ? `Updates: ${indicatorLabel}.` : ''}</span>
    {open && <div id="kh-background-work" ref={panelRef} className="kh-background-work" role="region" aria-labelledby="kh-background-work-title" tabIndex={-1}>
      <div className="kh-background-work__header">
        <div><h2 id="kh-background-work-title">Updates</h2><p>{detail || 'Saved results and recent activity'}</p></div>
        <button type="button" className="kh-background-work__close" aria-label="Close updates" title="Close updates"
          onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><Close size={20} /></button>
      </div>
      <div className="kh-background-work__filters" role="group" aria-label="Filter updates">
        {FILTERS.map(option => <button key={option.id} type="button" className="kh-background-work__filter"
          aria-pressed={filter === option.id} onClick={() => { setFilter(option.id); }}>{option.label}</button>)}
      </div>
      <div className="kh-background-work__body">
        {(recent.isPending || assignments.isPending) && <p className="kh-background-work__notice" role="status">Loading background work...</p>}
        {recent.isError && <p className="kh-background-work__notice kh-background-work__error" role="alert">{describeApiError(recent.error)} <button type="button" className="kh-background-work__action" onClick={() => { void recent.refetch(); }}>Retry jobs</button></p>}
        {assignments.isError && <p className="kh-background-work__notice kh-background-work__error" role="alert">{describeApiError(assignments.error)} <button type="button" className="kh-background-work__action" onClick={() => { void assignments.refetch(); }}>Retry assignments</button></p>}
        {imports.isPending && <p className="kh-background-work__notice" role="status">Loading import status...</p>}
        {imports.isError && <p className="kh-background-work__notice kh-background-work__error" role="alert">{describeApiError(imports.error)} <button type="button" className="kh-background-work__action" onClick={() => { void imports.refetch(); }}>Retry imports</button></p>}
        {!recent.isPending && !recent.isError && !assignments.isPending && !assignments.isError && !imports.isPending && !imports.isError && !items.length && <p className="kh-background-work__notice">No recent work. Jobs you start will appear here; you can keep working elsewhere.</p>}
        {!recent.isPending && !recent.isError && !assignments.isPending && !assignments.isError && !imports.isPending && !imports.isError && items.length > 0 && !filteredItems.length
          && <p className="kh-background-work__notice">No updates in this category.</p>}
        {filteredItems.length > 0 && <ul className="kh-background-work__list" aria-label="Updates, newest first">{filteredItems.map(item => {
              const unread = item.updates.some(update => !update.seen);
              const assignment = item.assignment;
              return <li key={item.id} className={`kh-background-work__item kh-background-work__item--${item.tone}${unread ? ' kh-background-work__item--unread' : ''}`} aria-busy={busy?.id === assignment?.id && busy !== null}>
                <span className="kh-background-work__icon" aria-hidden="true">{item.tone === 'active' ? <InProgress size={18} /> : item.tone === 'failed' ? <ErrorFilled size={18} /> : item.tone === 'attention' ? <WarningFilled size={18} /> : item.tone === 'information' ? <InformationFilled size={18} /> : item.tone === 'muted' ? <Close size={18} /> : <CheckmarkFilled size={18} />}</span>
                <div className="kh-background-work__content">
                  <div className="kh-background-work__meta"><span>{item.source}</span><time dateTime={item.at} title={new Date(item.at).toLocaleString('en-GB')}>{new Date(item.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>
                  <p className="kh-background-work__title">{item.title}</p>
                  <div className="kh-background-work__state">{item.state}{unread && <span className="kh-background-work__unread">New</span>}</div>
                  {item.message && <details className="kh-background-work__details"><summary>{item.tone === 'active' ? 'Progress' : item.tone === 'attention' || item.tone === 'failed' ? 'What needs attention' : item.tone === 'information' ? 'Information details' : 'Result details'}</summary><p>{item.message}</p></details>}
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
      </div>
      <div className="kh-background-work__footer">
        <span>{unseen ? `${unseen} new ${unseen === 1 ? 'update' : 'updates'}` : 'Latest activity · all updates read'}</span>
        <button type="button" className="kh-background-work__action" disabled={!unseen} onClick={() => { markJobUpdatesSeen(); }}>Mark all read</button>
      </div>
    </div>}
  </>;
};
