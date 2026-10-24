import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppDialog } from '../components/AppDialog';
import { JobArtifacts, JobSummary } from '../components/jobs/JobReview';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { useAthenaContext } from '../context/AthenaContext';
import type { JobDefinition, JobDevice, JobEvent, JobRun, ManagedJob } from '../types/jobs';

const initial: JobDefinition = { name: '', kind: 'prompt', prompt: '', schedule: { timezone: 'Europe/London', days: [1, 2, 3, 4, 5], times: ['09:00'] },
  approval: 'required', deviceId: '', inputFolder: '', outputFolder: '', outputs: ['think'] };
const outputChoices: JobDefinition['outputs'] = ['think', 'slack', 'blog', 'bluesky', 'linkedin', 'file'];
const date = (v: string | null): string => v ? new Date(v).toLocaleString('en-GB') : 'Not scheduled';

export function JobsPage(): React.ReactElement {
  const { openAthena } = useAthenaContext();
  const [params, setParams] = useSearchParams();
  const selected = params.get('jobId') ?? '';
  const linkedRun = params.get('runId');
  const [jobs, setJobs] = useState<ManagedJob[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [devices, setDevices] = useState<JobDevice[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ManagedJob | 'new' | null>(null);
  const [definition, setDefinition] = useState<JobDefinition>(initial);
  const [enabled, setEnabled] = useState(false);
  const [times, setTimes] = useState('09:00');
  const [next, setNext] = useState<string[]>([]);
  const [view, setView] = useState<JobRun | null>(null);
  const [reconcile, setReconcile] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [offset, setOffset] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const load = useCallback(async (): Promise<void> => {
    const query = new URLSearchParams({ offset: String(offset), ...(selected ? { jobId: selected } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}) });
    const [j, r, e, d] = await Promise.all([
      api.jobs<ManagedJob[]>(), api.jobs<JobRun[]>(`/runs?${query}`),
      api.jobs<JobEvent[]>(`/audit?${new URLSearchParams({ offset: String(auditOffset), ...(selected ? { jobId: selected } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}) })}`), api.jobs<JobDevice[]>('/devices'),
    ]);
    setJobs(j); setRuns(r); setEvents(e); setDevices(d);
  }, [selected, offset, auditOffset, status, from]);
  useEffect(() => {
    let active = true;
    const refresh = (): void => { void load().catch(err => { if (active) setError(describeApiError(err)); }); };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [load]);
  const runId = view?.id;
  useEffect(() => {
    if (!linkedRun) return;
    let active = true;
    void api.jobs<JobRun>(`/runs/${encodeURIComponent(linkedRun)}`).then(run => { if (active) setView(run); })
      .catch(err => { if (active) setError(describeApiError(err)); });
    return () => { active = false; };
  }, [linkedRun]);
  useEffect(() => {
    if (!runId) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.jobs<JobRun>(`/runs/${runId}`).then(run => { if (active) setView(run); })
        .catch(err => { if (active) setError(describeApiError(err)); });
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [runId]);
  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError('');
    try { await action(); await load(); }
    catch (err) { setError(describeApiError(err)); }
    finally { setBusy(false); }
  }
  function edit(job: ManagedJob | 'new'): void {
    const d = job === 'new' ? initial : job.definition;
    setDefinition(structuredClone(d)); setTimes(d.schedule.times.join(', '));
    setEnabled(job === 'new' ? false : job.enabled); setNext([]); setEditing(job);
  }
  function updated(): JobDefinition { return { ...definition, schedule: { ...definition.schedule, times: times.split(',').map(t => t.trim()) } }; }
  const folders = devices.find(d => d.id === definition.deviceId)?.folders ?? [];
  return <main className="kh-jobs">
    <header className="kh-jobs__header"><div><h1>Jobs</h1><p>Scheduled prompts, imports and publishing. You can also design and manage these with Athena from any chat.</p></div>
      <button type="button" onClick={() => edit('new')}>New job</button></header>
    {error && <p role="alert" className="kh-jobs__error">{error}</p>}
    <div className="kh-jobs__grid">{jobs.map(job => <article className={`kh-jobs__card${job.id === selected ? ' kh-jobs__card--selected' : ''}`} key={job.id}>
      <JobSummary definition={job.definition} />
      <p>{job.enabled ? 'Enabled' : 'Paused / draft'} · Revision {job.revision}</p><p>Next: {date(job.nextAt)}</p>
      {job.definition.deviceId && <p>Device last seen: {date(devices.find(d => d.id === job.definition.deviceId)?.seenAt ?? null)}</p>}
      <div className="kh-jobs__actions">
        <button type="button" onClick={() => edit(job)}>Configure</button>
        <button type="button" onClick={() => openAthena(`Help me review and refine this scheduled job's prompt and workflow. Discuss missing decisions before proposing a change. Job ID: ${job.id}.`, { type: 'job', id: job.id, title: job.definition.name, detail: JSON.stringify(job) })}>Design with Athena</button>
        <button type="button" disabled={busy} onClick={() => { void act(async () => { const run = await api.jobs<JobRun>(`/${job.id}/run`, 'POST', { preview: true }); setView(run); }); }}>Preview</button>
        <button type="button" onClick={() => { setParams({ jobId: job.id }); setOffset(0); setAuditOffset(0); }}>History</button>
        {job.enabled && <button type="button" disabled={busy} onClick={() => { void act(() => api.jobs(`/${job.id}/pause`, 'POST', {})); }}>Pause</button>}
        <button type="button" disabled={busy} onClick={() => { void act(async () => {
          if (await confirmDialog('Archive this job? Its schedule stops; all run and audit history is retained.', { title: job.definition.name, confirmLabel: 'Archive', tone: 'danger' })) await api.jobs(`/${job.id}/archive`, 'POST', {});
        }); }}>Archive</button>
      </div>
    </article>)}</div>
    <section className="kh-jobs__section"><h2>Run history and approvals</h2>
      <div className="kh-jobs__filters">
        <label>Job<select value={selected} onChange={e => { setParams(e.target.value ? { jobId: e.target.value } : {}); setOffset(0); setAuditOffset(0); }}>
          <option value="">All jobs</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.definition.name}</option>)}</select></label>
        <label>Status<select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All statuses</option>{['queued', 'running', 'waiting-file', 'waiting-device', 'awaiting-approval', 'succeeded', 'partial', 'failed', 'unconfirmed', 'missed', 'rejected'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Since<input type="date" value={from} onChange={e => { setFrom(e.target.value); setOffset(0); }} /></label>
      </div>
      <div className="kh-jobs__runs">{runs.map(run => <button className="kh-jobs__run" type="button" key={run.id} onClick={() => { setReconcile(''); setView(run); }}>
        <strong>{run.definition.name}{run.preview ? ' (preview)' : ''}</strong><span>{run.status}</span><span>{date(run.scheduledAt)} · v{run.revision}</span>
      </button>)}</div>
      {!runs.length && <p>No runs match these filters.</p>}
      <div className="kh-jobs__actions"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button>
        <button type="button" disabled={runs.length < 25} onClick={() => setOffset(offset + 25)}>Older</button></div>
    </section>
    <section className="kh-jobs__section"><h2>Audit log</h2>
      {events.map(event => <details className="kh-jobs__event" key={event.id}><summary>{date(event.createdAt)} · {event.event} · {event.actor}</summary><JobArtifacts value={event.detail} />
        {event.runId && <button type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${event.runId}`))); }}>Open run</button>}</details>)}
      {!events.length && <p>No audit events yet.</p>}
      <div className="kh-jobs__actions"><button type="button" disabled={!auditOffset} onClick={() => setAuditOffset(Math.max(0, auditOffset - 50))}>Newer events</button>
        <button type="button" disabled={events.length < 50} onClick={() => setAuditOffset(auditOffset + 50)}>Older events</button></div>
    </section>
    {editing && <AppDialog title={editing === 'new' ? 'Create job' : 'Configure job'} settings onClose={() => setEditing(null)} actions={<>
      <button className="kh-dialog__button" type="button" onClick={() => setEditing(null)}>Cancel</button>
      <button className="kh-dialog__button" type="button" onClick={() => {
        openAthena('Help me refine the prompt and workflow for this job configuration. Discuss it before proposing changes. These are draft settings, not permission to enable or publish.', {
          type: 'job', title: definition.name || 'New job', detail: JSON.stringify({ ...(editing !== 'new' ? { id: editing.id, revision: editing.revision } : {}), definition: updated() }),
        }); setEditing(null);
      }}>Discuss with Athena</button>
      {editing !== 'new' && <button className="kh-dialog__button" type="button" disabled={busy || !editing.enabled} onClick={() => { void act(async () => {
        if (await confirmDialog('Run the saved configuration now, using its saved approval and publishing permissions? Unsaved edits are not included.', { title: editing.definition.name, confirmLabel: 'Run now' })) {
          await api.jobs(`/${editing.id}/run`, 'POST', { preview: false }); setEditing(null);
        }
      }); }}>Run saved version now</button>}
      <button className="kh-dialog__button kh-dialog__button--primary" type="button" disabled={busy} onClick={() => { void act(async () => {
        await api.jobs(editing === 'new' ? '' : `/${editing.id}`, editing === 'new' ? 'POST' : 'PUT', { definition: updated(), enabled, revision: editing === 'new' ? 0 : editing.revision }); setEditing(null);
      }); }}>Confirm configuration</button></>}>
      <div className="kh-jobs kh-jobs__editor">
        <label>Name<input data-dialog-autofocus value={definition.name} onChange={e => setDefinition({ ...definition, name: e.target.value })} /></label>
        <label>Action<select value={definition.kind} onChange={e => setDefinition({ ...definition, kind: e.target.value as JobDefinition['kind'], outputs: e.target.value === 'content-sync' || e.target.value === 'm365-import' ? [] : ['think'] })}>
          <option value="prompt">Scheduled Athena prompt</option><option value="content-sync">Content sync</option><option value="m365-import">Ingest M365 Markdown report</option><option value="weekly-microsoft">Weekly Microsoft updates</option></select></label>
        <label>Prompt and editorial instructions<textarea rows={7} value={definition.prompt} onChange={e => setDefinition({ ...definition, prompt: e.target.value })} /></label>
        <label>Timezone<input value={definition.schedule.timezone} onChange={e => setDefinition({ ...definition, schedule: { ...definition.schedule, timezone: e.target.value } })} /></label>
        <div className="kh-jobs__actions"><button type="button" onClick={() => setDefinition({ ...definition, schedule: { ...definition.schedule, days: [1, 2, 3, 4, 5] } })}>Workdays</button><button type="button" onClick={() => setDefinition({ ...definition, schedule: { ...definition.schedule, days: [0, 1, 2, 3, 4, 5, 6] } })}>Full week</button></div>
        <fieldset><legend>Run on selected days</legend><div className="kh-jobs__choices">{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => <label key={day}>
          <input type="checkbox" checked={definition.schedule.days.includes(i)} onChange={e => setDefinition({ ...definition, schedule: { ...definition.schedule, days: e.target.checked ? [...definition.schedule.days, i].sort() : definition.schedule.days.filter(d => d !== i) } })} />{day}</label>)}</div></fieldset>
        <label>Scheduled times (HH:mm, comma separated)<input value={times} onChange={e => setTimes(e.target.value)} /></label>
        <button type="button" disabled={busy} onClick={() => { void act(async () => setNext(await api.jobs<string[]>('/schedule-preview', 'POST', { definition: updated() }))); }}>Show next five runs</button>
        {!!next.length && <p>{next.map(t => new Date(t).toLocaleString('en-GB', { timeZone: definition.schedule.timezone })).join(' · ')}</p>}
        <fieldset><legend>Output destinations</legend><div className="kh-jobs__choices">{outputChoices.map(o => <label key={o}><input type="checkbox" checked={definition.outputs.includes(o)} onChange={e => setDefinition({ ...definition, outputs: e.target.checked ? [...definition.outputs, o] : definition.outputs.filter(x => x !== o) })} />{o}</label>)}</div></fieldset>
        <label>Publishing mode<select value={definition.approval} onChange={e => setDefinition({ ...definition, approval: e.target.value as JobDefinition['approval'] })}>
          <option value="required">Require approval before delivery</option><option value="automatic">Automatically deliver to configured destinations</option></select></label>
        <label>Desktop device (for local files)<select value={definition.deviceId} onChange={e => setDefinition({ ...definition, deviceId: e.target.value, inputFolder: '', outputFolder: '' })}>
          <option value="">Cloud only / not configured</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name} · seen {date(d.seenAt)}</option>)}</select></label>
        <label>Authorised input folder<select value={definition.inputFolder} onChange={e => setDefinition({ ...definition, inputFolder: e.target.value })}><option value="">Select folder</option>{folders.map(f => <option key={f.id} value={f.path}>{f.path}</option>)}</select></label>
        <label>Authorised Markdown output folder<select value={definition.outputFolder} onChange={e => setDefinition({ ...definition, outputFolder: e.target.value })}><option value="">Select folder</option>{folders.map(f => <option key={f.id} value={f.path}>{f.path}</option>)}</select></label>
        <p>Grant new folders in Athena Desktop → Library → Folders on this PC. File jobs wait while the device is offline. M365 imports wait for the dated report until the next occurrence. File outputs use a unique run filename.</p>
        <label className="kh-jobs__check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable this schedule with the settings and permissions above</label>
        {error && <p role="alert" className="kh-jobs__error">{error}</p>}
      </div>
    </AppDialog>}
    {view && <AppDialog title={`${view.definition.name} — ${view.status}`} settings onClose={() => setView(null)} actions={<>
      <button className="kh-dialog__button" type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}`))); }}>Refresh</button>
      {view.status === 'awaiting-approval' && <><button className="kh-dialog__button" disabled={busy} type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}/decision`, 'POST', { approve: false }))); }}>Reject</button>
        <button className="kh-dialog__button kh-dialog__button--primary" disabled={busy} type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}/decision`, 'POST', { approve: true }))); }}>Approve shown content</button></>}
      {['failed', 'partial'].includes(view.status) && <button className="kh-dialog__button" disabled={busy} type="button" onClick={() => { void act(async () => { await api.jobs(`/runs/${view.id}/retry`, 'POST', {}); setView(await api.jobs<JobRun>(`/runs/${view.id}`)); }); }}>Retry failed steps</button>}
    </>}>
      <div className="kh-jobs"><JobSummary definition={view.definition} /><p>Occurrence: {date(view.scheduledAt)} · Version {view.revision} · {view.preview ? 'Preview — no delivery' : 'Live run'}</p>
        {view.status === 'awaiting-approval' && <p>Approve the exact payloads below. The confirmed public blog URL will be appended to the shown social copy after blog publication.</p>}
        {view.steps.map(s => <div className="kh-jobs__event" key={s.key}><strong>{s.key} · {s.status}</strong>{s.error && <p>{s.error}</p>}
          {s.result !== undefined && <details><summary>Step output</summary><JobArtifacts value={s.result} /></details>}</div>)}
        <h3>Saved output and delivery artifacts</h3><JobArtifacts value={view.artifacts} />
        {view.status === 'unconfirmed' && <div className="kh-jobs__editor"><h3>Reconcile uncertain delivery</h3><p>Check the destination first. Never retry an uncertain post without checking whether it exists.</p>
          <label>Step<select value={reconcile} onChange={e => setReconcile(e.target.value)}><option value="">Select step</option>{view.steps.filter(s => s.status === 'unconfirmed' || s.status === 'running').map(s => <option key={s.key}>{s.key}</option>)}</select></label>
          <label>Confirmed public URL<input value={receiptUrl} onChange={e => setReceiptUrl(e.target.value)} /></label>
          <div className="kh-jobs__actions">{[true, false].map(delivered => <button key={String(delivered)} type="button" disabled={busy || !reconcile} onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}/reconcile`, 'POST', { step: reconcile, delivered, url: receiptUrl }))); }}>{delivered ? 'Confirm it was delivered' : 'Confirm nothing was delivered'}</button>)}</div>
        </div>}
        {error && <p role="alert" className="kh-jobs__error">{error}</p>}
        <Link to={`/jobs?jobId=${view.jobId}`}>Job history</Link>
      </div>
    </AppDialog>}
  </main>;
}
