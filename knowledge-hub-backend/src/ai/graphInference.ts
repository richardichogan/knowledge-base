/**
 * Reasoning across the knowledge graph (nodes/edges) rather than one item at a
 * time: finds the items a query is about, ranks what each is connected to
 * (across every project), and surfaces "bridges" — items linked to several of
 * them, which is where non-obvious connections show up.
 */
import type { Pool } from 'pg';
import type { ContentItem } from '../types/contentItem.js';

/** Types that carry his own thinking or reading rank ahead of build/deploy noise. */
const TYPE_PRIORITY = ['note', 'task', 'discover_item', 'document', 'spark', 'canvas', 'cfp_item', 'pull_request', 'issue', 'commit', 'github_item'];
const NOISY_TYPES = new Set(['github_item', 'commit']);
const PER_TYPE = 3;
const CONNECTIONS_PER_SEED = 10;
const MAX_BRIDGES = 8;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'have', 'what', 'which', 'how', 'why', 'about', 'into',
  'any', 'all', 'our', 'his', 'her', 'their', 'does', 'did', 'can', 'could', 'would', 'should', 'related', 'connected',
  'linked', 'link', 'links', 'connection', 'connections', 'between', 'relate', 'relates',
]);

export interface GraphNodeRef { nodeId: string; refId: string; type: string; title: string; project: string | null }
export interface GraphLink extends Omit<GraphNodeRef, 'nodeId'> { edgeType: string; confidence: number }

export function graphTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]{2,}/gu) ?? []).filter((t) => !STOPWORDS.has(t)))].slice(0, 8);
}

function typeRank(type: string): number {
  const i = TYPE_PRIORITY.indexOf(type);
  return i === -1 ? TYPE_PRIORITY.length : i;
}

/** The project each node belongs to, where its underlying record has one. */
const NODE_PROJECT_SQL = `COALESCE(
  (SELECT ci.project_context FROM content_items ci WHERE ci.id = CASE WHEN n.ref_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN n.ref_id::uuid END),
  (SELECT cn.project_context FROM content_items cn WHERE n.ref_type = 'note' AND cn.source = 'note' AND cn.source_id = n.ref_id LIMIT 1),
  (SELECT t.project_id FROM tasks t WHERE n.ref_type = 'task' AND t.id::text = n.ref_id)
)`;

/** Nodes matching the query: the whole phrase, every term, or a tag — best matches and his own material first. */
export async function findGraphSeeds(db: Pool, query: string, limit: number): Promise<GraphNodeRef[]> {
  const terms = graphTerms(query);
  const phrase = query.trim();
  if (phrase === '') return [];
  const { rows } = await db.query<{ id: string; ref_id: string; ref_type: string; title: string; project: string | null }>(
    `WITH matched AS (
       SELECT n.*,
              CASE WHEN n.title ILIKE '%' || $1 || '%' THEN 3
                   WHEN cardinality($2::text[]) > 0 AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) t WHERE n.title NOT ILIKE '%' || t || '%') THEN 2
                   WHEN n.tags && $2::text[] THEN 1
                   ELSE 0 END AS score
         FROM nodes n
        WHERE n.title ILIKE '%' || $1 || '%'
           OR (cardinality($2::text[]) > 0 AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) t WHERE n.title NOT ILIKE '%' || t || '%'))
           OR n.tags && $2::text[]
     )
     SELECT n.id::text, n.ref_id, n.ref_type, n.title, ${NODE_PROJECT_SQL} AS project
       FROM matched n
      ORDER BY n.score DESC, array_position($3::text[], n.ref_type) NULLS LAST, n.updated_at DESC NULLS LAST
      LIMIT $4`,
    [phrase, terms, TYPE_PRIORITY, limit],
  );
  return rows.map((r) => ({ nodeId: r.id, refId: r.ref_id, type: r.ref_type, title: r.title, project: r.project }));
}

