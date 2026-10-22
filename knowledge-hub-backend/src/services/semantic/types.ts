/** Shared contracts for the Athena-native semantic layer (spec section 17). */

export const SEMANTIC_KINDS = ['project', 'decision', 'task', 'source', 'risk'] as const;
export type SemanticKind = typeof SEMANTIC_KINDS[number];

/** Structurally compatible with the knowledge layer's `KnowledgeRef`. */
export interface SemanticRef { kind: SemanticKind; id: string }

export type EdgeOrigin = 'explicit' | 'user_confirmed' | 'inferred';
export type Acceptance = 'accepted' | 'unknown';
export type RecordOrigin = 'human' | 'ai-generated' | 'imported' | 'unknown';

export interface SemanticRecord {
  ref: SemanticRef;
  title: string;
  projectId: string | null;
  /** Approved fields only; never a second mutable copy of the domain record. */
  fields: Record<string, unknown>;
  origin: RecordOrigin;
  /** Content hash of the approved fields, so results can cite the exact input revision. */
  version: string;
  sourceUpdatedAt: string | null;
  readAt: string;
}

export type SemanticAccess =
  | { status: 'ok'; data: SemanticRecord }
  | { status: 'not_found' }
  | { status: 'excluded' }
  | { status: 'unavailable'; code: string };

export type RelationshipName = 'belongs_to' | 'supported_by' | 'recorded_in' | 'implements' | 'affects' | 'supersedes';

export interface SemanticEdge {
  relationship: RelationshipName;
  from: SemanticRef;
  to: SemanticRef;
  origin: EdgeOrigin;
  /** Supersession only: when the replacement takes effect (ISO timestamp). */
  effectiveAt: string | null;
  /** Where the link is stored today; existing links are mapped, not copied. */
  storage: string;
}

export type RuleOutcome = 'matched' | 'not_matched' | 'unknown';
export type Applicability = 'applicable' | 'not_applicable' | 'unknown';

export interface RuleResult {
  ruleId: string;
  ruleVersion: number;
  evaluatedAt: string;
  refs: SemanticRef[];
  outcome: RuleOutcome;
  applicability: Applicability;
  /** Approved input values the outcome was computed from. */
  inputs: Record<string, unknown>;
  unavailable?: { code: string; reason: string };
  sourceVersions: Record<string, string>;
  explanation: string;
}

export interface SemanticContext {
  now: Date;
  /** Session exclusions: ids (or `kind:id`) that must not be read or leaked. */
  excludedIds?: ReadonlySet<string> | undefined;
}
