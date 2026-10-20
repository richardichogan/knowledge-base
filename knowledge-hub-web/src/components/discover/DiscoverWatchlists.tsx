import React, { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { AppDialog } from '../AppDialog';
import { DataNotice } from '../DataNotice';
import { groupProjectsByParent } from '../ProjectOptions';
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
        {groupProjectsByParent(projects.data ?? [], config.projectIds).map(group => <fieldset key={group.label} className="dw-project-group">
          <legend>{group.label}</legend>
          {group.projects.map(p => <label key={p.id} className="dw-check"><input type="checkbox" checked={config.projectIds.includes(p.id)}
            onChange={e => patch({ projectIds: e.target.checked ? [...config.projectIds, p.id] : config.projectIds.filter(id => id !== p.id) })} />{p.name}</label>)}
        </fieldset>)}
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
const IMPACT_LABELS = {
  'confirmed-overlap': 'Confirmed overlap', 'possible-relevance': 'Possible relevance', 'insufficient-context': 'Not enough information',
} as const;
const BRIEFING_STATUSES = new Set<WatchRunStatus>(['changes', 'no_meaningful_change', 'insufficient_coverage']);
const STALE_AFTER_DAYS = { daily: 2, weekly: 14 } as const;
const NOW_LIMIT = 5;
const PROJECT_LIMIT = 4;
const PROJECT_ITEM_LIMIT = 2;
const SUMMARY_CLAMP = 560;
const DAY = 86_400_000;

type Finding = WatchRun['findings'][number];
type CompanyState = 'changes' | 'quiet' | 'incomplete' | 'missing' | 'unchecked';
interface Company { name: string; relationship: WatchRelationship | null; findings: Finding[]; state: CompanyState; label: string }

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const findingAnchor = (run: WatchRun, finding: Finding): string => `finding-${run.id}-${finding.id}`.replace(/[^\w-]/g, '_');
const relationshipLabel = (relationship: WatchRelationship): string => relationship.replace(/-/g, ' ');

function coverageGaps(run: WatchRun): string[] {
  const failures = run.coverage.webFailures ?? 0;
  return [
    ...(run.coverage.missingEntities.length ? [`No evidence was found for ${run.coverage.missingEntities.join(', ')}.`] : []),
    ...(failures > 0 ? [`${count(failures, 'web search', 'web searches')} failed.`] : []),
    ...(run.coverage.truncated ? ['The evidence limit was reached, so some material was not read.'] : []),
  ];
}

function companyStates(watchlist: Watchlist, run: WatchRun | undefined): Company[] {
  const relationships = new Map<string, WatchRelationship>();
  [...watchlist.config.entities, ...(run?.config.entities ?? [])].forEach(e => { if (!relationships.has(e.name)) relationships.set(e.name, e.relationship); });
  const names = [...new Set([...watchlist.config.entities.map(e => e.name), ...(run?.config.entities.map(e => e.name) ?? []), ...(run?.findings.map(f => f.entity) ?? [])])];
  const incomplete = !!run && (run.status === 'insufficient_coverage' || run.coverage.truncated || (run.coverage.webFailures ?? 0) > 0);
  return names.map(name => {
    const findings = run?.findings.filter(f => f.entity === name) ?? [];
    const base = { name, relationship: relationships.get(name) ?? null, findings };
    if (findings.length) return { ...base, state: 'changes', label: count(findings.length, 'development') };
    if (!run || !run.config.entities.some(e => e.name === name)) return { ...base, state: 'unchecked', label: 'Not checked yet' };
    if (run.coverage.missingEntities.includes(name)) return { ...base, state: 'missing', label: 'No evidence found' };
    if (incomplete) return { ...base, state: 'incomplete', label: 'No change found · coverage incomplete' };
    return { ...base, state: 'quiet', label: 'No meaningful change found' };
  });
}

// Breadth before depth: one development per company in watchlist order. Athena does not rank findings.
function keyDevelopments(companies: Company[]): Finding[] {
  const picked: Finding[] = [];
  for (let round = 0; picked.length < NOW_LIMIT; round++) {
    const next = companies.flatMap(c => c.findings.slice(round, round + 1));
    if (!next.length) break;
    picked.push(...next.slice(0, NOW_LIMIT - picked.length));
  }
  return picked;
}

const FindingSources: React.FC<{ run: WatchRun; finding: Finding }> = ({ run, finding }) => {
  const sources = [...new Set(finding.evidenceIds)].flatMap(id => run.evidence.filter(e => e.id === id));
  if (!sources.length) return <p className="dw-hint">No source link was saved for this development.</p>;
  return <ul className="dw-evidence" aria-label="Sources">{sources.map(e => <li key={e.id}><a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>
    <span className="dw-evidence__meta">{reportDate(e.publishedAt)}{e.syndicatedIds.length > 0 && ` · ${e.syndicatedIds.length} syndicated copies counted once`}</span>
  </li>)}</ul>;
};

const FindingItem: React.FC<{ run: WatchRun; finding: Finding; open: boolean; onToggle: (open: boolean) => void }> = ({ run, finding, open, onToggle }) => {
  const anchor = findingAnchor(run, finding);
  const sourceCount = new Set(finding.evidenceIds).size;
  return <article className="dw-finding" id={anchor} tabIndex={-1} aria-labelledby={`${anchor}-title`}>
    <p className="dw-finding__meta">{CLAIM_LABELS[finding.kind]} · {finding.field || finding.criterion}</p>
    <h6 className="dw-finding__title" id={`${anchor}-title`}>{finding.changed}</h6>
    {finding.matters && <p className="dw-finding__matters"><span className="dw-label">Why it matters</span>{finding.matters}</p>}
    <details className="dw-details" open={open} onToggle={e => onToggle(e.currentTarget.open)}>
      <summary>Detail and {count(sourceCount, 'source')}</summary>
      <dl className="dw-facts">
        {finding.uncertainty && <div><dt>Not yet established</dt><dd>{finding.uncertainty}</dd></div>}
        <div><dt>Microsoft involvement</dt><dd>{finding.microsoftInvolvement || 'Not separately assessed in this saved analysis.'}</dd></div>
        <div><dt>Project impact</dt><dd>
          {finding.projectAssessments?.length ? <ul className="dw-impacts">{finding.projectAssessments.map(a => <li key={a.projectId}>
            <span className="dw-impacts__project">{a.projectName} · {IMPACT_LABELS[a.relationship]}</span>{a.impact}
          </li>)}</ul>
            : finding.projectImpact ? <>{finding.projectImpact}<span className="dw-impacts__note">Saved assessment · project-by-project comparison was not recorded.</span></>
              : 'No project impact was recorded.'}
        </dd></div>
      </dl>
      <FindingSources run={run} finding={finding} />
    </details>
  </article>;
};

const useOpenSet = (): [Set<string>, (id: string, open: boolean) => void] => {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string, value: boolean): void => setOpen(previous => {
    if (previous.has(id) === value) return previous;
    const next = new Set(previous);
    if (value) next.add(id); else next.delete(id);
    return next;
  });
  return [open, toggle];
};

