import type { Pool } from 'pg';
import type { BlogDraft, BlogLength } from '../../ai/blogDraft.js';
import { hasArticleContent } from '../../ai/blogEditorial.js';
import type { RetrievalScope } from '../../ai/knowledge/retrievalScope.js';
import { BLOG_SPECIALIST, jobData } from '../../services/blogJobs.js';
import { parseBlogReviewBody } from '../../services/blogPublisher.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../types/errors.js';
import { MANUAL_BLOG_STEPS, WORKFORCE_VERSION, contentSignature, parseAssignmentBrief, record, type Assignment, type AssignmentBrief, type AssignmentOrigin } from './contracts.js';
import { blogCheckpointSourceData, captureManualBlogSources, selectManualBlogContext } from './blogSources.js';
import { commissionAssignment, getAssignment, getAssignmentForRequest, workforceTransaction } from './store.js';

export interface TrustedBlogCommissionContext {
  ownerId: string;
  origin: Exclude<AssignmentOrigin, { kind: 'schedule' }>;
  projectId: string | null;
  excludedSourceIds: string[];
  readOnly: boolean;
}

export interface PreparedBlogCommission {
  brief: AssignmentBrief;
  length: BlogLength;
  subjectTitle: string;
  budgetProfileId: string;
}

export interface TrustedChatBlogAction {
  userId?: string | undefined;
  sessionId?: string | undefined;
  userMessage?: string | undefined;
  workforceRequestId?: string | undefined;
  readOnly?: boolean | undefined;
  excludedIds?: ReadonlySet<string> | undefined;
  exclusionsFailed?: boolean | undefined;
  strictProjectId?: string | null | undefined;
  retrievalScope?: RetrievalScope | undefined;
}

export function startChatManualBlogCommission(
  db: Pool, workerPool: string, value: unknown, turn: TrustedChatBlogAction,
): Promise<{ assignment: Assignment; existing: boolean }> {
  if (!turn.userId || !turn.sessionId || !turn.workforceRequestId || !turn.userMessage?.trim()) {
    throw new ForbiddenError('The blog team requires an authenticated current chat action. Nothing was commissioned.');
  }
  if (turn.readOnly !== false || turn.exclusionsFailed !== false || turn.excludedIds === undefined || turn.strictProjectId === undefined) {
    throw new ForbiddenError('This turn is read-only or its source exclusions could not be verified. Nothing was commissioned.');
  }
  if (turn.retrievalScope && Object.keys(turn.retrievalScope.filter).length) {
    throw new ForbiddenError('The manual blog pilot does not yet support this collection/date/state retrieval boundary. It will not widen it or use the legacy writer.');
  }
  const input = record(value, 'Chat blog action');
  const instruction = typeof input['instruction'] === 'string' && input['instruction'].trim() ? input['instruction'].trim() : turn.userMessage;
  const action = { subjectId: input['subjectId'], length: input['length'], instruction };
  return startManualBlogCommission(db, workerPool, action, {
    ownerId: turn.userId, origin: { kind: 'chat', conversationId: turn.sessionId,
      requestId: `${turn.workforceRequestId}:${contentSignature(action)}` },
    projectId: turn.strictProjectId ?? null, excludedSourceIds: [...turn.excludedIds].sort(), readOnly: false,
  });
}

export function primaryBlogSelection(subjectId: unknown): { type: 'discover' | 'spark-theme'; id: string } {
  if (typeof subjectId !== 'string') throw new ValidationError('The blog source is required.');
  const [type, id, extra] = subjectId.split(':');
  if ((type !== 'discover' && type !== 'spark-theme') || !id || extra !== undefined
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError('Use the exact Discover item or Spark theme ID for the blog team.');
  }
  return { type, id: id.toLowerCase() };
}

