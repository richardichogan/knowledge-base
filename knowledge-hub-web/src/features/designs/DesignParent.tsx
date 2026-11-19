import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { extractNoteBlockText, fetchNote, type NoteContentBlock } from '../../notes/noteStorage';
import { athenaLinkText, prepareEntityLinkExport } from '../../notes/linkLabels';
import { deferredView } from '../../utils/deferredView';
import { setDesignChatBridge } from '../../utils/activeBlockNoteEditor';
import { useAthenaContext } from '../../context/AthenaContext';
import type { NoteDocument } from '../../notes/types';
import type { DesignRole, SpecificationType } from '../../types/designs';
import { resolveDesignTab } from './designSections';
import { DesignVisual } from './DesignVisual';
import { DesignHandoff } from './DesignHandoff';
import { DesignConsistency } from './DesignConsistency';
import { DesignReadiness } from './DesignReadiness';
import { ImagineHarness } from './ImagineHarness';
import { DesignWorkflow } from './DesignWorkflow';
import { rememberAgentJob, useAgentJobFinished, useAgentJobs } from '../../services/agentJobStore';
import type { AgentJob } from '../../types/agentJobs';
import { AthenaRibbon } from '../../components/athena/AthenaRibbon';
import { requestCompletionNotifications } from '../../chat/completionNotification';
import { confirmDialog } from '../../services/appDialogs';
import { passageNavigationSnapshot, subscribePassageNavigation } from '../../notes/passageNavigation';

const NoteEditor = deferredView('Design document', async () => ({ default: (await import('../../notes/NoteEditor')).NoteEditor }));
const DiagramEditor = deferredView('Design diagram', async () => ({ default: (await import('../diagram/DiagramEditor')).DiagramEditor }));
const DOCUMENT_TABS = [{ role: 'use_case', label: 'Use case' }, { role: 'spec', label: 'Spec' },
  { role: 'architecture', label: 'Architecture' }, { role: 'diagram', label: 'Diagram' }, { role: 'workforce', label: 'Workforce' }] as const;
const TABS = [{ role: 'use_case', label: 'Use case' }, { role: 'spec', label: 'Spec' },
  { role: 'architecture', label: 'Architecture' }, { role: 'diagram', label: 'Diagram' },
  { role: 'blueprint', label: 'Blueprint' }, { role: 'build', label: 'Build' }] as const;
const AUXILIARY_SECTIONS = [{ role: 'workforce', label: 'Workforce design' }, { role: 'verify', label: 'Verify & Accept' }] as const;
type Tab = typeof TABS[number]['role'] | typeof AUXILIARY_SECTIONS[number]['role'];
const isTab = (value: string | null): value is Tab => [...TABS, ...AUXILIARY_SECTIONS].some(tab => tab.role === value);
type DocumentTab = Exclude<DesignRole, 'reference'>;
const isDocumentTab = (value: Tab): value is DocumentTab => DOCUMENT_TABS.some(item => item.role === value);
const documentRole = (value: Tab): DocumentTab => isDocumentTab(value) ? value : 'spec';

