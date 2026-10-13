import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Launch, Renew, Upload } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';

interface Edits { title?: string; summary?: string; content?: string; takeaways?: string; categories?: string; tags?: string }

const lines = (value: string): string[] => value.split('\n').map(v => v.trim()).filter(Boolean);
const commas = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);

export const BlogPublishModal: React.FC<{ itemId: string; title: string; onClose: () => void }> = ({ itemId, title, onClose }) => {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Edits>({});
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ editUrl: string | null } | null>(null);
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

  async function publish(): Promise<void> {
    setPublishing(true);
    setError(null);
    try {
      const r = await api.publishBlogPost(itemId, {
        title: value.title.trim(), summary: value.summary.trim(), content: value.content.trim(),
        keyTakeaways: lines(value.takeaways), categories: commas(value.categories), tags: commas(value.tags),
      });
      if (!r.success) throw new Error(r.error?.message ?? 'Could not publish the post.');
      setResult(r.data);
      void queryClient.invalidateQueries({ queryKey: ['discover'] });
      void queryClient.invalidateQueries({ queryKey: ['discover-sources'] });
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
        <button type="button" className="kh-dialog__button kh-dialog__button--primary"
          disabled={!ready || draft.isFetching || draft.isError || publishing} onClick={() => { void publish(); }}>
          <Upload size={16} /> {publishing ? 'Sending...' : 'Send as blog draft'}
        </button>
      </>}
    </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    {draft.isFetching && <p className="dc-linkedin__status" role="status">Athena is writing a draft post...</p>}
    {draft.isError && <p className="dc-linkedin__error" role="alert">{describeApiError(draft.error)}</p>}
    {d && !draft.isFetching && !draft.isError && !result && <>
      <label className="dc-linkedin__label" htmlFor="blog-title">Title</label>
      <input id="blog-title" className="dc-linkedin__url" value={value.title} onChange={set('title')} />
      <label className="dc-linkedin__label" htmlFor="blog-summary">Summary</label>
      <textarea id="blog-summary" className="dc-linkedin__copy" rows={2} value={value.summary} onChange={set('summary')} />
      <label className="dc-linkedin__label" htmlFor="blog-content">Post (Markdown)</label>
      <textarea id="blog-content" className="dc-linkedin__copy" rows={14} value={value.content} onChange={set('content')} />
      <label className="dc-linkedin__label" htmlFor="blog-takeaways">Key takeaways (one per line)</label>
      <textarea id="blog-takeaways" className="dc-linkedin__copy" rows={4} value={value.takeaways} onChange={set('takeaways')} />
      <label className="dc-linkedin__label" htmlFor="blog-categories">Categories (comma separated)</label>
      <input id="blog-categories" className="dc-linkedin__url" value={value.categories} onChange={set('categories')} />
      <label className="dc-linkedin__label" htmlFor="blog-tags">Tags (comma separated)</label>
      <input id="blog-tags" className="dc-linkedin__url" value={value.tags} onChange={set('tags')} />
      <p className="dc-linkedin__status">This creates a draft on themicrosoftcloudblog.com for you to review; it is not published live.</p>
    </>}
    {error && <p className="dc-linkedin__error" role="alert">{error}</p>}
    {result && <p className="dc-linkedin__status" role="status">
      Draft created on the blog.{' '}
      {result.editUrl && <a href={result.editUrl} target="_blank" rel="noreferrer"><Launch size={16} /> Open draft to edit</a>}
    </p>}
  </AppDialog>;
};
