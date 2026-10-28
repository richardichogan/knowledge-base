import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { alertDialog, confirmDialog } from '../../services/appDialogs';
import { Launch, Renew, Upload } from '@carbon/icons-react';
import { api, type BlogDraft, type BlogJobResult } from '../../services/api';
import type { ApiResponse } from '../../types';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';
import { BlogPostEditor } from './BlogPostEditor';
import { rememberAgentJob } from '../../services/agentJobStore';

interface Edits { excerpt?: string; postType?: BlogDraft['postType']; title?: string; summary?: string; content?: string; takeaways?: string; categories?: string; tags?: string }

const lines = (value: string): string[] => value.split('\n').map(v => v.trim()).filter(Boolean);
const commas = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);

type PublishResult = { editUrl: string | null; url: string | null; status: 'draft' | 'published' };

const stageLabels: Record<string, string> = {
  paragraphReview: 'Paragraph review',
  paragraphReviewError: 'Paragraph review error',
  paragraphRecheck: 'Read-only paragraph recheck',
  paragraphRecheckError: 'Paragraph recheck error',
  paragraphFieldRecheck: 'Read-only changed passage recheck',
  factReview: 'Fact review', styleReview: 'Style review', consolidation: 'Editorial consolidation',
  draftGeneration: 'Complete draft', validation: 'Initial validation', remediation: 'Remediation',
  postRemediationfactReview: 'Fact recheck', postRemediationstyleReview: 'Style recheck',
  recheckfactReview: 'Fact recheck', recheckstyleReview: 'Style recheck',
  recheckfactReviewError: 'Fact recheck error', recheckstyleReviewError: 'Style recheck error',
  finalValidation: 'Final validation', publicationValidation: 'Publication validation', error: 'Review error',
  factReviewError: 'Fact review error', styleReviewError: 'Style review error', remediationError: 'Remediation error',
  postRemediationfactReviewError: 'Fact recheck error', postRemediationstyleReviewError: 'Style recheck error',
};

function stageDetails(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const value = result as Record<string, unknown>;
  const details: string[] = [];
  if (typeof value['id'] === 'string' && typeof value['field'] === 'string' && typeof value['action'] === 'string') {
    const kind = typeof value['kind'] === 'string' ? `, ${value['kind']}` : '';
    details.push(`${value['id']} (${value['field']}${kind}): ${value['action']}`);
    if (typeof value['before'] === 'string' && value['action'] !== 'keep') details.push(`Original: ${value['before']}`);
    if (typeof value['after'] === 'string' && value['after']) details.push(`Proposed: ${value['after']}`);
  }
  if (Array.isArray(value['findings'])) {
    for (const finding of value['findings']) {
      if (finding && typeof finding === 'object' && 'reason' in finding && typeof finding.reason === 'string') {
        const passage = 'before' in finding && typeof finding.before === 'string' ? finding.before
          : 'claim' in finding && typeof finding.claim === 'string' ? finding.claim : '';
        details.push(passage ? `${finding.reason} (${passage})` : finding.reason);
        if ('sourcePassages' in finding && Array.isArray(finding.sourcePassages)) {
          for (const source of finding.sourcePassages) {
            if (source && typeof source === 'object' && 'id' in source && 'text' in source
              && typeof source.id === 'string' && typeof source.text === 'string') {
              details.push(`Source ${source.id}: ${source.text}`);
            }
          }
        }
      }
    }
    if (!value['findings'].length) details.push('No findings.');
  }
  if (Array.isArray(value['issues'])) details.push(...value['issues'].filter((item): item is string => typeof item === 'string'));
  if (typeof value['message'] === 'string') details.push(value['message']);
  if (Array.isArray(value['edits'])) details.push(`${value['edits'].length} targeted correction(s) proposed.`);
  if ('verified' in value && typeof value['verified'] === 'boolean') details.push(value['verified'] ? 'Automated checks passed.' : 'Automated checks incomplete or findings remain.');
  if (value['verification'] && typeof value['verification'] === 'object' && 'verified' in value['verification']) {
    details.push(value['verification'].verified === true ? 'Automated checks passed.' : 'Automated checks incomplete or findings remain.');
    if ('issues' in value['verification'] && Array.isArray(value['verification'].issues)) {
      details.push(...value['verification'].issues.filter((issue): issue is string => typeof issue === 'string'));
    }
  }
  if (value['draft']) details.push('Complete draft saved.');
  return [...new Set(details)];
}

