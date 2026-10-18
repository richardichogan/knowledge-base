import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { AppDialog } from '../AppDialog';
import { DataNotice } from '../DataNotice';
import type { Watchlist, WatchlistInput, WatchRelationship, WatchRun, WatchRunStatus } from '../../types/watchlists';
import '../../styles/discoverWatchlists.scss';
import { noteDraftIdentity } from '../../services/auth';

const RELATIONSHIPS: WatchRelationship[] = ['competitor', 'partner', 'platform-provider', 'market-reference'];
const STATUS: Record<WatchRunStatus, string> = {
  running: 'Running', changes: 'Meaningful changes', no_meaningful_change: 'No meaningful change',
  insufficient_coverage: 'Insufficient coverage', failed: 'Monitoring failed',
};
const CLAIM_LABELS = {
  positioning: 'Positioning / wording', 'announced-capability': 'Announced capability',
  'documented-availability': 'Documented availability', 'customer-outcome': 'Reported customer outcome',
};
const emptyConfig = (): WatchlistInput => ({
  name: '', description: '', question: '', searchContext: '', entities: [{ name: '', relationship: 'competitor' }],
  criteria: [], baseline: { text: '', links: [] }, sourceIds: [], projectIds: [], cadence: 'weekly', paused: false,
});
const lines = (value: string): string[] => value.split('\n').map(v => v.trim()).filter(Boolean);
const date = (value: string): string => new Date(value).toLocaleString('en-GB');

interface WatchlistDraft { config: WatchlistInput; criteria: string; links: string }
function watchlistDraftKey(existing: Watchlist | null): string {
  const identity = noteDraftIdentity.get();
  if (!identity) throw new Error('Sign in to retain a watchlist draft.');
  return `kh-watchlist-draft:${identity}:${noteDraftIdentity.epoch()}:${existing?.id ?? 'new'}:${existing?.revision ?? 0}`;
}

function isWatchlistDraft(value: unknown): value is WatchlistDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<WatchlistDraft>;
  const c = d.config;
  return typeof d.criteria === 'string' && typeof d.links === 'string' && !!c
    && ['name', 'description', 'question'].every(key => typeof c[key as 'name' | 'description' | 'question'] === 'string')
    && (c.searchContext === undefined || typeof c.searchContext === 'string')
    && Array.isArray(c.entities) && c.entities.length > 0 && c.entities.length <= 20
    && c.entities.every(e => e && typeof e.name === 'string' && RELATIONSHIPS.includes(e.relationship))
    && [c.criteria, c.sourceIds, c.projectIds, c.baseline?.links].every(v => Array.isArray(v) && v.every(item => typeof item === 'string'))
    && typeof c.baseline?.text === 'string' && ['daily', 'weekly'].includes(c.cadence) && typeof c.paused === 'boolean';
}

function watchlistInput(draft: WatchlistDraft): WatchlistInput {
  return {
    ...draft.config,
    entities: draft.config.entities.filter(entity => entity.name.trim()).map(entity => ({ ...entity, name: entity.name.trim() })),
    criteria: lines(draft.criteria),
    baseline: { ...draft.config.baseline, links: lines(draft.links) },
  };
}

function watchlistValidation(config: WatchlistInput): string | null {
  const missing = [!config.name.trim() && 'Name', !config.question.trim() && 'Monitoring question',
    !config.entities.length && 'Competitor list', !config.criteria.length && 'Comparison criteria'].filter(Boolean).join(', ');
  if (missing) return `Complete: ${missing}.`;
  return new Set(config.entities.map(entity => entity.name.toLocaleLowerCase())).size !== config.entities.length
    ? 'Each name in the competitor list must be unique.' : null;
}

