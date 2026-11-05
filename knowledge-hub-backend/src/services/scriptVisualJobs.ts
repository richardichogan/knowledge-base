import type { Pool } from 'pg';
import { getAgentJob, handOff, type HandOffResult } from '../agents/engine.js';
import type { SpecialistContext, SpecialistResult } from '../agents/registry.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { parseNoteContent } from '../utils/noteContent.js';
import { SCRIPT_VISUAL_INSTRUCTION_LIMIT, type VisualScriptBlock } from '../utils/scriptVisuals.js';
import { parseScriptVisualJobResult, SCRIPT_VISUAL_MAX_SECTIONS, SCRIPT_VISUAL_SPECIALIST, scriptVisualSnapshot, type ScriptVisualDraft, type ScriptVisualJobResult } from '../utils/scriptVisualJobs.js';
import { designScriptVisuals, scriptVisualGraphContext } from './scriptVisualDesigner.js';

interface ScriptVisualSubject { id: string; title: string; url: string; sections: VisualScriptBlock[] }

export async function resolveScriptVisualSubject(db: Pool, noteId: string): Promise<ScriptVisualSubject> {
  const { rows } = await db.query<{ content: string }>(
    "SELECT content FROM notes WHERE id::text=$1 AND status='active'", [noteId]);
  const row = rows[0];
  if (!row) throw new NotFoundError('Script');
  const parsed = parseNoteContent(row.content);
  if (parsed.contentType !== 'script') throw new ValidationError('Visuals belong to Script notes.');
  return { id: noteId, title: parsed.title ?? 'Untitled note', url: `/think?noteId=${encodeURIComponent(noteId)}`,
    sections: (parsed.blocks as VisualScriptBlock[]).filter(block => block.props?.scriptSection === true) };
}

export function parseScriptVisualInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input['instruction'] !== 'string' || !input['instruction'].trim()
    || input['instruction'].length > SCRIPT_VISUAL_INSTRUCTION_LIMIT || !Array.isArray(input['sections'])
    || !input['sections'].length || input['sections'].length > SCRIPT_VISUAL_MAX_SECTIONS
    || typeof input['openingSectionId'] !== 'string') throw new ValidationError('Provide a bounded visual request for 1–20 script sections.');
  let sections: ReturnType<typeof scriptVisualSnapshot>[];
  try { sections = input['sections'].map(scriptVisualSnapshot); }
  catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'The script source could not be captured.'); }
  if (new Set(sections.map(section => section.id)).size !== sections.length) throw new ValidationError('Choose unique script sections.');
  if (input['closingSectionId'] !== undefined && typeof input['closingSectionId'] !== 'string') throw new ValidationError('Invalid closing script section.');
  return { instruction: input['instruction'].trim(), sections, openingSectionId: input['openingSectionId'],
    ...(input['closingSectionId'] === undefined ? {} : { closingSectionId: input['closingSectionId'] }) };
}

export async function queueScriptVisuals(db: Pool, noteId: string, instruction: string, options: {
  sectionId?: string; conversationId?: string; requestedBy: 'app' | 'chat';
}): Promise<HandOffResult> {
  const subject = await resolveScriptVisualSubject(db, noteId);
  const sections = options.sectionId ? subject.sections.filter(section => section.id === options.sectionId) : subject.sections;
  return handOff(db, { specialist: SCRIPT_VISUAL_SPECIALIST, subjectId: noteId, requestedBy: options.requestedBy,
    conversationId: options.conversationId ?? null,
    input: parseScriptVisualInput({ instruction, sections, openingSectionId: subject.sections[0]?.id ?? '',
      closingSectionId: subject.sections.at(-1)?.id ?? '' }) });
}

export async function readScriptVisualJob(db: Pool, jobId: string, noteId: string, ownerId?: string): Promise<ScriptVisualJobResult> {
  const job = await getAgentJob(db, jobId, ownerId);
  if (job.specialist !== SCRIPT_VISUAL_SPECIALIST || job.subjectId !== noteId || job.status !== 'done') {
    throw new ValidationError('Choose a completed Ariadne visual result for this script.');
  }
  return parseScriptVisualJobResult(job.result, noteId);
}

export async function runScriptVisualJob(context: SpecialistContext): Promise<SpecialistResult> {
  const input = parseScriptVisualInput(context.input);
  const snapshots = (input['sections'] as unknown[]).map(scriptVisualSnapshot);
  const drafts: ScriptVisualDraft[] = [];
  context.progress('Reading the script\'s knowledge-graph relationships. The script remains unchanged.');
  const graphNeighbours = await scriptVisualGraphContext(context.db, context.subjectId);
  for (const [index, section] of snapshots.entries()) {
    context.signal.throwIfAborted();
    context.progress(`Designing section ${index + 1} of ${snapshots.length}. The script remains unchanged.`);
    const visuals = await designScriptVisuals(section, String(input['instruction']), context.signal,
      section.id === input['openingSectionId'], graphNeighbours, section.id === input['closingSectionId']);
    drafts.push({ section, visuals, expectedVisuals: typeof section.props?.scriptVisuals === 'string' ? section.props.scriptVisuals : '' });
  }
  context.signal.throwIfAborted();
  let result: ReturnType<typeof parseScriptVisualJobResult>;
  try { result = parseScriptVisualJobResult({ noteId: context.subjectId, sections: drafts }, context.subjectId); }
  catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'The pending visual result could not be validated.'); }
  return { data: { ...result, url: `/think?noteId=${encodeURIComponent(context.subjectId)}&visualJobId=${encodeURIComponent(context.jobId)}` },
    summary: 'Visuals are saved as a pending result. Review and apply them from the script toolbar when ready; the script is unchanged.' };
}
