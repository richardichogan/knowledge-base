import { registerSpecialist } from '../registry.js';
import { parseChatResearchInput, runChatResearch } from '../../work/chatResearch.js';
import { NotFoundError, ValidationError } from '../../types/errors.js';

registerSpecialist({
  id: 'chat-researcher',
  name: 'Iris — Researcher',
  description: 'Multi-source public research from chat: research external topics first in small saved batches, then return the cited findings to Athena for any requested internal comparison. Produces a new Think research note and reports back in this chat. Does not require a Plan task. Supply researchBrief; use researchAction with jobId to resume or cancel.',
  subjectType: 'chat',
  resolveSubject: async (db, id) => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Research needs the current chat ID.');
    const result = await db.query<{ title: string | null }>('SELECT title FROM ai_chat_sessions WHERE id=$1', [id]);
    if (!result.rows[0]) throw new NotFoundError('Research chat');
    return { id, title: result.rows[0].title || 'Chat research', url: `/chat?session=${id}` };
  },
  parseInput: parseChatResearchInput,
  run: runChatResearch,
});
