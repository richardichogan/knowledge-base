import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';

export interface AtlasNode {
  id: string; refId: string; refType: string; title: string; tags: string[];
  createdAt: string; updatedAt: string; conceptParent: string | null;
  projectIds: string[]; timestampBasis: 'source' | 'index';
}
export interface AtlasEdge {
  id: string; source: string; target: string; edgeType: string; confidence: number;
  metadata: Record<string, unknown> | null; createdAt: string | null;
  origin: 'explicit' | 'user_confirmed' | 'inferred';
}
export interface AtlasQuery { days: number; depth: number; seed: string | null; nodeTypes: string[]; edgeTypes: string[] }
const NODE_CAP = 500;
const EDGE_CAP = 2500;
const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 365;
const MAX_DAYS = 3650;
const MAX_DEPTH = 2;
const MAX_SEED_LENGTH = 250;
const MAX_TYPE_LIST_LENGTH = 500;

export function parseAtlasQuery(query: Record<string, unknown>): AtlasQuery {
  function integer(key: string, fallback: number, max: number): number {
    const value = query[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
      throw new ValidationError(`${key} must be an integer between 1 and ${max}`);
    }
    return Number(value);
  }
  function types(key: string): string[] {
    const value = query[key];
    if (value === undefined) return [];
    if (typeof value !== 'string' || value.length > MAX_TYPE_LIST_LENGTH || !/^[a-z_,]+$/.test(value)) throw new ValidationError(`Invalid ${key}`);
    return value.split(',').filter(Boolean);
  }
  const seed = query['seed'];
  if (seed !== undefined && (typeof seed !== 'string' || seed.length > MAX_SEED_LENGTH || !/^[\w:.-]+$/.test(seed))) {
    throw new ValidationError('Invalid graph starting point');
  }
  return { days: integer('days', DEFAULT_DAYS, MAX_DAYS), depth: integer('depth', 1, MAX_DEPTH), seed: seed ?? null,
    nodeTypes: types('node_types'), edgeTypes: types('edge_types') };
}

