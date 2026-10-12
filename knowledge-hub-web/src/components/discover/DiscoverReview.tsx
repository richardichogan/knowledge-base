import React, { useId, useRef, useState } from 'react';
import { api, type DiscoverFeedbackReason, type DiscoverItem } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { DataNotice } from '../DataNotice';

const REASONS: Array<{ value: DiscoverFeedbackReason; label: string }> = [
  { value: 'too-high', label: 'Relevance is too high' }, { value: 'too-low', label: 'Relevance is too low' },
  { value: 'not-relevant', label: 'Not relevant to my work' }, { value: 'already-covered', label: 'Already covered' },
  { value: 'incorrect-classification', label: 'Incorrect classification' },
];

export const DiscoverReview: React.FC<{ item: DiscoverItem }> = ({ item }) => {
  const id = useId();
  const factors = item.rankFactors;
  const [reason, setReason] = useState<DiscoverFeedbackReason>('not-relevant');
  const [explanation, setExplanation] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const request = useRef<{ requestId: string; reason: DiscoverFeedbackReason; explanation: string } | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy.current || saved) return;
    busy.current = true; setPending(true); setError(null);
    try {
      if (!request.current || request.current.reason !== reason || request.current.explanation !== explanation) {
        request.current = { requestId: crypto.randomUUID(), reason, explanation };
      }
      requireApiData(await api.saveDiscoverFeedback(item.id, request.current));
      setSaved(true);
    } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  }

  return (
    <div className="dc-review" onClick={event => event.stopPropagation()}>
      <details className="dc-review__rank">
        <summary>Why this rank?</summary>
        {factors ? <>
          <dl>
            <div><dt>Editorial relevance</dt><dd>{factors.editorial === null ? 'Unscored (treated as 0)' : `${(factors.editorial * 100).toFixed(1)} points`}</dd></div>
            <div><dt>Freshness ({factors.halfLifeDays}-day half-life)</dt><dd>{factors.recency === null ? 'Unknown' : `x ${factors.recency.toFixed(6)}`}</dd></div>
            <div><dt>Source authority</dt><dd>x {factors.authority.toFixed(6)}</dd></div>
            <div><dt>Article type</dt><dd>x {factors.articleType.toFixed(6)}</dd></div>
            <div><dt>Project fit</dt><dd>x {factors.project.toFixed(6)}</dd></div>
          </dl>
          <p>Multiply relevance points by these factors to obtain {item.rankScore == null ? 'an unavailable rank' : `${(item.rankScore * 100).toFixed(1)} rank points`}.
            {' '}Values are rounded for display; boosts can exceed 100. Computed {new Date(factors.computedAt).toLocaleString('en-GB')}.</p>
        </> : <p>Ranking factors are unavailable for this result. Refresh to request current factors.</p>}
      </details>
      <details className="dc-review__feedback">
        <summary>Give relevance feedback</summary>
        <p>Stored for review only. This does not change scoring weights or the article's workflow.</p>
        <form onSubmit={event => { void submit(event); }}>
          <label htmlFor={`${id}-reason`}>Reason</label>
          <select id={`${id}-reason`} value={reason} disabled={pending} onChange={event => {
            const next = REASONS.find(value => value.value === event.target.value);
            if (next) { setReason(next.value); setSaved(false); }
          }}>{REASONS.map(value => <option key={value.value} value={value.value}>{value.label}</option>)}</select>
          <label htmlFor={`${id}-explanation`}>Explanation (optional, up to 2,000 characters)</label>
          <textarea id={`${id}-explanation`} value={explanation} maxLength={2000} disabled={pending}
            onChange={event => { setExplanation(event.target.value); setSaved(false); }} />
          {error != null && <DataNotice title="Feedback was not confirmed; submit again to retry safely" error={error} />}
          <button type="submit" disabled={pending || saved}>{pending ? 'Saving feedback...' : saved ? 'Feedback saved' : 'Submit feedback'}</button>
          {saved && <p role="status">Feedback recorded. Score and workflow unchanged.</p>}
        </form>
      </details>
    </div>
  );
};
