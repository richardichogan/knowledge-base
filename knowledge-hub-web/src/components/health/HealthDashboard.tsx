import React from 'react';
import { Button } from '@carbon/react';
import type { HealthTurnMeasurements, KnowledgeHealth } from '../../services/api';
import { HealthDataTable } from './HealthDataTable';

const number = new Intl.NumberFormat('en-GB');
const rate = (part: number | undefined, total: number | undefined): string =>
  part === undefined || total === undefined || total === 0 ? 'Not measured' : `${(100 * part / total).toFixed(1)}%`;
const when = (value: string | null | undefined): string => value
  ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not measured';

const Ring: React.FC<{ value?: number | undefined; total?: number | undefined; label: string; warning?: boolean }> = ({ value, total, label, warning }) => {
  const measured = value !== undefined && total !== undefined && total > 0;
  const percent = measured ? Math.max(0, Math.min(100, 100 * value / total)) : 0;
  return <svg className={`kh-health__ring${!measured ? ' kh-health__ring--unknown' : ''}${warning ? ' kh-health__ring--warning' : ''}`}
    viewBox="0 0 100 100" role="img" aria-label={`${label}: ${measured ? `${percent.toFixed(1)}% (${value} of ${total})` : 'Not measured'}`}>
    <circle className="kh-health__ring-track" cx="50" cy="50" r="40" />
    {measured && <circle className="kh-health__ring-value" cx="50" cy="50" r="40" pathLength="100"
      strokeDasharray={`${percent} ${100 - percent}`} transform="rotate(-90 50 50)" />}
    <text x="50" y="54" textAnchor="middle">{measured ? `${percent.toFixed(1)}%` : 'N/A'}</text>
  </svg>;
};

const Observation: React.FC<{ label: string; count: number | undefined; maximum: number; warning?: boolean }> = ({ label, count, maximum, warning }) => (
  <div className={`kh-health__observation${warning ? ' kh-health__observation--warning' : ''}`}>
    <dt>{label}</dt><dd>{count === undefined ? 'Unknown' : number.format(count)}</dd>
    <div className="kh-health__observation-track" aria-hidden="true">
      <span style={{ width: `${100 * (count ?? 0) / Math.max(1, maximum)}%` }} />
    </div>
  </div>
);

export const MeasurementData: React.FC<{ data: HealthTurnMeasurements }> = ({ data }) => (
  <section className="kh-health__section">
    <h2>Turn measurement data and limitations</h2>
    <p className="kh-health__note">{data.note}</p>
    <p className="kh-health__note">First retained turn: {when(data.firstRecordedAt)}. Retention: {data.retentionDays} days. These are overlapping observations, not accuracy categories.</p>
    <HealthDataTable label="Turn measurement observations"
      headers={<tr><th>Observation</th><th>Count</th></tr>}
      rows={Object.entries({
          'Recorded accepted turns': data.accepted, 'Finished turns': data.finished, 'Complete trace captures': data.captureComplete,
          'Missing traces on finished turns': data.missingTraces, 'Incomplete captures on finished turns': data.incompleteCaptures,
          'Running / unfinished turns': data.unfinished, 'Final signals recorded': data.signalsMeasured,
          'UI snapshot observed': data.uiObserved, 'Resolved context observed': data.contextObserved,
          'Page content supplied': data.pageContentSupplied, 'Structured source reads observed': data.sourceReadTurns,
          'Partial source reads': data.partialReadTurns, 'Unavailable / omitted reads': data.unavailableReadTurns,
          'No observed page content or structured read': data.noObservedSourceTurns,
          'Chat replies persisted': data.repliesSaved, 'Failed turns': data.failed, 'Interrupted turns': data.interrupted,
          'Completed after error events': data.completedAfterErrors, 'Transport retries': data.transportRetries,
          'Model error events': data.modelErrors, 'Tool error results': data.toolErrors,
        }).map(([label, count]) => <tr key={label}><td>{label}</td><td>{number.format(count)}</td></tr>)} />
  </section>
);

