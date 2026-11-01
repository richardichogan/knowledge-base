import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { sanitizeHtml } from '../utils/sanitizeHtml';
import type { EpisodeLinks, EpisodePlatform, PodcastCampaignDetail } from '../types/podcastCampaign';
import './podcastCampaign.scss';

const platforms: EpisodePlatform[] = ['youtube', 'spotify', 'apple'];
const platformNames: Record<EpisodePlatform, string> = { youtube: 'YouTube', spotify: 'Spotify', apple: 'Apple Podcasts' };
const destinations = { blog: 'Launch blog', linkedin: 'LinkedIn', bluesky: 'Bluesky' };
const when = (date: string | null): string => date ? new Date(date).toLocaleString('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London',
}) : 'Date needed';
const queryKey = (noteId: string): string[] => ['podcast-campaign', noteId];
export function usePodcastCampaign(noteId: string, noteRevision: number, enabled = true) {
  const qc = useQueryClient();
  useEffect(() => { if (enabled) void qc.invalidateQueries({ queryKey: queryKey(noteId) }); }, [qc, noteId, noteRevision, enabled]);
  return useQuery({
    queryKey: queryKey(noteId), queryFn: () => api.publishing<PodcastCampaignDetail>(`/podcasts/${noteId}`),
    enabled,
    refetchInterval: query => query.state.data?.plan?.review?.status === 'pending' ? 5000 : query.state.data?.state === 'approved' ? 30_000 : false,
  });
}
function campaignStarted(data: PodcastCampaignDetail): boolean {
  return data.deliveries.some(delivery => ['sent', 'sending', 'unconfirmed'].includes(delivery.status));
}
function Failure({ error, retry }: { error: unknown; retry?: () => void }): React.ReactElement {
  return <div className="notes-podcast__error" role="alert">
    <p>{typeof error === 'string' ? error : describeApiError(error)}</p>
    {retry && <button type="button" className="notes-podcast__button" onClick={retry}>Retry</button>}
  </div>;
}
function CampaignArtwork({ post, noteId }: { post: NonNullable<PodcastCampaignDetail['plan']>['posts'][number]; noteId: string }): React.ReactElement | null {
  const asset = post.asset;
  const [source, setSource] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['podcast-image-file', asset?.imageId], enabled: !!asset,
    queryFn: async () => {
      if (!asset) throw new Error('The image identifier is unavailable.');
      return api.getImageFile(asset.imageId);
    }, staleTime: Infinity });
  useEffect(() => {
    if (!query.data) { setSource(null); return; }
    const url = URL.createObjectURL(query.data);
    setSource(url);
    return () => { URL.revokeObjectURL(url); };
  }, [query.data]);
  const downloadSource = useMutation({ mutationFn: async () => {
    const blob = await api.getPodcastArtworkSource(noteId, post.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `podcast-${post.id}.svg`;
    link.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
  } });
  if (!asset) return null;
  return <figure className="notes-podcast__artwork">
    {query.isError ? <Failure error={query.error} retry={() => { void query.refetch(); }} />
      : source ? <img src={source} width={asset.width} height={asset.height} alt={asset.alt} />
        : <p className="notes-podcast__help" role="status">Loading artwork...</p>}
    <figcaption>{post.assetSpec?.kind === 'quote' ? 'Speaker quote card' : 'Episode artwork'} · {asset.width} × {asset.height}
      {source && <a href={source} download={`${post.assetSpec?.kind ?? 'podcast'}-${post.destination}.png`}>Download image</a>}
      <button type="button" className="notes-podcast__button" disabled={downloadSource.isPending}
        onClick={() => { downloadSource.mutate(); }}>{downloadSource.isPending ? 'Downloading...' : 'Download editable SVG'}</button>
    </figcaption>
    {post.destination === 'blog' && <p className="notes-podcast__help">Blog artwork is available for review/download; this does not change the blog’s existing cover.</p>}
    {downloadSource.isError && <Failure error={downloadSource.error} retry={() => { downloadSource.mutate(); }} />}
  </figure>;
}

