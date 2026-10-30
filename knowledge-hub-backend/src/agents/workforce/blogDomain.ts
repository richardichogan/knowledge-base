import type { Pool, PoolClient } from 'pg';
import { getFoundryClient } from '../../ai/foundryClient.js';
import type { BlogDraft } from '../../ai/blogDraft.js';
import { critiqueInputSignature, hasArticleContent, hasCurrentBlogEditorialReview, paragraphReviewCoverage, sourceReferenceIssues, type BlogCritique } from '../../ai/blogEditorial.js';
import { jobData, reviewedDraftSignature, verifiedPost } from '../../services/blogJobs.js';
import { parseBlogReviewBody } from '../../services/blogPublisher.js';
import { ConflictError, NotFoundError, ValidationError } from '../../types/errors.js';
import { currentAgentAttempt } from '../attempt.js';
import { contentSignature, record, WORKFORCE_VERSION, type Assignment } from './contracts.js';
import { authorManualBlog, critiqueManualBlog, researchManualBlog, reviseManualBlog, type BlogResearchPackage, type ScopedBlogResearch } from './blogTeam.js';
import type { ManualBlogExecutor } from './dispatcher.js';
import type { ManualBlogStep, StepAcceptance } from './controller.js';
import { lockAssignment, transitionAssignment, workforceTransaction } from './store.js';

export interface BlogDomainCapabilities {
  /** Locks and revalidates the current real authority, exclusions, project and every controlling source version. */
  checkCurrent: (client: PoolClient, assignment: Assignment) => Promise<void>;
  /** Returns only explicitly commissioned source/context records, never an unrestricted corpus or a search tool. */
  loadResearch: (client: PoolClient, assignment: Assignment) => Promise<ScopedBlogResearch>;
}

interface BlogOutput {
  step: ManualBlogStep;
  research: BlogResearchPackage;
  original: BlogDraft | null;
  draft: BlogDraft | null;
  critique: BlogCritique | null;
  stages: Array<{ stage: string; result: unknown; at: string }>;
}

interface BlogStepRow {
  id: string;
  depends_on: string | null;
  step_key: ManualBlogStep;
  input: Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) throw new ValidationError(`${label} must contain strings only.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string.`);
  return value;
}

function draft(value: unknown): BlogDraft {
  const input = record(value, 'Blog candidate');
  const parsed = parseBlogReviewBody({ ...input, sourceUrl: undefined });
  const sourceUrl = input['sourceUrl'];
  if (sourceUrl !== null && typeof sourceUrl !== 'string') throw new ValidationError('The exact source URL is required.');
  const candidate: BlogDraft = {
    postType: parsed.postType, title: parsed.title, excerpt: parsed.excerpt, summary: parsed.summary, content: parsed.content,
    keyTakeaways: parsed.keyTakeaways, categories: parsed.categories, tags: parsed.tags, sourceUrl,
  };
  if (contentSignature(candidate) !== contentSignature(input) || !hasArticleContent(candidate)) {
    throw new ValidationError('The blog candidate changed its exact output contract or has no article content.');
  }
  return candidate;
}

