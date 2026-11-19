import type { Pool } from 'pg';
import { getDesign } from './designStore.js';
import { latestArtifact } from './designArtifacts.js';
import { readImagineHarness } from './imagineHarness.js';
import { createImagineBlueprint, getImagineBlueprintCreationStatus, prepareImagineBlueprintFromReview } from './imagineBlueprintCreation.js';
import { hasImagineConnection, openImagineConnection } from '../services/imagineConnection.js';
import { ConflictError, ValidationError } from '../types/errors.js';

export async function readImagineHandoff(db: Pool, id: string, owner: string) {
  const design = await getDesign(db, id);
  if (design.imagineScope !== 'workforce-definition') throw new ValidationError('This Design is not a workforce definition.');
  const [record, connected] = await Promise.all([getImagineBlueprintCreationStatus(db, id), hasImagineConnection(db, owner)]);
  const created = record.status === 'created';
  const partial = record.status === 'partial' || record.status === 'reconciliation-required';
  let canCreate = !created && !!record.binding;
  let detail = record.message ?? (created ? 'Saved and verified as undeployed in Imagine.' : partial
    ? 'Some records may already exist. Resume to reconcile them before writing anything else.'
    : 'Review complete. Create the undeployed workforce in Imagine.');
  if (!created && !partial && !record.binding) {
    const harness = await readImagineHarness(db, id);
    const artifact = harness.specApproved ? await latestArtifact(db, design.id) : null;
    canCreate = harness.specApproved && !!artifact;
    detail = !harness.specApproved ? 'Review and approve the current Workforce Spec in Design properties first.'
      : !artifact ? 'Save a Think Blueprint from the current Design before creating the workforce.'
      : 'Prepare the Imagine records from your reviewed Think Blueprint.';
  }
  return { state: created ? 'verified' : partial ? 'partial' : 'not-started', detail, canCreate,
    binding: record.binding, connected, workforceUrl: record.url, workforceId: record.workforceId,
    savedAgentCount: record.agentIds.length, savedEvalCount: record.evaluationCount, pendingStep: record.pendingStep } as const;
}

export async function writeImagineHandoff(db: Pool, id: string, owner: string, origin: string | undefined, input: Record<string, unknown>, prepare: boolean) {
  const design = await getDesign(db, id);
  const revision = input['expectedRevision'];
  if (design.imagineScope !== 'workforce-definition' || revision !== design.revision) {
    throw new ConflictError('The Design changed. Refresh the final stage before continuing.', 'DESIGN_CONFLICT');
  }
  if (!origin) throw new ValidationError('Continue in the signed-in Athena Design to create this blueprint.');
  const { participant, transport } = await openImagineConnection(db, owner, origin);
  if (!participant.roles.includes('demo-admin')) throw new ValidationError('The signed-in Imagine account does not have workforce authoring permission.');
  if (prepare) {
    await prepareImagineBlueprintFromReview(db, id, design.revision, transport);
  } else {
    if (input['confirmed'] !== true || typeof input['binding'] !== 'string') throw new ValidationError('Confirm the reviewed Imagine blueprint first.');
    await createImagineBlueprint(db, id, { binding: input['binding'], expectedRevision: design.revision, confirmed: true }, transport);
  }
  return readImagineHandoff(db, id, owner);
}

export async function readImagineMapping(db: Pool, id: string, binding: unknown, offset: unknown) {
  const record = await getImagineBlueprintCreationStatus(db, id);
  if (!record.binding || binding !== record.binding) throw new ConflictError('Refresh the reviewed mapping first.', 'DESIGN_CONFLICT');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 400_000) throw new ValidationError('Invalid mapping offset.');
  const row = (await db.query<{ content: string }>(
    'SELECT definition::text AS content FROM design_imagine_blueprint_creations WHERE design_id=$1 AND operation_id=$2', [id, record.operationId])).rows[0];
  if (!row) throw new ConflictError('The prepared mapping changed.', 'DESIGN_CONFLICT');
  const end = Math.min(row.content.length, offset + 12_000);
  return { binding, content: row.content.slice(offset, end), nextOffset: end < row.content.length ? end : null };
}
