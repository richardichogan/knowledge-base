import type { Pool } from 'pg';
import { getFoundryClient } from '../ai/foundryClient.js';
import type { BlogDraft, BlogVoiceSample } from '../ai/blogDraft.js';
import { hasArticleContent, paragraphReviewCoverage, recheckParagraphUnits, sourceReferenceIssues, verifyBlogDraft, type BlogVerification } from '../ai/blogEditorial.js';
import { handOff, type AgentJob } from '../agents/engine.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { parseBlogReviewBody, parsePublishBody, type BlogPublishBody } from './blogPublisher.js';

export const BLOG_SPECIALIST = 'blog-writer';
export const blogJobUrl = (id: string): string => `?blogJob=${encodeURIComponent(id)}`;

export interface BlogCheckpoint {
  draft: BlogDraft; originalDraft?: BlogDraft; evidence: string;
  stages?: Array<{ stage: string; result: unknown; at: string }>; voiceSamples?: BlogVoiceSample[];
  remediationUsed?: boolean; reviewBaseDraft?: BlogDraft;
}
interface BlogJobRow {
  id: string;
  specialist: string;
  subject_id: string;
  status: string;
  input: { blogCheckpoint?: BlogCheckpoint };
  result: { data?: Record<string, unknown>; summary?: string } | null;
}

function signature(post: BlogPublishBody): string {
  return JSON.stringify([
    post.postType, post.title, post.excerpt, post.summary, post.content,
    post.keyTakeaways, post.categories, post.tags,
  ]);
}

export function reviewedDraftSignature(draft: BlogDraft): string {
  return signature(parseBlogReviewBody({ ...draft, sourceUrl: undefined }));
}

/** Match what the editor sends, not the sourceUrl appended to the article. */
export function verifiedPost(draft: BlogDraft): string {
  return signature(parsePublishBody({
    postType: draft.postType, title: draft.title, excerpt: draft.excerpt, summary: draft.summary,
    content: draft.content, keyTakeaways: draft.keyTakeaways, categories: draft.categories, tags: draft.tags, status: 'draft',
  }));
}

export function jobData(id: string, subjectId: string, draft: BlogDraft, verification: BlogVerification): Record<string, unknown> {
  return { url: blogJobUrl(id), subjectId, draft, verification };
}

export async function assertVerifiedBlogJob(db: Pool, jobId: unknown, subjectId: string, post: BlogPublishBody): Promise<void> {
  if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(jobId)) {
    throw new ValidationError('A verified blog draft is required before sending.');
  }
  const { rows } = await db.query<BlogJobRow>('SELECT * FROM agent_jobs WHERE id = $1 AND specialist = $2', [jobId, BLOG_SPECIALIST]);
  const job = rows[0];
  if (!job || job.subject_id !== subjectId) throw new NotFoundError('Blog draft');
  const data = job.result?.data;
  const verification = data?.['verification'];
  const verified = verification && typeof verification === 'object' && 'verified' in verification && verification.verified === true;
  const checkpoint = job.input?.blogCheckpoint;
  const coverage = checkpoint?.originalDraft
    ? paragraphReviewCoverage(checkpoint.originalDraft, checkpoint.stages ?? [], signature(post))
    : ['The original paragraph review is unavailable.'];
  const sourceIssues = checkpoint?.originalDraft && checkpoint.draft
    ? sourceReferenceIssues(checkpoint.originalDraft, { ...checkpoint.draft, content: post.content }) : [];
  if (job.status !== 'done' || !verified || post.slug || post.sourceUrl
    || data?.['verifiedSignature'] !== signature(post) || coverage.length || sourceIssues.length) {
    throw new ConflictError('The current draft has not been verified. Recheck it before sending.', 'BLOG_VERIFICATION_REQUIRED');
  }
}

