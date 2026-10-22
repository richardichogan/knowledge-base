/**
 * Typed relationships. Existing links are mapped, not copied:
 *   belongs_to  <- ai_chat_sessions.project_id | tasks.project_id | project_register_items.project_id
 *   recorded_in <- chat_decisions.session_id
 *   affects     <- project_register_items.source_id (chat_decision) / task_id
 * Only implements, supersedes and supported_by need `semantic_edges` (migration 090).
 */
import type { Pool } from 'pg';
import { refKey, resolveEntity, sourceRef, type SemanticReaders } from './bindings.js';
import { RELATIONSHIP_DEFINITIONS, validateEdgeShape, type EdgeValidation } from './definitions.js';
import type { EdgeOrigin, RelationshipName, SemanticContext, SemanticEdge, SemanticKind, SemanticRef } from './types.js';

const MAX_EDGES = 500;
const MAX_CHAIN_NODES = 100;

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const asIso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null);

export interface InvalidEdge { edge: SemanticEdge; code: string; reason: string }
export interface EdgeSet { edges: SemanticEdge[]; invalid: InvalidEdge[] }

function toEdge(row: Row): SemanticEdge {
  return {
    relationship: str(row['relationship']) as RelationshipName,
    from: { kind: str(row['from_kind']) as SemanticKind, id: str(row['from_id']) },
    to: { kind: str(row['to_kind']) as SemanticKind, id: str(row['to_id']) },
    origin: str(row['origin']) as EdgeOrigin, effectiveAt: asIso(row['effective_at']), storage: 'semantic_edges',
  };
}

async function storedEdges(db: Pool, ref: SemanticRef, relationship?: RelationshipName): Promise<SemanticEdge[]> {
  const { rows } = await db.query<Row>(
    `SELECT relationship, from_kind, from_id, to_kind, to_id, origin, effective_at FROM semantic_edges
      WHERE ((from_kind = $1 AND from_id = $2) OR (to_kind = $1 AND to_id = $2)) AND ($3::text IS NULL OR relationship = $3)
      ORDER BY created_at LIMIT ${MAX_EDGES}`, [ref.kind, ref.id, relationship ?? null]);
  return rows.map(toEdge);
}

/** Edges mapped from existing storage where ref is an endpoint. Origin is `explicit`: each is a saved user/register link. */
async function mappedEdges(db: Pool, ref: SemanticRef): Promise<SemanticEdge[]> {
  const out: SemanticEdge[] = [];
  const mapped = (relationship: RelationshipName, from: SemanticRef, to: SemanticRef, storage: string): void => {
    out.push({ relationship, from, to, origin: 'explicit', effectiveAt: null, storage });
  };
  if (ref.kind === 'decision') {
    const { rows } = await db.query<Row>(
      `SELECT d.session_id::text AS session_id, s.project_id FROM chat_decisions d LEFT JOIN ai_chat_sessions s ON s.id = d.session_id WHERE d.id::text = $1`, [ref.id]);
    const row = rows[0];
    if (row !== undefined) {
      if (str(row['project_id']) !== '') mapped('belongs_to', ref, { kind: 'project', id: str(row['project_id']) }, 'ai_chat_sessions.project_id');
      mapped('recorded_in', ref, sourceRef('chat', str(row['session_id'])), 'chat_decisions.session_id');
    }
    const risks = await db.query<Row>(`SELECT id::text AS id FROM project_register_items WHERE kind = 'risk' AND source_type = 'chat_decision' AND source_id = $1 LIMIT ${MAX_EDGES}`, [ref.id]);
    for (const risk of risks.rows) mapped('affects', { kind: 'risk', id: str(risk['id']) }, ref, 'project_register_items.source_id');
  } else if (ref.kind === 'task') {
    const { rows } = await db.query<Row>(`SELECT project_id FROM tasks WHERE id = $1`, [ref.id]);
    if (str(rows[0]?.['project_id']) !== '') mapped('belongs_to', ref, { kind: 'project', id: str(rows[0]?.['project_id']) }, 'tasks.project_id');
    const risks = await db.query<Row>(`SELECT id::text AS id FROM project_register_items WHERE kind = 'risk' AND task_id = $1 LIMIT ${MAX_EDGES}`, [ref.id]);
    for (const risk of risks.rows) mapped('affects', { kind: 'risk', id: str(risk['id']) }, ref, 'project_register_items.task_id');
  } else if (ref.kind === 'risk') {
    const { rows } = await db.query<Row>(`SELECT project_id, source_type, source_id, task_id FROM project_register_items WHERE id::text = $1 AND kind = 'risk'`, [ref.id]);
    const row = rows[0];
    if (row !== undefined) {
      if (str(row['project_id']) !== '') mapped('belongs_to', ref, { kind: 'project', id: str(row['project_id']) }, 'project_register_items.project_id');
      if (row['source_type'] === 'chat_decision' && str(row['source_id']) !== '') mapped('affects', ref, { kind: 'decision', id: str(row['source_id']) }, 'project_register_items.source_id');
      if (str(row['task_id']) !== '') mapped('affects', ref, { kind: 'task', id: str(row['task_id']) }, 'project_register_items.task_id');
    }
  }
  return out;
}

