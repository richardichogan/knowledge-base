import { createHash } from 'node:crypto';
import { ValidationError } from '../../types/errors.js';

export const WORKFORCE_VERSION = 1;
export const AGENT_PROTOCOL_VERSION = 2;
export const AGENT_LEASE_MS = 60_000;
export const AGENT_HEARTBEAT_MS = 15_000;
export const AGENT_MAX_ATTEMPTS = 3;
const MAX_BRIEF_TEXT = 4_000;
const MAX_SCOPE_SOURCES = 100;
const MAX_SCOPE_EXCLUSIONS = 1_000;
const MAX_REVIEW_FINDINGS = 200;
export const ASSIGNMENT_STATES = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'superseded'] as const;
export type AssignmentState = typeof ASSIGNMENT_STATES[number];
export type Readiness = 'pending' | 'ready' | 'blocked';
export type RoleId = 'athena' | 'iris' | 'calliope' | 'momus' | 'echo' | 'daedalus' | 'ariadne'
  | 'themis' | 'hephaestus' | 'argus' | 'metis' | 'socrates';

export const WORKFORCE_ROLES: ReadonlyArray<{ id: RoleId; name: string; title: string }> = [
  { id: 'athena', name: 'Athena', title: 'Orchestrator' },
  { id: 'iris', name: 'Iris', title: 'Researcher' },
  { id: 'calliope', name: 'Calliope', title: 'Author' },
  { id: 'momus', name: 'Momus', title: 'Editorial critic' },
  { id: 'echo', name: 'Echo', title: 'Podcast producer' },
  { id: 'daedalus', name: 'Daedalus', title: 'Product architect' },
  { id: 'ariadne', name: 'Ariadne', title: 'Visual designer' },
  { id: 'themis', name: 'Themis', title: 'Verifier' },
  { id: 'hephaestus', name: 'Hephaestus', title: 'Build coordinator' },
  { id: 'argus', name: 'Argus', title: 'Intelligence analyst' },
  { id: 'metis', name: 'Metis', title: 'Work analyst' },
  { id: 'socrates', name: 'Socrates', title: 'Learning tutor' },
];

export interface SourceVersion {
  type: string;
  id: string;
  version: string;
}

export interface AssignmentScope {
  sources: SourceVersion[];
  excludedSourceIds: string[];
  projectId: string | null;
  readOnly: boolean;
}

export type AssignmentOrigin =
  | { kind: 'app'; requestId: string }
  | { kind: 'chat'; requestId: string; conversationId: string }
  | { kind: 'schedule'; requestId: string; scheduleId: string; runId: string; revision: number };

export interface AssignmentBrief {
  ownerId: string;
  workflow: string;
  workflowVersion: number;
  policyProfile: string;
  subjectType: string;
  subjectId: string;
  instruction: string;
  origin: AssignmentOrigin;
  scope: AssignmentScope;
}

export interface Assignment {
  id: string;
  brief: AssignmentBrief;
  workerPool: string;
  status: AssignmentState;
  readiness: Readiness;
  revision: number;
  budgetProfileId: string;
  deadline: Date;
  reason: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface StepDefinition {
  key: string;
  role: RoleId;
  profile: string;
  promptVersion: number;
  outputType: string;
}

export interface ArtifactReference {
  id: string;
  type: string;
  revision: string;
  signature: string;
}

export function parseArtifactReference(value: unknown): ArtifactReference {
  const input = record(value, 'Artifact reference');
  const signature = text(input['signature'], 'Artifact signature');
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new ValidationError('An exact SHA-256 artifact signature is required.');
  return {
    id: text(input['id'], 'Domain artifact ID'), type: text(input['type'], 'Domain artifact type'),
    revision: text(input['revision'], 'Domain artifact revision'), signature,
  };
}

export interface ReviewFinding {
  artifact: ArtifactReference;
  field: string;
  quote: string;
  classification: 'advisory' | 'major-risk' | 'incomplete-review' | 'invalid-contract';
  reason: string;
  correction: string;
  sources: SourceVersion[];
}

export function parseReviewFindings(
  value: unknown, artifact: ArtifactReference, fields: Readonly<Record<string, string>>, sources: SourceVersion[],
): ReviewFinding[] {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_FINDINGS) throw new ValidationError('The critic must return a bounded array of findings.');
  const allowedFields = new Set(['artifact', 'field', 'quote', 'classification', 'reason', 'correction', 'sources']);
  const sourceKeys = new Set(sources.map(source => contentSignature(source)));
  return value.map(value => {
    const finding = record(value, 'Review finding');
    if (Object.keys(finding).length !== allowedFields.size || Object.keys(finding).some(key => !allowedFields.has(key))) {
      throw new ValidationError('The critic can return findings only, never edits or approval instructions.');
    }
    if (contentSignature(finding['artifact']) !== contentSignature(artifact)) throw new ValidationError('The finding does not review the current artifact revision.');
    const field = text(finding['field'], 'Reviewed field');
    const quote = text(finding['quote'], 'Exact reviewed quotation');
    if (!Object.hasOwn(fields, field) || !fields[field]?.includes(quote)) throw new ValidationError('The finding must identify exact text in the reviewed artifact.');
    const classification = finding['classification'];
    if (classification !== 'advisory' && classification !== 'major-risk' && classification !== 'incomplete-review' && classification !== 'invalid-contract') {
      throw new ValidationError('The review finding has an invalid classification.');
    }
    if (!Array.isArray(finding['sources']) || finding['sources'].length > MAX_SCOPE_SOURCES) throw new ValidationError('Finding evidence must be explicitly supplied.');
    const checkedSources = finding['sources'].map(parseSourceVersion);
    if (checkedSources.some(source => !sourceKeys.has(contentSignature(source)))) throw new ValidationError('A finding cited evidence outside this assignment or at a different version.');
    return {
      artifact, field, quote, classification, reason: text(finding['reason'], 'Finding reason'),
      correction: text(finding['correction'], 'Correction objective'), sources: checkedSources,
    };
  });
}