// Read-through projections: domain relationships stay authoritative, not copied into another graph store.
const PROJECTION = `
WITH RECURSIVE live AS (
  SELECT 'project:'||id AS id, id AS ref_id, 'project'::text AS ref_type, name AS title,
    ARRAY[]::text[] AS tags, created_at, updated_at, ARRAY[id] AS project_ids FROM projects
  UNION ALL SELECT 'company:'||id, id::text, 'company', name, '{}', created_at, updated_at,
    ARRAY(SELECT project_id FROM company_projects WHERE company_id=c.id
      UNION SELECT project_id FROM person_project_roles WHERE company_id=c.id) FROM companies c
  UNION ALL SELECT 'person:'||id, id::text, 'person', name, '{}', created_at, updated_at,
    ARRAY(SELECT project_id FROM person_project_roles WHERE person_id=p.id) FROM people p
  UNION ALL SELECT 'note:'||id, id::text, 'note', COALESCE(NULLIF(note_list_metadata(content)->>'title',''),'Untitled note'),
    tags, created_at, updated_at, array_remove(ARRAY[project_id],NULL) FROM notes WHERE status='active'
  UNION ALL SELECT 'task:'||id, id::text, 'task', title, '{}', created_at, updated_at,
    array_remove(ARRAY[project_id],NULL) FROM tasks WHERE NOT archived
  UNION ALL SELECT 'decision:'||d.id, d.id::text, 'decision', d.text, '{}', d.created_at, d.updated_at,
    array_remove(ARRAY[s.project_id],NULL) FROM chat_decisions d JOIN ai_chat_sessions s ON s.id=d.session_id
  UNION ALL SELECT 'chat:'||id,id::text,'chat',COALESCE(title,'Conversation'),'{}',started_at,updated_at,
    array_remove(ARRAY[project_id],NULL) FROM ai_chat_sessions
  UNION ALL SELECT 'risk:'||id, id::text, 'risk', title, '{}', created_at, updated_at,
    array_remove(ARRAY[project_id],NULL) FROM project_register_items WHERE kind='risk'
),
all_nodes AS MATERIALIZED (
  SELECT *, 'source'::text AS timestamp_basis FROM live
  UNION ALL
  SELECT n.ref_type||':'||n.ref_id, n.ref_id, n.ref_type, n.title, n.tags, n.created_at, n.updated_at,
    '{}'::text[], 'index' FROM nodes n
    WHERE n.ref_type NOT IN ('project','company','person','note','task','decision','risk','chat')
),
raw_edges AS (
  SELECT e.id::text AS id, s.ref_type||':'||s.ref_id AS source, t.ref_type||':'||t.ref_id AS target,
    e.edge_type, e.confidence, e.metadata, e.created_at,
    CASE WHEN e.edge_type='thematically_related' THEN 'inferred' ELSE 'explicit' END AS origin
    FROM edges e JOIN nodes s ON s.id=e.source_node_id JOIN nodes t ON t.id=e.target_node_id
  UNION ALL SELECT 'project-link:'||n.id||':'||p, n.id, 'project:'||p, 'belongs_to', 1,
    jsonb_build_object('evidence','Saved project assignment'), NULL::timestamptz, 'explicit'
    FROM live n CROSS JOIN LATERAL unnest(n.project_ids) p WHERE n.ref_type NOT IN ('project','person','company')
  UNION ALL SELECT 'company-project:'||company_id||':'||project_id, 'company:'||company_id, 'project:'||project_id,
    'works_on',1,jsonb_build_object('evidence','Saved company programme link'),NULL,'explicit' FROM company_projects
  UNION ALL SELECT 'person-company:'||id, 'person:'||id,'company:'||company_id,'member_of',1,
    jsonb_build_object('evidence','Saved person company link'),NULL,'explicit' FROM people WHERE company_id IS NOT NULL
  UNION ALL SELECT 'role:'||person_id||':'||project_id,'person:'||person_id,'project:'||project_id,'works_on',1,
    jsonb_build_object('evidence','Saved programme role','role',role,'companyId',company_id),NULL,'explicit' FROM person_project_roles
  UNION ALL SELECT 'represents:'||person_id||':'||project_id,'person:'||person_id,'company:'||company_id,'represents',1,
    jsonb_build_object('evidence','Saved programme role','role',role,'projectId',project_id),NULL,'explicit'
    FROM person_project_roles WHERE company_id IS NOT NULL
  UNION ALL SELECT 'mention:'||source_note_id||':'||target_type||':'||target_id,
    'note:'||source_note_id,target_type||':'||target_id,'mentions',1,
    jsonb_build_object('evidence','Explicit entity mention in note'),NULL,'explicit' FROM note_entity_links
  UNION ALL SELECT 'note-link:'||source_note_id||':'||target_note_id,'note:'||source_note_id,'note:'||target_note_id,
    'references',1,jsonb_build_object('evidence','Explicit note link'),NULL,'explicit' FROM note_links
  UNION ALL SELECT 'recorded-in:'||id,'decision:'||id,'chat:'||session_id,'recorded_in',1,
    jsonb_build_object('evidence','Conversation where the decision was recorded'),created_at,'explicit' FROM chat_decisions
  UNION ALL SELECT 'risk-task:'||id,'risk:'||id,'task:'||task_id,'affects',1,
    jsonb_build_object('evidence','Saved risk task link'),NULL,'explicit' FROM project_register_items WHERE kind='risk' AND task_id IS NOT NULL
  UNION ALL SELECT 'risk-decision:'||id,'risk:'||id,'decision:'||source_id,'affects',1,
    jsonb_build_object('evidence','Saved risk decision link'),NULL,'explicit' FROM project_register_items WHERE kind='risk' AND source_type='chat_decision'
  UNION ALL SELECT 'semantic:'||id,
    CASE WHEN from_kind='source' THEN COALESCE((SELECT id FROM all_nodes
      WHERE ref_id=substring(from_id FROM 14) AND from_id LIKE 'content_item:%' ORDER BY id LIMIT 1),from_id) ELSE from_kind||':'||from_id END,
    CASE WHEN to_kind='source' THEN COALESCE((SELECT id FROM all_nodes
      WHERE ref_id=substring(to_id FROM 14) AND to_id LIKE 'content_item:%' ORDER BY id LIMIT 1),to_id) ELSE to_kind||':'||to_id END,
    relationship, CASE WHEN origin='inferred' THEN 0.5 ELSE 1 END,
    jsonb_build_object('evidence','Recorded semantic relationship','note',note,'effectiveAt',effective_at),
    created_at,origin FROM semantic_edges
),
all_edges AS MATERIALIZED (
  SELECT e.* FROM raw_edges e JOIN all_nodes s ON s.id=e.source JOIN all_nodes t ON t.id=e.target
  WHERE e.source<>e.target
),
root AS (
  SELECT id FROM all_nodes WHERE id=$1
  UNION SELECT ref_type||':'||ref_id FROM nodes WHERE id::text=$1
),
walk(id,depth) AS (
  SELECT id,0 FROM root
  UNION
  SELECT CASE WHEN e.source=w.id THEN e.target ELSE e.source END,w.depth+1
    FROM walk w JOIN all_edges e ON e.source=w.id OR e.target=w.id
    WHERE w.depth<$2 AND (cardinality($5::text[])=0 OR e.edge_type=ANY($5))
),
candidates AS (
  SELECT n.* FROM all_nodes n
  WHERE ($1::text IS NULL AND n.updated_at >= $3::timestamptz OR $1 IS NOT NULL AND n.id IN (SELECT id FROM walk))
    AND (cardinality($4::text[])=0 OR n.ref_type=ANY($4))
),
ranked AS (
  SELECT *,row_number() OVER (PARTITION BY ref_type ORDER BY updated_at DESC,id) AS type_rank FROM candidates
),
chosen AS (
  SELECT * FROM ranked ORDER BY (id IN (SELECT id FROM root)) DESC,
    ($1::text IS NULL AND type_rank<=20) DESC, (ref_type='project') DESC, updated_at DESC,id
  LIMIT ${NODE_CAP}
),
chosen_edges AS (
  SELECT e.* FROM all_edges e JOIN chosen s ON s.id=e.source JOIN chosen t ON t.id=e.target
    WHERE cardinality($5::text[])=0 OR e.edge_type=ANY($5)
),
bounded_edges AS (SELECT * FROM chosen_edges ORDER BY (origin<>'inferred') DESC,id LIMIT ${EDGE_CAP})
`;

