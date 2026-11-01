import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { connectionCredentials, credentialValue } from '../config/credentialValues.js';

interface TraceContext {
  id: string; db: Pool; sequence: number; closed: boolean; complete: boolean;
}
interface TraceSummary {
  id: string; assistant_message_id: string | null; environment: string; project_id: string | null;
  started_at: Date; expires_at: Date; finished_at: Date | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted'; capture_complete: boolean;
}
interface TraceEventPage {
  trace: Pick<TraceSummary, 'id' | 'status' | 'capture_complete'>;
  event: { sequence: number; kind: string; createdAt: Date; format: 'json'; offset: number; totalChars: number; content: string } | null;
  nextSequence: number | null; nextOffset: number | null;
}
const activeTrace = new AsyncLocalStorage<TraceContext>();
const PAGE_CHARS = 12_000;
const MIN_SECRET_CHARS = 8;
const RETENTION_CHECK_MS = 3_600_000;
const MAX_OFFSET = 100_000_000;
const LIST_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY = /(?:password|passwd|secret|authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?assertion|connection[-_]?string|private[-_]?key|database_url|^sig$|^token$|accountkey)/i;
const MASK = '[REDACTED]';

export function redactTrace(value: unknown): unknown {
  const secrets = [...Object.entries(process.env)
    .filter(([name, text]) => (SECRET_KEY.test(name) || /(?:^|_)(?:TOKEN|KEY)$/.test(name)) && typeof text === 'string' && text.length >= MIN_SECRET_CHARS)
    .map(([, text]) => text!),
  ...connectionCredentials.map(entry => credentialValue(entry.envKey, process.env[entry.envKey])).filter((value): value is string => !!value && value.length >= MIN_SECRET_CHARS)];
  const text = (input: string): string => {
    let result = input;
    for (const secret of secrets) result = result.split(secret).join(MASK);
    return result
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, MASK)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${MASK}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MASK)
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, MASK)
      .replace(/((?:api[-_]?key|password|passwd|client[-_]?secret|access[-_]?token|refresh[-_]?token|authorization|cookie|sig|token|accountkey)\s*["']?\s*[:=]\s*["']?)([^"'\s&,;}\]]+)/gi, `$1${MASK}`)
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${MASK}@`)
      .replace(/(postgres(?:ql)?:\/\/)[^/\s@]+@/gi, `$1${MASK}@`);
  };
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      // Tool arguments/results and page details can themselves contain serialized JSON.
      try { return JSON.stringify(visit(JSON.parse(item))); } catch { return text(item); }
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, SECRET_KEY.test(key) ? MASK : visit(child)]));
    }
    return item;
  };
  return visit(value);
}

function captureFailure(trace: TraceContext, stage: string): void {
  trace.complete = false;
  console.error('[turn-trace] Diagnostic capture incomplete:', { traceId: trace.id, stage });
}

export async function recordTurnTrace(kind: string, payload: unknown): Promise<void> {
  const trace = activeTrace.getStore();
  if (!trace || trace.closed) return;
  const sequence = ++trace.sequence;
  try {
    await trace.db.query('INSERT INTO ai_turn_trace_events(trace_id,sequence,kind,payload) VALUES($1,$2,$3,$4::jsonb)',
      [trace.id, sequence, kind, JSON.stringify(redactTrace(payload === undefined ? null : payload))]);
  } catch {
    captureFailure(trace, kind);
    try { await trace.db.query('UPDATE ai_turn_traces SET capture_complete=FALSE WHERE id=$1', [trace.id]); }
    catch { console.error('[turn-trace] Could not persist incomplete-capture marker:', trace.id); }
  }
}

export async function withTurnTrace<T>(
  db: Pool, sessionId: string | undefined, input: unknown, signal: AbortSignal | undefined, run: () => Promise<T>,
): Promise<T> {
  const parent = activeTrace.getStore();
  if (parent && !parent.closed) return run();
  const trace: TraceContext = { id: randomUUID(), db, sequence: 0, closed: false, complete: true };
  try {
    await db.query(`INSERT INTO ai_turn_traces(id,session_id,environment,project_id,status)
      SELECT $1,s.id,$3,s.project_id,'running'
      FROM (SELECT 1) seed LEFT JOIN ai_chat_sessions s ON s.id=$2::uuid`,
    [trace.id, sessionId ?? null, env.isDevelopment ? 'dev' : 'prod']);
  } catch {
    captureFailure(trace, 'start');
    return run();
  }
  return activeTrace.run(trace, async () => {
    await recordTurnTrace('turn.input', input);
    let status = 'completed';
    const interrupted = (): void => {
      void db.query("UPDATE ai_turn_traces SET status='interrupted',finished_at=NOW() WHERE id=$1 AND status='running'", [trace.id])
        .catch(() => { captureFailure(trace, 'interrupt'); });
    };
    signal?.addEventListener('abort', interrupted, { once: true });
    try {
      const result = await run();
      await recordTurnTrace('turn.output', result);
      return result;
    } catch (error) {
      status = signal?.aborted ? 'interrupted' : 'failed';
      await recordTurnTrace('turn.error', { name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      signal?.removeEventListener('abort', interrupted);
      trace.closed = true;
      try {
        await db.query(`UPDATE ai_turn_traces SET status=$2,finished_at=NOW(),capture_complete=capture_complete AND $3 WHERE id=$1`,
          [trace.id, signal?.aborted ? 'interrupted' : status, trace.complete]);
      } catch { captureFailure(trace, 'finish'); }
    }
  });
}

export async function linkTraceMessage(assistantMessageId: string): Promise<void> {
  const trace = activeTrace.getStore();
  if (!trace || !assistantMessageId) return;
  try {
    await trace.db.query('UPDATE ai_turn_traces SET assistant_message_id=$2 WHERE id=$1', [trace.id, assistantMessageId]);
  } catch { captureFailure(trace, 'message-link'); }
}

export async function setTraceProject(projectId: string | null): Promise<void> {
  const trace = activeTrace.getStore();
  if (!trace) return;
  try { await trace.db.query('UPDATE ai_turn_traces SET project_id=$2 WHERE id=$1', [trace.id, projectId]); }
  catch { captureFailure(trace, 'project-link'); }
}

export async function traceModelCall<T>(
  feature: string, deployment: string, api: string, body: unknown, run: () => Promise<T>,
): Promise<T> {
  if (!activeTrace.getStore()) return run();
  const callId = randomUUID();
  await recordTurnTrace('model.request', { callId, feature, deployment, api, body });
  try {
    const result = await run();
    await recordTurnTrace('model.response', { callId, result });
    return result;
  } catch (error) {
    await recordTurnTrace('model.error', { callId, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function pruneTurnTraces(db: Pool): Promise<void> {
  await db.query('DELETE FROM ai_turn_traces WHERE expires_at<=NOW()');
}

export function startTraceRetention(db: Pool): () => void {
  const prune = (): void => { void pruneTurnTraces(db).catch(() => { console.error('[turn-trace] Seven-day retention cleanup failed.'); }); };
  prune();
  const timer = setInterval(prune, RETENTION_CHECK_MS);
  timer.unref();
  return () => { clearInterval(timer); };
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError(`Supply a valid ${label}.`);
  return value;
}
function offset(value: unknown): number {
  const n = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_OFFSET) throw new ValidationError('Supply a nonnegative diagnostic offset.');
  return n;
}
export async function listTurnTraces(db: Pool, sessionId: unknown, from?: unknown, projectId?: string | null): Promise<{ items: TraceSummary[]; nextOffset: number | null; retentionDays: number }> {
  const id = validId(sessionId, 'chat session ID');
  const start = offset(from);
  const { rows } = await db.query<TraceSummary>(`SELECT id,assistant_message_id::text,environment,project_id,started_at,expires_at,finished_at,status,capture_complete
    FROM ai_turn_traces WHERE session_id=$1 AND expires_at>NOW() AND ($3::text IS NULL OR project_id=$3)
    ORDER BY started_at DESC,id DESC LIMIT 21 OFFSET $2`, [id, start, projectId ?? null]);
  return { items: rows.slice(0, LIST_SIZE), nextOffset: rows.length > LIST_SIZE ? start + LIST_SIZE : null, retentionDays: 7 };
}

export async function readTurnTrace(
  db: Pool, sessionId: unknown, traceId: unknown, sequence?: unknown, charOffset?: unknown, projectId?: string | null,
): Promise<TraceEventPage> {
  const session = validId(sessionId, 'chat session ID');
  const id = validId(traceId, 'trace ID');
  const after = offset(sequence);
  const start = offset(charOffset);
  const trace = await db.query<TraceEventPage['trace']>(`SELECT id,status,capture_complete FROM ai_turn_traces
    WHERE id=$1 AND session_id=$2 AND expires_at>NOW() AND ($3::text IS NULL OR project_id=$3)`, [id, session, projectId ?? null]);
  if (!trace.rows.length) throw new NotFoundError('Unexpired chat trace');
  const { rows } = await db.query<{ sequence: number; kind: string; created_at: Date; payload: unknown }>(
    'SELECT sequence,kind,created_at,payload FROM ai_turn_trace_events WHERE trace_id=$1 AND sequence>=$2 ORDER BY sequence LIMIT 2',
    [id, after || 1]);
  const event = rows[0];
  if (!event) return { trace: trace.rows[0]!, event: null, nextSequence: null, nextOffset: null };
  const content = JSON.stringify(redactTrace(event.payload));
  if (start > content.length) throw new ValidationError('The content offset exceeds this event. Start at offset zero for a new event.');
  return { trace: trace.rows[0]!, event: { sequence: event.sequence, kind: event.kind, createdAt: event.created_at,
    format: 'json', offset: start, totalChars: content.length, content: content.slice(start, start + PAGE_CHARS) },
  nextOffset: start + PAGE_CHARS < content.length ? start + PAGE_CHARS : null,
  nextSequence: rows[1]?.sequence ?? null };
}
