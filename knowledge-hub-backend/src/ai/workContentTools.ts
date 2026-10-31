import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { BRIEF_HEADINGS, createWorkContent, getWorkContent, noteId, parseSources, saveWorkContent, workMarkdown } from '../work/workContent.js';
import { ValidationError, ConflictError } from '../types/errors.js';
import { getExcludedSources } from './contextUsage.js';

export const WORK_WRITE_TOOLS = ['create_deliverable_brief', 'create_email_draft', 'update_deliverable_brief', 'update_email_draft'];
export const WORK_TOOL_NAMES = new Set([...WORK_WRITE_TOOLS, 'read_work_content']);
const WORK_BODY_PAGE_SIZE = 16_000;
export interface WorkTurnState {
  reads: Map<string, { revision: number; noteRevision: number; bodyRead: boolean; nextOffset: number | null }>;
  changedNoteIds: string[];
}
const sourceSchema = { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false,
  properties: { type: { type: 'string', enum: ['note', 'document'] }, id: { type: 'string' } }, required: ['type', 'id'] } };
const briefFields = {
  taskId: { type: 'string' }, targetFolder: { type: 'string', description: 'Exact OneDrive/Athena/<Project>/folder; no guessed destination.' },
  fileName: { type: 'string', description: 'Exact .docx, .pptx, .xlsx or .pdf name approved by Richard.' }, sources: sourceSchema,
};
const emailFields = { taskId: { type: 'string' }, briefId: { type: 'string' },
  to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' } };
export const WORK_CONTENT_TOOLS: LlmToolDefinition[] = [
  { type: 'function', function: { name: 'read_work_content',
    description: 'Read a Deliverable brief or Email draft from Think, including actual structured fields, revision, linked task and produced-file state. Body is paged; continue until nextOffset is null before claiming a full read. Read before changing anything.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      noteId: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
    }, required: ['noteId'] } } },
  ...(['deliverable_brief', 'email_draft'] as const).flatMap(kind => {
    const brief = kind === 'deliverable_brief';
    const fields = brief ? briefFields : emailFields;
    return [
      { type: 'function' as const, function: { name: `create_${kind}`,
        description: brief
          ? 'Create a task-linked Deliverable brief in Think for Athena to develop using the existing note editor with definition of done, evidence, decisions, specification and target-path headings. Keep the workflow in Athena and Think. Ask about unspecified format, destination or decisions. No task closure or external actions.'
          : 'Create one task-linked Email draft in Think. IBM Graph is unavailable: Richard reviews, copies and sends it manually. Never send via Alliance, or claim the draft was sent. Use supplied recipients and subject; ask about unresolved details.',
        parameters: { type: 'object', additionalProperties: false, properties: {
          title: { type: 'string' }, body: { type: 'string', description: brief
            ? `Markdown body with these exact five section headings: ${BRIEF_HEADINGS.join('; ')}.`
            : 'Markdown email body; do not invent recipients or sending status.' }, ...fields,
        }, required: ['title', 'taskId', ...(brief ? ['targetFolder', 'fileName', 'sources'] : ['to', 'subject', 'body'])] } } },
      { type: 'function' as const, function: { name: `update_${kind}`,
        description: `Persist explicitly requested changes to the open ${brief ? 'Deliverable brief' : 'Email draft'} using the normal revision-checked service. Read first. Omit untouched fields; body is a complete Markdown replacement only after reading all pages. Sent records cannot be rewritten. Does not mark Sent, change task status or send anything.`,
        parameters: { type: 'object', additionalProperties: false, properties: {
          noteId: { type: 'string' }, revision: { type: 'integer' }, noteRevision: { type: 'integer' },
          body: { type: 'string' }, ...fields,
        }, required: ['noteId', 'revision', 'noteRevision'] } } },
    ];
  }),
];
export async function executeWorkTool(db: Pool, name: string, args: Record<string, unknown>, access: {
  noteId?: string | undefined; excludedIds?: ReadonlySet<string> | undefined; exclusionsFailed?: boolean | undefined;
  sessionId?: string | undefined;
  strictProjectId?: string | null | undefined; readOnly?: boolean | undefined; workState?: WorkTurnState | undefined;
}): Promise<unknown> {
  if (access.exclusionsFailed) throw new ValidationError('Source exclusions are unavailable; work-content access is withheld.');
  const excluded = new Set(access.excludedIds ?? []);
  if (access.sessionId) for (const source of await getExcludedSources(db, access.sessionId)) excluded.add(source.id);
  if (WORK_WRITE_TOOLS.includes(name) && access.readOnly) throw new ValidationError('This turn is read-only.');
  const checkNote = async (id: string): Promise<void> => {
    const aliases = await db.query<{ id: string }>("SELECT id::text FROM content_items WHERE source='note' AND source_id=$1", [id]);
    if (excluded.has(id) || aliases.rows.some(alias => excluded.has(alias.id))) throw new ValidationError('This note is excluded from this conversation.');
    if (access.strictProjectId) {
      const match = await db.query("SELECT id FROM notes WHERE id=$1 AND project_id=$2 AND status='active'", [id, access.strictProjectId]);
      if (!match.rowCount) throw new ValidationError('The note is outside the enforced project scope.');
    }
  };
  if (args.sources !== undefined) for (const ref of parseSources(args.sources)) {
    if (excluded.has(ref.id)) throw new ValidationError('A cited source is excluded from this conversation.');
    if (ref.type === 'document') {
      const doc = (await db.query<{ source: string; source_id: string }>('SELECT source,source_id FROM content_items WHERE id=$1', [ref.id])).rows[0];
      if (doc && excluded.has(doc.source_id)) throw new ValidationError('The underlying cited source is excluded from this conversation.');
    }
    if (ref.type === 'note') await checkNote(ref.id);
    else if (access.strictProjectId) {
      const match = await db.query('SELECT id FROM content_items WHERE id=$1 AND project_context=$2', [ref.id, access.strictProjectId]);
      if (!match.rowCount) throw new ValidationError('A source is outside the enforced project scope.');
    }
  }
  if (name.startsWith('create_')) {
    if (access.strictProjectId) {
      const task = await db.query('SELECT id FROM tasks WHERE id=$1 AND project_id=$2 AND NOT archived', [args.taskId, access.strictProjectId]);
      if (!task.rowCount) throw new ValidationError('The task is outside the enforced project scope.');
    }
    const created = await createWorkContent(db, name === 'create_deliverable_brief' ? 'deliverable-brief' : 'email-draft', args);
    access.workState?.changedNoteIds.push(created.noteId);
    return { ...created, title: args.title, url: `/think?noteId=${created.noteId}`, saved: true,
      instructions: 'Created in Think. Return the exact saved noteId and a clickable link using url. Athena develops content in Think; IBM sending remains manual. No task was closed.' };
  }
  const id = noteId(args.noteId);
  await checkNote(id);
  const current = await getWorkContent(db, id);
  if (name === 'read_work_content') {
    const offset = args.offset ?? 0;
    const body = await workMarkdown(db, id);
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > body.length) throw new ValidationError('Invalid body offset.');
    const chunk = body.slice(offset, offset + WORK_BODY_PAGE_SIZE);
    const nextOffset = offset + chunk.length < body.length ? offset + chunk.length : null;
    const previous = access.workState?.reads.get(id);
    const contiguous = offset === 0 || previous?.revision === current.revision && previous.noteRevision === current.noteRevision && previous.nextOffset === offset;
    access.workState?.reads.set(id, { revision: current.revision, noteRevision: current.noteRevision, bodyRead: contiguous && nextOffset === null,
      nextOffset: contiguous ? nextOffset : null });
    return { ...current, body: chunk, bodyFormat: 'markdown', offset, nextOffset, totalChars: body.length,
      instructions: 'Actual saved content. Produced file means ready for review, not accepted or completed. Read its full indexed content using read_knowledge_record before discussing its contents.' };
  }
  if (access.noteId !== id) throw new ValidationError('Open this work item in Think before asking Athena to edit it, so pending editor changes can be saved safely.');
  if ((name === 'update_email_draft') !== (current.type === 'email-draft')) throw new ValidationError('Use the tool matching this content type.');
  const read = access.workState?.reads.get(id);
  if (!read || read.revision !== current.revision || read.noteRevision !== current.noteRevision || args.revision !== read.revision
    || args.noteRevision !== read.noteRevision || (args.body !== undefined && !read.bodyRead)) {
    throw new ConflictError('Read the current work content and all body pages before replacing it.', 'WORK_CONTENT_CONFLICT');
  }
  const input = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'noteId'));
  const saved = await saveWorkContent(db, id, input);
  access.workState?.changedNoteIds.push(id);
  return { ...saved, saved: true, instructions: 'Saved to the existing Think item. No email was sent and no task was completed.' };
}
