import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Time } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { useBackgroundJobs } from '../../services/agentJobStore';
import { assignmentStatusLabel, isActiveAgentJob, isActiveAssignment, type AssignmentSummary } from '../../types/agentJobs';
import { specialistLink } from '../../navigation/specialistLink';
import { runStatusLabel } from '../jobs/jobPresentation';
import type { JobRun, ManagedJob } from '../../types/jobs';
import { confirmDialog } from '../../services/appDialogs';

const ASSIGNMENTS_KEY = ['background-work-assignments'];
const stageLabels: Record<string, string> = {
  research: 'Research', draft: 'Draft', critique: 'Independent critique',
  revision: 'Targeted revision', recheck: 'Independent recheck',
};

export const BackgroundWork: React.FC = () => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<{ id: string; action: 'cancel' | 'resume' } | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const live = useBackgroundJobs();
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
  const assignmentRows = assignments.data ?? [];
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
  const merged = new Map((recent.data ?? []).map(job => [job.id, job]));
  for (const job of live) merged.set(job.id, job);
  const jobs = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = jobs.filter(isActiveAgentJob);
  const shown = [...active, ...jobs.filter(job => !isActiveAgentJob(job)).slice(0, 8)];
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
  const count = activeCount + attentionCount;
  const detail = [activeCount ? `${activeCount} running or queued` : '', attentionCount ? `${attentionCount} paused for attention` : ''].filter(Boolean).join(', ');
  const label = detail ? `Background work: ${detail}` : 'Background work';
  return <>
    <button type="button" ref={triggerRef} className={`kh-header__utility${open ? ' kh-header__utility--active' : ''}`}
      title={label} aria-label={label} aria-expanded={open} aria-controls={open ? 'kh-background-work' : undefined}
      onClick={() => { setOpen(value => !value); }}>
      <Time size={20} aria-hidden="true" />
      {count > 0 && <span className="kh-header__badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
    </button>
    {open && <div id="kh-background-work" ref={panelRef} className="kh-background-work" role="region" aria-label="Background work">
    <h2>Background work{detail ? ` · ${detail}` : ' · recent results'}</h2>
    <p>You can move between screens while specialists work. Completed work opens from here or its notification.</p>
    <h3>Daily Insights import</h3>
    {imports.isPending && <p role="status">Loading import status...</p>}
    {imports.isError && <p role="alert">{describeApiError(imports.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void imports.refetch(); }}>Retry</button></p>}
    {!imports.isPending && !imports.isError && !imports.data?.length && <p>No scheduled Daily Insights import. Local folder sync may still run separately.</p>}
    <ul className="kh-background-work__list">{imports.data?.map(({ job, run }) => <li key={job.id}>
      <div><strong>{job.definition.name}</strong><span className="kh-background-work__state">{run ? runStatusLabel(run) : 'Not run yet'}</span></div>
      {!job.enabled && <p>Schedule paused.</p>}
      {run && <p>Scheduled {new Date(run.scheduledAt).toLocaleString('en-GB', { timeZone: job.definition.schedule.timezone })} ({job.definition.schedule.timezone}).</p>}
      {run && ['failed', 'partial', 'rejected', 'missed', 'unconfirmed'].includes(run.status) && typeof run.artifacts.error === 'string' && <p>{run.artifacts.error}</p>}
      <Link to={`/jobs?${new URLSearchParams({ jobId: job.id, ...(run ? { runId: run.id } : {}) })}`} onClick={() => { setOpen(false); }}>
        {run ? 'View import run' : 'View schedule'}
      </Link>
    </li>)}</ul>
    <h3>Specialist work</h3>
    {assignments.isPending && <p role="status">Loading Athena assignments...</p>}
    {assignments.isError && <p role="alert">{describeApiError(assignments.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void assignments.refetch(); }}>Retry assignments</button></p>}
    <ul className="kh-background-work__list">{assignmentRows.map(assignment => <li key={assignment.id} aria-busy={isActiveAssignment(assignment) || busy?.id === assignment.id}>
      <div><strong className="kh-background-work__assignment-title">{assignment.title}</strong><span className={`kh-background-work__state kh-background-work__state--${assignment.status}${assignment.status === 'completed' && assignment.readiness === 'blocked' ? ' kh-background-work__state--attention' : ''}`}>{assignmentStatusLabel(assignment)}</span></div>
      {assignment.currentStep && <p>{assignment.currentStep.name} · {assignment.currentStep.title} · {stageLabels[assignment.currentStep.key]}</p>}
      {assignment.reason && <p>{assignment.reason}</p>}
      {assignment.status === 'completed' && assignment.readiness === 'ready' && <p>Draft and review saved. Publication remains a separate action in the existing editor.</p>}
      {assignment.status === 'cancelled' && <p>Future work stopped. Saved drafts and reviews are retained.</p>}
      {actionError?.id === assignment.id && <p className="kh-background-work__error" role="alert">{actionError.message}</p>}
      <div className="kh-background-work__actions">
        {assignment.resultUrl && <Link to={specialistLink(assignment.resultUrl, window.location.href)} onClick={() => { setOpen(false); }}>Open saved draft</Link>}
        {(isActiveAssignment(assignment) || assignment.status === 'waiting') && <button type="button"
          className="kh-background-work__action kh-background-work__action--cancel" disabled={busy !== null || assignments.isError}
          aria-label={`Cancel assignment: ${assignment.title}`} onClick={() => { void changeAssignment(assignment, 'cancel'); }}>
          {busy?.id === assignment.id && busy.action === 'cancel' ? 'Cancelling...' : 'Cancel'}
        </button>}
        {assignment.status === 'waiting' && <button type="button" className="kh-background-work__action"
          disabled={busy !== null || assignments.isError} onClick={() => { void changeAssignment(assignment, 'resume'); }}>
          {busy?.id === assignment.id && busy.action === 'resume' ? 'Requesting resume...' : 'Request resume'}
        </button>}
      </div>
    </li>)}</ul>
    {recent.isPending && <p role="status">Loading recent work...</p>}
    {recent.isError && <p role="alert">{describeApiError(recent.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void recent.refetch(); }}>Retry</button></p>}
    {!recent.isPending && !recent.isError && !assignments.isPending && !assignments.isError && !shown.length && !assignmentRows.length && <p>No recent specialist jobs.</p>}
    <ul className="kh-background-work__list">{shown.map(job => <li key={job.id} aria-busy={isActiveAgentJob(job)}>
      <div><strong>{job.specialistName}</strong><span className={`kh-background-work__state kh-background-work__state--${job.status}`}>{job.status === 'done' ? 'Completed' : job.status}</span></div>
      <p>{job.subjectTitle || 'Untitled work'}</p>
      <p>{isActiveAgentJob(job) ? job.progress.at(-1) ?? 'Waiting for a worker.'
        : job.status === 'failed' ? job.error ?? 'The job could not finish. Open the source to review it.'
          : job.summary ?? 'The result has been saved. Completion does not imply review or publication.'}</p>
      <Link to={specialistLink(typeof job.result?.url === 'string' ? job.result.url : job.subjectUrl, window.location.href)} onClick={() => { setOpen(false); }}>
        {job.status === 'done' ? 'Open result' : 'Open source'}
      </Link>
    </li>)}</ul>
    </div>}
  </>;
};
