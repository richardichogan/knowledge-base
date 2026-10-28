import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AppDialog } from '../../components/AppDialog';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { extractNoteBlockText, fetchNote, type NoteContentBlock } from '../../notes/noteStorage';
import { athenaLinkText, prepareEntityLinkExport } from '../../notes/linkLabels';
import { deferredView } from '../../utils/deferredView';
import { setDesignChatBridge } from '../../utils/activeBlockNoteEditor';
import { useAthenaContext } from '../../context/AthenaContext';
import type { NoteDocument } from '../../notes/types';
import type { DesignAsset, DesignDetail, SpecificationType } from '../../types/designs';
import { DesignVisual } from './DesignVisual';
import { DesignHandoff } from './DesignHandoff';
import { DesignConsistency } from './DesignConsistency';
import { rememberAgentJob, useAgentJobFinished, useAgentJobs } from '../../services/agentJobStore';
import type { AgentJob } from '../../types/agentJobs';
import { AthenaRibbon } from '../../components/athena/AthenaRibbon';
import { requestCompletionNotifications } from '../../chat/completionNotification';
import { confirmDialog } from '../../services/appDialogs';
import { passageNavigationSnapshot, subscribePassageNavigation } from '../../notes/passageNavigation';

const NoteEditor = deferredView('Design document', async () => ({ default: (await import('../../notes/NoteEditor')).NoteEditor }));
const DiagramEditor = deferredView('Design diagram', async () => ({ default: (await import('../diagram/DiagramEditor')).DiagramEditor }));
const TABS = [{ role: 'use_case', label: 'Use case' }, { role: 'spec', label: 'Spec' },
  { role: 'architecture', label: 'Architecture' }, { role: 'diagram', label: 'Diagram' }] as const;
type Tab = typeof TABS[number]['role'];
const isTab = (value: string | null): value is Tab => TABS.some(tab => tab.role === value);

