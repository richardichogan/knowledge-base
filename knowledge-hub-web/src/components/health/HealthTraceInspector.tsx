import React, { useEffect, useState } from 'react';
import { Button, InlineLoading } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type HealthTrace, type KnowledgeHealthParams } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { DataNotice } from '../DataNotice';

export interface HealthTraceSelection { traceId: string; sessionId: string; spanId: string | null; eventSequence: number }
const when = (value: string): string => new Date(value).toLocaleString('en-GB');

export const HealthTraceInspector: React.FC<{
  filters: KnowledgeHealthParams; onSelection: (selection: HealthTraceSelection | null) => void;
}> = ({ filters, onSelection }) => {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HealthTrace | null>(null);
  const [spanOffset, setSpanOffset] = useState(0);
  const [spanId, setSpanId] = useState<string | null>(null);
  const [positions, setPositions] = useState([{ sequence: 1, offset: 0 }]);
  const position = positions[positions.length - 1]!;
  const [busy, setBusy] = useState(false);
  const [confirmModel, setConfirmModel] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const traces = useQuery({ queryKey: ['health-traces', filters, offset],
    queryFn: async () => requireApiData(await api.listHealthTraces(filters, offset)), retry: false, refetchOnWindowFocus: false });
  const spans = useQuery({ queryKey: ['health-spans', selected?.id, spanOffset], enabled: selected !== null,
    queryFn: async () => requireApiData(await api.getHealthTraceSpans(selected!, spanOffset)), retry: false, refetchOnWindowFocus: false });
  const events = useQuery({ queryKey: ['health-events', selected?.id, position.sequence, position.offset], enabled: selected !== null,
    queryFn: async () => requireApiData(await api.readChatTurnTrace(selected!.session_id, selected!.id, position.sequence, position.offset)),
    retry: false, refetchOnWindowFocus: false });
  const evaluations = useQuery({ queryKey: ['health-evaluations', selected?.id], enabled: selected !== null,
    queryFn: async () => requireApiData(await api.getHealthTraceEvaluations(selected!)), retry: false, refetchOnWindowFocus: false });
  useEffect(() => {
    onSelection(selected ? { traceId: selected.id, sessionId: selected.session_id, spanId, eventSequence: position.sequence } : null);
  }, [selected, spanId, position.sequence, onSelection]);

  const choose = (trace: HealthTrace): void => {
    setSelected(trace); setSpanOffset(0); setSpanId(null); setPositions([{ sequence: 1, offset: 0 }]); setError(null); setConfirmModel(false);
  };
  const evaluate = async (method: 'deterministic' | 'model'): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true); setError(null); setConfirmModel(false);
    try {
      requireApiData(await api.evaluateHealthTrace(selected, method, method === 'model'));
      await evaluations.refetch();
      await queryClient.invalidateQueries({ queryKey: ['knowledge-health'] });
    }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const page = events.data;
  const traceStart = selected ? Date.parse(selected.started_at) : 0;
  const elapsed = selected ? Math.max(1, Date.parse(selected.finished_at ?? new Date().toISOString()) - traceStart) : 1;
  return (
    <section className="kh-health__section" aria-labelledby="health-trace-inspector">
      <h2 id="health-trace-inspector">Trace explorer and evaluations</h2>
      <p className="kh-health__note">Seven-day diagnostic evidence, including captured prompts and tool results. Redacted, never replayed.
        Environment tags identify runtime. Historical traces may have no spans. Evaluation reports expire with their trace.</p>
      {traces.isPending && <InlineLoading description="Loading traces" />}
      {traces.isError && <DataNotice title="Traces unavailable" error={traces.error} onRetry={() => { void traces.refetch(); }} busy={traces.isFetching} />}
      {traces.data?.items.length === 0 && <p>No retained traces match these filters. This is not a successful-capture score.</p>}
      <div className="kh-health__trace-picker">
        {traces.data?.items.map(trace => <button key={trace.id} type="button" className="kh-health__trace-choice"
          disabled={busy} aria-pressed={selected?.id === trace.id} onClick={() => choose(trace)}>
          <strong>{when(trace.started_at)}</strong><span>{trace.id.slice(0, 8)}</span>
          <span className="kh-health__tag">{trace.environment}</span><span className="kh-health__tag">{trace.status}</span>
          <span className={`kh-health__tag${trace.capture_complete ? '' : ' kh-health__tag--warning'}`}>{trace.capture_complete ? 'Capture complete' : 'Capture incomplete'}</span>
        </button>)}
      </div>
      <div className="kh-health__actions">
        <Button size="sm" kind="ghost" disabled={busy || traces.isFetching} onClick={() => {
          void traces.refetch().then(result => {
            const refreshed = result.data?.items.find(trace => trace.id === selected?.id);
            if (refreshed) setSelected(refreshed);
          });
          if (selected) { void spans.refetch(); void events.refetch(); void evaluations.refetch(); }
        }}>Refresh diagnostics</Button>
        <Button size="sm" kind="ghost" disabled={offset === 0 || busy || traces.isFetching} onClick={() => setOffset(Math.max(0, offset - 20))}>Newer traces</Button>
        <Button size="sm" kind="ghost" disabled={traces.data?.nextOffset == null || busy || traces.isFetching}
          onClick={() => setOffset(traces.data!.nextOffset!)}>Older traces</Button>
      </div>
      {selected && <>
        <div className="kh-health__actions">
          <p className="kh-health__note">Trace {selected.id} · session {selected.session_id} · {selected.environment}</p>
          <Button size="sm" kind="ghost" disabled={busy} onClick={() => {
            setSelected(null); setSpanId(null); setConfirmModel(false); setError(null);
          }}>Clear trace selection</Button>
        </div>
        <h3>Span waterfall</h3>
        {spans.isPending && <InlineLoading description="Loading spans" />}
        {spans.isError && <DataNotice title="Spans unavailable" error={spans.error} onRetry={() => { void spans.refetch(); }} busy={spans.isFetching} />}
        {spans.data?.items.length === 0 && <p>No spans recorded. Older event traces cannot be retroactively timed.</p>}
        <div className="kh-health__waterfall">
          {spans.data?.items.map(span => {
            const start = Math.max(0, Date.parse(span.started_at) - traceStart);
            return <button key={span.id} type="button" className="kh-health__span" aria-pressed={spanId === span.id}
              onClick={() => setSpanId(span.id)}>
              <span><strong>{span.name}</strong> <span className="kh-health__tag">{span.kind}</span> <span className="kh-health__tag">{span.status}</span>
                <small>{span.parent_id ? `Parent ${span.parent_id.slice(0, 8)}` : 'Root'} · {span.duration_ms === null ? 'Unfinished' : `${Math.round(span.duration_ms)} ms`}</small></span>
              <span className="kh-health__span-track" aria-hidden="true"><span className={`kh-health__span-bar kh-health__span-bar--${span.status}`}
                style={{ left: `${Math.min(100, 100 * start / elapsed)}%`, width: `${Math.min(100 - Math.min(100, 100 * start / elapsed), 100 * (span.duration_ms ?? 0) / elapsed)}%` }} /></span>
            </button>;
          })}
        </div>
        {spanId && <pre className="kh-health__json">{JSON.stringify(spans.data?.items.find(span => span.id === spanId), null, 2)}</pre>}
        <div className="kh-health__actions">
          <Button size="sm" kind="ghost" disabled={spanOffset === 0 || spans.isFetching} onClick={() => { setSpanOffset(Math.max(0, spanOffset - 20)); setSpanId(null); }}>Previous spans</Button>
          <Button size="sm" kind="ghost" disabled={spans.data?.nextOffset == null || spans.isFetching}
            onClick={() => { setSpanOffset(spans.data!.nextOffset!); setSpanId(null); }}>Next spans</Button>
        </div>
        <details className="kh-health__details">
          <summary>Captured event data</summary>
          {events.isPending && <InlineLoading description="Loading captured event" />}
          {events.isError && <DataNotice title="Event unavailable" error={events.error} onRetry={() => { void events.refetch(); }} busy={events.isFetching} />}
          {page?.event ? <>
            <p className="kh-health__note"><span className="kh-health__tag">{page.event.kind}</span> Event {page.event.sequence} · span {page.event.spanId ?? 'Not recorded'} · characters {page.event.offset}–{Math.min(page.event.totalChars, page.event.offset + page.event.content.length)} of {page.event.totalChars}</p>
            <pre className="kh-health__json">{page.event.content}</pre>
          </> : page && <p>No event at this position.</p>}
          <div className="kh-health__actions">
            <Button size="sm" kind="ghost" disabled={positions.length === 1 || events.isFetching} onClick={() => setPositions(current => current.slice(0, -1))}>Previous</Button>
            <Button size="sm" kind="ghost" disabled={!page || page.nextOffset === null && page.nextSequence === null || events.isFetching} onClick={() => {
              if (!page) return;
              setPositions(current => [...current, page.nextOffset !== null
                ? { sequence: position.sequence, offset: page.nextOffset } : { sequence: page.nextSequence!, offset: 0 }]);
            }}>Next chunk / event</Button>
          </div>
        </details>
        <h3>Evaluate saved evidence</h3>
        <p className="kh-health__note">Deterministic checks make no model call. Model review is optional, uses the configured standard model, and returns fallible judgements with event references—not verified accuracy. No source actions are replayed.</p>
        <div className="kh-health__actions">
          <Button size="sm" disabled={busy || selected.status === 'running'} onClick={() => { void evaluate('deterministic'); }}>Run deterministic checks</Button>
          <Button size="sm" kind="secondary" disabled={busy || selected.status === 'running'} onClick={() => setConfirmModel(true)}>Model review…</Button>
        </div>
        {confirmModel && <div className="kh-health__confirmation">
          <p>Run one model review of this saved trace? This uses model quota. Maximum input: 200,000 characters; no automatic replay or source edits.</p>
          <div className="kh-health__actions"><Button size="sm" disabled={busy} onClick={() => { void evaluate('model'); }}>Confirm model review</Button>
            <Button size="sm" kind="ghost" onClick={() => setConfirmModel(false)}>Cancel</Button></div>
        </div>}
        {busy && <InlineLoading description="Evaluating saved evidence" />}
        {error !== null && <DataNotice title="Evaluation failed" error={error} />}
        {evaluations.isPending && <InlineLoading description="Loading evaluation history" />}
        {evaluations.isError && <DataNotice title="Evaluation history unavailable" error={evaluations.error} onRetry={() => { void evaluations.refetch(); }} busy={evaluations.isFetching} />}
        {evaluations.data?.length === 0 && <p>This trace is unreviewed.</p>}
        {evaluations.data?.map(evaluation => <details className="kh-health__details" key={evaluation.id} open>
          <summary>{evaluation.method} · {evaluation.status} · {when(evaluation.created_at)}</summary>
          <p className="kh-health__note">Evaluator runtime: {evaluation.environment} · source runtime: {selected.environment} · {evaluation.version}{evaluation.model ? ` · ${evaluation.model}` : ''}</p>
          {evaluation.report ? <div className="kh-health__evaluation-checks">
            {evaluation.report.checks.map(check => <div key={check.criterion} className="kh-health__evaluation-check">
              <strong>{check.criterion.replaceAll('_', ' ')}</strong><span className={`kh-health__tag kh-health__tag--${check.verdict}`}>{check.verdict}</span>
              <p>{check.reason}</p><small>Evidence events: {check.evidenceSequences.join(', ') || 'None; uncertain'}</small>
            </div>)}<p className="kh-health__note">{evaluation.report.note}</p>
          </div> : <p>No completed report. Failed or unfinished evaluations do not establish an outcome.</p>}
        </details>)}
      </>}
    </section>
  );
};
