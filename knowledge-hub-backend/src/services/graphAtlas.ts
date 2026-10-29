import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import { canonicalContentSql } from '../db/contentVisibility.js';

export interface AtlasNode {
  id: string; refId: string; refType: string; title: string; tags: string[];
  createdAt: string; updatedAt: string; conceptParent: string | null;
  projectIds: string[]; timestampBasis: 'source' | 'index';
  url?: string | null;
}
export interface AtlasEdge {
  id: string; source: string; target: string; edgeType: string; confidence: number;
  metadata: Record<string, unknown> | null; createdAt: string | null;
  origin: 'explicit' | 'user_confirmed' | 'inferred';
}
export interface AtlasQuery { days: number; depth: number; seed: string | null; nodeTypes: string[]; edgeTypes: string[]; includeInferred: boolean }
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
  const includeInferred = query['include_inferred'];
  if (includeInferred !== undefined && includeInferred !== 'true' && includeInferred !== 'false') {
    throw new ValidationError('include_inferred must be true or false');
  }
  if (seed !== undefined && (typeof seed !== 'string' || seed.length > MAX_SEED_LENGTH || !/^[\w:.-]+$/.test(seed))) {
    throw new ValidationError('Invalid graph starting point');
  }
  return { days: integer('days', DEFAULT_DAYS, MAX_DAYS), depth: integer('depth', 1, MAX_DEPTH), seed: seed ?? null,
    nodeTypes: types('node_types'), edgeTypes: types('edge_types'), includeInferred: includeInferred !== 'false' };
}

