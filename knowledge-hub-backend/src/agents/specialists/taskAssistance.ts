import { registerSpecialist } from '../registry.js';
import { assistanceId, assistanceTask, parseAssistanceInput, requireApprovedAssistance, runTaskAssistance } from '../../work/taskAssistance.js';

for (const kind of ['research', 'email'] as const) {
  registerSpecialist({
    id: kind === 'research' ? 'task-researcher' : 'task-email-drafter',
    name: kind === 'research' ? 'Iris — Task researcher' : 'Email draft assistant',
    description: 'Executes only an existing user-approved task-assistance proposal. Research returns linked Think findings; email assistance drafts only. Assess and approve from the task view first.',
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
