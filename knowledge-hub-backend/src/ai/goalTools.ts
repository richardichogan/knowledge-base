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
import { goalsOverview, startGoalGeneration, startGoalReview } from '../goals/overview.js';
import { decideAdjustment, linkProject, linkTask, setMeasure } from '../goals/goalReview.js';

export const GOALS_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'manage_goals',
    description: 'Richard\'s four goals and Athena\'s weekly rhythm, shown on Today. Goals: imagine (2 Imagine proposals sent per quarter), practice (Advanced Specialisation submitted by 31 Jan 2027), voice (podcast every 14 days, 3 posts a week, 1 CFP a month), attention (inbox under 30, no open decision older than 14 days). '
      + 'status returns live health per goal and measure, this week\'s Monday brief (one move per goal, with any prepared draft or research) and the latest Friday scorecard (per-goal summary, honest date proposals for overdue tasks, Athena\'s own record and the tidy-up batch). Read status before any change and cite only what it returns. '
      + 'record_progress records a manual measure (imagine-proposals or cfp-month: count, default 1, negative to correct; advanced-specialisation: done true/false) with an optional note and date. '
      + 'refresh_brief or refresh_scorecard starts a regeneration in the background; read status again later. '
      + 'accept_move moves the task to in progress (or creates it in the goal\'s workstream); dismiss_move marks it "not this week". accept_date/dismiss_date decide a date proposal; accepting changes the task\'s due date. '
      + 'status also returns settings: pending monthly adjustments (proposed target/deadline/link changes), effective measures, overrides, lastReview and links (every workstream with its goal — a goal id, "none" for outside the goals, or null for undecided — plus open tasks in undecided workstreams). '
      + 'run_review starts the monthly review now in the background. accept_adjustment/dismiss_adjustment (id) decide a pending adjustment. set_measure (measureId, value: a whole-number target or a YYYY-MM-DD deadline) changes a goal measure; link_project (projectId, goalId or "none") links a workstream; link_task (taskId, goalId) moves a task into that goal\'s home workstream. Change settings only when Richard asks in this chat. '
      + 'apply_tidy archives stale tasks, drops stale decisions (or turns chosen ones into a Plan Inbox task, Think note or Spark in the chat\'s project via decisionActions) and files unfiled notes and chats in one batch, minus excluded item ids; use it ONLY when Richard explicitly asks in this chat, after listing the items. undo_tidy reverses a batch within 30 days. Nothing is ever sent.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'record_progress', 'refresh_brief', 'refresh_scorecard', 'accept_move', 'dismiss_move', 'accept_date', 'dismiss_date', 'apply_tidy', 'undo_tidy', 'run_review', 'accept_adjustment', 'dismiss_adjustment', 'set_measure', 'link_project', 'link_task'] },
      id: { type: 'string', description: 'Move id for accept_move/dismiss_move; date proposal id for accept_date/dismiss_date; batch id for undo_tidy; adjustment id for accept_adjustment/dismiss_adjustment.' },
      measureId: { type: 'string', description: 'Measure id from status (record_progress: imagine-proposals, cfp-month or advanced-specialisation; set_measure: any measure id).' },
      value: { type: ['integer', 'string'], description: 'set_measure: whole-number target or YYYY-MM-DD deadline.' },
      projectId: { type: 'string', description: 'Workstream id for link_project.' }, taskId: { type: 'string', description: 'Task id for link_task.' },
      goalId: { type: 'string', description: 'imagine, practice, voice, attention, or "none" (link_project only).' },
      count: { type: 'integer' }, done: { type: 'boolean' }, note: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, not in the future.' },
      excluded: { type: 'array', items: { type: 'string' }, description: 'For apply_tidy: tidy item ids Richard wants left alone.' },
      decisionActions: { type: 'object', additionalProperties: { type: 'string', enum: ['drop', 'task', 'note', 'spark'] }, description: 'For apply_tidy: drop-decision item id -> drop (default), task, note or spark, as Richard chose.' },
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
    case 'apply_tidy': return applyTidyBatch(db, args.excluded ?? [], 'athena', args.decisionActions ?? {});
    case 'undo_tidy': return undoTidyBatch(db, args.id, 'athena');
    case 'run_review': startGoalReview(db, 'athena'); return { started: 'review', note: 'The review runs in the background and usually takes a minute. Read status again to see proposed adjustments.' };
    case 'accept_adjustment': case 'dismiss_adjustment': return decideAdjustment(db, args.id, args.action === 'accept_adjustment');
    case 'set_measure': return setMeasure(db, args.measureId, args.value);
    case 'link_project': return linkProject(db, args.projectId, args.goalId);
    case 'link_task': return linkTask(db, args.taskId, args.goalId, 'athena');
    default: throw new ValidationError('Unknown goals action.');
  }
}