function research(value: unknown): BlogResearchPackage {
  const input = record(value, 'Blog research');
  const prepared = record(input['prepared'], 'Prepared blog');
  const sourceUrl = prepared['sourceUrl'];
  if ((sourceUrl !== null && typeof sourceUrl !== 'string') || typeof prepared['quick'] !== 'boolean') throw new ValidationError('The prepared blog format/source contract is invalid.');
  const reference = prepared['reference'] === null ? null : record(prepared['reference'], 'Source reference');
  if (reference && reference['publishedAt'] !== null && typeof reference['publishedAt'] !== 'string') throw new ValidationError('The source publication date is invalid.');
  if (!Array.isArray(input['voiceSamples'])) throw new ValidationError('Explicit voice samples are required.');
  const samples: unknown[] = input['voiceSamples'];
  const evidence = text(input['evidence'], 'Research evidence');
  record(JSON.parse(evidence), 'Research evidence');
  const user = text(prepared['user'], 'Prepared user context');
  record(JSON.parse(user), 'Prepared user context');
  return {
    prepared: {
      system: text(prepared['system'], 'Prepared system prompt'), user, quick: prepared['quick'], sourceUrl,
      reference: reference ? { title: text(reference['title'], 'Source title'), publishedAt: reference['publishedAt'] === null ? null : text(reference['publishedAt'], 'Publication date') } : null,
      allowedLinks: strings(prepared['allowedLinks'], 'Allowed links'),
    },
    evidence, voiceSamples: samples.map(value => {
      const sample = record(value, 'Voice sample');
      return { title: text(sample['title'], 'Sample title'), sample: text(sample['sample'], 'Voice sample text') };
    }),
  };
}

function parseOutput(value: unknown): BlogOutput {
  const input = record(value, 'Blog step output');
  const step = input['step'];
  if (step !== 'research' && step !== 'draft' && step !== 'critique' && step !== 'revision' && step !== 'recheck') throw new ValidationError('Unknown blog step.');
  if (!Array.isArray(input['stages'])) throw new ValidationError('Blog stage history is required.');
  const stages: unknown[] = input['stages'];
  const parsedStages = stages.map(value => {
    const stage = record(value, 'Blog stage');
    return { stage: text(stage['stage'], 'Stage name'), result: stage['result'], at: text(stage['at'], 'Stage timestamp') };
  });
  let critique: BlogCritique | null = null;
  if (input['critique'] !== null) {
    const review = record(input['critique'], 'Blog critique');
    const verification = record(review['verification'], 'Review verification');
    if (typeof review['complete'] !== 'boolean' || typeof verification['verified'] !== 'boolean'
      || !Array.isArray(review['findings']) || !Array.isArray(review['stages'])) throw new ValidationError('The critic returned an invalid review contract.');
    const findings: unknown[] = review['findings'];
    const reviewStages: unknown[] = review['stages'];
    critique = {
      inputSignature: text(review['inputSignature'], 'Reviewed input signature'), complete: review['complete'],
      verification: {
        verified: verification['verified'], issues: strings(verification['issues'], 'Review issues'),
        ...(verification['warnings'] === undefined ? {} : { warnings: strings(verification['warnings'], 'Review warnings') }),
      },
      findings: findings.map(value => {
        const finding = record(value, 'Targeted finding');
        const field = finding['field'];
        const kind = finding['kind'];
        if ((field !== 'title' && field !== 'excerpt' && field !== 'summary' && field !== 'content' && field !== 'keyTakeaways')
          || (kind !== 'style' && kind !== 'accuracy' && kind !== 'unsupported' && kind !== 'coherence' && kind !== 'length')
          || typeof finding['index'] !== 'number' || !Number.isSafeInteger(finding['index']) || finding['index'] < 0
          || typeof finding['usable'] !== 'boolean') throw new ValidationError('A targeted finding has invalid metadata.');
        return {
          id: text(finding['id'], 'Passage ID'), field, kind, index: finding['index'], usable: finding['usable'],
          before: text(finding['before'], 'Exact passage'), reason: text(finding['reason'], 'Finding reason'),
          evidence: strings(finding['evidence'], 'Finding evidence'),
          ...(finding['claim'] === undefined ? {} : { claim: text(finding['claim'], 'Exact claim') }),
        };
      }),
      stages: reviewStages.map(value => {
        const stage = record(value, 'Critic stage');
        return { stage: text(stage['stage'], 'Critic stage name'), result: stage['result'], at: text(stage['at'], 'Critic timestamp') };
      }),
    };
  }
  const parsed: BlogOutput = {
    step, research: research(input['research']), original: input['original'] === null ? null : draft(input['original']),
    draft: input['draft'] === null ? null : draft(input['draft']), critique, stages: parsedStages,
  };
  if (contentSignature(parsed) !== contentSignature(input)) throw new ValidationError('The blog step output contains unsupported or altered contract fields.');
  return parsed;
}