/** Where the draft comes from and where the post is sent; defaults to a Discover item. */
export interface BlogPublishSource {
  key: string;
  publish: (post: Omit<BlogDraft, 'sourceUrl'> & { status: 'draft' | 'published'; jobId: string }) => Promise<ApiResponse<PublishResult>>;
  onSent?: (result: PublishResult) => void;
}

type Props = { itemId?: string; source?: BlogPublishSource; title: string; onClose: () => void };

async function startBlogJob(subjectId: string, length: 'short' | 'long'): Promise<void> {
  const response = await api.handOffToSpecialist('blog-writer', subjectId, { length });
  if (!response.success) throw new Error(response.error?.message ?? 'Could not start the blog specialist.');
  if (response.data.status === 'needs_confirmation') throw new Error(response.data.message);
  if (response.data.status === 'already_running') throw new Error('A blog draft is already being written for this source. You will be notified when it is ready.');
  rememberAgentJob(response.data.job);
}

export const BlogPublishModal: React.FC<Props> = ({ itemId, source, title, onClose }) => {
  const [length, setLength] = useState<'short' | 'long' | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectId = source?.key ?? `discover:${itemId ?? ''}`;
  async function start(): Promise<void> {
    if (!length) return;
    setStarting(true);
    setError(null);
    try { await startBlogJob(subjectId, length); onClose(); }
    catch (e) { setError(describeApiError(e)); setStarting(false); }
  }
  return <AppDialog title="Publish to blog" onClose={onClose} actions={<>
    <button type="button" className="kh-dialog__button" disabled={starting} onClick={onClose}>Cancel</button>
    <button type="button" className="kh-dialog__button kh-dialog__button--primary" disabled={!length || starting}
      onClick={() => { void start(); }}>{starting ? 'Starting...' : 'Start drafting'}</button>
  </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    <p className="dc-linkedin__status">Choose a format. Athena will notify you when the draft is ready to review.</p>
    <div className="dc-linkedin__formats" role="group" aria-label="Post length">
      <button type="button" disabled={starting} aria-pressed={length === 'short'} onClick={() => { setLength('short'); }}>Quick take</button>
      <button type="button" disabled={starting} aria-pressed={length === 'long'} onClick={() => { setLength('long'); }}>Article</button>
    </div>
    {error && <p className="dc-linkedin__error" role="alert">{error}</p>}
  </AppDialog>;
};

export const BlogDraftEditor: React.FC<Props & { jobId: string; initial: BlogJobResult }> = ({ itemId, source, title, onClose, jobId, initial }) => {
  const target: BlogPublishSource = source ?? {
    key: `discover:${itemId ?? ''}`,
    publish: (post) => api.publishBlogPost(itemId ?? '', post),
  };
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Edits>({});
  const job = initial;
  const [publishing, setPublishing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const categories = useQuery({
    queryKey: ['blog-categories'],
    queryFn: async () => {
      const response = await api.getBlogCategories();
      if (!response.success) throw new Error(response.error?.message ?? 'Could not load blog categories.');
      return response.data;
    },
    retry: false, refetchOnWindowFocus: false,
  });
  const d = job.draft;
  const value = {
    postType: edits.postType ?? d?.postType ?? 'article',
    title: edits.title ?? d?.title ?? '',
    excerpt: edits.excerpt ?? d?.excerpt ?? '',
    summary: edits.summary ?? d?.summary ?? '',
    content: edits.content ?? d?.content ?? '',
    takeaways: edits.takeaways ?? d?.keyTakeaways.join('\n') ?? '',
    categories: edits.categories ?? d?.categories.join(', ') ?? '',
    tags: edits.tags ?? d?.tags.join(', ') ?? '',
  };
  const set = (key: keyof Edits) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const next = e.target.value;
    setEdits(c => ({ ...c, [key]: next }));
  };
  const post = {
    postType: value.postType, title: value.title.trim(), excerpt: value.excerpt.trim(), summary: value.summary.trim(),
    content: value.content.trim(), keyTakeaways: lines(value.takeaways), categories: commas(value.categories), tags: commas(value.tags),
  };
  const signature = JSON.stringify([post.postType, post.title, post.excerpt, post.summary, post.content, post.keyTakeaways, post.categories, post.tags]);
  const verified = job.verification.verified && job.verifiedSignature === signature;

  async function recheck(): Promise<void> {
    setChecking(true);
    setError(null);
    try {
      const response = await api.recheckBlogJob(jobId, post);
      if (!response.success) throw new Error(response.error?.message ?? 'Could not recheck the draft.');
      rememberAgentJob(response.data);
      onClose();
    } catch (e) { setError(describeApiError(e)); }
    finally { setChecking(false); }
  }

  async function generateAgain(): Promise<void> {
    setStarting(true);
    setError(null);
    try { await startBlogJob(target.key, d.postType === 'quick' ? 'short' : 'long'); onClose(); }
    catch (e) { setError(describeApiError(e)); setStarting(false); }
  }

  async function publish(status: 'draft' | 'published'): Promise<void> {
    if (!categories.data || invalidCategories.length > 0) {
      setError('Choose only accepted blog categories before sending. Other topics belong in tags.');
      return;
    }
    if (status === 'published') {
      const warning = value.postType === 'newsletter' ? ' This is a newsletter, so subscribers will be emailed.' : '';
      const ok = await confirmDialog(`Publish "${value.title.trim()}" live on themicrosoftcloudblog.com now?${warning}`,
        { title: 'Publish live', confirmLabel: 'Publish live' });
      if (!ok) return;
    }
    setPublishing(true);
    setError(null);
    try {
      const r = await target.publish({
        status,
        ...post, jobId,
      });
      if (!r.success) throw new Error(r.error?.message ?? 'Could not publish the post.');
      setResult(r.data);
      target.onSent?.(r.data);
      void alertDialog(status === 'published'
        ? `"${value.title.trim()}" is now live on The Microsoft Cloud Blog.`
        : `"${value.title.trim()}" was saved as a draft on the blog. Open it in the blog admin to review and publish.`,
      { title: status === 'published' ? 'Post published' : 'Draft saved', tone: 'success' });
      if (status === 'published') {
        void queryClient.invalidateQueries({ queryKey: ['discover'] });
        void queryClient.invalidateQueries({ queryKey: ['discover-sources'] });
      }
    } catch (e) {
      setError(describeApiError(e));
      void alertDialog(describeApiError(e), { title: 'Blog post not sent', tone: 'danger' });
    }
    setPublishing(false);
  }

  const invalidCategories = commas(value.categories).filter(category =>
    !categories.data?.some(accepted => accepted.toLowerCase() === category.toLowerCase()));
  const ready = !!(value.title.trim() && value.summary.trim() && value.content.trim() && categories.data && invalidCategories.length === 0);
  const busy = publishing || checking || starting;
  return <AppDialog title="Publish to blog" wide onClose={onClose}
    actions={<>
      <button type="button" className="kh-dialog__button" disabled={busy} onClick={onClose}>Close</button>
      {!result && <>
        <button type="button" className="kh-dialog__button" disabled={busy} onClick={() => { void generateAgain(); }}>
          <Renew size={16} /> {starting ? 'Starting...' : 'Generate again'}
        </button>
        <button type="button" className="kh-dialog__button" disabled={busy || verified || !ready} onClick={() => { void recheck(); }}>
          <Renew size={16} /> {checking ? 'Checking...' : 'Recheck draft'}
        </button>
        <button type="button" className="kh-dialog__button"
          disabled={!ready || !verified || busy} onClick={() => { void publish('draft'); }}>
          <Upload size={16} /> {publishing ? 'Sending...' : 'Save as draft'}
        </button>
        <button type="button" className="kh-dialog__button kh-dialog__button--primary"
          disabled={!ready || !verified || busy} onClick={() => { void publish('published'); }}>
          <Launch size={16} /> Publish live
        </button>
      </>}
    </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    {checking && <div className="dc-loading" role="status"><InlineLoading description="Starting the draft recheck..." /></div>}
    {publishing && <div className="dc-loading" role="status"><InlineLoading description="Sending to The Microsoft Cloud Blog..." /></div>}
    {!result && !verified && <div className="dc-blog-verification" role="status">
      <p>Draft saved. Review is incomplete or has unresolved findings. Recheck the current draft before sending it to the blog.</p>
      {job.verification.issues.length > 0 && <ul>{job.verification.issues.map((issue, index) => <li key={`${index.toString()}-${issue}`}>{issue}</li>)}</ul>}
    </div>}
    {!result && verified && <p className="dc-linkedin__status" role="status">
      Automated checks found no unresolved issues in this draft. They do not independently prove every claim or guarantee the intended voice; review it before publishing.
    </p>}
    {!result && job.workflow && <details className="dc-blog-workflow">
      <summary>Review stages</summary>
      {!job.workflow.originalAvailable && <p>The original draft was not recorded for this older job.</p>}
      <ul>{job.workflow.stages.filter(stage => stageLabels[stage.stage]).map((stage, index) => {
        const details = stageDetails(stage.result);
        return <li key={`${stage.stage}-${stage.at}-${index.toString()}`}>
          <strong>{stageLabels[stage.stage]}</strong>
          {details.length > 0 && <ul>{details.map((detail, i) => <li key={`${i.toString()}-${detail}`}>{detail}</li>)}</ul>}
        </li>;
      })}</ul>
    </details>}
    {categories.isError && <p className="dc-linkedin__error" role="alert">
      Blog categories could not be loaded: {describeApiError(categories.error)}{' '}
      <button type="button" className="kh-dialog__button" onClick={() => { void categories.refetch(); }}>Retry categories</button>
    </p>}
    {!result && <fieldset className="dc-blog-fields" disabled={busy}>
      <label className="dc-linkedin__label" htmlFor="blog-type">Post type</label>
      <select id="blog-type" className="dc-filter-select" value={value.postType}
        onChange={(e) => { const next = e.target.value as BlogDraft['postType']; setEdits(c => ({ ...c, postType: next })); }}>
        <option value="article">Article</option><option value="quick">Quick take</option><option value="weekly">Weekly</option>
        <option value="newsletter">Newsletter</option><option value="podcast">Podcast</option>
      </select>
      <label className="dc-linkedin__label" htmlFor="blog-title">Title</label>
      <input id="blog-title" className="dc-linkedin__url" value={value.title} onChange={set('title')} />
      <label className="dc-linkedin__label" htmlFor="blog-excerpt">Excerpt (search and preview text)</label>
      <textarea id="blog-excerpt" className="dc-linkedin__copy" rows={2} value={value.excerpt} onChange={set('excerpt')} />
      <label className="dc-linkedin__label" htmlFor="blog-summary">{value.postType === 'quick' ? 'Summary (search and AI only, not shown on quick takes)' : 'Summary'}</label>
      <textarea id="blog-summary" className="dc-linkedin__copy" rows={2} value={value.summary} onChange={set('summary')} />
      <BlogPostEditor value={value.content} disabled={busy}
        onChange={content => { setEdits(current => ({ ...current, content })); }} />
      <label className="dc-linkedin__label" htmlFor="blog-takeaways">{value.postType === 'quick' ? 'Key takeaways (optional, not shown on quick takes)' : 'Key takeaways (one per line)'}</label>
      <textarea id="blog-takeaways" className="dc-linkedin__copy" rows={4} value={value.takeaways} onChange={set('takeaways')} />
      <label className="dc-linkedin__label" htmlFor="blog-categories">Categories (comma separated)</label>
      <input id="blog-categories" className="dc-linkedin__url" value={value.categories} onChange={set('categories')}
        aria-describedby="blog-category-help" aria-invalid={invalidCategories.length > 0} />
      <p id="blog-category-help" className="dc-linkedin__status">
        {categories.data ? `Accepted: ${categories.data.join(', ')}.` : 'Loading accepted categories...'}{' '}
        Use tags for topics such as Dynamics 365. Quick take is a post type, not a category.
      </p>
      {categories.data && invalidCategories.length > 0 && <p className="dc-linkedin__error" role="alert">
        Unsupported categories: {invalidCategories.join(', ')}. Replace them with accepted categories or move them to tags.
      </p>}
      <label className="dc-linkedin__label" htmlFor="blog-tags">Tags (comma separated)</label>
      <input id="blog-tags" className="dc-linkedin__url" value={value.tags} onChange={set('tags')} />
      <p className="dc-linkedin__status">Save as draft to review it in the blog admin first, or Publish live to post it straight away.</p>
    </fieldset>}
    {error && <p className="dc-linkedin__error" role="alert">{error}</p>}
    {result && <p className="dc-linkedin__status" role="status">
      {result.status === 'published' ? 'Published live.' : 'Draft created on the blog.'}{' '}
      {result.status === 'published' && result.url && <a href={result.url} target="_blank" rel="noreferrer"><Launch size={16} /> View post</a>}{' '}
      {result.editUrl && <a href={result.editUrl} target="_blank" rel="noreferrer"><Launch size={16} /> Open in blog admin</a>}
    </p>}
  </AppDialog>;
};
