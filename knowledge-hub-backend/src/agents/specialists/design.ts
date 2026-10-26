/**
 * agents/specialists/design.ts — the Spec writer and the Blueprint designer.
 *
 * Both work on a Design. The Blueprint designer needs a current spec: if the
 * spec is missing, or the use case changed after it, the Spec writer runs
 * first as part of the same handoff. Changing the spec never starts a Blueprint.
 */
import type { Pool } from 'pg';
import { getDb } from '../../db/db.js';
import { getDesign, requiredText } from '../../designs/designStore.js';
import { generateArtifact, selectedAssets } from '../../designs/designArtifacts.js';
import { writeDesignSpec } from '../../designs/designSpec.js';
import { scheduleNoteIndexing } from '../../routes/notes.js';
import { scheduleGitHubPublish } from '../../services/noteGitHubService.js';
import { registerSpecialist, type Prerequisite } from '../registry.js';
import { ValidationError } from '../../types/errors.js';

export const SPEC_WRITER = 'spec-writer';
export const BLUEPRINT_DESIGNER = 'blueprint-designer';
const MAX_INSTRUCTION = 4_000;

async function resolveDesign(db: Pool, id: string, requireSpecificationType = false): Promise<{ id: string; title: string; url: string }> {
  const design = await getDesign(db, id);
  if (requireSpecificationType && !design.specificationType) throw new ValidationError('Choose Standard or IMAGINE beside Generate spec in this Design first.');
  return { id: design.id, title: design.title, url: `/think?design=${encodeURIComponent(design.id)}` };
}

/** The spec's state relative to the use case it is written from. */
async function specState(db: Pool, designId: string): Promise<'missing' | 'stale' | 'current'> {
  const design = await getDesign(db, designId);
  const selected = selectedAssets(design);
  const useCase = selected.find((asset) => asset.role === 'use_case');
  const spec = selected.find((asset) => asset.role === 'spec');
  if (!spec) return 'missing';
  if (!useCase || useCase.sourceType !== 'note' || spec.sourceType !== 'note') return 'current';
  const { rows } = await db.query<{ id: string; updated_at: Date }>(
    `SELECT id::text, updated_at FROM notes WHERE id::text = ANY($1)`, [[useCase.sourceId, spec.sourceId]]);
  const changed = (id: string): number => rows.find((row) => row.id === id)?.updated_at.getTime() ?? 0;
  return changed(useCase.sourceId) > changed(spec.sourceId) ? 'stale' : 'current';
}

registerSpecialist({
  id: SPEC_WRITER,
  name: 'Spec writer',
  description: 'Writes or rewrites a Design\'s spec from its use case. Earlier versions stay in note history.',
  subjectType: 'design',
  resolveSubject: (db, id) => resolveDesign(db, id, true),
  overwrites: async (db, designId) => (await specState(db, designId)) !== 'missing',
  run: async ({ db, jobId, subjectId, input, progress, signal }) => {
    progress('Reading the use case, architecture and diagrams');
    const result = await writeDesignSpec(db, subjectId, true, signal, progress, jobId, input['checkpointOnly'] === true);
    for (const note of result.notes) scheduleNoteIndexing(getDb(), note);
    for (const noteId of result.publish) scheduleGitHubPublish(getDb(), noteId);
    progress(result.created ? 'Spec saved and linked to the Design' : 'Spec saved; the previous version is in note history');
    return {
      data: { noteId: result.noteId, title: result.title, created: result.created },
      summary: `${result.created ? 'Wrote' : 'Rewrote'} “${result.title}” from the use case. The Blueprint was not changed.`,
    };
  },
});

registerSpecialist({
  id: BLUEPRINT_DESIGNER,
  name: 'Blueprint designer',
  description: 'Designs or regenerates a Design\'s visual Blueprint from its use case, spec, architecture and diagrams. Needs a current spec.',
  subjectType: 'design',
  resolveSubject: resolveDesign,
  parseInput: (input) => {
    const instruction = requiredText(input['instruction'] ?? '', 'Additional visual direction', MAX_INSTRUCTION, true);
    return instruction ? { instruction } : {};
  },
  prerequisites: async (db, designId): Promise<Prerequisite[]> => {
    const state = await specState(db, designId);
    if (state === 'current') return [];
    await resolveDesign(db, designId, true);
    return [{
      specialist: SPEC_WRITER,
      input: {},
      overwrites: state === 'stale',
      reason: state === 'missing'
        ? 'There is no spec yet, so the Spec writer writes one from the use case first.'
        : 'The use case changed after the spec, so the Spec writer rewrites the spec first. The current spec is replaced; earlier versions stay in note history.',
    }];
  },
  run: async ({ db, subjectId, input, progress }) => {
    const artifact = await generateArtifact(db, subjectId, input['instruction'], progress);
    return {
      data: { artifactId: artifact.id, revision: artifact.revision },
      summary: `Blueprint revision ${String(artifact.revision)} is ready.`,
    };
  },
});
