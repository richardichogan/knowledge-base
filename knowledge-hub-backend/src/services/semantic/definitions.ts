import type { EdgeOrigin, RelationshipName, SemanticEdge, SemanticKind } from './types.js';

/** Bump when an entity or relationship definition changes shape. */
export const SEMANTIC_SCHEMA_VERSION = 1;

export interface EntityDefinition {
  kind: SemanticKind;
  schemaVersion: number;
  /** Existing record the entity is read from, live, on every access. */
  binding: string;
  meaning: string;
  approvedFields: readonly string[];
}

export const ENTITY_DEFINITIONS: Record<SemanticKind, EntityDefinition> = {
  project: {
    kind: 'project', schemaVersion: SEMANTIC_SCHEMA_VERSION, binding: 'projects',
    meaning: 'Saved project: current goal, lifecycle and expected outputs',
    approvedFields: ['name', 'goal', 'lifecycleState', 'expectedOutputs'],
  },
  decision: {
    kind: 'decision', schemaVersion: SEMANTIC_SCHEMA_VERSION, binding: 'chat_decisions (+ ai_chat_sessions.project_id)',
    meaning: 'Recorded decision with originating chat and explicit acceptance provenance; not any sentence expressing intent',
    approvedFields: ['text', 'status', 'recordedBy', 'acceptance', 'acceptedAt', 'reviewDate', 'sessionId', 'createdAt'],
  },
  task: {
    kind: 'task', schemaVersion: SEMANTIC_SCHEMA_VERSION, binding: 'tasks',
    meaning: 'Existing task record with current status and dates; no duplicate semantic task table',
    approvedFields: ['status', 'rawStatus', 'waitingOn', 'dueDate', 'archived', 'priority'],
  },
  source: {
    kind: 'source', schemaVersion: SEMANTIC_SCHEMA_VERSION, binding: 'notes | content_items | ai_chat_sessions',
    meaning: 'Canonical reference to readable evidence (note, document/article, original chat exchange)',
    approvedFields: ['sourceType', 'state', 'excerpt', 'publishedAt'],
  },
  risk: {
    kind: 'risk', schemaVersion: SEMANTIC_SCHEMA_VERSION, binding: 'project_register_items (kind = risk)',
    meaning: 'Existing register risk, only where present and explicitly linked',
    approvedFields: ['status', 'detail', 'linkedDecisionId', 'linkedTaskId'],
  },
};

export interface RelationshipDefinition {
  name: RelationshipName;
  from: readonly SemanticKind[];
  to: readonly SemanticKind[];
  cardinality: string;
  evidence: string;
  /** Origins that may satisfy a rule requiring this relationship. */
  satisfyingOrigins: readonly EdgeOrigin[];
  storage: string;
}

const EXPLICIT: readonly EdgeOrigin[] = ['explicit', 'user_confirmed'];

export const RELATIONSHIP_DEFINITIONS: Record<RelationshipName, RelationshipDefinition> = {
  belongs_to: {
    name: 'belongs_to', from: ['decision', 'task', 'risk'], to: ['project'], cardinality: 'many-to-one',
    evidence: 'Explicit saved project association', satisfyingOrigins: EXPLICIT,
    storage: 'ai_chat_sessions.project_id | tasks.project_id | project_register_items.project_id',
  },
  supported_by: {
    name: 'supported_by', from: ['decision'], to: ['source'], cardinality: 'many-to-many',
    evidence: 'Recorded supporting citation/link, not thematic similarity', satisfyingOrigins: EXPLICIT,
    storage: 'semantic_edges',
  },
  recorded_in: {
    name: 'recorded_in', from: ['decision'], to: ['source'], cardinality: 'many-to-one',
    evidence: 'Original chat exchange recording the decision', satisfyingOrigins: EXPLICIT,
    storage: 'chat_decisions.session_id',
  },
  implements: {
    name: 'implements', from: ['task'], to: ['decision'], cardinality: 'many-to-many',
    evidence: 'Explicit saved link or user-confirmed association', satisfyingOrigins: EXPLICIT,
    storage: 'semantic_edges',
  },
  affects: {
    name: 'affects', from: ['risk'], to: ['decision', 'task'], cardinality: 'many-to-many',
    evidence: 'Explicit register/source link with its provenance', satisfyingOrigins: EXPLICIT,
    storage: 'project_register_items.source_id (chat_decision) | project_register_items.task_id',
  },
  supersedes: {
    name: 'supersedes', from: ['decision'], to: ['decision'], cardinality: 'many-to-one',
    evidence: 'Recorded supersession with an effective date; AI cannot silently establish it',
    satisfyingOrigins: EXPLICIT, storage: 'semantic_edges',
  },
};

export type EdgeValidation = { ok: true } | { ok: false; code: string; reason: string };

/** Typed endpoint/origin validation. Existence (dangling) checks need live reads: see relationships.ts. */
export function validateEdgeShape(edge: Pick<SemanticEdge, 'relationship' | 'from' | 'to' | 'origin' | 'effectiveAt'>): EdgeValidation {
  const def = (RELATIONSHIP_DEFINITIONS as Partial<Record<string, RelationshipDefinition>>)[edge.relationship];
  if (def === undefined) return { ok: false, code: 'unknown_relationship', reason: `Unknown relationship "${edge.relationship}".` };
  if (!def.from.includes(edge.from.kind) || !def.to.includes(edge.to.kind)) {
    return { ok: false, code: 'invalid_endpoint', reason: `${edge.relationship} must connect ${def.from.join('/')} -> ${def.to.join('/')}, not ${edge.from.kind} -> ${edge.to.kind}.` };
  }
  if (edge.from.id.trim() === '' || edge.to.id.trim() === '') return { ok: false, code: 'dangling', reason: 'Both endpoints need an id.' };
  if (edge.from.kind === edge.to.kind && edge.from.id === edge.to.id) {
    return { ok: false, code: 'self_edge', reason: `A ${edge.from.kind} cannot ${edge.relationship} itself.` };
  }
  if (!['explicit', 'user_confirmed', 'inferred'].includes(edge.origin)) return { ok: false, code: 'invalid_origin', reason: 'Origin must be explicit, user_confirmed or inferred.' };
  if (edge.relationship === 'supersedes') {
    if (edge.origin === 'inferred') return { ok: false, code: 'inferred_supersession', reason: 'Supersession must be recorded by the user; it cannot be inferred.' };
    if (edge.effectiveAt === null || Number.isNaN(Date.parse(edge.effectiveAt))) return { ok: false, code: 'missing_effective_date', reason: 'Supersession needs a valid effective date.' };
  }
  return { ok: true };
}
