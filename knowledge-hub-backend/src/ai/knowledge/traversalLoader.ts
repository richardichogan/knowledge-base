/**
 * DB-backed loaders for traverseRelationships over nodes/edges (read-only).
 * Inferred edge types stay labelled inferred; everything else is an explicit typed link.
 */
import type { Pool } from 'pg';
import type { EvidenceRef } from './evidence.js';
import { traverseRelationships, type RelatedEdge, type TargetResolution, type TraversalResult } from './traversal.js';

export const INFERRED_EDGE_TYPES: ReadonlySet<string> = new Set(['tag_overlap', 'thematically_related', 'produced_in_window', 'similar', 'similarity']);
/** Fetch slightly more than the per-expansion cap so truncation is detectable. */
const EDGE_FETCH_LIMIT = 41;
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** Types whose underlying record can be verified; others are accepted when the node exists. */
const VERIFIABLE_TYPES = ['note', 'task', 'document', 'discover_item', 'pull_request', 'issue', 'commit', 'github_item'];

interface EdgeRow { ref_id: string; ref_type: string; edge_type: string; confidence: string }

export function createEdgeLoader(db: Pool): (ref: EvidenceRef) => Promise<RelatedEdge[]> {
  return async (ref) => {
    const { rows } = await db.query<EdgeRow>(
      `WITH me AS (SELECT id FROM nodes WHERE ref_type = $1 AND ref_id = $2),
       links AS (
         SELECT e.target_node_id AS other, e.edge_type, e.confidence FROM edges e JOIN me ON e.source_node_id = me.id
         UNION ALL
         SELECT e.source_node_id, e.edge_type, e.confidence FROM edges e JOIN me ON e.target_node_id = me.id
       )
       SELECT n.ref_id, n.ref_type, l.edge_type, l.confidence::text
         FROM links l JOIN nodes n ON n.id = l.other
        WHERE n.id NOT IN (SELECT id FROM me)
        ORDER BY (l.edge_type = ANY($3::text[])) ASC, l.confidence DESC
        LIMIT ${EDGE_FETCH_LIMIT}`,
      [ref.kind, ref.id, [...INFERRED_EDGE_TYPES]],
    );
    return rows.map((r) => {
      const explicit = !INFERRED_EDGE_TYPES.has(r.edge_type);
      return {
        to: { kind: r.ref_type, id: r.ref_id }, relation: r.edge_type, explicit, confidence: Number(r.confidence),
        ...(!explicit && { provenance: 'graph-inference' }),
      };
    });
  };
}

interface TargetRow { title: string; project: string | null; present: boolean }

export function createTargetResolver(db: Pool, excluded: ReadonlySet<string>): (ref: EvidenceRef) => Promise<TargetResolution> {
  return async (ref) => {
    if (excluded.has(ref.id)) return { status: 'excluded' };
    const { rows } = await db.query<TargetRow>(
      `SELECT n.title,
              COALESCE(
                (SELECT ci.project_context FROM content_items ci WHERE ci.id = CASE WHEN n.ref_id ~* '${UUID}' THEN n.ref_id::uuid END),
                (SELECT cn.project_context FROM content_items cn WHERE n.ref_type = 'note' AND cn.source = 'note' AND cn.source_id = n.ref_id LIMIT 1),
                (SELECT t.project_id::text FROM tasks t WHERE n.ref_type = 'task' AND t.id::text = n.ref_id)
              ) AS project,
              (n.ref_type <> ALL($3::text[])
               OR EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = CASE WHEN n.ref_id ~* '${UUID}' THEN n.ref_id::uuid END)
               OR EXISTS (SELECT 1 FROM content_items cn WHERE n.ref_type = 'note' AND cn.source = 'note' AND cn.source_id = n.ref_id)
               OR EXISTS (SELECT 1 FROM tasks t WHERE n.ref_type = 'task' AND t.id::text = n.ref_id)) AS present
         FROM nodes n WHERE n.ref_type = $1 AND n.ref_id = $2`,
      [ref.kind, ref.id, VERIFIABLE_TYPES],
    );
    const row = rows[0];
    if (row === undefined) return { status: 'dangling' };
    if (!row.present) return { status: 'deleted' };
    return { status: 'ok', title: row.title, projectId: row.project };
  };
}

export interface TraversalToolTurn { sessionId?: string | undefined; excludedIds?: ReadonlySet<string> | undefined; signal?: AbortSignal | undefined }

/** Tool entry point: validates model arguments and returns labelled, unread targets. Never writes. */
export async function executeTraverseRelationships(db: Pool, args: Record<string, unknown>, turn: TraversalToolTurn): Promise<unknown> {
  const kind = typeof args['kind'] === 'string' ? args['kind'].trim() : '';
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (kind === '' || id === '') return { error: 'kind and id are required (use the type and refId from a search result).' };
  const excluded = turn.excludedIds ?? new Set<string>();
  if (excluded.has(id)) return { status: 'excluded' };
  const resolve = createTargetResolver(db, excluded);
  const start = { kind, id };
  const origin = await resolve(start);
  if (origin.status !== 'ok') return { status: origin.status === 'excluded' ? 'excluded' : 'not_found' };
  const result = await traverseRelationships({
    start, startProjectId: origin.projectId, loadEdges: createEdgeLoader(db), resolveTarget: resolve,
    ...(turn.signal !== undefined && { signal: turn.signal }),
  });
  return formatTraversal(result);
}

export function formatTraversal(r: TraversalResult): Record<string, unknown> {
  return {
    status: 'ok',
    start: r.start,
    results: r.steps.map((s) => ({
      id: s.ref.id, type: s.ref.kind, title: s.title, hop: s.hop, relation: s.relation, label: s.label,
      ...(s.confidence !== undefined && !s.explicit && { confidence: s.confidence }),
      project: s.projectId, crossProject: s.crossProject, via: s.path.slice(0, -1), read: false,
    })),
    visited: r.visited,
    rejectedCount: r.rejected.length,
    truncated: r.truncated,
    truncatedBy: r.truncatedBy,
    continuation: r.continuation,
    note: 'Targets are NOT read. Open each with read_knowledge_record before stating what it says. Only "explicit" links may be stated as relationships; "inferred" ones are suggestions and must be called inference.',
  };
}
