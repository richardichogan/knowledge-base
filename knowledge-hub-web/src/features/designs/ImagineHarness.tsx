import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { rememberAgentJob } from '../../services/agentJobStore';
import { confirmDialog } from '../../services/appDialogs';
import { requestCompletionNotifications } from '../../chat/completionNotification';
import type { DesignDetail } from '../../types/designs';

export const ImagineHarness: React.FC<{
  design: DesignDetail; busy: boolean; prepare: () => Promise<void>;
  onChanged: (design: DesignDetail) => void; onBusyChange: (busy: boolean) => void;
}> = ({ design, busy, prepare, onChanged, onBusyChange }) => {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const key = ['imagine-harness', design.id];
  const query = useQuery({ queryKey: key, enabled: design.imagineDemo,
    queryFn: async () => requireApiData(await api.getImagineHarness(design.id)) });
  const harness = query.data;
  const flag = useMutation({
    mutationFn: async (enabled: boolean) => {
      await prepare();
      return requireApiData(await api.setDesignImagineDemo(design.id, enabled, design.revision));
    },
    onSuccess: async updated => { onChanged(updated); await qc.invalidateQueries({ queryKey: key }); },
    onError: err => { setError(describeApiError(err)); },
  });
  const approve = useMutation({
    mutationFn: async () => {
      await prepare();
      if (!harness?.canApprove || harness.specRevision === null || !harness.assessmentId) throw new Error('Save and validate the specification before approving it.');
      return requireApiData(await api.approveImagineSpec(design.id, {
        expectedRevision: design.revision, expectedSpecRevision: harness.specRevision, assessmentId: harness.assessmentId,
      }));
    },
    onSuccess: result => { qc.setQueryData(key, result); },
    onError: err => { setError(describeApiError(err)); },
  });
  const generate = useMutation({
    mutationFn: async () => {
      await prepare();
      const result = requireApiData(await api.handOffToSpecialist('imagine-workforce-designer', design.id, {}, true));
      if (result.status === 'needs_confirmation') throw new Error(result.message);
      rememberAgentJob(result.job);
    },
    onError: err => { setError(describeApiError(err)); },
  });
  const check = useMutation({
    mutationFn: async () => { await prepare(); return requireApiData(await api.checkImagineWorkforce(design.id)); },
    onSuccess: result => { qc.setQueryData(key, result); },
    onError: err => { setError(describeApiError(err)); },
  });
  const pending = flag.isPending || approve.isPending || generate.isPending || check.isPending;
  useEffect(() => { onBusyChange(pending); return () => { onBusyChange(false); }; }, [pending, onBusyChange]);
  const start = async (): Promise<void> => {
    setError(null);
    if (harness?.workforce && !await confirmDialog('Athena will regenerate the selected workforce document from the approved specification. Earlier versions remain in note history.',
      { title: 'Regenerate workforce design?', confirmLabel: 'Continue', tone: 'danger' })) return;
    requestCompletionNotifications();
    generate.mutate();
  };
  return <section className="kh-imagine-harness" aria-label="Imagine demo harness">
    <h3>Imagine demo</h3>
    <label className="kh-imagine-harness__flag">
      <input type="checkbox" checked={design.imagineDemo} disabled={busy || pending}
        onChange={event => { setError(null); flag.mutate(event.target.checked); }} />
      <span>Use the Imagine demo harness</span>
    </label>
    <p>The flag enables gated design work, not generation or deployment.</p>
    {design.imagineDemo && <>
      <p>Use case → validated Spec → your approval → Workforce → review.</p>
      {query.isLoading && <p role="status">Loading harness state...</p>}
      {query.isError && <p role="alert" className="kh-design-work__error">{describeApiError(query.error)}{' '}
        <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>}
      {harness && <>
        <p role="status">{harness.workforce?.validated ? 'Workforce contract validated. Stopped for your review.'
          : harness.specApproved ? 'Current specification approved. Workforce generation is unlocked.'
            : harness.canApprove ? 'Specification validated. Waiting for your approval.'
              : 'Specification not yet approved. Workforce generation is locked.'}</p>
        {harness.blockers.length > 0 && <ul className="kh-imagine-harness__blockers">
          {harness.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
        {harness.blockerCount > harness.blockers.length && <p>Showing {harness.blockers.length} of {harness.blockerCount} blockers. Read the remaining findings in the Spec tab.</p>}
        {!harness.specApproved && <button type="button" className="kh-btn-accent" disabled={busy || pending || !harness.canApprove}
          onClick={() => { setError(null); approve.mutate(); }}>{approve.isPending ? 'Approving...' : 'Approve this spec'}</button>}
        <button type="button" className="kh-btn-accent" disabled={busy || pending || !harness.specApproved}
          onClick={() => { void start(); }}>{generate.isPending ? 'Starting...' : harness.workforce ? 'Regenerate workforce' : 'Generate workforce'}</button>
        {harness.workforce && <button type="button" className="kh-btn-ghost" disabled={busy || pending || !harness.specApproved}
          onClick={() => { setError(null); check.mutate(); }}>{check.isPending ? 'Checking...' : 'Check workforce contract'}</button>}
        {harness.workforce && !harness.workforce.validated && <p>The workforce is not validated against the current approved sources. Check saved edits or regenerate it after spec approval.</p>}
      </>}
      <p>Design checks only. No Imagine records, runtime execution or UI acceptance are claimed.</p>
    </>}
    {flag.isPending && <p role="status">Saving Imagine demo flag...</p>}
    {error && <p role="alert" className="kh-design-work__error">{error}</p>}
  </section>;
};