async function stepRow(client: PoolClient, assignment: Assignment): Promise<BlogStepRow> {
  const attempt = currentAgentAttempt();
  if (!attempt || attempt.assignmentId !== assignment.id) throw new ConflictError('The domain adapter requires its own live assignment attempt.', 'AGENT_ATTEMPT_CONFLICT');
  const result = await client.query<BlogStepRow>('SELECT id,depends_on,step_key,input FROM agent_jobs WHERE id=$1 AND assignment_id=$2', [attempt.jobId, assignment.id]);
  if (!result.rows[0]) throw new ConflictError('The blog step is no longer available.', 'ASSIGNMENT_STEP_INVALID');
  return result.rows[0];
}

async function acceptedRecheckSeed(
  client: PoolClient, sourceId: string, assignment: Assignment, seen = new Set<string>(),
): Promise<{ input: Record<string, unknown>; accepted: BlogOutput }> {
  if (seen.has(sourceId) || !assignment.brief.scope.sources.some(source => source.type === 'blog-checkpoint' && source.id === sourceId)) {
    throw new ConflictError('The recheck seed is cyclic or outside the commissioned checkpoint scope.', 'ASSIGNMENT_SOURCE_CHANGED');
  }
  seen.add(sourceId);
  const result = await client.query<{ input: Record<string, unknown>; attempts: number | null; signature: string | null }>(
    `SELECT j.input,a.producer_attempt AS attempts,a.content_signature AS signature FROM agent_jobs j LEFT JOIN LATERAL (
      SELECT producer_attempt,content_signature FROM agent_artifacts WHERE producer_job_id=j.id
        ORDER BY producer_attempt DESC LIMIT 1
    ) a ON TRUE WHERE j.id=$1`, [sourceId],
  );
  const source = result.rows[0];
  if (!source) throw new ConflictError('The original accepted blog revision is unavailable.', 'ASSIGNMENT_ARTIFACT_MISSING');
  if (source.attempts !== null && source.signature !== null) {
    const revisions = record(source.input['workforceBlogOutput'], 'Original blog output revisions');
    const accepted = parseOutput(revisions[String(source.attempts)]);
    if (contentSignature(accepted) !== source.signature) throw new ConflictError('The original accepted blog revision changed.', 'ASSIGNMENT_SOURCE_CHANGED');
    return { input: source.input, accepted };
  }
  if (source.input['workforceCanonicalBlog'] !== true) throw new ConflictError('The seed has no accepted blog provenance.', 'ASSIGNMENT_ARTIFACT_MISSING');
  const inherited = await acceptedRecheckSeed(client, text(source.input['workforceRecheckSourceJobId'], 'Prior recheck source'), assignment, seen);
  return { input: source.input, accepted: inherited.accepted };
}

