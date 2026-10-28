import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import { readStored, writeStored } from '../hooks/usePersistedState';

export const ProjectChanges: React.FC<{ projectId: string }> = ({ projectId }) => {
  const key = `kh-project-seen:${projectId}`;
  const [baseline] = useState(() => {
    const stored = readStored(key);
    return stored && Number.isFinite(Date.parse(stored)) && Date.parse(stored) <= Date.now() ? stored : null;
  });
  const [since, setSince] = useState(() => baseline ?? new Date(Date.now() - 86400000).toISOString());
  const changes = useQuery({ queryKey: ['project-changes', projectId, since],
    queryFn: async () => requireApiData(await api.getProjectChanges(projectId, since)), retry: false });
  useEffect(() => {
    if (changes.data) writeStored(key, changes.data.until);
  }, [changes.data, key]);
  return <section className="kh-work-context" aria-label="Project changes">
    <h3>What changed since you last looked?</h3>
    <p>{baseline ? 'Since your previous successful visit on this browser' : 'First visit on this browser: showing the last 24 hours'}.
      {' '}Current changed records, not a version-by-version diff. Repeated indexing alone does not count as a new development.</p>
    <div className="kh-work-context__actions">
      <label className="kh-work-context__field">Period
        <select value={since === baseline || (!baseline && since === changes.data?.since) ? 'visit' : 'custom'}
          onChange={event => {
            if (event.target.value === 'visit') setSince(baseline ?? new Date(Date.now() - 86400000).toISOString());
            else setSince(new Date(Date.now() - Number(event.target.value) * 86400000).toISOString());
          }}>
          <option value="visit">Since last visit / first 24 hours</option>
          <option value="custom" disabled>Selected period</option>
          <option value="1">Last day</option><option value="7">Last week</option><option value="30">Last 30 days</option>
        </select>
      </label>
      <button type="button" className="kh-btn-ghost" disabled={changes.isFetching} onClick={() => { void changes.refetch(); }}>Refresh changes</button>
    </div>
    {changes.isFetching && <p role="status">Reading linked project changes...</p>}
    {changes.isError && <p role="alert">{describeApiError(changes.error)}</p>}
    {changes.data && !changes.isError && <>
      <p className="kh-work-context__meta">{new Date(changes.data.since).toLocaleString('en-GB')} to {new Date(changes.data.until).toLocaleString('en-GB')}</p>
      {!changes.data.items.length && <p>No changed records found in the linked sources for this period. This does not establish that all connected systems are current.</p>}
      <ul className="kh-work-context__list">{changes.data.items.map(item => <li key={`${item.kind}:${item.id}`}>
        {item.href.startsWith('/') ? <Link to={item.href}>{item.title}</Link> : <a href={item.href} target="_blank" rel="noreferrer">{item.title}</a>}
        <span className="kh-work-context__meta">{item.kind} · {new Date(item.at).toLocaleString('en-GB')}</span>
        <p>{item.detail}</p>
      </li>)}</ul>
      {changes.data.truncated && <p className="kh-work-context__warning">Showing at most 30 recent records. Narrow the period or open the linked areas for the full picture.</p>}
    </>}
  </section>;
};
