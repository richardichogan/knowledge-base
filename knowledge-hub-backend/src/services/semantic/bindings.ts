/**
 * Live semantic bindings: every read goes to the authoritative domain table, never to a graph snapshot or a
 * copy. Missing, excluded and unavailable states are preserved, and no content is returned for excluded records.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { parseNoteContent } from '../../utils/noteContent.js';
import { renderNoteAsText } from '../noteTextService.js';
import { normaliseTaskStatus } from '../taskStatus.js';
import { normaliseDueDate } from './taskSemantics.js';
import type { Acceptance, RecordOrigin, SemanticAccess, SemanticContext, SemanticKind, SemanticRecord, SemanticRef } from './types.js';

const EXCERPT_CHARS = 600;
const VERSION_HASH_CHARS = 16;
const SOURCE_TYPES = ['note', 'content_item', 'chat'] as const;
export type SourceType = typeof SOURCE_TYPES[number];

/** Per-kind reader override, used to prove failure handling without touching the database. */
export type EntityReader = (db: Pool, id: string, ctx: SemanticContext) => Promise<SemanticAccess>;
export type SemanticReaders = Partial<Record<SemanticKind, EntityReader>>;

export function sourceRef(type: SourceType, id: string): SemanticRef {
  return { kind: 'source', id: `${type}:${id}` };
}

export function parseSourceRef(ref: SemanticRef): { type: SourceType; id: string } | null {
  const separator = ref.id.indexOf(':');
  const type = ref.id.slice(0, separator) as SourceType;
  return separator > 0 && SOURCE_TYPES.includes(type) && ref.id.length > separator + 1 ? { type, id: ref.id.slice(separator + 1) } : null;
}