async function predecessor(client: PoolClient, row: BlogStepRow, assignment: Assignment): Promise<BlogOutput | null> {
  if (!row.depends_on) {
    if (row.step_key !== 'recheck' || row.input['workforceRecheckSourceJobId'] === undefined) return null;
    const sourceId = text(row.input['workforceRecheckSourceJobId'], 'Recheck source job');
    const { input, accepted } = await acceptedRecheckSeed(client, sourceId, assignment);
    const checkpoint = record(input['blogCheckpoint'], 'Original blog checkpoint');
    if (contentSignature(checkpoint['originalDraft']) !== contentSignature(accepted.original)) {
      throw new ConflictError('The original draft changed before recheck.', 'ASSIGNMENT_SOURCE_CHANGED');
    }
    const snapshot = parseOutput({ ...accepted, original: checkpoint['originalDraft'], draft: checkpoint['draft'],
      stages: checkpoint['stages'], critique: null });
    const { original, draft: sourceDraft } = requireCandidate(snapshot);
    if (checkpoint['evidence'] !== accepted.research.evidence) throw new ConflictError('The source evidence changed before recheck.', 'ASSIGNMENT_SOURCE_CHANGED');
    const post = parseBlogReviewBody(row.input['workforceRecheckPost']);
    if (post.slug || post.sourceUrl) throw new ValidationError('Recheck cannot change the source or slug.');
    if (assignment.brief.instruction !== `[manual-blog:${post.postType === 'quick' ? 'short' : 'long'}] Independently recheck the exact owner-submitted candidate ${contentSignature(post)}. Do not edit or publish it.`) {
      throw new ConflictError('The recheck candidate changed after the owner commissioned it.', 'ASSIGNMENT_SOURCE_CHANGED');
    }
    const candidate: BlogDraft = {
      postType: post.postType, title: post.title, excerpt: post.excerpt, summary: post.summary, content: post.content,
      keyTakeaways: post.keyTakeaways, categories: post.categories, tags: post.tags, sourceUrl: sourceDraft.sourceUrl,
    };
    return { ...snapshot, original, draft: candidate };
  }
  const result = await client.query<{ input: Record<string, unknown>; attempts: number; signature: string }>(
    `SELECT j.input,j.attempts,a.content_signature AS signature FROM agent_jobs j JOIN agent_artifacts a
      ON a.producer_job_id=j.id AND a.producer_attempt=j.attempts WHERE j.id=$1 AND j.status=$2`,
    [row.depends_on, 'done'],
  );
  if (!result.rows[0]) throw new ConflictError('The predecessor has not accepted its output.', 'ASSIGNMENT_ARTIFACT_MISSING');
  const saved = result.rows[0];
  const revisions = record(saved.input['workforceBlogOutput'], 'Immutable output revisions');
  const output = parseOutput(revisions[String(saved.attempts)]);
  if (contentSignature(output) !== saved.signature) throw new ConflictError('The exact accepted predecessor revision is unavailable.', 'ASSIGNMENT_ARTIFACT_MISSING');
  return output;
}

async function checkCanonicalDraft(client: PoolClient, assignment: Assignment): Promise<void> {
  const saved = await client.query<{ input: Record<string, unknown> }>(
    "SELECT input FROM agent_jobs WHERE assignment_id=$1 AND (step_key='draft' OR input->>'workforceCanonicalBlog'='true') FOR SHARE", [assignment.id],
  );
  const input = saved.rows[0]?.input;
  if (input?.['blogCheckpoint'] !== undefined
    && contentSignature(input['blogCheckpoint']) !== input['workforceBlogProjectionSignature']) {
    throw new ConflictError('The canonical draft or its review context changed. Your edits have been retained.', 'ASSIGNMENT_SOURCE_CHANGED');
  }
}

function requireCandidate(output: BlogOutput): { draft: BlogDraft; original: BlogDraft } {
  if (!output.draft || !output.original) throw new ValidationError('The saved original and candidate are required.');
  return { draft: output.draft, original: output.original };
}