export async function readGraphAtlas(db: Pool, query: AtlasQuery, now = new Date()): Promise<{
  nodes: AtlasNode[]; edges: AtlasEdge[]; rootId: string | null;
  stats: { totalNodes: number; totalEdges: number; filteredNodes: number; filteredEdges: number; truncated: boolean };
}> {
  const result = await db.query<{ nodes: AtlasNode[]; edges: AtlasEdge[]; root_id: string | null; total_nodes: number; total_edges: number; matched_nodes: number; matched_edges: number }>(
    `${PROJECTION}
    SELECT (SELECT id FROM root ORDER BY id LIMIT 1) AS root_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'refId',ref_id,'refType',ref_type,'title',LEFT(title,240),
        'tags',tags,'createdAt',created_at,'updatedAt',updated_at,'projectIds',project_ids,
        'timestampBasis',timestamp_basis,'conceptParent',(
          SELECT p.name FROM tags t JOIN tags p ON p.id=t.parent_id
          WHERE t.name=ANY(chosen.tags) AND t.role='concept' ORDER BY p.name LIMIT 1
        ))) FROM chosen),'[]') AS nodes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'source',source,'target',target,'edgeType',edge_type,
        'confidence',confidence,'metadata',metadata,'createdAt',created_at,'origin',origin)) FROM bounded_edges),'[]') AS edges,
      (SELECT count(*)::int FROM all_nodes) AS total_nodes,(SELECT count(*)::int FROM all_edges) AS total_edges,
      (SELECT count(*)::int FROM candidates) AS matched_nodes,(SELECT count(*)::int FROM chosen_edges) AS matched_edges`,
    [query.seed, query.depth, new Date(now.getTime() - query.days * DAY_MS).toISOString(), query.nodeTypes, query.edgeTypes],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Graph query returned no result');
  return { nodes: row.nodes, edges: row.edges, rootId: row.root_id, stats: { totalNodes: row.total_nodes, totalEdges: row.total_edges,
    filteredNodes: row.nodes.length, filteredEdges: row.edges.length,
    truncated: row.matched_nodes > NODE_CAP || row.matched_edges > EDGE_CAP } };
}