const NowSection: React.FC<{
  watchlist: Watchlist; latest: WatchRun | undefined; briefing: WatchRun | undefined; companies: Company[]; running: boolean; loading: boolean;
  onOpen: (finding: Finding) => void;
}> = ({ watchlist, latest, briefing, companies, running, loading, onOpen }) => {
  const [fullSummary, setFullSummary] = useState(false);
  const summaryId = useId();
  const developments = keyDevelopments(companies);
  const total = briefing?.findings.length ?? 0;
  const gaps = briefing ? coverageGaps(briefing) : [];
  const ageDays = briefing ? Math.floor((Date.now() - new Date(briefing.completedAt ?? briefing.startedAt).getTime()) / DAY) : 0;
  const stale = !!briefing && ageDays > STALE_AFTER_DAYS[watchlist.config.cadence];
  const patterns = briefing ? [...new Set(briefing.findings.flatMap(f => f.field ? [f.field] : []))]
    .map(field => ({ field, companies: [...new Set(briefing.findings.filter(f => f.field === field).map(f => f.entity))] }))
    .filter(pattern => pattern.companies.length > 1) : [];
  const assessments = briefing?.findings.flatMap(f => (f.projectAssessments ?? []).map(a => ({ ...a, finding: f }))) ?? [];
  const projects = [...new Set(assessments.map(a => a.projectId))].map(id => assessments.filter(a => a.projectId === id));
  const tally = (['changes', 'quiet', 'incomplete', 'missing', 'unchecked'] as const).map(state => ({ state, n: companies.filter(c => c.state === state).length }))
    .filter(t => t.n > 0).map(t => ({ ...t, text: {
      changes: `${t.n} with developments`, quiet: `${t.n} with no meaningful change`, incomplete: `${t.n} with incomplete coverage`,
      missing: `${t.n} with no evidence found`, unchecked: `${t.n} not checked yet`,
    }[t.state] }));
  const summary = briefing?.summary.trim() ?? '';
  const longSummary = summary.length > SUMMARY_CLAMP;
  const projectGroup = (items: typeof assessments): React.ReactNode => <section className="dw-project-insights__group" key={items[0]!.projectId}>
    <h6>{items[0]!.projectName}</h6>
    <ul className="dw-plain-list">{items.slice(0, PROJECT_ITEM_LIMIT).map(item => <li className="dw-project-insights__item" key={`${item.finding.id}-${item.projectId}`}>
      <span className="dw-project-insights__relationship">{IMPACT_LABELS[item.relationship]}</span>
      <p>{item.impact}</p>
      <button type="button" className="dw-link-button" onClick={() => onOpen(item.finding)}>{item.finding.entity} · {item.finding.field || item.finding.criterion}</button>
    </li>)}</ul>
    {items.length > PROJECT_ITEM_LIMIT && <p className="dw-hint">{count(items.length - PROJECT_ITEM_LIMIT, 'more implication')} in the company breakdown.</p>}
  </section>;

  return <section className="dw-now" aria-labelledby={`${summaryId}-title`}>
    <h4 id={`${summaryId}-title`}>What you need to know now</h4>
    {loading && <p className="dw-hint" role="status">Loading the latest check…</p>}
    {running && <p className="dw-notice" role="status">A check is running. This briefing will update when it finishes.</p>}
    {latest?.status === 'failed' && <p className="dw-notice dw-notice--error">
      The latest check on {reportDate(latest.startedAt)} failed{latest.summary ? `: ${latest.summary}` : '.'} {briefing ? `Showing the last completed check from ${reportDate(briefing.startedAt)}.` : 'There is no completed check to show yet.'}
    </p>}
    {!loading && !briefing && !running && latest?.status !== 'failed' && <p className="dw-empty">
      No checks yet. Choose Run now to search for developments, or wait for the next scheduled check. Missing evidence is not the same as no meaningful change.
    </p>}
    {briefing && <>
      <p className="dw-now__asof">
        <span className={`dw-run__status dw-run__status--${briefing.status}`}>{STATUS[briefing.status]}</span>
        <span>Check on {reportDate(briefing.startedAt)} · evidence from {reportDate(briefing.windowStart)} to {reportDate(briefing.startedAt)}</span>
      </p>
      {stale && <p className="dw-notice dw-notice--warning">
        This briefing is {count(ageDays, 'day')} old. {watchlist.config.paused ? 'Monitoring is paused, so it is not being refreshed.' : `A ${watchlist.config.cadence} check was expected sooner; run now for current information.`}
      </p>}
      {gaps.length > 0 && <p className="dw-notice dw-notice--warning dw-run__warning">Coverage was incomplete. {gaps.join(' ')} Missing evidence does not mean no change.</p>}
      {summary ? <>
        <p id={summaryId} className={`dw-summary dw-now__summary${longSummary && !fullSummary ? ' dw-now__summary--clamped' : ''}`}>{summary}</p>
        {longSummary && <button type="button" className="dw-link-button" aria-expanded={fullSummary} aria-controls={summaryId}
          onClick={() => setFullSummary(v => !v)}>{fullSummary ? 'Show less' : 'Show full summary'}</button>}
      </> : <p className="dw-hint">No summary was recorded for this check.</p>}
      <p className="dw-now__tally">{count(companies.length, 'company', 'companies')}: {tally.map(t => t.text).join(' · ')}</p>
      {developments.length > 0 && <section className="dw-now__block" aria-label="Key developments">
        <h5>Key developments</h5>
        <p className="dw-hint">{total > developments.length ? `Showing ${developments.length} of ${total}: ` : ''}one per company first, in your watchlist order. Every development is in the company breakdown.</p>
        <ol className="dw-now__list">{developments.map(f => <li className="dw-now__item" key={f.id}>
          <p className="dw-now__company">{f.entity} · {CLAIM_LABELS[f.kind]}</p>
          <p className="dw-now__headline">{f.changed}</p>
          {f.matters && <p className="dw-now__matters">{f.matters}</p>}
          <button type="button" className="dw-link-button" onClick={() => onOpen(f)}>Detail and {count(new Set(f.evidenceIds).size, 'source')} in {f.entity}</button>
        </li>)}</ol>
      </section>}
      {patterns.length > 0 && <section className="dw-now__block" aria-label="Seen across several companies">
        <h5>Seen across several companies</h5>
        <ul className="dw-plain-list dw-now__patterns">{patterns.map(p => <li key={p.field}><strong>{p.field}</strong> · {p.companies.join(', ')}</li>)}</ul>
      </section>}
      {projects.length > 0 && <section className="dw-now__block dw-project-insights" aria-label="What this means for my projects">
        <h5>What this means for my projects</h5>
        {projects.slice(0, PROJECT_LIMIT).map(projectGroup)}
        {projects.length > PROJECT_LIMIT && <details className="dw-details"><summary>{count(projects.length - PROJECT_LIMIT, 'more project')}</summary>
          {projects.slice(PROJECT_LIMIT).map(projectGroup)}
        </details>}
      </section>}
    </>}
  </section>;
};

