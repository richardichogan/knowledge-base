import React, { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import type { JobDefinition, JobProposal } from '../../types/jobs';

export function JobSummary({ definition: d }: { definition: JobDefinition }): React.ReactElement {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return <div className="kh-jobs__summary">
    <strong>{d.name}</strong>
    <p>{d.kind} · {d.schedule.days.map(day => days[day]).join(', ')} at {d.schedule.times.join(', ')} · {d.schedule.timezone}</p>
    <p>{d.approval === 'required' ? 'Approval before external delivery' : 'Automatic delivery'} · Outputs: {d.outputs.join(', ') || 'source ingestion'}</p>
    {d.deviceId && <p>Desktop: {d.deviceId} · Input: {d.inputFolder || 'none'} · File output: {d.outputFolder || 'none'}</p>}
    {d.prompt && <pre className="kh-jobs__content">{d.prompt}</pre>}
  </div>;
}
export function JobArtifacts({ value }: { value: unknown }): React.ReactElement {
  const links = new Set<string>();
  function visit(v: unknown): void {
    if (typeof v === 'string' && /^(https:\/\/[^\s]+|\/(?:think|chat|jobs)\?[^\s]+)$/.test(v)) links.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  }
  visit(value);
  const artifacts = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const contentKeys = ['markdown', 'slackText', 'bluesky', 'linkedin'];
  const hasContent = artifacts && contentKeys.some(key => typeof artifacts[key] === 'string');
  return <><div className="kh-jobs__actions">{[...links].map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</div>
    {hasContent && contentKeys.map(key => typeof artifacts[key] === 'string' && artifacts[key] ? <section key={key}>
      <h4>{key === 'markdown' ? 'Generated content' : key === 'slackText' ? 'Slack summary' : `${key === 'bluesky' ? 'Bluesky' : 'LinkedIn'} copy (published blog link appended at delivery)`}</h4>
      <pre className="kh-jobs__content">{artifacts[key]}</pre>
    </section> : null)}
    {hasContent && artifacts.blog !== undefined && <section><h4>Exact blog payload</h4><pre className="kh-jobs__content">{JSON.stringify(artifacts.blog, null, 2)}</pre></section>}
    {hasContent ? <details className="kh-jobs__event"><summary>Source evidence, account details and delivery receipts</summary><pre className="kh-jobs__content">{JSON.stringify(value, null, 2)}</pre></details>
      : <pre className="kh-jobs__content">{JSON.stringify(value, null, 2)}</pre>}</>;
}
export function JobChatConfirmations({ sessionId }: { sessionId: string | null }): React.ReactElement | null {
  const [items, setItems] = useState<JobProposal[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setItems([]); setError('');
    if (!sessionId) return;
    const load = (): void => {
      void api.jobs<JobProposal[]>(`/proposals?sessionId=${encodeURIComponent(sessionId)}`)
        .then(result => { if (active) setItems(result); })
        .catch(err => { if (active) setError(describeApiError(err)); });
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId]);
  async function decide(id: string, confirm: boolean): Promise<void> {
    setBusy(true); setError('');
    try {
      await api.jobs(`/proposals/${id}/${confirm ? 'confirm' : 'reject'}`, 'POST', {});
      setItems(current => current.filter(p => p.id !== id));
    } catch (err) { setError(describeApiError(err)); }
    finally { setBusy(false); }
  }
  if (!items.length && !error) return null;
  return <section className="kh-jobs kh-jobs--chat" aria-label="Job confirmations">
    {error && <p role="alert" className="kh-jobs__error">{error}</p>}
    {items.map(item => <article className="kh-jobs__card" key={item.id}>
      <h3>{item.payload.operation === 'save' ? 'Review job configuration' : item.payload.operation === 'approve' ? 'Approve delivery' : item.payload.preview ? 'Preview job' : 'Run job now'}</h3>
      <JobSummary definition={item.payload.definition} />
      {item.payload.artifacts && <JobArtifacts value={item.payload.artifacts} />}
      <p>{item.payload.operation === 'save' ? item.payload.enabled ? 'Confirming enables this schedule and its stated permissions.' : 'This will save a paused draft.' : 'Confirm only after reviewing the configuration and outgoing content.'}</p>
      <div className="kh-jobs__actions">
        <button type="button" disabled={busy} onClick={() => { void decide(item.id, true); }}>Confirm</button>
        <button type="button" disabled={busy} onClick={() => { void decide(item.id, false); }}>Reject</button>
      </div>
    </article>)}
  </section>;
}
