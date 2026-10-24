import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Checkmark, Launch, Renew, Send } from '@carbon/icons-react';
import { api, type SocialDraft } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { confirmDialog } from '../../services/appDialogs';
import { AppDialog } from '../AppDialog';
import { BLUESKY_POST_LIMIT, LINKEDIN_POST_LIMIT, SHORT_POST_LIMIT, blueskyLength, linkedinLength, socialLength } from './socialLength';

export const LinkedInDraftModal: React.FC<{ itemId: string; title: string; onClose: () => void }> = ({ itemId, title, onClose }) => {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [markedPublished, setMarkedPublished] = useState(false);
  const [format, setFormat] = useState<'linkedin' | 'short'>('linkedin');
  const [edits, setEdits] = useState<Partial<Record<'linkedin' | 'short', string>>>({});
  const [posting, setPosting] = useState<'bluesky' | 'linkedin' | null>(null);
  const [blueskyUrl, setBlueskyUrl] = useState<string | null>(null);
  const [linkedinUrl, setLinkedinUrl] = useState<string | null>(null);
  const [linkedinWarning, setLinkedinWarning] = useState<string | null>(null);
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
  const postedUrl = blueskyUrl ?? draft.data?.blueskyPostUrl ?? null;
  const canPostBluesky = format === 'short' && draft.data?.sourceKind === 'discovered-article' && draft.data.blueskyConfigured === true;
  const tooLongForBluesky = blueskyLength(post, draft.data?.sourceUrl ?? null) > BLUESKY_POST_LIMIT;
  const linkedinPostUrl = linkedinUrl ?? draft.data?.linkedinPostUrl ?? null;
  const linkedinPostPending = !linkedinPostUrl && draft.data?.linkedinPostStatus != null;
  const canPostLinkedIn = format === 'linkedin' && draft.data?.sourceKind === 'discovered-article' && draft.data.linkedinConfigured === true;
  const linkedinCharacters = linkedinLength(post, draft.data?.sourceUrl ?? null);
  const tooLongForLinkedIn = linkedinCharacters > LINKEDIN_POST_LIMIT;
  const busy = saving || posting !== null;

  function markPublished(): void {
    setMarkedPublished(true);
    void queryClient.invalidateQueries({ queryKey: ['discover'] });
    void queryClient.invalidateQueries({ queryKey: ['discover-sources'] });
  }

  async function postToBluesky(): Promise<void> {
    if (!post.trim() || tooLongForBluesky) return;
    const ok = await confirmDialog('Post this to Bluesky as @richardihogan.bsky.social now, with the original article link? The article will move to Published.',
      { title: 'Post to Bluesky', confirmLabel: 'Post now' });
    if (!ok) return;
    setPosting('bluesky');
    setCopyError(null);
    try {
      const result = await api.postDiscoverToBluesky(itemId, post.trim());
      if (!result.success) throw new Error(result.error?.message ?? 'Could not post to Bluesky.');
      setBlueskyUrl(result.data.url);
      markPublished();
    } catch (error) {
      setCopyError(`Bluesky: ${describeApiError(error)}`);
    } finally {
      setPosting(null);
    }
  }

  async function postToLinkedIn(): Promise<void> {
    if (!post.trim() || tooLongForLinkedIn || linkedinPostUrl || linkedinPostPending) return;
    setPosting('linkedin');
    setCopyError(null);
    try {
      const account = await api.getLinkedInAccount();
      if (!account.success) throw new Error(account.error?.message ?? 'Could not verify your LinkedIn account.');
      const ok = await confirmDialog(
        `Publish this post publicly to ${account.data.name}'s personal LinkedIn profile, with the original article link? The article will move to Published.`,
        { title: 'Post to LinkedIn', confirmLabel: 'Post now' },
      );
      if (!ok) return;
      const result = await api.postDiscoverToLinkedIn(itemId, post.trim(), account.data.id);
      if (!result.success) throw new Error(result.error?.message ?? 'Could not post to LinkedIn.');
      setLinkedinUrl(result.data.url);
      setLinkedinWarning(result.data.warning ?? null);
      queryClient.setQueriesData<SocialDraft>({ queryKey: ['discover-linkedin-draft', itemId] }, current =>
        current ? { ...current, linkedinPostUrl: result.data.url, linkedinPostStatus: 'posted' } : current);
      if (!result.data.warning) markPublished();
    } catch (error) {
      setCopyError(`LinkedIn: ${describeApiError(error)}`);
      void queryClient.invalidateQueries({ queryKey: ['discover-linkedin-draft', itemId] });
    } finally {
      setPosting(null);
    }
  }

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
        markPublished();
      } catch (error) {
        setCopyError(`Post copied, but the article could not be moved to Published. Copy again to retry. ${describeApiError(error)}`);
      }
    }
    setSaving(false);
  }

  return <AppDialog title="Socials" wide onClose={onClose}
    actions={<>
      <button type="button" className="kh-dialog__button" disabled={busy} onClick={onClose}>Close</button>
      <button type="button" className="kh-dialog__button" disabled={draft.isFetching || busy}
        onClick={() => { setEdits(current => ({ ...current, [format]: undefined })); void draft.refetch(); }}>
        <Renew size={16} /> {draft.isFetching ? 'Writing...' : 'Generate again'}
      </button>
      {canPostBluesky && <button type="button" className="kh-dialog__button"
        disabled={!post.trim() || tooLongForBluesky || postedUrl !== null || draft.isFetching || draft.isError || busy}
        title={postedUrl ? 'Already posted to Bluesky' : undefined}
        onClick={() => { void postToBluesky(); }}>
        {postedUrl ? <Checkmark size={16} /> : <Send size={16} />} {posting === 'bluesky' ? 'Posting...' : postedUrl ? 'On Bluesky' : 'Post to Bluesky'}
      </button>}
      {canPostLinkedIn && <button type="button" className="kh-dialog__button"
        disabled={!post.trim() || tooLongForLinkedIn || linkedinPostUrl !== null || linkedinPostPending || draft.isFetching || draft.isError || busy}
        title={linkedinPostUrl ? 'Already posted to LinkedIn' : linkedinPostPending ? 'Check your LinkedIn profile before any further posting' : undefined}
        onClick={() => { void postToLinkedIn(); }}>
        {linkedinPostUrl ? <Checkmark size={16} /> : <Send size={16} />}
        {posting === 'linkedin' ? 'Checking / posting...' : linkedinPostUrl ? 'On LinkedIn' : linkedinPostPending ? 'Check LinkedIn' : 'Post to LinkedIn'}
      </button>}
      <button type="button" className="kh-dialog__button kh-dialog__button--primary"
        disabled={!post.trim() || tooLong || draft.isFetching || draft.isError || busy} onClick={() => { void copy(); }}>
        {copied ? <Checkmark size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy post + link'}
      </button>
    </>}>
    <p className="dc-linkedin__source-title">{title}</p>
    <div className="dc-linkedin__formats" role="group" aria-label="Social post format">
      <button type="button" disabled={busy} aria-pressed={format === 'linkedin'} onClick={() => { setFormat('linkedin'); }}>LinkedIn</button>
      <button type="button" disabled={busy} aria-pressed={format === 'short'} onClick={() => { setFormat('short'); }}>Bluesky / X</button>
    </div>
    {draft.isFetching && <p className="dc-linkedin__status" role="status">Athena is writing a short post with one enterprise IT observation where relevant...</p>}
    {draft.isError && <p className="dc-linkedin__error" role="alert">{describeApiError(draft.error)}</p>}
    {draft.data && !draft.isFetching && !draft.isError && <>
      <label className="dc-linkedin__label" htmlFor="linkedin-post">Post copy</label>
      <textarea id="linkedin-post" className="dc-linkedin__copy" value={post} rows={7} autoFocus
        disabled={busy}
        onChange={(e) => { const value = e.target.value; setEdits(current => ({ ...current, [format]: value })); setCopied(false); setCopyError(null); }} />
      {format === 'short' && <p className={tooLong ? 'dc-linkedin__error' : 'dc-linkedin__status'} aria-live="polite">
        {length} / {SHORT_POST_LIMIT} characters including URL and paragraph breaks (conservative X weighting).
        {tooLong ? ' Shorten the copy to enable Copy.' : ' Fits both Bluesky and X.'}
      </p>}
      {format === 'short' && draft.data.sourceKind === 'discovered-article' && draft.data.blueskyConfigured !== true && <p className="dc-linkedin__status">
        Direct posting to Bluesky is not set up on this server (BLUESKY_APP_PASSWORD).
      </p>}
      {format === 'linkedin' && <p className={tooLongForLinkedIn ? 'dc-linkedin__error' : 'dc-linkedin__status'} aria-live="polite">
        {linkedinCharacters} / {LINKEDIN_POST_LIMIT} characters including the original link.
        {tooLongForLinkedIn ? ' Shorten the post before publishing to LinkedIn.' : ''}
      </p>}
      {format === 'linkedin' && draft.data.sourceKind === 'discovered-article' && draft.data.linkedinConfigured !== true && <p className="dc-linkedin__status">
        Direct LinkedIn posting needs an access token. Add it in <a href="/my-work">My Work</a> &gt; Sync Status &gt; Connection tokens and API keys. Copy-and-paste still works.
      </p>}
      {format === 'linkedin' && linkedinPostPending && <p className="dc-linkedin__error" role="alert">
        An earlier post is in progress or may already be on LinkedIn. Check your profile; Athena will not send this article again.
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
    {copied && <p className="dc-linkedin__status" role="status">Copied with paragraph breaks.{markedPublished ? ' Article moved to Published, just like Copy URL.' : ''} Copying does not publish to social media.</p>}
    {format === 'linkedin' && linkedinPostUrl && <p className="dc-linkedin__status" role="status">
      {linkedinUrl ? 'Posted to LinkedIn. ' : 'This article is already on LinkedIn. '}
      {linkedinUrl && !linkedinWarning ? 'Article moved to Published. ' : ''}
      <a href={linkedinPostUrl} target="_blank" rel="noreferrer"><Launch size={16} /> View on LinkedIn</a>
    </p>}
    {format === 'linkedin' && linkedinWarning && <p className="dc-linkedin__error" role="alert">{linkedinWarning}</p>}
    {format === 'short' && postedUrl && <p className="dc-linkedin__status" role="status">
      {blueskyUrl ? 'Posted to Bluesky. Article moved to Published. ' : 'This article is already on Bluesky. '}
      <a href={postedUrl} target="_blank" rel="noreferrer"><Launch size={16} /> View on Bluesky</a>
    </p>}
  </AppDialog>;
};
