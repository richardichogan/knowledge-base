import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { useBackgroundJobs } from '../../services/agentJobStore';
import { isActiveAgentJob } from '../../types/agentJobs';
import { specialistLink } from '../../navigation/specialistLink';

export const BackgroundWork: React.FC = () => {
  const live = useBackgroundJobs();
  const recent = useQuery({
    queryKey: ['background-work'],
    queryFn: async () => requireApiData(await api.listRecentAgentJobs()),
    staleTime: 30_000, refetchInterval: 30_000,
  });
  const merged = new Map((recent.data ?? []).map(job => [job.id, job]));
  for (const job of live) merged.set(job.id, job);
  const jobs = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = jobs.filter(isActiveAgentJob);
  const shown = [...active, ...jobs.filter(job => !isActiveAgentJob(job)).slice(0, 8)];
  return <details className="kh-background-work">
    <summary>Background work{active.length ? ` · ${active.length} running or queued` : ' · recent results'}</summary>
    <p>You can move between screens while specialists work. Completed work opens from here or its notification. These are specialist jobs, not every chat or scheduled import.</p>
    {recent.isPending && <p role="status">Loading recent work...</p>}
    {recent.isError && <p role="alert">{describeApiError(recent.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void recent.refetch(); }}>Retry</button></p>}
    {!recent.isPending && !recent.isError && !shown.length && <p>No recent specialist jobs.</p>}
    <ul className="kh-background-work__list">{shown.map(job => <li key={job.id} aria-busy={isActiveAgentJob(job)}>
      <div><strong>{job.specialistName}</strong><span className={`kh-background-work__state kh-background-work__state--${job.status}`}>{job.status === 'done' ? 'Completed' : job.status}</span></div>
      <p>{job.subjectTitle || 'Untitled work'}</p>
      <p>{isActiveAgentJob(job) ? job.progress.at(-1) ?? 'Waiting for a worker.'
        : job.status === 'failed' ? job.error ?? 'The job could not finish. Open the source to review it.'
          : job.summary ?? 'The result has been saved. Completion does not imply review or publication.'}</p>
      <Link to={specialistLink(typeof job.result?.url === 'string' ? job.result.url : job.subjectUrl, window.location.href)}>
        {job.status === 'done' ? 'Open result' : 'Open source'}
      </Link>
    </li>)}</ul>
  </details>;
};