// Read-through projections: domain relationships stay authoritative, not copied into another graph store.
const PROJECTION = `
WITH RECURSIVE content_records AS MATERIALIZED (
  SELECT c.*, CASE
    WHEN source='discovered-article' THEN 'discover_item'
    WHEN source IN ('github-doc','github-content-store','user-upload','onedrive-document','ica-document') THEN 'document'
    WHEN source IN ('github-commit','gitlab-commit') THEN 'commit'
    WHEN source IN ('github-pr','gitlab-mr') THEN 'pull_request'
    WHEN source IN ('github-issue','gitlab-issue') THEN 'issue'
    WHEN source IN ('cms-blog','cms-newsletter') THEN 'blog_post'
    WHEN source='cms-podcast-show-notes' THEN 'podcast_episode'
    WHEN source='graph-calendar' THEN 'meeting'
    WHEN source='email' THEN 'email'
    WHEN source LIKE 'github-%' OR source LIKE 'gitlab-%' THEN 'github_item'
    ELSE 'content_item' END AS ref_type
  FROM content_items c WHERE source NOT IN ('note','task') AND ${canonicalContentSql('c')}
),
live AS (
  SELECT 'project:'||id AS id, id AS ref_id, 'project'::text AS ref_type, name AS title,
    ARRAY[]::text[] AS tags, created_at, updated_at, ARRAY[id] AS project_ids FROM projects
  UNION ALL SELECT 'company:'||id, id::text, 'company', name, '{}', created_at, updated_at,
    ARRAY(SELECT project_id FROM company_projects WHERE company_id=c.id
      UNION SELECT project_id FROM person_project_roles WHERE company_id=c.id) FROM companies c
  UNION ALL SELECT 'person:'||id, id::text, 'person', name, '{}', created_at, updated_at,
    ARRAY(SELECT project_id FROM person_project_roles WHERE person_id=p.id) FROM people p
  UNION ALL SELECT 'note:'||id, id::text, 'note', COALESCE(NULLIF(note_list_metadata(content)->>'title',''),'Untitled note'),
    ARRAY(SELECT DISTINCT name FROM (
      SELECT unnest(n.tags) AS name
      UNION ALL SELECT t.name FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=n.id
    ) names ORDER BY name), created_at, updated_at, array_remove(ARRAY[project_id],NULL) FROM notes n WHERE status='active'
  UNION ALL SELECT 'tag:'||t.id, t.id::text, 'tag', t.name, ARRAY[t.name], t.created_at,t.updated_at,'{}'::text[] FROM tags t
  UNION ALL SELECT 'spark:'||id,id::text,'spark',LEFT(body,240),tags,created_at,created_at,'{}'::text[] FROM sparks
  UNION ALL SELECT 'spark_theme:'||id,id::text,'spark_theme',theme,'{}',created_at,updated_at,'{}'::text[] FROM spark_clusters
  UNION ALL SELECT 'canvas:'||id,id::text,'canvas',title,'{}',created_at,updated_at,
    array_remove(ARRAY[project],NULL) FROM canvases WHERE deleted_at IS NULL
  UNION ALL SELECT 'usecase:'||id,id::text,'usecase',title,'{}',created_at,updated_at,
    array_remove(ARRAY[project_id],NULL) FROM use_cases WHERE stage<>'dropped'
  UNION ALL SELECT 'cfp_item:'||id,id::text,'cfp_item',conference_name,tags,discovered_at,discovered_at,'{}'::text[] FROM cfp_items
  UNION ALL SELECT c.ref_type||':'||c.id,c.id::text,c.ref_type,c.title,c.tags,c.published_at,c.updated_at,
    ARRAY(SELECT id FROM projects WHERE id=c.project_context) FROM content_records c
  UNION ALL SELECT 'task:'||id, id::text, 'task', title, '{}', created_at, updated_at,
    array_remove(ARRAY[project_id],NULL) FROM tasks WHERE NOT archived
  UNION ALL SELECT 'decision:'||d.id, d.id::text, 'decision', d.text, '{}', d.created_at, d.updated_at,
    array_remove(ARRAY[s.project_id],NULL) FROM chat_decisions d JOIN ai_chat_sessions s ON s.id=d.session_id
  UNION ALL SELECT 'chat:'||id,id::text,'chat',COALESCE(title,'Conversation'),'{}',started_at,updated_at,
    array_remove(ARRAY[project_id],NULL) FROM ai_chat_sessions
  UNION ALL SELECT (CASE kind WHEN 'issue' THEN 'register_issue' ELSE kind END)||':'||id,
    id::text,CASE kind WHEN 'issue' THEN 'register_issue' ELSE kind END,title,'{}',created_at,updated_at,
    array_remove(ARRAY[project_id],NULL) FROM project_register_items
  UNION ALL SELECT 'chat_output:'||o.id,o.id::text,'chat_output',o.title,'{}',o.created_at,o.updated_at,
    array_remove(ARRAY[s.project_id],NULL) FROM chat_outputs o JOIN ai_chat_sessions s ON s.id=o.session_id
  UNION ALL SELECT 'build_spec:'||id,id::text,'build_spec',title,'{}',created_at,updated_at,
    array_remove(ARRAY[project_id],NULL) FROM build_specs
),
all_nodes AS MATERIALIZED (
  SELECT *, 'source'::text AS timestamp_basis FROM live
),
alias_candidates AS (
  SELECT id AS alias,id FROM all_nodes
  UNION SELECT 'diagram:'||ref_id,id FROM all_nodes WHERE ref_type='canvas'
  UNION SELECT 'use_case:'||ref_id,id FROM all_nodes WHERE ref_type='usecase'
  UNION SELECT 'chat_decision:'||ref_id,id FROM all_nodes WHERE ref_type='decision'
  UNION SELECT 'ai_session:'||ref_id,id FROM all_nodes WHERE ref_type='chat'
  UNION SELECT 'spark:'||ref_id,id FROM all_nodes WHERE ref_type='spark_theme'
  UNION SELECT 'source:'||id,id FROM all_nodes WHERE ref_type IN ('note','chat')
  UNION SELECT 'content_item:'||id,ref_type||':'||id FROM content_records
  UNION SELECT 'source:content_item:'||id,ref_type||':'||id FROM content_records
  UNION SELECT 'article:'||id,'discover_item:'||id FROM content_records WHERE ref_type='discover_item'
  UNION SELECT 'discover:'||id,'discover_item:'||id FROM content_records WHERE ref_type='discover_item'
  UNION SELECT 'document:'||(metadata->>'repo')||'::'||(metadata->>'path'),ref_type||':'||id FROM content_records
    WHERE ref_type='document' AND metadata->>'repo' IS NOT NULL AND metadata->>'path' IS NOT NULL
  UNION SELECT 'document:'||CASE source WHEN 'user-upload' THEN 'kb-uploads' ELSE 'onedrive' END||'::'||id,
    ref_type||':'||id FROM content_records WHERE source IN ('user-upload','onedrive-document')
  UNION SELECT 'design:'||d.id,'note:'||d.parent_note_id FROM designs d JOIN all_nodes n ON n.id='note:'||d.parent_note_id
  UNION SELECT 'url:'||url,ref_type||':'||id FROM content_records WHERE url ~ '^https?://'
  UNION SELECT 'content_item:'||c.id,c.source||':'||c.source_id FROM content_items c
    JOIN all_nodes n ON n.id=c.source||':'||c.source_id WHERE c.source IN ('note','task')
  UNION SELECT 'source:content_item:'||c.id,c.source||':'||c.source_id FROM content_items c
    JOIN all_nodes n ON n.id=c.source||':'||c.source_id WHERE c.source IN ('note','task')
  UNION SELECT 'content_item:'||c.id,'note:'||p.note_id FROM content_items c
    JOIN note_github_publications p ON lower(p.repo)=lower(c.metadata->>'repo') AND p.path=c.metadata->>'path'
    JOIN all_nodes n ON n.id='note:'||p.note_id WHERE c.source IN ('github-doc','github-content-store')
  UNION SELECT 'source:content_item:'||c.id,'note:'||p.note_id FROM content_items c
    JOIN note_github_publications p ON lower(p.repo)=lower(c.metadata->>'repo') AND p.path=c.metadata->>'path'
    JOIN all_nodes n ON n.id='note:'||p.note_id WHERE c.source IN ('github-doc','github-content-store')
  UNION SELECT 'document:'||c.id,'note:'||p.note_id FROM content_items c
    JOIN note_github_publications p ON lower(p.repo)=lower(c.metadata->>'repo') AND p.path=c.metadata->>'path'
    JOIN all_nodes n ON n.id='note:'||p.note_id WHERE c.source IN ('github-doc','github-content-store')
  UNION SELECT 'document:'||p.repo||'::'||p.path,'note:'||p.note_id FROM note_github_publications p
    JOIN all_nodes n ON n.id='note:'||p.note_id
),
aliases AS MATERIALIZED (
  SELECT DISTINCT ON (alias) alias,id FROM (
    SELECT alias,id,MIN(id) OVER (PARTITION BY alias) AS first_id,MAX(id) OVER (PARTITION BY alias) AS last_id
    FROM alias_candidates
  ) unique_aliases WHERE first_id=last_id ORDER BY alias,id
),
indexed_refs AS MATERIALIZED (
  SELECT n.id,a.id AS target FROM nodes n LEFT JOIN content_items c ON c.id::text=n.ref_id
    JOIN aliases a ON a.alias=CASE WHEN c.id IS NOT NULL THEN 'content_item:'||c.id ELSE n.ref_type||':'||n.ref_id END
),
tag_memberships AS MATERIALIZED (
  SELECT a.id AS source,m.tag_id,m.assignment FROM (
    SELECT 'note:'||note_id AS ref,tag_id,source AS assignment FROM note_tags
    UNION ALL SELECT 'discover_item:'||discover_item_id,tag_id,source FROM discover_item_tags
    UNION ALL SELECT 'task:'||task_id,tag_id,source FROM task_tags
    UNION ALL SELECT 'document:'||doc_id,tag_id,'saved' FROM document_tags
    UNION ALL SELECT 'content_item:'||content_item_id,tag_id,'saved' FROM content_item_tags
    UNION ALL SELECT 'cfp_item:'||cfp_item_id,tag_id,'saved' FROM cfp_item_tags
    UNION ALL SELECT 'task:'||id,linked_tag_id,'saved' FROM tasks WHERE linked_tag_id IS NOT NULL
  ) m JOIN aliases a ON a.alias=m.ref
),
design_candidates AS (
  SELECT d.id AS design_id,d.parent_note_id,'note' AS source_type,d.source_note_id::text AS source_id,NULL::text AS role FROM designs d
  UNION SELECT d.id,d.parent_note_id,'usecase',d.source_use_case_id::text,'use_case' FROM designs d
  UNION SELECT d.id,d.parent_note_id,'note',u.spec_note_id::text,'spec' FROM designs d JOIN use_cases u ON u.id=d.source_use_case_id
  UNION SELECT d.id,d.parent_note_id,'link',l.url,'reference' FROM designs d JOIN use_case_links l ON l.use_case_id=d.source_use_case_id
  UNION SELECT d.id,d.parent_note_id,s.source_type,s.source_id,
    CASE s.source_type WHEN 'canvas' THEN 'diagram' ELSE NULL END
    FROM designs d JOIN use_case_sources s ON s.use_case_id=d.source_use_case_id WHERE s.source_type IN ('note','canvas')
  UNION SELECT d.id,d.parent_note_id,'note',l.target_note_id::text,NULL FROM designs d JOIN note_links l ON l.source_note_id=d.source_note_id
  UNION SELECT d.id,d.parent_note_id,'canvas',l.target_id,'diagram' FROM designs d JOIN note_entity_links l ON l.source_note_id=d.source_note_id AND l.target_type='diagram'
  UNION SELECT d.id,d.parent_note_id,a.source_type,a.source_id,a.role FROM designs d JOIN design_assets a ON a.design_id=d.id WHERE NOT a.excluded
),
design_members AS MATERIALIZED (
  SELECT c.*,COALESCE(o.role,c.role,'reference') AS asset_role FROM design_candidates c
    JOIN notes parent ON parent.id=c.parent_note_id AND parent.status='active'
      AND note_list_metadata(parent.content)->>'contentType'='design'
    LEFT JOIN design_assets o ON o.design_id=c.design_id AND o.source_type=c.source_type AND o.source_id=c.source_id
    WHERE c.source_id IS NOT NULL AND NOT COALESCE(o.excluded,false)
),
raw_edges AS (
  SELECT e.id::text AS id, sa.id AS source,ta.id AS target,
    e.edge_type, e.confidence, e.metadata, e.created_at,
    CASE WHEN e.edge_type='thematically_related' THEN 'inferred' ELSE 'explicit' END AS origin
    FROM edges e JOIN indexed_refs s ON s.id=e.source_node_id JOIN indexed_refs t ON t.id=e.target_node_id
    JOIN all_nodes sa ON sa.id=s.target JOIN all_nodes ta ON ta.id=t.target
    WHERE e.edge_type NOT IN ('on_map','has_spark','produced_in_window','tag_overlap')
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
  UNION ALL SELECT DISTINCT 'tagged:'||m.source||':'||m.tag_id,m.source,'tag:'||m.tag_id,
    'tagged_with',1,jsonb_build_object('evidence','Saved taxonomy membership','source',m.assignment,'role',t.role),NULL::timestamptz,'explicit'
    FROM tag_memberships m JOIN tags t ON t.id=m.tag_id
  UNION ALL SELECT 'tag-parent:'||id,'tag:'||id,'tag:'||parent_id,'belongs_to',1,
    jsonb_build_object('evidence','Saved taxonomy parent'),NULL,'explicit' FROM tags WHERE parent_id IS NOT NULL
  UNION ALL SELECT 'tag-project:'||id,'tag:'||id,'project:'||project_id,'identifies',1,
    jsonb_build_object('evidence','Saved project filing tag'),NULL,'explicit' FROM tags WHERE project_id IS NOT NULL
  UNION ALL SELECT 'task-link:'||id,'task:'||task_id,target_type||':'||target_id,'references',1,
    jsonb_build_object('evidence','Saved task link'),created_at,'explicit' FROM task_links
  UNION ALL SELECT 'note-source:'||n.id||':'||item,'note:'||n.id,'content_item:'||item,'references',1,
    jsonb_build_object('evidence','Saved linked source'),NULL,'explicit' FROM notes n CROSS JOIN LATERAL unnest(n.linked_items) item
  UNION ALL SELECT 'spark-source:'||id,'spark:'||id,source_type||':'||source_id,'has_spark',1,
    jsonb_build_object('evidence','Saved Spark source'),created_at,'explicit' FROM sparks WHERE source_id IS NOT NULL
  UNION ALL SELECT 'spark-theme:'||id,'spark:'||id,'spark_theme:'||cluster_id,'belongs_to',1,
    jsonb_build_object('evidence','Saved Spark theme'),created_at,'explicit' FROM sparks WHERE cluster_id IS NOT NULL
  UNION ALL SELECT 'spark-used:'||id,'spark:'||id,
    CASE used_type WHEN 'tasks' THEN 'task' ELSE used_type END||':'||used_ref,'developed_into',1,
    jsonb_build_object('evidence','Saved Spark output'),used_at,'explicit' FROM sparks WHERE used_ref IS NOT NULL
  UNION ALL SELECT 'theme-output:'||id,'spark_theme:'||id,
    CASE output_type WHEN 'tasks' THEN 'task' ELSE output_type END||':'||output_ref,'developed_into',1,
    jsonb_build_object('evidence','Saved theme output'),developed_at,'explicit' FROM spark_clusters WHERE output_ref IS NOT NULL
  UNION ALL SELECT 'canvas-note:'||canvas_id||':'||note_id,'canvas:'||canvas_id,'note:'||note_id,'on_map',1,
    jsonb_build_object('evidence','Saved pinned note'),created_at,'explicit' FROM canvas_notes
  UNION ALL SELECT 'canvas-ref:'||id,'canvas:'||canvas_id,ref_type||':'||ref_id,'on_map',1,
    jsonb_build_object('evidence','Saved canvas reference','cardId',id),created_at,'explicit' FROM canvas_nodes WHERE ref_id IS NOT NULL
  UNION ALL SELECT 'canvas-edge:'||e.id,s.ref_type||':'||s.ref_id,t.ref_type||':'||t.ref_id,e.edge_type,1,
    jsonb_build_object('evidence','Saved canvas connection','canvasId',e.canvas_id,'label',e.label),e.created_at,'explicit'
    FROM canvas_edges e JOIN canvases c ON c.id=e.canvas_id AND c.deleted_at IS NULL
    JOIN canvas_nodes s ON s.id=e.source_id AND s.canvas_id=e.canvas_id
    JOIN canvas_nodes t ON t.id=e.target_id AND t.canvas_id=e.canvas_id WHERE s.ref_id IS NOT NULL AND t.ref_id IS NOT NULL
  UNION ALL SELECT 'diagram-note:'||canvas_id||':'||element_id||':'||note_id,'canvas:'||canvas_id,'note:'||note_id,'annotates',1,
    jsonb_build_object('evidence','Saved diagram annotation','elementId',element_id),created_at,'explicit' FROM diagram_element_notes
  UNION ALL SELECT 'diagram-child:'||canvas_id||':'||node_id,'canvas:'||canvas_id,'canvas:'||child_canvas_id,'drills_into',1,
    jsonb_build_object('evidence','Saved diagram drilldown','elementId',node_id),NULL,'explicit' FROM diagram_drilldowns d
    WHERE EXISTS(SELECT 1 FROM canvas_diagrams cd CROSS JOIN LATERAL jsonb_array_elements(cd.document->'nodes') element
      WHERE cd.canvas_id=d.canvas_id AND element->>'id'=d.node_id::text)
  UNION ALL SELECT 'usecase-source:'||use_case_id||':'||source_type||':'||source_id,'usecase:'||use_case_id,
    source_type||':'||source_id,'derived_from',1,jsonb_build_object('evidence','Saved Use Case source'),added_at,'explicit' FROM use_case_sources
  UNION ALL SELECT 'usecase-spec:'||id,'usecase:'||id,'note:'||spec_note_id,'specifies',1,
    jsonb_build_object('evidence','Saved Use Case specification'),NULL,'explicit' FROM use_cases WHERE spec_note_id IS NOT NULL
  UNION ALL SELECT 'usecase-build:'||id,'usecase:'||id,'build_spec:'||build_spec_id,'implements',1,
    jsonb_build_object('evidence','Saved Use Case build'),NULL,'explicit' FROM use_cases WHERE build_spec_id IS NOT NULL
  UNION ALL SELECT 'usecase-link:'||id,'usecase:'||use_case_id,'url:'||url,'references',1,
    jsonb_build_object('evidence','Saved Use Case reference'),added_at,'explicit' FROM use_case_links
  UNION ALL SELECT 'design-asset:'||design_id||':'||source_type||':'||source_id,'note:'||parent_note_id,
    CASE source_type WHEN 'link' THEN 'url' ELSE source_type END||':'||source_id,'has_asset',1,
    jsonb_build_object('evidence','Linked Design asset','role',asset_role),NULL,'explicit' FROM design_members
  UNION ALL SELECT DISTINCT 'design-diagram:'||m.design_id||':'||links.canvas_id,'note:'||m.parent_note_id,
    'canvas:'||links.canvas_id,'has_asset',1,jsonb_build_object('evidence','Diagram linked to a Design document','role','diagram'),NULL::timestamptz,'explicit'
    FROM design_members m JOIN (
      SELECT canvas_id,note_id FROM canvas_notes UNION SELECT canvas_id,note_id FROM diagram_element_notes
    ) links ON m.source_type='note' AND links.note_id=m.source_id
    JOIN canvases c ON c.id=links.canvas_id AND c.canvas_type='diagram'
    WHERE NOT EXISTS(SELECT 1 FROM design_assets a WHERE a.design_id=m.design_id AND a.source_type='canvas'
      AND a.source_id=c.id::text AND a.excluded)
  UNION ALL SELECT 'chat-note:'||id,'chat:'||id,'note:'||note_id,'references',1,
    jsonb_build_object('evidence','Saved note conversation'),NULL,'explicit' FROM ai_chat_sessions WHERE note_id IS NOT NULL
  UNION ALL SELECT 'chat-output:'||id,'chat_output:'||id,'chat:'||session_id,'recorded_in',1,
    jsonb_build_object('evidence','Saved conversation output'),created_at,'explicit' FROM chat_outputs
  UNION ALL SELECT 'build-note:'||id,'build_spec:'||id,'note:'||note_id,'derived_from',1,
    jsonb_build_object('evidence','Saved build source note'),NULL,'explicit' FROM build_specs WHERE note_id IS NOT NULL
  UNION ALL SELECT 'build-output:'||id,'build_spec:'||id,'chat_output:'||chat_output_id,'derived_from',1,
    jsonb_build_object('evidence','Saved build source output'),NULL,'explicit' FROM build_specs WHERE chat_output_id IS NOT NULL
  UNION ALL SELECT 'build-pr:'||id,'build_spec:'||id,'url:'||final_pr_url,'implements',1,
    jsonb_build_object('evidence','Saved build pull request'),NULL,'explicit' FROM build_specs WHERE final_pr_url IS NOT NULL
  UNION ALL SELECT 'build-task-pr:'||id,'build_spec:'||spec_id,'url:'||pr_url,'implements',1,
    jsonb_build_object('evidence','Saved build task pull request'),NULL,'explicit' FROM build_tasks WHERE pr_url IS NOT NULL
  UNION ALL SELECT 'published-article:'||id,'discover_item:'||id,'url:'||(metadata->>'publishedUrl'),'developed_into',1,
    jsonb_build_object('evidence','Saved published article URL'),NULL,'explicit'
    FROM content_records WHERE ref_type='discover_item' AND metadata->>'publishedUrl' IS NOT NULL
  UNION ALL SELECT 'extraction:'||id,'note:'||note_id,target_type||':'||target_id,'derived_into',1,
    jsonb_build_object('evidence','Saved passage extraction','action',action),created_at,'explicit' FROM note_extractions WHERE target_id IS NOT NULL
  UNION ALL SELECT 'recorded-in:'||id,'decision:'||id,'chat:'||session_id,'recorded_in',1,
    jsonb_build_object('evidence','Conversation where the decision was recorded'),created_at,'explicit' FROM chat_decisions
  UNION ALL SELECT 'register-task:'||id,(CASE kind WHEN 'issue' THEN 'register_issue' ELSE kind END)||':'||id,'task:'||task_id,'affects',1,
    jsonb_build_object('evidence','Saved register task link'),NULL,'explicit' FROM project_register_items WHERE task_id IS NOT NULL
  UNION ALL SELECT 'register-decision:'||id,(CASE kind WHEN 'issue' THEN 'register_issue' ELSE kind END)||':'||id,'decision:'||source_id,'affects',1,
    jsonb_build_object('evidence','Saved register decision link'),NULL,'explicit' FROM project_register_items WHERE source_type='chat_decision'
  UNION ALL SELECT 'semantic:'||id,
    from_kind||':'||from_id,to_kind||':'||to_id,
    relationship, CASE WHEN origin='inferred' THEN 0.5 ELSE 1 END,
    jsonb_build_object('evidence','Recorded semantic relationship','note',note,'effectiveAt',effective_at),
    created_at,origin FROM semantic_edges
),
all_edges AS MATERIALIZED (
  SELECT DISTINCT ON (s.id,t.id,e.edge_type) e.id,s.id AS source,t.id AS target,e.edge_type,e.confidence,e.metadata,e.created_at,e.origin
    FROM raw_edges e JOIN aliases s ON s.alias=e.source JOIN aliases t ON t.alias=e.target
    WHERE s.id<>t.id AND ($6::boolean OR e.origin<>'inferred')
    ORDER BY s.id,t.id,e.edge_type,(e.origin='user_confirmed') DESC,(e.origin='inferred'),e.id
),
root AS (
  SELECT id FROM aliases WHERE alias=$1
  UNION SELECT target FROM indexed_refs WHERE id::text=$1
),
recorded_neighbours AS MATERIALIZED (
  SELECT target AS id FROM all_edges WHERE origin<>'inferred' AND source IN (SELECT id FROM root)
  UNION SELECT source FROM all_edges WHERE origin<>'inferred' AND target IN (SELECT id FROM root)
),
adj AS MATERIALIZED (
  SELECT source AS a,target AS b,edge_type FROM all_edges UNION ALL SELECT target,source,edge_type FROM all_edges
),
walk(id,depth) AS (
  SELECT id,0 FROM root
  UNION
  SELECT a.b,w.depth+1 FROM walk w JOIN adj a ON a.a=w.id
    WHERE w.depth<$2 AND (cardinality($5::text[])=0 OR a.edge_type=ANY($5))
),
walk_distances AS MATERIALIZED (
  SELECT id,MIN(depth) AS hop FROM walk GROUP BY id
),
candidates AS MATERIALIZED (
  SELECT n.*,0 AS hop FROM all_nodes n
    WHERE $1::text IS NULL AND n.updated_at >= $3::timestamptz
      AND (cardinality($4::text[])=0 OR n.ref_type=ANY($4))
  UNION ALL
  SELECT n.*,w.hop FROM all_nodes n JOIN walk_distances w ON w.id=n.id
    WHERE $1::text IS NOT NULL AND (cardinality($4::text[])=0 OR n.ref_type=ANY($4))
),
ranked AS (
  SELECT *,row_number() OVER (PARTITION BY ref_type ORDER BY updated_at DESC,id) AS type_rank FROM candidates
),
chosen AS (
  SELECT * FROM ranked ORDER BY (id IN (SELECT id FROM root)) DESC,
    hop,
    ($1::text IS NOT NULL AND id IN (SELECT id FROM recorded_neighbours)) DESC,
    ($1::text IS NULL AND type_rank<=20) DESC, (ref_type='project') DESC, updated_at DESC,id
  LIMIT ${NODE_CAP}
),
chosen_taxonomy AS MATERIALIZED (
  SELECT n.id AS source,t.id,t.name,t.parent_id,t.role FROM chosen n JOIN tags t ON t.name=ANY(n.tags)
  UNION
  SELECT m.source,t.id,t.name,t.parent_id,t.role FROM tag_memberships m
    JOIN chosen n ON n.id=m.source JOIN tags t ON t.id=m.tag_id
),
chosen_tag_metadata AS (
  SELECT t.source,array_agg(DISTINCT t.name ORDER BY t.name) AS names,
    MIN(p.name) FILTER (WHERE t.role='concept') AS concept_parent
    FROM chosen_taxonomy t LEFT JOIN tags p ON p.id=t.parent_id GROUP BY t.source
),
enriched_nodes AS (
  SELECT n.*,m.names AS taxonomy_names,m.concept_parent,
    COALESCE(c.url,'/chat?session='||COALESCE(o.session_id,d.session_id)) AS url
    FROM chosen n LEFT JOIN chosen_tag_metadata m ON m.source=n.id
    LEFT JOIN content_records c ON c.id::text=n.ref_id AND c.ref_type=n.ref_type
    LEFT JOIN chat_outputs o ON n.ref_type='chat_output' AND o.id::text=n.ref_id
    LEFT JOIN chat_decisions d ON n.ref_type='decision' AND d.id::text=n.ref_id
),
chosen_edges AS (
  SELECT e.* FROM all_edges e JOIN chosen s ON s.id=e.source JOIN chosen t ON t.id=e.target
    WHERE cardinality($5::text[])=0 OR e.edge_type=ANY($5)
),
bounded_edges AS (SELECT * FROM chosen_edges ORDER BY (origin<>'inferred') DESC,
  (source IN (SELECT id FROM root) OR target IN (SELECT id FROM root)) DESC,id LIMIT ${EDGE_CAP})
`;

