import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';

const labels: Record<string, string> = { use_case: 'Use case', spec: 'Spec', architecture: 'Architecture', diagram: 'Diagram' };

export const DesignConsistency: React.FC<{ id: string; busy: boolean; prepare: () => Promise<void> }> = ({ id, busy, prepare }) => {
  const [change, setChange] = useState('');
  const review = useMutation({
    mutationFn: async (requestedChange: string) => { await prepare(); return requireApiData(await api.checkDesignConsistency(id, requestedChange || undefined)); },
  });
  const report = review.data;
  return <section className="kh-design-consistency" aria-label="Design consistency">
    <h3>Consistency</h3>
    <p>Compare the selected saved inputs without rewriting them or blocking handoff. Pending editor changes are saved first.</p>
    <button type="button" className="kh-btn-accent" disabled={busy || review.isPending} onClick={() => { review.mutate(''); }}>
      {review.isPending ? 'Checking consistency...' : 'Check consistency'}
    </button>
    <details className="kh-design-consistency__impact">
      <summary>What would this decision change affect?</summary>
      <label className="kh-work-context__field">Proposed change
        <textarea value={change} maxLength={4000} disabled={review.isPending} rows={4}
          placeholder="Describe the existing decision and what you propose changing."
          onChange={event => { setChange(event.target.value); }} />
      </label>
      <p>Find linked passages and diagram elements to revisit. This assesses a proposal; it does not apply the decision or rewrite anything.</p>
      <button type="button" className="kh-btn-accent" disabled={busy || review.isPending || !change.trim()}
        onClick={() => { review.mutate(change.trim()); }}>Check change impact</button>
    </details>
    {review.isPending && <p role="status">Reading the supplied versions and verifying evidence. Previous results are hidden while this check runs.</p>}
    {review.isError && <p className="kh-design-work__error" role="alert">{describeApiError(review.error)}</p>}
    {report && !review.isPending && !review.isError && <div className="kh-design-consistency__report">
      <p className="kh-design-consistency__meta">Snapshot checked {new Date(report.checkedAt).toLocaleString('en-GB')} · Design revision {report.designRevision}. Recheck after edits.</p>
      {report.requestedChange && <p><strong>Proposed change assessed:</strong> {report.requestedChange}</p>}
      <dl className="kh-design-consistency__coverage">
        {report.coverage.map(item => <div key={item.role}><dt>{labels[item.role] ?? item.role}</dt><dd>{item.status === 'missing' ? 'Not supplied / not assessed' : item.status}</dd></div>)}
      </dl>
      {!report.complete && <p className="kh-design-consistency__warning">Incomplete coverage. Missing, ambiguous or unavailable inputs have not been assessed.</p>}
      {report.findings.length === 0 ? <p>{report.coverage.some(item => ['ambiguous', 'unavailable'].includes(item.status))
        ? 'Resolve the input selections before checking.'
        : report.coverage.filter(item => item.status === 'supplied').length < (report.requestedChange ? 1 : 2)
          ? 'Link at least two authoritative inputs to compare.'
          : report.requestedChange ? 'No evidenced impacts were identified in the supplied inputs. This does not establish that the change is safe or that unlinked material is unaffected.'
            : 'No evidenced conflicts or open decisions were found in the supplied inputs. This is not a completeness certification.'}</p>
        : <ol className="kh-design-consistency__findings">{report.findings.map((finding, index) => <li key={index}>
          <strong>{finding.kind === 'impact' ? 'Potential change impact' : finding.kind === 'contradiction' ? 'Contradiction' : 'Open decision'}</strong>
          <p>{finding.explanation}</p>
          {finding.evidence.map((evidence, n) => {
            const source = report.sources.find(item => item.id === evidence.sourceId);
            return <div className="kh-design-consistency__evidence" key={n}>
              {source && <Link to={source.href}>{source.title} · revision {source.revision}{evidence.elementId ? ` · element ${evidence.elementId}` : ''}</Link>}
              <blockquote>{evidence.quote}</blockquote>
            </div>;
          })}
        </li>)}</ol>}
    </div>}
  </section>;
};
