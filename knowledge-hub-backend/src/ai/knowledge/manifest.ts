import type { ContentSource } from '../../types/contentItem.js';

/**
 * Coverage manifest (Phase 0 audit). Dispositions come from source inspection,
 * not a production census: "partial" means the access path exists in code but
 * eligible-record counts, extraction completeness or ID-based reads are unproven.
 */
export type Availability = 'supported' | 'partial' | 'unavailable' | 'excluded';
export type Capability = 'discover' | 'read' | 'paginate' | 'related' | 'structured';
export type Freshness = 'live' | 'indexed' | 'synced' | 'derived';
export type Provenance = 'human' | 'imported' | 'ai-generated' | 'derived';

export interface KnowledgeFamily {
  kind: string;
  storage: string;
  capabilities: readonly Capability[];
  projection: { allowed: string; excluded: string };
  identity: string;
  scope: string;
  freshness: Freshness;
  provenance: readonly Provenance[];
  entryPoint: string;
  availability: Availability;
  reason: string;
  tests: readonly string[];
}

const SECRETS = 'tokens, credentials, raw config, binary/base64';

interface SourceDisposition { family: string; availability: Availability; reason: string }

const family = (
  kind: string, storage: string, capabilities: Capability[], allowed: string, freshness: Freshness,
  provenance: Provenance[], entryPoint: string, availability: Availability, reason: string, tests: string[],
): KnowledgeFamily => ({
  kind, storage, capabilities, projection: { allowed, excluded: SECRETS },
  identity: 'canonical ref kind:id; aliases via content_items and graph node ids',
  scope: 'project preference, session exclusions, archived/completed filters explicit',
  freshness, provenance, entryPoint, availability, reason, tests,
});

export const KNOWLEDGE_FAMILIES: readonly KnowledgeFamily[] = [
  family('project', 'projects table', ['discover', 'read', 'related', 'structured'], 'goal, description, role, lifecycle, outputs, dates, links', 'live', ['human'], 'get_project_details', 'supported', 'live read tool exists', ['COV-02', 'STATE-02']),
  family('note', 'notes + content_items(note)', ['discover', 'read', 'related'], 'title, plain text via noteTextService, links, tags', 'indexed', ['human'], 'search_knowledge_base; read_knowledge_record (missing)', 'partial', 'no ID-based paged reader; body may be truncated in index', ['READ-01', 'READ-07', 'SRC-08']),
  family('library-document', 'content_items (github-content-store/ica/upload/onedrive)', ['discover', 'read'], 'path, extracted text, origin, extraction state', 'indexed', ['imported'], 'search_library; find_files', 'partial', 'file content capped at 8,000/6,000 chars; extraction completeness not recorded', ['READ-01', 'READ-09', 'SRC-01']),
  family('discover-article', 'discovered articles + content_items(discovered-article)', ['discover', 'read', 'structured'], 'title, body, summary, publisher, dates, state', 'synced', ['imported'], 'inspect_discover_feed; search_knowledge_base', 'partial', 'dismissed/parked state handling needs explicit filters', ['SRC-10', 'SRC-11']),
  family('youtube', 'youtube discovery records', ['discover', 'read'], 'metadata and description only', 'synced', ['imported'], 'search_knowledge_base', 'partial', 'no transcript: must never imply video was watched', ['READ-08']),
  family('connected-activity', 'content_items (gitlab-*, github-*, email, graph-*, cms-*)', ['discover', 'read'], 'title, body, dates, links', 'synced', ['imported'], 'search_knowledge_base', 'partial', 'last-sync disclosure required; remote state not claimed', ['STATE-04', 'STATE-05']),
  family('task', 'tasks table', ['discover', 'read', 'structured'], 'status, priority, due, project, notes, links', 'live', ['human'], 'list_tasks', 'supported', 'live structured tool exists; archived/completed filters to verify', ['STATE-01', 'STATE-03', 'SRC-12']),
  family('person', 'people table', ['discover', 'read'], 'name, aliases, organisation, role, approved contact fields', 'live', ['human'], 'none (no AI people tool found)', 'unavailable', 'no chat tool; explicit-link identity rule required', ['SRC-13']),
  family('spark', 'sparks + themes', ['discover', 'read', 'related'], 'body, source refs, theme, lifecycle', 'live', ['human', 'derived'], 'create_spark only (write)', 'unavailable', 'no read tool', ['REL-05']),
  family('canvas', 'diagrams/maps', ['discover', 'read', 'related'], 'structure, labels, connections, annotations, drilldowns', 'live', ['human'], 'search_diagrams; read_diagram', 'supported', 'read tools exist', ['COV-02']),
  family('graph', 'nodes/edges + junctions', ['related'], 'nodes, edges, provenance', 'derived', ['derived', 'ai-generated'], 'search_knowledge_graph', 'partial', 'edge provenance (explicit vs inferred) needs verification', ['REL-02', 'REL-03', 'REL-04']),
  family('watchlist', 'discover watchlists + runs', ['discover', 'read'], 'config, question, baselines, run status/coverage, findings', 'derived', ['ai-generated'], 'get_discover_watchlist_records', 'supported', 'read-only tool exists; coverage {} handling covered by existing tests', ['EVD-07', 'EVD-08']),
  family('chat', 'ai_chat_sessions + messages', ['discover', 'read'], 'role, timestamp, session, summaries labelled', 'live', ['human', 'ai-generated'], 'search_past_chats; read_past_chat', 'supported', 'targeted retrieval exists', ['EVD-09']),
  family('output-decision', 'chat_outputs/versions + chat_decisions', ['read', 'structured'], 'current version, author; decided/open decisions', 'live', ['human', 'ai-generated'], 'read_output', 'partial', 'chat_decisions has no acceptance/project/review/supersession: acceptance is unknown', ['READ-10', 'EVD-02', 'SEM-05']),
  family('memory', 'athena memories', ['discover', 'read'], 'active scoped memories', 'live', ['human', 'ai-generated'], 'list_memories', 'supported', 'revoked memories must stay excluded', ['COV-02']),
  family('use-case', 'use_cases', ['discover', 'read', 'related'], 'stage, project, source links, spec, handoff', 'live', ['human'], 'none', 'unavailable', 'no chat reader found', ['REL-05']),
  family('build', 'build specs/tasks', ['discover', 'read'], 'specs, tasks, status, issue/PR links', 'live', ['human', 'ai-generated'], 'none', 'unavailable', 'no chat reader found', ['REL-05']),
  family('governance', 'project register/review packets', ['discover', 'read', 'structured'], 'questions, risks, issues, owners, dates, status', 'live', ['human'], 'none', 'unavailable', 'no chat reader found', ['REL-01']),
  family('podcast-content', 'podcast prep, episodes, content picks', ['discover', 'read'], 'prep, evidence, show notes, picks', 'live', ['human', 'ai-generated'], 'get_content_pipeline', 'partial', 'partial tool coverage', ['COV-02']),
  family('cfp-practice', 'CFP and practice score tables', ['discover', 'read', 'structured'], 'dates, status, scores', 'live', ['human'], 'none', 'unavailable', 'no chat reader found', ['COV-04']),
  family('knowledge-health', 'health aggregates', ['structured'], 'availability, last sync/index, aggregate failures', 'live', ['derived'], 'src/health/knowledgeHealth.ts', 'partial', 'reports per-family state, indexed counts and extraction; eligible/pending/failed per family are not recorded, so they read as not measured', ['UI-01']),
];

