import type { Pool } from 'pg';
import { getFoundryClient } from '../../ai/foundryClient.js';
import { blogEvidence, findBlogVoiceSamples, findEarlierPosts, generateBlogDraft, generateIdeasBlogDraft, readBlogSource, writeBlogCandidate, type BlogDraft, type BlogDraftWriter, type BlogVoiceSample, type BlogSource } from '../../ai/blogDraft.js';
import { researchBlogEvidence } from '../../ai/blogResearch.js';
import { buildBlogAuthorContext } from '../../ai/blogAuthorContext.js';
import { hasArticleContent, paragraphReviewCoverage, repairBlogDraft, type BlogVerification } from '../../ai/blogEditorial.js';
import { setAiWorkflowOutcome, setAiWorkflowStage } from '../../ai/aiWorkflow.js';
import { sourceUrl } from '../../ai/linkedInDraft.js';
import { getTheme } from '../../services/sparkGraduation.js';
import { BLOG_SPECIALIST, evaluateBlogRecheck, jobData, loadBlogRecheckCheckpoint, reviewedDraftSignature, verifiedPost } from '../../services/blogJobs.js';
import { parseBlogReviewBody } from '../../services/blogPublisher.js';
import { KnowledgeHubError, NotFoundError, ValidationError } from '../../types/errors.js';
import { registerSpecialist } from '../registry.js';

const SUBJECT = /^(discover|spark-theme):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
const RELATED_CHARS = 10000;
type SourceKind = 'discover' | 'spark-theme';
interface StageResult { stage: string; result: unknown; at: string }
interface BlogCheckpoint {
  draft?: BlogDraft;
  evidence?: string;
  originalDraft?: BlogDraft;
  stages?: StageResult[];
  remediationUsed?: boolean;
  voiceSamples?: BlogVoiceSample[];
  reviewBaseDraft?: BlogDraft;
}
class StaleBlogWorkerError extends Error {}

const STAGE_PROGRESS: Record<string, string> = {
  factReviewStarted: 'Reviewing facts',
  styleReviewStarted: 'Reviewing style',
  consolidation: 'Consolidating editorial findings',
  draftGeneration: 'Assembling the complete draft',
  validation: 'Validating the draft',
  remediationStarted: 'Correcting individual passages',
  postRemediationfactReviewStarted: 'Rechecking facts',
  postRemediationstyleReviewStarted: 'Rechecking style',
  recheckfactReviewStarted: 'Rechecking facts',
  recheckstyleReviewStarted: 'Rechecking style',
  finalValidation: 'Completing validation',
  editorialReviewStarted: 'Reviewing the argument and practical value',
};

function subject(value: string): { kind: SourceKind; id: string } {
  const idGroup = 2;
  const match = SUBJECT.exec(value);
  if (!match) throw new ValidationError('Use discover:<ID> or spark-theme:<ID> for the blog source.');
  return { kind: match[1]!.toLowerCase() as SourceKind, id: match[idGroup]!.toLowerCase() };
}

async function discoverSource(db: Pool, id: string): Promise<BlogSource> {
  const { rows } = await db.query<BlogSource>(
    `SELECT title, body, source, url, metadata->>'originalPublishedAt' AS "publishedAt",
      metadata->'publicationDateKnown' = 'true'::jsonb AS "publicationDateKnown"
      FROM content_items WHERE id = $1 AND source IN ('email', 'discovered-article')`, [id]);
  if (!rows[0]) throw new NotFoundError('Discover item');
  if (!rows[0].body.trim()) throw new ValidationError('This source has no content to draft from.');
  return rows[0];
}

