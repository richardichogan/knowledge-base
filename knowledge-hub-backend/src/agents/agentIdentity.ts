/**
 * agents/agentIdentity.ts — which named workforce agent owns each AI feature, specialist,
 * workforce profile and scheduled job. The learning ledger, agent lessons and the Memory page
 * use these names, so every lesson reaches the agent whose work it came from.
 */
import { WORKFORCE_ROLES, type RoleId } from './workforce/contracts.js';

export type AgentId = RoleId | 'system';

const OWNERS: Record<RoleId, readonly string[]> = {
  athena: [
    'chat', 'chat-title', 'chat-summary', 'chat-rollup', 'chat-to-think', 'output-title', 'note-summary', 'next-steps',
    'decisions', 'passage-followup', 'task-assistance-assessment', 'task-assistance-assessor', 'memory-suggestions',
    'memory-review', 'agent-lesson-review', 'scheduled-prompt', 'knowledge-nightly-review', 'tagging-sweep',
    'archive-tasks', 'connections', 'foundry-backfill', 'task-review', 'task-message-drafter', 'goals-brief', 'goals-scorecard',
    'deal-desk', 'meeting-prep', 'content-package', 'cfp-abstract', 'goal-review',
  ],
  iris: ['task-researcher', 'chat-researcher', 'document-reading', 'document-review', 'deep-dive', 'blog-research', 'manual-blog-research'],
  calliope: [
    'blog-specialist', 'blog-writer', 'manual-blog-draft', 'manual-blog-revision', 'spark-blog', 'discover-blog',
    'discover-linkedin', 'discover-social', 'discovery-draft-refresh', 'job-publish-package', 'weekly-msft-social', 'weekly-msft-digest',
    'podcast-copy-fitting', 'podcast-blog-formatting', 'publishing',
  ],
  momus: [
    'discover-editorial', 'discovery-editorial-assessment', 'publishing-picks', 'discovery-editorial-review', 'weekly-job-editorial',
    'weekly-microsoft', 'podcast-independent-review', 'podcast-publication-reviewer', 'blog-verification',
    'manual-blog-critique', 'manual-blog-recheck',
  ],
  echo: [
    'podcast-prep', 'podcast-script', 'podcast-script-writer', 'podcast-coverage', 'podcast-show-notes-writer',
    'podcast-recording-teaser-writer',
  ],
  daedalus: [
    'use-case-spec', 'spec-draft', 'spec-writer', 'design-feedback', 'design-readiness', 'design-readiness-repair',
    'design-consistency', 'design-impact', 'design',
  ],
  // The diagram specialist keeps its historical job id 'daedalus'; it is Ariadne's work.
  ariadne: ['design-visual', 'blueprint-designer', 'diagram-designer', 'script-visual-designer', 'daedalus'],
  themis: ['trace-evaluation'],
  hephaestus: ['build-decompose'],
  argus: [
    'discover-picks', 'discover-watchlists', 'weekly-msft-job', 'weekly-msft-selection', 'weekly-msft-facts',
    'email-importance', 'morning-brief', 'morning-briefing',
  ],
  metis: ['metis-daily-insights'],
  socrates: ['quick-learning', 'learning-question-writer'],
};

const SYSTEM = new Set(['embeddings', 'unlabelled']);
const ROLE_IDS = new Set<string>(WORKFORCE_ROLES.map(r => r.id));
const OWNER = new Map<string, RoleId>(
  (Object.entries(OWNERS) as Array<[RoleId, readonly string[]]>).flatMap(([role, ids]) => ids.map(id => [id, role] as const)),
);

/** The named agent for a feature, specialist, profile or job id; undefined when it is not mapped. */
export function agentFor(id: string | undefined | null): AgentId | undefined {
  if (id === undefined || id === null || id === '') return undefined;
  if (ROLE_IDS.has(id)) return id as RoleId;
  if (SYSTEM.has(id)) return 'system';
  return OWNER.get(id);
}

/** The first candidate that names an agent; Athena owns anything unmapped. */
export function resolveAgent(...candidates: Array<string | undefined | null>): AgentId {
  for (const candidate of candidates) {
    const agent = agentFor(candidate);
    if (agent !== undefined) return agent;
  }
  return 'athena';
}