/** All typed edges touching a ref, with invalid stored rows reported rather than silently trusted. */
export async function listEdges(db: Pool, ref: SemanticRef): Promise<EdgeSet> {
  const [stored, mapped] = await Promise.all([storedEdges(db, ref), mappedEdges(db, ref)]);
  const edges: SemanticEdge[] = [];
  const invalid: InvalidEdge[] = [];
  for (const edge of [...stored, ...mapped]) {
    const check = validateEdgeShape(edge);
    if (check.ok) edges.push(edge); else invalid.push({ edge, code: check.code, reason: check.reason });
  }
  return { edges, invalid };
}

/** Edges that may satisfy a rule requiring this relationship: explicit or user confirmed only. */
export function satisfyingEdges(edges: SemanticEdge[], relationship: RelationshipName): SemanticEdge[] {
  return edges.filter((edge) => edge.relationship === relationship && RELATIONSHIP_DEFINITIONS[relationship].satisfyingOrigins.includes(edge.origin));
}

export function inferredEdges(edges: SemanticEdge[], relationship: RelationshipName): SemanticEdge[] {
  return edges.filter((edge) => edge.relationship === relationship && edge.origin === 'inferred');
}

export type SupersessionState =
  | { state: 'current'; pending: Array<{ by: SemanticRef; effectiveAt: string }>; unconfirmed: Array<{ by: SemanticRef; reason: string }> }
  | { state: 'superseded'; by: SemanticRef; effectiveAt: string; allSuccessors: SemanticRef[] }
  | { state: 'invalid'; code: 'self_supersession' | 'cycle' | 'traversal_limit'; refs: SemanticRef[] }
  | { state: 'unknown'; code: string };

/** The connected supersession component around a decision, bounded. */
async function supersessionComponent(db: Pool, start: SemanticRef): Promise<{ edges: SemanticEdge[]; truncated: boolean }> {
  const seen = new Set<string>([refKey(start)]);
  const queue: SemanticRef[] = [start];
  const edges = new Map<string, SemanticEdge>();
  while (queue.length > 0) {
    const node = queue.shift() as SemanticRef;
    for (const edge of await storedEdges(db, node, 'supersedes')) {
      const key = `${refKey(edge.from)}>${refKey(edge.to)}`;
      edges.set(key, edge);
      for (const next of [edge.from, edge.to]) {
        if (seen.has(refKey(next))) continue;
        if (seen.size >= MAX_CHAIN_NODES) return { edges: [...edges.values()], truncated: true };
        seen.add(refKey(next));
        queue.push(next);
      }
    }
  }
  return { edges: [...edges.values()], truncated: false };
}