interface RawLink { seed_id: string; other_id: string; ref_id: string; ref_type: string; title: string; edge_type: string; confidence: string; project: string | null }

/** Every edge touching the seeds, at most PER_TYPE per seed and neighbour type (highest confidence first). */
async function linksFrom(db: Pool, seedIds: string[], minConfidence: number): Promise<RawLink[]> {
  if (seedIds.length === 0) return [];
  const { rows } = await db.query<RawLink>(
    `WITH seed AS (SELECT unnest($1::uuid[]) AS id),
     links AS (
       SELECT s.id AS seed_id, e.target_node_id AS other_id, e.edge_type, e.confidence FROM seed s JOIN edges e ON e.source_node_id = s.id
       UNION ALL
       SELECT s.id, e.source_node_id, e.edge_type, e.confidence FROM seed s JOIN edges e ON e.target_node_id = s.id
     ),
     best AS (
       SELECT DISTINCT ON (seed_id, other_id) * FROM links WHERE confidence >= $2 AND other_id <> seed_id
        ORDER BY seed_id, other_id, confidence DESC
     ),
     ranked AS (
       SELECT b.*, n.ref_id, n.ref_type, n.title,
              row_number() OVER (PARTITION BY b.seed_id, n.ref_type ORDER BY b.confidence DESC, n.updated_at DESC NULLS LAST) AS rn,
              count(*) OVER (PARTITION BY b.other_id) AS seed_count
         FROM best b JOIN nodes n ON n.id = b.other_id
     )
     SELECT n.seed_id::text, n.other_id::text, n.ref_id, n.ref_type, n.title, n.edge_type, n.confidence::text, ${NODE_PROJECT_SQL} AS project
       FROM ranked n
      WHERE n.rn <= $3 OR n.seed_count > 1`,
    [seedIds, minConfidence, PER_TYPE],
  );
  return rows;
}

function toLink(r: RawLink): GraphLink {
  return { refId: r.ref_id, type: r.ref_type, title: r.title, project: r.project, edgeType: r.edge_type, confidence: Number(r.confidence) };
}

function byUsefulness(a: { type: string; confidence: number }, b: { type: string; confidence: number }): number {
  const noise = Number(NOISY_TYPES.has(a.type)) - Number(NOISY_TYPES.has(b.type));
  return noise !== 0 ? noise : b.confidence - a.confidence || typeRank(a.type) - typeRank(b.type);
}

export interface GraphBridge { refId: string; type: string; title: string; project: string | null; links: string[]; averageConfidence: number }

/** Items connected to two or more of the given nodes, strongest first. */
function bridgesFrom(links: RawLink[], seeds: Map<string, string>): GraphBridge[] {
  const groups = new Map<string, RawLink[]>();
  for (const l of links) {
    if (seeds.has(l.other_id)) continue;
    groups.set(l.other_id, [...(groups.get(l.other_id) ?? []), l]);
  }
  return [...groups.values()]
    .map((g) => ({ g, seedsLinked: new Set(g.map((l) => l.seed_id)) }))
    .filter(({ seedsLinked }) => seedsLinked.size > 1)
    .map(({ g, seedsLinked }) => ({
      refId: g[0]!.ref_id, type: g[0]!.ref_type, title: g[0]!.title, project: g[0]!.project,
      links: [...seedsLinked].map((id) => seeds.get(id) ?? id),
      averageConfidence: Math.round((g.reduce((s, l) => s + Number(l.confidence), 0) / g.length) * 100) / 100,
    }))
    .sort((a, b) => b.links.length - a.links.length || Number(NOISY_TYPES.has(a.type)) - Number(NOISY_TYPES.has(b.type)) || b.averageConfidence - a.averageConfidence)
    .slice(0, MAX_BRIDGES);
}