export const HealthDashboard: React.FC<{ data: KnowledgeHealth; onInspectUsage: () => void; onInspectFeature: (feature: string) => void; onInspectIndex: () => void; busy: boolean }> = ({ data, onInspectUsage, onInspectFeature, onInspectIndex, busy }) => {
  const usage = data.usage.available ? data.usage.data.totals : undefined;
  const workflow = data.workflows?.available ? data.workflows.data : undefined;
  const measurements = data.measurements?.available ? data.measurements.data : undefined;
  const reliability = data.reliability?.available ? data.reliability.data : undefined;
  const indexing = data.families?.available ? data.families.data.semantic.work : undefined;
  const latestSync = data.syncRuns.available
    ? data.syncRuns.data.runs.find(run => run.environment === data.filters.environment && run.finishedAt !== null) : undefined;
  const failingFeature = reliability?.features.filter(row => row.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.failures / b.calls - a.failures / a.calls)[0];
  const slowGroups = data.usage.available ? data.usage.data.rows
    .filter(row => row.avgLatencyMs !== null && row.calls > 0)
    .sort((a, b) => (b.avgLatencyMs ?? 0) - (a.avgLatencyMs ?? 0)).slice(0, 5) : [];
  const maxDaily = Math.max(1, ...reliability?.daily.map(day => day.calls) ?? []);
  const missing = (measurements?.missingTraces ?? 0) + (measurements?.incompleteCaptures ?? 0);
  const indexingTotal = (indexing?.pending ?? 0) + (indexing?.failed ?? 0) + (indexing?.done ?? 0);
  const backlogMeasured = indexing?.pending != null && indexing.failed != null;
  const backlogTotal = (indexing?.pending ?? 0) + (indexing?.failed ?? 0);
  const chartMax = Math.max(400, Math.ceil(maxDaily / 400) * 400);
  const contextMax = Math.max(1, measurements?.pageContentSupplied ?? 0, measurements?.sourceReadTurns ?? 0,
    measurements?.partialReadTurns ?? 0, measurements?.unavailableReadTurns ?? 0);
  const outcomeMax = Math.max(1, measurements?.repliesSaved ?? 0, measurements?.completedAfterErrors ?? 0,
    workflow?.outcomes?.notRecorded ?? 0, workflow?.outcomes?.retryAttempts ?? 0);
  return (
    <section className="kh-health__dashboard" aria-labelledby="health-overview">
      <h2 id="health-overview" className="cds--visually-hidden">Runtime measurements</h2>
      <div className="kh-health__coverage">
        <div className="kh-health__dashboard-metrics">
          <section className="kh-health__command-card">
            <h3>Model-call success</h3>
            <div className="kh-health__command-measure">
              <Ring value={usage ? usage.calls - usage.failures : undefined} total={usage?.calls} label="Model calls returned successfully" />
              <div><span>Failure rate</span><strong className="kh-health__failure-value">{rate(usage?.failures, usage?.calls)}</strong>
                <small>{usage ? `${number.format(usage.failures)} failed / ${number.format(usage.calls)}` : 'Usage unavailable'}</small></div>
            </div>
            <p>Provider responses, not verified task success.</p>
            <div className="kh-health__actions">
              <Button kind="ghost" size="sm" disabled={busy} onClick={onInspectUsage}>Inspect model-call usage</Button>
            </div>
          </section>
          <section className="kh-health__command-card">
            <h3>Failure hotspot</h3>
            <div className="kh-health__command-measure">
              <Ring value={failingFeature?.failures} total={failingFeature?.calls} label="Failure rate for the feature with most failed calls" warning />
              <div><span className="kh-health__attention-feature">{failingFeature?.feature ?? (reliability ? 'No failed calls recorded' : 'Reliability unavailable')}</span>
                <strong className="kh-health__failure-value">{failingFeature ? number.format(failingFeature.failures) : reliability ? '0' : 'Not measured'}</strong>
                <small>{failingFeature ? `failed / ${number.format(failingFeature.calls)} calls` : 'In the selected runtime and window'}</small></div>
            </div>
            <p>Highest failed-call count in this window.</p>
            {failingFeature && <div className="kh-health__actions">
              <Button kind="ghost" size="sm" disabled={busy} onClick={() => onInspectFeature(failingFeature.feature)}>Inspect feature usage</Button>
            </div>}
          </section>
          <section className="kh-health__command-card">
            <h3>Shared indexing backlog</h3>
            <div className="kh-health__backlog-measure">
            <strong className="kh-health__backlog-total">{backlogMeasured ? number.format(backlogTotal) : 'Not measured'}</strong>
            {indexing?.pending != null && indexing.failed != null && <div className="kh-health__distribution" role="img" aria-label={`${indexing.pending} pending, ${indexing.failed} failed`}>
              <span className="kh-health__work kh-health__work--pending" style={{ width: `${100 * indexing.pending / Math.max(1, backlogTotal)}%` }} />
              <span className="kh-health__work kh-health__work--failed" style={{ width: `${100 * indexing.failed / Math.max(1, backlogTotal)}%` }} />
            </div>}
            </div>
            <div className="kh-health__legend">
              <span className="kh-health__legend-pending">{indexing?.pending ?? 'Unknown'} pending</span>
              <span className="kh-health__legend-failed">{indexing?.failed ?? 'Unknown'} failed</span>
            </div>
            <div className="kh-health__actions"><Button kind="ghost" size="sm" disabled={busy} onClick={onInspectIndex}>Inspect index coverage</Button></div>
          </section>
          <section className="kh-health__command-card">
            <h3>Measurement gaps</h3>
            <div className="kh-health__gaps">
              <div><i className="kh-health__gap-ring" aria-hidden="true" /><div>Trace capture<small>{measurements ? `${measurements.captureComplete}/${measurements.finished} finished · ${missing} gaps · ${measurements.unfinished} unfinished` : 'Unavailable'}</small></div><span className="kh-health__gap-status">{rate(measurements?.captureComplete, measurements?.finished)}</span></div>
              <div><i className="kh-health__gap-ring kh-health__gap-ring--warning" aria-hidden="true" /><div>Answer correctness<small>{measurements ? `${measurements.evaluated.model} reviewed · ${measurements.evaluated.unreviewed} unreviewed` : 'Not verified'}</small></div><span className="kh-health__gap-status kh-health__gap-status--warning">Unverified</span></div>
              <div><i className="kh-health__gap-ring" aria-hidden="true" /><div>Source check<small>{latestSync ? `${when(latestSync.finishedAt)}; ${latestSync.sources.reduce((n, source) => n + source.errors, 0)} errors` : 'No sync for this runtime'}</small></div><span className="kh-health__gap-status">{latestSync?.status ?? 'Not measured'}</span></div>
            </div>
          </section>
        </div>
      </div>
      <div className="kh-health__charts kh-health__charts--primary">
        <section className="kh-health__chart kh-health__activity" aria-labelledby="health-daily-chart">
          <div className="kh-health__activity-heading">
          <h3 id="health-daily-chart">Daily model calls</h3>
          <p className="kh-health__note">UTC days with recorded calls · count per day</p>
          <p className="kh-health__legend">
            <span className="kh-health__legend-done">Returned successfully</span>
            <span className="kh-health__legend-failed">Failed</span>
          </p>
          </div>
          <div className="kh-health__activity-body">
          {!reliability ? <p>Daily usage unavailable.</p> : reliability.daily.length === 0 ? <p>No model calls in this window.</p> : (
            <div className="kh-health__plot">
              <div className="kh-health__axis" aria-hidden="true">
                {[1, 2 / 3, 1 / 3, 0].map(fraction => <span key={fraction}>{number.format(Math.round(chartMax * fraction))}</span>)}
              </div>
              <div className="kh-health__histogram" role="list" aria-label="Daily model-call success and failure counts">
              {reliability.daily.map(day => <div key={day.day} className="kh-health__day" role="listitem"
                aria-label={`${day.day}: ${day.calls} calls, ${day.failures} failed`}>
                <span className="kh-health__day-count">{number.format(day.calls)}</span>
                <div className="kh-health__day-track" aria-hidden="true">
                  <span className="kh-health__day-success" style={{ height: `${100 * (day.calls - day.failures) / chartMax}%` }} />
                  <span className="kh-health__day-failure" style={{ height: `${100 * day.failures / chartMax}%` }} />
                </div>
                <span>{day.day.slice(5)}</span>
                <span className="kh-health__day-count">{new Date(`${day.day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span>
                <span className={`kh-health__day-count${day.failures > 0 ? ' kh-health__day-count--failed' : ''}`}>{day.failures} failed</span>
              </div>)}
              </div>
            </div>
          )}
          </div>
        </section>
        <section className="kh-health__chart kh-health__ai-usage" aria-labelledby="health-ai-usage">
          <h3 id="health-ai-usage">AI usage</h3>
          <dl className="kh-health__usage-strip">
            <div><dt>Total tokens</dt><dd>{usage && usage.measuredCalls > 0 ? number.format(usage.totalTokens) : 'Not measured'}</dd>
              <p>{usage && usage.measuredCalls > 0 ? `About ${number.format(Math.round(usage.totalTokens / usage.measuredCalls))} per measured call (derived)` : 'Provider usage not available'}</p></div>
            <div><dt>Average latency</dt><dd>{usage?.avgLatencyMs == null ? 'Not measured' : number.format(Math.round(usage.avgLatencyMs))}<small> ms</small></dd></div>
            <div><dt>Usage reported</dt><dd>{usage ? number.format(usage.measuredCalls) : 'Not measured'}<small> of {usage ? number.format(usage.calls) : 'unknown'} calls</small></dd>
              {usage && usage.calls > 0 && <div className="kh-health__usage-meter" role="meter" aria-label="Calls with reported usage" aria-valuemin={0} aria-valuemax={usage.calls} aria-valuenow={usage.measuredCalls}><span style={{ width: `${100 * usage.measuredCalls / usage.calls}%` }} /></div>}</div>
          </dl>
        </section>
      </div>
      <div className="kh-health__charts">
      <section className="kh-health__chart" aria-labelledby="health-slow-features">
        <h3 id="health-slow-features">Slowest model calls</h3>
        <p className="kh-health__note">Average seconds · top five returned groups · not end-to-end time.</p>
        {slowGroups.length === 0 ? <p className="kh-health__empty">No measured latency groups available.</p> : <div className="kh-health__latency-groups">
          {slowGroups.map(row => <div key={JSON.stringify([row.feature, row.persona, row.deployment])} className="kh-health__latency-group">
            <Button className="kh-health__chart-link" kind="ghost" size="sm" disabled={busy} onClick={() => onInspectFeature(row.feature)}>{row.feature}</Button>
            <span>{((row.avgLatencyMs ?? 0) / 1000).toFixed(1)} s · {number.format(row.calls)} calls</span>
            <div className="kh-health__usage-meter" aria-hidden="true"><span style={{ width: `${100 * (row.avgLatencyMs ?? 0) / Math.max(1, slowGroups[0]?.avgLatencyMs ?? 0)}%` }} /></div>
            <span className="kh-health__latency-meta">{row.persona ?? 'No persona'} · {row.deployment}</span>
          </div>)}
        </div>}
        <p className="kh-health__note">Select a feature to inspect usage. Check traces before tuning; long tasks and small samples need context.</p>
      </section>
        <section className="kh-health__chart" aria-labelledby="health-feature-chart">
          <h3 id="health-feature-chart">Where calls fail</h3>
          <p className="kh-health__note">Failure rate · highest failure counts first · select a feature to inspect.</p>
          {!reliability ? <p>Feature reliability unavailable.</p> : reliability.features.length === 0 ? <p>No feature measurements.</p> : (
            <div className="kh-health__feature-bars">
              {reliability.features.map(row => <div key={row.feature} className="kh-health__feature">
                <div><Button className="kh-health__chart-link" kind="ghost" size="sm" disabled={busy} onClick={() => onInspectFeature(row.feature)}>{row.feature}</Button><span>{row.failures}/{row.calls} failed · {rate(row.failures, row.calls)}</span></div>
                <div className="kh-health__feature-track" role="meter" aria-label={`${row.feature} failure percentage`}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={100 * row.failures / row.calls}
                  aria-valuetext={`${row.failures} failures in ${row.calls} calls`}>
                  <span style={{ width: `${100 * row.failures / row.calls}%` }} />
                </div>
              </div>)}
            </div>
          )}
        </section>
      </div>
      <section className="kh-health__backlog" aria-labelledby="health-backlog">
        <h3 id="health-backlog">Indexing work</h3>
        <p className="kh-health__note">Oldest pending update: {when(indexing?.oldestPendingAt)}. Pending and failed work can delay semantic-search freshness.</p>
        {indexing?.pending == null || indexing.failed == null || indexing.done == null ? <p>Work distribution not measured.</p> : <>
          <div className="kh-health__distribution" role="img"
            aria-label={`${indexing.pending} pending, ${indexing.failed} failed, ${indexing.done} done`}>
            {[['pending', indexing.pending], ['failed', indexing.failed], ['done', indexing.done]].map(([state, count]) =>
              <span key={state} className={`kh-health__work kh-health__work--${state}`}
                style={{ width: `${100 * Number(count) / Math.max(1, indexingTotal)}%` }} />)}
          </div>
          <p className="kh-health__legend">
            <span className="kh-health__legend-pending">{number.format(indexing.pending)} pending</span>
            <span className="kh-health__legend-failed">{number.format(indexing.failed)} failed</span>
            <span className="kh-health__legend-done">{number.format(indexing.done)} done</span>
          </p>
        </>}
      </section>
      <div className="kh-health__charts">
        <section className="kh-health__chart" aria-labelledby="health-context-summary">
          <h3 id="health-context-summary">Observed chat context</h3>
          {measurements ? <dl className="kh-health__observation-list">
            <Observation label="Page content supplied" count={measurements.pageContentSupplied} maximum={contextMax} />
            <Observation label="Structured source read" count={measurements.sourceReadTurns} maximum={contextMax} />
            <Observation label="Partial reads" count={measurements.partialReadTurns} maximum={contextMax} warning />
            <Observation label="Unavailable / omitted reads" count={measurements.unavailableReadTurns} maximum={contextMax} warning />
          </dl> : <p>{data.measurements && !data.measurements.available ? data.measurements.message : 'Not measured by this server.'}</p>}
          {measurements?.accepted === 0 && <p className="kh-health__empty">No recorded turns in this runtime/window. Zero observations are not evidence of healthy context.</p>}
          <p className="kh-health__note">These observations overlap. They do not prove the right content was read, that a full original was extracted, or that retrieval was needed.</p>
        </section>
        <section className="kh-health__chart" aria-labelledby="health-outcome-summary">
          <h3 id="health-outcome-summary">Recorded outcomes and recovery</h3>
          <dl className="kh-health__observation-list">
            <Observation label="Chat replies saved" count={measurements?.repliesSaved} maximum={outcomeMax} />
            <Observation label="Completed after errors" count={measurements?.completedAfterErrors} maximum={outcomeMax} />
            <Observation label="Workflow outcome missing" count={workflow?.outcomes?.notRecorded} maximum={outcomeMax} warning />
            <Observation label="Recorded retry attempts" count={workflow?.outcomes?.retryAttempts} maximum={outcomeMax} />
          </dl>
          <p className="kh-health__note">Bars compare recorded counts within each panel, not success rates.</p>
          <p className="kh-health__note">A saved chat reply is not a saved edit. Completion after errors is not proven recovery. Workflow retries require recorded attempt identity; historical outcomes are not guessed.</p>
        </section>
      </div>
      <div className="kh-health__charts">
        <section className="kh-health__chart" aria-labelledby="health-capture-chart">
          <h3 id="health-capture-chart">Trace capture distribution</h3>
          {!measurements || measurements.accepted === 0 ? <p className="kh-health__empty">No recorded turns to measure. Capture coverage is not measured, not 0%.</p> : <>
            <div className="kh-health__distribution" aria-label="Trace capture by recorded turn" role="img">
              {[['Complete', measurements.captureComplete, 'complete'], ['Incomplete', measurements.incompleteCaptures, 'incomplete'],
                ['Missing', measurements.missingTraces, 'missing'], ['Unfinished', measurements.unfinished, 'unfinished']].map(([label, count, kind]) =>
                <span key={String(label)} className={`kh-health__segment kh-health__segment--${String(kind)}`}
                  style={{ width: `${100 * Number(count) / measurements.accepted}%` }} title={`${label}: ${count}`} />)}
            </div>
            <p className="kh-health__note">Complete {measurements.captureComplete} · Incomplete {measurements.incompleteCaptures} · Missing {measurements.missingTraces} · Unfinished {measurements.unfinished}</p>
          </>}
        </section>
        <section className="kh-health__chart" aria-labelledby="health-source-map">
          <h3 id="health-source-map">Latest completed source check</h3>
          {!latestSync ? <p className="kh-health__empty">No completed run attributed to this runtime. Legacy history is not treated as production.</p>
            : <div className="kh-health__source-map">{latestSync.sources.map(source => <div key={source.source}
              className={`kh-health__source-cell${source.errors > 0 ? ' kh-health__source-cell--error' : ''}`}>
              <strong>{source.source}</strong><span>{source.errors > 0 ? `${source.errors} errors` : 'No reported errors'}</span>
              <small>{source.indexed} indexed · {data.filters.environment}</small>
            </div>)}</div>}
          <p className="kh-health__note">Recorded check result, not a guarantee of upstream completeness. Last indexed and last successfully checked are different.</p>
        </section>
      </div>
      <section className="kh-health__limitations" aria-labelledby="health-interpretation">
        <h3 id="health-interpretation">How to interpret these measurements</h3>
        <p>Environment identifies the executing backend, not the database. Content and index inventory are shared.
          Legacy runs without runtime attribution remain unknown. Missing data is not a healthy result.</p>
        <p>Capture and saved replies do not establish correct answers. Model evaluations are fallible reviews, not human verification.
          Full measurement definitions and counts are in the Turn measurements tab.</p>
        <p>Call counts and latency describe activity, not live capacity. CPU, memory, concurrency and saturation are not measured here.
          Latency rankings cover returned usage groups, not every operation; inspect traces before choosing a performance change.</p>
      </section>
    </section>
  );
};