const source = (family: string, availability: Availability, reason: string): SourceDisposition => ({ family, availability, reason });

/** Every ContentSource union member must be present; enforced by the COV-01 test. */
export const CONTENT_SOURCE_DISPOSITIONS: Record<ContentSource, SourceDisposition> = {
  'cms-blog': source('connected-activity', 'partial', 'CMS body may be truncated at ingestion'),
  'cms-newsletter': source('connected-activity', 'partial', 'CMS body may be truncated at ingestion'),
  'cms-podcast-show-notes': source('podcast-content', 'partial', 'show notes indexed; extraction completeness unrecorded'),
  'cms-session-summary': source('connected-activity', 'partial', 'summary only'),
  'gitlab-commit': source('connected-activity', 'partial', 'message/metadata only; noisy for ranking'),
  'gitlab-mr': source('connected-activity', 'partial', 'indexed text only'),
  'gitlab-issue': source('connected-activity', 'partial', 'indexed text only'),
  'gitlab-pipeline': source('connected-activity', 'partial', 'status metadata only'),
  'github-commit': source('connected-activity', 'partial', 'message/metadata only; noisy for ranking'),
  'github-pr': source('connected-activity', 'partial', 'indexed text only'),
  'github-issue': source('connected-activity', 'partial', 'indexed text only'),
  'github-content-store': source('library-document', 'partial', 'files capped at ingestion'),
  'github-doc': source('library-document', 'partial', 'files capped at ingestion'),
  'graph-calendar': source('connected-activity', 'partial', 'calendar entries as synced'),
  'graph-todo': source('connected-activity', 'partial', 'To Do items as synced'),
  'podcast-episode': source('podcast-content', 'partial', 'episode text as indexed'),
  'ai-session': source('chat', 'partial', 'indexed copy is a summary, not verbatim'),
  email: source('connected-activity', 'partial', 'only synced mail; mailbox not fully indexed'),
  'github-action': source('connected-activity', 'partial', 'run metadata only'),
  'github-release': source('connected-activity', 'partial', 'indexed text only'),
  'github-deployment': source('connected-activity', 'partial', 'status metadata only'),
  'github-pr-review': source('connected-activity', 'partial', 'indexed text only'),
  'gitlab-release': source('connected-activity', 'partial', 'indexed text only'),
  'gitlab-deployment': source('connected-activity', 'partial', 'status metadata only'),
  note: source('note', 'partial', 'indexed copy; see note family'),
  task: source('task', 'partial', 'indexed copy may be stale; live tool authoritative'),
  'discovered-article': source('discover-article', 'partial', 'dismissed/parked state to disclose'),
  'ica-document': source('library-document', 'partial', 'extraction completeness unrecorded'),
  'user-upload': source('library-document', 'partial', 'extraction completeness unrecorded'),
  'onedrive-document': source('library-document', 'partial', 'extraction completeness unrecorded'),
};
