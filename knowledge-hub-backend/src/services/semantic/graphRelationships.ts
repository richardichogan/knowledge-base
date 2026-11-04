/**
 * Registered vocabulary for every relationship the knowledge graph projects (spec §17.4).
 * The graph stays a read-through projection; this registry gives each edge type a meaning,
 * typed endpoints and an origin so Athena and health checks can reason over it.
 */
import type { EdgeOrigin, RelationshipName } from './types.js';

export type GraphNodeType =
  | 'project' | 'company' | 'person' | 'note' | 'tag' | 'category' | 'spark' | 'spark_theme' | 'canvas' | 'usecase'
  | 'cfp_item' | 'discover_item' | 'document' | 'commit' | 'pull_request' | 'issue' | 'github_item' | 'blog_post'
  | 'podcast_episode' | 'meeting' | 'email' | 'content_item' | 'task' | 'decision' | 'chat' | 'chat_output'
  | 'build_spec' | 'risk' | 'question' | 'register_issue';

export const PUBLISHED_POST_TYPES: readonly GraphNodeType[] = ['blog_post', 'podcast_episode'];
const ANY = '*';
type Endpoints = readonly GraphNodeType[] | typeof ANY;

export interface GraphRelationshipDefinition {
  name: string;
  /** Plain-English reading of `source -> target`. */
  meaning: string;
  from: Endpoints;
  to: Endpoints;
  origin: Extract<EdgeOrigin, 'explicit' | 'inferred'>;
  /** Where the link is saved today. */
  storage: string;
  /** Same relationship in the decision-review semantic layer, when one exists. */
  semantic?: RelationshipName;
}

function def(name: string, meaning: string, from: Endpoints, to: Endpoints, storage: string,
  extra: { origin?: 'explicit' | 'inferred'; semantic?: RelationshipName } = {}): GraphRelationshipDefinition {
  return { name, meaning, from, to, storage, origin: extra.origin ?? 'explicit', ...(extra.semantic !== undefined && { semantic: extra.semantic }) };
}

const REGISTER: readonly GraphNodeType[] = ['risk', 'question', 'register_issue'];

