import React, { useState } from 'react';
import { Button, InlineLoading, InlineNotification, Select, SelectItem, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import type { HealthSection, HealthUsageTotals, HealthWorkflowData, KnowledgeHealth, KnowledgeHealthParams } from '../services/api';
import { requireApiData } from '../services/apiError';
import { PageHeader } from '../components/PageHeader';
import { KnowledgeFamilies } from '../components/health/KnowledgeFamilies';
import { countCell, retrievalQualityStats } from './knowledgeHealthModel';
import './KnowledgeHealthPage.css';

const number = new Intl.NumberFormat('en-GB');
const dayOf = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** Tokens come only from calls that reported usage; with none measured the figure is unknown, not zero. */
const tokenCell = (totals: HealthUsageTotals, value: number): string =>
  totals.measuredCalls === 0 ? 'Not measured' : number.format(value);
const when = (iso: string | null): string => (iso === null ? 'Never' : new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }));

const Unavailable: React.FC<{ title: string; section: Extract<HealthSection<unknown>, { available: false }> }> = ({ title, section }) => (
  <InlineNotification kind="warning" title={`${title} unavailable`} subtitle={section.message} lowContrast hideCloseButton />
);

const UsageSummary: React.FC<{ totals: HealthUsageTotals }> = ({ totals }) => (
  <dl className="kh-health__stats">
    <div><dt>Model calls</dt><dd>{number.format(totals.calls)}</dd></div>
    <div><dt>Failed calls</dt><dd>{number.format(totals.failures)}</dd></div>
    <div><dt>Usage reported</dt><dd>{number.format(totals.measuredCalls)} of {number.format(totals.calls)}</dd></div>
    <div><dt>Total tokens</dt><dd>{tokenCell(totals, totals.totalTokens)}</dd></div>
    <div><dt>Average latency</dt><dd>{totals.avgLatencyMs === null ? 'No calls' : `${number.format(totals.avgLatencyMs)} ms`}</dd></div>
  </dl>
);

const WorkflowHealth: React.FC<{ data: HealthWorkflowData }> = ({ data }) => (
  <>
    <dl className="kh-health__stats">
      {Object.entries({ Runs: data.totals.runs, Completed: data.totals.completed, Failed: data.totals.failed,
        'Running / interrupted': data.totals.unfinished, 'Review blocked': data.totals.reviewBlocked, 'Delivered to blog': data.totals.delivered })
        .map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{number.format(count)}</dd></div>)}
    </dl>
    <p className="kh-health__note">{number.format(data.attributedCalls)} calls attributed; {number.format(data.unattributedCalls)} calls have unknown workflow/purpose.
      Historical calls are not guessed or backfilled. Completed means the operation returned, not that its output was accepted.
      Review and delivery counts overlap completion counts. Workflow dates use start time; call metrics use the selected window and filters.
      Running records may be unfinished after a stopped process.</p>
    {data.runs.length === 0 ? <p>No attributed workflows match these filters. Existing historical jobs are not retroactively included.</p>
      : <div className="kh-health__table-wrap" tabIndex={0} role="region" aria-label="Workflow outcomes and stage usage">
        <table className="kh-health__table">
          <thead><tr><th>Workflow / attempt</th><th>Purpose</th><th>Outcome</th><th>Elapsed</th><th>Calls</th><th>Tokens</th></tr></thead>
          <tbody>{data.runs.map(run => <React.Fragment key={run.id}>
            <tr><td>{run.feature} · {run.id.slice(0, 8)} · attempt {run.attempt}<br /><span className="kh-health__note">{when(run.startedAt)}</span></td>
              <td>{run.purpose}</td><td>{run.status}{run.outcome ? ` · ${run.outcome}` : ''}</td>
              <td>{run.durationMs === null ? 'Unfinished' : `${number.format(Math.round(run.durationMs / 1000))} s`}</td>
              <td>{number.format(run.calls)}</td><td>{run.tokens === null ? 'Not measured' : number.format(run.tokens)}{run.unmeasuredCalls > 0 ? ` · ${run.unmeasuredCalls} unmeasured calls` : ''}</td></tr>
            <tr><td colSpan={6}><details className="kh-health__details"><summary>Stage usage</summary>
              {data.stages.filter(stage => stage.runId === run.id).length === 0 ? <p>No measured stage calls.</p>
                : <ul>{data.stages.filter(stage => stage.runId === run.id).map(stage => <li key={stage.stage}>
                  <strong>{stage.stage}</strong>: {number.format(stage.calls)} calls · {stage.tokens === null ? 'tokens not measured' : `${number.format(stage.tokens)} tokens`} · {stage.failures} failed · {number.format(Math.round(stage.durationMs / 1000))} s summed model-call time
                </li>)}</ul>}
            </details></td></tr>
          </React.Fragment>)}</tbody>
        </table>
      </div>}
    {data.rowsTruncated && <p className="kh-health__note">Showing the latest 50 matching workflows. Narrow the date range for older runs.</p>}
    <p className="kh-health__note">Stage rows are bounded to 200 for these workflows. Summed call time is not end-to-end elapsed time.</p>
  </>
);