const COMPANY_NOTE: Record<CompanyState, (name: string, date: string | null) => string> = {
  changes: (_, date) => `Developments recorded in the check on ${date}.`,
  quiet: (name, date) => `No meaningful change was found for ${name} in the check on ${date}.`,
  incomplete: (_, date) => `No development was recorded in the check on ${date}, but coverage was incomplete, so this is not proof of no change.`,
  missing: (name, date) => `No evidence was found for ${name} in the check on ${date}. This is not proof of no activity.`,
  unchecked: (name, date) => date ? `${name} was not part of the check on ${date}. Run now to include it.` : `${name} has not been checked yet.`,
};

const CompanyBreakdown: React.FC<{
  run: WatchRun | undefined; companies: Company[]; selected: Company; onSelect: (name: string) => void;
  openIds: Set<string>; onToggle: (id: string, open: boolean) => void;
}> = ({ run, companies, selected, onSelect, openIds, onToggle }) => {
  const base = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = companies.indexOf(selected);
  const onKeyDown = (event: React.KeyboardEvent, current: number): void => {
    const last = companies.length - 1;
    const target = { ArrowDown: current + 1, ArrowRight: current + 1, ArrowUp: current - 1, ArrowLeft: current - 1, Home: 0, End: last }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = (target + companies.length) % companies.length;
    onSelect(companies[next]!.name);
    tabs.current[next]?.focus();
  };
  return <section className="dw-companies" aria-labelledby={`${base}-title`}>
    <h4 id={`${base}-title`}>Company by company</h4>
    <div className="dw-companies__layout">
      <div role="tablist" aria-label="Companies" aria-orientation="vertical" className="dw-company-tabs">
        {companies.map((company, i) => <button type="button" role="tab" key={company.name} id={`${base}-tab-${i}`} ref={el => { tabs.current[i] = el; }}
          aria-selected={i === index} aria-controls={`${base}-panel`} tabIndex={i === index ? 0 : -1}
          className={`dw-company-tab dw-company-tab--${company.state}`} onClick={() => onSelect(company.name)} onKeyDown={e => onKeyDown(e, i)}>
          <span className="dw-company-tab__name">{company.name}</span>
          <span className="dw-company-tab__state">{company.label}</span>
        </button>)}
      </div>
      <section role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${index}`} tabIndex={0} className="dw-company">
        <header className="dw-company__header">
          <h5>{selected.name}</h5>
          {selected.relationship && <span className="dw-badge">{relationshipLabel(selected.relationship)}</span>}
        </header>
        <p className={`dw-company__note dw-company__note--${selected.state}`}>{COMPANY_NOTE[selected.state](selected.name, run ? reportDate(run.startedAt) : null)}</p>
        {run && selected.findings.map(f => <FindingItem key={f.id} run={run} finding={f}
          open={openIds.has(findingAnchor(run, f))} onToggle={open => onToggle(findingAnchor(run, f), open)} />)}
      </section>
    </div>
  </section>;
};

const HistoryRun: React.FC<{ run: WatchRun }> = ({ run }) => {
  const [openIds, toggle] = useOpenSet();
  const gaps = coverageGaps(run);
  const names = [...new Set(run.findings.map(f => f.entity))];
  return <details className={`dw-details dw-history-entry dw-run dw-run--${run.status}`}>
    <summary>{reportDate(run.startedAt)} · {STATUS[run.status]} · {count(run.findings.length, 'development')}</summary>
    <p className="dw-summary">{run.summary || (run.status === 'running' ? 'Monitoring in progress…' : 'No summary was recorded for this check.')}</p>
    {gaps.length > 0 && <p className="dw-notice dw-notice--warning dw-run__warning">Coverage was incomplete. {gaps.join(' ')} Missing evidence does not mean no change.</p>}
    {names.map(name => <section className="dw-history-company" key={name} aria-label={`${name} developments`}>
      <p className="dw-history-company__name">{name}</p>
      {run.findings.filter(f => f.entity === name).map(f => <FindingItem key={f.id} run={run} finding={f}
        open={openIds.has(f.id)} onToggle={open => toggle(f.id, open)} />)}
    </section>)}
  </details>;
};

const WatchlistDetail: React.FC<{ watchlist: Watchlist; onEdit: () => void }> = ({ watchlist, onEdit }) => {
  const client = useQueryClient();
  const runPending = useRef(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [openIds, toggleOpen] = useOpenSet();
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const fetchRuns = (page: number) => async () => requireApiData(await api.getWatchlistRuns(watchlist.id, page));
  const recent = useQuery({ queryKey: ['watchlist-runs', watchlist.id, 1], queryFn: fetchRuns(1),
    refetchInterval: query => query.state.data?.some(r => r.status === 'running') ? 5000 : false });
  const older = useQuery({ queryKey: ['watchlist-runs', watchlist.id, historyPage], queryFn: fetchRuns(historyPage), enabled: historyPage > 1 });
  const baselines = useQuery({ queryKey: ['watchlists', watchlist.id, 'baselines', watchlist.baselineVersion],
    queryFn: async () => requireApiData(await api.getWatchlistBaselines(watchlist.id)) });
  const run = useMutation({
    mutationFn: async () => requireApiData(await api.runWatchlist(watchlist.id)),
    onSettled: () => { runPending.current = false; setHistoryPage(1); void client.invalidateQueries({ queryKey: ['watchlists'] }); void client.invalidateQueries({ queryKey: ['watchlist-runs', watchlist.id] }); },
  });
  const runs = recent.data ?? [];
  const latest = runs.find(r => r.status !== 'running');
  const briefing = runs.find(r => BRIEFING_STATUSES.has(r.status));
  const running = run.isPending || watchlist.lastRun?.status === 'running' || runs.some(r => r.status === 'running');
  const companies = companyStates(watchlist, briefing);
  const selected = companies.find(c => c.name === selectedName) ?? companies.find(c => c.findings.length) ?? companies[0];
  const history = historyPage === 1 ? recent : older;
  const earlier = (history.data ?? []).filter(r => r.status !== 'running' && (historyPage > 1 || r.id !== briefing?.id));
  useEffect(() => {
    if (!focusTarget) return;
    const target = document.getElementById(focusTarget);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    target?.focus({ preventScroll: true });
    setFocusTarget(null);
  }, [focusTarget]);
  const openFinding = (finding: Finding): void => {
    if (!briefing) return;
    const anchor = findingAnchor(briefing, finding);
    setSelectedName(finding.entity);
    toggleOpen(anchor, true);
    setFocusTarget(anchor);
  };
  return <section className="dw-detail" aria-label={watchlist.config.name}>
    <header className="dw-row"><div><h3>{watchlist.config.name}</h3>
      <p className="dw-hint">{watchlist.config.paused ? 'Paused' : `${watchlist.config.cadence === 'daily' ? 'Daily' : 'Weekly'} checks · next due ${date(watchlist.nextRunAt)}`}</p></div>
      <div className="dw-actions">
        <button type="button" className="dw-button" onClick={onEdit}>Edit watchlist</button>
        <button type="button" className="dw-button dw-button--primary" disabled={watchlist.config.paused || running}
          onClick={() => { if (!runPending.current) { runPending.current = true; run.mutate(); } }}>{running ? 'Monitoring…' : 'Run now'}</button>
      </div></header>
    {run.isError && <DataNotice title="Monitoring could not start" error={run.error} />}
    {recent.isError && <DataNotice title="Watchlist history unavailable" error={recent.error} onRetry={() => { void recent.refetch(); }} />}
    <NowSection watchlist={watchlist} latest={latest} briefing={briefing} companies={companies} running={running}
      loading={recent.isLoading} onOpen={openFinding} />
    {selected && <CompanyBreakdown run={briefing} companies={companies} selected={selected} onSelect={setSelectedName}
      openIds={openIds} onToggle={toggleOpen} />}
    <section className="dw-setup" aria-label="Monitoring setup and history">
      <h4>Monitoring setup and history</h4>
      <details className="dw-details"><summary>Monitoring brief</summary>
        <p className="dw-summary">{watchlist.config.question}</p>
        {watchlist.config.description && <p className="dw-hint">{watchlist.config.description}</p>}
        <dl className="dw-scope">
          <dt>Comparison criteria</dt><dd>{watchlist.config.criteria.join(' · ')}</dd>
          <dt>Companies and references</dt><dd>{watchlist.config.entities.map(e => `${e.name} (${relationshipLabel(e.relationship)})`).join(', ')}</dd>
          {watchlist.config.projectIds.length > 0 && <><dt>Linked projects</dt><dd>{watchlist.config.projectIds.map((id, i) => <React.Fragment key={id}>{i > 0 && ', '}<a href={`/projects?projectId=${encodeURIComponent(id)}`}>{id}</a></React.Fragment>)}</dd></>}
        </dl>
      </details>
      <details className="dw-details"><summary>Comparison context &amp; version history</summary>
        <p className="dw-pre">{watchlist.config.baseline.text || 'No manual comparison text. Athena uses saved project information.'}</p>
        {baselines.isError && <DataNotice title="Comparison history unavailable" error={baselines.error} />}
        {baselines.data?.map(b => <details className="dw-details" key={b.version}><summary>Version {b.version} · {date(b.createdAt)}</summary>
          <p className="dw-pre">{b.baseline.text}</p>
          {b.baseline.links.map(link => <a href={link} key={link} target="_blank" rel="noreferrer">{link}</a>)}
        </details>)}
      </details>
      {briefing && <details className="dw-details"><summary>Scope and sources of the check on {reportDate(briefing.startedAt)}</summary>
        <dl className="dw-scope">
          <dt>Monitoring question</dt><dd>{briefing.config.question}</dd>
          <dt>Comparison context · version {briefing.baselineVersion}</dt><dd className="dw-pre">{briefing.baseline.text || 'No manual comparison text was recorded.'}</dd>
          <dt>Coverage</dt><dd>
            {briefing.coverage.webSearches ? `${briefing.coverage.webSearches - (briefing.coverage.webFailures ?? 0)}/${briefing.coverage.webSearches} web searches succeeded. ` : ''}
            {briefing.coverage.sourcesChecked > 0 && `${briefing.coverage.sourcesHealthy}/${briefing.coverage.sourcesChecked} Discover sources healthy. `}
            {count(briefing.coverage.uniqueEvents, 'unique event')}.
          </dd>
        </dl>
        {briefing.baseline.links.map(link => <a key={link} href={link} target="_blank" rel="noreferrer">{link}</a>)}
        {briefing.evidence.length > 0 && <ul className="dw-evidence" aria-label="All sources">{briefing.evidence.map(e => <li key={e.id}><a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>
          <span className="dw-evidence__meta">{reportDate(e.publishedAt)}{e.syndicatedIds.length > 0 && ` · ${e.syndicatedIds.length} syndicated copies counted once`}</span>
        </li>)}</ul>}
      </details>}
      <details className="dw-details dw-history"><summary>Earlier checks{historyPage === 1 ? ` (${earlier.length}${runs.length === 100 ? '+' : ''})` : ''}</summary>
        {older.isError && <DataNotice title="Earlier checks unavailable" error={older.error} onRetry={() => { void older.refetch(); }} />}
        {history.isLoading && <p className="dw-hint" role="status">Loading earlier checks…</p>}
        {!history.isLoading && earlier.length === 0 && <p className="dw-hint">No earlier checks on this page.</p>}
        {earlier.map(r => <HistoryRun key={r.id} run={r} />)}
        {(historyPage > 1 || runs.length === 100) && <div className="dw-actions" aria-label="Watchlist history pages">
          <button type="button" className="dw-button" disabled={historyPage === 1 || history.isLoading} onClick={() => setHistoryPage(p => p - 1)}>Newer checks</button>
          <span className="dw-hint">History page {historyPage}</span>
          <button type="button" className="dw-button" disabled={history.data?.length !== 100 || history.isLoading} onClick={() => setHistoryPage(p => p + 1)}>Older checks</button>
        </div>}
      </details>
    </section>
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