export const DesignParent: React.FC<{
  id: string; actionsSlot: HTMLElement | null; workspaceBusy?: boolean; onOpenNote: (id: string) => void; onOpenMap: (id: string) => void;
}> = ({ id, actionsSlot, workspaceBusy = false, onOpenNote, onOpenMap }) => {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const initialTab = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : 'use_case');
  const [targetId, setTargetId] = useState<string | null>(params.get('asset'));
  const [handoff, setHandoff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [specStarting, setSpecStarting] = useState(false);
  const requestedSpecJob = useRef<string | null>(null);
  const [visualBusy, setVisualBusy] = useState(false);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [harnessBusy, setHarnessBusy] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const workflowDirty = useRef(false);
  const workflowBusyChange = useCallback((value: boolean) => { setWorkflowBusy(value); }, []);
  const workflowDirtyChange = useCallback((value: boolean) => { workflowDirty.current = value; }, []);
  const harnessBusyChange = useCallback((value: boolean) => { setHarnessBusy(value); }, []);
  const readinessBusyChange = useCallback((value: boolean) => { setReadinessBusy(value); }, []);
  const [visualStatus, setVisualStatus] = useState<string | undefined>();
  const visualBusyChange = useCallback((value: boolean, status?: string) => { setVisualBusy(value); setVisualStatus(status); }, []);
  const [chatBusy, setChatBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const chatBusyRef = useRef(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const noteSave = useRef<(() => Promise<boolean>) | null>(null);
  const diagramSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((save: (() => Promise<boolean>) | null) => { noteSave.current = save; }, []);
  const registerDiagramSave = useCallback((save: (() => Promise<boolean>) | null) => { diagramSave.current = save; }, []);
  const uid = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const passageRequest = useSyncExternalStore(subscribePassageNavigation, passageNavigationSnapshot);
  const passageSwitch = useRef(0);
  const query = useQuery({ queryKey: ['design', id], queryFn: async () => requireApiData(await api.getDesign(id)) });
  const design = query.data;
  const workforceDefinition = design?.imagineScope === 'workforce-definition';
  const stageLabel = (role: Tab, label: string): string => workforceDefinition
    ? role === 'spec' ? 'Workforce Spec' : role === 'build' ? 'Create Imagine Workforce Blueprint' : label : label;
  const tabs = (design?.imagineDemo || workforceDefinition ? TABS : DOCUMENT_TABS.filter(item => item.role !== 'workforce'))
    .map(item => ({ ...item, label: stageLabel(item.role, item.label) }));
  const tabLabel = stageLabel(tab, [...TABS, ...AUXILIARY_SECTIONS].find(item => item.role === tab)!.label);
  const mainTab = tabs.some(item => item.role === tab);
  useEffect(() => {
    if (design && !design.imagineDemo && !workforceDefinition && (!isDocumentTab(tab) || tab === 'workforce')) {
      setTab('use_case'); setTargetId(null);
      setParams({ design: id, tab: 'use_case' }, { replace: true });
    }
  }, [design, workforceDefinition, tab, id, setParams]);
  const { active: job, jobs: liveJobs } = useAgentJobs(design?.id);
  const history = useQuery({ queryKey: ['design-agent-jobs', id], enabled: !!design,
    queryFn: async () => requireApiData(await api.listDesignAgentJobs(design!.id)) });
  const latestJob = job ?? [...new Map([...(history.data ?? []), ...liveJobs].map(item => [item.id, item])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const specBusy = job?.specialist === 'spec-writer';
  const busy = visualBusy || readinessBusy || harnessBusy || workflowBusy || chatBusy || workspaceBusy || specStarting || !!job;
  const sectionRole = documentRole(tab);
  const { assets, asset, noteId } = resolveDesignTab(design, sectionRole, isDocumentTab(tab) ? targetId : null);
  // Empty sections use the parent only for the existing properties/shell, never as their editable body.
  const documentId = noteId ?? design?.parentNoteId;
  const document = useQuery({
    queryKey: ['design-document', documentId, editorEpoch],
    queryFn: async () => { const doc = await fetchNote(documentId!); if (!doc) throw new Error('The document is unavailable.'); return doc; },
    enabled: !!documentId, refetchOnWindowFocus: false, staleTime: 30_000,
  });
  const { setAthenaContext } = useAthenaContext();
  useEffect(() => {
    if (!document.data || !design) return;
    if (!isDocumentTab(tab)) {
      setAthenaContext({ type: 'note', id: noteId ?? design.parentNoteId, conversationId: design.parentNoteId,
        designId: design.id, designTab: tab, title: design.title,
        detail: workforceDefinition
          ? `${tabLabel} stage. Scope: workforce definition only. The final output is a saved, undeployed Imagine workforce blueprint, not a software build. Read read_design_workflow and read_design_package for actual saved scope and definitions. The Think Blueprint is a review artifact, not proof of Imagine persistence. Do not execute agents/evals, deploy, publish, provision resources, generate synthetic datasets or create demos.`
          : `${tabLabel} stage. Read read_design_workflow for actual saved workflow/build state, read_design_blueprint for the Blueprint, and read_design_acceptance for the actual GitHub phase report. Reported gate results are not independent runtime/identity verification or authorization to perform live actions.`,
        ...(design.projectId ? { projectId: design.projectId } : {}) });
      return;
    }
    if (asset?.available && asset.sourceType === 'canvas') return;
    if (!noteId) {
      setAthenaContext({ type: 'note', id: design.parentNoteId, conversationId: design.parentNoteId,
        designId: design.id, designTab: tab, title: design.title,
        detail: `${tabLabel} has no open document. ${assets.length ? 'Its existing document must be selected or restored.' : 'This section is empty; it is not the Use case text. Create this section only when requested.'} Read read_design_package for the actual saved sections.`,
        ...(design.projectId ? { projectId: design.projectId } : {}) });
      return;
    }
    const note = document.data;
    const blocks: unknown = JSON.parse(note.contentJson);
    if (!Array.isArray(blocks)) return;
    let cancelled = false;
    const publish = (): void => {
      setAthenaContext({ type: 'note', id: note.id, conversationId: design.parentNoteId,
        designId: design.id, designTab: tab, ...(note.revision !== undefined ? { revision: note.revision } : {}),
        title: note.title, detail: `${workforceDefinition ? 'Scope: workforce definition only. Existing full-demo documents are retained history, not authority to execute, deploy or create a demo. Final output: an undeployed Imagine workforce blueprint. ' : ''}${extractNoteBlockText(blocks as NoteContentBlock[], athenaLinkText)}`,
        ...(note.projectId ? { projectId: note.projectId } : {}) });
    };
    publish();
    void prepareEntityLinkExport(blocks).then(() => { if (!cancelled) publish(); }).catch(() => { /* links stay as ids */ });
    return () => { cancelled = true; };
  }, [document.data, design, tab, tabLabel, workforceDefinition, noteId, asset, assets.length, setAthenaContext]);
  useEffect(() => () => { setAthenaContext(null); }, [setAthenaContext]);
  const prepareEditors = useCallback(async (): Promise<void> => {
    if (noteSave.current && !await noteSave.current()) throw new Error('The document could not be saved. Your draft remains available; retry before continuing.');
    if (diagramSave.current && !await diagramSave.current()) throw new Error('The diagram could not be saved. Retry before continuing.');
  }, []);
  const prepare = useCallback(async (): Promise<void> => {
    if (workflowDirty.current) throw new Error('Save or discard the edited report link before leaving this stage or asking Athena to change the Design.');
    await prepareEditors();
  }, [prepareEditors]);
  const refresh = useCallback(async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['design-collaboration', id] });
    await qc.invalidateQueries({ queryKey: ['notes-list'] });
    await qc.invalidateQueries({ queryKey: ['imagine-harness'] });
  }, [id, qc]);
  useEffect(() => {
    if (!design) return;
    return setDesignChatBridge(design.parentNoteId, async () => {
      if (visualBusy || readinessBusy || harnessBusy || workflowBusy || chatBusyRef.current) throw new Error('Finish the current Design operation before sending another request.');
      chatBusyRef.current = true;
      setChatBusy(true);
      try { await prepare(); }
      catch (err) { chatBusyRef.current = false; setChatBusy(false); throw err; }
      return async changed => {
        try {
          if (changed) {
            await Promise.all([
              qc.invalidateQueries({ queryKey: ['design', id] }),
              qc.invalidateQueries({ queryKey: ['design-document'] }),
              qc.invalidateQueries({ queryKey: ['design-readiness', id] }),
              qc.invalidateQueries({ queryKey: ['imagine-harness', design.id] }),
              qc.invalidateQueries({ queryKey: ['design-builds', design.id] }),
              qc.invalidateQueries({ queryKey: ['imagine-blueprint', design.id] }),
              qc.invalidateQueries({ queryKey: ['design-acceptance', design.id] }),
              refresh(),
            ]);
          }
        } catch (err) { setError(describeApiError(err)); }
        finally { chatBusyRef.current = false; setChatBusy(false); }
      };
    });
  }, [design, id, prepare, qc, refresh, visualBusy, readinessBusy, harnessBusy, workflowBusy]);
  const switchTo = async (nextTab: Tab, sourceId: string | null = null): Promise<void> => {
    if (switching || busy || (nextTab === tab && sourceId === targetId)) return;
    setSwitching(true); setError(null);
    try {
      await prepare();
      const nextDocumentId = resolveDesignTab(design, documentRole(nextTab), isDocumentTab(nextTab) ? sourceId : null).noteId ?? design?.parentNoteId;
      if (nextDocumentId && nextDocumentId !== documentId) {
        await qc.fetchQuery({
          queryKey: ['design-document', nextDocumentId, editorEpoch],
          queryFn: async () => {
            const doc = await fetchNote(nextDocumentId);
            if (!doc) throw new Error('The document is unavailable.');
            return doc;
          },
          staleTime: 30_000,
        });
      }
      setTab(nextTab); setTargetId(sourceId);
      setParams({ design: id, tab: nextTab, ...(sourceId ? { asset: sourceId } : {}) }, { replace: true });
    } catch (err) { setError(describeApiError(err)); }
    finally { setSwitching(false); }
  };
  const startSection = async (role: Tab): Promise<void> => {
    if (busy || switching || !design || !isDocumentTab(role) || role === 'workforce') return;
    setSwitching(true); setError(null);
    try {
      await prepare();
      const updated = requireApiData(await api.createDesignSection(id, role, design.revision));
      qc.setQueryData(['design', id], updated);
      setTargetId(null);
      setParams({ design: id, tab: role }, { replace: true });
      await refresh();
    } catch (err) { setError(describeApiError(err)); }
    finally { setSwitching(false); }
  };
  useEffect(() => {
    if (!design || !passageRequest || passageSwitch.current === passageRequest.sequence || busy || switching) return;
    const requestedTab = params.get('tab');
    const requestedAsset = params.get('asset');
    if (params.get('design') !== id || !isTab(requestedTab) || requestedAsset !== passageRequest.noteId) return;
    passageSwitch.current = passageRequest.sequence;
    if (tab !== requestedTab || targetId !== requestedAsset) void switchTo(requestedTab, requestedAsset);
    // switchTo operates on the current render's editor and save state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, passageRequest, busy, switching, params, id, tab, targetId]);
  const selection = useMutation({
    mutationFn: async (sourceId: string) => {
      await prepare();
      return requireApiData(await api.selectDesignAsset(id, sectionRole, sourceId, design!.revision));
    },
    onSuccess: async updated => { qc.setQueryData(['design', id], updated); await refresh(); },
  });
  const specificationType = useMutation({
    mutationFn: async (type: SpecificationType) => {
      await prepare();
      return requireApiData(await api.setDesignSpecificationType(id, type, design!.revision));
    },
    onMutate: () => { setError(null); },
    onSuccess: async updated => {
      qc.setQueryData(['design', id], updated);
      await qc.invalidateQueries({ queryKey: ['imagine-harness'] });
    },
    onError: err => { setError(describeApiError(err)); },
  });
  useEffect(() => {
    if (!job) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [job]);
  // A specialist finished on this Design: show what it wrote.
  const finished = useCallback((done: AgentJob): void => {
    void Promise.all([qc.invalidateQueries({ queryKey: ['design', id] }), qc.invalidateQueries({ queryKey: ['design-document'] }),
      qc.invalidateQueries({ queryKey: ['design-agent-jobs', id] }), qc.invalidateQueries({ queryKey: ['imagine-harness'] }),
      qc.invalidateQueries({ queryKey: ['design-readiness', id] }), refresh()])
      .then(() => {
        if (done.status === 'done') {
          setEditorEpoch(value => value + 1);
          if (requestedSpecJob.current === done.id) {
            setTab('spec'); setTargetId(null);
            setParams({ design: id, tab: 'spec' }, { replace: true });
          }
        }
        if (requestedSpecJob.current === done.id) requestedSpecJob.current = null;
      })
      .catch((err: unknown) => { setError(describeApiError(err)); });
  }, [id, qc, refresh, setParams]);
  useAgentJobFinished(design?.id, finished);
  // Athena hands the spec to the Spec writer and carries on; the Design stays locked until it reports back.
  const spec = useMutation({
    mutationFn: async () => {
      if (!design?.specificationType) throw new Error('Choose Standard or IMAGINE before generating a spec.');
      await prepare();
      const current = requireApiData(await api.getDesign(id));
      qc.setQueryData(['design', id], current);
      const currentSpec = resolveDesignTab(current, 'spec', null).asset;
      const currentArchitecture = current.specificationType === 'imagine' ? resolveDesignTab(current, 'architecture', null).asset : undefined;
      const replacesSpec = currentSpec?.available && currentSpec.hasContent !== false;
      const replacesArchitecture = currentArchitecture?.available && currentArchitecture.hasContent !== false;
      if (current.imagineScope !== 'workforce-definition' && (replacesSpec || replacesArchitecture)
        && !await confirmDialog(current.specificationType === 'imagine'
          ? 'Athena will generate the Spec and recommended Architecture together from this use case and actual IMAGINE base references. Existing writing, images or files in either document will be replaced; earlier versions stay in note history. Neither document changes unless both finish successfully.'
          : 'Athena will replace the current spec with a new one written from this use case. Any edits, images or files in the spec will be overwritten. Earlier versions stay in note history.',
        { title: current.specificationType === 'imagine' ? 'Regenerate Spec and Architecture?' : 'Regenerate the spec?', confirmLabel: 'Continue', tone: 'danger' })) return;
      const result = requireApiData(await api.handOffToSpecialist('spec-writer', design!.id, {}, true));
      if (result.status === 'needs_confirmation') throw new Error(result.message);
      requestedSpecJob.current = result.job.id;
      rememberAgentJob(result.job);
    },
    onMutate: () => { requestCompletionNotifications(); setError(null); setSpecStarting(true); },
    onError: err => { setError(describeApiError(err)); },
    onSettled: () => { setSpecStarting(false); },
  });
  const jobSeconds = job ? Math.max(0, Math.round((now - Date.parse(job.startedAt ?? job.createdAt)) / 1000)) : 0;
  const jobStep = job?.progress[job.progress.length - 1];
  const authoritativeSpec = resolveDesignTab(design, 'spec', null).asset;
  const hasSpec = !!authoritativeSpec?.available && authoritativeSpec.hasContent !== false;
  // Every lock says why, so the Design never looks frozen.
  const lockReason = job ? (specBusy && tab === 'use_case' ? null
    : `${job.specialistName} ${job.status === 'running' ? `is working · ${jobSeconds}s${jobStep ? ` · ${jobStep}` : ''}` : 'is waiting to start'}. Editing unlocks when it finishes, and you'll be notified.`)
    : specStarting ? 'Saving the use case and handing it to the Spec writer...'
    : harnessBusy ? 'Saving or checking the Imagine harness. Editing unlocks when it finishes.'
    : readinessBusy ? 'Athena is checking readiness or preparing a repair. Editing unlocks when it finishes.'
    : visualBusy ? `${visualStatus ?? 'Athena is working on the Blueprint'}. Editing unlocks when it finishes, and you'll be notified.`
      : chatBusy ? 'Athena is working on this Design in the chat. Editing unlocks when the reply finishes.'
        : workspaceBusy ? 'Opening the note…' : switching ? 'Saving and switching documents…' : null;
  const startSpec = async (): Promise<void> => {
    if (busy || switching || !design?.specificationType || specificationType.isPending || spec.isPending) return;
    spec.mutate();
  };
  const useCases = design?.assets.filter(item => item.role === 'use_case' && item.available && item.sourceType === 'note' && item.hasContent !== false) ?? [];
  const hasUseCase = useCases.length === 1 || useCases.some(item => item.sourceId === design?.selections.use_case);
  const specDisabled = busy || switching || spec.isPending || specificationType.isPending || !design?.specificationType || !hasUseCase
    || !!design.imagineDemo && design.specificationType !== 'imagine';
  const designPanel = <div className="kh-design-work">
    <section aria-label="Design actions">
      <h3>Actions</h3>
      <label className="kh-design-spec-action__type">
        <span>Specification type</span>
        <select value={design?.specificationType ?? ''} disabled={busy || switching || spec.isPending || specificationType.isPending}
          onChange={event => {
            const value = event.target.value;
            if (value === 'standard' || value === 'imagine') specificationType.mutate(value);
          }}>
          <option value="" disabled>Choose a type</option>
          <option value="standard" disabled={workforceDefinition}>Standard</option>
          <option value="imagine">IMAGINE</option>
        </select>
      </label>
      {specificationType.isPending && <span className="kh-design-spec-action__saving" role="status">Saving type...</span>}
      <button type="button" className="kh-btn-accent" disabled={specDisabled} onClick={() => { void startSpec(); }}>
        {specStarting ? 'Starting Spec writer...' : specBusy ? 'The Spec writer is working…' : workforceDefinition ? 'Create Workforce Spec & Architecture'
          : design?.specificationType === 'imagine' ? hasSpec ? 'Regenerate Spec & Architecture' : 'Generate Spec & Architecture'
          : hasSpec ? 'Regenerate spec from use case' : 'Generate spec with Athena'}</button>
      <p>{!hasUseCase ? 'Open the Use case tab and write the use case before generating a spec.'
        : !design?.specificationType ? 'Choose a specification type. The choice is saved on this Design.'
          : workforceDefinition ? 'Creates a new definition-only Workforce Spec and recommended Architecture. Earlier documents remain intact. Stops before execution, deployment, synthetic data and demo creation.'
            : design.specificationType === 'imagine' ? 'Writes Spec and recommended Architecture from the use case and actual IMAGINE base sources. Both save together; existing writing is preserved until both are ready.'
            : 'Uses the selected use case. The existing spec stays intact until the new version is ready.'}</p>
      {error && <p role="alert" className="kh-design-work__error">{error}</p>}
    </section>
    {design && <ImagineHarness design={design} busy={busy || switching || specificationType.isPending || spec.isPending}
      prepare={prepare} showSpec={() => switchTo('spec', design.selections.spec ?? null)} onBusyChange={harnessBusyChange} onChanged={updated => {
        qc.setQueryData(['design', id], updated);
        void refresh();
      }} />}
    {tab === 'spec' && design?.specificationType === 'imagine' && <DesignReadiness key={`readiness:${id}`} id={id}
      specId={asset?.sourceId} currentSpecId={design.selections.spec ?? (assets.length === 1 ? assets[0]?.sourceId : undefined)}
      revision={document.data?.revision} designRevision={design.revision} definitionOnly={workforceDefinition} busy={busy || switching}
      prepare={prepare} onBusyChange={readinessBusyChange} onApplied={async () => {
        setEditorEpoch(value => value + 1);
        await Promise.all([qc.invalidateQueries({ queryKey: ['design-document'] }), refresh()]);
      }} />}
    {!workforceDefinition && <DesignConsistency key={`consistency:${id}`} id={id} busy={busy || switching} prepare={prepare} />}
    <section aria-label="Design activity">
      <h3>Activity</h3>
      {specStarting && !job ? <p role="status">Saving the use case and starting the Spec writer...</p> : job ? <div role="status" className="kh-design-work__activity">
        <AthenaRibbon size={24} mood="thinking" />
        <div><strong>{job.specialistName} · {job.status === 'running' ? `${jobSeconds}s` : 'Queued'}</strong>
          <p>{jobStep ?? 'Waiting to start.'}</p></div>
      </div> : visualBusy || chatBusy ? <p role="status">{visualStatus ?? 'Athena is working on this Design.'}</p>
        : latestJob ? <div>
          <strong>{latestJob.specialistName} · {latestJob.status === 'done' ? 'Completed' : 'Could not finish'}</strong>
          <p className={latestJob.status === 'failed' ? 'kh-design-work__error' : undefined}
            role={latestJob.status === 'failed' ? 'alert' : undefined}>{latestJob.error ?? latestJob.summary}</p>
          {latestJob.status === 'failed' && latestJob.specialist === 'spec-writer' && <>
            <p>{design?.imagineDemo ? 'Check the Spec tab and saved validation state before retrying; generation may have saved the spec before validation failed.' : 'The existing spec was not replaced.'}</p>
            <button type="button" className="kh-btn-ghost" disabled={busy || switching || spec.isPending || specificationType.isPending || !hasUseCase || !design?.specificationType}
              onClick={() => { void startSpec(); }}>Retry Spec writer</button>
          </>}
        </div> : <p>{history.isLoading ? 'Loading activity...' : 'No generation activity yet.'}</p>}
      {history.isError && <p role="alert" className="kh-design-work__error">{describeApiError(history.error)}
        {' '}<button type="button" className="kh-btn-ghost" onClick={() => { void history.refetch(); }}>Reload activity</button></p>}
    </section>
    <section aria-label="Design outputs">
      <h3>Outputs</h3>
      <ul className="kh-design-work__outputs">{DOCUMENT_TABS.filter(item => design?.imagineDemo || item.role !== 'workforce').map(item => {
        const linked = design?.assets.filter(output => output.role === item.role) ?? [];
        return <li key={item.role}><strong>{stageLabel(item.role, item.label)}</strong>
          {!linked.length ? <p>Not written yet</p> : linked.map(output => <button key={output.sourceId} type="button"
            className="kh-design-work__output" disabled={!output.available || busy || switching}
            onClick={() => { void switchTo(item.role, output.sourceId); }}>{output.title}{!output.available ? ' (unavailable)' : ''}</button>)}
        </li>;
      })}</ul>
      <p>Open a document, then use History to see or restore earlier versions.</p>
    </section>
  </div>;
  const saved = (note: NoteDocument): void => {
    qc.setQueryData(['design-document', documentId, editorEpoch], note);
    void qc.invalidateQueries({ queryKey: ['notes-list'] });
    void qc.invalidateQueries({ queryKey: ['design-collaboration', id] });
    void qc.invalidateQueries({ queryKey: ['design-readiness', id] });
    void qc.invalidateQueries({ queryKey: ['imagine-harness'] });
    void qc.invalidateQueries({ queryKey: ['design', id] });
    if (note.id === design?.parentNoteId) {
      if (note.contentType !== 'design') onOpenNote(note.id);
    }
  };
  if (query.isLoading) return <p className="kh-design-loading" role="status">Loading Design...</p>;
  if (!design) return <p className="kh-design-loading kh-uc-error" role="alert">{describeApiError(query.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>;
  const visual = <DesignVisual designId={id} subjectId={design.id} imagineDemo={design.imagineDemo} agentJob={job}
    parentNoteId={design.parentNoteId} prepare={prepare} onBusyChange={visualBusyChange} onAccepted={async () => {
      setEditorEpoch(value => value + 1); await refresh();
    }} />;
  const chrome = <div className="kh-design-chrome">
    <div className="kh-design-tabs" role="tablist" aria-label="Design documents" ref={tabsRef} onKeyDown={event => {
      const index = Math.max(0, tabs.findIndex(item => item.role === tab));
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); void switchTo(tabs[next]!.role);
      tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{tabs.map(item => <button key={item.role} type="button" role="tab" id={`${uid}-${item.role}`} aria-selected={tab === item.role}
      aria-controls={`${uid}-document`} tabIndex={tab === item.role || !mainTab && item.role === 'use_case' ? 0 : -1} disabled={switching || busy}
      onClick={() => { void switchTo(item.role); }}>{item.label}</button>)}</div>
    <div className="kh-design-links">
      {isDocumentTab(tab) && assets.length > 1 && <label className="kh-uc-field"><span className="kh-uc-field__label">Linked version</span>
        <select className="kh-uc-input" value={asset?.sourceId ?? ''} disabled={switching || busy} onChange={event => { void switchTo(tab, event.target.value); }}>
          <option value="" disabled>Choose a document</option>
          {assets.map(item => <option key={item.sourceId} value={item.sourceId}>{item.title}{design.selections[sectionRole] === item.sourceId ? ' (selected for handoff)' : ''}</option>)}
        </select></label>}
      {isDocumentTab(tab) && asset && assets.length > 1 && design.selections[sectionRole] !== asset.sourceId && <button type="button" className="kh-btn-ghost" disabled={busy || selection.isPending || !asset.available}
        onClick={() => { selection.mutate(asset.sourceId); }}>Use this version for visuals and handoff</button>}
    </div>
    {lockReason && <p className="kh-design-hint kh-design-hint--busy" role="status"><AthenaRibbon size={20} mood="thinking" />{lockReason}</p>}
    {error && !spec.isError && !specificationType.isError && <p role="alert" className="kh-uc-error">{error}</p>}
    {selection.isError && <p role="alert" className="kh-uc-error">{describeApiError(selection.error)}</p>}
    {isDocumentTab(tab) && !asset && assets.length > 0 && <p className="kh-design-hint">Choose an existing version; no other section has been substituted.</p>}
    {isDocumentTab(tab) && asset && !asset.available && <p className="kh-uc-error" role="alert">The linked document is unavailable or archived. Its original has not been replaced.</p>}
  </div>;
  return <div className="kh-design-parent" role={mainTab ? 'tabpanel' : 'region'} id={`${uid}-document`}
    aria-labelledby={mainTab ? `${uid}-${tab}` : undefined} aria-label={mainTab ? undefined : tabLabel}>
    {!document.data ? <>{chrome}<p className="kh-design-loading" role={document.isError ? 'alert' : 'status'}>
      {document.isError ? describeApiError(document.error) : 'Loading original document...'}
      {document.isError && <button className="kh-btn-ghost" type="button" onClick={() => { void document.refetch(); }}>Retry</button>}</p></>
      : <NoteEditor key={`${tab}:${document.data.id}:${editorEpoch}`} doc={document.data} onSaved={saved} actionsSlot={actionsSlot} externalBusy={busy || switching} loading={switching}
        hideProperties={asset?.sourceType === 'canvas' && asset.available}
        htmlViewEnabled={tab === 'spec' && !!noteId && !design.imagineDemo && !workforceDefinition}
        onOpenMap={onOpenMap} onSaveReady={registerSave} onBeforeViewChange={prepare} headerContent={chrome} designPanel={designPanel}
        actionContent={workforceDefinition ? undefined : <li role="menuitem"><button type="button" className="kb-menu__item" onClick={() => { setHandoff(true); }}>Copilot package...</button></li>}
        bodyContent={tab === 'blueprint' ? <div className="kh-design-visual-host">{visual}</div> : tab === 'build' || tab === 'verify' ? <DesignWorkflow key={`${design.id}:${tab}`}
          stage={tab} design={design} busy={busy || switching} prepare={prepareEditors}
          onHandoff={() => { setHandoff(true); }} onDirtyChange={workflowDirtyChange} onBusyChange={workflowBusyChange}
          onChanged={updated => { qc.setQueryData(['design', id], updated); void refresh(); }} />
          : asset?.available && asset.sourceType === 'canvas' ? <div className="kh-design-diagram-body">
          <DiagramEditor canvasId={asset.sourceId} designPanel={designPanel} parentContext={{ type: 'note', id: design.parentNoteId, title: design.title,
            designId: design.id, designTab: tab }}
            onSaveReady={registerDiagramSave} onOpenNote={onOpenNote} onDeleted={() => { void query.refetch(); }} /></div>
          : !noteId ? <section className="kh-design-diagram-empty" aria-label={`${tabLabel} content`}>
            <h3>{tabLabel}{asset ? ' unavailable' : assets.length ? ': choose a version' : ' is empty'}</h3>
            <p>{asset ? 'The original is unavailable or archived. No other section has been substituted.'
              : assets.length ? 'Select an existing version above to open its own content.'
                : tab === 'use_case' ? 'Start writing the use case here. Existing specification content stays in the Spec tab.'
                  : tab === 'spec' ? !hasUseCase ? 'Write the Use case first, then generate its specification here.'
                    : !design.specificationType ? 'Choose a specification type in Design actions, then generate the spec from your saved use case.'
                      : 'Generate the spec directly from your use case. Athena saves the result here; no blank document is needed first.'
                  : tab === 'workforce' ? 'Generate the workforce from the validated, approved specification using Design actions.'
                    : tab === 'diagram' ? 'Start a separate diagram canvas for this Design.'
                      : 'Start the architecture document here, or ask Athena to write this section.'}</p>
            {!assets.length && tab === 'spec' ? <div className="kh-design-actions">
              <button type="button" className="kh-btn-accent" disabled={specDisabled} onClick={() => { void startSpec(); }}>
                {specStarting ? 'Starting Spec writer...' : specBusy ? 'The Spec writer is working...'
                  : workforceDefinition ? 'Create Workforce Spec & Architecture'
                    : design.specificationType === 'imagine' ? 'Generate Spec & Architecture' : 'Generate spec from use case'}</button>
              <button type="button" className="kh-btn-ghost" disabled={busy || switching} onClick={() => { void startSection('spec'); }}>
                {switching ? 'Starting...' : 'Start writing manually'}</button>
            </div> : !assets.length && tab !== 'workforce' &&
              <button type="button" className="kh-btn-accent" disabled={busy || switching} onClick={() => { void startSection(tab); }}>
                {switching ? 'Starting...' : `Start ${tabLabel.toLowerCase()}`}</button>}
          </section> : undefined}
        visualContent={tab === 'spec' && !design.imagineDemo && !workforceDefinition ? visual : undefined} />}
    {handoff && <DesignHandoff design={design} prepare={prepare} onClose={() => { setHandoff(false); }} />}
  </div>;
};