/** The search_knowledge_graph tool. */
export async function searchKnowledgeGraph(db: Pool, query: string, limit: number): Promise<unknown> {
  const seeds = await findGraphSeeds(db, query, limit);
  if (seeds.length === 0) {
    return { resultCount: 0, results: [], message: 'No knowledge graph items matched — try a shorter or different term (a project, product or note name).' };
  }
  const links = await linksFrom(db, seeds.map((s) => s.nodeId), 0.5);
  const seedTitles = new Map(seeds.map((s) => [s.nodeId, s.title]));
  const results = seeds.map((seed) => ({
    title: seed.title, type: seed.type, refId: seed.refId, project: seed.project,
    connections: links.filter((l) => l.seed_id === seed.nodeId).map(toLink).sort(byUsefulness).slice(0, CONNECTIONS_PER_SEED),
  }));
  const projects = [...new Set([...results.map((r) => r.project), ...results.flatMap((r) => r.connections.map((c) => c.project))].filter((p): p is string => p !== null))];
  return {
    resultCount: results.length,
    results,
    bridges: bridgesFrom(links, seedTitles),
    projectsSpanned: projects,
    note: 'Connections span all projects. "bridges" are items linked to more than one of the results — use them to reason about how separate pieces of work relate. Read an item (search_knowledge_base with its title) before quoting it; a thematic link is a lead, not proof.',
  };
}

/**
 * Items the graph connects to what auto-retrieval found, which retrieval itself
 * missed — so Athena sees related work from other projects without being asked.
 */
export async function graphConnectionsFor(db: Pool, items: ContentItem[], limit = 6): Promise<GraphBridge[]> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const noteIds = items.filter((i) => i.source === 'note').map((i) => i.sourceId);
  const { rows: seedRows } = await db.query<{ id: string; title: string }>(
    `SELECT id::text, title FROM nodes WHERE ref_id = ANY($1::text[]) OR (ref_type = 'note' AND ref_id = ANY($2::text[]))`,
    [ids, noteIds],
  );
  if (seedRows.length === 0) return [];
  const seeds = new Map(seedRows.map((r) => [r.id, r.title]));
  const retrievedTitles = new Set(items.map((i) => i.title.trim().toLowerCase()));
  const links = (await linksFrom(db, [...seeds.keys()], 0.7))
    .filter((l) => !seeds.has(l.other_id) && !NOISY_TYPES.has(l.ref_type) && !retrievedTitles.has(l.title.trim().toLowerCase()));
  const groups = new Map<string, RawLink[]>();
  for (const l of links) groups.set(l.other_id, [...(groups.get(l.other_id) ?? []), l]);
  return [...groups.values()]
    .map((g) => ({
      refId: g[0]!.ref_id, type: g[0]!.ref_type, title: g[0]!.title, project: g[0]!.project,
      links: [...new Set(g.map((l) => seeds.get(l.seed_id) ?? l.seed_id))],
      averageConfidence: Math.round((g.reduce((s, l) => s + Number(l.confidence), 0) / g.length) * 100) / 100,
    }))
    .sort((a, b) => b.links.length - a.links.length || typeRank(a.type) - typeRank(b.type) || b.averageConfidence - a.averageConfidence)
    .slice(0, limit);
}

const TYPE_LABEL: Record<string, string> = {
  note: 'Think note', task: 'task', discover_item: 'Discover article', document: 'document', spark: 'Spark', canvas: 'canvas/diagram',
  cfp_item: 'CFP', pull_request: 'PR', issue: 'issue',
};

export function formatGraphConnections(bridges: GraphBridge[]): string {
  if (bridges.length === 0) return '';
  return [
    '## Knowledge graph connections to the retrieved items (all projects)',
    ...bridges.map((b) => `- ${TYPE_LABEL[b.type] ?? b.type}: "${b.title}"${b.project !== null ? ` [project: ${b.project}]` : ''} — linked to ${b.links.map((t) => `"${t}"`).join(', ')}`),
    'These are graph links, not retrieved content: when one bears on the question, read it (search_knowledge_base with its title, or search_knowledge_graph) and say how it connects. Do not quote them unread.',
  ].join('\n');
}
