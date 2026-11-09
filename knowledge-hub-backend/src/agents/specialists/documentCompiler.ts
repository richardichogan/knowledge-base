import { registerSpecialist } from '../registry.js';
import { parseDocumentCompilerInput, runDocumentCompiler } from '../../work/documentCompiler.js';
import { NotFoundError, ValidationError } from '../../types/errors.js';

registerSpecialist({
  id: 'document-compiler',
  name: 'Iris — Document compiler',
  description: 'Combines MANY Library documents (more than about three, or any set too large to read within one answer) into ONE new Think note: reads each document in turn in the background, saves a section per document, and applies the user\'s instruction to every section (e.g. strip a topic, keep only requirements). Find the documents first with search_library and pass their IDs in compileBrief. Never read the whole set yourself in the chat turn.',
  subjectType: 'chat',
  resolveSubject: async (db, id) => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Compiling documents needs the current chat ID.');
    const result = await db.query<{ title: string | null }>('SELECT title FROM ai_chat_sessions WHERE id=$1', [id]);
    if (!result.rows[0]) throw new NotFoundError('Compile chat');
    return { id, title: result.rows[0].title || 'Document compilation', url: `/chat?session=${id}` };
  },
  parseInput: parseDocumentCompilerInput,
  run: runDocumentCompiler,
});
