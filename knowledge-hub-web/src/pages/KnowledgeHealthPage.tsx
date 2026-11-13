import React, { useCallback, useEffect, useState } from 'react';
import { Button, InlineLoading, InlineNotification, Select, SelectItem, Tab, TabList, TabPanel, TabPanels, Tabs, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import type { HealthSection, HealthUsageTotals, HealthWorkflowData, KnowledgeHealth, KnowledgeHealthParams } from '../services/api';
import { requireApiData } from '../services/apiError';
import { PageHeader } from '../components/PageHeader';
import { KnowledgeFamilies } from '../components/health/KnowledgeFamilies';
import { HealthDashboard, MeasurementData } from '../components/health/HealthDashboard';
import { HealthTraceInspector, type HealthTraceSelection } from '../components/health/HealthTraceInspector';
import { HealthDataTable, HealthTablePageContext } from '../components/health/HealthDataTable';
import { useAthenaContext } from '../context/AthenaContext';
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
    <div><dt>Partial responses</dt><dd>{totals.partialCalls === undefined ? 'Unmeasured' : number.format(totals.partialCalls)}</dd></div>
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
    <h3>Failures and partial results</h3>
    {!data.failureDiagnostics
      ? <p>Failure diagnostics are unavailable from this backend version.</p>
      : data.failureDiagnostics.length === 0
        ? <p>No failed or partial model calls or workflows match these filters. Older runs without diagnostics are not inferred.</p>
      : <HealthDataTable label="Workflow failure diagnostics"
          headers={<tr><th>Source</th><th>Feature</th><th>Status</th><th>Stage</th><th>Category</th><th>Occurrences</th></tr>}
          rows={data.failureDiagnostics.map((failure, index) => (
            <tr key={`${failure.source}-${failure.feature}-${failure.status}-${failure.stage ?? 'unknown'}-${failure.code}-${index}`}>
              <td>{failure.source}</td>
              <td><span className="kh-health__tag">{failure.feature}</span></td>
              <td>{failure.status}</td>
              <td>{failure.stage ?? 'Unrecorded'}</td>
              <td>{failure.code.replaceAll('-', ' ')}</td>
              <td>{number.format(failure.occurrences)}</td>
            </tr>
          ))} />}
    <p className="kh-health__note">Categories are fixed labels; raw provider errors, prompts and content are not shown. New failures are classified; historical failures without a category remain unclassified.</p>
    {data.failureDiagnosticsTruncated && <p className="kh-health__note">Showing the 100 largest diagnostic groups. Narrow the filters for more detail.</p>}
    <p className="kh-health__note">Workflow and model-call observations can describe the same incident; do not add them together. Partial responses contain usable but incomplete text.</p>
    <p className="kh-health__note">{number.format(data.attributedCalls)} calls linked to a workflow run; {number.format(data.unattributedCalls)} calls lack a workflow-run link (feature labels may still be recorded). This measures diagnostic coverage, not performance or success.
      Historical workflow links are not guessed or backfilled. Completed means the operation returned, not that its output was accepted.
      Review and delivery counts overlap completion counts. Workflow dates use start time; call metrics use the selected window and filters.
      Running records may be unfinished after a stopped process.</p>
    {data.runs.length === 0 ? <p>No attributed workflows match these filters. Existing historical jobs are not retroactively included.</p>
      : <HealthDataTable label="Workflow outcomes and stage usage"
          headers={<tr><th>Workflow / attempt</th><th>Purpose</th><th>Outcome</th><th>Elapsed</th><th>Calls</th><th>Tokens</th></tr>}
          rows={data.runs.map(run => (
            <tr key={run.id}><td><span className="kh-health__tag">{run.feature}</span> · {run.id.slice(0, 8)} · attempt {run.attempt}<br /><span className="kh-health__note">{when(run.startedAt)}</span>
            <details className="kh-health__details"><summary>Stage usage</summary>
              {data.stages.filter(stage => stage.runId === run.id).length === 0 ? <p>No measured stage calls.</p>
                : <ul>{data.stages.filter(stage => stage.runId === run.id).map(stage => <li key={stage.stage}>
                  <strong>{stage.stage}</strong>: {number.format(stage.calls)} calls · {stage.tokens === null ? 'tokens not measured' : `${number.format(stage.tokens)} tokens`} · {stage.failures} failed · {stage.partialCalls === undefined ? 'partial responses unmeasured' : `${stage.partialCalls} partial`} · {number.format(Math.round(stage.durationMs / 1000))} s summed model-call time
                </li>)}</ul>}
            </details></td>
              <td><span className="kh-health__tag">{run.purpose}</span></td><td><span className="kh-health__tag">{run.status}</span>{run.outcome ? ` · ${run.outcome}` : ' · Outcome unknown'}</td>
              <td>{run.durationMs === null ? 'Unfinished' : `${number.format(Math.round(run.durationMs / 1000))} s`}</td>
              <td>{number.format(run.calls)}</td><td>{run.tokens === null ? 'Not measured' : number.format(run.tokens)}{run.unmeasuredCalls > 0 ? ` · ${run.unmeasuredCalls} unmeasured calls` : ''}</td></tr>
          ))} />}
    {data.rowsTruncated && <p className="kh-health__note">Showing the latest 50 matching workflows. Narrow the date range for older runs.</p>}
    <p className="kh-health__note">Stage rows are bounded to 200 for these workflows. Summed call time is not end-to-end elapsed time.</p>
  </>
);

