import type { Pool } from 'pg';
import { recordAiAuthoredNote } from './aiLedger.js';
import { randomUUID } from 'node:crypto';
import type { LlmToolDefinition } from './foundryClient.js';
import { getDesign, requiredText } from '../designs/designStore.js';
import { collaboration, hasProtectedContent, lockSources, parseChanges, replaceBlock, selectedAssets, sourceSnapshot, type DesignSource } from '../designs/designArtifacts.js';
import { parseWriting, writeNoteInTransaction } from '../services/noteVersionService.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import { ConflictError, ValidationError } from '../types/errors.js';
import { scheduleNoteIndexing } from '../routes/notes.js';
import { linkNamedReferences } from '../services/noteLinks.js';
import { scheduleGitHubPublish } from '../services/noteGitHubService.js';
import type { Note } from '../types/index.js';
import { checkDesignReadiness, pageReadiness, prepareReadinessRepair, readDesignReadiness, readinessHistory, resolveReadinessRepair } from '../designs/designReadiness.js';

const MAX_PACKAGE_CHARACTERS = 250_000;
const RECENT_FEEDBACK_COUNT = 20;
const MAX_DOCUMENTS = 3;
const MAX_DOCUMENT_TITLE = 500;
const MAX_DOCUMENT_MARKDOWN = 150_000;
const MAX_READINESS_OFFSET = 100_000;
const MAX_REPAIR_INDEX = 4;
const REPAIR_CHUNK_CHARS = 12_000;
const MAX_PROPOSAL_ID = 100;

export interface DesignTurnState {
  read?: { revision: number; sources: DesignSource[] };
  changedNoteIds: string[];
}
export const DESIGN_READINESS_WRITE_TOOLS = ['check_design_readiness', 'prepare_design_readiness_repair', 'discard_design_readiness_repair'];