const WatchlistForm: React.FC<{ existing: Watchlist | null; onClose: () => void; onSaved: (watchlist: Watchlist) => void }> = ({ existing, onClose, onSaved }) => {
  const [initial] = useState(() => {
    const config = existing?.config ?? emptyConfig();
    const fallback = { config, criteria: config.criteria.join('\n'), links: config.baseline.links.join('\n') };
    try {
      const key = watchlistDraftKey(existing);
      const raw = sessionStorage.getItem(key);
      if (!raw) return { draft: fallback, key, restored: false, error: null };
      const parsed: unknown = JSON.parse(raw);
      if (!isWatchlistDraft(parsed)) throw new Error('The retained watchlist draft could not be read.');
      return { draft: parsed, key, restored: true, error: null };
    } catch (error) {
      console.error('[watchlists] Draft could not be loaded:', error);
      return { draft: fallback, key: null, restored: false, error: 'Draft recovery is unavailable. Keep this form open until it is saved.' };
    }
  });
  const [config, setConfig] = useState<WatchlistInput>(initial.draft.config);
  const [criteria, setCriteria] = useState(initial.draft.criteria);
  const [links, setLinks] = useState(initial.draft.links);
  const [draftError, setDraftError] = useState<string | null>(initial.error);
  const [submitted, setSubmitted] = useState(initial.restored);
  const client = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const savePending = useRef(false);
  const saved = useRef(false);
  useEffect(() => {
    if (!initial.key || saved.current) return;
    try {
      sessionStorage.setItem(initial.key, JSON.stringify({ config, criteria, links }));
      setDraftError(null);
    } catch (error) {
      console.error('[watchlists] Draft could not be retained:', error);
      setDraftError('This browser could not retain your draft. Keep this form open until it is saved.');
    }
  }, [config, criteria, links, initial.key]);
  const input = watchlistInput({ config, criteria, links });
  const entities = input.entities;
  const duplicate = new Set(entities.map(e => e.name.toLocaleLowerCase())).size !== entities.length;
  const validation = watchlistValidation(input);
  const sources = useQuery({ queryKey: ['discovery-feeds'], queryFn: async () => requireApiData(await api.listDiscoveryFeeds()) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: async () => requireApiData(await api.getProjects()) });
  const save = useMutation({
    mutationFn: async () => requireApiData(await api.saveWatchlist(input, existing ?? undefined)),
    onSuccess: watchlist => {
      saved.current = true;
      if (initial.key) {
        try { sessionStorage.removeItem(initial.key); }
        catch (error) { console.error('[watchlists] Saved draft could not be cleared:', error); }
      }
      client.setQueryData<Watchlist[]>(['watchlists'], previous => [watchlist, ...(previous ?? []).filter(w => w.id !== watchlist.id)]);
      void client.invalidateQueries({ queryKey: ['watchlists'] });
      onSaved(watchlist);
      onClose();
    },
    onSettled: () => { savePending.current = false; },
  });
  const patch = (part: Partial<WatchlistInput>): void => { setConfig(c => ({ ...c, ...part })); };
  const submit = (): void => {
    setSubmitted(true);
    if (savePending.current) return;
    if (validation) {
      const field = !config.name.trim() ? 'name' : !config.question.trim() ? 'question'
        : !entities.length || duplicate ? 'competitor' : 'criteria';
      const input = formRef.current?.querySelector<HTMLElement>(`[data-watchlist-field="${field}"]`);
      input?.focus();
      input?.scrollIntoView({ block: 'center' });
      return;
    }
    savePending.current = true;
    save.mutate();
  };
  const close = (): void => { if (!savePending.current) onClose(); };
  return <AppDialog wide title={existing ? 'Edit watchlist' : 'New watchlist'} onClose={close} actions={<>
    <div className="dw-save-status">
      {submitted && validation && <p role="alert" className="dw-hint">{validation} Your entries are retained.</p>}
      {save.isError && <DataNotice title="Watchlist was not saved — your entries are retained" error={save.error} />}
    </div>
    <button type="button" className="dw-button" disabled={save.isPending} onClick={close}>Close</button>
    <button type="button" className="dw-button dw-button--primary" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save watchlist'}</button>
  </>}>
    <form ref={formRef} id="watchlist-form" className="dw-form" noValidate onSubmit={e => { e.preventDefault(); submit(); }}>
      <p className="dw-hint">Enter the competitors you want to follow and your monitoring question. Every run searches the web for those names. Empty extra rows are ignored.</p>
      {!draftError && <p className="dw-hint" role="status">{initial.restored ? 'Your previous draft has been restored. ' : ''}Entries are retained in this browser tab until saved, including if you close this form or reload.</p>}
      {draftError && <p className="dw-hint" role="alert">{draftError}</p>}
      <label className="dw-field">Name<input required maxLength={160} data-dialog-autofocus data-watchlist-field="name" aria-invalid={submitted && !config.name.trim()} value={config.name} onChange={e => patch({ name: e.target.value })} />
        {submitted && !config.name.trim() && <span className="dw-field-error">Enter a watchlist name.</span>}</label>
      <label className="dw-field">Description<textarea maxLength={2000} value={config.description} onChange={e => patch({ description: e.target.value })} /></label>
      <label className="dw-field">Monitoring question<textarea required maxLength={2000} data-watchlist-field="question" aria-invalid={submitted && !config.question.trim()} value={config.question} onChange={e => patch({ question: e.target.value })} />
        {submitted && !config.question.trim() && <span className="dw-field-error">Enter the question this watchlist should monitor.</span>}</label>
      <fieldset className="dw-fieldset"><legend>Competitor list</legend>
        <p className="dw-hint">One name per row. You can also track partners, products or market references.</p>
        {config.entities.map((entity, index) => <div className="dw-entity" key={index}>
          <input aria-label={`Competitor ${index + 1}`} data-watchlist-field="competitor" aria-invalid={submitted && (!entities.length || duplicate)} maxLength={120} value={entity.name}
            onChange={e => patch({ entities: config.entities.map((v, i) => i === index ? { ...v, name: e.target.value } : v) })} />
          <select aria-label={`Relationship ${index + 1}`} value={entity.relationship}
            onChange={e => patch({ entities: config.entities.map((v, i) => i === index ? { ...v, relationship: e.target.value as WatchRelationship } : v) })}>
            {RELATIONSHIPS.map(r => <option key={r} value={r}>{r.replace(/-/g, ' ')}</option>)}
          </select>
          <button type="button" className="dw-button" aria-label={`Remove entity ${index + 1}`} disabled={config.entities.length === 1}
            onClick={() => patch({ entities: config.entities.filter((_, i) => i !== index) })}>Remove</button>
        </div>)}
        <button type="button" className="dw-button" disabled={config.entities.length >= 20} onClick={() => patch({ entities: [...config.entities, { name: '', relationship: 'competitor' }] })}>Add competitor</button>
        {submitted && (!entities.length || duplicate) && <p className="dw-field-error">{duplicate ? 'Each competitor name must be unique.' : 'Enter at least one competitor.'}</p>}
      </fieldset>
      <label className="dw-field">Search context (optional) — added to each name's press release, announcement and blog searches, e.g. "Microsoft partner"
        <input maxLength={120} value={config.searchContext ?? ''} onChange={e => patch({ searchContext: e.target.value })} /></label>
      <label className="dw-field">Comparison criteria (one per line)<textarea required rows={3} data-watchlist-field="criteria" aria-invalid={submitted && !lines(criteria).length} value={criteria} onChange={e => setCriteria(e.target.value)} />
        {submitted && !lines(criteria).length && <span className="dw-field-error">Enter at least one comparison criterion.</span>}</label>
      <label className="dw-field">Our position (optional)<span className="dw-hint">Athena uses saved project information and indexed project notes and documents. Add text only for a specific comparison.</span><textarea rows={5} maxLength={16000} value={config.baseline.text}
        onChange={e => patch({ baseline: { ...config.baseline, text: e.target.value } })} /></label>
      {existing && <p className="dw-hint">Current baseline: v{existing.baselineVersion}. Editing the baseline or its links creates a new version. Existing runs keep their original version.</p>}
      <label className="dw-field">Links to supporting material (one http(s) URL per line, optional)<textarea rows={2} value={links} onChange={e => setLinks(e.target.value)} /></label>
      <fieldset className="dw-fieldset"><legend>Extra Discover sources (optional)</legend>
        <p className="dw-hint">Not required: each run already searches the web for every monitored name. Tick feeds only to also include articles Discover has collected.</p>
        {sources.isLoading && <p className="dw-hint">Loading sources…</p>}
        {sources.isError && <DataNotice title="Sources unavailable" error={sources.error} />}
                {sources.data?.map(s => <label key={s.id} className="dw-check"><input type="checkbox" checked={config.sourceIds.includes(s.id)}
          onChange={e => patch({ sourceIds: e.target.checked ? [...config.sourceIds, s.id] : config.sourceIds.filter(id => id !== s.id) })} />
          {s.title}{!s.isActive && ' (disabled — coverage will be incomplete)'}</label>)}
      </fieldset>
      <fieldset className="dw-fieldset"><legend>Linked projects (optional)</legend>
        <p className="dw-hint">Choose projects to focus the impact assessment. If none are selected, Athena considers your active projects.</p>
        {projects.isError && <DataNotice title="Projects unavailable" error={projects.error} />}
        {projects.data?.filter(p => p.lifecycleState !== 'archived' || config.projectIds.includes(p.id)).map(p => <label key={p.id} className="dw-check"><input type="checkbox" checked={config.projectIds.includes(p.id)}
          onChange={e => patch({ projectIds: e.target.checked ? [...config.projectIds, p.id] : config.projectIds.filter(id => id !== p.id) })} />{p.name}</label>)}
      </fieldset>
      <label className="dw-field">Cadence<select value={config.cadence} onChange={e => patch({ cadence: e.target.value as WatchlistInput['cadence'] })}>
        <option value="daily">Daily</option><option value="weekly">Weekly</option>
      </select></label>
      <label className="dw-check"><input type="checkbox" checked={config.paused} onChange={e => patch({ paused: e.target.checked })} />Paused</label>
      {validation && <p className="dw-hint" role="status">{validation}</p>}
    </form>
  </AppDialog>;
};

