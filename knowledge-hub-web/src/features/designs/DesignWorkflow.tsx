import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { confirmDialog } from '../../services/appDialogs';
import { acquireImagineIdToken } from '../../services/imagineAuth';
import type { DesignDetail } from '../../types/designs';

export const DesignWorkflow: React.FC<{
  stage: 'build' | 'verify'; design: DesignDetail; busy: boolean; prepare: () => Promise<void>;
  onHandoff: () => void; onChanged: (design: DesignDetail) => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}> = ({ stage, design, busy, prepare, onHandoff, onChanged, onDirtyChange, onBusyChange }) => {
  const definitionOnly = design.imagineScope === 'workforce-definition';
  const savedSource = design.selections.reference ?? '';
  const [url, setUrl] = useState(savedSource);
  const previousSource = useRef(savedSource);
  useEffect(() => {
    const previous = previousSource.current;
    setUrl(current => current === previous ? savedSource : current);
    previousSource.current = savedSource;
  }, [savedSource]);
  const dirty = url !== savedSource;
  useEffect(() => { onDirtyChange(dirty); return () => { onDirtyChange(false); }; }, [dirty, onDirtyChange]);
  const builds = useQuery({ queryKey: ['design-builds', design.id], enabled: stage === 'build' && !definitionOnly,
    queryFn: async () => requireApiData(await api.getDesignBuilds(design.id)) });
  const evidence = useQuery({ queryKey: ['design-acceptance', design.id, savedSource], enabled: stage === 'verify' && !!savedSource,
    queryFn: async () => requireApiData(await api.getDesignAcceptance(design.id)), retry: false });
  const save = useMutation({
    mutationFn: async () => { await prepare(); return requireApiData(await api.setDesignAcceptanceSource(design.id, url.trim(), design.revision)); },
    onSuccess: updated => { setUrl(updated.selections.reference ?? ''); onChanged(updated); },
  });
  const creation = useQuery({ queryKey: ['imagine-blueprint', design.id, design.revision], enabled: definitionOnly && stage === 'build',
    queryFn: async () => requireApiData(await api.getImagineCreation(design.id)), retry: false });
  const connect = useMutation({ mutationFn: async () => api.connectImagine(design.id, await acquireImagineIdToken()),
    onSuccess: async () => { await creation.refetch(); } });
  const create = useMutation({ mutationFn: async () => {
    await prepare();
    const binding = creation.data?.binding ?? requireApiData(await api.prepareImagineCreation(design.id, design.revision)).binding;
    if (!binding) throw new Error('The reviewed definition changed. Refresh the final stage before continuing.');
    if (!await confirmDialog(`Save the reviewed “${design.title}” workforce definition in Imagine? No agents or evaluations will run.`,
      { title: 'Create Imagine workforce blueprint?', confirmLabel: 'Create blueprint' })) return;
    requireApiData(await api.createImagineBlueprint(design.id, design.revision, binding));
  }, onSettled: async () => { await creation.refetch(); } });
  const working = save.isPending || create.isPending || connect.isPending;
  useEffect(() => { onBusyChange(working); return () => { onBusyChange(false); }; }, [working, onBusyChange]);
  const current = evidence.isError ? undefined : evidence.data;
  const report = current?.report;
  const source = current?.source;
  return <section className="kh-design-workflow" aria-label={stage === 'build'
    ? definitionOnly ? 'Create Imagine Workforce Blueprint' : 'Design Build handoff' : 'Verify and accept repository evidence'}>
    {stage === 'build' && definitionOnly ? <>
      <h3>Create Imagine Workforce Blueprint</h3>
      <p>Save the reviewed workforce in Imagine. Its members, handoffs, governance rules and evaluation definitions stay undeployed.</p>
      {creation.isLoading && <p role="status">Checking the reviewed definition and saved records…</p>}
      {creation.isError ? <p role="alert" className="kh-uc-error">{describeApiError(creation.error)}{' '}
        <button type="button" className="kh-btn-ghost" onClick={() => { void creation.refetch(); }}>Retry</button></p> : creation.data && <>
        <p className="kh-design-workflow__boundary" role="status">{create.isPending ? 'Saving and verifying the workforce in Imagine…' : creation.data.detail}</p>
        {(creation.data.savedAgentCount > 0 || creation.data.savedEvalCount > 0) && <p>Saved digital members: {creation.data.savedAgentCount}. Evaluation definitions: {creation.data.savedEvalCount}.</p>}
        {creation.data.state === 'verified' && creation.data.workforceUrl
          ? <a className="kh-uc-link" href={creation.data.workforceUrl} target="_blank" rel="noreferrer">Open workforce in Imagine</a>
          : <div className="kh-design-actions">
            {!creation.data.connected && creation.data.canCreate
              ? <button type="button" className="kh-btn-accent" disabled={busy || working} onClick={() => { connect.mutate(); }}>
                {connect.isPending ? 'Connecting…' : 'Sign in to Imagine'}</button>
              : <button type="button" className="kh-btn-accent" disabled={busy || working || !creation.data.canCreate || !creation.data.connected}
                onClick={() => { create.mutate(); }}>{create.isPending ? 'Saving…' : creation.data.state === 'partial' ? 'Resume creation' : 'Create Imagine Workforce Blueprint'}</button>}
          </div>}
      </>}
      {(connect.isError || create.isError) && <p role="alert" className="kh-uc-error">{describeApiError(connect.error ?? create.error)}</p>}
    </> : stage === 'build' ? <>
      <h3>Build</h3>
      <p>Prepare and review one immutable package containing the use case, spec, workforce design, architecture, optional diagram and Blueprint.
        Publish that exact snapshot through the existing confirmation, then create its Build draft. Creating the draft does not start agents or deploy anything.</p>
      <div className="kh-design-actions"><button type="button" className="kh-btn-accent" disabled={busy} onClick={onHandoff}>Prepare Build handoff</button></div>
      <h3>Latest 20 Builds from this Design’s specifications</h3>
      {builds.isLoading && <p role="status">Loading linked Builds...</p>}
      {builds.isError && <p className="kh-uc-error" role="alert">{describeApiError(builds.error)}{' '}
        <button type="button" className="kh-btn-ghost" onClick={() => { void builds.refetch(); }}>Retry</button></p>}
      {builds.data?.length === 0 && <p>No Build draft has been created from these specifications.</p>}
      {!!builds.data?.length && <ul className="kh-design-workflow__builds">{builds.data.map(build => <li key={build.id}>
        <Link className="kh-uc-link" to={`/build?spec=${encodeURIComponent(build.id)}`}>{build.title}</Link>
        <span>{build.repo} · {build.status}</span>
      </li>)}</ul>}
      <p>Build task completion is not IMAGINE acceptance. Keep live/simulated fidelity and requirement-to-evidence traceability explicit.</p>
    </> : <>
      <h3>Verify &amp; Accept</h3>
      <p>Read the demo repository’s existing G0–G7 phase report and its evidence references. This view does not run another evaluator or record human approval.</p>
      <label className="kh-uc-field"><span className="kh-uc-field__label">GitHub phase-report JSON file</span>
        <input className="kh-uc-input" type="url" maxLength={2048} value={url} disabled={busy || save.isPending}
          placeholder="https://github.com/owner/repo/blob/ref/path.json" onChange={event => { setUrl(event.target.value); }} /></label>
      <p className="kh-design-hint">Use a configured workstream repository. Accepts a version-1 PhaseAcceptanceReport or a BuildStatus export containing acceptance.report.</p>
      <div className="kh-design-actions">
        <button type="button" className="kh-btn-accent" disabled={busy || save.isPending || !url.trim() || !dirty}
          onClick={() => { save.mutate(); }}>{save.isPending ? 'Saving report link...' : 'Save report link'}</button>
        {dirty && <button type="button" className="kh-btn-ghost" disabled={busy || save.isPending} onClick={() => { setUrl(savedSource); }}>Discard link edit</button>}
        {savedSource && <button type="button" className="kh-btn-ghost" disabled={busy || dirty || evidence.isFetching}
          onClick={() => { void evidence.refetch(); }}>{evidence.isFetching ? 'Reading GitHub report...' : 'Refresh report'}</button>}
      </div>
      {dirty && <p role="status">The edited link is not saved. Save or discard it before leaving this stage or asking Athena to change the Design.</p>}
      {save.isError && <p className="kh-uc-error" role="alert">{describeApiError(save.error)}</p>}
      {!savedSource && <p role="status">No repository report linked. Verification and acceptance have not been established here.</p>}
      {evidence.isLoading && <p role="status">Reading the saved GitHub gate report...</p>}
      {evidence.isError && <p className="kh-uc-error" role="alert">{describeApiError(evidence.error)} No current report read is confirmed.</p>}
      <p className="kh-design-workflow__boundary">Repository-reported evidence only. Check that the scenario and candidate below match the intended demo.
        Athena has not independently verified current runtime state, candidate drift or reviewer identity.
        A reported pass does not authorize deployment, messages, evaluations, access changes or downstream writes.</p>
      {report && source && <>
        <h3>Reported scenario: {report.scenario ?? 'Not recorded'}</h3>
        <p><a className="kh-uc-link" href={source.immutableUrl} target="_blank" rel="noreferrer">Read this exact report revision on GitHub</a></p>
        <dl><dt>Report commit</dt><dd><code>{source.commit}</code></dd><dt>Report blob</dt><dd><code>{source.blob}</code></dd>
          <dt>Report binding</dt><dd><code>{report.binding ?? 'Not recorded'}</code></dd>
          <dt>Retrieved</dt><dd>{source.readAt}</dd><dt>Report’s stated evidence basis</dt><dd>{report.evidenceBasis}</dd></dl>
        {report.candidate ? <dl>
          <dt>Candidate commit</dt><dd><code>{report.candidate.commit}</code></dd>
          <dt>Environment</dt><dd>{report.candidate.environment}</dd>
          <dt>Backend revision</dt><dd>{report.candidate.backendRevision}</dd>
          <dt>Frontend artifact</dt><dd>{report.candidate.frontendArtifact}</dd>
          <dt>Configuration fingerprint</dt><dd><code>{report.candidate.configurationFingerprint}</code></dd>
          <dt>Workforce member IDs</dt><dd>{report.candidate.workforceMemberIds.join(', ')}</dd>
          <dt>Agent identities</dt><dd><ul>{report.candidate.agents.map((agent, index) => <li key={index}>
            {agent.catalogueId} · {agent.deploymentId} · <code>{agent.definitionFingerprint}</code></li>)}</ul></dd>
        </dl> : <p>No candidate identity was recorded in this report.</p>}
        {report.phases.map(phase => <details className="kh-design-workflow__phase" key={phase.id}>
          <summary>{phase.title} · Reported: {phase.state}</summary>
          {phase.criteria.length ? <ul>{phase.criteria.map(criterion => <li key={criterion.id}>
            <strong>{criterion.title} · Reported: {criterion.state}</strong>
            {criterion.reasons.map((reason, index) => <p key={`reason:${index}`}>{reason}</p>)}
            {!!criterion.sources.length && <ul aria-label="Reported evidence references">{criterion.sources.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul>}
          </li>)}</ul> : <p>No criterion details recorded in this report.</p>}
        </details>)}
      </>}
    </>}
  </section>;
};
