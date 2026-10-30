import { anonymiseBlogAuthorContext, type BlogAuthorRecord } from '../../ai/blogAuthorContext.js';
import {
  blogEvidence, finishPreparedBlogDraft, prepareBlogDraft, prepareIdeasBlogDraft, readBlogSource, writeBlogCandidate,
  type BlogDraft, type BlogLength, type BlogSource, type BlogVoiceSample, type EarlierPost, type PreparedBlogDraft,
} from '../../ai/blogDraft.js';
import {
  critiqueBlogCandidate, reviseBlogCandidate, type BlogCritique,
} from '../../ai/blogEditorial.js';
import { withAiStage } from '../../ai/aiWorkflow.js';
import type { FoundryClient } from '../../ai/foundryClient.js';
import { sourceUrl } from '../../ai/linkedInDraft.js';
import { record } from './contracts.js';
import { ValidationError } from '../../types/errors.js';

type BlogModel = Pick<FoundryClient, 'chat'>;

/** The domain adapter supplies only already-authorised, version-bound records, never a database/search capability. */
export interface ScopedBlogResearch {
  instruction: string;
  source: { kind: 'discover'; article: BlogSource }
    | { kind: 'spark-theme'; theme: string; ideas: Array<{ body: string; sourceTitle: string | null }> };
  length: BlogLength;
  earlierPosts: EarlierPost[];
  voiceSamples: BlogVoiceSample[];
  authorRecords: BlogAuthorRecord[];
}

export interface BlogResearchPackage {
  prepared: PreparedBlogDraft;
  evidence: string;
  voiceSamples: BlogVoiceSample[];
}

export function researchManualBlog(input: ScopedBlogResearch, client: BlogModel): Promise<BlogResearchPackage> {
  if (!input.authorRecords.length) {
    return Promise.reject(new ValidationError('The blog team requires scoped author grounding before research can start. No research or model call was made.'));
  }
  return withAiStage('iris:blog-research', async () => {
    let prepared: PreparedBlogDraft;
    let topic: string;
    if (input.source.kind === 'discover') {
      const source = await readBlogSource(input.source.article);
      topic = source.title;
      prepared = await prepareBlogDraft(source, sourceUrl(source.url), input.length, input.earlierPosts, client);
    } else {
      topic = input.source.theme;
      prepared = await prepareIdeasBlogDraft(topic, input.source.ideas, input.length, input.earlierPosts, client);
    }
    const authorContext = await anonymiseBlogAuthorContext(input.authorRecords, topic, client);
    const source = record(JSON.parse(prepared.user), 'Prepared blog evidence');
    return {
      prepared: {
        ...prepared,
        user: JSON.stringify({ ...source, agreedInstruction: input.instruction, authorContext: {
          insights: authorContext.insights.map(({ basis, text }) => ({ basis, text })), privacyChecked: true,
        } }),
      },
      evidence: blogEvidence(JSON.stringify({ ...source, authorContext })),
      voiceSamples: input.voiceSamples,
    };
  });
}

export function authorManualBlog(research: BlogResearchPackage, client: BlogModel): Promise<BlogDraft> {
  return withAiStage('calliope:blog-draft', async () => {
    const { prepared } = research;
    const draft = await writeBlogCandidate(client, prepared.system, prepared.user, prepared.quick, prepared.sourceUrl, research.voiceSamples);
    return finishPreparedBlogDraft(prepared, draft);
  });
}

export function critiqueManualBlog(
  research: BlogResearchPackage, original: BlogDraft, draft: BlogDraft, draftSignature: string,
  client: BlogModel, progress?: (current: number, total: number) => void,
): Promise<BlogCritique> {
  return withAiStage('momus:blog-critique', () =>
    critiqueBlogCandidate(original, draft, research.evidence, draftSignature, client, research.voiceSamples, progress));
}

export function reviseManualBlog(
  research: BlogResearchPackage, draft: BlogDraft, critique: BlogCritique, client: BlogModel,
): Promise<BlogDraft> {
  return withAiStage('calliope:blog-targeted-revision', () =>
    reviseBlogCandidate(draft, research.evidence, critique, client, research.voiceSamples));
}
