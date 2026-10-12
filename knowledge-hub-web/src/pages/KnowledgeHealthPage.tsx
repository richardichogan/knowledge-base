import React, { useState } from 'react';
import { Button, InlineLoading, InlineNotification, Select, SelectItem, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import type { HealthSection, HealthUsageTotals, KnowledgeHealth, KnowledgeHealthParams } from '../services/api';
import { requireApiData } from '../services/apiError';
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

export const KnowledgeHealthPage: React.FC = () => {
  const [draft, setDraft] = useState<KnowledgeHealthParams>({ from: dayOf(6), to: dayOf(0), environment: 'prod' });
  const [applied, setApplied] = useState<KnowledgeHealthParams>(draft);
  const query = useQuery<KnowledgeHealth>({
    queryKey: ['knowledge-health', applied],
    queryFn: async () => requireApiData(await api.getKnowledgeHealth(applied)),
    retry: false, refetchOnWindowFocus: false,
  });
  const facets = query.data?.usage.available === true ? query.data.usage.data.facets : { features: [], personas: [], deployments: [] };
  const facet = (name: 'feature' | 'persona' | 'deployment', label: string, options: string[]) => (
    <Select id={`health-${name}`} labelText={label} size="sm" value={draft[name] ?? ''}
      onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}>
      <SelectItem value="" text="All" />
      {options.map(option => <SelectItem key={option} value={option} text={option} />)}
    </Select>
  );
  return (
    <div className="page-root kh-health">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Knowledge health</h1>
          <p className="page-subtitle">How Athena is being used and whether your sources are fresh. No prompts or content are shown here.</p>
        </div>
      </div>
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
          <section className="kh-health__section" aria-labelledby="health-sync">
            <h2 id="health-sync">Source sync</h2>
            {!query.data.syncRuns.available ? <Unavailable title="Source sync" section={query.data.syncRuns} /> : (
              query.data.syncRuns.data.runs.length === 0 ? <p>No sync runs have been recorded.</p> : (
                <ul className="kh-health__list">
                  {query.data.syncRuns.data.runs.map(run => (
                    <li key={run.id}>
                      <strong>{run.status}</strong> · started {when(run.startedAt)}{run.finishedAt === null ? '' : ` · finished ${when(run.finishedAt)}`}
                      <div className="kh-health__note">
                        {run.sources.length === 0 ? 'No per-source results.' : run.sources.map(s => `${s.source}: ${number.format(s.indexed)} indexed, ${number.format(s.errors)} errors`).join(' · ')}
                      </div>
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
    </div>
  );
};