export function PodcastEpisodeLinks({ noteId, noteRevision }: { noteId: string; noteRevision: number }): React.ReactElement {
  const query = usePodcastCampaign(noteId, noteRevision);
  if (!query.data) return <div className="notes-podcast">
    {query.isError ? <Failure error={query.error} retry={() => { void query.refetch(); }} /> : <p role="status">Loading episode links...</p>}
  </div>;
  return <EpisodeLinkForm key={noteId} data={query.data} loadError={query.isError ? query.error : null} />;
}
function EpisodeLinkForm({ data, loadError }: { data: PodcastCampaignDetail; loadError: unknown }): React.ReactElement {
  const qc = useQueryClient();
  const [links, setLinks] = useState<EpisodeLinks>(data.links);
  const [revision, setRevision] = useState(data.revision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!dirty) { setLinks(data.links); setRevision(data.revision); }
  }, [data.links, data.revision, dirty]);
  const locked = data.state === 'approved' || campaignStarted(data);
  return <form className="notes-podcast" onSubmit={event => {
    event.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    void api.publishing<PodcastCampaignDetail>(`/podcasts/${data.noteId}/links`, 'PUT', { revision, links })
      .then(result => { qc.setQueryData(queryKey(data.noteId), result); setDirty(false); setSaved(true); })
      .catch((failure: unknown) => { setError(`Episode links were not saved. ${describeApiError(failure)}`); })
      .finally(() => { setBusy(false); });
  }}>
    <p className="notes-podcast__help">Use this episode's links, not the show or channel pages. Blog and LinkedIn include all three; Bluesky rotates between them.</p>
    {data.revision === 0 && <p className="notes-podcast__help">Unambiguous links from your note are prefilled. Check and save them before preparing the campaign.</p>}
    {platforms.map(platform => <label key={platform} className="notes-podcast__field">
      <span>{platformNames[platform]} episode URL</span>
      <input type="url" autoComplete="off" maxLength={2048} value={links[platform]} disabled={busy || locked}
        placeholder="https://" onChange={event => {
          setLinks(current => ({ ...current, [platform]: event.target.value })); setDirty(true); setSaved(false);
        }} />
    </label>)}
    {locked ? <p className="notes-podcast__help">{campaignStarted(data)
      ? 'Publication has started; the approved episode links are locked.'
      : 'Pause the approved campaign before changing its links.'}</p>
      : <button type="submit" className="notes-podcast__button notes-podcast__button--primary" disabled={busy || (!dirty && data.revision > 0)}>
        {busy ? 'Saving links...' : 'Save episode links'}
      </button>}
    {dirty && revision !== data.revision && <p className="notes-podcast__error" role="alert">This campaign changed elsewhere. Your unsaved link entries are retained; reload the saved campaign before replacing them.</p>}
    {error && <Failure error={error} />}
    {loadError !== null && <Failure error={loadError} />}
    {saved && <p className="notes-podcast__help" role="status">Episode links saved.</p>}
  </form>;
}

