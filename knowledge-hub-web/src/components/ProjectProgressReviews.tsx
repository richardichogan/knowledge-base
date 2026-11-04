import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { DataNotice } from './DataNotice';
import { useAthenaContext } from '../context/AthenaContext';
import type { ProgressEvidence, ProgressFinding, ProgressReview, ProgressReviewSummary } from '../types/progressReview';

const dateTime = (value: string): string => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const WORK_TYPE_LABEL = { project: 'Project', opportunity: 'Opportunity', offering: 'Offering', bau: 'BAU', aspiration: 'Aspiration', exploration: 'Exploration', 'side-project': 'Side project' };

function EvidenceLinks({ ids, evidence }: { ids: string[]; evidence: ProgressEvidence[] }): React.ReactElement | null {
  const sources = ids.flatMap(id => {
    const source = evidence.find(item => item.id === id);
    return source ? [source] : [];
  });
  if (!sources.length) return null;
  return <div className="kh-progress-review__sources" aria-label="Supporting sources">
    {sources.map(source => source.href.startsWith('/') && !source.href.startsWith('//')
      ? <Link key={source.id} to={source.href}>{source.title}</Link>
      : /^https?:\/\//i.test(source.href) ? <a key={source.id} href={source.href} target="_blank" rel="noreferrer">{source.title}</a>
        : <span key={source.id}>{source.title}</span>)}
  </div>;
}

function Findings({ title, items, review, empty }: { title: string; items: ProgressFinding[]; review: ProgressReview; empty: string }): React.ReactElement {
  return <section className="kh-progress-review__findings">
    <h4>{title}</h4>
    {items.length ? <ul className="kh-progress-review__findings-list">{items.map((item, index) => <li key={index}>
      <p>{item.text}</p><EvidenceLinks ids={item.evidenceIds} evidence={review.evidence} />
    </li>)}</ul> : <p>{empty}</p>}
  </section>;
}

