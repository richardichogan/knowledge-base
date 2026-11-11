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
  actionReliability: { measuredTurns: number; capabilityLoads: number; capabilityDenials: number; blockedCapabilities: number;
    receipts: number; warnings: number; contradictions: number; unconfirmedClaims: number };
  correctness: 'unreviewed';
  evaluated: { deterministic: number; deterministicFailed: number; model: number; human: { up: number; down: number }; unreviewed: number };
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
    COALESCE(SUM((signals->>'toolErrors')::int),0) tool_errors,
    COUNT(*) FILTER(WHERE signals->>'reliabilityObserved'='true')::int reliability_measured,
    COALESCE(SUM((signals->>'capabilityLoads')::int),0) capability_loads,
    COALESCE(SUM((signals->>'capabilityDenials')::int),0) capability_denials,
    COALESCE(SUM((signals->>'blockedCapabilities')::int),0) capability_blocked,
    COALESCE(SUM((signals->>'actionReceipts')::int),0) action_receipts,
    COALESCE(SUM((signals->>'actionWarnings')::int),0) action_warnings,
    COALESCE(SUM((signals->>'actionContradictions')::int),0) action_contradictions,
    COALESCE(SUM((signals->>'unconfirmedActionClaims')::int),0) action_unconfirmed
    FROM ai_turn_measurements WHERE expires_at>NOW() AND started_at>=$1::timestamptz AND started_at<$2::timestamptz
      AND environment=$3 AND ($4::text IS NULL OR persona=$4)
    GROUP BY "day" ORDER BY "day"`, [start, end, filters.environment, filters.persona]);
  const sum = (name: string): number => rows.reduce((total, row) => total + Number(row[name]), 0);
  const first = rows[0]?.first_at;
  const evaluations = await db.query<{ deterministic: number; deterministic_failed: number; model: number }>(`SELECT
    COUNT(DISTINCT m.id) FILTER(WHERE e.method='deterministic')::int deterministic,
    COUNT(DISTINCT m.id) FILTER(WHERE e.method='deterministic' AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(e.report->'checks') c WHERE c->>'verdict'='fail'))::int deterministic_failed,
    COUNT(DISTINCT m.id) FILTER(WHERE e.method='model')::int model
    FROM ai_turn_measurements m JOIN ai_trace_evaluations e ON e.trace_id=m.id AND e.status='completed'
    WHERE m.expires_at>NOW() AND m.started_at>=$1::timestamptz AND m.started_at<$2::timestamptz
      AND m.environment=$3 AND ($4::text IS NULL OR m.persona=$4)`, [start, end, filters.environment, filters.persona]);
  // His 👍/👎 on a reply, matched to the turn that produced it (feedback stores the session and reply excerpt).
  const human = await db.query<{ up: number; down: number; reviewed: number }>(`SELECT
    COUNT(*) FILTER(WHERE r.rating='up')::int up, COUNT(*) FILTER(WHERE r.rating='down')::int down,
    COUNT(*) FILTER(WHERE r.rating IS NOT NULL OR EXISTS(SELECT 1 FROM ai_trace_evaluations e
      WHERE e.trace_id=m.id AND e.status='completed' AND e.method='model'))::int reviewed
    FROM ai_turn_measurements m
    LEFT JOIN ai_turn_traces t ON t.id=m.id
    LEFT JOIN ai_chat_messages msg ON msg.id=t.assistant_message_id
    LEFT JOIN LATERAL (SELECT f.rating FROM athena_feedback f
      WHERE f.session_id=t.session_id AND f.reply_excerpt=left(msg.content,1000) ORDER BY f.created_at DESC LIMIT 1) r ON TRUE
    WHERE m.expires_at>NOW() AND m.started_at>=$1::timestamptz AND m.started_at<$2::timestamptz
      AND m.status<>'running'
      AND m.environment=$3 AND ($4::text IS NULL OR m.persona=$4)`, [start, end, filters.environment, filters.persona]);
  const ratedUp = Number(human.rows[0]?.up ?? 0);
  const ratedDown = Number(human.rows[0]?.down ?? 0);
  const reviewed = Number(human.rows[0]?.reviewed ?? 0);
  return {
    firstRecordedAt: first ? new Date(String(first)).toISOString() : null, retentionDays: 7,
    accepted: sum('accepted'), finished: sum('finished'), captureComplete: sum('complete'),
    missingTraces: sum('missing'), incompleteCaptures: sum('incomplete'), unfinished: sum('unfinished'),
    signalsMeasured: sum('measured'), uiObserved: sum('ui'), contextObserved: sum('context'), pageContentSupplied: sum('page'),
    sourceReadTurns: sum('source_read'), partialReadTurns: sum('partial_read'), unavailableReadTurns: sum('unavailable_read'),
    noObservedSourceTurns: sum('no_source'), repliesSaved: sum('saved'), failed: sum('failed'), interrupted: sum('interrupted'),
    completedAfterErrors: sum('recovered'), transportRetries: sum('retries'), modelErrors: sum('model_errors'), toolErrors: sum('tool_errors'),
    actionReliability: { measuredTurns: sum('reliability_measured'), capabilityLoads: sum('capability_loads'),
      capabilityDenials: sum('capability_denials'), blockedCapabilities: sum('capability_blocked'),
      receipts: sum('action_receipts'), warnings: sum('action_warnings'), contradictions: sum('action_contradictions'),
      unconfirmedClaims: sum('action_unconfirmed') },
    correctness: 'unreviewed',
    evaluated: { deterministic: Number(evaluations.rows[0]?.deterministic ?? 0),
      deterministicFailed: Number(evaluations.rows[0]?.deterministic_failed ?? 0), model: Number(evaluations.rows[0]?.model ?? 0),
      human: { up: ratedUp, down: ratedDown }, unreviewed: sum('finished') - reviewed },
    daily: rows.map(row => ({ day: String(row.day), accepted: Number(row.accepted), complete: Number(row.complete), failed: Number(row.failed) })),
    note: 'Seven-day, post-instrumentation chat turns only, including failures and interruptions. Recorded accepted turns are the denominator; telemetry database failures can leave uncounted turns and are logged. Active turns have unfinished capture. Signals count structured observations, not proof of correct intent or full source extraction. Page content, reads and errors overlap. No observed source is not proof retrieval was needed or no evidence existed in history/search. Completed after errors means the turn returned, not that the failed operation recovered. Reply saved means chat history persisted, not a requested edit or delivery. Correctness comes only from his 👍/👎 on replies and optional model reviews; no automated accuracy score is inferred.',
  };
}
