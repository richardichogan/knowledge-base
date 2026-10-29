import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Time } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { useBackgroundJobs } from '../../services/agentJobStore';
import { isActiveAgentJob } from '../../types/agentJobs';
import { specialistLink } from '../../navigation/specialistLink';
import { runStatusLabel } from '../jobs/jobPresentation';
import type { JobRun, ManagedJob } from '../../types/jobs';

export const BackgroundWork: React.FC = () => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const live = useBackgroundJobs();
  const recent = useQuery({
    queryKey: ['background-work'],
    queryFn: async () => requireApiData(await api.listRecentAgentJobs()),
    staleTime: 30_000, refetchInterval: 30_000,
  });
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
  const label = active.length ? `Background work: ${active.length} running or queued` : 'Background work';
  return <>
    <button type="button" ref={triggerRef} className={`kh-header__utility${open ? ' kh-header__utility--active' : ''}`}
      title={label} aria-label={label} aria-expanded={open} aria-controls={open ? 'kh-background-work' : undefined}
      onClick={() => { setOpen(value => !value); }}>
      <Time size={20} aria-hidden="true" />
      {active.length > 0 && <span className="kh-header__badge" aria-hidden="true">{active.length > 99 ? '99+' : active.length}</span>}
    </button>
    {open && <div id="kh-background-work" ref={panelRef} className="kh-background-work" role="region" aria-label="Background work">
    <h2>Background work{active.length ? ` · ${active.length} running or queued` : ' · recent results'}</h2>
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
    {recent.isPending && <p role="status">Loading recent work...</p>}
    {recent.isError && <p role="alert">{describeApiError(recent.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void recent.refetch(); }}>Retry</button></p>}
    {!recent.isPending && !recent.isError && !shown.length && <p>No recent specialist jobs.</p>}
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
