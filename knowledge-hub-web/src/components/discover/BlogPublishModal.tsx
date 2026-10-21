import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { alertDialog, confirmDialog } from '../../services/appDialogs';
import { Launch, Renew, Upload } from '@carbon/icons-react';
import { api, type BlogDraft } from '../../services/api';
import type { ApiResponse } from '../../types';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';
import { BlogPostEditor } from './BlogPostEditor';

interface Edits { excerpt?: string; postType?: BlogDraft['postType']; title?: string; summary?: string; content?: string; takeaways?: string; categories?: string; tags?: string }

const lines = (value: string): string[] => value.split('\n').map(v => v.trim()).filter(Boolean);
const commas = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);

type PublishResult = { editUrl: string | null; url: string | null; status: 'draft' | 'published' };

/** Where the draft comes from and where the post is sent; defaults to a Discover item. */
export interface BlogPublishSource {
  key: string;
  draft: (length: 'short' | 'long') => Promise<ApiResponse<BlogDraft>>;
  publish: (post: Omit<BlogDraft, 'sourceUrl'> & { status: 'draft' | 'published' }) => Promise<ApiResponse<PublishResult>>;
  onSent?: (result: PublishResult) => void;
}

export const BlogPublishModal: React.FC<{ itemId?: string; source?: BlogPublishSource; title: string; onClose: () => void }> = ({ itemId, source, title, onClose }) => {
  const target: BlogPublishSource = source ?? {
    key: `discover:${itemId ?? ''}`,
    draft: (len) => api.createBlogDraft(itemId ?? '', len),
    publish: (post) => api.publishBlogPost(itemId ?? '', post),
  };
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Edits>({});
  const [length, setLength] = useState<'short' | 'long'>('short');
  const [publishing, setPublishing] = useState(false);
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
  const draft = useQuery({
    queryKey: ['blog-draft', target.key, length],
    queryFn: async () => {
      const r = await target.draft(length);
      if (!r.success) throw new Error(r.error?.message ?? 'Could not generate the blog draft.');
      return r.data;
    },
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  });
  const d = draft.data;
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
        postType: value.postType,
        title: value.title.trim(), excerpt: value.excerpt.trim(), summary: value.summary.trim(), content: value.content.trim(),
        keyTakeaways: lines(value.takeaways), categories: commas(value.categories), tags: commas(value.tags),
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
  return <AppDialog title="Publish to blog" wide onClose={onClose}
    actions={<>
      <button type="button" className="kh-dialog__button" disabled={publishing} onClick={onClose}>Close</button>
      {!result && <>
        <button type="button" className="kh-dialog__button" disabled={draft.isFetching || publishing}
          onClick={() => { setEdits({}); void draft.refetch(); }}>
          <Renew size={16} /> {draft.isFetching ? 'Writing...' : 'Generate again'}
        </button>
        <button type="button" className="kh-dialog__button"
          disabled={!ready || draft.isFetching || draft.isError || publishing} onClick={() => { void publish('draft'); }}>
          <Upload size={16} /> {publishing ? 'Sending...' : 'Save as draft'}
        </button>
        <button type="button" className="kh-dialog__button kh-dialog__button--primary"
          disabled={!ready || draft.isFetching || draft.isError || publishing} onClick={() => { void publish('published'); }}>
          <Launch size={16} /> Publish live
        </button>
      </>}
    </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    {!result && <div className="dc-linkedin__formats" role="group" aria-label="Post length">
      <button type="button" disabled={publishing || draft.isFetching} aria-pressed={length === 'short'} onClick={() => { setLength('short'); setEdits({}); }}>Quick take</button>
      <button type="button" disabled={publishing || draft.isFetching} aria-pressed={length === 'long'} onClick={() => { setLength('long'); setEdits({}); }}>Article</button>
    </div>}
    {draft.isFetching && <div className="dc-loading" role="status"><InlineLoading description={`Athena is writing ${length === 'short' ? 'a quick take' : 'an article'} in the blog house style...`} /></div>}
    {publishing && <div className="dc-loading" role="status"><InlineLoading description="Sending to The Microsoft Cloud Blog..." /></div>}
    {draft.isError && <p className="dc-linkedin__error" role="alert">{describeApiError(draft.error)}</p>}
    {categories.isError && <p className="dc-linkedin__error" role="alert">
      Blog categories could not be loaded: {describeApiError(categories.error)}{' '}
      <button type="button" className="kh-dialog__button" onClick={() => { void categories.refetch(); }}>Retry categories</button>
    </p>}
    {d && !draft.isFetching && !draft.isError && !result && <>
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
      <BlogPostEditor value={value.content} disabled={publishing}
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
    </>}
    {error && <p className="dc-linkedin__error" role="alert">{error}</p>}
    {result && <p className="dc-linkedin__status" role="status">
      {result.status === 'published' ? 'Published live.' : 'Draft created on the blog.'}{' '}
      {result.status === 'published' && result.url && <a href={result.url} target="_blank" rel="noreferrer"><Launch size={16} /> View post</a>}{' '}
      {result.editUrl && <a href={result.editUrl} target="_blank" rel="noreferrer"><Launch size={16} /> Open in blog admin</a>}
    </p>}
  </AppDialog>;
};
