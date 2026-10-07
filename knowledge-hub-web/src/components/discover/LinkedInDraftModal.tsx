import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Checkmark, Launch, Renew } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';

export const LinkedInDraftModal: React.FC<{ itemId: string; title: string; onClose: () => void }> = ({ itemId, title, onClose }) => {
  const [post, setPost] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const draft = useQuery({
    queryKey: ['discover-linkedin-draft', itemId],
    queryFn: async () => {
      const result = await api.createLinkedInDraft(itemId);
      if (!result.success) throw new Error(result.error?.message ?? 'Could not generate the draft.');
      return result.data;
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => { if (draft.data) { setPost(draft.data.post); setCopied(false); setCopyError(null); } }, [draft.data, draft.dataUpdatedAt]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText([post.trim(), draft.data?.sourceUrl].filter(Boolean).join('\n\n'));
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopied(false);
      setCopyError('Clipboard access was denied. Select the draft text and copy it manually.');
    }
  }

  return <AppDialog title="Quick LinkedIn post" wide onClose={onClose}
    actions={<>
      <button type="button" className="kh-dialog__button" onClick={onClose}>Close</button>
      <button type="button" className="kh-dialog__button" disabled={draft.isFetching}
        onClick={() => { void draft.refetch(); }}>
        <Renew size={16} /> {draft.isFetching ? 'Writing...' : 'Generate again'}
      </button>
      <button type="button" className="kh-dialog__button kh-dialog__button--primary"
        disabled={!post.trim() || draft.isFetching || draft.isError} onClick={() => { void copy(); }}>
        {copied ? <Checkmark size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy post + link'}
      </button>
    </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    {draft.isFetching && <p className="dc-linkedin__status" role="status">Athena is writing a short post with one enterprise IT observation where relevant...</p>}
    {draft.isError && <p className="dc-linkedin__error" role="alert">{describeApiError(draft.error)}</p>}
    {draft.data && !draft.isFetching && !draft.isError && <>
      <label className="dc-linkedin__label" htmlFor="linkedin-post">Post copy</label>
      <textarea id="linkedin-post" className="dc-linkedin__copy" value={post} rows={7} autoFocus
        onChange={(e) => { setPost(e.target.value); setCopied(false); setCopyError(null); }} />
      <div className="dc-linkedin__source">
        {draft.data.sourceUrl
          ? <a href={draft.data.sourceUrl} target="_blank" rel="noreferrer"><Launch size={16} /> Open original {draft.data.sourceKind === 'email' ? 'email' : 'article'}</a>
          : <span>No original source link is available.</span>}
        {draft.data.sourceKind === 'email' && <p>Email links require mailbox access. Review the copy for private information before sharing.</p>}
      </div>
      {draft.data.sourceUrl && <input className="dc-linkedin__url" aria-label="Original source link" value={draft.data.sourceUrl} readOnly />}
    </>}
    {copyError && <p className="dc-linkedin__error" role="alert">{copyError}</p>}
    {copied && <p className="dc-linkedin__status" role="status">Copied with paragraph breaks. Nothing has been published.</p>}
  </AppDialog>;
};