/** Preserve automatic grounding through a bounded, versioned server-side context selection. */
export async function startManualBlogCommission(
  db: Pool, workerPool: string, value: unknown, context: TrustedBlogCommissionContext,
): Promise<{ assignment: Assignment; existing: boolean }> {
  const input = record(value, 'Manual blog action');
  const primary = primaryBlogSelection(input['subjectId']);
  const format = length(input['length']);
  const instruction = input['instruction'] === undefined
    ? `Write the selected ${format === 'short' ? 'Quick take' : 'Article'} for my review. Do not publish it.` : input['instruction'];
  if (typeof instruction !== 'string' || !instruction.trim()) throw new ValidationError('The agreed blog instruction is required.');
  const subjectId = `${primary.type}:${primary.id}`;
  const receipt = await getAssignmentForRequest(db, context.ownerId, workerPool, context.origin.requestId);
  if (receipt) {
    trustedBrief(receipt.brief, context);
    if (receipt.brief.workflow !== 'manual-blog' || receipt.brief.workflowVersion !== WORKFORCE_VERSION
      || receipt.brief.policyProfile !== 'manual-blog' || receipt.brief.subjectType !== 'blog-source'
      || receipt.brief.subjectId !== subjectId || receipt.brief.instruction !== `[manual-blog:${format}] ${instruction.trim()}`) {
      throw new ConflictError('This request ID belongs to a different blog action.', 'ASSIGNMENT_REQUEST_CONFLICT');
    }
    return { assignment: receipt, existing: true };
  }
  const prepared = await prepareManualBlogCommission(db, {
    subjectId, length: format, instruction, sources: [primary], autoContext: true,
  }, context);
  return commissionPreparedManualBlog(db, workerPool, prepared, context);
}

/** An explicit editor action is a new bounded review, not a resume or an automatic budget refill. */
export async function commissionManualBlogRecheck(
  db: Pool, workerPool: string, jobId: string, ownerId: string, requestId: string, value: unknown,
): Promise<{ assignment: Assignment; existing: boolean }> {
  const post = parseBlogReviewBody(value);
  if (post.slug || post.sourceUrl) throw new ValidationError('Recheck cannot change the source or slug.');
  if (!hasArticleContent({ ...post, sourceUrl: null })) throw new ValidationError('The blog draft must contain article text.');
  const instruction = `[manual-blog:${post.postType === 'quick' ? 'short' : 'long'}] Independently recheck the exact owner-submitted candidate ${contentSignature(post)}. Do not edit or publish it.`;
  const receipt = await getAssignmentForRequest(db, ownerId, workerPool, requestId);
  if (receipt) {
    const root = await db.query(
      `SELECT id FROM agent_jobs WHERE assignment_id=$1 AND step_key='recheck'
        AND input->>'workforceRecheckSourceJobId'=$2 AND input->>'workforceCanonicalBlog'='true'`,
      [receipt.id, jobId],
    );
    if (receipt.brief.workflow !== 'manual-blog' || receipt.brief.workflowVersion !== WORKFORCE_VERSION
      || receipt.brief.policyProfile !== 'manual-blog' || receipt.brief.instruction !== instruction
      || !root.rowCount) {
      throw new ConflictError('This request ID belongs to a different blog recheck.', 'ASSIGNMENT_REQUEST_CONFLICT');
    }
    return { assignment: receipt, existing: true };
  }
  const source = await db.query<{ assignment_id: string; subject_title: string; input: Record<string, unknown> }>(
    `SELECT assignment_id,subject_title,input FROM agent_jobs WHERE id=$1 AND specialist=$2 AND input->'blogCheckpoint' IS NOT NULL
      AND assignment_id IS NOT NULL AND (step_key='draft' OR input->>'workforceCanonicalBlog'='true')`,
    [jobId, BLOG_SPECIALIST],
  );
  const saved = source.rows[0];
  if (!saved) throw new NotFoundError('Workforce blog draft');
  const previous = await getAssignment(db, saved.assignment_id, ownerId);
  if (previous.status === 'queued' || previous.status === 'running' || previous.status === 'waiting') {
    throw new ConflictError('Stop the team through the existing editor action before rechecking.', 'BLOG_JOB_RUNNING');
  }
  const checkpoint = record(saved.input['blogCheckpoint'], 'Original blog checkpoint');
  const savedDraft = record(checkpoint['draft'], 'Saved blog draft');
  const sourceUrl = savedDraft['sourceUrl'];
  if (sourceUrl !== null && typeof sourceUrl !== 'string') throw new ValidationError('The original source URL is unavailable.');
  const candidate: BlogDraft = {
    postType: post.postType, title: post.title, excerpt: post.excerpt, summary: post.summary, content: post.content,
    keyTakeaways: post.keyTakeaways, categories: post.categories, tags: post.tags, sourceUrl,
  };
  const recheckCheckpoint = { ...checkpoint, draft: candidate };
  const seedSignature = contentSignature(blogCheckpointSourceData(saved.input));
  const brief = parseAssignmentBrief({
    ...previous.brief,
    origin: { ...previous.brief.origin, requestId },
    instruction,
    scope: { ...previous.brief.scope, sources: [
      ...previous.brief.scope.sources, { type: 'blog-checkpoint', id: jobId, version: 'unversioned' },
    ] },
  });
  const captured = await workforceTransaction(db, client => captureManualBlogSources(client, brief));
  if (!captured.sources.some(source => source.type === 'blog-checkpoint' && source.id === jobId && source.version === seedSignature)) {
    throw new ConflictError('The original checkpoint changed while saving the recheck request. Your submitted text was not replaced.', 'ASSIGNMENT_SOURCE_CHANGED');
  }
  for (const inherited of previous.brief.scope.sources) {
    if (!captured.sources.some(current => contentSignature(current) === contentSignature(inherited))) {
      throw new ConflictError('The original source or authority changed. Recheck will not silently refresh evidence.', 'ASSIGNMENT_SOURCE_CHANGED');
    }
  }
  const exact = { ...brief, scope: { ...brief.scope, sources: captured.sources } };
  return commissionAssignment(db, exact, {
    budgetProfileId: previous.budgetProfileId, workerPool, firstStep: MANUAL_BLOG_STEPS.recheck,
    specialist: BLOG_SPECIALIST, subjectTitle: saved.subject_title, subjectUrl: '?blogJob=' + encodeURIComponent(jobId),
    input: { workforceCanonicalBlog: true, workforceRecheckSourceJobId: jobId, workforceRecheckPost: post,
      blogCheckpoint: recheckCheckpoint, workforceBlogProjectionSignature: contentSignature(recheckCheckpoint),
      length: post.postType === 'quick' ? 'short' : 'long' },
    initialiseStep: async (client, newJobId, assignmentId) => {
      const summary = 'Your submitted draft is saved. Momus has not completed its independent review.';
      const data = {
        ...jobData(newJobId, previous.brief.subjectId, candidate, { verified: false, issues: ['Independent recheck is pending.'] }),
        workforceAssignmentId: assignmentId,
        workflow: { originalAvailable: true, stages: checkpoint['stages'] ?? [], remediationUsed: checkpoint['remediationUsed'] === true },
      };
      await client.query('UPDATE agent_jobs SET result=$2::jsonb WHERE id=$1 AND assignment_id=$3',
        [newJobId, JSON.stringify({ data, summary }), assignmentId]);
    },
    authorise: async client => {
      const current = await captureManualBlogSources(client, exact);
      if (contentSignature(current.sources) !== contentSignature(exact.scope.sources)) {
        throw new ConflictError('The original checkpoint or source authority changed during recheck commissioning.', 'ASSIGNMENT_SOURCE_CHANGED');
      }
    },
  });
}

