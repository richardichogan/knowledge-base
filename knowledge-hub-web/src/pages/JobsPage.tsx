import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Add, CalendarTools, ChevronRight, OverflowMenuVertical } from '@carbon/icons-react';
import { AppDialog } from '../components/AppDialog';
import { JobArtifacts, JobSummary } from '../components/jobs/JobReview';
import { jobKinds, outputNames, scheduleLabel, statusLabel, runStatusLabel } from '../components/jobs/jobPresentation';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { useAthenaContext } from '../context/AthenaContext';
import type { JobDefinition, JobDevice, JobEvent, JobRun, ManagedJob } from '../types/jobs';

const initial: JobDefinition = { name: '', kind: 'prompt', prompt: '', schedule: { timezone: 'Europe/London', days: [1, 2, 3, 4, 5], times: ['09:00'] },
  approval: 'required', deviceId: '', inputFolder: '', outputFolder: '', outputs: ['think'] };
const outputChoices: JobDefinition['outputs'] = ['think', 'slack', 'blog', 'bluesky', 'linkedin', 'file'];
const date = (v: string | null, timezone?: string): string => v ? new Date(v).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}),
}) : 'Not scheduled';

export function JobsPage({ onClose }: { onClose?: () => void }): React.ReactElement {
  const { openAthena } = useAthenaContext();
  const location = useLocation();
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
  useEffect(() => { setNext([]); }, [definition, times]);
  const [tab, setTab] = useState<'schedules' | 'runs' | 'audit'>(selected ? 'runs' : 'schedules');
  const [menu, setMenu] = useState<string | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(true);
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
    void load().catch(err => { if (active) setError(describeApiError(err)); })
      .finally(() => { if (active) setLoading(false); });
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
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Element && !event.target.closest('.kh-jobs__row')) setMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
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
  const localFiles = definition.kind === 'm365-import' || definition.outputs.includes('file');
  const generates = definition.kind === 'prompt' || definition.kind === 'weekly-microsoft';
  const publishes = definition.outputs.some(output => ['slack', 'blog', 'bluesky', 'linkedin'].includes(output));
  function filterJob(id: string): void {
    setParams(id ? { jobId: id } : {}, { replace: true, state: location.state });
    setOffset(0); setAuditOffset(0);
  }
  function discuss(job: ManagedJob): void {
    openAthena(`Help me review and refine this scheduled job's prompt and workflow. Discuss missing decisions before proposing a change. Job ID: ${job.id}.`,
      { type: 'job', id: job.id, title: job.definition.name, detail: JSON.stringify(job) });
    onClose?.();
  }
  function closeRun(): void {
    setView(null);
    if (linkedRun) filterJob(selected);
  }
  return <div className="kh-jobs kh-jobs--manager" aria-busy={busy || loading}>
    <header className="kh-jobs__header"><p>Prompts, imports and publishing, on your schedule.<br /><span className="kh-jobs__muted">Set them up here or talk them through with Athena.</span></p>
      <button className="kh-jobs__primary" type="button" onClick={() => edit('new')}><Add size={16} />New job</button></header>
    {error && <p role="alert" className="kh-jobs__error">{error}</p>}
    <nav className="kh-jobs__tabs" aria-label="Jobs views">
      <button type="button" aria-pressed={tab === 'schedules'} onClick={() => setTab('schedules')}>Schedules</button>
      <button type="button" aria-pressed={tab === 'runs'} onClick={() => setTab('runs')}>Runs & approvals</button>
      <button type="button" aria-pressed={tab === 'audit'} onClick={() => setTab('audit')}>Audit log</button>
    </nav>
    {loading && <p className="kh-jobs__empty" role="status">Loading jobs…</p>}
    {!loading && tab === 'schedules' && <section aria-label="Scheduled jobs" className="kh-jobs__list">
      {jobs.map(job => {
        const d = job.definition;
        const needsSetup = d.kind === 'm365-import' && (!d.deviceId || !d.inputFolder);
        return <article className={`kh-jobs__row${job.id === selected ? ' kh-jobs__row--selected' : ''}`} key={job.id}
          onKeyDown={event => {
            if (event.key === 'Escape' && menu === job.id) {
              event.preventDefault(); event.stopPropagation(); setMenu(null); menuTrigger.current?.focus();
            }
          }}>
          <CalendarTools size={20} className="kh-jobs__row-icon" />
          <div className="kh-jobs__identity"><button className="kh-jobs__name" type="button" onClick={() => edit(job)}>{d.name}</button>
            <p className="kh-jobs__muted">{jobKinds[d.kind]}{d.outputs.length > 0 && ` · ${d.outputs.map(output => outputNames[output]).join(', ')}`}</p>
            {d.outputs.some(output => ['slack', 'blog', 'bluesky', 'linkedin'].includes(output)) && <span className="kh-jobs__meta">{d.approval === 'required' ? 'Approval before publishing' : 'Automatic publishing'}</span>}
          </div>
          <div className="kh-jobs__schedule"><span>{scheduleLabel(d.schedule)}</span>
            <span className="kh-jobs__meta">{d.schedule.timezone}</span>
            <span className="kh-jobs__meta">{job.enabled ? `Next ${date(job.nextAt, d.schedule.timezone)}` : needsSetup ? 'Choose a desktop and folder to start' : 'No upcoming runs'}</span>
            {d.deviceId && <span className="kh-jobs__meta">Desktop seen {date(devices.find(device => device.id === d.deviceId)?.seenAt ?? null)}</span>}
          </div>
          <span className={`kh-jobs__status${job.enabled ? ' kh-jobs__status--enabled' : needsSetup ? ' kh-jobs__status--setup' : ''}`}>{job.enabled ? 'Active' : needsSetup ? 'Needs setup' : 'Paused'}</span>
          <div className="kh-jobs__row-actions">
            <button className="kh-jobs__configure" type="button" aria-label={`Configure ${d.name}`} onClick={() => edit(job)}>{needsSetup ? 'Set up' : 'Edit'}<ChevronRight size={16} /></button>
              <button className="kh-jobs__icon-button" type="button" aria-label={`More actions for ${d.name}`} aria-expanded={menu === job.id} aria-controls={menu === job.id ? `job-actions-${job.id}` : undefined}
                onClick={event => { menuTrigger.current = event.currentTarget; setMenu(menu === job.id ? null : job.id); }}><OverflowMenuVertical size={20} /></button>
          </div>
              {menu === job.id && <div className="kh-jobs__menu" id={`job-actions-${job.id}`} role="group" aria-label={`Actions for ${d.name}`}
                onClick={() => { setMenu(null); menuTrigger.current?.focus(); }}>
                <button type="button" onClick={() => discuss(job)}>Design with Athena</button>
                {job.enabled && <button type="button" disabled={busy} onClick={() => { void act(async () => {
                  if (await confirmDialog('Run this job now with its saved settings? It goes through editorial review and approval exactly like a scheduled run, then delivers to its saved destinations.', { title: d.name, confirmLabel: 'Run now' })) {
                    setView(await api.jobs<JobRun>(`/${job.id}/run`, 'POST', { preview: false }));
                  }
                }); }}>Run now</button>}
                <button type="button" disabled={busy} onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/${job.id}/run`, 'POST', { preview: true }))); }}>Preview output</button>
                <button type="button" onClick={() => { filterJob(job.id); setTab('runs'); }}>Run history</button>
                {job.enabled && <button type="button" disabled={busy} onClick={() => { void act(() => api.jobs(`/${job.id}/pause`, 'POST', {})); }}>Pause schedule</button>}
                <button className="kh-jobs__danger" type="button" disabled={busy} onClick={() => { void act(async () => {
                  if (await confirmDialog('Archive this job? Its schedule stops; all run and audit history is retained.', { title: d.name, confirmLabel: 'Archive', tone: 'danger' })) await api.jobs(`/${job.id}/archive`, 'POST', {});
                }); }}>Archive job</button>
              </div>}
        </article>;
      })}
      {!jobs.length && <div className="kh-jobs__empty"><h3>No scheduled jobs yet</h3><p>Create a job or ask Athena to help you design one.</p></div>}
    </section>}
    {!loading && tab !== 'schedules' && <section className="kh-jobs__section" aria-label={tab === 'runs' ? 'Run history and approvals' : 'Audit log'}>
      <div className="kh-jobs__filters">
        <label>Job<select value={selected} onChange={e => filterJob(e.target.value)}>
          <option value="">All jobs</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.definition.name}</option>)}</select></label>
        <label>Status<select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); setAuditOffset(0); }}>
          <option value="">All statuses</option>{['queued', 'running', 'waiting-file', 'waiting-device', 'awaiting-approval', 'succeeded', 'partial', 'failed', 'unconfirmed', 'missed', 'rejected'].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
        <label>Since<input type="date" value={from} onChange={e => { setFrom(e.target.value); setOffset(0); setAuditOffset(0); }} /></label>
      </div>
      {tab === 'runs' ? <>
      <div className="kh-jobs__runs">{runs.map(run => <button className="kh-jobs__run" type="button" key={run.id} onClick={() => { setReconcile(''); setView(run); }}>
        <strong>{run.definition.name}{run.preview ? ' (preview)' : ''}</strong><span className="kh-jobs__status">{runStatusLabel(run)}</span><span>{date(run.scheduledAt)} · v{run.revision}</span>
      </button>)}</div>
      {!runs.length && <div className="kh-jobs__empty"><h3>No runs to show</h3><p>{selected || status || from ? 'Try a different job, status or date.' : 'Scheduled runs and previews will appear here, along with anything needing approval.'}</p></div>}
      {(offset > 0 || runs.length >= 25) && <div className="kh-jobs__actions"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button>
        <button type="button" disabled={runs.length < 25} onClick={() => setOffset(offset + 25)}>Older</button></div>
      }</> : <>
      {events.map(event => <details className="kh-jobs__event" key={event.id}><summary>{date(event.createdAt)} · {event.event} · {event.actor}</summary><JobArtifacts value={event.detail} />
        {event.runId && <button type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${event.runId}`))); }}>Open run</button>}</details>)}
      {!events.length && <div className="kh-jobs__empty"><h3>No audit events to show</h3><p>Configuration changes, approvals and delivery outcomes are recorded here.</p></div>}
      {(auditOffset > 0 || events.length >= 50) && <div className="kh-jobs__actions"><button type="button" disabled={!auditOffset} onClick={() => setAuditOffset(Math.max(0, auditOffset - 50))}>Newer events</button>
        <button type="button" disabled={events.length < 50} onClick={() => setAuditOffset(auditOffset + 50)}>Older events</button></div>
      }</>}
    </section>}
    {editing && <AppDialog title={editing === 'new' ? 'Create job' : 'Configure job'} settings onClose={() => setEditing(null)} actions={<>
      <button className="kh-dialog__button" type="button" onClick={() => setEditing(null)}>Cancel</button>
      <button className="kh-dialog__button kh-dialog__button--primary" type="button" disabled={busy} onClick={() => { void act(async () => {
        await api.jobs(editing === 'new' ? '' : `/${editing.id}`, editing === 'new' ? 'POST' : 'PUT', { definition: updated(), enabled, revision: editing === 'new' ? 0 : editing.revision }); setEditing(null);
      }); }}>{busy ? 'Saving…' : 'Save job'}</button></>}>
      <div className="kh-jobs kh-jobs__editor">
        <div className="kh-jobs__assist"><p className="kh-jobs__muted">Need help with the prompt or workflow?</p><button type="button" onClick={() => {
          openAthena('Help me refine the prompt and workflow for this job configuration. Discuss it before proposing changes. These are draft settings, not permission to enable or publish.', {
            type: 'job', title: definition.name || 'New job', detail: JSON.stringify({ ...(editing !== 'new' ? { id: editing.id, revision: editing.revision } : {}), definition: updated() }),
          }); setEditing(null); onClose?.();
        }}>Discuss with Athena</button></div>
        <section className="kh-jobs__form-section"><h3>Job details</h3><div className="kh-jobs__field-grid">
        <label>Name<input data-dialog-autofocus value={definition.name} onChange={e => setDefinition({ ...definition, name: e.target.value })} /></label>
        <label>Action<select value={definition.kind} onChange={e => setDefinition({ ...definition, kind: e.target.value as JobDefinition['kind'], outputs: e.target.value === 'content-sync' || e.target.value === 'm365-import' ? [] : ['think'] })}>
          <option value="prompt">Scheduled Athena prompt</option><option value="content-sync">Content sync</option><option value="m365-import">Ingest M365 Markdown report</option><option value="weekly-microsoft">Weekly Microsoft updates</option></select></label>
        </div>
        {generates && <label>Prompt and editorial instructions<textarea rows={5} value={definition.prompt} onChange={e => setDefinition({ ...definition, prompt: e.target.value })} /></label>}
        </section>
        <section className="kh-jobs__form-section"><h3>Schedule</h3>
        <div className="kh-jobs__field-grid">
        <label>Timezone<input value={definition.schedule.timezone} onChange={e => setDefinition({ ...definition, schedule: { ...definition.schedule, timezone: e.target.value } })} /></label>
        <label>Times (24-hour, comma separated)<input value={times} onChange={e => setTimes(e.target.value)} /></label>
        </div>
        <fieldset><legend>Run on</legend>
        <div className="kh-jobs__actions"><button type="button" onClick={() => setDefinition({ ...definition, schedule: { ...definition.schedule, days: [1, 2, 3, 4, 5] } })}>Workdays</button><button type="button" onClick={() => setDefinition({ ...definition, schedule: { ...definition.schedule, days: [0, 1, 2, 3, 4, 5, 6] } })}>Full week</button></div>
        <div className="kh-jobs__choices">{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => <label key={day}>
          <input type="checkbox" checked={definition.schedule.days.includes(i)} onChange={e => setDefinition({ ...definition, schedule: { ...definition.schedule, days: e.target.checked ? [...definition.schedule.days, i].sort() : definition.schedule.days.filter(d => d !== i) } })} />{day}</label>)}</div></fieldset>
        <div><button type="button" disabled={busy} onClick={() => { void act(async () => setNext(await api.jobs<string[]>('/schedule-preview', 'POST', { definition: updated() }))); }}>Check next five runs</button></div>
        {!!next.length && <p className="kh-jobs__muted">{next.map(t => date(t, definition.schedule.timezone)).join(' · ')}</p>}
        </section>
        {generates && <section className="kh-jobs__form-section"><h3>Output & publishing</h3>
        <fieldset><legend>Save or send to</legend><div className="kh-jobs__choices">{outputChoices.map(o => <label key={o}><input type="checkbox" checked={definition.outputs.includes(o)} onChange={e => setDefinition({ ...definition, outputs: e.target.checked ? [...definition.outputs, o] : definition.outputs.filter(x => x !== o) })} />{outputNames[o]}</label>)}</div></fieldset>
        {publishes && <label>Publishing mode<select value={definition.approval} onChange={e => setDefinition({ ...definition, approval: e.target.value as JobDefinition['approval'] })}>
          <option value="required">Require approval before delivery</option><option value="automatic">Automatically deliver to configured destinations</option></select></label>
        }</section>}
        {localFiles && <section className="kh-jobs__form-section"><h3>Desktop files</h3>
        <label>Desktop device<select value={definition.deviceId} onChange={e => setDefinition({ ...definition, deviceId: e.target.value, inputFolder: '', outputFolder: '' })}>
          <option value="">Cloud only / not configured</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name} · seen {date(d.seenAt)}</option>)}</select></label>
        {definition.kind === 'm365-import' && <label>Authorised input folder<select value={definition.inputFolder} onChange={e => setDefinition({ ...definition, inputFolder: e.target.value })}><option value="">Select folder</option>{folders.map(f => <option key={f.id} value={f.path}>{f.path}</option>)}</select></label>}
        {definition.outputs.includes('file') && <label>Authorised Markdown output folder<select value={definition.outputFolder} onChange={e => setDefinition({ ...definition, outputFolder: e.target.value })}><option value="">Select folder</option>{folders.map(f => <option key={f.id} value={f.path}>{f.path}</option>)}</select></label>}
        <p className="kh-jobs__muted">Grant folders in Athena Desktop → Library → Folders on this PC. File jobs wait while the desktop is offline.</p>
        {definition.kind === 'm365-import' && <p className="kh-jobs__muted">Imports wait for the dated M365 report until the next occurrence. This schedules pickup, not report generation.</p>}
        {definition.outputs.includes('file') && <p className="kh-jobs__muted">Each run writes a unique Markdown file without overwriting existing content.</p>}
        </section>}
        <label className="kh-jobs__check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable this schedule with the settings and permissions above</label>
        {editing !== 'new' && <details className="kh-jobs__event"><summary>Saved version & manual run</summary>
          <p className="kh-jobs__muted">Version {editing.revision}. A manual run uses saved settings, not the edits above.</p>
          <button type="button" disabled={busy || !editing.enabled} onClick={() => { void act(async () => {
            if (await confirmDialog('Run the saved configuration now, using its saved approval and publishing permissions? Unsaved edits are not included.', { title: editing.definition.name, confirmLabel: 'Run now' })) {
              await api.jobs(`/${editing.id}/run`, 'POST', { preview: false }); setEditing(null);
            }
          }); }}>Run saved version now</button>
        </details>}
        {error && <p role="alert" className="kh-jobs__error">{error}</p>}
      </div>
    </AppDialog>}
    {view && <AppDialog title={`${view.definition.name} — ${runStatusLabel(view)}`} settings onClose={closeRun} actions={<>
      <button className="kh-dialog__button" type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}`))); }}>Refresh</button>
      {view.status === 'awaiting-approval' && <><button className="kh-dialog__button" disabled={busy} type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}/decision`, 'POST', { approve: false }))); }}>Reject</button>
        <button className="kh-dialog__button kh-dialog__button--primary" disabled={busy} type="button" onClick={() => { void act(async () => setView(await api.jobs<JobRun>(`/runs/${view.id}/decision`, 'POST', { approve: true }))); }}>Approve shown content</button></>}
      {['failed', 'partial'].includes(view.status) && <button className="kh-dialog__button" disabled={busy} type="button" onClick={() => { void act(async () => { await api.jobs(`/runs/${view.id}/retry`, 'POST', {}); setView(await api.jobs<JobRun>(`/runs/${view.id}`)); }); }}>Re-run</button>}
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
        <Link to={`/jobs?jobId=${view.jobId}`} state={location.state} replace onClick={() => { setTab('runs'); setView(null); setOffset(0); setAuditOffset(0); }}>Job history</Link>
      </div>
    </AppDialog>}
  </div>;
}