function ReviewBody({ projectId, reviewId }: { projectId: string; reviewId: string }): React.ReactElement {
  const review = useQuery({
    queryKey: ['project-progress-review', projectId, reviewId],
    queryFn: async () => requireApiData(await api.getProgressReview(projectId, reviewId)), retry: false,
  });
  return <div className="kh-progress-review__body">
    {review.isLoading && <p role="status">Reading saved review...</p>}
    {review.isError && <DataNotice title="This review could not be loaded." error={review.error} onRetry={() => { void review.refetch(); }} />}
    {review.data && <>
      <p className="kh-progress-review__meta">{WORK_TYPE_LABEL[review.data.projectType]} · {dateTime(review.data.since)} to {dateTime(review.data.until)}</p>
      <p>{review.data.assessment.summary}</p>
      <Findings title="Meaningful progress" items={review.data.assessment.progress} review={review.data} empty="No meaningful progress could be substantiated from the retrieved evidence." />
      <Findings title="Activity without a demonstrated outcome" items={review.data.assessment.activity} review={review.data} empty="No additional activity was identified that warrants a separate finding." />
      <Findings title="Blockers and uncertainty" items={review.data.assessment.blockers} review={review.data} empty="No specific blocker was identified in the retrieved evidence. This is not proof that none exists." />
      <section className="kh-progress-review__findings">
        <h4>Suggested next move</h4><p>{review.data.assessment.nextMove.text}</p>
        <h4>Why Athena picked it</h4><p>{review.data.assessment.nextMove.why}</p>
        <EvidenceLinks ids={review.data.assessment.nextMove.evidenceIds} evidence={review.data.evidence} />
      </section>
      <p className="kh-progress-review__meta">Saved assessment, not a live status report. No tasks, goals or deliverables were changed.</p>
      <details className="kh-progress-review__evidence">
        <summary>Evidence and access limitations</summary>
        <ul className="kh-progress-review__limitations">{review.data.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
        <h4>Direction used for this review</h4>
        <p>{review.data.projectSnapshot.goal || 'No goal was recorded.'}</p>
        {review.data.projectSnapshot.deliverables.length > 0 && <ul className="kh-progress-review__limitations">
          {review.data.projectSnapshot.deliverables.map((item, index) => <li key={index}>{item}</li>)}
        </ul>}
        {review.data.evidence.map(item => <details className="kh-progress-review__excerpt" key={item.id}>
          <summary>{item.title}</summary>
          <p className="kh-progress-review__meta">{item.kind} · {dateTime(item.updatedAt)} · {item.role === 'changed-record' ? 'Recorded update, not a version diff' : 'Saved content snapshot'}{item.truncated ? ' · Partial excerpt' : ''}</p>
          <p className="kh-progress-review__content">{item.content || 'No body content was retrieved.'}</p>
          <EvidenceLinks ids={[item.id]} evidence={review.data.evidence} />
        </details>)}
      </details>
    </>}
  </div>;
}

function HistoryItem({ item, expanded, onToggle }: { item: ProgressReviewSummary; expanded: boolean; onToggle: () => void }): React.ReactElement {
  return <div className="kh-progress-review__history-item">
    <button className="kh-progress-review__toggle" type="button" aria-expanded={expanded} aria-controls={`progress-review-${item.id}`} onClick={onToggle}>
      <span>{dateTime(item.createdAt)}</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {!expanded && <p className="kh-progress-review__meta">{item.summary}</p>}
    <div id={`progress-review-${item.id}`} hidden={!expanded}>
      {expanded && <ReviewBody projectId={item.projectId} reviewId={item.id} />}
    </div>
  </div>;
}

export function ProjectProgressReviews({ projectId }: { projectId: string }): React.ReactElement {
  const qc = useQueryClient();
  const requestId = useRef<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const previousLatest = useRef<string>();
  const history = useQuery({
    queryKey: ['project-progress-reviews', projectId, offset],
    queryFn: async () => requireApiData(await api.getProgressReviews(projectId, offset)), retry: false,
  });
  const { pageContext, setAthenaContext } = useAthenaContext();
  const activeReview = useQuery({
    queryKey: ['project-progress-review', projectId, expanded],
    queryFn: async () => requireApiData(await api.getProgressReview(projectId, expanded!)),
    enabled: expanded !== null, retry: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      requestId.current ??= crypto.randomUUID();
      return requireApiData(await api.generateProgressReview(projectId, requestId.current));
    },
    onSuccess: data => {
      requestId.current = null;
      setOffset(0);
      setExpanded(data.id);
      qc.setQueryData(['project-progress-review', projectId, data.id], data);
      void qc.invalidateQueries({ queryKey: ['project-progress-reviews', projectId] });
    },
    onError: () => { void qc.invalidateQueries({ queryKey: ['project-progress-reviews', projectId] }); },
  });
  const latest = offset === 0 ? history.data?.items[0]?.id : undefined;
  useEffect(() => {
    if (latest && latest !== previousLatest.current) {
      previousLatest.current = latest;
      setExpanded(latest);
    }
  }, [latest]);
  const pending = generate.isPending;
  useEffect(() => {
    if (pageContext?.id !== projectId) return;
    const marker = '\nActive project progress review:\n';
    const detail = `${(pageContext.detail ?? '').split(marker)[0]}${marker}${JSON.stringify({
      projectId, reviewId: expanded, generating: pending, latestReviewId: latest,
      access: activeReview.isError ? 'Selected review could not be loaded.' : activeReview.isFetching ? 'Reading selected review.' : 'Saved review context.',
      assessment: activeReview.data?.assessment, period: activeReview.data ? { since: activeReview.data.since, until: activeReview.data.until } : undefined,
      limitations: activeReview.data?.limitations,
      retrieval: 'Use read_project_progress_reviews for full captured evidence excerpts and history. Only generate_project_progress_review when requested. A review is not an edit or acceptance.',
    })}`;
    if (detail !== pageContext.detail) setAthenaContext({ ...pageContext, detail });
  }, [projectId, expanded, pending, latest, activeReview.data, activeReview.isError, activeReview.isFetching, pageContext, setAthenaContext]);

  return <section className="kh-work-context kh-progress-review" aria-label="Direction and progress review">
    <div className="kh-progress-review__header">
      <h3>Direction and progress</h3>
      <button className="kh-btn-accent" type="button" disabled={pending} onClick={() => { generate.mutate(); }}>Review progress</button>
    </div>
    <p>Review the last seven days against this work’s direction, using linked saved evidence. Previous reviews stay here.</p>
    {pending && <p role="status">Athena is reading linked evidence and preparing the review. Nothing else is being changed...</p>}
    {generate.isError && <DataNotice title="The progress review could not be confirmed. Refresh history before retrying." error={generate.error} />}
    {history.isLoading && <p role="status">Loading review history...</p>}
    {history.isError && <DataNotice title="Review history could not be loaded." error={history.error} onRetry={() => { void history.refetch(); }} />}
    {history.data && <>
      {!history.data.items.length && <p>No saved reviews yet.</p>}
      {history.data.items.map(item => <HistoryItem key={item.id} item={item} expanded={expanded === item.id}
        onToggle={() => { setExpanded(previous => previous === item.id ? null : item.id); }} />)}
      {history.data.total > history.data.limit && <div className="kh-progress-review__pager">
        <button className="kh-btn-ghost" type="button" disabled={offset === 0 || history.isFetching} onClick={() => { setOffset(Math.max(0, offset - history.data!.limit)); }}>Newer reviews</button>
        <span>{offset + 1}–{Math.min(offset + history.data.limit, history.data.total)} of {history.data.total}</span>
        <button className="kh-btn-ghost" type="button" disabled={offset + history.data.limit >= history.data.total || history.isFetching}
          onClick={() => { setOffset(offset + history.data!.limit); }}>Older reviews</button>
      </div>}
    </>}
  </section>;
}
