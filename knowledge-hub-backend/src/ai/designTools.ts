import type { Pool } from 'pg';
import { listDesignBuilds, readDesignAcceptance, setDesignAcceptanceSource } from '../designs/designWorkflow.js';
import { buildPublishedPackage } from '../designs/designPackages.js';
import { BUILD_READ_TOOLS, executeBuildTool, type BuildTurnState } from './buildTools.js';
import { recordAiAuthoredNote } from './aiLedger.js';
import { randomUUID } from 'node:crypto';
import type { LlmToolDefinition } from './foundryClient.js';
import { getDesign, requiredText, setImagineDemo, setImagineScope } from '../designs/designStore.js';
import { checkImagineWorkforce, readImagineHarness, requireImagineSpecApproval } from '../designs/imagineHarness.js';
import { collaboration, hasProtectedContent, lockSources, parseChanges, queueFeedback, replaceBlock, selectedAssets, sourceSnapshot, type DesignSource } from '../designs/designArtifacts.js';
import { authoredForModel, isAuthored } from '../designs/visualArtifact.js';
import { parseWriting, writeNoteInTransaction } from '../services/noteVersionService.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import { ConflictError, ValidationError } from '../types/errors.js';
import { scheduleNoteIndexing } from '../routes/notes.js';
import { linkNamedReferences } from '../services/noteLinks.js';
import { scheduleGitHubPublish } from '../services/noteGitHubService.js';
import type { Note } from '../types/index.js';
import { pageReadiness, readDesignReadiness, readinessHistory, resolveReadinessRepair } from '../designs/designReadiness.js';
import { handOff } from '../agents/engine.js';
import { WORKFORCE_DEFINITION_BOUNDARY } from '../designs/workforceDefinitionScope.js';
import { readImagineHandoff, readImagineMapping, writeImagineHandoff } from '../designs/imagineHandoff.js';

const MAX_PACKAGE_CHARACTERS = 250_000;
const RECENT_FEEDBACK_COUNT = 20;
const MAX_DOCUMENTS = 3;
const MAX_DOCUMENT_TITLE = 500;
const MAX_DOCUMENT_MARKDOWN = 150_000;
const MAX_READINESS_OFFSET = 100_000;
const MAX_REPAIR_INDEX = 4;
const REPAIR_CHUNK_CHARS = 12_000;
const MAX_PROPOSAL_ID = 100;
const BLUEPRINT_CHUNK_CHARS = 12_000;

export interface DesignTurnState {
  read?: { revision: number; sources: DesignSource[] };
  acceptanceRead?: { revision: number; commit: string | null; json: string };
  buildReads?: Map<string, BuildTurnState>;
  changedNoteIds: string[];
}
export const DESIGN_READINESS_WRITE_TOOLS = ['check_design_readiness', 'prepare_design_readiness_repair', 'discard_design_readiness_repair', 'set_design_imagine_demo', 'set_design_imagine_scope', 'check_imagine_workforce', 'queue_design_blueprint_feedback', 'set_design_acceptance_source', 'create_design_build_draft', 'create_imagine_workforce_blueprint'];

