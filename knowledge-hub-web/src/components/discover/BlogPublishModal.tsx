import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Launch, Renew, Upload } from '@carbon/icons-react';
import { api, type BlogDraft } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';

interface Edits { postType?: BlogDraft['postType']; title?: string; summary?: string; content?: string; takeaways?: string; categories?: string; tags?: string }

const lines = (value: string): string[] => value.split('\n').map(v => v.trim()).filter(Boolean);
const commas = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);

export const BlogPublishModal: React.FC<{ itemId: string; title: string; onClose: () => void }> = ({ itemId, title, onClose }) => {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Edits>({});
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ editUrl: string | null; url: string | null; status: 'draft' | 'published' } | null>(null);
  const draft = useQuery({
    queryKey: ['discover-blog-draft', itemId],
    queryFn: async () => {
      const r = await api.createBlogDraft(itemId);
      if (!r.success) throw new Error(r.error?.message ?? 'Could not generate the blog draft.');
      return r.data;
    },
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  });
  const d = draft.data;
  const value = {
    postType: edits.postType ?? d?.postType ?? 'article',
    title: edits.title ?? d?.title ?? '',
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
    if (status === 'published') {
      const warning = value.postType === 'newsletter' ? ' This is a newsletter, so subscribers will be emailed.' : '';
      if (!window.confirm(`Publish "${value.title.trim()}" live on themicrosoftcloudblog.com now?${warning}`)) return;
    }
    setPublishing(true);
    setError(null);
    try {
      const r = await api.publishBlogPost(itemId, {
        status,
        postType: value.postType,
        title: value.title.trim(), summary: value.summary.trim(), content: value.content.trim(),
        keyTakeaways: lines(value.takeaways), categories: commas(value.categories), tags: commas(value.tags),
      });
      if (!r.success) throw new Error(r.error?.message ?? 'Could not publish the post.');
      setResult(r.data);
      if (status === 'published') {
        void queryClient.invalidateQueries({ queryKey: ['discover'] });
        void queryClient.invalidateQueries({ queryKey: ['discover-sources'] });
      }
    } catch (e) {
      setError(describeApiError(e));
    }
    setPublishing(false);
  }

  const ready = !!(value.title.trim() && value.summary.trim() && value.content.trim());
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
    {draft.isFetching && <p className="dc-linkedin__status" role="status">Athena is writing a draft post...</p>}
    {draft.isError && <p className="dc-linkedin__error" role="alert">{describeApiError(draft.error)}</p>}
    {d && !draft.isFetching && !draft.isError && !result && <>
      <label className="dc-linkedin__label" htmlFor="blog-type">Post type</label>
      <select id="blog-type" className="dc-filter-select" value={value.postType}
        onChange={(e) => { const next = e.target.value as BlogDraft['postType']; setEdits(c => ({ ...c, postType: next })); }}>
        <option value="article">Article</option><option value="weekly">Weekly</option>
        <option value="newsletter">Newsletter</option><option value="podcast">Podcast</option>
      </select>
      <label className="dc-linkedin__label" htmlFor="blog-title">Title</label>
      <input id="blog-title" className="dc-linkedin__url" value={value.title} onChange={set('title')} />
      <label className="dc-linkedin__label" htmlFor="blog-summary">Summary</label>
      <textarea id="blog-summary" className="dc-linkedin__copy" rows={2} value={value.summary} onChange={set('summary')} />
      <label className="dc-linkedin__label" htmlFor="blog-content">Post (HTML)</label>
      <textarea id="blog-content" className="dc-linkedin__copy" rows={14} value={value.content} onChange={set('content')} />
      <label className="dc-linkedin__label" htmlFor="blog-takeaways">Key takeaways (one per line)</label>
      <textarea id="blog-takeaways" className="dc-linkedin__copy" rows={4} value={value.takeaways} onChange={set('takeaways')} />
      <label className="dc-linkedin__label" htmlFor="blog-categories">Categories (comma separated)</label>
      <input id="blog-categories" className="dc-linkedin__url" value={value.categories} onChange={set('categories')} />
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
