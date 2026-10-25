import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { LlmToolDefinition } from './foundryClient.js';
import { getDesign, requiredText } from '../designs/designStore.js';
import { collaboration, hasProtectedContent, lockSources, parseChanges, replaceBlock, selectedAssets, sourceSnapshot, type DesignSource } from '../designs/designArtifacts.js';
import { parseWriting, writeNoteInTransaction } from '../services/noteVersionService.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import { ConflictError, ValidationError } from '../types/errors.js';
import { scheduleNoteIndexing } from '../routes/notes.js';
import { scheduleGitHubPublish } from '../services/noteGitHubService.js';
import type { Note } from '../types/index.js';

const MAX_PACKAGE_CHARACTERS = 250_000;
const RECENT_FEEDBACK_COUNT = 20;
const MAX_DOCUMENTS = 3;
const MAX_DOCUMENT_TITLE = 500;
const MAX_DOCUMENT_MARKDOWN = 150_000;

export interface DesignTurnState {
  read?: { revision: number; sources: DesignSource[] };
  changedNoteIds: string[];
}

export const DESIGN_CHAT_TOOLS: LlmToolDefinition[] = [
  { type: 'function', function: {
    name: 'read_design_package',
    description: 'Read the current Think Design, its exact linked section identities/revisions and complete selected Markdown originals. Use before creating or updating Design documents. This is the working Design, not a downloadable archive.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'save_design_documents',
    description: 'When explicitly asked to create, revise or save Design documents, atomically save the requested sections into THIS Design. Update the existing original ID, never duplicate it. A missing section is created and linked atomically. Read the package first. This saves directly with history, not a nonexistent Apply preview. Does not start publication/export or accept visual feedback proposals; existing linked-copy autosync follows normal note saves.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      expectedDesignRevision: { type: 'integer' },
      documents: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false,
        properties: {
          role: { type: 'string', enum: ['use_case', 'spec', 'architecture'] },
          noteId: { type: ['string', 'null'], description: 'Exact selected note ID from read_design_package; null only for a genuinely empty section.' },
          expectedRevision: { type: ['integer', 'null'], description: 'Exact note revision just read; null only for a new document.' },
          title: { type: 'string' },
          markdown: { type: ['string', 'null'], description: 'Complete revised document, or null when using targeted changes. Whole rewrites are refused when they would discard native references/media.' },
          changes: { type: 'array', maxItems: 30, description: 'For existing rich documents, use exact block IDs from read_design_package; null blockId appends. Preserves all untouched blocks. Empty for a complete Markdown rewrite.',
            items: { type: 'object', additionalProperties: false, properties: {
              blockId: { type: ['string', 'null'] }, markdown: { type: 'string' },
            }, required: ['blockId', 'markdown'] } },
        }, required: ['role', 'noteId', 'expectedRevision', 'title', 'markdown', 'changes'],
      } },
    }, required: ['expectedDesignRevision', 'documents'] },
  } },
];

