/** A decision's semantic state: user-confirmed acceptance, review date and its links. */
export interface SemanticEdgeView {
  relationship: 'implements' | 'supersedes' | 'supported_by' | 'belongs_to' | 'recorded_in' | 'affects';
  from: { kind: string; id: string };
  to: { kind: string; id: string };
  origin: 'explicit' | 'user_confirmed' | 'inferred';
  effectiveAt: string | null;
}

export interface DecisionSemantics {
  id: string;
  status: string;
  acceptance: 'accepted' | 'unknown';
  acceptedAt: string | null;
  reviewDate: string | null;
  supersession: { state: 'current' | 'superseded' | 'invalid' | 'unknown' } & Record<string, unknown>;
  edges: SemanticEdgeView[];
}

export type DecisionLinkRelationship = 'implements' | 'supersedes' | 'superseded_by';

export interface DecisionLinkInput {
  relationship: DecisionLinkRelationship;
  counterpartId: string;
  effectiveAt?: string;
}