export async function beginManualBlogEdit(
  db: Pool, jobId: string, ownerId: string, expectedDraftSignature: string, requestId: string,
): Promise<{ assignmentId: string; changedBeforeEditing: boolean }> {
  const found = await db.query<{ assignment_id: string }>(
    "SELECT assignment_id FROM agent_jobs WHERE id=$1 AND (step_key='draft' OR input->>'workforceCanonicalBlog'='true') AND assignment_id IS NOT NULL", [jobId],
  );
  if (!found.rows[0]) throw new NotFoundError('Workforce blog draft');
  const assignmentId = found.rows[0].assignment_id;
  return workforceTransaction(db, async client => {
    const assignment = await lockAssignment(client, assignmentId);
    if (assignment.brief.ownerId !== ownerId || assignment.brief.workflow !== 'manual-blog') throw new NotFoundError('Workforce blog draft');
    const result = await client.query<{ input: Record<string, unknown> }>('SELECT input FROM agent_jobs WHERE id=$1 AND assignment_id=$2 FOR UPDATE', [jobId, assignmentId]);
    if (!result.rows[0]) throw new NotFoundError('Workforce blog draft');
    const checkpoint = record(result.rows[0].input['blogCheckpoint'], 'Saved blog checkpoint');
    const changedBeforeEditing = reviewedDraftSignature(draft(checkpoint['draft'])) !== expectedDraftSignature;
    if (assignment.status === 'queued' || assignment.status === 'running' || assignment.status === 'waiting') {
      await transitionAssignment(client, assignment.id, assignment.revision, assignment.status, 'superseded', {
        readiness: 'blocked', reason: 'You started editing the draft. Further automatic application has stopped; your local edits have not been autosaved or replaced.',
      });
      await client.query(
        `UPDATE agent_jobs SET status='failed',error='The owner started editing the canonical draft.',
          lease_owner=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE assignment_id=$1 AND status IN ('queued','running')`, [assignmentId],
      );
      await client.query("UPDATE agent_jobs SET input=jsonb_set(input,'{workforceEditorIntent}',$2::jsonb) WHERE id=$1",
        [jobId, JSON.stringify({ requestId, expectedDraftSignature })]);
    }
    return { assignmentId, changedBeforeEditing };
  });
}