export const GRAPH_RELATIONSHIPS: Readonly<Record<string, GraphRelationshipDefinition>> = Object.fromEntries([
  def('belongs_to', 'is filed under (saved workstream, parent tag or Spark theme)', ANY, ['project', 'tag', 'spark_theme'],
    'project_id columns | tags.parent_id | sparks.cluster_id | semantic_edges', { semantic: 'belongs_to' }),
  def('client_of', 'is the client of the workstream', ['company'], ['project'], 'company_projects (role = client)'),
  def('partner_on', 'is a partner on the workstream', ['company'], ['project'], 'company_projects (role <> client)'),
  def('sells', 'is an opportunity selling the offering', ['project'], ['project'], 'project_offering_links (relation = sells)'),
  def('related_to', 'is related to the offering', ['project'], ['project'], 'project_offering_links'),
  def('used_in', 'diagram is also used in the workstream', ['canvas'], ['project'], 'canvas_project_uses'),
  def('member_of', 'person works for the company', ['person'], ['company'], 'people.company_id'),
  def('works_on', 'person has a role on the workstream', ['person'], ['project'], 'person_project_roles'),
  def('represents', 'person represents the company on a workstream', ['person'], ['company'], 'person_project_roles.company_id'),
  def('mentions', 'note explicitly mentions the entity', ['note'], ANY, 'note_entity_links'),
  def('references', 'explicitly links to', ANY, ANY,
    'note_links | notes.linked_items | task_links | entity_manual_links | use_case_links | ai_chat_sessions.note_id | deliverable_briefs | email_drafts | edges'),
  def('tagged_with', 'is tagged with', ANY, ['tag'], 'note_tags | task_tags | canvas_tags | other *_tags tables | published post keywords'),
  def('identifies', 'filing tag identifies the workstream', ['tag'], ['project'], 'tags.project_id'),
  def('in_category', 'published post is in the category', PUBLISHED_POST_TYPES, ['category', 'tag'], 'content_items.metadata.categories'),
  def('has_spark', 'Spark was captured from', ['spark'], ANY, 'sparks.source_type/source_id | edges'),
  def('developed_into', 'was developed into', ANY, ANY,
    'sparks.used_ref | spark_clusters.output_ref | publishedUrl | deliverable_briefs.produced_content_id | task_assistance'),
  def('derived_into', 'passage was extracted into', ['note'], ANY, 'note_extractions | note_passage_followups'),
  def('derived_from', 'was derived from', ['usecase', 'build_spec', 'note'], ANY, 'use_case_sources | build_specs | email_drafts.brief_id'),
  def('specifies', 'use case is specified by the note', ['usecase'], ['note'], 'use_cases.spec_note_id'),
  def('implements', 'is implemented by / implements', ['usecase', 'build_spec', 'task'], ANY,
    'use_cases.build_spec_id | build_specs.final_pr_url | build_tasks.pr_url | semantic_edges', { semantic: 'implements' }),
  def('has_asset', 'has the linked asset (Design, podcast script or show notes)', ['note'], ANY, 'design_assets | podcast_episodes'),
  def('on_map', 'diagram or map shows the item', ['canvas'], ANY, 'canvas_notes | canvas_nodes | edges'),
  def('annotates', 'diagram element is annotated by the note', ['canvas'], ['note'], 'diagram_element_notes'),
  def('drills_into', 'diagram element drills into the child diagram', ['canvas'], ['canvas'], 'diagram_drilldowns'),
  def('recorded_in', 'was recorded in the conversation', ['decision', 'chat_output'], ANY,
    'chat_decisions.session_id | chat_outputs.session_id', { semantic: 'recorded_in' }),
  def('affects', 'register item affects', REGISTER, ['task', 'decision'], 'project_register_items', { semantic: 'affects' }),
  def('supported_by', 'decision is supported by the evidence', ['decision'], ANY, 'semantic_edges', { semantic: 'supported_by' }),
  def('supersedes', 'decision supersedes the earlier decision', ['decision'], ['decision'], 'semantic_edges', { semantic: 'supersedes' }),
  def('read', 'Athena read the record in this conversation', ['chat'], ANY, 'document_reading_sessions'),
  def('thematically_related', 'is thematically similar to (AI suggestion)', ANY, ANY, 'edges', { origin: 'inferred' }),
  def('tag_overlap', 'shares tags with (computed suggestion)', ANY, ANY, 'edges', { origin: 'inferred' }),
  def('produced_in_window', 'was produced around the same time as (computed suggestion)', ANY, ANY, 'edges', { origin: 'inferred' }),
  def('similar', 'is similar to (computed suggestion)', ANY, ANY, 'edges', { origin: 'inferred' }),
  def('similarity', 'is similar to (computed suggestion)', ANY, ANY, 'edges', { origin: 'inferred' }),
].map((d) => [d.name, d]));

/** Edge-id prefix for user-drawn diagram connections; their type is free text chosen in the diagram editor. */
export const DIAGRAM_CONNECTION_PREFIX = 'canvas-edge:';

export const INFERRED_GRAPH_EDGE_TYPES: ReadonlySet<string> = new Set(
  Object.values(GRAPH_RELATIONSHIPS).filter((d) => d.origin === 'inferred').map((d) => d.name),
);

export type GraphEdgeClassification =
  | { status: 'registered'; meaning: string; definition: GraphRelationshipDefinition }
  | { status: 'diagram_connection'; meaning: string }
  | { status: 'invalid_endpoint'; meaning: string; reason: string }
  | { status: 'unregistered'; meaning: null; reason: string };

function allows(endpoints: Endpoints, type: string): boolean {
  return endpoints === ANY || (endpoints as readonly string[]).includes(type);
}

/** Classifies one projected edge against the registry. */
export function classifyGraphEdge(edge: { id: string; edgeType: string }, sourceType: string, targetType: string): GraphEdgeClassification {
  if (edge.id.startsWith(DIAGRAM_CONNECTION_PREFIX)) {
    return { status: 'diagram_connection', meaning: `is connected on a diagram (“${edge.edgeType}”)` };
  }
  const definition = GRAPH_RELATIONSHIPS[edge.edgeType];
  if (definition === undefined) return { status: 'unregistered', meaning: null, reason: `"${edge.edgeType}" is not a registered relationship.` };
  if (!allows(definition.from, sourceType) || !allows(definition.to, targetType)) {
    return { status: 'invalid_endpoint', meaning: definition.meaning,
      reason: `${edge.edgeType} does not connect ${sourceType} -> ${targetType}.` };
  }
  return { status: 'registered', meaning: definition.meaning, definition };
}

/** Edge types in use that the registry does not describe. */
export function unregisteredGraphEdgeTypes(types: Iterable<string>): string[] {
  return [...new Set(types)].filter((t) => GRAPH_RELATIONSHIPS[t] === undefined).sort();
}