export const DESIGN_CHAT_TOOLS: LlmToolDefinition[] = [
  { type: 'function', function: {
    name: 'read_imagine_blueprint_mapping',
    description: 'Read the actual prepared Imagine workforce definition from this Design, in bounded JSON chunks. Use the binding returned by read_design_workflow; follow nextOffset until null. A mapping is not proof of an external save.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      binding: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
    }, required: ['binding', 'offset'] },
  } },
  { type: 'function', function: {
    name: 'create_imagine_workforce_blueprint',
    description: 'First read_design_workflow. To prepare the local mapping use confirmed:false and binding:"" with the actual expectedRevision. Read the mapping and show it to the user. Only after explicit confirmation use confirmed:true with the returned binding to save the definition in Imagine. Never request a token or password in chat. Does not approve the Spec, deploy, execute or create a demo.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      expectedRevision: { type: 'integer', minimum: 0 }, binding: { type: 'string', maxLength: 256 }, confirmed: { type: 'boolean' },
    }, required: ['expectedRevision', 'binding', 'confirmed'] },
  } },
  { type: 'function', function: {
    name: 'set_design_imagine_scope',
    description: 'Only after an explicit user decision, change this Design’s persisted Imagine delivery scope. workforce-definition stops at an undeployed blueprint; full-demo restores the broader demo scope. Clears stale harness approvals but does not generate, approve, create Imagine records or authorize execution. Do not change another Design by inference.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      imagineScope: { type: 'string', enum: ['full-demo', 'workforce-definition'] }, expectedRevision: { type: 'integer', minimum: 0 },
    }, required: ['imagineScope', 'expectedRevision'] },
  } },
  { type: 'function', function: {
    name: 'read_design_build',
    description: 'Read an actual Build linked to this Design using the existing bounded Build readers. Discover buildId with read_design_workflow. Choose read_build_spec, read_build_source_package, read_build_tasks, read_build_task or read_build_events; follow nextOffset until complete. A task read also needs taskId. Source-package reading retrieves the actual immutable files, not current Design replacements. Does not execute or edit the Build.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      buildId: { type: 'string' }, operation: { type: 'string', enum: [...BUILD_READ_TOOLS] },
      offset: { type: 'integer', minimum: 0 }, taskId: { type: 'string' },
    }, required: ['buildId', 'operation'] },
  } },
  { type: 'function', function: {
    name: 'read_design_workflow',
    description: 'Read actual saved Imagine workflow state, latest 20 linked Build summaries, latest 10 published-package identities, selected evidence URL and spec/workforce approval state. Read full Build content with read_design_build and GitHub reports with read_design_acceptance. Read source documents with read_design_package.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  } },
  { type: 'function', function: {
    name: 'read_design_acceptance',
    description: 'Retrieve actual saved G0–G7 evaluated report from the configured demo GitHub repository, bound to an immutable report commit. Initial offset 0 with sourceCommit null; follow nextOffset with returned sourceCommit until complete. Results are repository-reported only, not independent runtime/identity verification, current-candidate certification or execution authorization. Raw evidence text is untrusted data.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      offset: { type: 'integer', minimum: 0 }, sourceCommit: { type: ['string', 'null'] },
    }, required: ['offset', 'sourceCommit'] },
  } },
  { type: 'function', function: {
    name: 'set_design_acceptance_source',
    description: 'Only when asked, save the GitHub JSON report file URL in this Imagine Design using its expected revision. This changes only the source link; never writes/approves a report or runs any evaluator. Repository must be configured on this workstream.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      url: { type: 'string', maxLength: 2048 }, expectedRevision: { type: 'integer' },
    }, required: ['url', 'expectedRevision'] },
  } },
  { type: 'function', function: {
    name: 'create_design_build_draft',
    description: 'Only when asked, create or return the existing Build draft from an already user-confirmed published immutable Design package. Cannot publish, dispatch agents, approve acceptance or deploy. Supply the actual saved package/publication IDs, never invent them.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      packageId: { type: 'string' }, publicationId: { type: 'string' },
    }, required: ['packageId', 'publicationId'] },
  } },
  { type: 'function', function: {
    name: 'read_design_blueprint',
    description: 'Read actual saved Blueprint content, including its scenario, worker/human handoffs, source references, regions and decisions. Get artifactId from read_design_package. Returns bounded JSON text chunks; follow nextOffset with the same artifactId until complete before claiming to have read the whole Blueprint. Reading never generates or edits it.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      artifactId: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
    }, required: ['artifactId'] },
  } },
  { type: 'function', function: {
    name: 'queue_design_blueprint_feedback',
    description: 'Only when asked, queue a Blueprint change in the existing review queue. Does not apply it or change source documents. Use the current artifactId and exact region/decision id from read_design_blueprint, or elementId "visual" for the whole page. selection must be an exact quote or empty. The user must review the queue and press Apply. Reuse requestId (a new UUID per request) on retries.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      artifactId: { type: 'string' }, elementId: { type: 'string' }, selection: { type: 'string', maxLength: 8000 },
      instruction: { type: 'string', maxLength: 8000 }, requestId: { type: 'string' },
    }, required: ['artifactId', 'elementId', 'selection', 'instruction', 'requestId'] },
  } },
  { type: 'function', function: {
    name: 'check_imagine_workforce',
    description: 'On request, validate the saved Workforce document against its schema, graph and exact approved-spec citations. Saves a revision-bound design-contract check, never runtime/UI acceptance. Requires the user’s existing current spec approval; cannot grant approval.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  } },
  { type: 'function', function: {
    name: 'read_imagine_harness',
    description: 'Read this Design’s separate Imagine demo flag, actual revision-bound specification approval, validation blockers and workforce validation freshness. Read actual documents with read_design_package. Human spec approval is available only in Design properties; never claim it or bypass it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  } },
  { type: 'function', function: {
    name: 'set_design_imagine_demo',
    description: 'Only when explicitly requested, set the separate Imagine demo flag using the current Design revision. Does not change specification type, generate content or approve the spec. Changing the flag clears prior harness approvals.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      imagineDemo: { type: 'boolean' }, expectedRevision: { type: 'integer' },
    }, required: ['imagineDemo', 'expectedRevision'] },
  } },
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
    description: 'On explicit request, queue a background review of the selected IMAGINE specification. The job receipt is not a completed assessment. Read findings after completion with read_design_readiness.',
    parameters: { type: 'object', additionalProperties: false, properties: { specId: { type: 'string' } }, required: ['specId'] },
  } },
  { type: 'function', function: {
    name: 'prepare_design_readiness_repair',
    description: 'Queue a finding-specific repair preview. Athena proposes the correction; the user need not supply instructions. Does not apply changes or close the finding. Only request synthetic fixtures with explicit user authorization.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      assessmentId: { type: 'string' }, findingId: { type: 'string' }, instruction: { type: 'string', maxLength: 4000 },
      allowSyntheticFixtures: { type: 'boolean' },
    }, required: ['assessmentId', 'findingId'] },
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
          role: { type: 'string', enum: ['use_case', 'spec', 'architecture', 'workforce'] },
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
  access: { userId?: string | undefined; browserOrigin?: string | undefined; excludedIds?: ReadonlySet<string>; exclusionsFailed?: boolean; strictProjectId?: string | null; signal?: AbortSignal | undefined; readOnly?: boolean | undefined },
  state?: DesignTurnState): Promise<unknown> {
  access.signal?.throwIfAborted();
  const design = await getDesign(db, owner);
  if (design.parentNoteId !== owner) throw new ValidationError('The Design conversation owner does not match this package.');
  if (access.exclusionsFailed || access.excludedIds?.has(owner)
    || access.strictProjectId && design.projectId !== access.strictProjectId) throw new ValidationError('This Design is unavailable in the current conversation scope.');
  const selected = selectedAssets(design);
  const accessedAssets = name.includes('design_readiness') || name === 'read_imagine_harness' || name === 'check_imagine_workforce'
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
  if (name === 'set_design_imagine_scope') {
    if (access.readOnly) throw new ValidationError('This is a read-only turn. The Imagine scope was not changed.');
    const updated = await setImagineScope(db, design.id, args);
    state?.changedNoteIds.push(design.parentNoteId);
    return { designId: updated.id, revision: updated.revision, imagineScope: updated.imagineScope,
      note: 'Scope saved and prior harness approvals cleared. No documents, Imagine records or execution permissions were created.' };
  }
  if (name === 'read_design_build') {
    const buildId = requiredText(args['buildId'], 'Build ID', 100);
    const operation = BUILD_READ_TOOLS.find(item => item === args['operation']);
    if (!operation || !(await listDesignBuilds(db, design.id)).some(build => build.id === buildId)) {
      throw new ValidationError('Choose an actual linked Build and a supported read operation.');
    }
    if (state && !state.buildReads) state.buildReads = new Map();
    const buildState = state?.buildReads?.get(buildId) ?? { taskReads: new Map(), changed: false };
    state?.buildReads?.set(buildId, buildState);
    return executeBuildTool(db, operation, args, { selectedSpecId: buildId,
      ...(access.strictProjectId ? { strictProjectId: access.strictProjectId } : {}),
      ...(access.excludedIds ? { excludedIds: access.excludedIds } : {}) }, buildState);
  }
  if (name === 'create_imagine_workforce_blueprint' || name === 'read_imagine_blueprint_mapping') {
    if (access.excludedIds?.size || access.strictProjectId) {
      const currentArtifact = await collaboration(db, design.id);
      if (!currentArtifact.artifact || currentArtifact.stale || currentArtifact.artifact.sources.some(s =>
        !selected.some(a => a.sourceId === s.id) || access.excludedIds?.has(s.id))) {
        throw new ValidationError('The Blueprint includes unavailable or excluded sources.');
      }
    }
    if (name === 'read_imagine_blueprint_mapping') return readImagineMapping(db, design.id, args['binding'], args['offset']);
    if (access.readOnly || !access.userId) throw new ValidationError('A signed-in, writable Design conversation is required.');
    const preparing = args['confirmed'] !== true;
    const view = await writeImagineHandoff(db, design.id, access.userId, access.browserOrigin, args, preparing);
    state?.changedNoteIds.push(design.parentNoteId);
    return { ...view, ...(preparing && { next: 'Show the prepared status and ask for confirmation before writing to Imagine.' }) };
  }
  if (name === 'read_design_workflow') return { designId: design.id, revision: design.revision,
    imagineScope: design.imagineScope,
    ...(design.imagineScope === 'workforce-definition' ? { imagineBlueprintCreation: await readImagineHandoff(db, design.id, access.userId ?? '') } : {}),
    stages: design.imagineScope === 'workforce-definition'
      ? ['Use Case', 'Workforce Spec', 'Architecture', 'Diagram', 'Blueprint', 'Create Imagine Workforce Blueprint']
      : ['Use case', 'Spec', 'Architecture', 'Diagram', 'Blueprint', 'Build'],
    harness: await readImagineHarness(db, design.id), builds: await listDesignBuilds(db, design.id),
    publishedPackages: (await db.query(`SELECT p.id AS "publicationId",p.package_id AS "packageId",p.repo,p.branch,p.commit_sha AS commit
      FROM design_publications p JOIN design_packages d ON d.id=p.package_id
      WHERE d.design_id=$1 AND p.status='published' ORDER BY p.created_at DESC,p.id DESC LIMIT 10`, [design.id])).rows,
    acceptanceSource: design.selections.reference ?? null,
    note: design.imagineScope === 'workforce-definition' ? WORKFORCE_DEFINITION_BOUNDARY
      : 'Read actual documents/Blueprint/report before reasoning over their content. Build completion is not acceptance. Reports are read-only repository claims; no independent runtime or reviewer identity verification is performed.' };
  if (name === 'set_design_acceptance_source') {
    if (access.readOnly) throw new ValidationError('This is a read-only turn. The report link was not changed.');
    const updated = await setDesignAcceptanceSource(db, design.id, args);
    state?.changedNoteIds.push(design.parentNoteId);
    return { designId: design.id, revision: updated.revision, url: updated.selections.reference,
      note: 'Source link saved, not the report itself. No acceptance or execution permission was granted.' };
  }
  if (name === 'create_design_build_draft') {
    if (access.readOnly) throw new ValidationError('This is a read-only turn. No Build draft created.');
    if (design.imagineScope === 'workforce-definition') throw new ValidationError('Software builds are outside this Design’s workforce-definition-only scope. The final action creates an undeployed Imagine workforce blueprint.');
    if (!design.imagineDemo) throw new ValidationError('Enable Imagine demo to use this workflow.');
    const snapshotId = requiredText(args['packageId'], 'Package ID', 100);
    const snapshot = (await db.query<{ manifest: { sources: Array<{ id: string }> } }>(
      'SELECT manifest FROM design_packages WHERE id::text=$1 AND design_id=$2', [snapshotId, design.id])).rows[0];
    if (!snapshot) throw new ValidationError('The published package is unavailable in this Design.');
    if (snapshot.manifest.sources.some(source => access.excludedIds?.has(source.id))) throw new ValidationError('A published source is excluded from this conversation.');
    if (access.strictProjectId) {
      const sourceIds = snapshot.manifest.sources.map(source => source.id);
      const outside = await db.query(`SELECT id FROM notes WHERE id=ANY($1::uuid[]) AND project_id IS DISTINCT FROM $2
        UNION ALL SELECT id FROM canvases WHERE id=ANY($1::uuid[]) AND project IS DISTINCT FROM $2`, [sourceIds, access.strictProjectId]);
      if (outside.rows.length) throw new ValidationError('A published source is outside the enforced workstream scope.');
    }
    const draft = await buildPublishedPackage(db, design.id, snapshotId, requiredText(args['publicationId'], 'Publication ID', 100));
    state?.changedNoteIds.push(design.parentNoteId);
    return { buildId: draft.id, status: draft.status, note: 'Draft handoff only. No agents dispatched and no acceptance, deployment or other live action authorized.' };
  }
  if (name === 'read_design_acceptance') {
    if (design.selections.reference && access.excludedIds?.has(design.selections.reference)) throw new ValidationError('The report reference is excluded from this conversation.');
    const offset = args['offset'];
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000) throw new ValidationError('Choose a valid bounded report offset.');
    if (offset === 0) {
      const view = await readDesignAcceptance(db, design.id);
      const read = { revision: design.revision, commit: view.source?.commit ?? null, json: JSON.stringify(view) };
      if (args['sourceCommit'] !== null && args['sourceCommit'] !== read.commit) throw new ConflictError('The repository report revision changed. Restart the report read.', 'DESIGN_CONFLICT');
      if (state) state.acceptanceRead = read;
      const end = BLUEPRINT_CHUNK_CHARS;
      return { sourceCommit: read.commit, json: read.json.slice(0, end), nextOffset: read.json.length > end ? end : null,
        note: 'Repository-reported results, not independently authenticated live acceptance. Follow all chunks before claiming a complete read.' };
    }
    const read = state?.acceptanceRead;
    if (!read || read.revision !== design.revision || read.commit !== args['sourceCommit'] || offset >= read.json.length) {
      throw new ConflictError('The report read is unavailable or changed. Restart at offset 0 with sourceCommit null.', 'DESIGN_CONFLICT');
    }
    const end = offset + BLUEPRINT_CHUNK_CHARS;
    return { sourceCommit: read.commit, json: read.json.slice(offset, end), nextOffset: read.json.length > end ? end : null };
  }
  if (name === 'read_design_blueprint') {
    const view = await collaboration(db, design.id);
    const artifact = view.artifact;
    if (!artifact) throw new ValidationError('No saved Blueprint exists. Generate one before reading it.');
    if (artifact.id !== args['artifactId']) throw new ConflictError('The Blueprint changed. Read the current artifactId from read_design_package.', 'DESIGN_CONFLICT');
    if (artifact.sources.some(source => access.excludedIds?.has(source.id))) throw new ValidationError('A saved Blueprint source is excluded from this conversation.');
    if (access.strictProjectId) {
      const invalid = await db.query(`SELECT id FROM notes WHERE id=ANY($1::uuid[]) AND project_id IS DISTINCT FROM $2
        UNION ALL SELECT id FROM canvases WHERE id=ANY($3::uuid[]) AND project IS DISTINCT FROM $2`, [
        artifact.sources.filter(source => source.role !== 'diagram').map(source => source.id), access.strictProjectId,
        artifact.sources.filter(source => source.role === 'diagram').map(source => source.id),
      ]);
      if (invalid.rows.length) throw new ValidationError('A saved Blueprint source is outside the enforced workstream scope.');
    }
    const content = JSON.stringify(isAuthored(artifact.blueprint) ? authoredForModel(artifact.blueprint) : artifact.blueprint);
    const offset = args['offset'] ?? 0;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > content.length) throw new ValidationError('Use a valid Blueprint character offset.');
    const end = Math.min(content.length, offset + BLUEPRINT_CHUNK_CHARS);
    return { artifactId: artifact.id, revision: artifact.revision, stale: view.stale, sourceError: view.sourceError,
      representation: 'blueprint-json', offset, content: content.slice(offset, end), totalCharacters: content.length,
      nextOffset: end < content.length ? end : null };
  }
  if (name === 'queue_design_blueprint_feedback') {
    if (access.readOnly) throw new ValidationError('This is a read-only turn. Blueprint feedback was not queued.');
    const feedback = await queueFeedback(db, design.id, args);
    state?.changedNoteIds.push(design.parentNoteId);
    return { feedbackId: feedback.id, status: feedback.status,
      note: 'Feedback queued only. No Blueprint or source writing changed. Review the existing queue and press Apply to make the change.' };
  }
  if (name === 'read_imagine_harness') return readImagineHarness(db, design.id);
  if (name === 'check_imagine_workforce') {
    const checked = await checkImagineWorkforce(db, design.id);
    state?.changedNoteIds.push(design.parentNoteId);
    return checked;
  }
  if (name === 'set_design_imagine_demo') {
    const updated = await setImagineDemo(db, design.id, args);
    state?.changedNoteIds.push(design.parentNoteId);
    return { imagineDemo: updated.imagineDemo, revision: updated.revision, note: 'Flag saved; no generation or approval performed.' };
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
    if (name === 'check_design_readiness' || name === 'prepare_design_readiness_repair') {
      if (access.readOnly) throw new ValidationError('This conversation is read-only. No background work was queued.');
      if (access.strictProjectId || access.excludedIds?.size) throw new ValidationError('The background reviewer cannot enforce conversation-specific source restrictions. No work was queued.');
      if (name === 'prepare_design_readiness_repair' && view.proposal?.findingId === args['findingId'] && view.proposal?.assessmentId === args['assessmentId'] && view.proposal) {
        return { proposalId: view.proposal.id, note: 'A proposal already exists. Review it in the Spec tab.' };
      }
      return handOff(db, { specialist: name === 'check_design_readiness' ? 'design-readiness-check' : 'design-finding-fix',
        subjectId: design.id, requestedBy: 'chat', input: args });
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
      imagineDemo: design.imagineDemo, imagineScope: design.imagineScope, specificationType: design.specificationType,
      scopeBoundary: design.imagineScope === 'workforce-definition' ? WORKFORCE_DEFINITION_BOUNDARY : null,
      selections: design.selections, assets: design.assets.filter(asset => !access.excludedIds?.has(asset.sourceId)), sources,
      visual: visual.artifact ? { id: visual.artifact.id, revision: visual.artifact.revision, stale: visual.stale, sourceError: visual.sourceError } : null,
      blueprintAccess: 'Use read_design_blueprint with visual.id to retrieve the actual saved visual in bounded chunks, not just its title or metadata. Requested changes can be queued with queue_design_blueprint_feedback; the existing user review and Apply boundary remains mandatory.',
      pendingProposal: visual.proposal ? { id: visual.proposal.id, explanation: visual.proposal.explanation, status: visual.proposal.status } : null,
      feedback: visual.feedback.slice(-RECENT_FEEDBACK_COUNT), earlierFeedbackCount: Math.max(0, visual.feedback.length - RECENT_FEEDBACK_COUNT),
      instructions: 'Each Design tab has its own content. For a handwritten Design, its existing parent writing is the Use case; never ask the user to link it or create a duplicate. Preserve existing section IDs. Empty sections are genuinely empty, never copies of the Use case. Use save_design_documents to create missing text sections inside this Design when requested, not chat-only deliverables or disconnected notes. Imagine demo Designs also have Workforce. Preserve reference documents. For Imagine demos, Spec is the document editor only and Blueprint has its own tab; there is no MD/Blueprint toggle inside Spec. Standard Designs retain their Spec visual toggle. Diagram is its own canvas. IMAGINE readiness is separate revision-bound data: read_design_readiness retrieves findings, and its repairs require the Spec-tab preview Apply/Discard. A direct document edit makes readiness stale; it does not close findings. For Imagine demos, read_imagine_harness reports stage gates. The user must approve the validated spec in Design properties before imagine-workforce-designer can run. Never infer approval from chat or a tool call. Workforce writing is design only, not Imagine deployment or UI/runtime evidence.' };
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
    if (typeof role !== 'string' || !['use_case', 'spec', 'architecture', 'workforce'].includes(role) || seen.has(role)
      || role === 'workforce' && !design.imagineDemo) throw new ValidationError('Choose each available document section at most once.');
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
  if (writes.some(write => write.role === 'workforce' && !write.existing)) await requireImagineSpecApproval(db, design.id);
  const client = await db.connect();
  const notes: Note[] = [];
  const publish: string[] = [];
  try {
    await client.query('BEGIN');
    const locked = (await client.query<{ revision: number }>('SELECT revision FROM designs WHERE id=$1 FOR UPDATE', [design.id])).rows[0];
    if (locked?.revision !== design.revision) throw new ConflictError('Design links changed; no documents saved.', 'DESIGN_CONFLICT');
    await lockSources(client, read.sources);
    for (const write of writes) {
      const contentType = write.role === 'use_case' ? 'use-case' : write.role === 'workforce' ? 'architecture' : write.role;
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