export const DesignParent: React.FC<{
  id: string; actionsSlot: HTMLElement | null; workspaceBusy?: boolean; onOpenNote: (id: string) => void; onOpenMap: (id: string) => void;
}> = ({ id, actionsSlot, workspaceBusy = false, onOpenNote, onOpenMap }) => {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const initialTab = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : 'use_case');
  const [targetId, setTargetId] = useState<string | null>(params.get('asset'));
  const [linking, setLinking] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [visualBusy, setVisualBusy] = useState(false);
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
  const { active: job, jobs: liveJobs } = useAgentJobs(design?.id);
  const history = useQuery({ queryKey: ['design-agent-jobs', id], enabled: !!design,
    queryFn: async () => requireApiData(await api.listDesignAgentJobs(design!.id)) });
  const latestJob = job ?? [...new Map([...(history.data ?? []), ...liveJobs].map(item => [item.id, item])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const specBusy = job?.specialist === 'spec-writer';
  const busy = visualBusy || chatBusy || workspaceBusy || !!job;
  const assets = design?.assets.filter(asset => asset.role === tab) ?? [];
  const chosen = targetId && assets.some(item => item.sourceId === targetId) ? targetId : design?.selections[tab];
  const asset = chosen ? assets.find(item => item.sourceId === chosen) : assets.length === 1 ? assets[0] : undefined;
  const documentId = asset?.available && asset.sourceType === 'note' ? asset.sourceId : design?.parentNoteId;
  const document = useQuery({
    queryKey: ['design-document', documentId, editorEpoch],
    queryFn: async () => { const doc = await fetchNote(documentId!); if (!doc) throw new Error('The document is unavailable.'); return doc; },
    enabled: !!documentId, refetchOnWindowFocus: false, staleTime: 30_000,
  });
  const { setAthenaContext } = useAthenaContext();
  useEffect(() => {
    if (!document.data || !design) return;
    const note = document.data;
    const blocks: unknown = JSON.parse(note.contentJson);
    if (!Array.isArray(blocks)) return;
    let cancelled = false;
    const publish = (): void => {
      setAthenaContext({ type: 'note', id: note.id, conversationId: design.parentNoteId,
        title: note.title, detail: extractNoteBlockText(blocks as NoteContentBlock[], athenaLinkText),
        ...(note.projectId ? { projectId: note.projectId } : {}) });
    };
    publish();
    void prepareEntityLinkExport(blocks).then(() => { if (!cancelled) publish(); }).catch(() => { /* links stay as ids */ });
    return () => { cancelled = true; };
  }, [document.data, design, setAthenaContext]);
  useEffect(() => () => { setAthenaContext(null); }, [setAthenaContext]);
  const prepare = useCallback(async (): Promise<void> => {
    if (noteSave.current && !await noteSave.current()) throw new Error('The document could not be saved. Your draft remains available; retry before continuing.');
    if (diagramSave.current && !await diagramSave.current()) throw new Error('The diagram could not be saved. Retry before continuing.');
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['design-collaboration', id] });
    await qc.invalidateQueries({ queryKey: ['notes-list'] });
  }, [id, qc]);
  useEffect(() => {
    if (!design) return;
    return setDesignChatBridge(design.parentNoteId, async () => {
      if (visualBusy || chatBusyRef.current) throw new Error('Finish the current Design operation before sending another request.');
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
              refresh(),
            ]);
          }
        } catch (err) { setError(describeApiError(err)); }
        finally { chatBusyRef.current = false; setChatBusy(false); }
      };
    });
  }, [design, id, prepare, qc, refresh, visualBusy]);
  const switchTo = async (nextTab: Tab, sourceId: string | null = null): Promise<void> => {
    if (switching || busy || (nextTab === tab && sourceId === targetId)) return;
    setSwitching(true); setError(null);
    try {
      await prepare();
      const nextAssets = design?.assets.filter(item => item.role === nextTab) ?? [];
      const nextChosen = sourceId ?? design?.selections[nextTab];
      const nextAsset = nextChosen ? nextAssets.find(item => item.sourceId === nextChosen) : nextAssets.length === 1 ? nextAssets[0] : undefined;
      const nextDocumentId = nextAsset?.available && nextAsset.sourceType === 'note' ? nextAsset.sourceId : design?.parentNoteId;
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
      return requireApiData(await api.selectDesignAsset(id, tab, sourceId, design!.revision));
    },
    onSuccess: async updated => { qc.setQueryData(['design', id], updated); await refresh(); },
  });
  const specificationType = useMutation({
    mutationFn: async (type: SpecificationType) => {
      await prepare();
      return requireApiData(await api.setDesignSpecificationType(id, type, design!.revision));
    },
    onMutate: () => { setError(null); },
    onSuccess: updated => { qc.setQueryData(['design', id], updated); },
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
      qc.invalidateQueries({ queryKey: ['design-agent-jobs', id] }), refresh()])
      .then(() => { if (done.status === 'done') setEditorEpoch(value => value + 1); })
      .catch((err: unknown) => { setError(describeApiError(err)); });
  }, [id, qc, refresh]);
  useAgentJobFinished(design?.id, finished);
  // Athena hands the spec to the Spec writer and carries on; the Design stays locked until it reports back.
  const spec = useMutation({
    mutationFn: async () => {
      if (!design?.specificationType) throw new Error('Choose Standard or IMAGINE before generating a spec.');
      await prepare();
      const result = requireApiData(await api.handOffToSpecialist('spec-writer', design!.id, {}, true));
      if (result.status === 'needs_confirmation') throw new Error(result.message);
      rememberAgentJob(result.job);
    },
    onMutate: () => { requestCompletionNotifications(); setError(null); },
    onError: err => { setError(describeApiError(err)); },
  });
  const jobSeconds = job ? Math.max(0, Math.round((now - Date.parse(job.startedAt ?? job.createdAt)) / 1000)) : 0;
  const jobStep = job?.progress[job.progress.length - 1];
  const hasSpec = !!design?.assets.some(item => item.role === 'spec' && item.available);
  // Every lock says why, so the Design never looks frozen.
  const lockReason = job ? (specBusy && tab === 'use_case' ? null
    : `${job.specialistName} ${job.status === 'running' ? `is working · ${jobSeconds}s${jobStep ? ` · ${jobStep}` : ''}` : 'is waiting to start'}. Editing unlocks when it finishes, and you'll be notified.`)
    : visualBusy ? `${visualStatus ?? 'Athena is working on the Blueprint'}. Editing unlocks when it finishes, and you'll be notified.`
      : chatBusy ? 'Athena is working on this Design in the chat. Editing unlocks when the reply finishes.'
        : workspaceBusy ? 'Opening the note…' : switching ? 'Saving and switching documents…' : null;
  const startSpec = async (): Promise<void> => {
    if (!design?.specificationType || specificationType.isPending) return;
    if (hasSpec && !await confirmDialog('Athena will replace the current spec with a new one written from this use case. Any edits, images or files in the spec will be overwritten. Earlier versions stay in note history.',
      { title: 'Regenerate the spec?', confirmLabel: 'Continue', tone: 'danger' })) return;
    spec.mutate();
  };
  const useCases = design?.assets.filter(item => item.role === 'use_case' && item.available && item.sourceType === 'note') ?? [];
  const hasUseCase = useCases.length === 1 || useCases.some(item => item.sourceId === design?.selections.use_case);
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
          <option value="standard">Standard</option>
          <option value="imagine">IMAGINE</option>
        </select>
      </label>
      {specificationType.isPending && <span className="kh-design-spec-action__saving" role="status">Saving type...</span>}
      <button type="button" className="kh-btn-accent" disabled={busy || switching || spec.isPending || specificationType.isPending || !design?.specificationType || !hasUseCase} onClick={() => { void startSpec(); }}>
        {specBusy ? 'The Spec writer is working…' : hasSpec ? 'Regenerate spec from use case' : 'Generate spec with Athena'}</button>
      <p>{!hasUseCase ? 'Link and select a use case before generating a spec.'
        : !design?.specificationType ? 'Choose a specification type. The choice is saved on this Design.'
          : 'Uses the selected use case. The existing spec stays intact until the new version is ready.'}</p>
      {error && <p role="alert" className="kh-design-work__error">{error}</p>}
    </section>
    <DesignConsistency key={id} id={id} busy={busy || switching} prepare={prepare} />
    <section aria-label="Design activity">
      <h3>Activity</h3>
      {job ? <div role="status" className="kh-design-work__activity">
        <AthenaRibbon size={24} mood="thinking" />
        <div><strong>{job.specialistName} · {job.status === 'running' ? `${jobSeconds}s` : 'Queued'}</strong>
          <p>{jobStep ?? 'Waiting to start.'}</p></div>
      </div> : visualBusy || chatBusy ? <p role="status">{visualStatus ?? 'Athena is working on this Design.'}</p>
        : latestJob ? <div>
          <strong>{latestJob.specialistName} · {latestJob.status === 'done' ? 'Completed' : 'Could not finish'}</strong>
          <p className={latestJob.status === 'failed' ? 'kh-design-work__error' : undefined}
            role={latestJob.status === 'failed' ? 'alert' : undefined}>{latestJob.error ?? latestJob.summary}</p>
          {latestJob.status === 'failed' && latestJob.specialist === 'spec-writer' && <>
            <p>The existing spec was not replaced.</p>
            <button type="button" className="kh-btn-ghost" disabled={busy || switching || spec.isPending || specificationType.isPending || !hasUseCase || !design?.specificationType}
              onClick={() => { void startSpec(); }}>Retry Spec writer</button>
          </>}
        </div> : <p>{history.isLoading ? 'Loading activity...' : 'No generation activity yet.'}</p>}
      {history.isError && <p role="alert" className="kh-design-work__error">{describeApiError(history.error)}
        {' '}<button type="button" className="kh-btn-ghost" onClick={() => { void history.refetch(); }}>Reload activity</button></p>}
    </section>
    <section aria-label="Design outputs">
      <h3>Outputs</h3>
      <ul className="kh-design-work__outputs">{TABS.map(item => {
        const linked = design?.assets.filter(output => output.role === item.role) ?? [];
        return <li key={item.role}><strong>{item.label}</strong>
          {!linked.length ? <p>Not linked</p> : linked.map(output => <button key={output.sourceId} type="button"
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
    if (note.id === design?.parentNoteId) {
      void qc.invalidateQueries({ queryKey: ['design', id] });
      if (note.contentType !== 'design') onOpenNote(note.id);
    }
  };
  if (query.isLoading) return <p className="kh-design-loading" role="status">Loading Design...</p>;
  if (!design) return <p className="kh-design-loading kh-uc-error" role="alert">{describeApiError(query.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>;
  const chrome = <div className="kh-design-chrome">
    <div className="kh-design-tabs" role="tablist" aria-label="Design documents" ref={tabsRef} onKeyDown={event => {
      const index = TABS.findIndex(item => item.role === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : null;
      if (next === null) return;
      event.preventDefault(); void switchTo(TABS[next]!.role);
      tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{TABS.map(item => <button key={item.role} type="button" role="tab" id={`${uid}-${item.role}`} aria-selected={tab === item.role}
      aria-controls={`${uid}-document`} tabIndex={tab === item.role ? 0 : -1} disabled={switching || busy}
      onClick={() => { void switchTo(item.role); }}>{item.label}</button>)}</div>
    <div className="kh-design-links">
      {assets.length > 1 && <label className="kh-uc-field"><span className="kh-uc-field__label">Linked version</span>
        <select className="kh-uc-input" value={asset?.sourceId ?? ''} disabled={switching || busy} onChange={event => { void switchTo(tab, event.target.value); }}>
          <option value="" disabled>Choose a document</option>
          {assets.map(item => <option key={item.sourceId} value={item.sourceId}>{item.title}{design.selections[tab] === item.sourceId ? ' (selected for handoff)' : ''}</option>)}
        </select></label>}
      {asset && assets.length > 1 && design.selections[tab] !== asset.sourceId && <button type="button" className="kh-btn-ghost" disabled={busy || selection.isPending || !asset.available}
        onClick={() => { selection.mutate(asset.sourceId); }}>Use this version for visuals and handoff</button>}
      {!assets.length && <button type="button" className="kh-btn-ghost" disabled={switching || busy} onClick={() => { setLinking(true); }}>Link {TABS.find(item => item.role === tab)!.label.toLowerCase()}</button>}
    </div>
    {lockReason && <p className="kh-design-hint kh-design-hint--busy" role="status"><AthenaRibbon size={20} mood="thinking" />{lockReason}</p>}
    {error && !spec.isError && !specificationType.isError && <p role="alert" className="kh-uc-error">{error}</p>}
    {selection.isError && <p role="alert" className="kh-uc-error">{describeApiError(selection.error)}</p>}
    {!asset && tab !== 'diagram' && <p className="kh-design-hint">{assets.length ? 'Choose a linked version; none has been assumed.' : 'No document linked. Link an existing original to this tab. The parent writing below is preserved.'}</p>}
    {asset && !asset.available && <p className="kh-uc-error" role="alert">The linked document is unavailable or archived. Its original has not been replaced.</p>}
  </div>;
  return <div className="kh-design-parent" role="tabpanel" id={`${uid}-document`} aria-labelledby={`${uid}-${tab}`}>
    {!document.data ? <>{chrome}<p className="kh-design-loading" role={document.isError ? 'alert' : 'status'}>
      {document.isError ? describeApiError(document.error) : 'Loading original document...'}
      {document.isError && <button className="kh-btn-ghost" type="button" onClick={() => { void document.refetch(); }}>Retry</button>}</p></>
      : <NoteEditor key={`${document.data.id}:${editorEpoch}`} doc={document.data} onSaved={saved} actionsSlot={actionsSlot} externalBusy={busy || switching} loading={switching}
        hideProperties={asset?.sourceType === 'canvas' && asset.available}
        htmlViewEnabled={tab === 'spec'}
        onOpenMap={onOpenMap} onSaveReady={registerSave} onBeforeViewChange={prepare} headerContent={chrome} designPanel={designPanel}
        actionContent={<li role="menuitem"><button type="button" className="kb-menu__item" onClick={() => { setHandoff(true); }}>Copilot package...</button></li>}
        bodyContent={asset?.available && asset.sourceType === 'canvas' ? <div className="kh-design-diagram-body">
          <DiagramEditor canvasId={asset.sourceId} designPanel={designPanel} parentContext={{ type: 'note', id: design.parentNoteId, title: design.title }}
            onSaveReady={registerDiagramSave} onOpenNote={onOpenNote} onDeleted={() => { void query.refetch(); }} /></div>
          : tab === 'diagram' ? <section className="kh-design-diagram-empty" aria-label="Diagram canvas">
            <h3>{asset ? 'Diagram unavailable' : assets.length ? 'Choose a diagram canvas' : 'No diagram canvas linked'}</h3>
            <p>{asset ? 'The original canvas is unavailable or archived. No note editor has been substituted.'
              : assets.length ? 'Select a linked canvas above to open its diagramming tools here.'
                : 'Link an existing diagram canvas above to open its diagramming tools here. This tab edits the original canvas, not a note.'}</p>
          </section> : undefined}
        visualContent={<DesignVisual designId={id} subjectId={design.id} agentJob={job} parentNoteId={design.parentNoteId} prepare={prepare} onBusyChange={visualBusyChange} onAccepted={async () => {
          setEditorEpoch(value => value + 1); await refresh();
        }} />} />}
    {linking && <LinkDocument design={design} role={tab} onClose={() => { setLinking(false); }} onSaved={updated => {
      qc.setQueryData(['design', id], updated); setLinking(false); void refresh();
    }} />}
    {handoff && <DesignHandoff design={design} prepare={prepare} onClose={() => { setHandoff(false); }} />}
  </div>;
};

const LinkDocument: React.FC<{ design: DesignDetail; role: Tab; onClose: () => void; onSaved: (design: DesignDetail) => void }> = ({ design, role, onClose, onSaved }) => {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setSearch(input); }, 250); return () => { clearTimeout(timer); }; }, [input]);
  const sourceType = role === 'diagram' ? 'canvas' : 'note';
  const query = useQuery({ queryKey: ['design-asset-search', search, sourceType], queryFn: async () => requireApiData(await api.searchDesignAssets(search, sourceType)) });
  const link = useMutation({ mutationFn: async (asset: DesignAsset) => requireApiData(await api.linkDesignAsset(design.id, { ...asset, role })), onSuccess: onSaved });
  const assets = query.data?.filter(asset => asset.sourceId !== design.parentNoteId) ?? [];
  return <AppDialog title={`Link ${TABS.find(item => item.role === role)!.label.toLowerCase()}`} onClose={onClose}
    actions={<button type="button" className="kh-btn-ghost" disabled={link.isPending} onClick={onClose}>Close</button>}>
    <label className="kh-uc-field"><span className="kh-uc-field__label">Find existing {role === 'diagram' ? 'canvas' : 'document'}</span>
      <input className="kh-uc-input" type="search" data-dialog-autofocus value={input} maxLength={200} onChange={event => { setInput(event.target.value); }} /></label>
    {query.isFetching && <p className="kh-design-hint" role="status">Searching...</p>}
    {query.isError && <p className="kh-uc-error" role="alert">{describeApiError(query.error)}</p>}
    <ul className="kh-design-assets">{assets.map(asset => {
      const linked = design.assets.some(item => item.sourceType === asset.sourceType && item.sourceId === asset.sourceId && item.role === role);
      return <li key={asset.sourceId}><strong>{asset.title}</strong><button type="button" className="kh-btn-ghost" disabled={link.isPending || linked}
        onClick={() => { link.mutate(asset); }}>{linked ? 'Linked' : 'Link'}</button></li>;
    })}</ul>
    {!query.isFetching && !query.isError && !assets.length && <p className="kh-design-hint">No matches. Refine the search.</p>}
    {link.isError && <p className="kh-uc-error" role="alert">{describeApiError(link.error)}</p>}
  </AppDialog>;
};