export const KnowledgeHealthPage: React.FC = () => {
  const [draft, setDraft] = useState<KnowledgeHealthParams>({ from: dayOf(6), to: dayOf(0), environment: 'prod' });
  const [applied, setApplied] = useState<KnowledgeHealthParams>(draft);
  const query = useQuery<KnowledgeHealth>({
    queryKey: ['knowledge-health', applied],
    queryFn: async () => requireApiData(await api.getKnowledgeHealth(applied)),
    retry: false, refetchOnWindowFocus: false,
  });
  const facets = query.data?.usage.available === true ? query.data.usage.data.facets : { features: [], personas: [], deployments: [] };
  const quality = query.data?.retrievalQuality;
  const facet = (name: 'feature' | 'persona' | 'deployment', label: string, options: string[]) => (
    <Select id={`health-${name}`} labelText={label} size="sm" value={draft[name] ?? ''}
      onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}>
      <SelectItem value="" text="All" />
      {options.map(option => <SelectItem key={option} value={option} text={option} />)}
    </Select>
  );
  return (
    <main className="page-root kh-health">
      <PageHeader title="Knowledge health" subtitle="How Athena is being used and whether your sources are fresh. No prompts or content are shown here." />
      <form className="kh-health__filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }); }}>
        <TextInput id="health-from" type="date" size="sm" labelText="From (UTC)" value={draft.from ?? ''} onChange={event => setDraft(c => ({ ...c, from: event.target.value }))} />
        <TextInput id="health-to" type="date" size="sm" labelText="To (UTC, inclusive)" value={draft.to ?? ''} onChange={event => setDraft(c => ({ ...c, to: event.target.value }))} />
        <Select id="health-environment" labelText="Environment" size="sm" value={draft.environment ?? 'prod'}
          onChange={event => setDraft(c => ({ ...c, environment: event.target.value === 'dev' ? 'dev' : 'prod' }))}>
          <SelectItem value="prod" text="Production" />
          <SelectItem value="dev" text="Development" />
        </Select>
        {facet('feature', 'Feature', facets.features)}
        {facet('persona', 'Persona', facets.personas)}
        {facet('deployment', 'Deployment', facets.deployments)}
        <Button type="submit" size="sm" disabled={query.isFetching}>Apply</Button>
      </form>
      {query.isPending && <InlineLoading description="Loading health" />}
      {query.isError && <DataNotice title="Knowledge health could not be loaded" error={query.error} onRetry={() => { void query.refetch(); }} busy={query.isFetching} />}
      {query.data && (
        <>
          <p className="kh-health__fresh">
            Generated {when(query.data.generatedAt)} · {query.data.filters.from} to {query.data.filters.to} UTC
            {query.data.usage.available && ` · usage recorded since ${when(query.data.usage.data.firstRecordedAt)}`}
          </p>
          <section className="kh-health__section" aria-labelledby="health-usage">
            <h2 id="health-usage">AI usage</h2>
            {!query.data.usage.available ? <Unavailable title="AI usage" section={query.data.usage} /> : (
              <>
                <UsageSummary totals={query.data.usage.data.totals} />
                <p className="kh-health__note">
                  Tokens count only calls where the provider reported usage; other calls show as not measured. Cached tokens are part of the prompt and
                  reasoning tokens part of the completion. No cost is shown because no pricing is configured.
                </p>
                {query.data.usage.data.rows.length === 0 ? <p>No model calls were recorded for these filters.</p> : (
                  <div className="kh-health__table-wrap" tabIndex={0} role="region" aria-label="AI usage by feature, persona and deployment">
                    <table className="kh-health__table">
                      <thead><tr><th>Feature</th><th>Persona</th><th>Deployment</th><th>Calls</th><th>Failed</th><th>Prompt (cached)</th><th>Completion (reasoning)</th><th>Latency</th></tr></thead>
                      <tbody>
                        {query.data.usage.data.rows.map(row => (
                          <tr key={`${row.feature}|${row.persona ?? ''}|${row.deployment}`}>
                            <td>{row.feature}</td><td>{row.persona ?? '—'}</td><td>{row.deployment}</td>
                            <td>{number.format(row.calls)}</td><td>{number.format(row.failures)}</td>
                            <td>{row.measuredCalls === 0 ? 'Not measured' : `${number.format(row.promptTokens)} (${number.format(row.cachedPromptTokens)})`}</td>
                            <td>{row.measuredCalls === 0 ? 'Not measured' : `${number.format(row.completionTokens)} (${number.format(row.reasoningCompletionTokens)})`}</td>
                            <td>{row.avgLatencyMs === null ? '—' : `${number.format(row.avgLatencyMs)} ms`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {query.data.usage.data.rowsTruncated && <p className="kh-health__note">Showing the 50 heaviest groups. Narrow the filters to see the rest.</p>}
              </>
            )}
          </section>
          <section className="kh-health__section" aria-labelledby="health-workflows">
            <h2 id="health-workflows">Workflow outcomes</h2>
            {!query.data.workflows ? <p>Workflow attribution is not available from this server version.</p>
              : !query.data.workflows.available ? <Unavailable title="Workflow outcomes" section={query.data.workflows} />
                : <WorkflowHealth data={query.data.workflows.data} />}
          </section>
          <section className="kh-health__section" aria-labelledby="health-sync">
            <h2 id="health-sync">Source sync</h2>
            <p className="kh-health__note">Latest shared-source runs across environments, independent of the usage filters. Older runs have counts only; actionable diagnostics are recorded by updated servers.</p>
            {!query.data.syncRuns.available ? <Unavailable title="Source sync" section={query.data.syncRuns} /> : (
              query.data.syncRuns.data.runs.length === 0 ? <p>No sync runs have been recorded.</p> : (
                <ul className="kh-health__list">
                  {query.data.syncRuns.data.runs.map(run => (
                    <li key={run.id}>
                      <strong>{run.status}</strong> · started {when(run.startedAt)}{run.finishedAt === null ? '' : ` · finished ${when(run.finishedAt)}`}
                      <div className="kh-health__note">
                        {run.sources.length === 0 ? 'No per-source results.' : run.sources.map(s => `${s.source}: ${number.format(s.indexed)} indexed, ${number.format(s.errors)} errors`).join(' · ')}
                      </div>
                      {run.sources.some(source => (source.failures?.length ?? 0) > 0) && <details className="kh-health__details">
                        <summary>Source failures and actions</summary>
                        <ul>{run.sources.flatMap(source => (source.failures ?? []).map((failure, index) => <li key={`${source.source}-${index}`}>
                          <strong>{source.source} · {failure.target}</strong>: {failure.code}. {failure.action}
                        </li>))}</ul>
                        <p className="kh-health__note">At most 20 diagnostics per source. Counts can exceed the displayed details.</p>
                      </details>}
                    </li>
                  ))}
                </ul>
              )
            )}
            {query.data.syncRuns.available && query.data.syncRuns.data.jobs.length > 0 && (
              <>
                <h3>Scheduled jobs</h3>
                <ul className="kh-health__list">
                  {query.data.syncRuns.data.jobs.map(job => (
                    <li key={`${job.job}|${job.period}`}><strong>{job.job}</strong> · {job.period} · {job.status} · started {when(job.startedAt)}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="kh-health__section" aria-labelledby="health-quality">
            <h2 id="health-quality">Conversation retrieval quality</h2>
            {quality === undefined ? <p>Retrieval quality is not measured by this server version.</p>
              : !quality.available ? <Unavailable title="Retrieval quality" section={quality} /> : (
                <>
                  <p className="kh-health__note">{quality.data.note}</p>
                  <dl className="kh-health__stats">
                    {retrievalQualityStats(quality.data).map(({ key, label, value }) => (
                      <div key={key}><dt>{label}</dt><dd className={value === null ? 'kh-health__stat-text' : undefined}>
                        {countCell(value, n => number.format(n))}
                      </dd></div>
                    ))}
                  </dl>
                  <p className="kh-health__note">
                    Legacy/unattributed turns: {number.format(quality.data.legacyUnattributedTurns)}.
                    These have no environment or scope attribution and are shown separately, never counted as scope-compliant.
                  </p>
                  <div className="kh-health__table-wrap" tabIndex={0} role="region" aria-label="Audited turn signals">
                    <table className="kh-health__table">
                      <thead><tr><th>Primary signal</th><th>Turns</th><th>Attribution</th></tr></thead>
                      <tbody>
                        {[...quality.data.categories.map(row => ({ ...row, attribution: applied.environment ?? 'prod' })),
                          ...quality.data.legacyCategories.map(row => ({ ...row, attribution: 'Legacy: environment unknown' }))].map(row => (
                          <tr key={`${row.attribution}|${row.category}`}><td>{row.category.replaceAll('_', ' ')}</td><td>{number.format(row.turns)}</td><td>{row.attribution}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
          </section>
          <section className="kh-health__section" aria-labelledby="health-families">
            <h2 id="health-families">Knowledge coverage</h2>
            <KnowledgeFamilies section={query.data.families} />
          </section>
          <section className="kh-health__section" aria-labelledby="health-index">
            <h2 id="health-index">Index freshness</h2>
            {!query.data.index.available ? <Unavailable title="Index freshness" section={query.data.index} /> : (
              <>
                <p>
                  Discover scoring backlog: <strong>{number.format(query.data.index.data.scoring.unscored)}</strong> of{' '}
                  {number.format(query.data.index.data.scoring.discoveredArticles)} discovered articles are not yet scored.
                </p>
                <ul className="kh-health__list">
                  {query.data.index.data.sources.map(source => (
                    <li key={source.source}><strong>{source.source}</strong> · {number.format(source.items)} items · last indexed {when(source.lastIndexedAt)}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
};
