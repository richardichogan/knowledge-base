import type { Pool } from 'pg';
import { reviewDecisions } from '../services/semantic/decisionReview.js';
import type { LlmToolDefinition } from './foundryClient.js';

export const REVIEW_DECISIONS_TOOL = 'review_decisions';

export const REVIEW_DECISIONS_DEFINITION: LlmToolDefinition = {
  type: 'function',
  function: {
    name: REVIEW_DECISIONS_TOOL,
    description:
      "Read-only review of a project's recorded decisions. Returns, per decision, four separate parts: the recorded decision with acceptance and supersession; " +
      'deterministic facts (review date, linked tasks and risks, rule results); an advisory assessment of newer evidence with counterevidence; and a suggested next step that is NOT executed. ' +
      'Acceptance "unknown" means it was never confirmed by the user. Never present an advisory assessment as fact or say a decision is revoked or invalid.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id. Defaults to the active conversation project; when there is none, decisions across ALL projects are reviewed. Never ask the user which project: omit this and call the tool.' },
        decisionId: { type: 'string', description: 'Review one decision only.' },
      },
      required: [],
    },
  },
};

export async function executeReviewDecisions(
  db: Pool, args: Record<string, unknown>, turn: { excludedIds?: ReadonlySet<string> | undefined; exclusionsFailed?: boolean | undefined; now?: Date },
): Promise<unknown> {
  if (turn.exclusionsFailed === true) return { error: 'Conversation exclusions could not be loaded, so decisions were not read. Try again.' };
  const projectId = typeof args['projectId'] === 'string' && args['projectId'].trim() !== '' ? args['projectId'].trim() : null;
  const decisionId = typeof args['decisionId'] === 'string' && args['decisionId'].trim() !== '' ? args['decisionId'].trim() : undefined;
  try {
    return await reviewDecisions(db, {
      projectId, decisionId, advisoryDisabled: process.env['SEMANTIC_ADVISORY_DISABLED'] === '1',
    }, { now: turn.now ?? new Date(), excludedIds: turn.excludedIds });
  } catch (err) {
    console.warn('[semantic] review_decisions failed:', err instanceof Error ? err.message : err);
    return { error: 'Decision review is unavailable right now; nothing was changed.' };
  }
}
