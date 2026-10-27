import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppDialog } from '../AppDialog';
import { BlogPostEditor } from './BlogPostEditor';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import { confirmDialog } from '../../services/appDialogs';
import type { FeedPolicy, PublishingFeed, PublishingTopic, PublishingDraft, PublishingDetail, PublishingDelivery, PublishingEvent, PublishingScheduleEntry, ScheduledPodcastPost } from '../../types/publishing';

const names = { bluesky: 'Bluesky', 'blog-linkedin': 'Blog / LinkedIn', blog: 'Blog', linkedin: 'LinkedIn' };
const when = (value: string | null): string => value ? new Date(value).toLocaleString('en-GB') : 'Not yet';
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REVIEW_MAX_AGE_MS = 86_400_000;
type Action = (path: string, method: 'POST' | 'PUT', body: unknown) => Promise<boolean>;
function sourceLink(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
export function PublishingFeedControls({ feeds, act, busy }: { feeds: PublishingFeed[]; act: Action; busy: boolean }): React.ReactElement {
  return <>{feeds.map(feed => <section className="kh-publishing__feed" key={feed.id}>
    <div><h3>{names[feed.id]}</h3><p>{feed.id === 'bluesky' ? 'Microsoft-first updates and coordinated blog promotion. Human approval required. Up to 4 posts/day, at least 2 hours apart.' : 'Selective Microsoft-focused analysis, blog first. One package approval covers Blog and LinkedIn. Up to 3 LinkedIn posts/day, at least 3 hours apart.'}</p></div>
    <button type="button" role="switch" className="kh-publishing__switch" aria-label={`${names[feed.id]} posting automation`} aria-checked={feed.enabled} disabled={busy}
      onClick={() => { void act(`/feeds/${feed.id}`, 'PUT', { ...feed, enabled: !feed.enabled }); }}><span aria-hidden="true" />{feed.enabled ? 'On' : 'Off'}</button>
    <details className="kh-publishing__policy"><summary>Schedule and guidance</summary><PolicyEditor key={feed.revision} feed={feed} act={act} busy={busy} /></details>
  </section>)}</>;
}

function PolicyEditor({ feed, act, busy }: { feed: PublishingFeed; act: Action; busy: boolean }): React.ReactElement {
  const [policy, setPolicy] = useState<FeedPolicy>(feed.policy);
  function field<K extends keyof FeedPolicy>(key: K, value: FeedPolicy[K]): void { setPolicy(p => ({ ...p, [key]: value })); }
  return <form className="kh-publishing__form" onSubmit={e => { e.preventDefault(); void act(`/feeds/${feed.id}`, 'PUT', { ...feed, policy }); }}>
    <div className="kh-publishing__fields">
      <label>Timezone<input required value={policy.timezone} onChange={e => field('timezone', e.target.value)} /></label>
      <label>From<input required type="number" min={0} max={23} value={policy.startHour} onChange={e => field('startHour', Number(e.target.value))} /></label>
      <label>Until<input required type="number" min={1} max={24} value={policy.endHour} onChange={e => field('endHour', Number(e.target.value))} /></label>
    </div>
    <fieldset className="kh-publishing__days"><legend>Publishing days</legend>{weekdays.map((day, i) => <label key={day}>
      <input type="checkbox" checked={policy.days.includes(i)} onChange={e => field('days', e.target.checked ? [...policy.days, i] : policy.days.filter(d => d !== i))} />{day}
    </label>)}</fieldset>
    <label>Editorial guidance<textarea rows={3} maxLength={4000} value={policy.guidance} onChange={e => field('guidance', e.target.value)} /></label>
    <p className="kh-publishing__meta">Hours use the selected timezone, including daylight saving. Daily limits are ceilings, never targets.</p>
    <button disabled={busy} type="submit">Save policy</button>
  </form>;
}
function DraftEditor({ draft, act, busy, onDone }: { draft: PublishingDraft; act: Action; busy: boolean; onDone: () => void }): React.ReactElement {
  const [content, setContent] = useState(draft.content);
  const field = (key: string, value: unknown): void => setContent(p => ({ ...p, [key]: value }));
  return <form className="kh-publishing__form" onSubmit={e => {
    e.preventDefault(); void act(`/drafts/${draft.id}`, 'PUT', { version: draft.version, content }).then(saved => { if (saved) onDone(); });
  }}>
    {draft.destination === 'blog' ? <>
      {['title', 'slug', 'excerpt', 'summary', 'twitterCopy'].map(key => <label key={key}>{key === 'title' ? 'Title' : key === 'slug' ? 'Slug' : key === 'excerpt' ? 'Excerpt' : key === 'twitterCopy' ? 'Twitter / X package copy (not auto-posted)' : 'Summary'}
        <textarea required={key !== 'excerpt'} rows={key === 'summary' ? 3 : 2} value={String(content[key] ?? '')} onChange={e => field(key, e.target.value)} />
      </label>)}
      <BlogPostEditor value={String(content.content ?? '')} onChange={value => field('content', value)} disabled={busy} />
      <label>Key takeaways (one per line)<textarea rows={4} value={Array.isArray(content.keyTakeaways) ? content.keyTakeaways.join('\n') : ''}
        onChange={e => field('keyTakeaways', e.target.value.split('\n').filter(Boolean))} /></label>
      {['categories', 'tags'].map(key => <label key={key}>{key === 'categories' ? 'Categories' : 'Tags'} (comma-separated)
        <input value={Array.isArray(content[key]) ? content[key].join(', ') : ''} onChange={e => field(key, e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
      </label>)}
    </> : <label>{names[draft.destination]} copy<textarea required rows={5} value={String(content.copy ?? '')} onChange={e => field('copy', e.target.value)} /></label>}
    <p className="kh-publishing__meta">Saving creates a new version and clears approval. Blog edits also invalidate hook review and approval.</p>
    <div className="kh-publishing__actions"><button type="submit" disabled={busy}>Save new version</button><button type="button" disabled={busy} onClick={onDone}>Cancel edit</button></div>
  </form>;
}
export function PublishingDraftPreview({ draft }: { draft: PublishingDraft }): React.ReactElement {
  if (!hasSavedDraftText(draft)) return <p className="kh-publishing__empty">No post text was saved for this record. It is not ready for approval and will not appear in your shortlist.</p>;
  return draft.destination === 'blog' ? <>
    <h4>{String(draft.content.title ?? 'Untitled blog draft')}</h4>
    {draft.content.summary && <p>{String(draft.content.summary)}</p>}
    <div className="kh-publishing__prose" dangerouslySetInnerHTML={{ __html: sanitizeHtml(String(draft.content.content ?? '')) }} />
    <details className="kh-publishing__evidence"><summary>Quick-take package</summary>
      <p className="kh-publishing__meta">Post type: {String(draft.content.postType ?? 'Not set')} · Slug: {String(draft.content.slug ?? 'Not set')}</p>
      <h4>Excerpt</h4><p>{String(draft.content.excerpt ?? '')}</p>
      <h4>Key takeaways</h4>{Array.isArray(draft.content.keyTakeaways) && draft.content.keyTakeaways.map((takeaway, index) => <p key={index}>{String(takeaway)}</p>)}
      <p>Categories: {Array.isArray(draft.content.categories) ? draft.content.categories.join(', ') : ''}</p>
      <p>Tags: {Array.isArray(draft.content.tags) ? draft.content.tags.join(', ') : ''}</p>
      {typeof draft.content.sourceUrl === 'string' && <p>Source: <a href={sourceLink(draft.content.sourceUrl)} target="_blank" rel="noreferrer">{draft.content.sourceUrl}</a></p>}
      <h4>Twitter / X copy</h4><p className="kh-publishing__copy">{String(draft.content.twitterCopy ?? 'Not prepared')}</p>
      <p className="kh-publishing__meta">Included for manual use; Twitter / X is not an automated destination.</p>
    </details>
  </> : <p className="kh-publishing__copy">{String(draft.content.copy ?? 'No copy has been saved yet.')}</p>;
}
function hasSavedDraftText(draft: PublishingDraft): boolean {
  return (draft.destination === 'blog' ? ['title', 'summary', 'content'] : ['copy'])
    .every(field => typeof draft.content[field] === 'string' && Boolean(draft.content[field].trim()));
}
function isReadyDraft(draft: PublishingDraft): boolean {
  return hasSavedDraftText(draft) && draft.review === 'pass' && !draft.held && draft.approval !== 'rejected'
    && draft.reviewedAt !== null
    && Date.now() - new Date(draft.reviewedAt).getTime() < REVIEW_MAX_AGE_MS;
}
export function publishingApprovalBlocker(draft: PublishingDraft): string | null {
  if (!hasSavedDraftText(draft)) return 'No post text was saved. This record is not ready for approval.';
  if (draft.held) return draft.review === 'pass'
    ? draft.reason || 'Publishing is on hold. Resolve the delivery issue before scheduling.'
    : 'Editorial preparation is incomplete. This draft is not ready for approval.';
  if (draft.review !== 'pass') return draft.review === 'pending'
    ? 'Editorial review is pending. Approval becomes available after accuracy and voice checks pass.'
    : 'Editorial checks need attention. Edit the copy or request another review before approving.';
  return null;
}
export function TopicReview({ id, act, busy, feeds, readyOnly = false, initialDestination = null }: { id: string; act: Action; busy: boolean; feeds: PublishingFeed[]; readyOnly?: boolean; initialDestination?: PublishingDraft['destination'] | null }): React.ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [destination, setDestination] = useState<PublishingDraft['destination'] | null>(initialDestination);
  const [reason, setReason] = useState('');
  const detail = useQuery({ queryKey: ['publishing', 'topic', id], queryFn: () => api.publishing<PublishingDetail>(`/topics/${id}`), refetchInterval: editing ? false : 30000 });
  const d = detail.data;
  if (detail.isError) return <p role="alert" className="kh-publishing__error">{describeApiError(detail.error)}</p>;
  if (!d) return <p role="status">Loading evidence and drafts…</p>;
  const visibleDrafts = d.drafts.filter(draft => !readyOnly || isReadyDraft(draft));
  const current = visibleDrafts.find(draft => draft.destination === destination)
    ?? visibleDrafts.find(draft => draft.approval !== 'approved') ?? visibleDrafts[0];
  function decide(draft: PublishingDraft, action: string): void { void act(`/drafts/${draft.id}/decision`, 'POST', { version: draft.version, action, reason }); }
  return <div className="kh-publishing__review">
    <h3 className="kh-publishing__review-title">{d.topic.title}</h3>
    {d.topic.error && <p className="kh-publishing__notice">Preparation stopped. This item is not ready for approval.</p>}
    {visibleDrafts.length === 0 && <p className="kh-publishing__empty">Athena has not completed this draft’s preparation. Only finished, reviewed posts are offered for scheduling.</p>}
    {visibleDrafts.length > 0 && <nav className="kh-publishing__destinations" aria-label="Draft destination">
      {visibleDrafts.map(draft => <button type="button" key={draft.destination} aria-pressed={current?.id === draft.id}
        disabled={Boolean(editing)} onClick={() => setDestination(draft.destination)}>{names[draft.destination]}</button>)}
    </nav>}
    {current && [current].map(draft => {
      const sent = d.deliveries.find(delivery => delivery.draftId === draft.id && delivery.version === draft.version && ['sent', 'sending', 'unconfirmed'].includes(delivery.status));
      const packageDraft = draft.variant === 'blog' && draft.destination !== 'bluesky';
      const blog = d.drafts.find(candidate => candidate.destination === 'blog');
      const linkedin = d.drafts.find(candidate => candidate.destination === 'linkedin');
      const pair = [blog, linkedin];
      const packageBlocker = !blog || !linkedin ? 'The blog and LinkedIn copy must both be prepared before scheduling.'
        : pair.map(candidate => candidate && publishingApprovalBlocker(candidate)
          ? `${names[candidate.destination]}: ${publishingApprovalBlocker(candidate)}` : null).find(Boolean) ?? null;
      const blocker = packageDraft ? packageBlocker : publishingApprovalBlocker(draft);
      const approved = packageDraft ? pair.every(candidate => candidate?.approval === 'approved') : draft.approval === 'approved';
      const canApprove = blocker === null && !sent;
      const feedId = draft.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin';
      const feed = feeds.find(f => f.id === feedId);
      return <section className="kh-publishing__draft" key={draft.id}>
        <div className="kh-publishing__draft-heading"><h3>{names[draft.destination]} <span>v{draft.version}</span></h3>
          <span className="kh-publishing__meta">{sent?.status ?? (draft.held ? 'Needs attention' : approved ? 'Approved' : blocker ? 'Needs review' : 'Ready for approval')}</span></div>
        <p className="kh-publishing__meta">Account: {String(draft.content.accountName ?? draft.content.account ?? 'Not connected')}</p>
        {editing === draft.id ? <DraftEditor key={`${draft.id}:${draft.version}`} draft={draft} act={act} busy={busy} onDone={() => setEditing(null)} /> : <>
          <div className="kh-publishing__actions kh-publishing__draft-actions">
            {!blocker && <button type="button" className="kh-publishing__primary" disabled={busy || !canApprove || approved} onClick={() => {
              if (packageDraft && blog && linkedin) void act(`/topics/${id}/approve`, 'POST', { versions: { blog: blog.version, linkedin: linkedin.version } });
              else decide(draft, 'approve');
            }}>
              {approved ? 'Sent for scheduling' : packageDraft ? 'Send package for scheduling' : 'Send for scheduling'}</button>}
            {hasSavedDraftText(draft) && <button type="button" disabled={busy || Boolean(sent)} onClick={() => setEditing(draft.id)}>Edit draft</button>}
            {readyOnly && draft.approval === 'pending' && <button type="button" className="kh-publishing__danger"
              disabled={busy || d.drafts.some(item => item.approval === 'approved') || d.deliveries.length > 0}
              onClick={() => { void (async () => {
                if (!await confirmDialog(packageDraft
                  ? 'Discard this unapproved Blog/LinkedIn package? Its source article is retained. Approved and scheduled posts cannot be discarded here.'
                  : 'Discard this unapproved post? Its source article is retained. Approved and scheduled posts cannot be discarded here.',
                { title: packageDraft ? 'Discard draft package' : 'Discard draft', confirmLabel: 'Discard' })) return;
                await act(`/drafts/${draft.id}/discard`, 'POST', { versions: Object.fromEntries(d.drafts.map(item => [item.id, item.version])) });
              })(); }}>{packageDraft ? 'Discard package' : 'Discard draft'}</button>}
            <details className="kh-publishing__more"><summary>More actions</summary><div className="kh-publishing__actions">
              <button type="button" disabled={busy || Boolean(sent)} onClick={() => { void act(`/drafts/${draft.id}/review`, 'POST', { version: draft.version }); }}>Request fresh review</button>
              {!draft.held && <button type="button" disabled={busy || Boolean(sent)} onClick={() => decide(draft, 'hold')}>Hold draft</button>}
              {draft.held && <button type="button" disabled={busy || Boolean(sent)} onClick={() => decide(draft, 'resume')}>Resume draft</button>}
              <button type="button" disabled={busy || Boolean(sent)} onClick={() => { void act(`/drafts/${draft.id}/account`, 'POST', { version: draft.version }); }}>Rebind account</button>
              <button type="button" className="kh-publishing__danger" disabled={busy || Boolean(sent)} onClick={() => decide(draft, 'reject')}>Reject draft</button>
            </div></details>
          </div>
          {!sent && <p className="kh-publishing__notice">{blocker ?? (approved ? 'Sent for scheduling.'
            : packageDraft ? 'Read the Blog and LinkedIn tabs, then send the package for scheduling once. This approves both saved versions together.'
              : 'Editorial checks passed. Read the draft, then send this exact version for scheduling.')}
            {feed?.enabled === false ? ` ${names[feedId]} automation is off; planned times are paused, not promised delivery times.`
              : feed?.enabled ? ' See Scheduling for the assigned time and any delivery blockers.' : ' Feed settings are unavailable; scheduling cannot be confirmed.'}</p>}
          <div className="kh-publishing__post"><PublishingDraftPreview draft={draft} /></div>
          {draft.destination !== 'blog' && <p className="kh-publishing__meta">{draft.variant === 'blog' ? 'The verified public blog URL is appended at delivery.' : `Source link: ${d.sources[0]?.url ?? 'Unavailable'}`}</p>}
          {draft.reason && <details className="kh-publishing__evidence"><summary>Publishing status and findings</summary><pre>{draft.reason}</pre></details>}
        </>}
        <details className="kh-publishing__evidence"><summary>Version history, accuracy and voice findings</summary>
          {d.versions.filter(v => v.draft_id === draft.id).map(v => <section key={v.version}>
            <h4>Version {v.version} · {v.approved_by ? `Approved by ${v.approved_by} at ${when(v.approved_at)}` : 'No approval recorded'}</h4>
            <pre>{JSON.stringify(v.reviews, null, 2)}</pre><details><summary>Exact version content</summary><pre>{JSON.stringify(v.content, null, 2)}</pre></details>
          </section>)}
        </details>
      </section>;
    })}
    <details className="kh-publishing__evidence"><summary>Sources and topic controls</summary>
      <p>{d.topic.rationale || 'Editorial assessment is pending.'}</p>
      {d.topic.error && <pre>{d.topic.error}</pre>}
      {d.sources.map(source => <section key={source.itemId}>
        <a href={sourceLink(source.url)} target="_blank" rel="noreferrer">{source.title}</a><p className="kh-publishing__meta">Read: {when(source.readAt)}</p>
        <pre>{source.body || 'Source not yet read. No publication is permitted without evidence.'}</pre>
      </section>)}
      <label>Editorial feedback or hold reason<textarea rows={2} maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="kh-publishing__actions">
        <button type="button" disabled={busy} onClick={() => { void act(`/topics/${id}/decision`, 'POST', { action: 'hold', reason }); }}>Hold topic</button>
        <button type="button" className="kh-publishing__danger" disabled={busy} onClick={() => { void act(`/topics/${id}/decision`, 'POST', { action: 'reject', reason }); }}>Reject topic</button>
        {d.drafts.length === 0 && ['held', 'rejected'].includes(d.topic.state) && <button type="button" disabled={busy}
          onClick={() => { void act(`/topics/${id}/decision`, 'POST', { action: 'reassess' }); }}>Reassess</button>}
      </div>
    </details>
  </div>;
}
function Reconciliation({ delivery, act, busy }: { delivery: PublishingDelivery; act: Action; busy: boolean }): React.ReactElement {
  const [url, setUrl] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [reason, setReason] = useState('');
  return <details className="kh-publishing__evidence"><summary>Reconcile or retry this delivery</summary>
    <form className="kh-publishing__form" onSubmit={e => { e.preventDefault(); void act(`/deliveries/${delivery.id}/reconcile`, 'POST', { delivered: true, url, publishedAt: new Date(publishedAt).toISOString(), reason }); }}>
      <p>Check the destination first. An unresolved request is never retried automatically.</p>
      <label>Public post URL<input required type="url" value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>Actual publication time (your local time)<input required type="datetime-local" value={publishedAt} onChange={e => setPublishedAt(e.target.value)} /></label>
      <label>Reconciliation note<input value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="kh-publishing__actions"><button type="submit" disabled={busy}>Confirm delivered</button>
        <button type="button" disabled={busy} onClick={() => { void act(`/deliveries/${delivery.id}/reconcile`, 'POST', { delivered: false, reason }); }}>Confirm not delivered; allow retry</button></div>
    </form>
  </details>;
}
export function PublishingDraftList({ topics, selected, onSelect }: {
  topics: PublishingTopic[]; selected: string | undefined; onSelect: (id: string) => void;
}): React.ReactElement {
  const prepared = topics.filter(topic => topic.drafts.length > 0);
  function row(topic: PublishingTopic): React.ReactElement {
    const blog = topic.drafts.find(draft => draft.destination === 'blog');
    const preview = blog?.content.summary ?? topic.drafts[0]?.content.copy;
    return <button className="kh-publishing__draft-row" type="button" key={topic.id} aria-pressed={selected === topic.id}
      onClick={() => onSelect(topic.id)}>
      <strong>{String(blog?.content.title ?? topic.title)}</strong>
      {typeof preview === 'string' && <span className="kh-publishing__snippet">{preview}</span>}
      <span className="kh-publishing__meta">{topic.drafts.length
        ? `${topic.drafts.map(draft => names[draft.destination]).join(' · ')}${topic.state === 'held' || topic.drafts.some(draft => draft.held) ? ' · Needs attention' : ''}`
        : 'No draft yet'}</span>
    </button>;
  }
  return <aside className="kh-publishing__draft-list" aria-label="Draft posts">
    <h3>Draft posts <span>{prepared.length}</span></h3>
    {prepared.map(row)}
    {!prepared.length && <p className="kh-publishing__empty">No finished drafts ready for approval. Athena prepares and reviews the shortlist before it appears here.</p>}
  </aside>;
}
function scheduleStatus(post: PublishingScheduleEntry): string {
  if ('noteId' in post) {
    if (post.deliveryStatus === 'sending') return 'Sending';
    if (post.deliveryStatus === 'unconfirmed') return 'Awaiting confirmation';
    if (post.campaignPaused) return 'Paused · campaign';
    if (post.deliveryStatus === 'failed') return 'Needs attention';
  }
  return !post.scheduledAt ? 'Cannot schedule' : post.paused ? 'Paused · automation off'
    : new Date(post.scheduledAt) <= new Date() ? 'Due · awaiting worker checks' : 'Scheduled';
}
export function ScheduledPodcastPreview({ post, onOpen }: { post: ScheduledPodcastPost; onOpen: () => void }): React.ReactElement {
  return <section className="kh-publishing__review">
    <h3 className="kh-publishing__review-title">{post.title}</h3>
    <p className="kh-publishing__meta">Podcast campaign · {names[post.destination]} · {scheduleStatus(post)}</p>
    <h4>{post.label}</h4>
    {post.blog ? <><h4>{post.blog.title}</h4><p>{post.blog.summary}</p>
      <div className="kh-publishing__prose" dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.blog.content) }} /></>
      : <div className="kh-publishing__copy">{post.copy}</div>}
    <p className="kh-publishing__notice">{post.reason}</p>
    <Link className="kh-publishing__campaign-link" to={`/think?noteId=${encodeURIComponent(post.noteId)}&panel=campaign`} onClick={onOpen}>
      Open campaign to review or pause/resume
    </Link>
  </section>;
}
export function PublishingSchedule({ posts, selected, onSelect }: { posts: PublishingScheduleEntry[]; selected: string | undefined; onSelect: (id: string) => void }): React.ReactElement {
  const groups = new Map<string, PublishingScheduleEntry[]>();
  for (const post of posts) {
    const day = post.scheduledAt ? `${new Date(post.scheduledAt).toLocaleDateString('en-GB', {
      timeZone: post.timezone, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
    })} · ${post.timezone}` : 'Needs attention · no slot assigned';
    groups.set(day, [...(groups.get(day) ?? []), post]);
  }
  return <aside className="kh-publishing__agenda" aria-label="Scheduled posts">
    {[...groups].map(([day, entries]) => <section className="kh-publishing__schedule-day" key={day}>
      <h3>{day}</h3>
      {entries.map(post => <button type="button" className="kh-publishing__schedule-row" key={post.draftId}
        aria-pressed={selected === post.draftId} onClick={() => onSelect(post.draftId)}>
        <span className="kh-publishing__schedule-time">{post.scheduledAt ? <time dateTime={post.scheduledAt}>{new Date(post.scheduledAt).toLocaleString('en-GB', {
          timeZone: post.timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        })} · {post.timezone}</time> : 'Unscheduled'}
          <span>{'noteId' in post ? 'Podcast · ' : ''}{names[post.destination]} · v{post.version}</span></span>
        <strong>{post.title}</strong>
        {'noteId' in post && <span className="kh-publishing__meta">{post.label}</span>}
        <span className={`kh-publishing__schedule-status${post.paused || !post.scheduledAt || ('noteId' in post && post.deliveryStatus) ? ' kh-publishing__schedule-status--waiting' : ''}`}>
          {scheduleStatus(post)}</span>
        <span className={post.scheduledAt ? 'kh-publishing__meta' : 'kh-publishing__schedule-reason'}>{post.reason}</span>
        {post.paused && !post.scheduledAt && <span className="kh-publishing__meta">Automation is also off.</span>}
      </button>)}
    </section>)}
  </aside>;
}
export function DiscoverPublishing({ onClose }: { onClose: () => void }): React.ReactElement {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'review' | 'upcoming' | 'history' | 'audit'>('review');
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const feeds = useQuery({ queryKey: ['publishing', 'feeds'], queryFn: () => api.publishing<PublishingFeed[]>('/feeds') });
  const topics = useQuery({ queryKey: ['publishing', 'topics', offset], queryFn: () => api.publishing<PublishingTopic[]>(`/topics?offset=${offset}`), enabled: tab === 'review', refetchInterval: 30000 });
  const schedule = useQuery({ queryKey: ['publishing', 'schedule'], queryFn: () => api.publishing<PublishingScheduleEntry[]>('/schedule'), enabled: tab === 'upcoming', refetchInterval: 30000 });
  const refresh = useQuery({
    queryKey: ['publishing', 'draft-refresh'], queryFn: () => api.publishing<{ running: boolean; message: string; updatedAt: string | null }>('/drafts/refresh'),
    enabled: tab === 'review', refetchInterval: query => query.state.data?.running ? 3000 : false,
  });
  const lastRefresh = useRef<string | null>(null);
  useEffect(() => {
    if (refresh.data?.running || !refresh.data?.updatedAt || refresh.data.updatedAt === lastRefresh.current) return;
    lastRefresh.current = refresh.data.updatedAt;
    void qc.invalidateQueries({ queryKey: ['publishing', 'topics'] });
  }, [qc, refresh.data]);
  const history = useQuery({ queryKey: ['publishing', 'history', offset], queryFn: () => api.publishing<PublishingDelivery[]>(`/history?offset=${offset}`), enabled: tab === 'history', refetchInterval: 30000 });
  const audit = useQuery({ queryKey: ['publishing', 'audit', offset], queryFn: () => api.publishing<PublishingEvent[]>(`/audit?offset=${offset}`), enabled: tab === 'audit' });
  const active = tab === 'history' ? history : tab === 'audit' ? audit : tab === 'upcoming' ? schedule : topics;
  const act: Action = async (path, method, body) => {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.publishing(path, method, body);
      await qc.invalidateQueries({ queryKey: ['publishing'] });
      setMessage(path === '/drafts/refresh' ? 'Draft refresh started. New candidates are being prepared and reviewed; approved and scheduled posts are unchanged.'
        : path.endsWith('/discard') ? 'Draft discarded. The source article and all approved/scheduled posts are unchanged.'
        : path.endsWith('/review') ? 'Review queued. Your saved copy is unchanged; approval will be needed after review.'
        : path.endsWith('/approve') ? 'Package sent for scheduling. Blog and LinkedIn approved together; the blog publishes first.'
        : path.endsWith('/decision') && typeof body === 'object' && body !== null && 'action' in body && body.action === 'approve'
          ? 'Approval saved. Open Scheduling to see the planned time or what is blocking a slot. Automation remains unchanged.'
        : path === '/schedule/refresh' ? 'Schedule refreshed. Missed slots move to the next available opening; posting switches are unchanged.'
        : path.endsWith('/decision') ? 'Decision saved.'
          : 'Saved. Changes apply to the next unclaimed publishing opportunity.'); return true;
    } catch (err) { setError(describeApiError(err)); return false; }
    finally { setBusy(false); }
  };
  const shown = (topics.data ?? []).filter(t => !t.drafts.some(d => d.approval === 'approved')
    && !t.deliveries.some(delivery => ['sent', 'sending', 'unconfirmed'].includes(delivery.status))
    && t.drafts.some(d => isReadyDraft(d) && d.approval === 'pending')).slice(0, 8);
  const scheduled = schedule.data?.find(post => post.draftId === selected) ?? schedule.data?.[0];
  const expanded = shown.find(topic => topic.id === selected)?.id ?? shown.find(topic => topic.drafts.length > 0)?.id ?? shown[0]?.id;
  return <AppDialog title="Publishing" wide settings onClose={onClose}
    actions={<button className="kh-dialog__button" type="button" onClick={onClose}>Close</button>}>
    <div className="kh-publishing" aria-busy={busy}>
      <p className="kh-publishing__meta">Microsoft-first, freshest relevant stories first. Up to 8 reviewed draft entries, refreshed after every content sync. Blog packages count as one entry. Scheduled items are separate.</p>
      <details className="kh-publishing__settings">
      <summary>Automation and schedule{feeds.data ? ` · Bluesky ${feeds.data.find(feed => feed.id === 'bluesky')?.enabled ? 'on' : 'off'} · Blog / LinkedIn ${feeds.data.find(feed => feed.id === 'blog-linkedin')?.enabled ? 'on' : 'off'}` : ''}</summary>
      <div className="kh-publishing__feeds" aria-label="Posting automation">
        {feeds.isLoading && <p role="status">Loading feed settings…</p>}
        {feeds.isError && <p role="alert" className="kh-publishing__error">{describeApiError(feeds.error)}</p>}
        {feeds.data && <PublishingFeedControls feeds={feeds.data} act={act} busy={busy} />}
      </div>
      <p className="kh-publishing__meta">Off pauses new publication, not preparation or review. It cannot retract a request already in flight. Limits cover Athena posts, not posts made directly on the platforms.</p>
      </details>
      {(error || message) && <p role={error ? 'alert' : 'status'} className={error ? 'kh-publishing__error' : 'kh-publishing__notice'}>{error || message}</p>}
      <nav className="kh-publishing__tabs" aria-label="Publishing views">{(['review', 'upcoming', 'history', 'audit'] as const).map(value =>
        <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setOffset(0); setSelected(null); }}>{value === 'review' ? 'Drafts' : value === 'upcoming' ? 'Scheduling' : value === 'history' ? 'History' : 'Audit'}</button>)}</nav>
      {tab === 'review' && <div className="kh-publishing__schedule-toolbar" aria-label="Draft refresh">
        <div className="kh-publishing__refresh-status">
          <p className="kh-publishing__meta" role="status">{refresh.isLoading ? 'Checking draft preparation…' : refresh.data?.message}</p>
          {refresh.isError && <p className="kh-publishing__error" role="alert">{describeApiError(refresh.error)}</p>}
        </div>
        <button type="button" disabled={busy || refresh.isLoading || refresh.data?.running === true}
          onClick={() => { void act('/drafts/refresh', 'POST', {}); }}>{refresh.data?.running ? 'Refreshing drafts…' : 'Refresh drafts'}</button>
      </div>}
      {tab === 'upcoming' && <div className="kh-publishing__schedule-toolbar">
        <p className="kh-publishing__meta">Approved posts and podcast campaigns share this schedule. Off pauses delivery. Refresh replans ordinary drafts; podcast times stay as approved and are managed in Campaign. Blog-linked posts wait for the verified public URL.</p>
        <button type="button" disabled={busy || schedule.isFetching} onClick={() => { void act('/schedule/refresh', 'POST', {}); }}>Refresh schedule</button>
      </div>}
      {active.isLoading && <p role="status">Loading publishing {tab}…</p>}
      {active.isError && <div className="kh-publishing__error" role="alert"><p>{describeApiError(active.error)}</p><button type="button" onClick={() => { void active.refetch(); }}>Retry loading</button></div>}
      {!active.isLoading && !active.isError && (active.data?.length === 0 || (tab === 'review' && !shown.length)) && <p className="kh-publishing__empty">{tab === 'history' ? 'No delivery attempts yet.' : tab === 'audit' ? 'No publishing events yet.' : tab === 'upcoming' ? 'No posts sent for scheduling yet.' : 'No finished drafts ready for approval. Athena completes writing and editorial checks before showing posts here. Preparation failures are recorded in Audit; unfinished or failed drafts are never offered for scheduling.'}</p>}
      {tab === 'review' && shown.length > 0 && <div className="kh-publishing__workspace">
        <PublishingDraftList topics={shown} selected={expanded} onSelect={setSelected} />
        <article className="kh-publishing__reading" aria-label="Selected draft">
          {expanded && <TopicReview key={expanded} id={expanded} act={act} busy={busy} feeds={feeds.data ?? []} readyOnly />}
        </article>
      </div>}
      {tab === 'upcoming' && !schedule.isError && scheduled && <div className="kh-publishing__workspace kh-publishing__workspace--schedule">
        <PublishingSchedule posts={schedule.data ?? []} selected={scheduled.draftId} onSelect={setSelected} />
        <article className="kh-publishing__reading" aria-label="Scheduled draft">
          {!scheduled.scheduledAt && <section className="kh-publishing__blocker" aria-label="Scheduling blocker">
            <h3>Why this cannot be scheduled</h3>
            <p>{scheduled.reason}</p>
          </section>}
          {'noteId' in scheduled ? <ScheduledPodcastPreview post={scheduled} onOpen={onClose} />
            : <TopicReview key={scheduled.draftId} id={scheduled.topicId} initialDestination={scheduled.destination} act={act} busy={busy} feeds={feeds.data ?? []} />}
        </article>
      </div>}
      {tab === 'history' && history.data?.map(delivery => <article className="kh-publishing__history" key={delivery.id}>
        <h3>{names[delivery.destination as keyof typeof names] ?? delivery.destination} · {delivery.status}</h3>
        <p className="kh-publishing__meta">{delivery.account} · {when(delivery.publishedAt ?? delivery.attemptedAt)}{delivery.nextAttemptAt && ` · Retry after ${when(delivery.nextAttemptAt)}`}</p>
        {delivery.error && <p className="kh-publishing__notice">{delivery.error}</p>}
        {typeof delivery.receipt?.url === 'string' && /^https:\/\//.test(delivery.receipt.url) && <a target="_blank" rel="noreferrer" href={delivery.receipt.url}>View published post</a>}
        {['unconfirmed', 'sending', 'failed'].includes(delivery.status) && <Reconciliation delivery={delivery} act={act} busy={busy} />}
      </article>)}
      {tab === 'audit' && audit.data?.map(entry => <details className="kh-publishing__evidence" key={entry.id}>
        <summary>{entry.event} · {when(entry.createdAt)} · {entry.actor}</summary><pre>{JSON.stringify(entry.detail, null, 2)}</pre>
      </details>)}
      {tab !== 'upcoming' && <div className="kh-publishing__actions kh-publishing__paging"><button type="button" disabled={offset === 0 || active.isFetching} onClick={() => { setOffset(v => Math.max(0, v - 50)); setSelected(null); }}>Previous page</button>
        <button type="button" disabled={!active.data || active.data.length < 50 || active.isFetching || offset >= 10000} onClick={() => { setOffset(v => v + 50); setSelected(null); }}>Next page</button></div>}
    </div>
  </AppDialog>;
}