export async function executeDesignTool(db: Pool, name: string, owner: string, args: Record<string, unknown>,
  access: { excludedIds?: ReadonlySet<string>; exclusionsFailed?: boolean; strictProjectId?: string | null; signal?: AbortSignal | undefined },
  state?: DesignTurnState): Promise<unknown> {
  access.signal?.throwIfAborted();
  const design = await getDesign(db, owner);
  if (design.parentNoteId !== owner) throw new ValidationError('The Design conversation owner does not match this package.');
  if (access.exclusionsFailed || access.excludedIds?.has(owner)
    || access.strictProjectId && design.projectId !== access.strictProjectId) throw new ValidationError('This Design is unavailable in the current conversation scope.');
  const selected = selectedAssets(design);
  if (selected.some(asset => access.excludedIds?.has(asset.sourceId))) throw new ValidationError('A selected Design document is excluded from this conversation.');
  if (access.strictProjectId) {
    const outOfScope = await db.query(`SELECT id FROM notes WHERE id=ANY($1::uuid[]) AND project_id IS DISTINCT FROM $2
      UNION ALL SELECT id FROM canvases WHERE id=ANY($3::uuid[]) AND project IS DISTINCT FROM $2`, [
      selected.filter(asset => asset.sourceType === 'note').map(asset => asset.sourceId), access.strictProjectId,
      selected.filter(asset => asset.sourceType === 'canvas').map(asset => asset.sourceId),
    ]);
    if (outOfScope.rows.length) throw new ValidationError('A selected original is outside the enforced project scope.');
  }
  if (name === 'read_design_package') {
    const sources = await sourceSnapshot(db, design);
    if (JSON.stringify(sources).length > MAX_PACKAGE_CHARACTERS) throw new ValidationError('The complete package exceeds the chat read limit. Read individual documents through read_knowledge_record; no content was truncated.');
    const visual = await collaboration(db, design.id);
    if (state) state.read = { revision: design.revision, sources };
    return { designId: design.id, parentNoteId: owner, title: design.title, revision: design.revision,
      selections: design.selections, assets: design.assets.filter(asset => !access.excludedIds?.has(asset.sourceId)), sources,
      visual: visual.artifact ? { id: visual.artifact.id, revision: visual.artifact.revision, stale: visual.stale, sourceError: visual.sourceError } : null,
      pendingProposal: visual.proposal ? { id: visual.proposal.id, explanation: visual.proposal.explanation, status: visual.proposal.status } : null,
      feedback: visual.feedback.slice(-RECENT_FEEDBACK_COUNT), earlierFeedbackCount: Math.max(0, visual.feedback.length - RECENT_FEEDBACK_COUNT),
      instructions: 'The Design is the parent. The four tabs open these exact originals. Empty sections need a new linked original, not a chat-only deliverable or standalone note. Preserve reference documents. HTML is one shared visual under Spec; Diagram is the original canvas.' };
  }
  if (name !== 'save_design_documents') throw new ValidationError('Unknown Design operation.');
  const read = state?.read;
  if (!read || !Number.isInteger(args['expectedDesignRevision']) || args['expectedDesignRevision'] !== design.revision
    || read.revision !== design.revision) throw new ConflictError('Read the current Design before saving its documents.', 'DESIGN_CONFLICT');
  if (!Array.isArray(args['documents']) || !args['documents'].length || args['documents'].length > MAX_DOCUMENTS) throw new ValidationError('Save one to three Design documents.');
  const seen = new Set<string>();
  const writes = args['documents'].map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Invalid Design document.');
    const input = raw as Record<string, unknown>;
    const role = input['role'];
    if (typeof role !== 'string' || !['use_case', 'spec', 'architecture'].includes(role) || seen.has(role)) throw new ValidationError('Choose each document section at most once.');
    seen.add(role);
    const existing = selected.find(asset => asset.role === role);
    if (existing ? input['noteId'] !== existing.sourceId || !Number.isInteger(input['expectedRevision'])
      || read.sources.find(source => source.id === existing.sourceId)?.revision !== input['expectedRevision']
      : input['noteId'] !== null || input['expectedRevision'] !== null) throw new ConflictError('Document identity changed. Read this Design again; do not create a duplicate.', 'DESIGN_CONFLICT');
    if (!Array.isArray(input['changes'])) throw new ValidationError('Supply targeted changes, or an empty changes array for a full rewrite.');
    const targeted = input['changes'].length > 0;
    if (targeted && (!existing || input['markdown'] !== null)) throw new ValidationError('Targeted changes need an existing original and markdown:null.');
    const changes = targeted ? parseChanges(JSON.stringify({ explanation: 'Requested Design edits', changes: input['changes'].map((change: unknown) => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new ValidationError('Invalid block change.');
      return { ...change, noteId: existing!.sourceId };
    }) }), read.sources, new Set([existing!.sourceId])).changes : [];
    return { role, id: existing?.sourceId ?? randomUUID(), existing: !!existing, revision: input['expectedRevision'] as number | null,
      title: requiredText(input['title'], 'Document title', MAX_DOCUMENT_TITLE),
      markdown: targeted ? null : requiredText(input['markdown'], 'Document Markdown', MAX_DOCUMENT_MARKDOWN), changes };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const client = await db.connect();
  const notes: Note[] = [];
  const publish: string[] = [];
  try {
    await client.query('BEGIN');
    const locked = (await client.query<{ revision: number }>('SELECT revision FROM designs WHERE id=$1 FOR UPDATE', [design.id])).rows[0];
    if (locked?.revision !== design.revision) throw new ConflictError('Design links changed; no documents saved.', 'DESIGN_CONFLICT');
    await lockSources(client, read.sources);
    for (const write of writes) {
      const contentType = write.role === 'use_case' ? 'use-case' : write.role;
      let blocks: unknown[] = write.markdown === null ? [] : textToBlocks(write.markdown);
      if (write.markdown !== null && !blocks.length) throw new ValidationError('Document Markdown produced no writing. Nothing was saved.');
      if (write.existing) {
        const row = (await client.query<{ content: string }>("SELECT content FROM notes WHERE id=$1 AND status='active' FOR UPDATE", [write.id])).rows[0];
        if (!row) throw new ValidationError('The original document is unavailable.');
        const original = parseWriting(row.content);
        if (write.markdown === null) {
          blocks = JSON.parse(original.contentJson) as unknown[];
          for (const change of write.changes) blocks = replaceBlock(blocks, change);
        } else if (hasProtectedContent(JSON.parse(original.contentJson))) throw new ValidationError('This original contains embedded media or native references. Use targeted block changes, preserving those blocks; no documents were saved.');
        const result = await writeNoteInTransaction(client, write.id, { expectedRevision: write.revision!,
          content: JSON.stringify({ ...JSON.parse(row.content), title: write.title, contentJson: JSON.stringify(blocks) }), protectBefore: true });
        notes.push(result.note); if (result.publish) publish.push(write.id);
      } else {
        await client.query('INSERT INTO notes(id,content,project_id) VALUES($1,$2,$3)',
          [write.id, JSON.stringify({ title: write.title, contentType, contentJson: JSON.stringify(blocks) }), design.projectId]);
        const result = await writeNoteInTransaction(client, write.id, { expectedRevision: 0 });
        notes.push(result.note);
      }
      await client.query(`INSERT INTO design_assets(design_id,source_type,source_id,role,excluded) VALUES($1,'note',$2,$3,false)
        ON CONFLICT(design_id,source_type,source_id) DO UPDATE SET role=EXCLUDED.role,excluded=false`, [design.id, write.id, write.role]);
      await client.query('UPDATE designs SET selections=jsonb_set(selections,ARRAY[$2::text],to_jsonb($3::text)) WHERE id=$1', [design.id, write.role, write.id]);
    }
    await client.query('UPDATE designs SET revision=revision+1,updated_at=NOW() WHERE id=$1', [design.id]);
    access.signal?.throwIfAborted();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  for (const note of notes) scheduleNoteIndexing(db, note);
  for (const id of publish) scheduleGitHubPublish(db, id);
  state.changedNoteIds.push(...writes.map(write => write.id));
  delete state.read;
  return { saved: true, designId: design.id, documents: writes.map(write => ({ role: write.role, noteId: write.id, title: write.title,
    url: `/think?design=${encodeURIComponent(owner)}&tab=${write.role}&asset=${write.id}` })),
    note: 'Saved into this Design, not a preview. Report the saved sections briefly using these exact links. No Apply action is needed.' };
}
