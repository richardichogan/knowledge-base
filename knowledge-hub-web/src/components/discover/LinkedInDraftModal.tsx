import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Checkmark, Launch, Renew } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';
import { SHORT_POST_LIMIT, socialLength } from './socialLength';

export const LinkedInDraftModal: React.FC<{ itemId: string; title: string; onClose: () => void }> = ({ itemId, title, onClose }) => {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [markedPublished, setMarkedPublished] = useState(false);
  const [format, setFormat] = useState<'linkedin' | 'short'>('linkedin');
  const [edits, setEdits] = useState<Partial<Record<'linkedin' | 'short', string>>>({});
  const draft = useQuery({
    queryKey: ['discover-linkedin-draft', itemId, format],
    queryFn: async () => {
      const result = await api.createLinkedInDraft(itemId, format);
      if (!result.success) throw new Error(result.error?.message ?? 'Could not generate the draft.');
      return result.data;
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const post = edits[format] ?? draft.data?.post ?? '';
  useEffect(() => { setCopied(false); setCopyError(null); }, [draft.data, draft.dataUpdatedAt, format, edits]);
  const length = socialLength(post, draft.data?.sourceUrl ?? null);
  const tooLong = format === 'short' && length > SHORT_POST_LIMIT;

  async function copy(): Promise<void> {
    if (tooLong) { setCopyError('Shorten the post before copying: the copy and original URL exceed 280 characters.'); return; }
    setSaving(true);
    try {
      await navigator.clipboard.writeText([post.trim(), draft.data?.sourceUrl].filter(Boolean).join('\n\n'));
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopied(false);
      setCopyError('Clipboard access was denied. Select the draft text and copy it manually.');
      setSaving(false);
      return;
    }
    if (draft.data?.sourceKind === 'discovered-article' && !markedPublished) {
      try {
        const result = await api.updateDiscoverWorkflow(itemId, 'published');
        if (!result.success) throw new Error(result.error?.message ?? 'Could not update the article.');
        setMarkedPublished(true);
        void queryClient.invalidateQueries({ queryKey: ['discover'] });
        void queryClient.invalidateQueries({ queryKey: ['discover-sources'] });
      } catch (error) {
        setCopyError(`Post copied, but the article could not be moved to Published. Copy again to retry. ${describeApiError(error)}`);
      }
    }
    setSaving(false);
  }

  return <AppDialog title="Socials" wide onClose={onClose}
    actions={<>
      <button type="button" className="kh-dialog__button" disabled={saving} onClick={onClose}>Close</button>
      <button type="button" className="kh-dialog__button" disabled={draft.isFetching || saving}
        onClick={() => { setEdits(current => ({ ...current, [format]: undefined })); void draft.refetch(); }}>
        <Renew size={16} /> {draft.isFetching ? 'Writing...' : 'Generate again'}
      </button>
      <button type="button" className="kh-dialog__button kh-dialog__button--primary"
        disabled={!post.trim() || tooLong || draft.isFetching || draft.isError || saving} onClick={() => { void copy(); }}>
        {copied ? <Checkmark size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy post + link'}
      </button>
    </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    <div className="dc-linkedin__formats" role="group" aria-label="Social post format">
      <button type="button" disabled={saving} aria-pressed={format === 'linkedin'} onClick={() => { setFormat('linkedin'); }}>LinkedIn</button>
      <button type="button" disabled={saving} aria-pressed={format === 'short'} onClick={() => { setFormat('short'); }}>Bluesky / X</button>
    </div>
    {draft.isFetching && <p className="dc-linkedin__status" role="status">Athena is writing a short post with one enterprise IT observation where relevant...</p>}
    {draft.isError && <p className="dc-linkedin__error" role="alert">{describeApiError(draft.error)}</p>}
    {draft.data && !draft.isFetching && !draft.isError && <>
      <label className="dc-linkedin__label" htmlFor="linkedin-post">Post copy</label>
      <textarea id="linkedin-post" className="dc-linkedin__copy" value={post} rows={7} autoFocus
        onChange={(e) => { const value = e.target.value; setEdits(current => ({ ...current, [format]: value })); setCopied(false); setCopyError(null); }} />
      {format === 'short' && <p className={tooLong ? 'dc-linkedin__error' : 'dc-linkedin__status'} aria-live="polite">
        {length} / {SHORT_POST_LIMIT} characters including URL and paragraph breaks (conservative X weighting).
        {tooLong ? ' Shorten the copy to enable Copy.' : ' Fits both Bluesky and X.'}
      </p>}
      <div className="dc-linkedin__source">
        {draft.data.sourceUrl
          ? <a href={draft.data.sourceUrl} target="_blank" rel="noreferrer"><Launch size={16} /> Open original {draft.data.sourceKind === 'email' ? 'email' : 'article'}</a>
          : <span>No original source link is available.</span>}
        {draft.data.sourceKind === 'email' && <p>Email links require mailbox access. Review the copy for private information before sharing.</p>}
      </div>
      {draft.data.sourceUrl && <input className="dc-linkedin__url" aria-label="Original source link" value={draft.data.sourceUrl} readOnly />}
    </>}
    {copyError && <p className="dc-linkedin__error" role="alert">{copyError}</p>}
    {copied && <p className="dc-linkedin__status" role="status">Copied with paragraph breaks.{markedPublished ? ' Article moved to Published, just like Copy URL.' : ''} Nothing has been posted to social media.</p>}
  </AppDialog>;
};
