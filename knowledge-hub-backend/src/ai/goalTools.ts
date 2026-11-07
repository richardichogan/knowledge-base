/**
 * ai/goalTools.ts — Athena reads and works Richard's four goals: health and measures, the Monday moves, the Friday
 * scorecard, honest date proposals and the tidy-up batch. Shares every service and safeguard with the Today panel.
 */
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { ValidationError } from '../types/errors.js';
import { recordGoalProgress } from '../goals/goals.js';
import { acceptGoalMove, dismissGoalMove } from '../goals/brief.js';
import { applyTidyBatch, decideDateProposal, undoTidyBatch } from '../goals/scorecard.js';
import { goalsOverview, startGoalGeneration } from '../goals/overview.js';

export const GOALS_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'manage_goals',
    description: 'Richard\'s four goals and Athena\'s weekly rhythm, shown on Today. Goals: imagine (2 Imagine proposals sent per quarter), practice (Advanced Specialisation submitted by 31 Jan 2027), voice (podcast every 14 days, 3 posts a week, 1 CFP a month), attention (inbox under 30, no open decision older than 14 days). '
      + 'status returns live health per goal and measure, this week\'s Monday brief (one move per goal, with any prepared draft or research) and the latest Friday scorecard (per-goal summary, honest date proposals for overdue tasks, Athena\'s own record and the tidy-up batch). Read status before any change and cite only what it returns. '
      + 'record_progress records a manual measure (imagine-proposals or cfp-month: count, default 1, negative to correct; advanced-specialisation: done true/false) with an optional note and date. '
      + 'refresh_brief or refresh_scorecard starts a regeneration in the background; read status again later. '
      + 'accept_move moves the task to in progress (or creates it in the goal\'s workstream); dismiss_move marks it "not this week". accept_date/dismiss_date decide a date proposal; accepting changes the task\'s due date. '
      + 'apply_tidy archives stale tasks, drops stale decisions and files unfiled notes and chats in one batch, minus excluded item ids; use it ONLY when Richard explicitly asks in this chat, after listing the items. undo_tidy reverses a batch within 30 days. Nothing is ever sent.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'record_progress', 'refresh_brief', 'refresh_scorecard', 'accept_move', 'dismiss_move', 'accept_date', 'dismiss_date', 'apply_tidy', 'undo_tidy'] },
      id: { type: 'string', description: 'Move id for accept_move/dismiss_move; date proposal id for accept_date/dismiss_date; batch id for undo_tidy.' },
      measureId: { type: 'string', enum: ['imagine-proposals', 'cfp-month', 'advanced-specialisation'] },
      count: { type: 'integer' }, done: { type: 'boolean' }, note: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, not in the future.' },
      excluded: { type: 'array', items: { type: 'string' }, description: 'For apply_tidy: tidy item ids Richard wants left alone.' },
    }, required: ['action'] },
  },
};

export async function executeGoalsTool(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  switch (args.action) {
    case 'status': return goalsOverview(db);
    case 'record_progress': return recordGoalProgress(db, args, 'athena');
    case 'refresh_brief': case 'refresh_scorecard': {
      const which = args.action === 'refresh_brief' ? 'brief' : 'scorecard';
      startGoalGeneration(db, which, 'athena');
      return { started: which, note: 'Generation runs in the background and usually takes a minute or two. Read status again to see it.' };
    }
    case 'accept_move': return acceptGoalMove(db, args.id, 'athena');
    case 'dismiss_move': return dismissGoalMove(db, args.id);
    case 'accept_date': case 'dismiss_date': return decideDateProposal(db, args.id, args.action === 'accept_date', 'athena');
    case 'apply_tidy': return applyTidyBatch(db, args.excluded ?? [], 'athena');
    case 'undo_tidy': return undoTidyBatch(db, args.id, 'athena');
    default: throw new ValidationError('Unknown goals action.');
  }
}