export function PodcastCampaign({ noteId, noteRevision, beforePrepare, recordingTease = false, prepareTeaser, preparingTeaser = false }: {
  noteId: string; noteRevision: number; beforePrepare: () => Promise<boolean>;
  recordingTease?: boolean; prepareTeaser?: () => Promise<void>; preparingTeaser?: boolean;
}): React.ReactElement {
  const query = usePodcastCampaign(noteId, noteRevision);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = query.data;
  if (!data) return <div className="notes-podcast">
    {query.isError ? <Failure error={query.error} retry={() => { void query.refetch(); }} /> : <p role="status">Loading campaign...</p>}
  </div>;
  const started = campaignStarted(data);
  const completeLinks = platforms.every(platform => Boolean(data.links[platform]));
  const completed = Boolean(data.plan?.posts.length) && data.plan!.posts.every(post => data.deliveries.some(delivery =>
    delivery.identity === `podcast:${noteId}:${post.id}` && delivery.status === 'sent'));
  async function act(action: 'prepare' | 'approve' | 'pause' | 'resume' | 'review'): Promise<void> {
    if (!data) return;
    setError(null);
    if (action === 'approve' && !await confirmDialog(
      `Approve scheduling all ${data.plan?.posts.length ?? 0} existing posts with their reviewed image assets, exact copy${recordingTease ? ' (no episode URLs)? The recording teaser can run on Friday, Saturday or Sunday before Monday’s release.' : ' and listening URLs? The Monday launch and subsequent campaign dates stay as defined in Show Notes.'} Other bookings do not block these posts. LinkedIn uses your personal account. After publication starts, this campaign's copy and links are locked.`,
      { title: recordingTease ? 'Approve recording teaser' : 'Approve episode campaign', confirmLabel: recordingTease ? 'Approve teaser' : 'Approve campaign' },
    )) return;
    if (action === 'resume' && !await confirmDialog(
      'Resume automatic delivery of the approved campaign? Other scheduled content, publishing windows and daily limits do not delay podcast posts.',
      { title: 'Resume campaign', confirmLabel: 'Resume delivery' },
    )) return;
    setBusy(action);
    try {
      if ((action === 'prepare' || action === 'approve') && !await beforePrepare()) throw new Error('Save or resolve the open note before continuing.');
      if (action === 'prepare' && recordingTease) {
        if (!prepareTeaser) throw new Error('The recording teaser worker is unavailable.');
        await prepareTeaser();
        return;
      }
      const result = await api.publishing<PodcastCampaignDetail>(`/podcasts/${noteId}/${action === 'prepare' ? 'prepare' : action === 'review' ? 'review' : 'decision'}`, 'POST',
        { revision: data.revision, ...(!['prepare', 'review'].includes(action) && { action }) });
      qc.setQueryData(queryKey(noteId), result);
      void qc.invalidateQueries({ queryKey: ['publishing', 'schedule'] });
    } catch (failure) { setError(describeApiError(failure)); }
    finally { setBusy(null); }
  }
  return <div className="notes-podcast" aria-busy={busy !== null}>
    <div className="notes-podcast__heading">
      <h3>{recordingTease ? 'Recording teaser' : 'Episode campaign'}</h3>
      <span className="notes-podcast__state">{completed ? 'Published' : data.state === 'approved' ? 'Approved' : data.state === 'paused' ? 'Paused' : 'Draft'}</span>
    </div>
    <p className="notes-podcast__help">{recordingTease
      ? 'Prepared as soon as the transcript is uploaded: complete personal LinkedIn and Bluesky teaser copy, without episode URLs. Approve it separately; it will not be repeated in the launch campaign.'
      : 'Create the campaign from existing Show Notes copy and generate every image asset. Review each post, artwork and date here, then approve scheduling once. Nothing is automatically approved. Edit the source note to change an unpublished draft.'}</p>
    {!data.automaticDelivery && <p className="notes-podcast__notice">Local automatic delivery is off. Drafts and approvals use the shared database; delivery requires the production campaign worker.</p>}
    {!recordingTease && (!completeLinks || data.revision === 0) ? <p className="notes-podcast__notice">Check and save all three episode links in Metadata first.</p> : null}
    {data.sourceChanged && <p className="notes-podcast__notice">{data.state === 'draft'
      ? recordingTease ? 'The transcript changed. Ask Athena to review and update this draft before approval.' : 'Show Notes changed since preparation. Prepare again before approval.'
      : 'Show Notes changed. The approved campaign remains a fixed copy; your note edits do not rewrite scheduled posts.'}</p>}
    <div className="notes-podcast__actions">
      {!started && data.state !== 'approved' && (!recordingTease || !data.plan) && <button type="button" className="notes-podcast__button"
        disabled={busy !== null || preparingTeaser || (!recordingTease && (!completeLinks || data.revision === 0))} onClick={() => { void act('prepare'); }}>
        {recordingTease ? preparingTeaser || busy === 'prepare' ? 'Preparing teaser...' : 'Prepare recording teaser'
          : busy === 'prepare' ? 'Creating campaign and images...' : data.plan ? 'Refresh campaign from note' : 'Create campaign'}
      </button>}
      {data.plan && data.state === 'draft' && <button type="button" className="notes-podcast__button notes-podcast__button--primary"
        disabled={busy !== null || data.issues.length > 0} onClick={() => { void act('approve'); }}>
        {busy === 'approve' ? 'Approving...' : recordingTease ? 'Approve recording teaser' : 'Approve complete campaign'}
      </button>}
      {data.state === 'approved' && !completed && <button type="button" className="notes-podcast__button" disabled={busy !== null}
        onClick={() => { void act('pause'); }}>{busy === 'pause' ? 'Pausing...' : 'Pause delivery'}</button>}
      {data.state === 'paused' && !completed && <button type="button" className="notes-podcast__button notes-podcast__button--primary" disabled={busy !== null}
        onClick={() => { void act('resume'); }}>{busy === 'resume' ? 'Resuming...' : 'Resume delivery'}</button>}
    </div>
    {error && <Failure error={error} />}
    {query.isError && <Failure error={query.error} retry={() => { void query.refetch(); }} />}
    {data.error && <Failure error={data.error} />}
    {data.plan ? <>
      {data.plan.reviewRequired && <section className="notes-podcast__review" aria-label="Independent publication review">
        <h4>Independent image and post review</h4>
        <p className="notes-podcast__help" role={data.plan.review?.status === 'fail' ? 'alert' : 'status'}>
          {data.plan.review?.status === 'pass'
            ? `Passed by a separate reviewer using ${data.plan.review.reviewer}. Manual approval is still required.`
            : data.plan.review?.status === 'fail'
              ? 'Review found a problem or could not complete. Approval is blocked; see the findings below.'
              : 'A separate model is inspecting the actual rendered images and authored posts. Approval is blocked until this version passes.'}
        </p>
        {data.state === 'draft' && <button type="button" className="notes-podcast__button"
          disabled={busy !== null} onClick={() => { void act('review'); }}>{busy === 'review' ? 'Starting review...' : 'Retry independent review'}</button>}
      </section>}
      <p className="notes-podcast__help">{data.plan.posts.length} posts · Times shown in UK time (Europe/London).
        {recordingTease ? 'The recording teaser can run on recording Friday or the Saturday/Sunday before Monday’s release.'
          : 'The Monday launch, weekday quote posts and fuller posts retain their dates from Show Notes.'} Other scheduled content does not block podcast posts, and confirmed posts are never resent.</p>
      <p className="notes-podcast__help">LinkedIn: {data.plan.linkedinName} (personal) · Bluesky: {data.plan.accounts.bluesky}</p>
      {data.issues.length > 0 && <section className="notes-podcast__notice" aria-label="Resolve before approval">
        <h4>Resolve before approval</h4><ul>{data.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
      </section>}
      {data.plan.notes.length > 0 && <section><h4>Preparation notes</h4><ul>{data.plan.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
      <div className="notes-podcast__posts">{data.plan.posts.map(post => {
        const delivery = data.deliveries.find(item => item.identity === `podcast:${noteId}:${post.id}`);
        const receiptUrl = typeof delivery?.receipt?.url === 'string' && /^https:\/\/[^\s]+$/i.test(delivery.receipt.url) ? delivery.receipt.url : null;
        return <details key={post.id} className="notes-podcast__post" open={Boolean(post.asset)}>
          <summary>
            <span className="notes-podcast__post-title">{destinations[post.destination]}{post.platform ? ` · ${platformNames[post.platform]}` : ''}</span>
            <span className="notes-podcast__post-time">{when(post.scheduledAt)} · {delivery?.status ?? (data.state === 'approved' ? 'Scheduled' : 'Draft')}</span>
            <span>{post.label}</span>
          </summary>
          {post.asset && <CampaignArtwork post={post} noteId={noteId} />}
          {post.destination === 'blog' && post.blog ? <>
            <h4>{post.blog.title}</h4>
            <p className="notes-podcast__help">{post.blog.summary}</p>
            <div className="notes-podcast__blog" dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.blog.content) }} />
          </> : <div className="notes-podcast__copy">{post.copy}{post.url ? `\n\n${post.url}` : ''}</div>}
          {delivery?.error && <Failure error={delivery.error} />}
          {delivery?.nextAttemptAt && <p className="notes-podcast__help">Next confirmation or retry: {when(delivery.nextAttemptAt)}</p>}
          {receiptUrl && <a className="notes-podcast__receipt" href={receiptUrl} target="_blank" rel="noopener noreferrer">Open published post</a>}
          {delivery && ['failed', 'unconfirmed'].includes(delivery.status) && <p className="notes-podcast__help">Resolve this delivery in Discover's publishing History before retrying.</p>}
        </details>;
      })}</div>
      {data.plan.excluded.length > 0 && <details className="notes-podcast__excluded"><summary>Not scheduled</summary>
        <ul>{data.plan.excluded.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      </details>}
    </> : <p className="notes-podcast__empty">{recordingTease
      ? preparingTeaser ? 'The transcript worker is preparing the recording teaser. No post will publish without your approval.' : 'No teaser saved yet. Prepare it from the transcript; no episode URLs are needed.'
      : 'No campaign prepared. Your original Show Notes and current publishing cycle are unchanged.'}</p>}
  </div>;
}
