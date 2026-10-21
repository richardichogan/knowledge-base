export type WatchRelationship = 'competitor' | 'partner' | 'platform-provider' | 'market-reference';
export type WatchClaimKind = 'positioning' | 'announced-capability' | 'documented-availability' | 'customer-outcome';
export interface WatchEntity { name: string; relationship: WatchRelationship }
export interface WatchBaseline { text: string; links: string[] }
export interface WatchBaselineVersion { version: number; baseline: WatchBaseline; createdAt: string }
export interface WatchlistInput {
  name: string;
  description: string;
  question: string;
  /** Extra words for the per-entity web searches, e.g. "Microsoft partner". */
  searchContext?: string;
  entities: WatchEntity[];
  criteria: string[];
  projectIds: string[];
  sourceIds: string[];
  baseline: WatchBaseline;
  cadence: 'daily' | 'weekly';
  paused: boolean;
}
export interface Watchlist {
  id: string;
  config: WatchlistInput;
  revision: number;
  baselineVersion: number;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  lastRun: { status: WatchRunStatus; startedAt: string; summary: string } | null;
}
export type WatchRunStatus = 'running' | 'changes' | 'no_meaningful_change' | 'insufficient_coverage' | 'failed';
export interface WatchEvidence {
  id: string; title: string; url: string; publishedAt: string; excerpt: string;
  eventKey: string; syndicatedIds: string[]; entities: string[];
}
export type WatchProjectAssessment = {
  projectId: string; projectName: string; impact: string; watchNext?: string;
} & ({
  relationship: 'confirmed-overlap' | 'possible-relevance' | 'insufficient-context';
  relevance?: never;
} | {
  relevance: 'high' | 'medium' | 'low' | 'no-material-impact' | 'insufficient-evidence';
  relationship?: 'confirmed-overlap' | 'possible-relevance' | 'insufficient-context';
});
export interface WatchFinding {
  entity: string; criterion: string; kind: WatchClaimKind;
  changed: string; matters: string; uncertainty: string; response: string; evidenceIds: string[];
  field?: string;
  microsoftInvolvement?: string;
  projectImpact?: string;
  headline?: string;
  evidenceHighlight?: { text: string; evidenceIds: string[] };
  watchNext?: { statement: string; evidenceIds: string[] };
  projectAssessments?: WatchProjectAssessment[];
}
export interface WatchCoverage {
  matched: number; uniqueEvents: number; sourcesChecked: number; sourcesHealthy: number;
  webSearches?: number; webFailures?: number;
  missingEntities: string[]; truncated: boolean;
}
export interface WatchRun {
  id: string; watchlistId: string; baselineVersion: number; baseline: WatchBaseline;
  config: WatchlistInput; startedAt: string; completedAt: string | null; windowStart: string;
  status: WatchRunStatus; summary: string; coverage: Partial<WatchCoverage>; evidence: WatchEvidence[];
  findings: Array<WatchFinding & { id: string }>;
}
export interface InterestWeight { kind: 'topic' | 'source'; term: string; weight: number }