/** Stores immutable step revisions in the existing job checkpoint domain; the original draft job remains the editor link. */
export function createManualBlogExecutor(db: Pool, capabilities: BlogDomainCapabilities): ManualBlogExecutor {
  return {
    execute: async ({ assignment, definition, signal }): Promise<BlogOutput> => {
      const loaded = await workforceTransaction(db, async client => {
        await capabilities.checkCurrent(client, assignment);
        await checkCanonicalDraft(client, assignment);
        const row = await stepRow(client, assignment);
        if (row.step_key !== definition.key) throw new ValidationError('The execution definition does not match the live job.');
        const previous = await predecessor(client, row, assignment);
        const sources = row.step_key === 'research' ? await capabilities.loadResearch(client, assignment) : null;
        return { row, previous, sources };
      });
      signal.throwIfAborted();
      const client = getFoundryClient('blog-specialist');
      if (definition.key === 'research') {
        if (!loaded.sources || loaded.previous) throw new ValidationError('The research step has invalid inputs.');
        const researched = await researchManualBlog(loaded.sources, client);
        const evidence = record(JSON.parse(researched.evidence), 'Research evidence');
        const author = record(evidence['authorContext'], 'Sanitised author provenance');
        if (!Array.isArray(author['insights']) || !Array.isArray(author['sources']) || author['privacyChecked'] !== true
          || typeof author['withheldInsights'] !== 'number' || evidence['research'] === undefined) throw new ValidationError('Research provenance is incomplete.');
        const at = new Date().toISOString();
        return {
          step: 'research', research: researched, original: null, draft: null, critique: null,
          stages: [
            { stage: 'sourceResearch', result: evidence['research'], at },
            { stage: 'authorContext', result: { insightCount: author['insights'].length, sourceCount: author['sources'].length,
              withheldInsights: author['withheldInsights'], privacyChecked: true }, at },
          ],
        } satisfies BlogOutput;
      }
      const previous = loaded.previous;
      if (!previous) throw new ValidationError('The accepted predecessor output is required.');
      if (definition.key === 'draft') {
        const candidate = await authorManualBlog(previous.research, client);
        return { ...previous, step: 'draft', original: candidate, draft: candidate } satisfies BlogOutput;
      }
      const candidate = requireCandidate(previous);
      if (definition.key === 'revision') {
        if (!previous.critique) throw new ValidationError('The independent critique is required for revision.');
        return { ...previous, step: 'revision', draft: await reviseManualBlog(previous.research, candidate.draft, previous.critique, client) } satisfies BlogOutput;
      }
      if (definition.key !== 'critique' && definition.key !== 'recheck') throw new ValidationError('The manual blog step is not supported.');
      const critique = await critiqueManualBlog(previous.research, candidate.original, candidate.draft, reviewedDraftSignature(candidate.draft), client);
      return { ...previous, step: definition.key, critique, stages: [...previous.stages, ...critique.stages] } satisfies BlogOutput;
    },
    acceptance: {
      checkCurrent: async (client, assignment): Promise<void> => {
        await capabilities.checkCurrent(client, assignment);
        await checkCanonicalDraft(client, assignment);
      },
      accept: async (client, context, proposal): Promise<StepAcceptance> => {
        const output = parseOutput(proposal);
        if (output.step !== context.step) throw new ValidationError('The proposed blog output belongs to a different step.');
        const row = await stepRow(client, context.assignment);
        const previous = await predecessor(client, row, context.assignment);
        if (previous && contentSignature(output.research) !== contentSignature(previous.research)) throw new ValidationError('A downstream role cannot replace accepted research.');
        if (previous?.original && contentSignature(output.original) !== contentSignature(previous.original)) throw new ValidationError('A downstream role cannot replace the original draft.');
        if ((context.step === 'critique' || context.step === 'recheck') && contentSignature(output.draft) !== contentSignature(previous?.draft)) throw new ValidationError('The independent critic cannot edit the candidate.');
        if (context.step === 'revision' && contentSignature(output.critique) !== contentSignature(previous?.critique)) throw new ValidationError('The author cannot change the independent critique.');
        if (context.step !== 'research' && context.step !== 'critique' && context.step !== 'recheck'
          && contentSignature(output.stages) !== contentSignature(previous?.stages ?? [])) throw new ValidationError('An author cannot change the independent stage history.');
        let disposition: StepAcceptance['disposition'] = { kind: 'continue' };
        let summary = context.step === 'research' ? 'Iris saved the scoped evidence and privacy-checked author context.' : 'Calliope saved the candidate.';
        if (context.step === 'research') {
          if (output.draft || output.original || output.critique
            || output.stages.some(stage => stage.stage !== 'sourceResearch' && stage.stage !== 'authorContext')) throw new ValidationError('Research cannot author or certify a draft.');
        } else {
          const candidate = requireCandidate(output);
          if (candidate.draft.sourceUrl !== output.research.prepared.sourceUrl) throw new ValidationError('The author cannot change the commissioned source URL.');
          if (context.step === 'draft' && contentSignature(candidate.original) !== contentSignature(candidate.draft)) throw new ValidationError('The initial original must match the generated candidate.');
          if (sourceReferenceIssues(candidate.original, candidate.draft).length) throw new ValidationError('The candidate changed its protected source footer.');
          const critic = context.step === 'critique' || context.step === 'recheck';
          if (critic) {
            if (!output.critique) throw new ValidationError('The critic did not return an independent review.');
            const review = output.critique;
            if (review.inputSignature !== critiqueInputSignature(candidate.draft, output.research.evidence)
              || contentSignature(output.stages) !== contentSignature([...(previous?.stages ?? []), ...review.stages])) {
              throw new ValidationError('The independent review does not match the exact current candidate, evidence and stage history.');
            }
            const coverage = paragraphReviewCoverage(candidate.original, review.stages, reviewedDraftSignature(candidate.draft));
            let publicationIssue: string | null = null;
            try {
              if (verifiedPost(candidate.draft) !== reviewedDraftSignature(candidate.draft)) publicationIssue = 'Publishing would change the reviewed draft. Edit and recheck it before sending.';
            } catch (error) {
              if (!(error instanceof ValidationError)) throw error;
              publicationIssue = error.message;
            }
            const ready = review.complete && review.verification.verified && review.verification.issues.length === 0 && coverage.length === 0
              && hasCurrentBlogEditorialReview(candidate.draft, review.stages) && publicationIssue === null;
            disposition = review.complete && !coverage.length ? {
              kind: 'review', requiresRevision: context.step === 'critique' && review.findings.some(finding => finding.usable),
              readiness: ready ? 'ready' : 'blocked', reason: ready ? null : publicationIssue ?? (review.verification.issues.join(' ') || 'The exact current draft needs further review.'),
            } : { kind: 'wait', reason: 'The independent review is incomplete. Saved work requires attention.' };
            summary = ready ? 'Momus completed the independent review. The draft is ready for your review, not published.' : 'Momus saved the independent findings; attention is required.';
          }
          const root = context.step === 'draft' || row.input['workforceCanonicalBlog'] === true ? row : (await client.query<BlogStepRow>(
            "SELECT id,depends_on,step_key,input FROM agent_jobs WHERE assignment_id=$1 AND step_key='draft' FOR UPDATE", [context.assignment.id],
          )).rows[0];
          if (!root) throw new ConflictError('The canonical editor draft is missing.', 'ASSIGNMENT_ARTIFACT_MISSING');
          const checkpoint = root.input['blogCheckpoint'];
          if (context.step !== 'draft' && row.input['workforceCanonicalBlog'] !== true) {
            const current = record(checkpoint, 'Canonical draft checkpoint');
            if (contentSignature(current['draft']) !== contentSignature(previous?.draft)) throw new ConflictError('The canonical draft changed during the assignment. Your edits were retained.', 'ASSIGNMENT_SOURCE_CHANGED');
          }
          const verification = critic && output.critique ? output.critique.verification : { verified: false, issues: ['Independent verification is not complete.'] };
          const ready = disposition.kind === 'review' && disposition.readiness === 'ready' && !disposition.requiresRevision;
          const data = {
            ...jobData(root.id, context.assignment.brief.subjectId, candidate.draft, { ...verification, verified: ready }),
            workforceAssignmentId: context.assignment.id,
            ...(ready ? { verifiedSignature: verifiedPost(candidate.draft) } : {}),
            workflow: { originalAvailable: true, stages: output.stages, remediationUsed: context.step === 'revision' || context.step === 'recheck' },
          };
          const checkpointValue = { draft: candidate.draft, originalDraft: candidate.original, evidence: output.research.evidence,
            voiceSamples: output.research.voiceSamples, stages: output.stages, remediationUsed: context.step === 'revision' || context.step === 'recheck' };
          await client.query(
            `UPDATE agent_jobs SET input=jsonb_set(jsonb_set(input,'{blogCheckpoint}',$2::jsonb),'{workforceBlogProjectionSignature}',to_jsonb($4::text)),
              result=COALESCE(result,'{}'::jsonb)||$3::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
            [root.id, JSON.stringify(checkpointValue), JSON.stringify({ data, summary }), contentSignature(checkpointValue)],
          );
        }
        const attempt = currentAgentAttempt();
        if (!attempt) throw new ConflictError('The accepting attempt disappeared.', 'AGENT_ATTEMPT_CONFLICT');
        await client.query(
          "UPDATE agent_jobs SET input=jsonb_set(input,'{workforceBlogOutput}',COALESCE(input->'workforceBlogOutput','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)) WHERE id=$1",
          [row.id, String(attempt.attempt), JSON.stringify(output)],
        );
        return {
          reference: { id: row.id, type: context.step === 'research' ? 'blog-evidence' : context.step === 'critique' || context.step === 'recheck' ? 'blog-review' : 'blog-draft',
            revision: String(attempt.attempt), signature: contentSignature(output) },
          schemaVersion: WORKFORCE_VERSION, summary, disposition,
        };
      },
    },
  };
}
