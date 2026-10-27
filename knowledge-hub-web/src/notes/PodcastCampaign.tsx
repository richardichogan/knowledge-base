import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
function useCampaign(noteId: string, noteRevision: number) {
  const qc = useQueryClient();
  useEffect(() => { void qc.invalidateQueries({ queryKey: queryKey(noteId) }); }, [qc, noteId, noteRevision]);
  return useQuery({
    queryKey: queryKey(noteId), queryFn: () => api.publishing<PodcastCampaignDetail>(`/podcasts/${noteId}`),
    refetchInterval: query => query.state.data?.state === 'approved' ? 30_000 : false,
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

export function PodcastEpisodeLinks({ noteId, noteRevision }: { noteId: string; noteRevision: number }): React.ReactElement {
  const query = useCampaign(noteId, noteRevision);
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

export function PodcastCampaign({ noteId, noteRevision, beforePrepare }: {
  noteId: string; noteRevision: number; beforePrepare: () => Promise<boolean>;
}): React.ReactElement {
  const query = useCampaign(noteId, noteRevision);
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
  async function act(action: 'prepare' | 'approve' | 'pause' | 'resume'): Promise<void> {
    if (!data) return;
    setError(null);
    if (action === 'approve' && !await confirmDialog(
      `Approve all ${data.plan?.posts.length ?? 0} posts, their exact copy, listening URLs and schedule? LinkedIn uses your personal account. After publication starts, this campaign's copy and links are locked.`,
      { title: 'Approve episode campaign', confirmLabel: 'Approve campaign' },
    )) return;
    if (action === 'resume' && !await confirmDialog(
      'Resume automatic delivery of the approved campaign? Overdue posts will become eligible in order, within the account publishing windows and limits.',
      { title: 'Resume campaign', confirmLabel: 'Resume delivery' },
    )) return;
    setBusy(action);
    try {
      if ((action === 'prepare' || action === 'approve') && !await beforePrepare()) throw new Error('Save or resolve the open note before continuing.');
      const result = await api.publishing<PodcastCampaignDetail>(`/podcasts/${noteId}/${action === 'prepare' ? 'prepare' : 'decision'}`, 'POST',
        { revision: data.revision, ...(action !== 'prepare' && { action }) });
      qc.setQueryData(queryKey(noteId), result);
      void qc.invalidateQueries({ queryKey: ['publishing', 'schedule'] });
    } catch (failure) { setError(describeApiError(failure)); }
    finally { setBusy(null); }
  }
  return <div className="notes-podcast" aria-busy={busy !== null}>
    <div className="notes-podcast__heading">
      <h3>Episode campaign</h3>
      <span className="notes-podcast__state">{completed ? 'Published' : data.state === 'approved' ? 'Approved' : data.state === 'paused' ? 'Paused' : 'Draft'}</span>
    </div>
    <p className="notes-podcast__help">Prepare from the saved Show Notes, review every post, then approve the complete campaign once. Edit the source note to change an unpublished draft.</p>
    {!data.automaticDelivery && <p className="notes-podcast__notice">Local automatic delivery is off. Drafts and approvals use the shared database; delivery requires the production campaign worker.</p>}
    {!completeLinks || data.revision === 0 ? <p className="notes-podcast__notice">Check and save all three episode links in Metadata first.</p> : null}
    {data.sourceChanged && <p className="notes-podcast__notice">{data.state === 'draft'
      ? 'Show Notes changed since preparation. Prepare again before approval.'
      : 'Show Notes changed. The approved campaign remains a fixed copy; your note edits do not rewrite scheduled posts.'}</p>}
    <div className="notes-podcast__actions">
      {!started && data.state !== 'approved' && <button type="button" className="notes-podcast__button"
        disabled={busy !== null || !completeLinks || data.revision === 0} onClick={() => { void act('prepare'); }}>
        {busy === 'prepare' ? 'Preparing campaign...' : data.plan ? 'Prepare again from note' : 'Prepare campaign'}
      </button>}
      {data.plan && data.state === 'draft' && <button type="button" className="notes-podcast__button notes-podcast__button--primary"
        disabled={busy !== null || data.issues.length > 0} onClick={() => { void act('approve'); }}>
        {busy === 'approve' ? 'Approving...' : 'Approve complete campaign'}
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
      <p className="notes-podcast__help">{data.plan.posts.length} posts · Times shown in UK time (Europe/London).
        Shared daily limits and earlier deliveries can delay a post; confirmed posts are never resent.</p>
      <p className="notes-podcast__help">LinkedIn: {data.plan.linkedinName} (personal) · Bluesky: {data.plan.accounts.bluesky}</p>
      {data.issues.length > 0 && <section className="notes-podcast__notice" aria-label="Resolve before approval">
        <h4>Resolve before approval</h4><ul>{data.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
      </section>}
      {data.plan.notes.length > 0 && <section><h4>Preparation notes</h4><ul>{data.plan.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
      <div className="notes-podcast__posts">{data.plan.posts.map(post => {
        const delivery = data.deliveries.find(item => item.identity === `podcast:${noteId}:${post.id}`);
        const receiptUrl = typeof delivery?.receipt?.url === 'string' && /^https:\/\/[^\s]+$/i.test(delivery.receipt.url) ? delivery.receipt.url : null;
        return <details key={post.id} className="notes-podcast__post">
          <summary>
            <span className="notes-podcast__post-title">{destinations[post.destination]}{post.platform ? ` · ${platformNames[post.platform]}` : ''}</span>
            <span className="notes-podcast__post-time">{when(post.scheduledAt)} · {delivery?.status ?? (data.state === 'approved' ? 'Scheduled' : 'Draft')}</span>
            <span>{post.label}</span>
          </summary>
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
    </> : <p className="notes-podcast__empty">No campaign prepared. Your original Show Notes and current publishing cycle are unchanged.</p>}
  </div>;
}