export const KnowledgeHealthPage: React.FC = () => {
  const { setAthenaContext } = useAthenaContext();
  const [traceSelection, setTraceSelection] = useState<HealthTraceSelection | null>(null);
  const [detailTab, setDetailTab] = useState(0);
  const [focusDetails, setFocusDetails] = useState(false);
  const [tablePages, setTablePages] = useState<Record<string, { page: number; total: number; pageSize: number }>>({});
  const reportTablePage = useCallback((label: string, page: number, total: number) => {
    setTablePages(current => current[label]?.page === page && current[label]?.total === total
      ? current : { ...current, [label]: { page, total, pageSize: 25 } });
  }, []);
  const [draft, setDraft] = useState<KnowledgeHealthParams>({ from: dayOf(6), to: dayOf(0), environment: 'prod' });
  const [applied, setApplied] = useState<KnowledgeHealthParams>(draft);
  const query = useQuery<KnowledgeHealth>({
    queryKey: ['knowledge-health', applied],
    queryFn: async () => requireApiData(await api.getKnowledgeHealth(applied)),
    retry: false, refetchOnWindowFocus: false,
  });
  const facets = query.data?.usage.available === true ? query.data.usage.data.facets : { features: [], personas: [], deployments: [] };
  useEffect(() => {
    if (focusDetails && !query.isFetching && query.data && query.data.filters.feature === (applied.feature || null)) {
      document.getElementById('health-detail-data')?.focus();
      setFocusDetails(false);
    }
  }, [focusDetails, query.isFetching, query.data, applied.feature]);
  const quality = query.data?.retrievalQuality;
  useEffect(() => {
    setAthenaContext({
      type: 'knowledge-health', id: 'knowledge-health', title: 'Knowledge health instrumentation',
      detail: JSON.stringify({ filters: applied, generatedAt: query.data?.generatedAt,
        measurements: query.data?.measurements, reliability: query.data?.reliability, artifactOutcomes: query.data?.artifactOutcomes, traceSelection, tablePages,
        activeDetailTab: ['AI usage', 'Workflows', 'Source sync', 'Retrieval quality', 'Knowledge coverage', 'Index freshness', 'Turn measurements', 'Traces and evaluations', 'Audience engagement'][detailTab],
        workflowOutcomes: query.data?.workflows?.available ? query.data.workflows.data.outcomes : null,
        loading: query.isFetching, error: query.isError ? 'Health could not be loaded' : null,
        retrieval: 'Use read_knowledge_health for the current structured report sections. Metrics are not proof of answer correctness.' }),
    });
    return () => setAthenaContext(null);
  }, [setAthenaContext, applied, query.data, query.isFetching, query.isError, traceSelection, detailTab, tablePages]);
  const facet = (name: 'feature' | 'persona' | 'deployment', label: string, options: string[]) => (
    <Select id={`health-${name}`} labelText={label} size="sm" value={draft[name] ?? ''}
      onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}>
      <SelectItem value="" text="All" />
      {options.map(option => <SelectItem key={option} value={option} text={option} />)}
    </Select>
  );
  return (
    <main className="page-root kh-health">
      <PageHeader className="kh-health__page-heading" title="Instrumentation overview"
        subtitle="Environment identifies the executing backend, not the database. No data, missing attribution and unreviewed answers are not healthy results."
        actions={query.data ? <>
          <span className="kh-health__runtime-badge">{query.data.filters.environment === 'prod' ? 'Production runtime' : 'Development runtime'}</span>
          <span className="kh-health__window-badge">{new Date(`${query.data.filters.from}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} to {new Date(`${query.data.filters.to}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, UTC</span>
        </> : undefined} />
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
        <div className="kh-health__actions">
          <Button type="submit" size="sm" disabled={query.isFetching}>Apply</Button>
          <Button type="button" kind="ghost" size="sm" disabled={query.isFetching} onClick={() => {
            const reset: KnowledgeHealthParams = { from: dayOf(6), to: dayOf(0), environment: 'prod' };
            setDraft(reset); setApplied(reset); setTraceSelection(null); setTablePages({});
          }}>Reset filters</Button>
        </div>
      </form>
      {query.isPending && <InlineLoading description="Loading health" />}
      {query.isError && <DataNotice title="Knowledge health could not be loaded" error={query.error} onRetry={() => { void query.refetch(); }} busy={query.isFetching} />}
      {query.data && (
        <>
          <p className="kh-health__fresh">
            Generated {when(query.data.generatedAt)} · {query.data.filters.from} to {query.data.filters.to} UTC
            {query.data.usage.available && ` · usage recorded since ${when(query.data.usage.data.firstRecordedAt)}`}
          </p>
          <HealthDashboard data={query.data} busy={query.isFetching}
            onInspectUsage={() => { setDetailTab(0); setFocusDetails(true); }} onInspectFeature={feature => {
            const filters = { ...applied, feature };
            setDraft(filters); setApplied(filters); setDetailTab(0); setTablePages({});
            setFocusDetails(true);
          }} onInspectIndex={() => { setDetailTab(4); setFocusDetails(true); }} />
          <HealthTablePageContext.Provider value={reportTablePage}>
          <section id="health-detail-data" tabIndex={-1} key={JSON.stringify(applied)} className="kh-health__data" aria-labelledby="health-detail-heading">
            <h2 id="health-detail-heading">Detailed instrumentation data</h2>
            <Tabs selectedIndex={detailTab} onChange={({ selectedIndex }) => setDetailTab(selectedIndex)}>
              <TabList aria-label="Detailed instrumentation data">
                <Tab>AI usage</Tab><Tab>Workflows</Tab><Tab>Source sync</Tab><Tab>Retrieval quality</Tab>
                <Tab>Knowledge coverage</Tab><Tab>Index freshness</Tab><Tab>Turn measurements</Tab><Tab>Traces and evaluations</Tab>
                <Tab>Audience engagement</Tab>
              </TabList>
              <TabPanels>
                <TabPanel>
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
                  <HealthDataTable label="AI usage by feature, persona and deployment"
                    headers={<tr><th>Feature</th><th>Persona</th><th>Deployment</th><th>Calls</th><th>Failed</th><th>Partial</th><th>Prompt (cached)</th><th>Completion (reasoning)</th><th>Latency</th></tr>}
                    rows={query.data.usage.data.rows.map(row => (
                          <tr key={`${row.feature}|${row.persona ?? ''}|${row.deployment}`}>
                            <td><span className="kh-health__tag">{query.data.filters.environment}</span> <span className="kh-health__tag">{row.feature}</span></td><td>{row.persona ?? '—'}</td><td>{row.deployment}</td>
                            <td>{number.format(row.calls)}</td><td>{number.format(row.failures)}</td><td>{row.partialCalls === undefined ? 'Unmeasured' : number.format(row.partialCalls)}</td>
                            <td>{row.measuredCalls === 0 ? 'Not measured' : `${number.format(row.promptTokens)} (${number.format(row.cachedPromptTokens)})`}</td>
                            <td>{row.measuredCalls === 0 ? 'Not measured' : `${number.format(row.completionTokens)} (${number.format(row.reasoningCompletionTokens)})`}</td>
                            <td>{row.avgLatencyMs === null ? '—' : `${number.format(row.avgLatencyMs)} ms`}</td>
                          </tr>
                        ))} />
                )}
                {query.data.usage.data.rowsTruncated && <p className="kh-health__note">Showing the 50 heaviest groups. Narrow the filters to see the rest.</p>}
              </>
            )}
          </section>
                </TabPanel>
                <TabPanel>
          <section className="kh-health__section" aria-labelledby="health-workflows">
            <h2 id="health-workflows">Workflow outcomes</h2>
            <p className="kh-health__note"><span className="kh-health__tag">{query.data.filters.environment}</span> Runtime-scoped workflow data</p>
            {!query.data.workflows ? <p>Workflow attribution is not available from this server version.</p>
              : !query.data.workflows.available ? <Unavailable title="Workflow outcomes" section={query.data.workflows} />
                : <WorkflowHealth data={query.data.workflows.data} />}
            <h3>Recorded artifact outcomes</h3>
            {!query.data.artifactOutcomes ? <p>Artifact outcome measurements are unavailable from this backend version.</p>
              : !query.data.artifactOutcomes.available ? <Unavailable title="Artifact outcomes" section={query.data.artifactOutcomes} />
                : <>
                  <dl className="kh-health__stats">
                    <div><dt>Generated versions recorded</dt><dd>{number.format(query.data.artifactOutcomes.data.generatedVersions)}</dd></div>
                    <div><dt>Distinct generated items</dt><dd>{number.format(query.data.artifactOutcomes.data.generatedTargets)}</dd></div>
                    <div><dt>AI versions with changed user saves</dt><dd>{number.format(query.data.artifactOutcomes.data.editedVersions)}</dd></div>
                  </dl>
                  <p className="kh-health__note">{query.data.artifactOutcomes.data.note}</p>
                  {query.data.artifactOutcomes.data.decisions.length === 0 ? <p>No user decision records in this runtime/window. Acceptance and rework are unmeasured, not zero.</p>
                    : <HealthDataTable label="Recorded user decisions on artifacts"
                      headers={<tr><th>Decision</th><th>Item type</th><th>Records</th><th>Distinct items</th><th>Linked to AI version</th></tr>}
                      rows={query.data.artifactOutcomes.data.decisions.map(row => <tr key={`${row.kind}:${row.targetType}`}>
                        <td>{row.kind.replaceAll('-', ' ')}</td><td>{row.targetType.replaceAll('-', ' ')}</td>
                        <td>{number.format(row.events)}</td><td>{number.format(row.targets)}</td><td>{number.format(row.linkedEvents)}</td>
                      </tr>)} />}
                  {query.data.artifactOutcomes.data.rowsTruncated && <p className="kh-health__note">Showing the 50 largest decision groups. Narrow the date range for more detail.</p>}
                </>}
          </section>
                </TabPanel>
                <TabPanel>
          <section className="kh-health__section" aria-labelledby="health-sync">
            <h2 id="health-sync">Source sync</h2>
            <p className="kh-health__note">Latest source runs for the selected runtime, plus clearly labelled legacy runs whose environment is unknown.
              Dates and feature filters do not restrict source history. Content/index inventory remains shared.</p>
            {!query.data.syncRuns.available ? <Unavailable title="Source sync" section={query.data.syncRuns} /> : (
              query.data.syncRuns.data.runs.length === 0 ? <p>No sync runs have been recorded.</p> : (
                <ul className="kh-health__list">
                  {query.data.syncRuns.data.runs.map(run => (
                    <li key={run.id}>
                      <span className="kh-health__tag">{run.status}</span> <span className="kh-health__tag">{run.environment ?? 'Environment unknown (legacy)'}</span> · started {when(run.startedAt)}{run.finishedAt === null ? '' : ` · finished ${when(run.finishedAt)}`}
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
                    <li key={`${job.job}|${job.period}`}><strong>{job.job}</strong> · {job.period} · <span className="kh-health__tag">{job.environment ?? 'Environment unknown (legacy)'}</span> <span className="kh-health__tag">{job.status}</span> · started {when(job.startedAt)}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
                </TabPanel>
                <TabPanel>
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
                  <HealthDataTable label="Audited turn signals"
                    headers={<tr><th>Primary signal</th><th>Turns</th><th>Attribution</th></tr>}
                    rows={[...quality.data.categories.map(row => ({ ...row, attribution: applied.environment ?? 'prod' })),
                          ...quality.data.legacyCategories.map(row => ({ ...row, attribution: 'Legacy: environment unknown' }))].map(row => (
                          <tr key={`${row.attribution}|${row.category}`}><td><span className="kh-health__tag">{row.category.replaceAll('_', ' ')}</span></td><td>{number.format(row.turns)}</td><td><span className="kh-health__tag">{row.attribution}</span></td></tr>
                        ))} />
                </>
              )}
          </section>
                </TabPanel>
                <TabPanel>
          <section className="kh-health__section" aria-labelledby="health-families">
            <h2 id="health-families">Knowledge coverage</h2>
            <KnowledgeFamilies section={query.data.families} />
          </section>
                </TabPanel>
                <TabPanel>
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
                    <li key={source.source}><strong>{source.source}</strong> <span className="kh-health__tag">Shared inventory</span> · {number.format(source.items)} items · last indexed {when(source.lastIndexedAt)}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
                </TabPanel>
                <TabPanel>
                  {query.data.measurements?.available ? <MeasurementData data={query.data.measurements.data} />
                    : <p>{query.data.measurements && !query.data.measurements.available ? query.data.measurements.message : 'Turn measurements unavailable.'}</p>}
                </TabPanel>
                <TabPanel>
                  <HealthTraceInspector key={JSON.stringify(applied)} filters={applied} onSelection={setTraceSelection} />
                </TabPanel>
                <TabPanel>
          <section className="kh-health__section" aria-labelledby="health-engagement">
            <h2 id="health-engagement">Audience engagement</h2>
            {!query.data.engagement ? <p>Engagement snapshots are not available from this server version.</p>
              : !query.data.engagement.available ? <Unavailable title="Audience engagement" section={query.data.engagement} /> : (
                <>
                  <p className="kh-health__note">{query.data.engagement.data.note}</p>
                  {query.data.engagement.data.posts.length === 0 ? <p>No sent Bluesky posts were published in this window.</p> : (
                    <HealthDataTable label="Bluesky post engagement"
                      headers={<tr><th>Post</th><th>Published</th><th>Likes</th><th>Reposts</th><th>Replies</th><th>Quotes</th><th>Captured</th></tr>}
                      rows={query.data.engagement.data.posts.map(post => (
                        <tr key={post.deliveryId}>
                          <td>{post.url === null ? post.source : <a className="kh-health__post-link" href={post.url} target="_blank" rel="noreferrer">{post.source}</a>}
                            {post.unavailable && <> <span className="kh-health__tag">No longer on Bluesky</span></>}</td>
                          <td>{when(post.publishedAt)}</td>
                          {(['likes', 'reposts', 'replies', 'quotes'] as const).map(key => (
                            <td key={key}>{post.unavailable ? '—' : post.metrics === null ? 'Not collected'
                              : post.metrics[key] === null ? 'Not reported' : number.format(post.metrics[key])}</td>
                          ))}
                          <td>{post.capturedAt === null ? 'Not collected yet' : <>{when(post.capturedAt)}{post.capturedEnvironment !== null && <> <span className="kh-health__tag">{post.capturedEnvironment}</span></>}</>}</td>
                        </tr>
                      ))} />
                  )}
                  {query.data.engagement.data.postsTruncated && <p className="kh-health__note">Showing the 50 most recent posts. Narrow the date range for older ones.</p>}
                </>
              )}
          </section>
                </TabPanel>
              </TabPanels>
            </Tabs>
          </section>
          </HealthTablePageContext.Provider>
        </>
      )}
    </main>
  );
};