export interface BudgetLimits {
  calls: number;
  tokens: number;
  durationMs: number;
}

const TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> = {
  queued: ['running', 'waiting', 'failed', 'cancelled', 'superseded'],
  running: ['waiting', 'completed', 'failed', 'cancelled', 'superseded'],
  waiting: ['running', 'failed', 'cancelled', 'superseded'],
  completed: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

export function canTransition(from: AssignmentState, to: AssignmentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalAssignment(state: AssignmentState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_BRIEF_TEXT) throw new ValidationError(`${label} is required and must be bounded.`);
  return value.trim();
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ValidationError(`${label} must be a positive safe integer.`);
  return value;
}

export function parseBudgetLimits(value: unknown): BudgetLimits {
  const input = record(value, 'Budget limits');
  return {
    calls: positiveInteger(input['calls'], 'Call limit'),
    tokens: positiveInteger(input['tokens'], 'Token limit'),
    durationMs: positiveInteger(input['durationMs'], 'Assignment duration limit'),
  };
}

export function parseSourceVersion(value: unknown): SourceVersion {
  const input = record(value, 'Source version');
  return { type: text(input['type'], 'Source type'), id: text(input['id'], 'Source ID'), version: text(input['version'], 'Source version') };
}

export function parseAssignmentBrief(value: unknown): AssignmentBrief {
  const input = record(value, 'Assignment');
  const origin = record(input['origin'], 'Assignment origin');
  const requestId = text(origin['requestId'], 'Request ID');
  let parsedOrigin: AssignmentOrigin;
  if (origin['kind'] === 'app') parsedOrigin = { kind: 'app', requestId };
  else if (origin['kind'] === 'chat') parsedOrigin = { kind: 'chat', requestId, conversationId: text(origin['conversationId'], 'Conversation ID') };
  else if (origin['kind'] === 'schedule') {
    if (typeof origin['revision'] !== 'number' || !Number.isSafeInteger(origin['revision']) || origin['revision'] < 0) {
      throw new ValidationError('The schedule revision is required.');
    }
    parsedOrigin = {
      kind: 'schedule', requestId, scheduleId: text(origin['scheduleId'], 'Schedule ID'),
      runId: text(origin['runId'], 'Schedule run ID'), revision: origin['revision'],
    };
  } else throw new ValidationError('The assignment origin is invalid.');
  const scope = record(input['scope'], 'Source scope');
  if (!Array.isArray(scope['sources']) || !scope['sources'].length || scope['sources'].length > MAX_SCOPE_SOURCES) {
    throw new ValidationError('An explicit, bounded set of versioned sources is required.');
  }
  if (!Array.isArray(scope['excludedSourceIds']) || scope['excludedSourceIds'].length > MAX_SCOPE_EXCLUSIONS) {
    throw new ValidationError('Source exclusions must be supplied explicitly.');
  }
  if (typeof scope['readOnly'] !== 'boolean') throw new ValidationError('The source read-only restriction is required.');
  const sources = scope['sources'].map(parseSourceVersion);
  const exclusions = [...new Set(scope['excludedSourceIds'].map(id => text(id, 'Excluded source ID')))].sort();
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.type}:${source.id}`;
    if (seen.has(key)) throw new ValidationError('A source can have only one controlling version.');
    if (exclusions.includes(source.id) || exclusions.includes(key)) throw new ValidationError('An excluded source cannot be commissioned.');
    seen.add(key);
  }
  return {
    ownerId: text(input['ownerId'], 'Assignment owner'),
    workflow: text(input['workflow'], 'Workflow'),
    workflowVersion: positiveInteger(input['workflowVersion'], 'Workflow version'),
    policyProfile: text(input['policyProfile'], 'Policy profile'),
    subjectType: text(input['subjectType'], 'Subject type'),
    subjectId: text(input['subjectId'], 'Subject ID'),
    instruction: text(input['instruction'], 'Agreed instruction'),
    origin: parsedOrigin,
    scope: {
      sources, excludedSourceIds: exclusions, readOnly: scope['readOnly'],
      projectId: scope['projectId'] === null ? null : text(scope['projectId'], 'Project ID'),
    },
  };
}

export function contentSignature(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stable(child)]));
    }
    return item;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function commissionSignature(brief: AssignmentBrief): string {
  return contentSignature({
    ...brief, origin: { ...brief.origin, requestId: undefined },
    scope: { ...brief.scope, sources: [...brief.scope.sources].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)) },
  });
}

export const MANUAL_BLOG_STEPS = {
  research: { key: 'research', role: 'iris', profile: 'manual-blog-research', promptVersion: 1, outputType: 'blog-evidence' },
  draft: { key: 'draft', role: 'calliope', profile: 'manual-blog-draft', promptVersion: 1, outputType: 'blog-draft' },
  critique: { key: 'critique', role: 'momus', profile: 'manual-blog-critique', promptVersion: 1, outputType: 'blog-review' },
  revision: { key: 'revision', role: 'calliope', profile: 'manual-blog-revision', promptVersion: 1, outputType: 'blog-draft' },
  recheck: { key: 'recheck', role: 'momus', profile: 'manual-blog-recheck', promptVersion: 1, outputType: 'blog-review' },
} as const satisfies Record<string, StepDefinition>;
