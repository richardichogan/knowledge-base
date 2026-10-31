import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';
import { parseNoteContent, type Block } from '../utils/noteContent.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import { noteMarkdown } from '../services/noteMarkdown.js';
import { linkNamedReferences } from '../services/noteLinks.js';
import { writeNoteInTransaction } from '../services/noteVersionService.js';
import { scheduleNoteIndexing } from '../routes/notes.js';
import { scheduleGitHubPublish } from '../services/noteGitHubService.js';
import { rowToTask, syncTaskToTimeline } from '../routes/tasks.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import type { Note } from '../types/contentItem.js';

export type WorkContentType = 'deliverable-brief' | 'email-draft';
export interface WorkSource { type: 'note' | 'document'; id: string }
export interface WorkContent {
  noteId: string; type: WorkContentType; revision: number; noteRevision: number;
  taskId: string | null; taskTitle: string | null; taskUpdatedAt: string | null;
  targetFolder: string; fileName: string; sources: WorkSource[];
  producedFile: { id: string; url: string; modifiedAt: string | null; title: string } | null;
  briefId: string | null; to: string; cc: string; subject: string; status: 'draft' | 'sent'; sentAt: string | null;
}
const MAX_BODY = 60_000;
const SOURCE_LIMIT = 12;
const TEXT_LIMIT = 1000;
const ID_LIMIT = 100;
const FILE_NAME_LIMIT = 200;
const TITLE_LIMIT = 300;
const SUBJECT_LIMIT = 500;
const RECIPIENT_LIMIT = 2000;
const PROJECT_PATH_PARTS = 2;
const CONTROL_CODE_LIMIT = 32;
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(char => char.charCodeAt(0) < CONTROL_CODE_LIMIT);
}
export const BRIEF_HEADINGS = [
  'Outcome & definition of done', 'Sources & evidence', 'Decisions only Richard can make',
  'Deliverable specification (format, audience, structure, template)', 'Target OneDrive path',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function noteId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('Use an exact note UUID.');
  return value;
}
function text(value: unknown, field: string, max = TEXT_LIMIT): string {
  if (typeof value !== 'string' || value.length > max || value.includes(String.fromCharCode(0))) throw new ValidationError(`${field} must contain up to ${max} characters.`);
  return value.trim();
}
function nullableId(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  const id = text(value, field, ID_LIMIT);
  return id || null;
}
export function parseSources(value: unknown): WorkSource[] {
  if (!Array.isArray(value) || value.length > SOURCE_LIMIT) throw new ValidationError(`Use up to ${SOURCE_LIMIT} cited source references.`);
  const refs = value.map((raw: unknown): WorkSource => {
    if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid source reference.');
    const ref = raw as Record<string, unknown>;
    if (ref.type !== 'note' && ref.type !== 'document') throw new ValidationError('Sources must reference a note or indexed document.');
    return { type: ref.type, id: noteId(ref.id) };
  });
  return refs.filter((ref, i) => refs.findIndex(other => other.type === ref.type && other.id === ref.id) === i);
}
export function targetPath(folder: unknown, name: unknown): { targetFolder: string; fileName: string } {
  const root = env.ALLIANCE_ONEDRIVE_ROOT.replace(/^\/+|\/+$/g, '');
  const targetFolder = text(folder, 'Target folder').replace(/^OneDrive\//i, '').replace(/\/+$/, '');
  const fileName = text(name, 'File name', FILE_NAME_LIMIT);
  if ((targetFolder && (!targetFolder.startsWith(`${root}/`) || targetFolder.split('/').length < PROJECT_PATH_PARTS))
    || (targetFolder !== '' && targetFolder.split('/').some(part => part === '.' || part === '..' || !part.trim()))
    || /[\\:*?"<>|]/.test(targetFolder) || hasControlCharacters(targetFolder)) {
    throw new ValidationError(`Choose a folder under OneDrive/${root}/<Project>/.`);
  }
  if (fileName && (!/\.(docx|pptx|xlsx|pdf)$/i.test(fileName) || /[/\\:*?"<>|]/.test(fileName) || hasControlCharacters(fileName))) {
    throw new ValidationError('Choose an exact Word, PowerPoint, Excel or PDF file name without path separators.');
  }
  return { targetFolder, fileName };
}
type NoteRow = { content: string; revision: number; project_id: string | null };
async function currentNote(client: Pool | PoolClient, id: string, lock = false): Promise<NoteRow & { type: WorkContentType }> {
  const result = await client.query<NoteRow>(
    `SELECT content,revision,project_id FROM notes WHERE id=$1 AND status='active'${lock ? ' FOR UPDATE' : ''}`, [id]);
  const row = result.rows[0];
  const type = row && parseNoteContent(row.content).contentType;
  if (!row || (type !== 'deliverable-brief' && type !== 'email-draft')) throw new NotFoundError('Work content not found or no longer this content type.');
  return { ...row, type };
}
async function ensureSide(client: Pool | PoolClient, id: string, type: WorkContentType): Promise<void> {
  await client.query(`INSERT INTO ${type === 'deliverable-brief' ? 'deliverable_briefs' : 'email_drafts'}(note_id)
    VALUES($1) ON CONFLICT(note_id) DO NOTHING`, [id]);
}
export async function getWorkContent(db: Pool, id: string): Promise<WorkContent> {
  noteId(id);
  const note = await currentNote(db, id);
  await ensureSide(db, id, note.type);
  const result = await db.query<{
    revision: number; task_id: string | null; task_title: string | null; task_updated_at: string | null;
    target_folder?: string; file_name?: string; source_refs?: WorkSource[];
    produced_content_id?: string | null; produced_url?: string | null; produced_modified_at?: string | null; produced_title?: string | null;
    brief_id?: string | null; recipients_to?: string; recipients_cc?: string; subject?: string; status?: 'draft' | 'sent'; sent_at?: string | null;
  }>(note.type === 'deliverable-brief' ? `SELECT b.*,t.title AS task_title,t.updated_at::text AS task_updated_at,
    d.title AS produced_title,b.produced_modified_at::text FROM deliverable_briefs b
    LEFT JOIN tasks t ON t.id=b.task_id LEFT JOIN content_items d ON d.id=b.produced_content_id WHERE b.note_id=$1`
    : `SELECT e.*,t.title AS task_title,t.updated_at::text AS task_updated_at,e.sent_at::text
    FROM email_drafts e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.note_id=$1`, [id]);
  const r = result.rows[0];
  if (!r) throw new NotFoundError('Work metadata unavailable.');
  return {
    noteId: id, type: note.type, revision: r.revision, noteRevision: note.revision,
    taskId: r.task_id, taskTitle: r.task_title, taskUpdatedAt: r.task_updated_at,
    targetFolder: r.target_folder ?? '', fileName: r.file_name ?? '', sources: r.source_refs ?? [],
    producedFile: r.produced_content_id ? { id: r.produced_content_id, url: r.produced_url ?? '', modifiedAt: r.produced_modified_at ?? null, title: r.produced_title ?? '' } : null,
    briefId: r.brief_id ?? null, to: r.recipients_to ?? '', cc: r.recipients_cc ?? '', subject: r.subject ?? '',
    status: r.status ?? 'draft', sentAt: r.sent_at ?? null,
  };
}
async function validateLinks(client: PoolClient, input: Record<string, unknown>, project: string | null): Promise<void> {
  if (input.taskId) {
    const task = await client.query<{ project_id: string | null }>('SELECT project_id FROM tasks WHERE id=$1 AND NOT archived FOR SHARE', [input.taskId]);
    if (!task.rows[0]) throw new ValidationError('Linked task is unavailable.');
    if (project && task.rows[0].project_id !== project) throw new ValidationError('Link a task from this note’s project.');
  }
  if (input.briefId) {
    const brief = await client.query(`SELECT b.note_id FROM deliverable_briefs b JOIN notes n ON n.id=b.note_id
      WHERE b.note_id=$1 AND n.status='active' AND note_list_metadata(n.content)->>'contentType'='deliverable-brief'`, [noteId(input.briefId)]);
    if (!brief.rowCount) throw new ValidationError('Linked deliverable brief is unavailable.');
  }
  if (input.sources !== undefined) {
    for (const ref of parseSources(input.sources)) {
      const result = await client.query(ref.type === 'note'
        ? "SELECT id FROM notes WHERE id=$1 AND status='active'"
        : 'SELECT id FROM content_items WHERE id=$1', [ref.id]);
      if (!result.rowCount) throw new ValidationError(`Cited ${ref.type} ${ref.id} is unavailable.`);
    }
  }
}
async function linkTask(client: PoolClient, taskId: string | null, id: string, title: string): Promise<void> {
  if (!taskId) return;
  await client.query(`INSERT INTO task_links(task_id,target_type,target_id,target_title,target_url) VALUES($1,'note',$2,$3,$4)
    ON CONFLICT(task_id,target_type,target_id) DO UPDATE SET target_title=EXCLUDED.target_title,target_url=EXCLUDED.target_url`,
  [taskId, id, title, `/think?noteId=${encodeURIComponent(id)}`]);
}
function parseFields(type: WorkContentType, input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(type === 'deliverable-brief'
    ? ['taskId', 'targetFolder', 'fileName', 'sources', 'revision', 'noteRevision', 'body']
    : ['taskId', 'briefId', 'to', 'cc', 'subject', 'revision', 'noteRevision', 'body']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new ValidationError('Unsupported work-content field. Sent status must be confirmed separately.');
  const patch: Record<string, unknown> = {};
  for (const key of ['taskId', 'briefId']) if (key in input) patch[key] = nullableId(input[key], key);
  for (const key of ['to', 'cc', 'subject']) if (key in input) {
    patch[key] = text(input[key], key, key === 'subject' ? SUBJECT_LIMIT : RECIPIENT_LIMIT);
    if (/[\r\n]/.test(String(patch[key]))) throw new ValidationError(`${key} must be a single line.`);
  }
  if ('sources' in input) patch.sources = parseSources(input.sources);
  return patch;
}
export async function saveWorkContent(db: Pool, id: string, input: Record<string, unknown>): Promise<WorkContent> {
  noteId(id);
  const client = await db.connect();
  let saved: Awaited<ReturnType<typeof writeNoteInTransaction>> | undefined;
  try {
    await client.query('BEGIN');
    const note = await currentNote(client, id, true);
    await ensureSide(client, id, note.type);
    const table = note.type === 'deliverable-brief' ? 'deliverable_briefs' : 'email_drafts';
    const side = (await client.query<{ revision: number; target_folder?: string; file_name?: string; status?: string }>(
      `SELECT * FROM ${table} WHERE note_id=$1 FOR UPDATE`, [id])).rows[0]!;
    if (input.revision !== side.revision || input.noteRevision !== note.revision) {
      throw new ConflictError('This note or its properties changed elsewhere. Keep your draft and reload before saving.', 'WORK_CONTENT_CONFLICT');
    }
    const patch = parseFields(note.type, input);
    if (side.status === 'sent' && (input.body !== undefined || ['to', 'cc', 'subject'].some(key => key in patch))) {
      throw new ConflictError('This email is recorded as Sent. Create a new draft for a follow-up rather than changing the sent record.', 'WORK_EMAIL_SENT');
    }
    if (note.type === 'deliverable-brief' && ('targetFolder' in input || 'fileName' in input)) {
      Object.assign(patch, targetPath(input.targetFolder ?? side.target_folder, input.fileName ?? side.file_name));
    }
    const targetChanged = note.type === 'deliverable-brief' &&
      (patch.targetFolder !== undefined && patch.targetFolder !== side.target_folder
        || patch.fileName !== undefined && patch.fileName !== side.file_name);
    await validateLinks(client, patch, note.project_id);
    const columns: Record<string, string> = {
      taskId: 'task_id', briefId: 'brief_id', targetFolder: 'target_folder', fileName: 'file_name',
      sources: 'source_refs', to: 'recipients_to', cc: 'recipients_cc', subject: 'subject',
    };
    const values: unknown[] = [id];
    const assignments = Object.entries(patch).map(([key, value]) => {
      values.push(key === 'sources' ? JSON.stringify(value) : value);
      return `${columns[key]}=$${values.length}`;
    });
    if (targetChanged) {
      assignments.push('produced_content_id=NULL', 'produced_url=NULL', 'produced_modified_at=NULL');
    }
    assignments.push('revision=revision+1');
    await client.query(`UPDATE ${table} SET ${assignments.join(',')} WHERE note_id=$1`, values);
    if (input.body !== undefined) {
      const plainBlocks = (blocks: Block[]): boolean => blocks.every(block =>
        ['heading', 'paragraph', 'bulletListItem', 'numberedListItem', 'checkListItem'].includes(block.type ?? '')
        && plainBlocks(block.children ?? []));
      if (!plainBlocks(parseNoteContent(note.content).blocks)) {
        throw new ValidationError('This note contains rich assets or tables. Use the existing editor’s proposed note edits to preserve them; a plain-text replacement was not saved.');
      }
      const body = text(input.body, 'Body', MAX_BODY);
      const wrapper = JSON.parse(note.content) as Record<string, unknown>;
      saved = await writeNoteInTransaction(client, id, {
        content: JSON.stringify({ ...wrapper, contentJson: JSON.stringify(textToBlocks(body)) }),
        expectedRevision: note.revision, protectBefore: true,
      });
    }
    const task = (await client.query<{ task_id: string | null }>(`SELECT task_id FROM ${table} WHERE note_id=$1`, [id])).rows[0]!;
    await linkTask(client, task.task_id, id, parseNoteContent(note.content).title ?? 'Work content');
    if (note.type === 'deliverable-brief' && task.task_id) {
      await client.query(`INSERT INTO task_links(task_id,target_type,target_id,target_title,target_url)
        SELECT $2,'document',d.id::text,d.title,d.url FROM deliverable_briefs b
        JOIN content_items d ON d.id=b.produced_content_id WHERE b.note_id=$1
        ON CONFLICT(task_id,target_type,target_id) DO UPDATE SET target_title=EXCLUDED.target_title,target_url=EXCLUDED.target_url`, [id, task.task_id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new ConflictError('Another deliverable brief already uses that exact OneDrive file path.', 'WORK_TARGET_CONFLICT');
    }
    throw error;
  } finally { client.release(); }
  if (saved) { scheduleNoteIndexing(db, saved.note); if (saved.publish) scheduleGitHubPublish(db, id); }
  return getWorkContent(db, id);
}
export async function createWorkContent(db: Pool, type: WorkContentType, input: Record<string, unknown>): Promise<WorkContent> {
  const title = text(input.title, 'Title', TITLE_LIMIT);
  if (!title) throw new ValidationError('A title is required.');
  const taskId = nullableId(input.taskId, 'Task ID');
  if (!taskId) throw new ValidationError('A linked Plan task is required when Athena creates work content.');
  const task = (await db.query<{ project_id: string | null }>('SELECT project_id FROM tasks WHERE id=$1 AND NOT archived', [taskId])).rows[0];
  if (!task) throw new ValidationError('Linked task is unavailable.');
  const id = randomUUID();
  let body = input.body === undefined && type === 'deliverable-brief'
    ? BRIEF_HEADINGS.map(heading => `## ${heading}\n\n`).join('\n') : text(input.body ?? '', 'Body', MAX_BODY);
  if (type === 'deliverable-brief' && !body.startsWith(`# ${title}\n`)) body = `# ${title}\n\n${body}`;
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'title' && key !== 'body'));
  const parsed = parseFields(type, fields);
  if (type === 'deliverable-brief') Object.assign(parsed, targetPath(input.targetFolder ?? '', input.fileName ?? ''));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await validateLinks(client, parsed, task.project_id);
    await client.query('INSERT INTO notes(id,content,project_id) VALUES($1,$2,$3)', [id,
      await linkNamedReferences(client, JSON.stringify({ title, contentType: type, contentJson: JSON.stringify(textToBlocks(body)) }), id), task.project_id]);
    await ensureSide(client, id, type);
    const table = type === 'deliverable-brief' ? 'deliverable_briefs' : 'email_drafts';
    const columns: Record<string, string> = { taskId: 'task_id', briefId: 'brief_id', targetFolder: 'target_folder', fileName: 'file_name', sources: 'source_refs', to: 'recipients_to', cc: 'recipients_cc', subject: 'subject' };
    const values: unknown[] = [id];
    const assignments = Object.entries(parsed).map(([key, value]) => {
      values.push(key === 'sources' ? JSON.stringify(value) : value); return `${columns[key]}=$${values.length}`;
    });
    await client.query(`UPDATE ${table} SET ${assignments.join(',')} WHERE note_id=$1`, values);
    await linkTask(client, taskId, id, title);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new ConflictError('That OneDrive target is already assigned to a brief.', 'WORK_TARGET_CONFLICT');
    throw error;
  } finally { client.release(); }
  const saved = await createdNote(db, id);
  scheduleNoteIndexing(db, saved);
  return getWorkContent(db, id);
}
async function createdNote(db: Pool, id: string): Promise<Note> {
  const row = (await db.query<{ id: string; content: string; created_at: Date; updated_at: Date; revision: number; project_id: string | null }>('SELECT * FROM notes WHERE id=$1', [id])).rows[0]!;
  return { id: row.id, content: row.content, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    revision: row.revision, tags: [], linkedItems: [], status: 'active' as const, ...(row.project_id && { projectId: row.project_id }) };
}
export async function markEmailSent(db: Pool, id: string, input: Record<string, unknown>): Promise<WorkContent> {
  const current = await getWorkContent(db, id);
  if (current.type !== 'email-draft' || input.confirmed !== true) throw new ValidationError('Confirm that you sent this email yourself.');
  if (!(await workText(db, id)).trim()) throw new ValidationError('An empty email cannot be marked Sent.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const note = await currentNote(client, id, true);
    if (note.revision !== input.noteRevision) throw new ConflictError('The email body changed. Review it before marking Sent.', 'WORK_CONTENT_CONFLICT');
    const result = await client.query(`UPDATE email_drafts SET status='sent',sent_at=now(),revision=revision+1
      WHERE note_id=$1 AND revision=$2 AND status='draft' AND recipients_to<>'' AND subject<>''`, [id, input.revision]);
    if (!result.rowCount) throw new ConflictError('Review the current draft, recipient and subject before marking Sent.', 'WORK_CONTENT_CONFLICT');
    if (current.taskId) await client.query('INSERT INTO task_notes(task_id,body) VALUES($1,$2)',
      [current.taskId, `Email "${current.subject}" marked Sent by Richard. Waiting-on status requires separate confirmation.`]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return getWorkContent(db, id);
}
export async function confirmEmailWaiting(db: Pool, id: string, input: Record<string, unknown>): Promise<WorkContent> {
  if (input.confirmed !== true) throw new ValidationError('Confirm the waiting-on task change.');
  const client = await db.connect();
  let task: ReturnType<typeof rowToTask> | undefined;
  try {
    await client.query('BEGIN');
    const note = await currentNote(client, id, true);
    if (note.type !== 'email-draft') throw new ValidationError('Open an Email draft before confirming a waiting-on proposal.');
    const email = (await client.query<{ task_id: string | null; recipients_to: string; status: string; revision: number }>(
      'SELECT * FROM email_drafts WHERE note_id=$1 FOR UPDATE', [id])).rows[0];
    if (!email || email.status !== 'sent' || email.revision !== input.revision || !email.task_id) throw new ConflictError('The sent draft or linked task changed.', 'WORK_CONTENT_CONFLICT');
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE tasks SET status='waiting',waiting_on=$2,updated_at=now() WHERE id=$1 AND NOT archived
       AND status NOT IN ('completed','cancelled') AND updated_at=$3::timestamptz RETURNING *`,
      [email.task_id, email.recipients_to, input.taskUpdatedAt]);
    if (!updated.rows[0]) throw new ConflictError('The task changed since this proposal. Refresh before confirming.', 'WORK_TASK_CONFLICT');
    task = rowToTask(updated.rows[0]);
    await client.query('INSERT INTO task_notes(task_id,body) VALUES($1,$2)', [email.task_id, `Richard confirmed waiting on ${email.recipients_to} after sending the linked email.`]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  if (task) await syncTaskToTimeline(db, task);
  return getWorkContent(db, id);
}
export async function workText(db: Pool, id: string): Promise<string> {
  const note = await currentNote(db, id);
  if (!parseNoteContent(note.content).blocks.length) return '';
  return renderNoteAsText(db, note.content);
}
export async function workMarkdown(db: Pool, id: string): Promise<string> {
  const note = await currentNote(db, id);
  if (!parseNoteContent(note.content).blocks.length) return '';
  return (await noteMarkdown(note.content, id)).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}
/** Reconciles even unchanged documents so new briefs can match an already indexed file. */
export async function reconcileDeliverables(db: Pool, root: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const changed = await client.query<{ note_id: string; task_id: string | null; title: string; id: string; url: string; path: string }>(`
      UPDATE deliverable_briefs b SET produced_content_id=d.id,produced_url=d.url,
        produced_modified_at=d.published_at,revision=b.revision+1
      FROM content_items d,notes n WHERE n.id=b.note_id AND n.status='active'
        AND note_list_metadata(n.content)->>'contentType'='deliverable-brief' AND d.source='onedrive-document'
        AND lower(b.target_folder || '/' || b.file_name)=lower($1 || '/' || (d.metadata->>'path'))
        AND (b.produced_content_id IS DISTINCT FROM d.id OR b.produced_modified_at IS DISTINCT FROM d.published_at OR b.produced_url IS DISTINCT FROM d.url)
      RETURNING b.note_id::text,b.task_id,d.title,d.id::text,d.url,d.metadata->>'path' AS path`, [root]);
    for (const file of changed.rows) {
      if (!file.task_id) continue;
      await client.query(`INSERT INTO task_links(task_id,target_type,target_id,target_title,target_url) VALUES($1,'document',$2,$3,$4)
        ON CONFLICT(task_id,target_type,target_id) DO UPDATE SET target_title=EXCLUDED.target_title,target_url=EXCLUDED.target_url`,
      [file.task_id, file.id, file.title, file.url]);
      await client.query('INSERT INTO task_notes(task_id,body) VALUES($1,$2)',
        [file.task_id, `OneDrive file ${root}/${file.path} linked to deliverable brief ${file.note_id}. Ready for review, not completed.`]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