registerSpecialist({
  id: BLOG_SPECIALIST,
  name: 'Blog writer',
  description: 'Drafts a Quick take or Article from a Discover item or Spark theme. Ask which format first. Use subjectId discover:<ID> or spark-theme:<ID>, and length short or long.',
  subjectType: 'blog-source',
  resolveSubject: async (db, value) => {
    const source = subject(value);
    if (source.kind === 'discover') {
      const item = await discoverSource(db, source.id);
      return { id: `${source.kind}:${source.id}`, title: item.title, url: '/discover' };
    }
    const theme = await getTheme(db, source.id);
    if (!theme.sparks.length) throw new ValidationError('This theme has no sparks to draft from.');
    return { id: `${source.kind}:${source.id}`, title: theme.theme, url: '/think' };
  },
  parseInput: input => {
    if (input['length'] !== 'short' && input['length'] !== 'long') throw new ValidationError('Choose Quick take or Article before starting.');
    if (input['mode'] === 'recheck') {
      if (typeof input['sourceJobId'] !== 'string'
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input['sourceJobId'])) {
        throw new ValidationError('A valid source draft is required for recheck.');
      }
      const post = parseBlogReviewBody(input['post']);
      if (post.slug || post.sourceUrl) throw new ValidationError('A blog draft recheck cannot change the source or slug.');
      return { mode: 'recheck', sourceJobId: input['sourceJobId'], post, length: input['length'] };
    }
    return { length: input['length'] };
  },
  run: async ({ db, jobId, attempt, subjectId, input, progress, signal }) => {
    setAiWorkflowStage('source-research');
    const source = subject(subjectId);
    const checkpoint = input['blogCheckpoint'];
    const saved = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
      ? checkpoint as BlogCheckpoint : undefined;
    let draft = saved?.draft;
    let evidence = saved?.evidence;
    let originalDraft = saved?.originalDraft;
    let voiceSamples = saved?.voiceSamples ?? [];
    let reviewBaseDraft = saved?.reviewBaseDraft;
    let stages = Array.isArray(saved?.stages) ? [...saved.stages] : [];
    let remediationUsed = saved?.remediationUsed === true || (!!saved?.draft && !saved.originalDraft);
    const save = async (candidate: BlogDraft, sourceEvidence: string): Promise<void> => {
      const data = {
        ...jobData(jobId, subjectId, candidate, { verified: false, issues: ['Verification is not complete.'] }),
        workflow: { originalAvailable: !!originalDraft, stages, remediationUsed },
      };
      const updated = await db.query(
        `UPDATE agent_jobs SET input = jsonb_set(input, '{blogCheckpoint}', $3::jsonb), result = $4::jsonb, updated_at = NOW()
          WHERE id = $1 AND status = 'running' AND attempts = $2 RETURNING id`,
        [jobId, attempt, JSON.stringify({ draft: candidate, evidence: sourceEvidence, ...(originalDraft ? { originalDraft } : {}),
          ...(reviewBaseDraft ? { reviewBaseDraft } : {}), voiceSamples, stages, remediationUsed }),
          JSON.stringify({ data, summary: 'The draft is saved and awaiting verification.' })],
      );
      if (!updated.rowCount) throw new StaleBlogWorkerError('This blog job was interrupted; the current worker cannot overwrite its saved draft.');
      draft = candidate;
      evidence = sourceEvidence;
    };
    if ((!draft || !evidence) && input['mode'] === 'recheck') {
      if (typeof input['sourceJobId'] !== 'string') throw new ValidationError('The source draft is unavailable.');
      const sourceCheckpoint = (await loadBlogRecheckCheckpoint(db, input['sourceJobId'], subjectId)).checkpoint;
      const post = parseBlogReviewBody(input['post']);
      if (post.slug || post.sourceUrl) throw new ValidationError('A blog draft recheck cannot change the source or slug.');
      const candidate: BlogDraft = {
        postType: post.postType, title: post.title, excerpt: post.excerpt, summary: post.summary,
        content: post.content, keyTakeaways: post.keyTakeaways, categories: post.categories, tags: post.tags,
        sourceUrl: sourceCheckpoint.draft.sourceUrl,
      };
      if (!hasArticleContent(candidate)) throw new ValidationError('The blog draft must contain article text.');
      originalDraft = sourceCheckpoint.originalDraft;
      reviewBaseDraft = sourceCheckpoint.draft;
      voiceSamples = sourceCheckpoint.voiceSamples ?? [];
      stages = Array.isArray(sourceCheckpoint.stages) ? [...sourceCheckpoint.stages] : [];
      remediationUsed = sourceCheckpoint.remediationUsed === true;
      progress('Saving the edited draft for recheck');
      await save(candidate, sourceCheckpoint.evidence);
    } else if (!draft || !evidence) {
      progress('Checking source evidence and official product documentation');
      voiceSamples = await findBlogVoiceSamples(db);
      let capturedEvidence = '';
      const writer: BlogDraftWriter = async (client, system, user, quick, url) => {
        progress('Grounding your perspective and anonymising relevant experience');
        setAiWorkflowStage('author-context');
        const source = JSON.parse(user) as Record<string, unknown>;
        const topic = typeof source['title'] === 'string' ? source['title']
          : typeof source['theme'] === 'string' ? source['theme'] : subjectId;
        const authorContext = await buildBlogAuthorContext(db, topic, client);
        capturedEvidence = blogEvidence(JSON.stringify({ ...source, authorContext }));
        const grounded = JSON.stringify({ ...source, authorContext: {
          insights: authorContext.insights.map(({ basis, text }) => ({ basis, text })), privacyChecked: true,
        } });
        const researched = JSON.parse(capturedEvidence) as Record<string, unknown>;
        stages = [...stages, { stage: 'sourceResearch', result: researched['research'], at: new Date().toISOString() }];
        stages = [...stages, { stage: 'authorContext', result: {
          insightCount: authorContext.insights.length, sourceCount: authorContext.sources.length, privacyChecked: true,
          withheldInsights: authorContext.withheldInsights,
        }, at: new Date().toISOString() }];
        progress('Writing the blog draft');
        setAiWorkflowStage('draft-generation');
        return writeBlogCandidate(client, system, grounded, quick, url, voiceSamples);
      };
      const length = input['length'] === 'long' ? 'long' : 'short';
      const client = getFoundryClient('blog-specialist');
      let candidate: BlogDraft;
      if (source.kind === 'discover') {
        const item = await discoverSource(db, source.id);
        const earlier = length === 'short' ? await findEarlierPosts(db, `${item.title} ${item.body.slice(0, RELATED_CHARS)}`) : [];
        const readable = await readBlogSource(item);
        candidate = await generateBlogDraft(readable, sourceUrl(readable.url), length, earlier, client, writer);
      } else {
        const theme = await getTheme(db, source.id);
        if (!theme.sparks.length) throw new ValidationError('This theme has no sparks to draft from.');
        const earlier = length === 'short' ? await findEarlierPosts(db, [theme.theme, ...theme.sparks.map(s => s.body)].join(' ')) : [];
        candidate = await generateIdeasBlogDraft(theme.theme, theme.sparks, length, earlier, client, writer);
      }
      if (signal.aborted) throw new Error('The blog job is stopping.');
      originalDraft = candidate;
      stages = [...stages, { stage: 'draftGeneration', result: { draft: candidate }, at: new Date().toISOString() }];
      await save(candidate, capturedEvidence);
    } else {
      progress('Resuming review of the saved draft');
    }
    if (!draft || !evidence) throw new ValidationError('The saved draft and source evidence are required for verification.');
    if (!hasArticleContent(draft)) throw new ValidationError('The saved blog draft has no article content.');
    if (signal.aborted) throw new Error('The blog job is stopping.');
    const record = async (stage: string, result: unknown): Promise<void> => {
      if (signal.aborted) throw new Error('The blog job is stopping.');
      if (stage === 'remediationStarted') remediationUsed = true;
      stages = [...stages, { stage, result, at: new Date().toISOString() }];
      await save(draft!, evidence!);
      if (STAGE_PROGRESS[stage]) progress(STAGE_PROGRESS[stage]);
    };
    let verification: BlogVerification;
    setAiWorkflowStage('editorial-review');
    try {
      if (input['mode'] === 'recheck') {
        progress('Grounding your perspective and anonymising relevant experience');
        setAiWorkflowStage('author-context');
        const authorContext = await buildBlogAuthorContext(db, draft.title, getFoundryClient('blog-specialist'));
        progress('Checking official product documentation for the edited draft');
        setAiWorkflowStage('source-research');
        const researched = await researchBlogEvidence(evidence, getFoundryClient('blog-specialist'), undefined, draft);
        await save(draft, JSON.stringify({ ...JSON.parse(researched) as Record<string, unknown>, authorContext }));
        await record('sourceResearch', (JSON.parse(researched) as Record<string, unknown>)['research']);
        await record('authorContext', {
          insightCount: authorContext.insights.length, sourceCount: authorContext.sources.length, privacyChecked: true,
          withheldInsights: authorContext.withheldInsights,
        });
      }
      const completedParagraphs = new Set<string>();
      setAiWorkflowStage('editorial-review');
      const paragraphIssues: Array<{ field: 'title' | 'excerpt' | 'summary' | 'content' | 'keyTakeaways'; before: string; issues: string[] }> = [];
      for (const stage of stages) {
        if (stage.stage !== 'paragraphReview' || !stage.result || typeof stage.result !== 'object' || Array.isArray(stage.result)) continue;
        const item = stage.result as Record<string, unknown>;
        if (typeof item['id'] === 'string') completedParagraphs.add(item['id']);
        if (typeof item['field'] === 'string' && ['title', 'excerpt', 'summary', 'content', 'keyTakeaways'].includes(item['field'])
          && typeof item['before'] === 'string' && Array.isArray(item['issues']) && item['issues'].every(issue => typeof issue === 'string')) {
          paragraphIssues.push({ field: item['field'] as typeof paragraphIssues[number]['field'], before: item['before'], issues: item['issues'] });
        }
      }
      if (input['mode'] === 'recheck') {
        verification = await evaluateBlogRecheck(draft, { draft, evidence, ...(originalDraft ? { originalDraft } : {}),
          ...(reviewBaseDraft ? { reviewBaseDraft } : {}), stages, voiceSamples },
        record, (current, total) => progress(`Rechecking passage ${current.toString()} of ${total.toString()}`));
      } else {
        const result = await repairBlogDraft(draft, evidence, candidate => save(candidate, evidence!), undefined, {
          record, remediationUsed, originalDraft: originalDraft ?? draft, completedParagraphs, paragraphIssues,
          voiceSamples,
          paragraphResults: stages.filter(stage => stage.stage === 'paragraphReview').map(stage => stage.result),
          paragraphProgress: (current, total) => progress(`Reviewing paragraph or field ${current.toString()} of ${total.toString()}`),
          checkpointParagraph: async (candidate, result) => {
            if (signal.aborted) throw new Error('The blog job is stopping.');
            stages = [...stages, { stage: 'paragraphReview', result, at: new Date().toISOString() }];
            await save(candidate, evidence!);
          },
        });
        draft = result.draft;
        verification = result.verification;
      }
      const coverage = originalDraft
        ? paragraphReviewCoverage(originalDraft, stages, input['mode'] === 'recheck' ? reviewedDraftSignature(draft) : undefined)
        : ['The original draft is unavailable, so the paragraph review cannot be verified.'];
      if (coverage.length) verification = { ...verification, verified: false, issues: [...new Set([...verification.issues, ...coverage])] };
      if (verification.verified) {
        const exact = JSON.stringify([draft.postType, draft.title, draft.excerpt, draft.summary, draft.content, draft.keyTakeaways, draft.categories, draft.tags]);
        if (verifiedPost(draft) !== exact) throw new ValidationError('Publishing would change the draft. Edit and recheck it before sending.');
      }
    } catch (error) {
      if (signal.aborted || error instanceof StaleBlogWorkerError) throw error;
      const message = error instanceof KnowledgeHubError ? error.message : 'The editorial check encountered an unexpected error.';
      console.error(`[blog-specialist] ${jobId} review did not complete: ${error instanceof Error ? error.name : 'unknown error'}`);
      verification = { verified: false, issues: [message] };
      await record('error', { message });
    }
    await record('publicationValidation', verification);
    setAiWorkflowOutcome(verification.verified ? 'ready' : 'review-blocked');
    return {
      data: {
        ...jobData(jobId, subjectId, draft, verification),
        workflow: { originalAvailable: !!originalDraft, stages, remediationUsed },
        ...(verification.verified ? { verifiedSignature: verifiedPost(draft) } : {}),
      },
      summary: verification.verified ? 'The blog draft is ready to review.' : 'The saved blog draft needs attention before it can be sent.',
    };
  },
});