export const DESIGN_CHAT_TOOLS: LlmToolDefinition[] = [
  { type: 'function', function: {
    name: 'read_design_readiness_repair',
    description: 'Retrieve the actual proposed Markdown for one pending readiness block change in bounded character chunks. Follow nextOffset and then next changeIndex until complete. Original blocks remain readable through the normal knowledge/document tools. Reading does not Apply the proposal.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      changeIndex: { type: 'integer', minimum: 0, maximum: 4 }, offset: { type: 'integer', minimum: 0 },
    } },
  } },
  { type: 'function', function: {
    name: 'read_design_readiness',
    description: 'Read the saved IMAGINE readiness assessment, actual revision freshness, coverage and a bounded page of findings. Not an assessment of unread content. Follow nextOffset for further findings; open and resolved pages are separate. Repair previews are reviewed with Apply/Discard in the existing Spec tab.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      offset: { type: 'integer', minimum: 0 }, status: { type: 'string', enum: ['open', 'resolved'] },
    } },
  } },
  { type: 'function', function: {
    name: 'read_design_readiness_history',
    description: 'Read a bounded page of previous IMAGINE assessment timestamps and blocker counts. Historical results are not current readiness.',
    parameters: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 } } },
  } },
  { type: 'function', function: {
    name: 'check_design_readiness',
    description: 'Only on explicit request, assess the selected IMAGINE specification using complete saved sources. One bounded review, no automatic retries. Persists a revision-bound assessment, not a document edit or live acceptance. Read the resulting findings with read_design_readiness.',
    parameters: { type: 'object', additionalProperties: false, properties: { specId: { type: 'string' } }, required: ['specId'] },
  } },
  { type: 'function', function: {
    name: 'prepare_design_readiness_repair',
    description: 'Prepare a finding-specific block-level repair preview using the user’s confirmed answer/instruction. Does NOT save writing or close the finding. The user reviews Apply/Discard in the Spec tab. allowSyntheticFixtures may be true only when the user explicitly authorised synthetic fixtures for this repair; never infer consent.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      assessmentId: { type: 'string' }, findingId: { type: 'string' }, instruction: { type: 'string', maxLength: 4000 },
      allowSyntheticFixtures: { type: 'boolean' },
    }, required: ['assessmentId', 'findingId', 'instruction', 'allowSyntheticFixtures'] },
  } },
  { type: 'function', function: {
    name: 'discard_design_readiness_repair',
    description: 'Discard the pending readiness repair only when asked. No source writing changes. Applying requires the user’s Spec-tab preview approval, not a model-controlled confirmation flag.',
    parameters: { type: 'object', additionalProperties: false, properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
  } },
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
  const accessedAssets = name.includes('design_readiness')
    ? [...selected, ...design.assets.filter(asset => asset.role === 'reference' && asset.sourceType === 'note')] : selected;
  if (accessedAssets.some(asset => access.excludedIds?.has(asset.sourceId))) throw new ValidationError('A selected Design document or assessment reference is excluded from this conversation.');
  if (access.strictProjectId) {
    const outOfScope = await db.query(`SELECT id FROM notes WHERE id=ANY($1::uuid[]) AND project_id IS DISTINCT FROM $2
      UNION ALL SELECT id FROM canvases WHERE id=ANY($3::uuid[]) AND project IS DISTINCT FROM $2`, [
      accessedAssets.filter(asset => asset.sourceType === 'note').map(asset => asset.sourceId), access.strictProjectId,
      accessedAssets.filter(asset => asset.sourceType === 'canvas').map(asset => asset.sourceId),
    ]);
    if (outOfScope.rows.length) throw new ValidationError('A selected original is outside the enforced workstream scope.');
  }
  if (name.includes('design_readiness')) {
    const offset = args['offset'] ?? 0;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_READINESS_OFFSET) throw new ValidationError('Use a nonnegative pagination offset up to 100,000.');
    const view = await readDesignReadiness(db, design.id);
    // Saved assessments/proposals may refer to originals removed or excluded since the check.
    const refs = [...(view.report?.sources ?? []), ...(view.proposal?.checkedSources ?? []),
      ...(view.report?.findings.flatMap(finding => [...finding.evidence, ...(finding.resolution?.evidence ?? [])])
        .map(entry => ({ id: entry.sourceId, role: entry.elementId ? 'diagram' : 'note' })) ?? [])];
    if (refs.some(source => access.excludedIds?.has(source.id))) throw new ValidationError('An assessed source is excluded from this conversation.');
    if (access.strictProjectId && refs.length) {
      const notes = refs.filter(source => source.role !== 'diagram').map(source => source.id);
      const diagrams = refs.filter(source => source.role === 'diagram').map(source => source.id);
      const invalid = await db.query(`SELECT id FROM notes WHERE id=ANY($1::uuid[]) AND project_id IS DISTINCT FROM $2
        UNION ALL SELECT id FROM canvases WHERE id=ANY($3::uuid[]) AND project IS DISTINCT FROM $2`, [notes, access.strictProjectId, diagrams]);
      if (invalid.rows.length) throw new ValidationError('Assessment evidence is outside the enforced workstream scope.');
    }
    if (name === 'read_design_readiness_history') return readinessHistory(db, design.id, offset);
    if (name === 'read_design_readiness_repair') {
      const index = args['changeIndex'] ?? 0;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_REPAIR_INDEX) throw new ValidationError('Choose a repair change index from 0 to 4.');
      const change = view.proposal?.changes[index];
      if (!change || offset > change.markdown.length) throw new ValidationError('This repair chunk is unavailable.');
      const end = offset + REPAIR_CHUNK_CHARS;
      return { proposalId: view.proposal!.id, changeIndex: index, changeCount: view.proposal!.changes.length,
        noteId: change.noteId, blockId: change.blockId, markdown: change.markdown.slice(offset, end),
        nextOffset: change.markdown.length > end ? end : null,
        nextChangeIndex: index + 1 < view.proposal!.changes.length ? index + 1 : null,
        stale: !['ready', 'blocked', 'partial'].includes(view.state), note: 'Preview only. The user must Apply in the Spec tab; this is not saved writing.' };
    }
    if (name === 'read_design_readiness') {
      const status = args['status'] ?? 'open';
      if (status !== 'open' && status !== 'resolved') throw new ValidationError('Choose open or resolved findings.');
      const page = pageReadiness(view, offset, status);
      // Do not duplicate large repair Markdown in every findings page.
      return { ...page, proposal: page.proposal ? { id: page.proposal.id, findingId: page.proposal.findingId, status: page.proposal.status,
        instruction: page.proposal.instruction, explanation: page.proposal.explanation, allowSyntheticFixtures: page.proposal.allowSyntheticFixtures,
        note: 'Review the complete block changes and Apply/Discard in the Spec tab.' } : null };
    }
    if (name === 'check_design_readiness') {
      const checked = await checkDesignReadiness(db, design.id, args['specId'], access.signal);
      state?.changedNoteIds.push(design.parentNoteId);
      return { state: checked.state, assessmentId: checked.report?.id, saved: true, note: 'Assessment saved, no writing changed. Read findings with read_design_readiness; this is not live approval or implementation evidence.' };
    }
    if (name === 'prepare_design_readiness_repair') {
      const prepared = await prepareReadinessRepair(db, design.id, args, access.signal);
      state?.changedNoteIds.push(design.parentNoteId);
      return { proposed: true, proposalId: prepared.proposal?.id, explanation: prepared.proposal?.explanation,
        note: 'No writing changed. Review the actual pending block changes with Apply/Discard in the Spec-tab readiness section. Recheck after applying; a proposal does not resolve a finding.' };
    }
    if (name === 'discard_design_readiness_repair') {
      const result = await resolveReadinessRepair(db, design.id, requiredText(args['proposalId'], 'Proposal ID', MAX_PROPOSAL_ID), false, access.signal);
      state?.changedNoteIds.push(design.parentNoteId);
      return { discarded: true, ...result };
    }
    throw new ValidationError('Unknown readiness operation.');
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
      instructions: 'The Design is the parent. The four tabs open these exact originals. Empty sections need a new linked original, not a chat-only deliverable or standalone note. Preserve reference documents. HTML is one shared visual under Spec; Diagram is the original canvas. IMAGINE readiness is separate revision-bound data: read_design_readiness retrieves findings, and its repairs require the Spec-tab preview Apply/Discard. A direct document edit makes readiness stale; it does not close findings.' };
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
          [write.id, await linkNamedReferences(client, JSON.stringify({ title: write.title, contentType, contentJson: JSON.stringify(blocks) }), write.id), design.projectId]);
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
  for (const note of notes) { scheduleNoteIndexing(db, note); recordAiAuthoredNote(db, note.id, note.content); }
  for (const id of publish) scheduleGitHubPublish(db, id);
  state.changedNoteIds.push(...writes.map(write => write.id));
  delete state.read;
  return { saved: true, designId: design.id, documents: writes.map(write => ({ role: write.role, noteId: write.id, title: write.title,
    url: `/think?design=${encodeURIComponent(owner)}&tab=${write.role}&asset=${write.id}` })),
    note: 'Saved into this Design, not a preview. Report the saved sections briefly using these exact links. No Apply action is needed.' };
}