export async function readGraphAtlas(db: Pick<Pool, 'query'>, query: AtlasQuery, now = new Date()): Promise<{
  nodes: AtlasNode[]; edges: AtlasEdge[]; rootId: string | null;
  stats: { totalNodes: number; totalEdges: number; filteredNodes: number; filteredEdges: number; truncated: boolean };
}> {
  const result = await db.query<{ nodes: AtlasNode[]; edges: AtlasEdge[]; root_id: string | null; total_nodes: number; total_edges: number; matched_nodes: number; matched_edges: number }>(
    `${PROJECTION}
    SELECT (SELECT id FROM root ORDER BY id LIMIT 1) AS root_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'refId',ref_id,'refType',ref_type,'title',LEFT(title,240),
        'tags',ARRAY(SELECT DISTINCT name FROM unnest(tags||COALESCE(taxonomy_names,'{}'::text[])) name ORDER BY name),
        'createdAt',created_at,'updatedAt',updated_at,'projectIds',project_ids,
        'url',url,'timestampBasis',timestamp_basis,'conceptParent',concept_parent)) FROM enriched_nodes),'[]') AS nodes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'source',source,'target',target,'edgeType',edge_type,
        'confidence',confidence,'metadata',metadata,'createdAt',created_at,'origin',origin)) FROM bounded_edges),'[]') AS edges,
      (SELECT count(*)::int FROM all_nodes) AS total_nodes,(SELECT count(*)::int FROM all_edges) AS total_edges,
      (SELECT count(*)::int FROM candidates) AS matched_nodes,(SELECT count(*)::int FROM chosen_edges) AS matched_edges`,
    [query.seed, query.depth, new Date(now.getTime() - query.days * DAY_MS).toISOString(), query.nodeTypes, query.edgeTypes, query.includeInferred],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Graph query returned no result');
  return { nodes: row.nodes, edges: row.edges, rootId: row.root_id, stats: { totalNodes: row.total_nodes, totalEdges: row.total_edges,
    filteredNodes: row.nodes.length, filteredEdges: row.edges.length,
    truncated: row.matched_nodes > NODE_CAP || row.matched_edges > EDGE_CAP } };
}
