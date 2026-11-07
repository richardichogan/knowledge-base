import { registerSpecialist } from '../registry.js';
import { approveTaskAssistance, assessTaskAssistance, assistanceId, TASK_ASSISTANCE_SPECIALISTS, assistanceTask, parseAssistanceInput, requireApprovedAssistance, runTaskAssistance } from '../../work/taskAssistance.js';
import { ValidationError } from '../../types/errors.js';
import type { SpecialistContext, SpecialistResult } from '../registry.js';

const MAX_OWNER_ID_LENGTH = 200;

registerSpecialist({
  id: 'task-assistance-assessor',
  name: 'Athena — task help assessment',
  description: 'Prepares a proposal for how Athena could help with a new task. It does not research, draft, or change anything until you approve.',
  subjectType: 'task',
  resolveSubject: async (db, id) => {
    const task = await assistanceTask(db, id);
    return { id: task.id, title: task.title, url: `/plan?taskId=${encodeURIComponent(task.id)}` };
  },
  parseInput: input => {
    const ownerId = input['ownerId'];
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > MAX_OWNER_ID_LENGTH) {
      throw new ValidationError('Task help assessment requires an authenticated owner.');
    }
    if (input['scheduled'] !== undefined && input['scheduled'] !== true) throw new ValidationError('Invalid scheduled review flag.');
    return { ownerId, ...(input['scheduled'] === true ? { scheduled: true } : {}) };
  },
  run: async context => {
    const ownerId = context.input['ownerId'];
    if (typeof ownerId !== 'string') throw new ValidationError('Task help assessment requires an authenticated owner.');
    const scheduled = context.input['scheduled'] === true;
    const task = await assistanceTask(context.db, context.subjectId);
    if (scheduled && task.status !== 'completed') return scheduledReview(context, ownerId);
    const recurring = (await context.db.query<{ recurring_parent_id: string | null }>(
      'SELECT recurring_parent_id FROM tasks WHERE id=$1', [task.id])).rows[0]?.recurring_parent_id;
    if (task.status === 'inbox' || task.status === 'completed' || task.recurringCadence || recurring) {
      return {
        data: { taskId: task.id, skipped: true, url: `/plan?taskId=${encodeURIComponent(task.id)}` },
        summary: 'Automatic help was not assessed: Inbox tasks wait for acceptance, and completed or recurring tasks are excluded. No research or drafting started.',
      };
    }
    context.progress('Preparing a proposal for how Athena could help. No work will start without your approval.');
    const assessment = await assessTaskAssistance(context.db, context.subjectId, ownerId, '');
    return {
      data: { taskId: context.subjectId, proposalId: assessment.id, url: `/plan?taskId=${encodeURIComponent(context.subjectId)}` },
      summary: 'How Athena could help is ready for your review. No research or drafting has started.',
    };
  },
});

/** The twice-daily review: propose help for any open task, and start research straight away (it only reads and writes a Think note). */
async function scheduledReview(context: SpecialistContext, ownerId: string): Promise<SpecialistResult> {
  context.progress('Scheduled review: checking whether Athena can help with this task. Emails and messages wait for your approval.');
  const assessment = await assessTaskAssistance(context.db, context.subjectId, ownerId, '');
  const url = `/plan?taskId=${encodeURIComponent(context.subjectId)}`;
  if (assessment.proposal.kind === 'research') {
    try {
      await approveTaskAssistance(context.db, context.subjectId, ownerId, assessment.id);
      return { data: { taskId: context.subjectId, proposalId: assessment.id, autoStarted: true, url },
        summary: 'Scheduled review: Iris has started the proposed research. Findings will be linked to the task; nothing else changed.' };
    } catch (error) {
      context.progress(`Research was proposed but could not start automatically: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return { data: { taskId: context.subjectId, proposalId: assessment.id, url },
    summary: 'Scheduled review: a proposal for how Athena could help is ready for your review. Nothing has been drafted or sent.' };
}

for (const kind of ['research', 'email', 'message', 'support'] as const) {
  registerSpecialist({
    id: TASK_ASSISTANCE_SPECIALISTS[kind],
    name: kind === 'research' ? 'Iris — Task researcher' : kind === 'email' ? 'Hermes — Email draft assistant'
      : kind === 'message' ? 'Hermes — Slack/Teams message drafter' : 'Task preparation assistant',
    description: 'Executes only an existing user-approved task-assistance proposal. Research returns linked Think findings; email and Slack/Teams message assistance drafts only (Plan > Drafts), never sends; preparation supports tasks without claiming unavailable actions. Assess and approve from the task view first.',
    subjectType: 'task',
    resolveSubject: async (db, id) => {
      const task = await assistanceTask(db, id);
      return { id: task.id, title: task.title, url: `/plan?taskId=${encodeURIComponent(task.id)}` };
    },
    parseInput: parseAssistanceInput,
    overwrites: (_db, _id, input) => Promise.resolve(input['replaceRevision'] !== undefined),
    prerequisites: async (db, id, input) => {
      await requireApprovedAssistance(db, id, assistanceId(input['proposalId']), kind);
      return [];
    },
    run: context => runTaskAssistance(context, kind),
  });
}
