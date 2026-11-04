/**
 * read_record_relationships: one hop of the knowledge graph's registered, typed relationships
 * around a record (clients, partners, workstreams, people, tags, diagrams, outputs...). Read-only.
 */
import type { Pool } from 'pg';
import { readGraphAtlas } from '../../services/graphAtlas.js';

export const READ_RECORD_RELATIONSHIPS_TOOL = 'read_record_relationships';
const MAX_RESULTS = 40;
const SEED_PATTERN = /^[\w:.-]+$/;
const KIND_ALIASES: Record<string, string> = { diagram: 'diagram', canvas: 'canvas', use_case: 'use_case', usecase: 'usecase', workstream: 'project' };
/** Node types that carry no workstream of their own, so strict scope does not hide them. */
const UNSCOPED_TYPES = new Set(['project', 'company', 'person', 'tag', 'category']);

export const READ_RECORD_RELATIONSHIPS_DEFINITION = {
  type: 'function' as const,
  function: {
    name: READ_RECORD_RELATIONSHIPS_TOOL,
    description:
      'Reads the saved, typed relationships around one record from the knowledge graph: e.g. a workstream\'s client and partner ' +
      'companies, offering, people and roles, filing tags; a note\'s mentions, links, Design assets and extractions; a diagram\'s ' +
      'workstreams, annotations and drilldowns; a post\'s categories. Each link has a registered relation, its plain meaning, direction ' +
      'and origin ("explicit" = saved link, state it as fact; "inferred" = suggestion, call it inference). Targets are NOT read: open them ' +
      'before saying what they contain. Read-only; one hop.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Record type: project/workstream, company, person, note, task, canvas/diagram, usecase, document, discover_item, decision, chat, tag…' },
        id: { type: 'string', description: 'Record id (refId) from a search result, page context or graph node.' },
        include_inferred: { type: 'boolean', description: 'Also return AI/similarity suggestions (default false).' },
      },
      required: ['kind', 'id'],
    },
  },
};

export interface RecordRelationshipsTurn { excludedIds?: ReadonlySet<string> | undefined; strictProjectId?: string | null | undefined }

export async function executeReadRecordRelationships(db: Pool, args: Record<string, unknown>, turn: RecordRelationshipsTurn): Promise<unknown> {
  const rawKind = typeof args['kind'] === 'string' ? args['kind'].trim().toLowerCase() : '';
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (rawKind === '' || id === '') return { error: 'kind and id are required (use the type and refId from a search result).' };
  const excluded = turn.excludedIds ?? new Set<string>();
  const isExcluded = (type: string, refId: string): boolean => excluded.has(refId) || excluded.has(`${type}:${refId}`);
  const kind = KIND_ALIASES[rawKind] ?? rawKind;
  if (isExcluded(kind, id)) return { status: 'excluded' };
  const seed = `${kind}:${id}`;
  if (seed.length > 250 || !SEED_PATTERN.test(seed)) return { error: 'Invalid kind or id.' };

  const atlas = await readGraphAtlas(db, { days: 3650, depth: 1, seed, nodeTypes: [], edgeTypes: [], includeInferred: args['include_inferred'] === true });
  const root = atlas.rootId === null ? undefined : atlas.nodes.find((n) => n.id === atlas.rootId);
  if (root === undefined) return { status: 'not_found', message: 'No graph record matches that kind and id.' };
  const strict = turn.strictProjectId ?? null;
  if (strict !== null && !UNSCOPED_TYPES.has(root.refType) && !root.projectIds.includes(strict)) return { status: 'excluded' };

  const nodes = new Map(atlas.nodes.map((n) => [n.id, n]));
  const links = atlas.edges
    .filter((e) => e.source === root.id || e.target === root.id)
    .map((e) => {
      const outgoing = e.source === root.id;
      const other = nodes.get(outgoing ? e.target : e.source);
      return { e, outgoing, other };
    })
    .filter(({ other }) => other !== undefined && !isExcluded(other.refType, other.refId)
      && (strict === null || UNSCOPED_TYPES.has(other.refType) || other.projectIds.includes(strict)))
    .sort((a, b) => Number(a.e.origin === 'inferred') - Number(b.e.origin === 'inferred') || a.e.edgeType.localeCompare(b.e.edgeType));

  const results = links.slice(0, MAX_RESULTS).map(({ e, outgoing, other }) => {
    const metadata = e.metadata ?? {};
    return {
      id: other!.refId, type: other!.refType, title: other!.title,
      relation: e.edgeType, meaning: e.meaning, direction: outgoing ? 'outgoing' : 'incoming',
      reads: e.meaning === null ? null : outgoing ? `"${root.title}" ${e.meaning} "${other!.title}"` : `"${other!.title}" ${e.meaning} "${root.title}"`,
      origin: e.origin, registered: e.registration === 'registered' || e.registration === 'diagram_connection',
      evidence: typeof metadata['evidence'] === 'string' ? metadata['evidence'] : null,
      ...(typeof metadata['role'] === 'string' && { role: metadata['role'] }),
      ...(e.origin === 'inferred' && { confidence: e.confidence }),
      projectIds: other!.projectIds, url: other!.url ?? null, read: false,
    };
  });
  return {
    status: 'ok',
    record: { id: root.refId, type: root.refType, title: root.title, projectIds: root.projectIds },
    results,
    truncated: links.length > MAX_RESULTS || atlas.stats.truncated,
    unregisteredRelations: atlas.stats.unregisteredEdgeTypes,
    note: 'Relationships only; targets are NOT read. State explicit links as saved relationships; call inferred ones suggestions. Open a target before quoting it.',
  };
}