const reportDate = (value: string): string => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const RunRecord: React.FC<{ run: WatchRun }> = ({ run }) => {
  const entities = [...new Set([...run.config.entities.map(e => e.name), ...run.findings.map(f => f.entity)])];
  const withoutFindings = entities.filter(name => !run.findings.some(f => f.entity === name));
  const patterns = [...new Set(run.findings.flatMap(f => f.field ? [f.field] : []))]
    .map(field => ({ field, competitors: [...new Set(run.findings.filter(f => f.field === field).map(f => f.entity))] }))
    .filter(pattern => pattern.competitors.length > 1);
  const assessments = run.findings.flatMap(f => (f.projectAssessments ?? []).map(assessment => ({ ...assessment, finding: f })));
  const projectIds = [...new Set(assessments.map(assessment => assessment.projectId))];
  return <article className={`dw-run dw-run--${run.status}`} aria-label={`Analysis from ${reportDate(run.startedAt)}`}>
    <header className="dw-row">
      <h4>Analysis · {reportDate(run.startedAt)}</h4>
      <span className={`dw-run__status dw-run__status--${run.status}`}>{STATUS[run.status]}</span>
    </header>
    <p className="dw-hint">Evidence from {reportDate(run.windowStart)} to {reportDate(run.startedAt)} · {run.findings.length} findings · {run.coverage.uniqueEvents} unique events</p>
    <section className="dw-run__overview" aria-label="Analysis summary">
      <h5>Summary</h5>
      <p className="dw-summary">{run.summary || (run.status === 'running' ? 'Monitoring in progress…' : 'No summary was recorded for this run.')}</p>
    </section>
    {(run.coverage.missingEntities.length > 0 || run.coverage.truncated || (run.coverage.webFailures ?? 0) > 0) && <p className="dw-run__warning">
      Coverage is incomplete.
      {run.coverage.missingEntities.length > 0 && ` No evidence found for: ${run.coverage.missingEntities.join(', ')}.`}
      {(run.coverage.webFailures ?? 0) > 0 && ` ${run.coverage.webFailures} web searches failed.`}
      {run.coverage.truncated && ' The evidence limit was reached.'} Missing evidence does not mean no change.
    </p>}
    <div className="dw-report-layout">
    <div className="dw-report-layout__activity">
    {run.findings.length > 0 && <>
      {entities.map(name => {
        const findings = run.findings.filter(f => f.entity === name);
        if (!findings.length) return null;
        return <section className="dw-competitor" aria-label={`${name} findings`} key={name}>
          <header className="dw-competitor__header"><h5>{name}</h5><span>{findings.length} {findings.length === 1 ? 'finding' : 'findings'}</span></header>
          {findings.map(f => <section className="dw-finding" key={f.id} id={`finding-${run.id}-${f.id}`}>
            <h6 className="dw-finding__title">{f.changed}</h6>
            <p className="dw-finding__meta">{CLAIM_LABELS[f.kind]}</p>
            <dl className="dw-finding__implications">
              <div><dt>Field</dt><dd>{f.field || `Monitored criterion: ${f.criterion}`}</dd></div>
              <div><dt>Microsoft involvement</dt><dd>{f.microsoftInvolvement || 'Not separately assessed in this saved analysis.'}</dd></div>
            </dl>
          </section>)}
        </section>;
      })}
    </>}
    {withoutFindings.length > 0 && run.status !== 'running' && <p className="dw-hint">
      No supported findings recorded for {withoutFindings.join(', ')}. This is not proof of no activity.
    </p>}
    </div>
    {run.findings.length > 0 && <aside className="dw-project-insights" aria-label="What this means for my projects">
      <h5>What this means for my projects</h5>
      {projectIds.map(projectId => {
        const items = assessments.filter(assessment => assessment.projectId === projectId);
        return <section className="dw-project-insights__group" key={projectId}>
          <h6>{items[0]?.projectName}</h6>
          {items.map(item => <div className="dw-project-insights__item" key={`${item.finding.id}-${projectId}`}>
            <a href={`#finding-${run.id}-${item.finding.id}`}>{item.finding.entity} · {item.finding.field || item.finding.criterion}</a>
            <span className="dw-project-insights__relationship">{{
              'confirmed-overlap': 'Confirmed overlap',
              'possible-relevance': 'Possible relevance',
              'insufficient-context': 'Not enough information',
            }[item.relationship]}</span>
            <p>{item.impact}</p>
          </div>)}
        </section>;
      })}
      {run.findings.filter(f => !f.projectAssessments?.length).map(f => <div className="dw-project-insights__item" key={f.id}>
        <a href={`#finding-${run.id}-${f.id}`}>{f.entity} · {f.field || f.criterion}</a>
        <p>{f.projectImpact || f.matters}</p>
        <span className="dw-hint">Saved assessment · project-by-project comparison was not recorded.</span>
      </div>)}
      {patterns.length > 0 && <section className="dw-project-insights__group">
        <h6>Across competitors</h6>
        {patterns.map(pattern => <p key={pattern.field}><strong>{pattern.field}</strong><br />Activity reported by {pattern.competitors.join(', ')}.</p>)}
      </section>}
    </aside>}
    </div>
    <details className="dw-details"><summary>Research scope &amp; comparison context</summary>
      <dl className="dw-scope">
        <dt>Monitoring question</dt><dd>{run.config.question}</dd>
        <dt>Comparison criteria</dt><dd>{run.config.criteria.join(' · ')}</dd>
        <dt>Competitors and references</dt><dd>{run.config.entities.map(e => `${e.name} (${e.relationship})`).join(', ')}</dd>
        <dt>Comparison context · version {run.baselineVersion}</dt><dd className="dw-pre">{run.baseline.text || 'No manual comparison text was recorded.'}</dd>
        <dt>Coverage</dt><dd>
          {run.coverage.webSearches ? `${run.coverage.webSearches - (run.coverage.webFailures ?? 0)}/${run.coverage.webSearches} web searches succeeded. ` : ''}
          {run.coverage.sourcesChecked > 0 && `${run.coverage.sourcesHealthy}/${run.coverage.sourcesChecked} Discover sources healthy. `}
          {run.coverage.uniqueEvents} unique events.
        </dd>
      </dl>
      {run.baseline.links.map(link => <a key={link} href={link} target="_blank" rel="noreferrer">{link}</a>)}
    </details>
    {run.evidence.length > 0 && <details className="dw-details"><summary>All research sources ({run.evidence.length} unique events)</summary>
      <ul className="dw-evidence">{run.evidence.map(e => <li key={e.id}><a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>
        <span className="dw-evidence__meta">{reportDate(e.publishedAt)}{e.syndicatedIds.length > 0 && ` · ${e.syndicatedIds.length} syndicated copies counted once`}</span>
      </li>)}</ul>
    </details>}
  </article>;
};