function findCycle(edges: SemanticEdge[]): SemanticRef[] | null {
  const next = new Map<string, SemanticEdge[]>();
  for (const edge of edges) next.set(refKey(edge.from), [...(next.get(refKey(edge.from)) ?? []), edge]);
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (ref: SemanticRef): SemanticRef[] | null => {
    const key = refKey(ref);
    if (onPath.has(key)) return [ref];
    if (done.has(key)) return null;
    onPath.add(key);
    for (const edge of next.get(key) ?? []) {
      const cycle = visit(edge.to);
      if (cycle !== null) return [ref, ...cycle];
    }
    onPath.delete(key);
    done.add(key);
    return null;
  };
  for (const edge of edges) {
    const cycle = visit(edge.from);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * Whether a decision is current at `ctx.now`. A replacement only counts when it was recorded by the user, is
 * effective, and is itself an accepted decision; anything else is reported, never applied. A cycle or self-edge
 * yields an invalid state rather than an arbitrary "current" decision.
 */
export async function resolveSupersession(db: Pool, decision: SemanticRef, ctx: SemanticContext, readers: SemanticReaders = {}): Promise<SupersessionState> {
  let component: { edges: SemanticEdge[]; truncated: boolean };
  try {
    component = await supersessionComponent(db, decision);
  } catch {
    return { state: 'unknown', code: 'edge_reader_failed' };
  }
  const selfEdge = component.edges.find((edge) => refKey(edge.from) === refKey(edge.to));
  if (selfEdge !== undefined) return { state: 'invalid', code: 'self_supersession', refs: [selfEdge.from] };
  const cycle = findCycle(component.edges);
  if (cycle !== null) return { state: 'invalid', code: 'cycle', refs: cycle };
  if (component.truncated) return { state: 'invalid', code: 'traversal_limit', refs: [decision] };

  const now = ctx.now.getTime();
  const pending: Array<{ by: SemanticRef; effectiveAt: string }> = [];
  const unconfirmed: Array<{ by: SemanticRef; reason: string }> = [];
  const active: Array<{ by: SemanticRef; effectiveAt: string }> = [];
  for (const edge of component.edges.filter((e) => refKey(e.to) === refKey(decision))) {
    if (edge.origin === 'inferred' || edge.effectiveAt === null) { unconfirmed.push({ by: edge.from, reason: 'not_recorded_by_user' }); continue; }
    if (Date.parse(edge.effectiveAt) > now) { pending.push({ by: edge.from, effectiveAt: edge.effectiveAt }); continue; }
    const successor = await resolveEntity(db, edge.from, ctx, readers);
    if (successor.status === 'excluded' || successor.status === 'unavailable') return { state: 'unknown', code: 'successor_unavailable' };
    if (successor.status === 'not_found' || successor.data.fields['acceptance'] !== 'accepted') {
      unconfirmed.push({ by: edge.from, reason: successor.status === 'not_found' ? 'successor_missing' : 'successor_not_accepted' });
      continue;
    }
    active.push({ by: edge.from, effectiveAt: edge.effectiveAt });
  }
  if (active.length === 0) return { state: 'current', pending, unconfirmed };
  active.sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt));
  const latest = active[0] as { by: SemanticRef; effectiveAt: string };
  return { state: 'superseded', by: latest.by, effectiveAt: latest.effectiveAt, allSuccessors: active.map((a) => a.by) };
}

/**
 * Validates and stores a user-recorded edge (implements, supersedes, supported_by). Rejects wrong endpoint types,
 * dangling or excluded endpoints and supersession cycles. Not exposed to the chat model.
 */
export async function recordEdge(db: Pool, edge: Omit<SemanticEdge, 'storage'>, ctx: SemanticContext, readers: SemanticReaders = {}): Promise<EdgeValidation> {
  const shape = validateEdgeShape(edge);
  if (!shape.ok) return shape;
  if (RELATIONSHIP_DEFINITIONS[edge.relationship].storage !== 'semantic_edges') {
    return { ok: false, code: 'mapped_relationship', reason: `${edge.relationship} is read from existing records, not stored separately.` };
  }
  for (const end of [edge.from, edge.to]) {
    const access = await resolveEntity(db, end, ctx, readers);
    if (access.status !== 'ok') return { ok: false, code: access.status === 'not_found' ? 'dangling' : access.status, reason: `${end.kind} ${end.id} is not available.` };
  }
  if (edge.relationship === 'supersedes') {
    const component = await supersessionComponent(db, edge.to);
    const cycle = findCycle([...component.edges, { ...edge, storage: 'semantic_edges' }]);
    if (cycle !== null) return { ok: false, code: 'cycle', reason: 'This supersession would create a cycle.' };
  }
  await db.query(
    `INSERT INTO semantic_edges (relationship, from_kind, from_id, to_kind, to_id, origin, effective_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (relationship, from_kind, from_id, to_kind, to_id) DO UPDATE SET origin = EXCLUDED.origin, effective_at = COALESCE(EXCLUDED.effective_at, semantic_edges.effective_at)
       WHERE semantic_edges.origin = 'inferred' AND EXCLUDED.origin <> 'inferred'`,
    [edge.relationship, edge.from.kind, edge.from.id, edge.to.kind, edge.to.id, edge.origin, edge.effectiveAt]);
  return { ok: true };
}
