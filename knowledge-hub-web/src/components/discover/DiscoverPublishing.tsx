import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog } from '../AppDialog';
import { BlogPostEditor } from './BlogPostEditor';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import type { FeedPolicy, PublishingFeed, PublishingTopic, PublishingDraft, PublishingDetail, PublishingDelivery, PublishingEvent } from '../../types/publishing';

const names = { bluesky: 'Bluesky', 'blog-linkedin': 'Blog / LinkedIn', blog: 'Blog', linkedin: 'LinkedIn' };
const when = (value: string | null): string => value ? new Date(value).toLocaleString('en-GB') : 'Not yet';
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type Action = (path: string, method: 'POST' | 'PUT', body: unknown) => Promise<boolean>;
function sourceLink(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
export function PublishingFeedControls({ feeds, act, busy }: { feeds: PublishingFeed[]; act: Action; busy: boolean }): React.ReactElement {
  return <>{feeds.map(feed => <section className="kh-publishing__feed" key={feed.id}>
    <div><h3>{names[feed.id]}</h3><p>{feed.id === 'bluesky' ? 'Source-led updates and coordinated blog promotion. Up to 4 posts/day, at least 2 hours apart.' : 'Selective analysis, blog first. Both approvals required. Up to 3 LinkedIn posts/day, at least 3 hours apart.'}</p></div>
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
      <label>Expiry (hours)<input required type="number" min={1} max={720} value={policy.expiryHours} onChange={e => field('expiryHours', Number(e.target.value))} /></label>
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
      {['title', 'excerpt', 'summary'].map(key => <label key={key}>{key === 'title' ? 'Title' : key === 'excerpt' ? 'Excerpt' : 'Summary'}
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
function TopicReview({ id, act, busy }: { id: string; act: Action; busy: boolean }): React.ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const detail = useQuery({ queryKey: ['publishing', 'topic', id], queryFn: () => api.publishing<PublishingDetail>(`/topics/${id}`), refetchInterval: editing ? false : 30000 });
  const d = detail.data;
  if (detail.isError) return <p role="alert" className="kh-publishing__error">{describeApiError(detail.error)}</p>;
  if (!d) return <p role="status">Loading evidence and drafts…</p>;
  function decide(draft: PublishingDraft, action: string): void { void act(`/drafts/${draft.id}/decision`, 'POST', { version: draft.version, action, reason }); }
  return <div className="kh-publishing__review">
    <p>{d.topic.rationale || 'Editorial assessment is pending.'}</p>
    {d.topic.error && <p className="kh-publishing__notice">{d.topic.error}</p>}
    <details className="kh-publishing__evidence"><summary>Source evidence ({d.sources.length})</summary>{d.sources.map(source => <section key={source.itemId}>
      <a href={sourceLink(source.url)} target="_blank" rel="noreferrer">{source.title}</a><p className="kh-publishing__meta">Read: {when(source.readAt)}</p>
      <pre>{source.body || 'Source not yet read. No publication is permitted without evidence.'}</pre>
    </section>)}</details>
    <label>Editorial feedback or hold reason<textarea rows={2} maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <div className="kh-publishing__actions">
      <button type="button" disabled={busy} onClick={() => { void act(`/topics/${id}/decision`, 'POST', { action: 'hold', reason }); }}>Hold topic</button>
      <button type="button" className="kh-publishing__danger" disabled={busy} onClick={() => { void act(`/topics/${id}/decision`, 'POST', { action: 'reject', reason }); }}>Reject topic</button>
      {d.drafts.length === 0 && ['held', 'rejected'].includes(d.topic.state) && <button type="button" disabled={busy}
        onClick={() => { void act(`/topics/${id}/decision`, 'POST', { action: 'reassess' }); }}>Reassess</button>}
    </div>
    {d.drafts.map(draft => {
      const sent = d.deliveries.find(delivery => delivery.draftId === draft.id && delivery.version === draft.version && ['sent', 'sending', 'unconfirmed'].includes(delivery.status));
      const canApprove = draft.review === 'pass' && !draft.held && new Date(draft.expiresAt) > new Date() && (!sent || sent.status === 'sent');
      return <section className="kh-publishing__draft" key={draft.id}>
        <div className="kh-publishing__draft-heading"><h3>{names[draft.destination]} <span>v{draft.version}</span></h3>
          <span className="kh-publishing__meta">{sent?.status ?? (draft.held ? 'Held' : `Review: ${draft.review} · Approval: ${draft.approval}`)}</span></div>
        <p className="kh-publishing__meta">Account: {String(draft.content.accountName ?? draft.content.account ?? 'Not connected')} · Expires: {when(draft.expiresAt)}</p>
        {editing === draft.id ? <DraftEditor key={`${draft.id}:${draft.version}`} draft={draft} act={act} busy={busy} onDone={() => setEditing(null)} /> : <>
          {draft.destination === 'blog' ? <><h4>{String(draft.content.title)}</h4><p>{String(draft.content.summary)}</p>
            <div className="kh-publishing__prose" dangerouslySetInnerHTML={{ __html: sanitizeHtml(String(draft.content.content)) }} /></>
            : <p className="kh-publishing__copy">{String(draft.content.copy)}</p>}
          {draft.destination !== 'blog' && <p className="kh-publishing__meta">{draft.variant === 'blog' ? 'The verified public blog URL is appended at delivery.' : `Source link: ${d.sources[0]?.url ?? 'Unavailable'}`}</p>}
          {draft.reason && <p className="kh-publishing__notice">{draft.reason}</p>}
          <div className="kh-publishing__actions">
            {draft.variant === 'blog' && draft.destination !== 'bluesky' && <button type="button" disabled={busy || !canApprove || draft.approval === 'approved'} onClick={() => decide(draft, 'approve')}>
              {draft.approval === 'approved' ? 'Approved' : `Approve ${names[draft.destination]} v${draft.version}`}</button>}
            <button type="button" disabled={busy || Boolean(sent)} onClick={() => setEditing(draft.id)}>Edit</button>
            <button type="button" disabled={busy || Boolean(sent)} onClick={() => { void act(`/drafts/${draft.id}/review`, 'POST', { version: draft.version }); }}>Request review</button>
            <button type="button" disabled={busy || Boolean(sent)} onClick={() => decide(draft, draft.held ? 'resume' : 'hold')}>{draft.held ? 'Resume draft' : 'Hold draft'}</button>
            <button type="button" disabled={busy || Boolean(sent)} onClick={() => { void act(`/drafts/${draft.id}/account`, 'POST', { version: draft.version }); }}>Rebind account</button>
            <button type="button" className="kh-publishing__danger" disabled={busy || Boolean(sent)} onClick={() => decide(draft, 'reject')}>Reject draft</button>
          </div>
        </>}
        <details className="kh-publishing__evidence"><summary>Version history, accuracy and voice findings</summary>
          {d.versions.filter(v => v.draft_id === draft.id).map(v => <section key={v.version}>
            <h4>Version {v.version} · {v.approved_by ? `Approved by ${v.approved_by} at ${when(v.approved_at)}` : 'No approval recorded'}</h4>
            <pre>{JSON.stringify(v.reviews, null, 2)}</pre><details><summary>Exact version content</summary><pre>{JSON.stringify(v.content, null, 2)}</pre></details>
          </section>)}
        </details>
      </section>;
    })}
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
export function DiscoverPublishing({ onClose }: { onClose: () => void }): React.ReactElement {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'review' | 'upcoming' | 'history' | 'audit'>('review');
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const feeds = useQuery({ queryKey: ['publishing', 'feeds'], queryFn: () => api.publishing<PublishingFeed[]>('/feeds') });
  const topics = useQuery({ queryKey: ['publishing', 'topics', offset], queryFn: () => api.publishing<PublishingTopic[]>(`/topics?offset=${offset}`), enabled: tab === 'review' || tab === 'upcoming', refetchInterval: 30000 });
  const history = useQuery({ queryKey: ['publishing', 'history', offset], queryFn: () => api.publishing<PublishingDelivery[]>(`/history?offset=${offset}`), enabled: tab === 'history', refetchInterval: 30000 });
  const audit = useQuery({ queryKey: ['publishing', 'audit', offset], queryFn: () => api.publishing<PublishingEvent[]>(`/audit?offset=${offset}`), enabled: tab === 'audit' });
  const active = tab === 'history' ? history : tab === 'audit' ? audit : topics;
  const act: Action = async (path, method, body) => {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.publishing(path, method, body);
      await qc.invalidateQueries({ queryKey: ['publishing'] });
      setMessage('Saved. Changes apply to the next unclaimed publishing opportunity.'); return true;
    } catch (err) { setError(describeApiError(err)); return false; }
    finally { setBusy(false); }
  };
  const shown = (topics.data ?? []).filter(t => tab !== 'upcoming' || (t.state === 'ready' && t.drafts.some(d => d.review === 'pass' && !d.held && d.approval !== 'rejected'
    && new Date(d.expiresAt) > new Date()
    && (d.variant === 'source' || t.drafts.filter(companion => companion.destination === 'blog' || companion.destination === 'linkedin').every(companion => companion.approval === 'approved' && !companion.held))
    && !t.deliveries.some(delivery => delivery.draftId === d.id && ['sent', 'sending', 'unconfirmed'].includes(delivery.status)))));
  if (tab === 'upcoming') shown.sort((a, b) => b.priority - a.priority);
  return <AppDialog title="Publishing" wide settings onClose={onClose}
    actions={<button className="kh-dialog__button" type="button" onClick={onClose}>Close</button>}>
    <div className="kh-publishing" aria-busy={busy}>
      <p>Two coordinated feeds. Athena prepares and reviews; you approve every blog and LinkedIn hook. Publishing is paced separately from content sync.</p>
      <div className="kh-publishing__feeds" aria-label="Posting automation">
        {feeds.isLoading && <p role="status">Loading feed settings…</p>}
        {feeds.isError && <p role="alert" className="kh-publishing__error">{describeApiError(feeds.error)}</p>}
        {feeds.data && <PublishingFeedControls feeds={feeds.data} act={act} busy={busy} />}
      </div>
      <p className="kh-publishing__meta">Off pauses new publication, not preparation or review. It cannot retract a request already in flight. Limits cover Athena posts, not posts made directly on the platforms.</p>
      {(error || message) && <p role={error ? 'alert' : 'status'} className={error ? 'kh-publishing__error' : 'kh-publishing__notice'}>{error || message}</p>}
      <nav className="kh-publishing__tabs" aria-label="Publishing views">{(['review', 'upcoming', 'history', 'audit'] as const).map(value =>
        <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setOffset(0); setSelected(null); }}>{value === 'review' ? 'Review' : value === 'upcoming' ? 'Upcoming' : value === 'history' ? 'History' : 'Audit'}</button>)}</nav>
      {active.isLoading && <p role="status">Loading publishing {tab}…</p>}
      {active.isError && <div className="kh-publishing__error" role="alert"><p>{describeApiError(active.error)}</p><button type="button" onClick={() => { void active.refetch(); }}>Retry loading</button></div>}
      {!active.isLoading && !active.isError && active.data?.length === 0 && <p className="kh-publishing__empty">{tab === 'history' ? 'No delivery attempts yet.' : tab === 'audit' ? 'No publishing events yet.' : 'No candidates yet. The next editorial pass will assess eligible Discover articles. Nothing is posted just to fill a schedule.'}</p>}
      {(tab === 'review' || tab === 'upcoming') && shown.map(topic => <article className="kh-publishing__topic" key={topic.id}>
        <button className="kh-publishing__topic-toggle" type="button" aria-expanded={selected === topic.id} onClick={() => setSelected(selected === topic.id ? null : topic.id)}>
          <strong>{topic.title}</strong><span>{topic.state} · {topic.drafts.map(d => names[d.destination]).join(', ') || 'Awaiting selection'}</span>
        </button>
        {selected === topic.id && <TopicReview id={topic.id} act={act} busy={busy} />}
      </article>)}
      {tab === 'upcoming' && topics.data && topics.data.length > 0 && !shown.length && <p className="kh-publishing__empty">Nothing eligible on this page. Held, expired and unreviewed drafts stay in Review.</p>}
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
      <div className="kh-publishing__actions kh-publishing__paging"><button type="button" disabled={offset === 0 || active.isFetching} onClick={() => setOffset(v => Math.max(0, v - 50))}>Newer</button>
        <button type="button" disabled={!active.data || active.data.length < 50 || active.isFetching || offset >= 10000} onClick={() => setOffset(v => v + 50)}>Older</button></div>
    </div>
  </AppDialog>;
}