export async function loadBlogRecheckCheckpoint(db: Pool, id: string, subjectId?: string): Promise<{ checkpoint: BlogCheckpoint; subjectId: string }> {
  const { rows } = await db.query<BlogJobRow>('SELECT * FROM agent_jobs WHERE id = $1 AND specialist = $2', [id, BLOG_SPECIALIST]);
  const job = rows[0];
  if (!job) throw new NotFoundError('Blog draft');
  if (subjectId && job.subject_id !== subjectId) throw new NotFoundError('Blog draft');
  if (job.status === 'running' || job.status === 'queued') throw new ConflictError('The blog specialist is still working.', 'BLOG_JOB_RUNNING');
  const checkpoint = job.input.blogCheckpoint;
  if (!checkpoint?.draft || !checkpoint.evidence) throw new ValidationError('The original draft or its source evidence is unavailable.');
  return { checkpoint, subjectId: job.subject_id };
}

export async function queueBlogRecheck(db: Pool, id: string, body: unknown): Promise<AgentJob> {
  const { checkpoint, subjectId } = await loadBlogRecheckCheckpoint(db, id);
  const post = parseBlogReviewBody(body);
  if (post.slug || post.sourceUrl) throw new ValidationError('A blog draft recheck cannot change the source or slug.');
  if (!hasArticleContent({ ...checkpoint.draft, ...post })) throw new ValidationError('The blog draft must contain article text.');
  const queued = await handOff(db, {
    specialist: BLOG_SPECIALIST, subjectId, requestedBy: 'app',
    input: { mode: 'recheck', sourceJobId: id, post, length: post.postType === 'quick' ? 'short' : 'long' },
  });
  if (queued.status === 'already_running') throw new ConflictError('The blog specialist is already working on this source.', 'BLOG_JOB_RUNNING');
  if (queued.status !== 'queued') throw new ConflictError('The blog recheck could not be started.', 'BLOG_RECHECK_NOT_QUEUED');
  return queued.job;
}

export async function evaluateBlogRecheck(
  draft: BlogDraft, checkpoint: BlogCheckpoint,
  record: (stage: string, result: unknown) => Promise<void>,
  progress?: (current: number, total: number) => void,
): Promise<BlogVerification> {
  const post = parseBlogReviewBody({ ...draft, sourceUrl: undefined });
  if (!hasArticleContent(draft)) throw new ValidationError('The blog draft must contain article text.');
  const stages = [...(checkpoint.stages ?? [])];
  const draftSignature = signature(post);
  const client = getFoundryClient('blog-specialist');
  const paragraph = checkpoint.originalDraft
    ? await recheckParagraphUnits(checkpoint.originalDraft, draft, checkpoint.evidence, stages, client, checkpoint.voiceSamples, draftSignature,
      async result => {
        const saved = { ...result, draftSignature };
        stages.push({ stage: 'paragraphRecheck', result: saved, at: new Date().toISOString() });
        await record('paragraphRecheck', saved);
      }, progress, record, checkpoint.reviewBaseDraft)
    : { issues: ['The original draft is unavailable, so the unfinished paragraph review cannot be checked.'], results: [] };
  const coverage = checkpoint.originalDraft ? paragraphReviewCoverage(checkpoint.originalDraft, stages, draftSignature) : paragraph.issues;
  const sourceIssues = checkpoint.originalDraft ? sourceReferenceIssues(checkpoint.originalDraft, draft) : [];
  let verification = await verifyBlogDraft(draft, checkpoint.evidence, client, checkpoint.voiceSamples, record);
  if (paragraph.issues.length || coverage.length || sourceIssues.length) verification = {
    verified: false, issues: [...new Set([...verification.issues, ...paragraph.issues, ...coverage, ...sourceIssues])],
  };
  if (verification.verified) {
    try {
      if (signature(parsePublishBody({ ...draft, sourceUrl: undefined })) !== signature(post)) {
        verification = { verified: false, issues: ['The draft contains punctuation that would be changed during publishing. Edit it before rechecking.'] };
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      verification = { verified: false, issues: [error.message] };
    }
  }
  return verification;
}