export function refKey(ref: SemanticRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Stable JSON so the same approved fields always hash to the same version. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fieldsVersion(fields: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(fields)).digest('hex').slice(0, VERSION_HASH_CHARS);
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function isExcluded(ctx: SemanticContext, ref: SemanticRef): boolean {
  const set = ctx.excludedIds;
  if (set === undefined || set.size === 0) return false;
  const inner = ref.kind === 'source' ? (parseSourceRef(ref)?.id ?? ref.id) : ref.id;
  return set.has(ref.id) || set.has(refKey(ref)) || set.has(inner);
}

function record(ref: SemanticRef, ctx: SemanticContext, title: string, projectId: string | null, fields: Record<string, unknown>,
  origin: RecordOrigin, updatedAt: unknown): SemanticAccess {
  return {
    status: 'ok',
    data: { ref, title, projectId, fields, origin, version: fieldsVersion({ title, projectId, ...fields }), sourceUpdatedAt: iso(updatedAt), readAt: ctx.now.toISOString() },
  };
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

async function readProject(db: Pool, id: string, ctx: SemanticContext): Promise<SemanticAccess> {
  const { rows } = await db.query<Row>(
    `SELECT id, name, goal, lifecycle_state, expected_outputs, updated_at FROM projects WHERE id = $1`, [id]);
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  return record({ kind: 'project', id }, ctx, str(row['name']), id, {
    name: str(row['name']), goal: str(row['goal']), lifecycleState: str(row['lifecycle_state']),
    expectedOutputs: Array.isArray(row['expected_outputs']) ? row['expected_outputs'] : [],
  }, 'human', row['updated_at']);
}

async function readTask(db: Pool, id: string, ctx: SemanticContext): Promise<SemanticAccess> {
  const { rows } = await db.query<Row>(
    `SELECT id, title, status, project_id, priority, to_char(due_date, 'YYYY-MM-DD') AS due_date, waiting_on, archived, updated_at
       FROM tasks WHERE id = $1`, [id]);
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  const status = normaliseTaskStatus(row['status']);
  return record({ kind: 'task', id }, ctx, str(row['title']), strOrNull(row['project_id']), {
    status: status ?? null, rawStatus: str(row['status']), waitingOn: strOrNull(row['waiting_on']),
    dueDate: normaliseDueDate(row['due_date']) ?? null, archived: row['archived'] === true, priority: str(row['priority']),
  }, 'human', row['updated_at']);
}

export function acceptanceOf(row: { accepted_at: unknown; acceptance_origin: unknown }): Acceptance {
  // Never upgrade: both the timestamp and the explicit confirmation origin must be present.
  return row.accepted_at !== null && row.accepted_at !== undefined && row.acceptance_origin === 'user_confirmed' ? 'accepted' : 'unknown';
}

async function readDecision(db: Pool, id: string, ctx: SemanticContext): Promise<SemanticAccess> {
  const { rows } = await db.query<Row>(
    `SELECT d.id::text AS id, d.session_id::text AS session_id, d.status, d.text, d.source, d.created_at, d.updated_at,
            d.accepted_at, d.acceptance_origin, to_char(d.review_date, 'YYYY-MM-DD') AS review_date, s.project_id
       FROM chat_decisions d LEFT JOIN ai_chat_sessions s ON s.id = d.session_id WHERE d.id::text = $1`, [id]);
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  const acceptance = acceptanceOf({ accepted_at: row['accepted_at'], acceptance_origin: row['acceptance_origin'] });
  return record({ kind: 'decision', id }, ctx, str(row['text']), strOrNull(row['project_id']), {
    text: str(row['text']), status: str(row['status']), recordedBy: row['source'] === 'user' ? 'user' : 'assistant_extraction',
    acceptance, acceptedAt: acceptance === 'accepted' ? iso(row['accepted_at']) : null,
    reviewDate: strOrNull(row['review_date']), sessionId: str(row['session_id']), createdAt: iso(row['created_at']),
  }, row['source'] === 'user' ? 'human' : 'ai-generated', row['updated_at']);
}

async function readRisk(db: Pool, id: string, ctx: SemanticContext): Promise<SemanticAccess> {
  const { rows } = await db.query<Row>(
    `SELECT id::text AS id, project_id, title, detail, status, source_type, source_id, task_id, updated_at
       FROM project_register_items WHERE id::text = $1 AND kind = 'risk'`, [id]);
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  return record({ kind: 'risk', id }, ctx, str(row['title']), strOrNull(row['project_id']), {
    status: str(row['status']), detail: str(row['detail']).slice(0, EXCERPT_CHARS),
    linkedDecisionId: row['source_type'] === 'chat_decision' ? strOrNull(row['source_id']) : null, linkedTaskId: strOrNull(row['task_id']),
  }, 'human', row['updated_at']);
}

const clip = (text: string): { excerpt: string; truncated: boolean } =>
  ({ excerpt: text.slice(0, EXCERPT_CHARS), truncated: text.length > EXCERPT_CHARS });

async function readSource(db: Pool, rawId: string, ctx: SemanticContext): Promise<SemanticAccess> {
  const parsed = parseSourceRef({ kind: 'source', id: rawId });
  if (parsed === null) return { status: 'not_found' };
  const ref = sourceRef(parsed.type, parsed.id);
  if (parsed.type === 'note') {
    const { rows } = await db.query<Row>(`SELECT id::text AS id, content, status, revision, updated_at, created_at FROM notes WHERE id::text = $1`, [parsed.id]);
    const row = rows[0];
    if (row === undefined) return { status: 'not_found' };
    const content = str(row['content']);
    const title = parseNoteContent(content).title ?? 'Untitled note';
    return record(ref, ctx, title, null, {
      sourceType: 'note', state: row['status'] === 'archived' ? 'archived' : 'current', ...clip(await renderNoteAsText(db, content)),
      publishedAt: iso(row['created_at']), revision: Number(row['revision'] ?? 0),
    }, 'human', row['updated_at']);
  }
  if (parsed.type === 'content_item') {
    const { rows } = await db.query<Row>(
      `SELECT id::text AS id, source, title, summary, body, published_at, updated_at, project_context FROM content_items WHERE id::text = $1`, [parsed.id]);
    const row = rows[0];
    if (row === undefined) return { status: 'not_found' };
    const text = str(row['summary']) !== '' ? str(row['summary']) : str(row['body']);
    return record(ref, ctx, str(row['title']), null, {
      sourceType: 'content_item', state: 'current', contentSource: str(row['source']), ...clip(text), publishedAt: iso(row['published_at']),
    }, 'imported', row['updated_at']);
  }
  const { rows } = await db.query<Row>(`SELECT id::text AS id, title, updated_at, created_at, project_id FROM ai_chat_sessions WHERE id::text = $1`, [parsed.id]);
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  return record(ref, ctx, str(row['title']) || 'Chat', strOrNull(row['project_id']), {
    sourceType: 'chat', state: 'current', excerpt: '', truncated: false, publishedAt: iso(row['created_at']),
  }, 'human', row['updated_at']);
}

const DEFAULT_READERS: Record<SemanticKind, EntityReader> = {
  project: readProject, task: readTask, decision: readDecision, risk: readRisk, source: readSource,
};

/** Resolves a canonical ref to the current authoritative record. Excluded records are never read. */
export async function resolveEntity(db: Pool, ref: SemanticRef, ctx: SemanticContext, readers: SemanticReaders = {}): Promise<SemanticAccess> {
  if (isExcluded(ctx, ref)) return { status: 'excluded' };
  const reader = readers[ref.kind] ?? DEFAULT_READERS[ref.kind];
  try {
    return await reader(db, ref.id, ctx);
  } catch (err) {
    console.warn(`[semantic] ${ref.kind} read failed:`, err instanceof Error ? err.message : err);
    return { status: 'unavailable', code: 'reader_failed' };
  }
}

export type { SemanticRecord };