const WatchlistDetail: React.FC<{ watchlist: Watchlist; onEdit: () => void }> = ({ watchlist, onEdit }) => {
  const client = useQueryClient();
  const runPending = useRef(false);
  const [historyPage, setHistoryPage] = useState(1);
  const history = useQuery({ queryKey: ['watchlist-runs', watchlist.id, historyPage], queryFn: async () => requireApiData(await api.getWatchlistRuns(watchlist.id, historyPage)),
    refetchInterval: query => query.state.data?.some(r => r.status === 'running') ? 5000 : false });
  const baselines = useQuery({ queryKey: ['watchlists', watchlist.id, 'baselines', watchlist.baselineVersion],
    queryFn: async () => requireApiData(await api.getWatchlistBaselines(watchlist.id)) });
  const run = useMutation({
    mutationFn: async () => requireApiData(await api.runWatchlist(watchlist.id)),
    onSettled: () => { runPending.current = false; setHistoryPage(1); void client.invalidateQueries({ queryKey: ['watchlists'] }); void client.invalidateQueries({ queryKey: ['watchlist-runs', watchlist.id] }); },
  });
  const running = run.isPending || watchlist.lastRun?.status === 'running' || history.data?.some(r => r.status === 'running');
  return <section className="dw-detail" aria-label={watchlist.config.name}>
    <header className="dw-row"><h3>{watchlist.config.name}</h3><div className="dw-actions">
      <button type="button" className="dw-button" onClick={onEdit}>Edit watchlist</button>
      <button type="button" className="dw-button dw-button--primary" disabled={watchlist.config.paused || running}
        onClick={() => { if (!runPending.current) { runPending.current = true; run.mutate(); } }}>{running ? 'Monitoring…' : 'Run now'}</button>
    </div></header>
    <p className="dw-hint">{watchlist.config.paused ? 'Paused' : `${watchlist.config.cadence} · next due ${date(watchlist.nextRunAt)}`}</p>
    <div className="dw-entities">{watchlist.config.entities.map(e => <span className="dw-badge" key={e.name}>{e.name} · {e.relationship.replace(/-/g, ' ')}</span>)}</div>
    <details className="dw-details"><summary>Monitoring brief</summary>
      <p className="dw-summary">{watchlist.config.question}</p>
      {watchlist.config.description && <p className="dw-hint">{watchlist.config.description}</p>}
    </details>
    <details className="dw-details"><summary>Comparison context &amp; version history</summary>
      <p className="dw-pre">{watchlist.config.baseline.text}</p>
      {baselines.isError && <DataNotice title="Comparison history unavailable" error={baselines.error} />}
      {baselines.data?.map(b => <details className="dw-details" key={b.version}><summary>Version {b.version} · {date(b.createdAt)}</summary>
        <p className="dw-pre">{b.baseline.text}</p>
        {b.baseline.links.map(link => <a href={link} key={link} target="_blank" rel="noreferrer">{link}</a>)}
      </details>)}
    </details>
    {watchlist.config.projectIds.length > 0 && <p className="dw-hint">Linked projects: {watchlist.config.projectIds.map((id, i) => <React.Fragment key={id}>{i > 0 && ', '}<a href={`/projects?projectId=${encodeURIComponent(id)}`}>{id}</a></React.Fragment>)}</p>}
    <h3 className="dw-history-title">{historyPage === 1 ? 'Latest analysis' : 'Earlier analyses'}</h3>
    {run.isError && <DataNotice title="Monitoring could not start" error={run.error} />}
    {history.isError && <DataNotice title="Watchlist history unavailable" error={history.error} onRetry={() => { void history.refetch(); }} />}
    {history.isLoading && <p className="dw-hint" role="status">Loading history…</p>}
    {history.data?.length === 0 && <p className="dw-empty">No analyses yet. Choose Run now to search for competitor developments, or wait for the next scheduled run. Missing evidence is not the same as no meaningful change.</p>}
    {history.data?.map((r, index) => index === 0 ? <RunRecord key={r.id} run={r} /> :
      <details className="dw-details dw-history-entry" key={r.id}><summary>{reportDate(r.startedAt)} · {STATUS[r.status]} · {r.findings.length} findings</summary>
        <RunRecord run={r} />
      </details>)}
    {(historyPage > 1 || history.data?.length === 100) && <div className="dw-actions" aria-label="Watchlist history pages">
      <button type="button" className="dw-button" disabled={historyPage === 1 || history.isLoading} onClick={() => setHistoryPage(p => p - 1)}>Newer runs</button>
      <span className="dw-hint">History page {historyPage}</span>
      <button type="button" className="dw-button" disabled={history.data?.length !== 100 || history.isLoading} onClick={() => setHistoryPage(p => p + 1)}>Older runs</button>
    </div>}
  </section>;
};