function length(value: unknown): BlogLength {
  if (value !== 'short' && value !== 'long') throw new ValidationError('Choose Quick take or Article before commissioning the blog team.');
  return value;
}

function trustedBrief(value: unknown, context: TrustedBlogCommissionContext): AssignmentBrief {
  const parsed = parseAssignmentBrief(value);
  if (parsed.ownerId !== context.ownerId || contentSignature(parsed.origin) !== contentSignature(context.origin)
    || parsed.scope.projectId !== context.projectId || parsed.scope.readOnly !== context.readOnly
    || contentSignature(parsed.scope.excludedSourceIds) !== contentSignature(context.excludedSourceIds)) {
    throw new ForbiddenError('The commission cannot change its authenticated owner, originating action or trusted retrieval restrictions.');
  }
  if (parsed.scope.readOnly) throw new ForbiddenError('A read-only request cannot commission the blog team.');
  return parsed;
}

/** Preparation is read-only and free of model calls; the explicit action must submit these exact versions again. */
export function prepareManualBlogCommission(db: Pool, value: unknown, context: TrustedBlogCommissionContext): Promise<PreparedBlogCommission> {
  const input = record(value, 'Manual blog request');
  const format = length(input['length']);
  if (!Array.isArray(input['sources'])) throw new ValidationError('The exact controlling sources and authorised context records are required.');
  const selections: unknown[] = input['sources'];
  const sources = selections.map(value => {
    const source = record(value, 'Source selection');
    return { type: source['type'], id: source['id'], version: 'unversioned' };
  });
  const conversationId = context.origin.kind === 'chat' ? context.origin.conversationId : null;
  if (conversationId !== null && !sources.some(source => source.type === 'chat-scope' && source.id === conversationId)) {
    sources.push({ type: 'chat-scope', id: conversationId, version: 'unversioned' });
  }
  if (typeof input['instruction'] !== 'string' || !input['instruction'].trim()) throw new ValidationError('The agreed blog instruction is required.');
  const brief = trustedBrief({
    ownerId: context.ownerId, workflow: 'manual-blog', workflowVersion: WORKFORCE_VERSION, policyProfile: 'manual-blog',
    subjectType: 'blog-source', subjectId: input['subjectId'], instruction: `[manual-blog:${format}] ${input['instruction'].trim()}`,
    origin: context.origin,
    scope: { sources, projectId: context.projectId, excludedSourceIds: context.excludedSourceIds, readOnly: context.readOnly },
  }, context);
  return workforceTransaction(db, async client => {
    const profile = await client.query<{ id: string }>(
      `SELECT id FROM agent_budget_profiles WHERE workflow='manual-blog' AND workflow_version=$1
        AND policy_profile='manual-blog' AND approved_by=$2 AND enabled ORDER BY approved_at DESC,id LIMIT 1 FOR SHARE`,
      [WORKFORCE_VERSION, context.ownerId],
    );
    if (!profile.rows[0]) throw new ForbiddenError('The blog team remains disabled until its owner approves finite numeric call, token and deadline limits.');
    let captured = await captureManualBlogSources(client, brief);
    if (input['autoContext'] === true) {
      const additional = await selectManualBlogContext(client, brief, captured.title, format);
      const combined = new Map(brief.scope.sources.map(source => [`${source.type}:${source.id}`, source]));
      for (const source of additional) if (!combined.has(`${source.type}:${source.id}`)) combined.set(`${source.type}:${source.id}`, { ...source, version: 'unversioned' });
      captured = await captureManualBlogSources(client, { ...brief, scope: { ...brief.scope, sources: [...combined.values()] } });
    }
    if (!captured.sources.some(source => ['author-memory', 'author-message', 'configured-profile', 'blog-context', 'blog-author-post'].includes(source.type))) {
      throw new ValidationError('No permitted author grounding is available. The blog team will not invent background or broaden this request.');
    }
    return { brief: { ...brief, scope: { ...brief.scope, sources: captured.sources } }, length: format,
      subjectTitle: captured.title, budgetProfileId: profile.rows[0].id };
  });
}

