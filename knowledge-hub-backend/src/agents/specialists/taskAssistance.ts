import { registerSpecialist } from '../registry.js';
import { assessTaskAssistance, assistanceId, assistanceTask, parseAssistanceInput, requireApprovedAssistance, runTaskAssistance } from '../../work/taskAssistance.js';
import { ValidationError } from '../../types/errors.js';

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
    return { ownerId };
  },
  run: async context => {
    const ownerId = context.input['ownerId'];
    if (typeof ownerId !== 'string') throw new ValidationError('Task help assessment requires an authenticated owner.');
    const task = await assistanceTask(context.db, context.subjectId);
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

for (const kind of ['research', 'email', 'support'] as const) {
  registerSpecialist({
    id: kind === 'research' ? 'task-researcher' : kind === 'email' ? 'task-email-drafter' : 'task-preparation-assistant',
    name: kind === 'research' ? 'Iris — Task researcher' : kind === 'email' ? 'Hermes — Email draft assistant' : 'Task preparation assistant',
    description: 'Executes only an existing user-approved task-assistance proposal. Research returns linked Think findings; email assistance drafts only; preparation supports tasks without claiming unavailable actions. Assess and approve from the task view first.',
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
