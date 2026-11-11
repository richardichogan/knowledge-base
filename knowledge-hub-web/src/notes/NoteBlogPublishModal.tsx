import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Launch, Upload } from '@carbon/icons-react';
import { alertDialog, confirmDialog } from '../services/appDialogs';
import { api, type BlogDraft, type NoteBlogPackage } from '../services/api';
import { describeApiError } from '../services/apiError';
import { AppDialog } from '../components/AppDialog';
import { BlogPostEditor } from '../components/discover/BlogPostEditor';

/**
 * Direct note → blog publishing. A Blog draft note's body is parsed into the CMS package
 * fields server-side; this modal lets them be reviewed and corrected, then sent straight
 * to The Microsoft Cloud Blog (live or as a CMS draft). No background job is involved.
 */

interface Edits { excerpt?: string; postType?: BlogDraft['postType']; title?: string; summary?: string; content?: string; takeaways?: string; categories?: string; tags?: string }

type PublishResult = { editUrl: string | null; url: string | null; status: 'draft' | 'published' };

const lines = (value: string): string[] => value.split('\n').map(v => v.trim()).filter(Boolean);
const commas = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);

const NoteBlogDraftEditor: React.FC<{ noteId: string; title: string; initial: NoteBlogPackage; onClose: () => void }> = ({ noteId, title, initial, onClose }) => {
  const [edits, setEdits] = useState<Edits>({});
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
  const value = {
    postType: edits.postType ?? initial.postType,
    title: edits.title ?? initial.title,
    excerpt: edits.excerpt ?? initial.excerpt,
    summary: edits.summary ?? initial.summary,
    content: edits.content ?? initial.content,
    takeaways: edits.takeaways ?? initial.keyTakeaways.join('\n'),
    categories: edits.categories ?? initial.categories.join(', '),
    tags: edits.tags ?? initial.tags.join(', '),
  };
  const set = (key: keyof Edits) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const next = e.target.value;
    setEdits(current => ({ ...current, [key]: next }));
  };
  const invalidCategories = commas(value.categories).filter(category =>
    !categories.data?.some(accepted => accepted.toLowerCase() === category.toLowerCase()));
  const ready = !!(value.title.trim() && value.summary.trim() && value.content.trim() && categories.data && invalidCategories.length === 0);

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
      const r = await api.publishNoteBlogPost(noteId, {
        status,
        ...(initial.slug ? { slug: initial.slug } : {}),
        postType: value.postType, title: value.title.trim(), excerpt: value.excerpt.trim(), summary: value.summary.trim(),
        content: value.content.trim(), keyTakeaways: lines(value.takeaways), categories: commas(value.categories), tags: commas(value.tags),
      });
      if (!r.success) throw new Error(r.error?.message ?? 'Could not publish the post.');
      setResult(r.data);
    } catch (e) {
      setError(describeApiError(e));
      void alertDialog(describeApiError(e), { title: 'Blog post not sent', tone: 'danger' });
    }
    setPublishing(false);
  }

  if (result) return <AppDialog key="note-blog-send-success" title={result.status === 'published' ? 'Post published' : 'Draft saved'} tone="success"
    onClose={onClose} actions={
      <button type="button" className="kh-dialog__button kh-dialog__button--primary" data-dialog-autofocus onClick={onClose}>Done</button>
    }>
    <p className="kh-dialog__message">{result.status === 'published'
      ? `"${value.title.trim()}" is now live on The Microsoft Cloud Blog.`
      : `"${value.title.trim()}" was saved as a draft on the blog.`}</p>
    {(result.url || result.editUrl) && <p className="dc-linkedin__status">
      {result.status === 'published' && result.url && <a href={result.url} target="_blank" rel="noreferrer"><Launch size={16} /> View post</a>}{' '}
      {result.editUrl && <a href={result.editUrl} target="_blank" rel="noreferrer"><Launch size={16} /> Open in blog admin</a>}
    </p>}
  </AppDialog>;
  return <AppDialog title="Publish to blog" wide onClose={onClose}
    actions={<>
      <button type="button" className="kh-dialog__button" disabled={publishing} onClick={onClose}>Close</button>
      <button type="button" className="kh-dialog__button"
        disabled={!ready || publishing} onClick={() => { void publish('draft'); }}>
        <Upload size={16} /> {publishing ? 'Sending...' : 'Save as draft'}
      </button>
      <button type="button" className="kh-dialog__button kh-dialog__button--primary"
        disabled={!ready || publishing} onClick={() => { void publish('published'); }}>
        <Launch size={16} /> Publish live
      </button>
    </>}>
    <div className="dc-blog-review">
      <p className="dc-blog-review__source">Source: {title}</p>
      {publishing && <div className="dc-loading" role="status"><InlineLoading description="Sending to The Microsoft Cloud Blog..." /></div>}
      {initial.missing.length > 0 && <div className="dc-blog-verification" role="status">
        <p>The note did not supply every CMS field. Fill in the gaps below, or in the note itself:</p>
        <ul>{initial.missing.map(field => <li key={field}>{field}</li>)}</ul>
      </div>}
      {categories.isError && <p className="dc-linkedin__error" role="alert">
        Blog categories could not be loaded: {describeApiError(categories.error)}{' '}
        <button type="button" className="kh-dialog__button" onClick={() => { void categories.refetch(); }}>Retry categories</button>
      </p>}
      {categories.data && invalidCategories.length > 0 && <p className="dc-linkedin__error" role="alert">
        Unsupported categories: {invalidCategories.join(', ')}. Update them in Post details before sending.
      </p>}
      {error && <p className="dc-linkedin__error" role="alert">{error}</p>}
      <fieldset className="dc-blog-fields" disabled={publishing}>
        <div className="dc-blog-review__heading-fields">
          <div>
            <label className="dc-linkedin__label" htmlFor="note-blog-title">Title</label>
            <input id="note-blog-title" className="dc-linkedin__url" value={value.title} onChange={set('title')} />
          </div>
          <div>
            <label className="dc-linkedin__label" htmlFor="note-blog-type">Post type</label>
            <select id="note-blog-type" className="dc-filter-select" value={value.postType}
              onChange={(e) => { const next = e.target.value as BlogDraft['postType']; setEdits(current => ({ ...current, postType: next })); }}>
              <option value="article">Article</option><option value="quick">Quick take</option><option value="weekly">Weekly</option>
              <option value="newsletter">Newsletter</option><option value="podcast">Podcast</option>
            </select>
          </div>
        </div>
        <BlogPostEditor value={value.content} disabled={publishing}
          onChange={content => { setEdits(current => ({ ...current, content })); }} />
        <details className="dc-blog-section">
          <summary>Post details</summary>
          <div className="dc-blog-section__fields">
            <label className="dc-linkedin__label" htmlFor="note-blog-excerpt">Excerpt (search and preview text)</label>
            <textarea id="note-blog-excerpt" className="dc-linkedin__copy" rows={2} value={value.excerpt} onChange={set('excerpt')} />
            <label className="dc-linkedin__label" htmlFor="note-blog-summary">{value.postType === 'quick' ? 'Summary (search and AI only, not shown on quick takes)' : 'Summary'}</label>
            <textarea id="note-blog-summary" className="dc-linkedin__copy" rows={2} value={value.summary} onChange={set('summary')} />
            <label className="dc-linkedin__label" htmlFor="note-blog-takeaways">{value.postType === 'quick' ? 'Key takeaways (optional, not shown on quick takes)' : 'Key takeaways (one per line)'}</label>
            <textarea id="note-blog-takeaways" className="dc-linkedin__copy" rows={4} value={value.takeaways} onChange={set('takeaways')} />
            <label className="dc-linkedin__label" htmlFor="note-blog-categories">Categories (comma separated)</label>
            <input id="note-blog-categories" className="dc-linkedin__url" value={value.categories} onChange={set('categories')}
              aria-describedby="note-blog-category-help" aria-invalid={invalidCategories.length > 0} />
            <p id="note-blog-category-help" className="dc-linkedin__status">
              {categories.data ? `Accepted: ${categories.data.join(', ')}.` : 'Loading accepted categories...'}{' '}
              Use tags for topics such as Dynamics 365. Quick take is a post type, not a category.
            </p>
            <label className="dc-linkedin__label" htmlFor="note-blog-tags">Tags (comma separated)</label>
            <input id="note-blog-tags" className="dc-linkedin__url" value={value.tags} onChange={set('tags')} />
          </div>
        </details>
      </fieldset>
    </div>
  </AppDialog>;
};

export const NoteBlogPublishModal: React.FC<{ noteId: string; title: string; onClose: () => void }> = ({ noteId, title, onClose }) => {
  const pkg = useQuery({
    queryKey: ['note-blog-package', noteId],
    queryFn: async () => {
      const response = await api.getNoteBlogPackage(noteId);
      if (!response.success) throw new Error(response.error?.message ?? 'Could not read the blog package from this note.');
      return response.data;
    },
    retry: false, refetchOnWindowFocus: false,
  });
  if (pkg.isError) return <AppDialog title="Publish to blog" onClose={onClose} actions={
    <button type="button" className="kh-dialog__button" data-dialog-autofocus onClick={onClose}>Close</button>
  }>
    <p className="dc-linkedin__error" role="alert">{describeApiError(pkg.error)}</p>
  </AppDialog>;
  if (pkg.isPending || !pkg.data) return <AppDialog title="Publish to blog" onClose={onClose} actions={
    <button type="button" className="kh-dialog__button" onClick={onClose}>Cancel</button>
  }>
    <div className="dc-loading" role="status"><InlineLoading description="Reading the note..." /></div>
  </AppDialog>;
  return <NoteBlogDraftEditor noteId={noteId} title={title} initial={pkg.data} onClose={onClose} />;
};