export const PROACTIVE_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'manage_proactive',
    description: 'Athena\'s proactive work towards Richard\'s goals. status returns: deal desk (one Think note per Imagine opportunity — ADNOC turnaround, Royal London complaints, IKEA, Reckitt — with the latest logged change and canUndo), '
      + 'meeting prep (prep cards from the latest Daily Briefing with attendees, last exchange, promises both ways, talking points and deal-brief link; proposed promises; chases on Waiting-on tasks; cadence nudges for Miha, Chad and Josh), '
      + 'the CFP shortlist and scheduled abstracts, and Athena\'s self-report (proposed/accepted/ignored/rejected per proposal type and which types are switched off). Read status before any change and cite only what it returns. '
      + 'run-deal-desk and refresh-meeting-prep start in the background; read status later. update-deal-from-notes (projectId, notes) updates one deal brief from pasted meeting notes now. deal-history (projectId); undo-deal-update (updateId) restores the previous writing if the note has not been edited since. '
      + 'accept-promise creates a task (Richard\'s promise) or a Waiting-on task (someone else\'s) plus a draft; accept-cadence creates a task and a draft; accept-chase creates the chase draft (chases carry suggested wording only until accepted); dismiss-promise/dismiss-cadence/dismiss-chase decline. '
      + 'Deal desk updates may carry a suggested follow-up (followUp) with no draft; create-deal-draft (updateId) creates it as a draft. No draft exists until Richard accepts. paused lists jobs or specialist agents Athena stopped after repeated failures, each with its question; resume-paused (id) tries again, stop-paused (id) leaves it stopped. timing shows peak-hour gating: proposals surface Mon–Fri 09:00–11:00 and 16:00–18:00 UK, at most three at a time; items marked held are waiting for the next window. confirm-cfp saves the CFP and schedules an abstract note and submission task at deadline minus 21 days; dismiss-cfp archives it. '
      + 'enable-proposal-type/disable-proposal-type (type) switch a kind of proposal on or off. Use decisions only when Richard asks in this chat. Drafts are never sent and CFPs are never submitted by Athena.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'run-deal-desk', 'update-deal-from-notes', 'deal-history', 'undo-deal-update', 'refresh-meeting-prep', 'accept-promise', 'dismiss-promise',
        'accept-cadence', 'dismiss-cadence', 'accept-chase', 'dismiss-chase', 'create-deal-draft', 'resume-paused', 'stop-paused', 'confirm-cfp', 'dismiss-cfp', 'enable-proposal-type', 'disable-proposal-type'] },
      id: { type: 'string', description: 'Promise, cadence, chase, CFP or pause id from status.' },
      projectId: { type: 'string', enum: ['imagine-turnaround', 'imagine-complaints-process', 'ikea', 'reckitt'] },
      notes: { type: 'string', description: 'Pasted meeting notes for update-deal-from-notes.' },
      updateId: { type: 'string' },
      type: { type: 'string', enum: ['goal-move', 'date-proposal', 'deal-followup', 'promise', 'chase', 'cadence', 'cfp', 'chat-next-step', 'goal-adjustment'] },
    }, required: ['action'] },
  },
};

export const DECIDE_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'manage_decide_queue',
    description: 'Today\'s Decide queue: everything waiting on Richard\'s decision, oldest first — publishing picks, open chat decisions from every chat, proactive proposals (held ones included), unsent email drafts and waiting tasks with nobody named (with Athena\'s guess). '
      + 'list returns every item with kind, refId, title, source, date and meta. Act on publishing picks with manage_publishing_feeds and on promise/chase/cadence/package/cfp/paused items with manage_proactive (id = refId). '
      + 'This tool decides chat decisions (decision-decided marks it decided, decision-drop drops it, decision-task/decision-note/decision-spark turn it into a Plan Inbox task, Think note or Spark and drop it), '
      + 'waiting tasks (waiting-on sets waitingOn on the task; waiting-skip hides the suggestion until the task changes) and unsent drafts (draft-delete moves the unsent draft note to Deleted, the same as Plan › Drafts Delete; sent drafts cannot be deleted). Act only when Richard asks in this chat.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'decision-decided', 'decision-drop', 'decision-task', 'decision-note', 'decision-spark', 'waiting-on', 'waiting-skip', 'draft-delete'] },
      id: { type: 'string', description: 'The item refId from list (decision id, task id or draft note id).' },
      waitingOn: { type: 'string', description: 'Who the task is waiting on, for waiting-on.' },
    }, required: ['action'] },
  },
};

export async function executeDecideTool(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const { decideQueue, decideAction } = await import('../goals/decide.js');
  if (args.action === 'list') return decideQueue(db);
  return decideAction(db, String(args.action), args, 'athena');
}

export async function executeProactiveTool(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const { proactiveOverview, proactiveAction } = await import('../goals/proactive.js');
  if (args.action === 'status') return proactiveOverview(db);
  const result = await proactiveAction(db, args.action, args, 'athena');
  return result && typeof result === 'object' && 'started' in result
    ? { ...result, note: 'Runs in the background and usually takes a minute or two. Read status again to see the result.' } : result;
}
