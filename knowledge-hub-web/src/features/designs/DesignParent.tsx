import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AppDialog } from '../../components/AppDialog';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { extractNoteBlockText, fetchNote, type NoteContentBlock } from '../../notes/noteStorage';
import { deferredView } from '../../utils/deferredView';
import { setDesignChatBridge } from '../../utils/activeBlockNoteEditor';
import { useAthenaContext } from '../../context/AthenaContext';
import type { NoteDocument } from '../../notes/types';
import type { DesignAsset, DesignDetail } from '../../types/designs';
import { DesignVisual } from './DesignVisual';
import { DesignHandoff } from './DesignHandoff';
import { announceAthenaJob } from '../../components/athena/AthenaJobNotice';
import { AthenaRibbon } from '../../components/athena/AthenaRibbon';
import { requestCompletionNotifications } from '../../chat/completionNotification';
import { confirmDialog } from '../../services/appDialogs';

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
  const [specBusy, setSpecBusy] = useState(false);
  const specStartedRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const busy = visualBusy || chatBusy || workspaceBusy || specBusy;
  const chatBusyRef = useRef(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const noteSave = useRef<(() => Promise<boolean>) | null>(null);
  const diagramSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((save: (() => Promise<boolean>) | null) => { noteSave.current = save; }, []);
  const registerDiagramSave = useCallback((save: (() => Promise<boolean>) | null) => { diagramSave.current = save; }, []);
  const uid = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const query = useQuery({ queryKey: ['design', id], queryFn: async () => requireApiData(await api.getDesign(id)) });
  const design = query.data;
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
    setAthenaContext({ type: 'note', id: note.id, conversationId: design.parentNoteId,
      title: note.title, detail: extractNoteBlockText(blocks as NoteContentBlock[]),
      ...(note.projectId ? { projectId: note.projectId } : {}) });
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
  const selection = useMutation({
    mutationFn: async (sourceId: string) => {
      await prepare();
      return requireApiData(await api.selectDesignAsset(id, tab, sourceId, design!.revision));
    },
    onSuccess: async updated => { qc.setQueryData(['design', id], updated); await refresh(); },
  });
  useEffect(() => {
    if (!specBusy) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [specBusy]);
  const spec = useMutation({
    mutationFn: async () => {
      await prepare();
      return requireApiData(await api.writeDesignSpec(id, true));
    },
    onMutate: () => { requestCompletionNotifications(); specStartedRef.current = Date.now(); setNow(Date.now()); setSpecBusy(true); setError(null); },
    onSuccess: async result => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['design', id] }), qc.invalidateQueries({ queryKey: ['design-document'] }), refresh()]);
      setEditorEpoch(value => value + 1);
      announceAthenaJob({ ok: true, always: true, tag: `design-spec-${id}`, startedAt: specStartedRef.current,
        title: result.created ? 'Spec written' : 'Spec regenerated',
        body: `“${result.title}” is ready. The Blueprint is unchanged; regenerate it from the Spec tab when you want it to match.`,
        url: `/think?design=${encodeURIComponent(id)}&tab=spec` });
    },
    onError: err => {
      announceAthenaJob({ ok: false, always: true, tag: `design-spec-${id}`, startedAt: specStartedRef.current, title: 'Spec not written',
        body: describeApiError(err), url: `/think?design=${encodeURIComponent(id)}&tab=use_case` });
    },
    onSettled: () => { setSpecBusy(false); },
  });
  const hasSpec = !!design?.assets.some(item => item.role === 'spec' && item.available);
  // Every lock says why, so the Design never looks frozen.
  const lockReason = specBusy ? null
    : visualBusy ? `${visualStatus ?? 'Athena is working on the Blueprint'}. Editing unlocks when it finishes, and you'll be notified.`
      : chatBusy ? 'Athena is working on this Design in the chat. Editing unlocks when the reply finishes.'
        : workspaceBusy ? 'Opening the note…' : switching ? 'Saving and switching documents…' : null;
  const startSpec = async (): Promise<void> => {
    if (hasSpec && !await confirmDialog('Athena will replace the current spec with a new one written from this use case. Any edits, images or files in the spec will be overwritten. Earlier versions stay in note history.',
      { title: 'Regenerate the spec?', confirmLabel: 'Continue', tone: 'danger' })) return;
    spec.mutate();
  };
  const specAction = (footer: boolean): React.ReactNode => tab === 'use_case' && asset?.available && asset.sourceType === 'note'
    ? <div className={`kh-design-spec-action${footer ? ' kh-design-spec-action--footer' : ''}`}>
      <button type="button" className="kh-btn-accent" disabled={busy || switching} onClick={() => { void startSpec(); }}>
        {specBusy ? 'Athena is writing the spec…' : hasSpec ? 'Regenerate spec from use case' : 'Generate spec with Athena'}</button>
      <p role={specBusy ? 'status' : undefined} className={specBusy ? 'kh-design-hint--busy' : undefined}>{specBusy
        ? <><AthenaRibbon size={20} mood="thinking" />{`Working for ${Math.max(0, Math.round((now - specStartedRef.current) / 1000))}s. You'll be notified when it's done.`}</>
        : hasSpec ? 'Rewrites the spec from this use case. Earlier versions stay in history.' : 'Athena writes a spec from this use case and links it to the Spec tab.'}</p>
    </div> : null;
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
    {specAction(false)}
    {lockReason && <p className="kh-design-hint kh-design-hint--busy" role="status"><AthenaRibbon size={20} mood="thinking" />{lockReason}</p>}
    {error && <p role="alert" className="kh-uc-error">{error}</p>}
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
        onOpenMap={onOpenMap} onSaveReady={registerSave} onBeforeViewChange={prepare} headerContent={chrome} footerContent={specAction(true)}
        actionContent={<li role="menuitem"><button type="button" className="kb-menu__item" onClick={() => { setHandoff(true); }}>Copilot package...</button></li>}
        bodyContent={asset?.available && asset.sourceType === 'canvas' ? <div className="kh-design-diagram-body">
          <DiagramEditor canvasId={asset.sourceId} parentContext={{ type: 'note', id: design.parentNoteId, title: design.title }}
            onSaveReady={registerDiagramSave} onOpenNote={onOpenNote} onDeleted={() => { void query.refetch(); }} /></div>
          : tab === 'diagram' ? <section className="kh-design-diagram-empty" aria-label="Diagram canvas">
            <h3>{asset ? 'Diagram unavailable' : assets.length ? 'Choose a diagram canvas' : 'No diagram canvas linked'}</h3>
            <p>{asset ? 'The original canvas is unavailable or archived. No note editor has been substituted.'
              : assets.length ? 'Select a linked canvas above to open its diagramming tools here.'
                : 'Link an existing diagram canvas above to open its diagramming tools here. This tab edits the original canvas, not a note.'}</p>
          </section> : undefined}
        visualContent={<DesignVisual designId={id} parentNoteId={design.parentNoteId} prepare={prepare} onBusyChange={visualBusyChange} onAccepted={async () => {
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