/** Only an authenticated real action supplies context; it cannot be taken from a model's confirmed flag. */
export async function commissionPreparedManualBlog(
  db: Pool, workerPool: string, value: unknown, context: TrustedBlogCommissionContext,
): Promise<{ assignment: Assignment; existing: boolean }> {
  const input = record(value, 'Prepared manual blog commission');
  const brief = trustedBrief(input['brief'], context);
  if (!brief.scope.sources.some(source => ['author-memory', 'author-message', 'configured-profile', 'blog-context', 'blog-author-post'].includes(source.type))) {
    throw new ValidationError('The prepared blog commission must include permitted author grounding.');
  }
  const format = length(input['length']);
  if (!brief.instruction.startsWith(`[manual-blog:${format}] `)) throw new ValidationError('The approved blog format changed after preparation.');
  if (typeof input['budgetProfileId'] !== 'string' || typeof input['subjectTitle'] !== 'string') throw new ValidationError('The prepared budget profile and source title are required.');
  const title = input['subjectTitle'];
  return commissionAssignment(db, brief, {
    budgetProfileId: input['budgetProfileId'], workerPool, firstStep: MANUAL_BLOG_STEPS.research,
    specialist: BLOG_SPECIALIST, subjectTitle: title, subjectUrl: brief.subjectId.startsWith('discover:') ? '/discover' : '/think', input: { length: format },
    authorise: async client => {
      const current = await captureManualBlogSources(client, brief);
      if (current.title !== title || contentSignature(current.sources) !== contentSignature(brief.scope.sources)) {
        throw new ConflictError('The source title, controlling content or conversation scope changed after preparation.', 'ASSIGNMENT_SOURCE_CHANGED');
      }
    },
  });
}
