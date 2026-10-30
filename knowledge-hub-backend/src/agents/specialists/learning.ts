import { registerSpecialist } from '../registry.js';
import { getLearningSession } from '../../learning/store.js';
import { prepareLearningSession } from '../../learning/agent.js';

registerSpecialist({
  id: 'learning-question-writer',
  name: 'Learning question writer',
  description: 'Prepares a personalised ten-question Microsoft/GitHub learning session from official documentation, preserving older session sizes and requiring independent evidence review before admission.',
  subjectType: 'learning-session',
  resolveSubject: async (db, id) => {
    const session = await getLearningSession(db, id);
    return { id: session.id, title: 'Quick learning', url: `/learn?session=${session.id}` };
  },
  run: async context => {
    const count = await prepareLearningSession(context);
    return { data: { sessionId: context.subjectId, url: `/learn?session=${context.subjectId}` },
      summary: `${count} source-checked learning questions are ready. Each question's sources will be checked again before it is shown.` };
  },
});
