import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import type { DesignReadiness as ReadinessData, ReadinessEvidence } from '../../types/designs';
import { extractNoteBlockText } from '../../notes/noteText';

const labels: Record<ReadinessData['state'], string> = {
  'not-assessed': 'Not assessed', blocked: 'Specification gaps open', ready: 'Checked specification complete',
  partial: 'Partial assessment — not ready', stale: 'Stale — sources changed', unavailable: 'Sources unavailable',
};

export const DesignReadiness: React.FC<{
  id: string; specId: string | undefined; currentSpecId: string | undefined; revision: number | undefined;
  designRevision: number; busy: boolean; prepare: () => Promise<void>;
  onBusyChange: (busy: boolean) => void; onApplied: () => Promise<void>;
}> = ({ id, specId, currentSpecId, revision, designRevision, busy, prepare, onBusyChange, onApplied }) => {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [target, setTarget] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const query = useQuery({ queryKey: ['design-readiness', id, revision, designRevision, offset, status],
    queryFn: async () => requireApiData(await api.getDesignReadiness(id, offset, status)) });
  const refresh = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ['design-readiness', id] }); };
  const check = useMutation({
    mutationFn: async () => {
      await prepare();
      const current = requireApiData(await api.getDesign(id));
      const candidates = current.assets.filter(item => item.role === 'spec');
      const selected = current.selections.spec ?? (candidates.length === 1 ? candidates[0]?.sourceId : undefined);
      if (!selected || selected !== specId) throw new Error('Select this specification for handoff before checking readiness.');
      return requireApiData(await api.checkDesignReadiness(id, selected));
    },
    onSuccess: async () => { setOffset(0); setStatus('open'); await refresh(); },
  });
  const repair = useMutation({
    mutationFn: async () => {
      await prepare();
      if (!query.data?.report || !target) throw new Error('Choose a finding in the current assessment.');
      return requireApiData(await api.prepareDesignReadinessRepair(id, query.data.report.id, target, instruction.trim(), synthetic));
    },
    onSuccess: async () => { setTarget(null); setInstruction(''); setSynthetic(false); await refresh(); },
  });
  const resolve = useMutation({
    mutationFn: async (accept: boolean) => {
      if (accept) await prepare();
      if (!query.data?.proposal) throw new Error('The pending repair is unavailable.');
      return requireApiData(await api.resolveDesignReadinessRepair(id, query.data.proposal.id, accept));
    },
    onSuccess: async result => { if (result.noteIds.length) await onApplied(); await refresh(); },
  });
  const working = check.isPending || repair.isPending || resolve.isPending;
  useEffect(() => { onBusyChange(working); return () => { onBusyChange(false); }; }, [working, onBusyChange]);
  const view = query.data;
  const report = view?.report;
  const isSelected = !!specId && specId === currentSpecId;
  const canRepair = isSelected && view && !['stale', 'unavailable', 'not-assessed'].includes(view.state);
  const error = check.error ?? repair.error ?? resolve.error;
  const evidence = (entry: ReadinessEvidence, index: number): React.ReactNode => {
    const source = report?.sources.find(item => item.id === entry.sourceId);
    return <div className="kh-design-readiness__evidence" key={`${entry.sourceId}:${index}`}>
      {source ? <Link to={source.href}>{source.title} · revision {entry.revision}{entry.elementId ? ` · element ${entry.elementId}` : ''}</Link>
        : <span>Source {entry.sourceId} · revision {entry.revision} (historical)</span>}
      {source && entry.revision !== source.revision && <p>Evidence from an earlier revision; not a current read.</p>}
      <blockquote>{entry.quote}</blockquote>
    </div>;
  };
  return <section className="kh-design-readiness" aria-label="IMAGINE specification readiness">
    <h3>IMAGINE readiness</h3>
    <p>Check the saved specification against its selected sources. Handoff stays available with warnings; this does not certify implementation or live approval.</p>
    {!isSelected && <p className="kh-design-readiness__warning">Select this specification for handoff before checking or preparing a repair.</p>}
    <button type="button" className="kh-btn-accent" disabled={busy || working || !isSelected || !!view?.proposal}
      onClick={() => { check.reset(); repair.reset(); resolve.reset(); check.mutate(); }}>{check.isPending ? 'Checking readiness…' : 'Check readiness'}</button>
    {working && <p role="status">{check.isPending ? 'Reading saved sources and checking actual completeness. One bounded review; no automatic retries.'
      : repair.isPending ? 'Preparing a targeted preview. Your writing is unchanged.' : 'Resolving the reviewed repair…'}</p>}
    {query.isLoading && <p role="status">Loading saved assessment…</p>}
    {query.isError && <p role="alert" className="kh-design-readiness__error">{describeApiError(query.error)}
      {' '}<button type="button" className="kh-btn-ghost" disabled={working} onClick={() => { void query.refetch(); }}>Retry loading</button></p>}
    {error && <p role="alert" className="kh-design-readiness__error">{describeApiError(error)} Previous saved assessments are unchanged unless a repair was applied.</p>}
    {view && !working && <>
      <p role="status" className={`kh-design-readiness__state kh-design-readiness__state--${view.state}`}>{labels[view.state]}</p>
      {view.sourceError && <p className="kh-design-readiness__error">{view.sourceError}</p>}
      {report && <>
        <p className="kh-design-readiness__meta">Checked {new Date(report.checkedAt).toLocaleString('en-GB')} · Design revision {report.designRevision} · {report.ruleVersion}</p>
        <p>{view.counts.blockers} open specification gap(s) · {view.counts.executionPrerequisites} execution prerequisite(s) · {view.counts.resolved} resolved finding(s).</p>
        <details className="kh-design-readiness__details"><summary>Checked sources and coverage</summary>
          <ul>{report.sources.map(source => <li key={`${source.id}:${source.role}`}><Link to={source.href}>{source.title}</Link> · {source.role} · revision {source.revision}</li>)}</ul>
          {(report.coverage ?? []).map(item => <details className="kh-design-readiness__details" key={item.obligation}>
            <summary>{item.obligation} · {item.status}</summary>
            <p>{item.explanation}</p>{item.evidence.map(evidence)}
          </details>)}
          {report.limitations.map((limitation, index) => <p className="kh-design-readiness__warning" key={index}>{limitation}</p>)}
        </details>
        <div className="kh-design-readiness__actions">
          <button type="button" className="kh-btn-ghost" aria-pressed={status === 'open'} onClick={() => { setStatus('open'); setOffset(0); }}>Open findings</button>
          <button type="button" className="kh-btn-ghost" aria-pressed={status === 'resolved'} onClick={() => { setStatus('resolved'); setOffset(0); }}>Resolved findings</button>
        </div>
        <ol className="kh-design-readiness__findings" start={offset + 1}>
          {report.findings.map(finding => <li key={finding.id}>
            <strong>{finding.target}</strong>
            <p className="kh-design-readiness__meta">{finding.kind === 'blocker' ? 'Specification gap' : 'Execution prerequisite'} · {finding.origin} · {finding.status}</p>
            <p>{finding.explanation}</p><p><strong>Needed:</strong> {finding.expectedEvidence}</p>
            {finding.evidence.map(evidence)}
            {finding.resolution && <details className="kh-design-readiness__details"><summary>Recorded resolution</summary>
              <p>{finding.resolution.explanation}</p>{finding.resolution.evidence.map(evidence)}</details>}
            {finding.status === 'open' && <button type="button" className="kh-btn-ghost" disabled={busy || !canRepair || !!view.proposal}
              onClick={() => { setTarget(finding.id); setInstruction(''); setSynthetic(false); repair.reset(); }}>Prepare repair</button>}
            {target === finding.id && <form className="kh-design-readiness__repair" onSubmit={event => {
              event.preventDefault(); if (canRepair && instruction.trim()) repair.mutate();
            }}>
              <label>Confirmed answer or repair instruction
                <textarea value={instruction} maxLength={4000} rows={4} disabled={busy || !canRepair} required
                  onChange={event => { setInstruction(event.target.value); }} />
              </label>
              <label className="kh-design-readiness__checkbox">
                <input type="checkbox" checked={synthetic} disabled={busy || !canRepair} onChange={event => { setSynthetic(event.target.checked); }} />
                <span>I authorise synthetic fixtures for this repair only; label them illustrative, never live evidence.</span>
              </label>
              <p>No writing is saved until you review and Apply the preview. Unanswered decisions stay open.</p>
              <div className="kh-design-readiness__actions">
                <button type="submit" className="kh-btn-accent" disabled={busy || !canRepair || !instruction.trim()}>Prepare preview</button>
                <button type="button" className="kh-btn-ghost" onClick={() => { setTarget(null); }}>Cancel</button>
              </div>
            </form>}
          </li>)}
        </ol>
        {!report.findings.length && <p>{status === 'resolved' ? 'No resolved findings on this page.' : 'No open findings on this page. Check coverage and freshness before relying on the assessment.'}</p>}
        <div className="kh-design-readiness__actions">
          <button type="button" className="kh-btn-ghost" disabled={!offset || query.isFetching} onClick={() => { setOffset(value => Math.max(0, value - 20)); }}>Previous findings</button>
          <button type="button" className="kh-btn-ghost" disabled={view.nextOffset === null || query.isFetching} onClick={() => { if (view.nextOffset !== null) setOffset(view.nextOffset); }}>More findings</button>
        </div>
      </>}
      {view.proposal && <div className="kh-design-readiness__proposal">
        <h4>Review pending repair</h4>
        <p><strong>Your instruction:</strong> {view.proposal.instruction}</p>
        <p>{view.proposal.explanation}</p>
        <p>Synthetic fixtures {view.proposal.allowSyntheticFixtures ? 'authorised for this repair only' : 'not authorised'}.</p>
        {view.proposal.changes.map((change, index) => <details open className="kh-design-readiness__details" key={index}>
          <summary>{change.blockId ? `Replace block ${change.blockId}` : 'Append new content'}</summary>
          {change.before !== null && <><p>Current block</p><pre tabIndex={0} aria-label="Current block content">{extractNoteBlockText([{ content: change.before }])}</pre></>}
          <p>Proposed writing</p>
          <pre tabIndex={0} aria-label="Proposed block content">{change.markdown}</pre>
        </details>)}
        <p>Apply saves only these changes with note history. Readiness then becomes stale; recheck to establish which findings are resolved.</p>
        <div className="kh-design-readiness__actions">
          <button type="button" className="kh-btn-accent" disabled={busy || !canRepair} onClick={() => { resolve.reset(); resolve.mutate(true); }}>Apply reviewed repair</button>
          <button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { resolve.reset(); resolve.mutate(false); }}>Discard</button>
        </div>
      </div>}
    </>}
  </section>;
};