export const DiscoverWatchlists: React.FC = () => {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Watchlist | null | undefined>(undefined);
  const [draft, setDraft] = useState<WatchlistDraft | null>(null);
  const [draftReadError, setDraftReadError] = useState<Error | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [draftClearError, setDraftClearError] = useState<Error | null>(null);
  const saveDraftPending = useRef(false);
  const saveDraft = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('No retained draft is available.');
      const input = watchlistInput(draft);
      const validation = watchlistValidation(input);
      if (validation) throw new Error(validation);
      return requireApiData(await api.saveWatchlist(input));
    },
    onSuccess: watchlist => {
      try {
        sessionStorage.removeItem(watchlistDraftKey(null));
        setDraftClearError(null);
      } catch (error) {
        console.error('[watchlists] Saved draft could not be cleared:', error);
        setDraftClearError(new Error('The watchlist is saved, but its browser draft could not be cleared. Do not save it again.'));
      }
      setDraft(null);
      setSelected(watchlist.id);
      setSavedName(watchlist.config.name);
      client.setQueryData<Watchlist[]>(['watchlists'], previous => [watchlist, ...(previous ?? []).filter(item => item.id !== watchlist.id)]);
      void client.invalidateQueries({ queryKey: ['watchlists'] });
    },
    onSettled: () => { saveDraftPending.current = false; },
  });
  useEffect(() => {
    if (editing !== undefined) return;
    try {
      const raw = sessionStorage.getItem(watchlistDraftKey(null));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (raw && !isWatchlistDraft(parsed)) throw new Error('The retained watchlist draft could not be read. It has not been removed.');
      setDraft(isWatchlistDraft(parsed) && (
        parsed.config.name.trim() || parsed.config.question.trim() || parsed.config.description.trim()
        || parsed.config.entities.some(entity => entity.name.trim()) || parsed.criteria.trim()
        || parsed.links.trim() || parsed.config.baseline.text.trim()
      ) ? parsed : null);
      setDraftReadError(null);
    } catch (error) {
      console.error('[watchlists] Retained draft could not be read:', error);
      setDraftReadError(error instanceof Error ? error : new Error('Could not read your retained watchlist draft.'));
    }
  }, [editing]);
  const lists = useQuery({ queryKey: ['watchlists'], queryFn: async () => requireApiData(await api.getWatchlists()) });
  const draftValidation = draft ? watchlistValidation(watchlistInput(draft)) : null;
  const active = lists.data?.find(w => w.id === selected) ?? lists.data?.[0];
  return <section className="dw" aria-label="Discover Watchlists">
    <header className="dw-row"><div><h2>Watchlists</h2><p className="dw-hint">Follow your competitors and see what has changed.</p></div>
      <button type="button" className="dw-button dw-button--primary" disabled={saveDraft.isPending} onClick={() => { setSavedName(null); setEditing(null); }}>{draft ? 'Resume draft' : 'New watchlist'}</button></header>
    {savedName && <p className="dw-hint" role="status">Watchlist "{savedName}" saved.</p>}
    {draftReadError && <DataNotice title="Could not recover the watchlist draft" error={draftReadError} />}
    {draftClearError && <DataNotice title="Watchlist saved; draft cleanup failed" error={draftClearError} />}
    {draft && <section className="dw-draft" aria-label="Unsaved watchlist draft">
      <div className="dw-row"><h3>{draft.config.name.trim() || 'Untitled watchlist'} <span className="dw-draft__state">Unsaved draft</span></h3>
        <div className="dw-actions">
          <button type="button" className="dw-button" disabled={saveDraft.isPending} onClick={() => setEditing(null)}>Continue editing</button>
          {!draftValidation && <button type="button" className="dw-button dw-button--primary" disabled={saveDraft.isPending} onClick={() => {
            if (saveDraftPending.current) return;
            saveDraftPending.current = true;
            saveDraft.mutate();
          }}>{saveDraft.isPending ? 'Saving…' : 'Save watchlist'}</button>}
        </div></div>
      <p className="dw-hint">These entries are retained in this tab, but have not been saved as a watchlist.</p>
      {draftValidation && <p className="dw-field-error">Not saved. {draftValidation}</p>}
      {saveDraft.isError && <DataNotice title="Watchlist was not saved — your entries are retained" error={saveDraft.error} />}
      {draft.config.question && <p className="dw-summary">{draft.config.question}</p>}
      <div className="dw-entities">{draft.config.entities.filter(entity => entity.name.trim()).map((entity, index) =>
        <span className="dw-badge" key={index}>{entity.name}</span>)}</div>
    </section>}
    {lists.isError && <DataNotice title="Watchlists unavailable" error={lists.error} onRetry={() => { void lists.refetch(); }} />}
    {lists.isLoading && <p className="dw-hint" role="status">Loading watchlists…</p>}
    {lists.data?.length === 0 && <p className="dw-empty">{draft ? 'No saved watchlists yet. Continue the draft above to finish saving it.' : 'No saved watchlists yet. Add competitors, a monitoring question and comparison criteria to create one.'}</p>}
    {lists.data && lists.data.length > 0 && <label className="dw-field dw-selector">Watchlist<select value={active?.id ?? ''} onChange={e => setSelected(e.target.value)}>
      {lists.data.map(w => <option value={w.id} key={w.id}>{w.config.name}{w.config.paused ? ' (paused)' : ''}{w.lastRun ? ` · ${STATUS[w.lastRun.status]}` : ''}</option>)}
    </select></label>}
    {active && <WatchlistDetail key={active.id} watchlist={active} onEdit={() => setEditing(active)} />}
    {editing !== undefined && <WatchlistForm existing={editing} onSaved={watchlist => { setSelected(watchlist.id); setSavedName(watchlist.config.name); }} onClose={() => setEditing(undefined)} />}
  </section>;
};
