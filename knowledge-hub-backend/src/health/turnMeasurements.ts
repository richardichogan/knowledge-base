import type { Pool } from 'pg';
import type { HealthFilters } from './knowledgeHealth.js';

export interface TurnMeasurementHealth {
  firstRecordedAt: string | null;
  retentionDays: number;
  accepted: number;
  finished: number;
  captureComplete: number;
  missingTraces: number;
  incompleteCaptures: number;
  unfinished: number;
  signalsMeasured: number;
  uiObserved: number;
  contextObserved: number;
  pageContentSupplied: number;
  sourceReadTurns: number;
  partialReadTurns: number;
  unavailableReadTurns: number;
  noObservedSourceTurns: number;
  repliesSaved: number;
  failed: number;
  interrupted: number;
  completedAfterErrors: number;
  transportRetries: number;
  modelErrors: number;
  toolErrors: number;
  correctness: 'unreviewed';
  evaluated: { deterministic: number; model: number; unreviewed: number };
  daily: Array<{ day: string; accepted: number; complete: number; failed: number }>;
  note: string;
}

export async function readTurnMeasurements(
  db: Pool, filters: HealthFilters, start: string, end: string,
): Promise<TurnMeasurementHealth> {
  const { rows } = await db.query<Record<string, unknown>>(`SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day",
    MIN(started_at) first_at, COUNT(*)::int accepted,
    COUNT(*) FILTER(WHERE status<>'running')::int finished,
    COUNT(*) FILTER(WHERE status<>'running' AND capture_complete)::int complete,
    COUNT(*) FILTER(WHERE status<>'running' AND NOT trace_started)::int missing,
    COUNT(*) FILTER(WHERE status<>'running' AND trace_started AND NOT capture_complete)::int incomplete,
    COUNT(*) FILTER(WHERE status='running')::int unfinished,
    COUNT(*) FILTER(WHERE signals IS NOT NULL)::int measured,
    COUNT(*) FILTER(WHERE signals->>'uiObserved'='true')::int ui,
    COUNT(*) FILTER(WHERE signals->>'contextObserved'='true')::int context,
    COUNT(*) FILTER(WHERE signals->>'pageContentSupplied'='true')::int page,
    COUNT(*) FILTER(WHERE (signals->>'completeReads')::int>0 OR (signals->>'partialReads')::int>0)::int source_read,
    COUNT(*) FILTER(WHERE (signals->>'partialReads')::int>0)::int partial_read,
    COUNT(*) FILTER(WHERE (signals->>'unavailableReads')::int>0)::int unavailable_read,
    COUNT(*) FILTER(WHERE signals IS NOT NULL AND signals->>'contextObserved'='true'
      AND signals->>'pageContentSupplied'='false' AND (signals->>'completeReads')::int=0
      AND (signals->>'partialReads')::int=0)::int no_source,
    COUNT(*) FILTER(WHERE signals->>'replySaved'='true')::int saved,
    COUNT(*) FILTER(WHERE status='failed')::int failed,
    COUNT(*) FILTER(WHERE status='interrupted')::int interrupted,
    COUNT(*) FILTER(WHERE status='completed' AND ((signals->>'modelErrors')::int>0 OR (signals->>'toolErrors')::int>0))::int recovered,
    COALESCE(SUM((signals->>'transportRetries')::int),0) retries,
    COALESCE(SUM((signals->>'modelErrors')::int),0) model_errors,
    COALESCE(SUM((signals->>'toolErrors')::int),0) tool_errors
    FROM ai_turn_measurements WHERE expires_at>NOW() AND started_at>=$1::timestamptz AND started_at<$2::timestamptz
      AND environment=$3 AND ($4::text IS NULL OR persona=$4)
    GROUP BY "day" ORDER BY "day"`, [start, end, filters.environment, filters.persona]);
  const sum = (name: string): number => rows.reduce((total, row) => total + Number(row[name]), 0);
  const first = rows[0]?.first_at;
  const evaluations = await db.query<{ deterministic: number; model: number }>(`SELECT
    COUNT(DISTINCT m.id) FILTER(WHERE e.method='deterministic')::int deterministic,
    COUNT(DISTINCT m.id) FILTER(WHERE e.method='model')::int model
    FROM ai_turn_measurements m JOIN ai_trace_evaluations e ON e.trace_id=m.id AND e.status='completed'
    WHERE m.expires_at>NOW() AND m.started_at>=$1::timestamptz AND m.started_at<$2::timestamptz
      AND m.environment=$3 AND ($4::text IS NULL OR m.persona=$4)`, [start, end, filters.environment, filters.persona]);
  return {
    firstRecordedAt: first ? new Date(String(first)).toISOString() : null, retentionDays: 7,
    accepted: sum('accepted'), finished: sum('finished'), captureComplete: sum('complete'),
    missingTraces: sum('missing'), incompleteCaptures: sum('incomplete'), unfinished: sum('unfinished'),
    signalsMeasured: sum('measured'), uiObserved: sum('ui'), contextObserved: sum('context'), pageContentSupplied: sum('page'),
    sourceReadTurns: sum('source_read'), partialReadTurns: sum('partial_read'), unavailableReadTurns: sum('unavailable_read'),
    noObservedSourceTurns: sum('no_source'), repliesSaved: sum('saved'), failed: sum('failed'), interrupted: sum('interrupted'),
    completedAfterErrors: sum('recovered'), transportRetries: sum('retries'), modelErrors: sum('model_errors'), toolErrors: sum('tool_errors'),
    correctness: 'unreviewed',
    evaluated: { deterministic: Number(evaluations.rows[0]?.deterministic ?? 0), model: Number(evaluations.rows[0]?.model ?? 0),
      unreviewed: sum('finished') - Number(evaluations.rows[0]?.model ?? 0) },
    daily: rows.map(row => ({ day: String(row.day), accepted: Number(row.accepted), complete: Number(row.complete), failed: Number(row.failed) })),
    note: 'Seven-day, post-instrumentation chat turns only, including failures and interruptions. Recorded accepted turns are the denominator; telemetry database failures can leave uncounted turns and are logged. Active turns have unfinished capture. Signals count structured observations, not proof of correct intent or full source extraction. Page content, reads and errors overlap. No observed source is not proof retrieval was needed or no evidence existed in history/search. Completed after errors means the turn returned, not that the failed operation recovered. Reply saved means chat history persisted, not a requested edit or delivery. Correctness is unreviewed; no automated accuracy score is inferred.',
  };
}
