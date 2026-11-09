/**
 * notes/NotesPage.tsx — Think page: page header + command bar, then a
 * three-column layout. Left: NoteList. Centre: Editor. Right: tabbed side
 * panel (Athena / Metadata / Connections).
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { usePageTitle } from '../navigation/PageTitle';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Add, SidePanelOpen, SidePanelClose, DocumentImport, ChevronDown, Document, Idea, Draw, TrashCan, Renew, ArrowLeft } from '@carbon/icons-react';
import { NoteList } from './NoteList';
import { NoteFilters, tagFolderPath } from './NoteTagFolders';
import { CONTENT_TYPE_OPTIONS, type ContentType } from './constants';
import { expandTagIds, useTaxonomy } from '../hooks/useTaxonomy';
import { QuickSparkModal } from '../components/sparks/QuickSparkModal';
import { fetchNotesPage, fetchNote, createNote, deleteNote, extractNoteBlockText, buildPreview } from './noteStorage';
import { preparePresentationScript } from '../features/autocue/preparePresentationScript';
import { openPresentationVisuals, presentedVisualIssue, recordPresentedVisuals, desktopVisualIssue } from '../features/autocue/presentedVisuals';
import { scriptVideoContext } from '../features/autocue/scriptVideoState';
import { annotatedPresentation } from '../features/podcasts/scriptAnnotations';
import { episodeScriptText } from '../types/podcastEpisodes';
import type { NoteContentBlock, NoteListPage } from './noteStorage';
import { athenaLinkText, prepareEntityLinkExport } from './linkLabels';
import { loadedNotes, nextNotesPage, noteListQuery, type NoteListQuery } from './noteListState';
import type { NoteDocument, NoteListItem } from './types';
import { SideTabsPanel } from '../components/SideTabsPanel';
import type { PaneWidthOptions } from '../hooks/usePersistedState';
import { SparkPanel } from '../features/sparks/SparkPanel';
import { SparksAthenaPanel } from '../features/sparks/SparksAthenaPanel';
import { deferredView } from '../utils/deferredView';
import { api } from '../services/api';
import { confirmDialog, alertDialog } from '../services/appDialogs';
import { useAthenaContext } from '../context/AthenaContext';
import { usePersistedBoolean } from '../hooks/usePersistedState';
import type { CanvasFullApi, CanvasSummaryApi } from '../services/api';
import type { DiagramType } from '../features/diagram/diagramTypes';
import { diagramLocation, readThinkLocation } from './thinkLocation';
import '../features/diagram/diagramIntegration.scss';
import { DataNotice } from '../components/DataNotice';
import { canvasGroupsByProject } from '../features/canvas/canvasGroups';
import { useProjects } from '../hooks/useProjects';
import { PageHeader } from '../components/PageHeader';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useDesktopCommand } from '../services/desktopCommands';
import { getDesktop } from '../types/desktop';
import { authSession } from '../services/authSession';
import { DesignParent } from '../features/designs/DesignParent';
import { PodcastEpisodeParent } from '../features/podcasts/PodcastEpisodeParent';
import { describeApiError, requireApiData } from '../services/apiError';
import { AppDialog } from '../components/AppDialog';
import { NoteEditorHost } from './NoteEditorHost';
import { slidePanels } from '../utils/panelTransition';
import { requestPassageNavigation } from './passageNavigation';
import { CreateUseCaseDialog } from '../features/useCases/CreateUseCaseDialog';
import { UseCaseDetailPanel } from '../features/useCases/UseCaseDetailPanel';
import { useUseCase } from '../hooks/useUseCases';
import { getActiveBlockNoteEditor, getActiveNoteId } from '../utils/activeBlockNoteEditor';
import { scriptSectionContext } from './noteText';

const NoteEditor = deferredView('Note editor', async () => ({ default: (await import('./NoteEditor')).NoteEditor }));
const CanvasEditor = deferredView('Brainstorm', async () => ({ default: (await import('../features/canvas/CanvasEditor')).CanvasEditor }));
const DiagramEditor = deferredView('Diagram', async () => ({ default: (await import('../features/diagram/DiagramEditor')).DiagramEditor }));
const ImportNoteModal = deferredView('Note import', async () => ({ default: (await import('./ImportNoteModal')).ImportNoteModal }));
const NoteRecoveryCentre = deferredView('Think recovery', async () => ({ default: (await import('./NoteRecoveryCentre')).NoteRecoveryCentre }));

const SPARKS_SIDE_WIDTH: PaneWidthOptions = { compact: 380, wide: 460, min: 300, max: (viewport) => Math.round(viewport * 0.45) };

type ViewMode = 'notes' | 'sparks' | 'canvas';

// Stable empty fallback. A `= []` default is a NEW array every render, and
// the Athena-context effect below depends on the canvas list — so it re-ran,
// re-set the context and re-rendered the page in an endless loop.
const NO_CANVASES: CanvasSummaryApi[] = [];
const NO_NOTES: NoteListItem[] = [];

const VIEW_MODES: { key: ViewMode; label: string; Icon: typeof Document }[] = [
  { key: 'notes',  label: 'Notes',  Icon: Document },
  { key: 'sparks', label: 'Sparks', Icon: Idea },
  { key: 'canvas', label: 'Canvas', Icon: Draw },
];

// Cap on how much of a note's body text is sent to Athena as page context —
// large enough for typical notes/transcripts to be answerable in full, but
// bounded so a huge document doesn't blow the model's context window.
// Was 20,000 — too small for full meeting transcripts, which caused Athena to
// answer as if the back half of a note (e.g. the Q&A section) didn't exist.
const NOTE_CONTEXT_MAX_CHARS = 150_000;

// Per-image cap on the vision description passed to Athena. Was 600, which
// cut most descriptions off before any of the slide/diagram detail.
const IMAGE_DESCRIPTION_MAX_CHARS = 2_500;
const IMAGE_LOOKUP_RETRIES = 4;
const IMAGE_LOOKUP_RETRY_MS = 10_000;

export const NotesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const useCaseId = searchParams.get('useCase');
  const useCaseQuery = useUseCase(useCaseId);
  const requestedCreation = searchParams.get('new');
  const [sparksAthenaBusy, setSparksAthenaBusy] = useState(false);
  const [sparksPrompt, setSparksPrompt] = useState<{ prompt: string; sequence: number } | undefined>(undefined);
  const [selectedId,       setSelectedId]       = useState<string | null>(null);
  const [openDoc,          setOpenDoc]          = useState<NoteDocument | null>(null);
  const [loadingNoteId, setLoadingNoteId] = useState<string | null>(null);
  const [campaignRequest, setCampaignRequest] = useState<{ noteId: string; sequence: number } | null>(null);
  const [mode,             setMode]             = useState<ViewMode>(() => {
    const view = readThinkLocation(searchParams)?.view;
    return view === 'designs' ? 'notes' : view ?? 'notes';
  });
  const [selectedDesign, setSelectedDesign] = useState<string | null>(searchParams.get('design'));
  const [selectedEpisode, setSelectedEpisode] = useState<string | null>(searchParams.get('design') ? null : searchParams.get('episode'));
  const parentOpen = selectedDesign !== null || selectedEpisode !== null;
  const [parentChoices, setParentChoices] = useState<Array<{ id: string; parentNoteId: string; title: string; role: string }>>([]);
  const [choiceSourceId, setChoiceSourceId] = useState<string | null>(null);
  usePageTitle({ view: VIEW_MODES.find((v) => v.key === mode)?.label });
  const [mobilePane, setMobilePane] = useState<'list' | 'editor'>('list');
  const mobile = useMediaQuery('(max-width: 640px)');
  const showEditor = useCallback(() => { setMobilePane('editor'); }, []);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [deletingNoteId,   setDeletingNoteId]   = useState<string | null>(null);
  const deletingNoteRef = useRef<string | null>(null);
  const creatingNoteRef = useRef(false);
  const [importModalOpen,  setImportModalOpen]  = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreMenuOpen) return;
    const close = (e: MouseEvent): void => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) setMoreMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreMenuOpen]);
  const [importHasOpened, setImportHasOpened] = useState(false);
  useEffect(() => { if (importModalOpen) setImportHasOpened(true); }, [importModalOpen]);
  const [sparkModalOpen,   setSparkModalOpen]   = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [listCollapsed, setListCollapsedNow] = usePersistedBoolean('kh_think_list_collapsed', false);
  const [filtersCollapsed, setFiltersCollapsed] = usePersistedBoolean('kh_think_filters_collapsed', true);
  const setListCollapsed = useCallback((next: boolean): void => { slidePanels(() => { setListCollapsedNow(next); }); }, [setListCollapsedNow]);
  const { setAthenaContext, setThinkNavigation } = useAthenaContext();
  // Command-bar element NoteEditor portals its note actions (Export, Push, Delete) into.
  const [docActionsSlot, setDocActionsSlot] = useState<HTMLDivElement | null>(null);

  const [listQuery, setListQuery] = useState<NoteListQuery>({ sort: 'modified' });
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedContentType, setSelectedContentType] = useState<ContentType | null>(null);
  // Definitions live in their own alphabetical section; filtering to another type hides it.
  const definitionsVisible = selectedContentType === null || selectedContentType === 'definition';
  const taxonomy = useTaxonomy();
  const selectedTag = taxonomy.data?.flatMap(parent => [parent, ...(parent.children ?? [])])
    .find(tag => tag.id === selectedTagId);
  const selectedTagPath = selectedTag ? tagFolderPath(selectedTag, taxonomy.data ?? []) : 'Unavailable tag';
  const filterTagIds = selectedTagId ? [...expandTagIds(selectedTagId, taxonomy.data ?? [])].join(',') : undefined;
  const onListQueryChange = useCallback((next: NoteListQuery): void => {
    const clean = noteListQuery(next);
    setListQuery((current) => JSON.stringify(current) === JSON.stringify(clean) ? current : clean);
  }, []);
  const { data: notePages, isLoading, isError, error: listError, isFetching, refetch,
    hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = useInfiniteQuery({
    queryKey: ['notes-list', 'designs', listQuery, filterTagIds ?? '', selectedContentType ?? ''],
    queryFn: ({ pageParam }) => fetchNotesPage(pageParam, listQuery, 'designs',
      { excludeContentType: 'definition', excludeTaskEmails: true,
        ...(selectedContentType ? { contentType: selectedContentType } : {}),
        ...(filterTagIds ? { tagIds: filterTagIds } : {}) }),
    initialPageParam: 1,
    getNextPageParam: nextNotesPage,
    staleTime: 30_000,
    retry: 1,
  });
  // Definitions are reference entries, listed alphabetically in their own section rather than by date.
  const definitionsQuery = useInfiniteQuery({
    queryKey: ['notes-list', 'definitions', listQuery.q ?? '', filterTagIds ?? ''],
    queryFn: ({ pageParam }) => fetchNotesPage(pageParam, { ...(listQuery.q ? { q: listQuery.q } : {}), sort: 'title' }, 'flat',
      { contentType: 'definition', ...(filterTagIds ? { tagIds: filterTagIds } : {}) }),
    initialPageParam: 1,
    getNextPageParam: nextNotesPage,
    staleTime: 30_000,
    retry: 1,
  });
  const definitions = useMemo(() => definitionsQuery.data === undefined ? NO_NOTES
    : loadedNotes(definitionsQuery.data.pages), [definitionsQuery.data]);
  const notes = useMemo(() => {
    if (notePages === undefined) return NO_NOTES;
    return loadedNotes(notePages.pages);
  }, [notePages]);
  const noteTotal = notePages?.pages[0]?.total ?? 0;
  useEffect(() => {
    if (mode !== 'notes') { setThinkNavigation(null); return; }
    const listedDefinitions = definitionsVisible ? definitions : NO_NOTES;
    const listed = [...notes, ...listedDefinitions];
    const folders = (taxonomy.data ?? []).flatMap(parent => [parent, ...(parent.children ?? [])]);
    const error = listError ?? definitionsQuery.error;
    setThinkNavigation({
      selectedTag: selectedTagId ? { id: selectedTagId, path: selectedTagPath, filterTagIds: filterTagIds?.split(',') ?? [] } : null,
      selectedContentType: selectedContentType ? { id: selectedContentType,
        label: CONTENT_TYPE_OPTIONS.find(option => option.id === selectedContentType)?.label ?? selectedContentType } : null,
      folders: folders.slice(0, 100).map(tag => ({ id: tag.id, name: tag.name, parentId: tag.parentId ?? null })),
      totalFolders: folders.length, foldersHasMore: folders.length > 100,
      listCollapsed, filtersCollapsed,
      folderStatus: taxonomy.isError ? 'error' : taxonomy.isPending ? 'loading' : 'ready',
      ...(taxonomy.error ? { folderError: describeApiError(taxonomy.error) } : {}),
      search: listQuery.q ?? '', sort: listQuery.sort ?? 'modified',
      notes: listed.slice(0, 50).map(note => ({ id: note.id, title: note.title })),
      loadedNotes: listed.length, totalNotes: noteTotal + (definitionsVisible ? definitionsQuery.data?.pages[0]?.total ?? 0 : 0),
      hasMore: Boolean(hasNextPage || (definitionsVisible && definitionsQuery.hasNextPage) || listed.length > 50),
      listStatus: error ? 'error' : isLoading || definitionsQuery.isPending ? 'loading' : 'ready',
      ...(error ? { listError: describeApiError(error) } : {}),
    });
  }, [mode, selectedTagId, selectedTagPath, filterTagIds, selectedContentType, definitionsVisible,
    taxonomy.data, taxonomy.isError, taxonomy.isPending, taxonomy.error,
    listQuery, notes, definitions, noteTotal, definitionsQuery.data, definitionsQuery.hasNextPage, definitionsQuery.isPending,
    definitionsQuery.error, hasNextPage, isLoading, listError, listCollapsed, filtersCollapsed, setThinkNavigation]);
  useEffect(() => () => setThinkNavigation(null), [setThinkNavigation]);
  const selectDesign = (id: string, role?: string, assetId?: string): void => {
    setSelectedDesign(id); setSelectedEpisode(null); setSelectedId(id); setMode('notes'); setMobilePane('editor');
    setSearchParams({ design: id, ...(role ? { tab: role } : {}), ...(assetId ? { asset: assetId } : {}) }, { replace: true });
  };
  const selectEpisode = (id: string, tab?: string): void => {
    setSelectedEpisode(id); setSelectedDesign(null); setSelectedId(id); setMode('notes'); setMobilePane('editor');
    setSearchParams({ episode: id, tab: tab ?? searchParams.get('tab') ?? 'prep' }, { replace: true });
  };

  const { data: canvases = NO_CANVASES, isLoading: canvasLoading, isError: canvasListError } = useQuery<CanvasSummaryApi[]>({
    queryKey: ['canvases'],
    queryFn: async () => {
      const r = await api.listCanvases();
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    enabled: mode === 'canvas',
    staleTime: 30_000,
  });
  const { data: projects = [] } = useProjects();
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const canvasGroups = canvasGroupsByProject(canvases, projectNames);

  useEffect(() => {
    const location = readThinkLocation(searchParams);
    const designId = searchParams.get('design');
    if (designId) {
      setSelectedDesign(designId); setSelectedEpisode(null); setMode('notes'); setMobilePane('editor');
      return;
    }
    const episodeId = searchParams.get('episode');
    if (episodeId) {
      setSelectedEpisode(episodeId); setSelectedDesign(null); setSelectedId(episodeId); setMode('notes'); setMobilePane('editor');
      return;
    }
    if (location?.view === 'designs') { setMode('notes'); return; }
    if (location?.view === 'sparks') {
      setMode('sparks');
      searchParams.delete('view');
      setSearchParams(searchParams, { replace: true });
      return;
    }
    if (location?.view === 'canvas') {
      openMap(location.id);
      if (location.footnote !== undefined) setCanvasFootnote(location.footnote);
      return;
    }
    const linkedId = searchParams.get('noteId');
    if (linkedId !== null) {
      const passageId = searchParams.get('passageId');
      if (passageId) requestPassageNavigation(linkedId, passageId);
      if (searchParams.get('panel') === 'campaign') {
        setCampaignRequest(previous => ({ noteId: linkedId, sequence: (previous?.sequence ?? 0) + 1 }));
        searchParams.delete('panel');
      }
      setMode('notes');
      setMobilePane('editor');
      void handleSelectNote(linkedId);
      if (passageId) {
        const next = new URLSearchParams(searchParams); next.delete('passageId');
        setSearchParams(next, { replace: true });
      }
      return;
    }
    const first = notes[0];
    if (first !== undefined && selectedId === null) void handleSelectNote(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, searchParams]);

  // The most recently clicked note. A slower earlier load must not replace
  // the note the user has since clicked on.
  const latestSelectRef = useRef<string | null>(null);

  async function handleSelectNote(id: string): Promise<void> {
    if (!parentOpen && id === selectedId && openDoc?.id === id && openDoc.contentType !== 'design' && openDoc.contentType !== 'podcast-episode') return;
    latestSelectRef.current = id;
    setLoadingNoteId(id);
    setSelectedId(id); // highlight immediately; the body follows
    try {
      const doc = await fetchNote(id);
      if (latestSelectRef.current !== id) return;
      if (doc === null) throw new Error('The document is unavailable. Your current document has been kept open.');
      if (doc.contentType === 'design') { setOpenDoc(doc); selectDesign(doc.id); return; }
      if (doc.contentType === 'podcast-episode') { setOpenDoc(doc); selectEpisode(doc.id, 'prep'); return; }
      const parents = requireApiData(await api.designMembership('note', id));
      if (latestSelectRef.current !== id) return;
      if (parents.length === 1) { selectDesign(parents[0]!.parentNoteId, parents[0]!.role, id); return; }
      if (parents.length > 1) { setChoiceSourceId(id); setParentChoices(parents); return; }
      setSelectedDesign(null); setSelectedEpisode(null);
      setOpenDoc(doc);
      if (searchParams.get('noteId') !== id || searchParams.has('design') || searchParams.has('episode')) {
        const next = new URLSearchParams(searchParams); next.delete('design'); next.delete('episode'); next.delete('view'); next.delete('tab'); next.delete('asset'); next.delete('mapId');
        next.set('noteId', id);
        setSearchParams(next, { replace: true });
      }
    } catch (err) {
      console.error('[Think] Could not open note:', err);
      if (latestSelectRef.current !== id) return;
      latestSelectRef.current = openDoc?.id ?? null;
      setSelectedId(openDoc?.id ?? null);
      await alertDialog(err instanceof Error ? err.message : 'Could not open the note. Its saved content has not been changed.', { title: 'Could not open note', tone: 'danger' });
    } finally {
      setLoadingNoteId(current => current === id ? null : current);
    }
  }

  async function handleCreateNote(contentType: 'note' | 'spec' = 'note'): Promise<boolean> {
    if (creatingNoteRef.current) return false;
    creatingNoteRef.current = true;
    try {
      const doc = await createNote({ title: contentType === 'spec' ? 'Untitled spec' : 'Untitled', contentType, contentJson: '[]' });
      if (doc !== null) {
        setSelectedDesign(null);
        await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
        latestSelectRef.current = doc.id;
        setSelectedId(doc.id);
        setOpenDoc(doc);
        setMobilePane('editor');
        setMode('notes');
        setSearchParams({ noteId: doc.id }, { replace: true });
        return true;
      }
      return false;
    } catch (err) {
      await alertDialog(err instanceof Error ? err.message : 'Could not create the note.', { title: 'Could not create note', tone: 'danger' });
      return false;
    } finally {
      creatingNoteRef.current = false;
    }
  }

  useEffect(() => {
    if (requestedCreation === 'spec') void handleCreateNote('spec');
    // The creation guard prevents duplicate writes; successful creation consumes the URL request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedCreation]);

  useDesktopCommand('new-note', async () => {
    if (!await handleCreateNote()) throw new Error('Could not create a note. Check Think before retrying.');
  });
  useDesktopCommand('new-diagram', async () => {
    if (!await handleCreateCanvas('diagram')) throw new Error('Could not create the diagram. Check Think before retrying.');
  });
  const presentationSave = useRef<(() => Promise<boolean>) | null>(null);
  const presentationSelection = `${mode}:${selectedEpisode ?? selectedDesign ?? selectedId ?? openDoc?.id ?? ''}`;
  const presentationSelectionRef = useRef(presentationSelection);
  presentationSelectionRef.current = presentationSelection;
  const presentationCancellation = useRef(0);
  const registerPresentationSave = useCallback((save: (() => Promise<boolean>) | null): void => { presentationSave.current = save; }, []);
  async function presentNote(): Promise<void> {
    const selection = presentationSelection;
    const cancellation = presentationCancellation.current;
    const assertCurrentSelection = (): void => {
      if (authSession.isExpired()) throw new Error('Sign in again before presenting.');
      if (selection !== presentationSelectionRef.current || cancellation !== presentationCancellation.current) {
        throw new Error('The presentation request was cancelled or the open document changed. Present the current document again.');
      }
      if (mode === 'notes' && !selectedEpisode && openDoc && latestSelectRef.current !== openDoc.id) {
        throw new Error('Wait for the selected document to finish opening before presenting.');
      }
    };
    if (authSession.isExpired()) throw new Error('Sign in again before presenting.');
    const presentation = getDesktop()?.presentation;
    if (!presentation) throw new Error('Update Athena Desktop to present on another display.');
    assertCurrentSelection();
    if (mode === 'notes' && (selectedEpisode || openDoc)) {
      const save = presentationSave.current;
      if (!save || !await save()) throw new Error('Save the current document successfully before presenting. Your open edits are retained.');
      if (presentationSave.current !== save) throw new Error('The open document changed while saving. Present the current document again.');
      assertCurrentSelection();
    }
    if (mode === 'notes' && selectedEpisode) {
      if (!presentation.present) throw new Error('Install the updated Athena Desktop to present directly without the settings window.');
      const episode = requireApiData(await api.getPodcastEpisode(selectedEpisode));
      assertCurrentSelection();
      const text = episodeScriptText(episode.scriptIntro, episode.scriptCards);
      if (!text.trim()) throw new Error('Write or draft the script before presenting.');
      const annotated = annotatedPresentation(text);
      if (annotated.runs.some(run => run.styles.length) && !presentation.scriptAnnotations) {
        throw new Error('Update Athena Desktop to present script colours and delivery cues. Your saved script is unchanged.');
      }
      await presentation.present({ noteId: episode.noteId, title: episode.title, ...annotated });
      recordPresentedVisuals(episode.noteId, null);
      return;
    }
    if (mode !== 'notes' || !openDoc) { await presentation.open(); return; }
    if (!presentation.present) throw new Error('Install the updated Athena Desktop to present directly without the settings window.');
    const saved = await fetchNote(openDoc.id);
    assertCurrentSelection();
    if (!saved) throw new Error('Save the note before presenting.');
    const script = await preparePresentationScript(saved.contentJson, { script: saved.contentType === 'script' });
    assertCurrentSelection();
    if (!script.text.trim()) throw new Error(saved.contentType === 'script'
      ? 'No spoken text to present. Script headings are editor-only; add spoken text beneath them.'
      : 'Choose a saved note containing text.');
    if (script.runs.some(run => run.styles.some(style => style.startsWith('cue-') || style.startsWith('colour-')))
      && !presentation.scriptAnnotations) {
      throw new Error('Update Athena Desktop to present script colours and delivery cues. Your saved script is unchanged.');
    }
    const desktopIssue = desktopVisualIssue(script.visuals, presentation);
    await presentation.present({ noteId: saved.id, title: saved.title, text: script.text, runs: script.runs, visuals: desktopIssue ? [] : script.visuals });
    recordPresentedVisuals(saved.id, script.visualIssue ?? desktopIssue);
  }
  useDesktopCommand('present-note', presentNote);
  const openVisualsHandler = getDesktop()?.presentation ? async (): Promise<void> => {
    const presentation = getDesktop()?.presentation;
    if (!presentation?.openVisuals) throw new Error('Use an updated Athena Desktop to open the synchronised local browser output.');
    if (!openDoc || mode !== 'notes') throw new Error('Choose a saved script before opening browser visuals.');
    const noteId = openDoc.id;
    await openPresentationVisuals(presentNote, () => presentedVisualIssue(noteId), () => presentation.openVisuals!());
  } : undefined;
  const presentHandler = getDesktop()?.presentation ? (): void => { void presentNote().catch(err => {
    void alertDialog(err instanceof Error ? err.message : 'Could not open presentation.', { title: 'Presentation', tone: 'danger' });
  }); } : undefined;
  const stopPresentingHandler = getDesktop()?.presentation ? (): void => {
    presentationCancellation.current += 1;
    void getDesktop()?.presentation?.close().catch(err => {
      void alertDialog(err instanceof Error ? err.message : 'Could not stop presenting.', { title: 'Presentation', tone: 'danger' });
    });
  } : undefined;
  useEffect(() => {
    const presentation = getDesktop()?.presentation;
    const release = (): void => {
      presentationCancellation.current += 1;
      void presentation?.release?.().catch(error => { console.error('[Presentation] Could not close note output:', error); });
    };
    const off = authSession.subscribe(() => { if (authSession.isExpired()) release(); });
    return () => { off(); release(); };
  }, []);

  async function handleImported(doc: NoteDocument): Promise<void> {
    setImportModalOpen(false);
    await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    latestSelectRef.current = doc.id;
    setSelectedId(doc.id);
    setOpenDoc(doc);
    setMobilePane('editor');
  }

  async function handleDeleteNote(id: string): Promise<void> {
    if (deletingNoteRef.current !== null) return;
    deletingNoteRef.current = id;
    setDeletingNoteId(id);
    try {
      await deleteNote(id);
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      if (latestSelectRef.current === id) {
        const remaining = notes.filter((n) => n.id !== id);
        const next = remaining[0];
        if (next !== undefined) {
          setSelectedId(null); // force re-fetch via handleSelectNote
          await handleSelectNote(next.id);
        } else {
          latestSelectRef.current = null;
          setSelectedId(null);
          setOpenDoc(null);
        }
      }
    } catch (err) {
      await alertDialog(err instanceof Error ? err.message : 'Could not delete the note. Your open writing is unchanged.', { title: 'Could not delete note', tone: 'danger' });
    } finally {
      deletingNoteRef.current = null;
      setDeletingNoteId(null);
    }
  }

  async function handleCreateCanvas(canvasType: 'brainstorm' | 'diagram' = 'brainstorm', noteId?: string, diagramType: DiagramType = 'general'): Promise<boolean> {
    setNewMapMenu(null);
    setCanvasError(null);
    try {
      const diagramTitle = diagramType === 'ai-flow' ? 'Untitled AI flow' : 'Untitled diagram';
      const r = await api.createCanvas({
        title: canvasType === 'diagram' ? (noteId !== undefined && openDoc?.id === noteId ? `${openDoc.title} diagram` : diagramTitle) : 'Untitled brainstorm', canvasType,
        ...(canvasType === 'brainstorm' ? { rootLabel: 'New idea' } : {}),
        ...(canvasType === 'diagram' && noteId !== undefined ? { noteId } : {}),
      });
      if (!r.success) throw new Error(r.error.message);
      if (canvasType === 'diagram' && diagramType === 'ai-flow') {
        try {
          const snap = await api.getDiagram(r.data.id);
          if (!snap.success) throw new Error(snap.error.message);
          const saved = await api.saveDiagram(r.data.id, snap.data.revision, { ...snap.data.document, diagramType: 'ai-flow' });
          if (!saved.success) throw new Error(saved.error.message);
        } catch (err) {
          setCanvasError(`Created the diagram, but could not make it an AI flow diagram (${err instanceof Error ? err.message : 'Unknown error'}). Use the AI flow switch in the diagram header.`);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['canvases'] });
      openMap(r.data.id);
      return true;
    } catch (err) { setCanvasError(`Could not create canvas: ${err instanceof Error ? err.message : 'Unknown error'}`); return false; }
  }

  async function handleDeleteCanvas(id: string, title: string): Promise<void> {
    if (!await confirmDialog(`Move the canvas “${title}” to the recycle bin? Its content, links, assets and saved diagram revisions will be retained until you permanently delete it.`, {
      title: 'Move canvas to recycle bin', confirmLabel: 'Move to recycle bin', tone: 'danger',
    })) return;
    setCanvasError(null);
    try {
      await api.deleteCanvas(id);
      if (selectedCanvasId === id) setSelectedCanvasId(null);
      await queryClient.invalidateQueries({ queryKey: ['canvases'] });
    } catch (err) { setCanvasError(`Could not delete canvas: ${err instanceof Error ? err.message : 'Unknown error'}`); }
  }

  /** "New canvas": with a note open, offer to pin the map to it (recommended) or start blank. */
  const [newMapMenu, setNewMapMenu] = useState<'header' | 'footer' | null>(null);
  function requestNewMap(where: 'header' | 'footer'): void {
    setNewMapMenu(where);
  }
  async function createPinnedMap(noteId: string): Promise<void> {
    setNewMapMenu(null);
    setCanvasError(null);
    try {
      const r = await api.createCanvas({ noteId });
      if (!r.success) throw new Error(r.error.message);
      await queryClient.invalidateQueries({ queryKey: ['canvases'] });
      openMap(r.data.id, 'suggestions');
    } catch (err) { setCanvasError(`Could not create brainstorm: ${err instanceof Error ? err.message : 'Unknown error'}`); }
  }

  // Side-panel tab a canvas opens on (Suggestions for a new one, so related content is one drag away).
  const [canvasOpenTab, setCanvasOpenTab] = useState<string | undefined>(undefined);
  // Footnote number from a /think?mapId=…&footnote=n link, shown when the diagram opens.
  const [canvasFootnote, setCanvasFootnote] = useState<number | undefined>(undefined);
  function openMap(mapId: string, tab?: string): void {
    latestSelectRef.current = mapId;
    void api.designMembership('canvas', mapId).then(result => {
      const parents = requireApiData(result);
      if (latestSelectRef.current !== mapId) return;
      if (parents.length === 1) { selectDesign(parents[0]!.parentNoteId, 'diagram', mapId); return; }
      if (parents.length > 1) { setChoiceSourceId(mapId); setParentChoices(parents); return; }
      setSelectedDesign(null);
      setMode('canvas');
      setMobilePane('editor');
      setCanvasOpenTab(tab);
      const location = readThinkLocation(searchParams);
      setCanvasFootnote(location?.view === 'canvas' && location.id === mapId ? location.footnote : undefined);
      setSelectedCanvasId(mapId);
      if (searchParams.get('mapId') !== mapId || searchParams.has('noteId')) setSearchParams(diagramLocation(searchParams, mapId), { replace: true });
    }).catch((error: unknown) => { setCanvasError(describeApiError(error)); });
  }

  /** "Canvas" on a note: opens the note's canvas, or creates one with the note as its first card. */
  async function mapNote(noteId: string): Promise<void> {
    setCanvasError(null);
    try {
      const existing = await api.listCanvases(noteId);
      if (!existing.success) throw new Error(existing.error.message);
      const first = existing.data.find((c) => c.canvasType !== 'diagram');
      if (first !== undefined) { openMap(first.id); return; }
      await createPinnedMap(noteId);
    } catch (err) { setCanvasError(`Could not open brainstorm: ${err instanceof Error ? err.message : 'Unknown error'}`); }
  }

  /** Opens a note from a map (switches Think back to Notes). */
  function openNoteFromMap(noteId: string): void {
    setSearchParams({ noteId }, { replace: true });
    setMode('notes');
    setMobilePane('editor');
    setSelectedId(null);
    void handleSelectNote(noteId);
  }

  /** A note changed on the server (a canvas summary was added to it): reload it if it’s the open one. */
  function refreshNoteIfOpen(noteId: string): void {
    if (openDoc?.id !== noteId) return;
    void fetchNote(noteId).then((doc) => { if (doc !== null && latestSelectRef.current === noteId) setOpenDoc(doc); }).catch((err: unknown) => {
      console.error('[Think] Could not reload note:', err);
      void alertDialog(err instanceof Error ? err.message : 'Could not reload the note. Your current editor has been kept.', { title: 'Could not reload note', tone: 'danger' });
    });
  }

  function handleNoteSaved(updated: NoteDocument): void {
    setOpenDoc(current => current?.id === updated.id ? updated : current);
    if (updated.contentType === 'design' && latestSelectRef.current === updated.id) selectDesign(updated.id);
    if (updated.contentType === 'podcast-episode' && latestSelectRef.current === updated.id) selectEpisode(updated.id, 'prep');
    // Show the accepted save immediately, then reconcile server ordering and filters.
    const preview = buildPreview(updated.contentJson, updated.title);
    const patchRow = (n: NoteListItem): NoteListItem => {
      if (n.id !== updated.id) return n;
      const next: NoteListItem = {
        ...n,
        title: updated.title,
        contentType: updated.contentType,
        updatedAt: updated.updatedAt,
      };
      if (preview === '') delete next.body;
      else next.body = preview;
      if (updated.projectId === undefined) delete next.projectId;
      else next.projectId = updated.projectId;
      return next;
    };
    queryClient.setQueriesData<InfiniteData<NoteListPage>>({ queryKey: ['notes-list'] }, (current) => current === undefined || !Array.isArray(current.pages) ? undefined : ({
      ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map(patchRow) })),
    }));
    void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
  }

  /** Recursively walk BlockNote's Block[] JSON and collect every image block's URL. */
  function extractImageUrls(blocks: unknown): string[] {
    if (!Array.isArray(blocks)) return [];
    const urls: string[] = [];
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: unknown; props?: { url?: unknown }; children?: unknown };
      if (b.type === 'image' && typeof b.props?.url === 'string' && b.props.url !== '') {
        urls.push(b.props.url);
      }
      if (Array.isArray(b.children)) urls.push(...extractImageUrls(b.children));
    }
    return urls;
  }

  // Image descriptions (vision analysis / OCR) per set of image URLs. Cached
  // so every re-run of the effect below can include them straight away —
  // previously a re-run reset Athena's context without images and then
  // skipped the lookup, so Athena almost never saw a note's images.
  const imageDescriptionsRef = useRef(new Map<string, string[]>());
  const noteId = mode === 'notes' && !parentOpen ? openDoc?.id ?? null : null;
  const noteContentJson = mode === 'notes' && !parentOpen ? openDoc?.contentJson ?? null : null;
  const noteTitle = mode === 'notes' && !parentOpen ? openDoc?.title ?? null : null;
  const noteContentType = mode === 'notes' && !parentOpen ? openDoc?.contentType ?? null : null;
  const noteProjectId = mode === 'notes' && !parentOpen ? openDoc?.projectId ?? null : null;

  useEffect(() => {
    if (useCaseId !== null) {
      setAthenaContext({ type: 'use-case', id: useCaseId, title: useCaseQuery.data?.title ?? 'Use case',
        detail: useCaseQuery.data ? `Think use case and saved sources:\n${JSON.stringify(useCaseQuery.data)}`
          : `Use case content has not been retrieved.${useCaseQuery.error ? ` Retrieval failed: ${describeApiError(useCaseQuery.error)}` : ''} Use saved-content retrieval before answering.` });
      return () => { setAthenaContext(null); };
    }
    if (parentOpen) return undefined;
    if (mode === 'notes' && !parentOpen && openDoc !== null) {
      // Give Athena the note's actual text, not just its title/type — otherwise
      // it has nothing to answer questions about the content you're viewing
      // and falls back to (possibly stale/unindexed) RAG search instead.
      let blocks: unknown = [];
      try { blocks = JSON.parse(openDoc.contentJson); } catch { blocks = []; }
      // Link chips (e.g. a heading that links to another note) carry no text of their own,
      // so Athena gets each one's title and id to read or follow.
      const liveScriptEditor = (): ReturnType<typeof getActiveBlockNoteEditor> =>
        openDoc.contentType === 'script' && getActiveNoteId() === openDoc.id ? getActiveBlockNoteEditor() : null;
      const bodyBlock = (): string => {
        const editor = liveScriptEditor();
        const currentBlocks = editor?.document ?? blocks;
        const bodyText = Array.isArray(currentBlocks)
          ? extractNoteBlockText(currentBlocks as NoteContentBlock[], athenaLinkText, openDoc.contentType === 'script').slice(0, NOTE_CONTEXT_MAX_CHARS)
          : '';
        const focusedId = document.activeElement?.closest('.bn-block-outer')?.getAttribute('data-id');
        const selection = editor ? scriptSectionContext(editor.document,
          focusedId ?? editor.getTextCursorPosition().block.id,
          document.activeElement instanceof HTMLTextAreaElement ? '' : editor.getSelectedText()) : '';
        const scene = document.activeElement?.closest('.bn-block-outer')?.querySelector('[data-visual-scene]')?.getAttribute('data-visual-scene');
        const pending = document.querySelector<HTMLElement>('[data-visual-job]');
        return (bodyText !== '' ? `\n\nContent:\n${bodyText}` : '') + selection + (editor ? scriptVideoContext() : '') + (scene ? `\n[Preview scene id: ${scene}]` : '')
          + (pending ? `\n[Reviewing pending visual job ${pending.dataset.visualJob}; status: ${pending.dataset.visualJobStatus}. ${pending.dataset.visualJobConflict || ''} Use read_script_visuals with jobId for its actual saved scenes. Pending is not applied.]` : '');
      };
      const imageUrls = extractImageUrls(blocks);
      const imagesKey = imageUrls.join('|');
      const doc = openDoc;
      let latestDescriptions: string[] | undefined;

      const publish = (descriptions: string[] | undefined): void => {
        latestDescriptions = descriptions;
        const imageNote = imageUrls.length > 0
          ? `. Contains ${imageUrls.length.toString()} embedded image(s)`
          : '';
        setAthenaContext({
          type: 'note',
          title: doc.title,
          detail: `Content type: ${doc.contentType}${imageNote}${doc.contentType === 'script'
            ? '. Script section cards: headings are editor-only titles; their nested child blocks are the spoken body. Each card has a stable block id, included below. Titles are excluded from the autocue. Preserve heading levels when editing. [colour=teal|yellow|pink]...[/colour] describes visual emphasis; [pause]/[beat] are nonspoken delivery cues. For replace_text, find the exact visible wording without colour markers; replacement may use these annotations. Read the saved note for full content if this context is partial.'
            : ''}${bodyBlock()}`,
          id: doc.id,
          ...(['deliverable-brief', 'email-draft'].includes(doc.contentType) ? { workContentId: doc.id } : {}),
          ...(doc.projectId ? { projectId: doc.projectId } : {}),
          ...(descriptions !== undefined && descriptions.length > 0 && { images: descriptions.join('\n\n') }),
        });
      };

      let cancelled = false;
      let selectionTimer: ReturnType<typeof setTimeout> | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const refreshSelection = (): void => {
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => { if (!cancelled) publish(latestDescriptions); }, 150);
      };
      if (doc.contentType === 'script') {
        document.addEventListener('selectionchange', refreshSelection);
        document.addEventListener('focusin', refreshSelection);
        window.addEventListener('athena:script-visual-context', refreshSelection);
      }
      const cleanup = (): void => {
        cancelled = true;
        clearTimeout(selectionTimer);
        clearTimeout(retryTimer);
        document.removeEventListener('selectionchange', refreshSelection);
        document.removeEventListener('focusin', refreshSelection);
        window.removeEventListener('athena:script-visual-context', refreshSelection);
        setAthenaContext(null);
      };
      const cached = imageDescriptionsRef.current.get(imagesKey);
      publish(cached);
      if (JSON.stringify(blocks).includes('Mention"')) {
        void prepareEntityLinkExport(blocks).then(() => { if (!cancelled) publish(latestDescriptions); })
          .catch(() => { /* links stay as ids */ });
      }
      if (imageUrls.length === 0 || cached !== undefined) {
        return cleanup;
      }

      const lookup = (attempt: number): void => { void api.lookupImages(imageUrls).then((r) => {
        if (!r.success || cancelled && attempt > 0) return;
        const total = imageUrls.length;
        const described = new Set<number>();
        const descriptions = r.data.items
          .map((img, i) => {
            const position = img.position ?? i + 1;
            const parts: string[] = [];
            if (img.visionAnalysis !== undefined) parts.push(img.visionAnalysis);
            else if (img.ocrText !== undefined) parts.push(`Text in image: ${img.ocrText}`);
            if (img.caption !== undefined) parts.push(`Caption: ${img.caption}`);
            if (parts.length > 0) described.add(position);
            return parts.length > 0 ? `[Image ${position.toString()} of ${total.toString()}${position === total ? ', last' : ''}] ${parts.join(' — ').slice(0, IMAGE_DESCRIPTION_MAX_CHARS)}` : null;
          })
          .filter((d): d is string => d !== null);
        const missing = imageUrls.map((_, i) => i + 1).filter((p) => !described.has(p));
        if (missing.length > 0) {
          descriptions.push(`[No stored description yet for image(s) ${missing.join(', ')} of ${total.toString()}; say so rather than guessing their contents.]`);
        }
        // A newly pasted image is analysed in the background: retry rather
        // than caching an incomplete result for the rest of the session.
        if (missing.length > 0 && attempt < IMAGE_LOOKUP_RETRIES) {
          if (!cancelled) retryTimer = setTimeout(() => { lookup(attempt + 1); }, IMAGE_LOOKUP_RETRY_MS);
        } else {
          // Cache even if this run was superseded, so the next run uses it.
          imageDescriptionsRef.current.set(imagesKey, descriptions);
        }
        if (!cancelled) publish(descriptions);
      }).catch(() => { /* context stays without image detail */ }); };
      lookup(0);

      return cleanup;
    }
    setAthenaContext(null);
    return undefined;
    // Depend on primitive fields, not the `openDoc` object reference — autosave
    // hands back a new object (new updatedAt) on every save tick even when
    // nothing changed, which would otherwise refire this effect (and the image
    // lookup fetch inside it) in a tight loop on a timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, parentOpen, noteId, noteContentJson, noteTitle, noteContentType, noteProjectId, setAthenaContext, useCaseId, useCaseQuery.data, useCaseQuery.error]);

  return (
    <div className="notes-page" role="main" data-view={mode} data-active-pane={mode === 'sparks' ? 'editor' : mobilePane}>
      <PageHeader title="Think" className="notes-header" actions={<>
          {mode !== 'sparks' && mobilePane === 'editor' && <button type="button"
            className="kb-import-btn kh-workspace-back" onClick={() => { setMobilePane('list'); }}>
            <ArrowLeft size={16} />{mode === 'canvas' ? 'Canvases' : 'Notes'}
          </button>}
          {mode === 'notes' && <div className="notes-doc-actions-slot kh-command-row" ref={setDocActionsSlot} />}
          {mode === 'canvas' && <button type="button" className="kb-import-btn notes-recycle-launch" aria-haspopup="dialog"
            title="Open canvas recycle bin" onClick={() => { setRecoveryOpen(true); }}><TrashCan size={16} /><span>Recycle bin</span></button>}
          {mode === 'notes' && !parentOpen && openDoc === null && (
            <div className="notes-export-anchor notes-more-anchor kh-command-row" ref={moreMenuRef}>
              <button type="button" className="kb-import-btn notes-more-btn" aria-haspopup="menu" aria-expanded={moreMenuOpen}
                onClick={() => { setMoreMenuOpen((v) => !v); }}>
                <ChevronDown size={16} /> Actions
              </button>
              {moreMenuOpen && (
                <ul className="kb-menu" role="menu">
                  <li role="menuitem">
                    <button type="button" className="kb-menu__item" title="Import a Markdown or text file as a note"
                      onClick={() => { setMoreMenuOpen(false); setImportModalOpen(true); }}>
                      <DocumentImport size={16} /> Import
                    </button>
                  </li>
                  <li role="menuitem">
                    <button type="button" className="kb-menu__item notes-recovery-launch" aria-haspopup="dialog"
                      onClick={() => { moreMenuRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus(); setMoreMenuOpen(false); setRecoveryOpen(true); }}>
                      <Renew size={16} /> Recovery & recycle bin
                    </button>
                  </li>
                </ul>
              )}
            </div>
          )}
          <div className="plan-view-toggle kh-command-row" role="tablist" aria-label="Think view">
            {VIEW_MODES.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`think-tab-${key}`}
                aria-controls="think-workspace"
                tabIndex={mode === key ? 0 : -1}
                aria-selected={mode === key}
                className={`plan-view-btn${mode === key ? ' plan-view-btn--active' : ''}`}
                onClick={() => { setSearchParams(key === 'sparks' ? { view: 'sparks' } : {}, { replace: true }); setSelectedDesign(null); setMode(key); setMobilePane('list'); }}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const index = VIEW_MODES.findIndex(view => view.key === key);
                  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? VIEW_MODES.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + VIEW_MODES.length) % VIEW_MODES.length;
                  document.getElementById(`think-tab-${VIEW_MODES[nextIndex]!.key}`)?.click();
                  document.getElementById(`think-tab-${VIEW_MODES[nextIndex]!.key}`)?.focus();
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
          {/* Always present (label follows the view) so the bar keeps its
              shape when switching Notes / Sparks / Canvas. */}
          <div className="mm-newmap-anchor kh-command-row">
            <button
              type="button"
              className="docs-upload-btn notes-header__new"
              aria-haspopup={mode === 'canvas' ? 'menu' : undefined}
              onClick={() => {
                if (mode === 'canvas') requestNewMap('header');
                else if (mode === 'sparks') setSparkModalOpen(true);
                else void handleCreateNote();
              }}
            >
              <Add size={20} />
              {mode === 'canvas' ? 'New canvas' : mode === 'sparks' ? 'New spark' : 'New note'}
            </button>
            {newMapMenu === 'header' && (
              <NewMapMenu
                noteTitle={openDoc?.title}
                onPin={() => { if (openDoc !== null) void createPinnedMap(openDoc.id); }}
                onBlank={() => { setNewMapMenu(null); void handleCreateCanvas(); }}
                onDiagram={() => { void handleCreateCanvas('diagram'); }}
                onAiFlow={() => { void handleCreateCanvas('diagram', undefined, 'ai-flow'); }}
                onClose={() => { setNewMapMenu(null); }}
              />
            )}
          </div>
      </>} />

      {recoveryOpen && <NoteRecoveryCentre onClose={() => setRecoveryOpen(false)}
        onOpenNote={id => { setMode('notes'); setMobilePane('editor'); void handleSelectNote(id); }} />}
      {mode === 'notes' && isError && !isFetchNextPageError && <DataNotice title="Note list is unavailable. Your open note is unchanged." error={listError} onRetry={() => { void refetch(); }} />}
      {canvasError !== null && <p className="mm-canvas-error" role="alert">{canvasError}</p>}
      <div className="notes-root" id="think-workspace" role="tabpanel" aria-labelledby={`think-tab-${mode}`}>
        {/* ── Left panel ── */}
        {mode === 'sparks' ? null : listCollapsed && !mobile ? (
          <div className="notes-list-rail">
            <button
              type="button"
              className="notes-list-rail__btn"
              title={mode === 'notes' ? 'Expand notes and tags' : 'Expand canvas list'}
              aria-label={mode === 'notes' ? 'Expand notes and tags' : 'Expand canvas list'}
              onClick={() => { setListCollapsed(false); }}
            >
              <SidePanelOpen size={16} />
            </button>
          </div>
        ) : (
        <div className="notes-list-panel">
          {mode !== 'notes' && <div className="notes-list-panel__head">
            <span className="notes-list-panel__label">{VIEW_MODES.find((v) => v.key === mode)?.label}</span>
            <button
              type="button"
              className="notes-mode-collapse"
              title="Collapse list"
              aria-label="Collapse list"
              onClick={() => { setListCollapsed(true); }}
            >
              <SidePanelClose size={16} />
            </button>
          </div>}

          {mode === 'notes' && (
            <div className="notes-navigation-split">
            <div className="notes-navigation-list">
            <NoteList
              showTools
              belowTools={<NoteFilters selectedTagId={selectedTagId} onSelectTag={setSelectedTagId}
                selectedContentType={selectedContentType} onSelectContentType={setSelectedContentType}
                collapsed={filtersCollapsed} onToggleCollapsed={() => setFiltersCollapsed(!filtersCollapsed)} />}
              {...(!mobile ? { onCollapse: () => setListCollapsed(true) } : {})}
              {...(filterTagIds ? { tagIds: filterTagIds } : {})}
              notes={notes}
              selectedId={selectedDesign ?? selectedEpisode ?? selectedId}
              onSelect={(id) => { setMobilePane('editor'); void handleSelectNote(id); }}
              onSelectPassage={(id, passageId) => { setSearchParams({ noteId: id, passageId }); }}
              onDelete={(id) => { void handleDeleteNote(id); }}
              deletingId={deletingNoteId}
              onQueryChange={onListQueryChange}
              total={noteTotal}
              loading={isLoading}
              unavailable={isError}
              hasMore={hasNextPage}
              loadingMore={isFetchingNextPage}
              loadMoreError={isFetchNextPageError}
              fetching={isFetching}
              onLoadMore={() => { void fetchNextPage({ cancelRefetch: false }); }}
              definitions={definitionsVisible ? definitions : NO_NOTES}
              definitionsHasMore={definitionsVisible ? definitionsQuery.hasNextPage : false}
              definitionsLoadingMore={definitionsVisible ? definitionsQuery.isFetchingNextPage : false}
              onLoadMoreDefinitions={() => { void definitionsQuery.fetchNextPage({ cancelRefetch: false }); }}
            />
            {definitionsVisible && definitionsQuery.isError && <p className="notes-tag-folders__notice notes-tag-folders__notice--error" role="alert">
              Definitions unavailable. <button type="button" onClick={() => { void definitionsQuery.refetch(); }}>Retry</button>
            </p>}
            </div>
            </div>
          )}

          {mode === 'canvas' && (
            <>
              {canvasLoading ? (
                <div className="notes-list"><InlineLoading description="Loading…" /></div>
              ) : (
                <div className="notes-list">
                  {canvasListError && <p className="mm-canvas-error" role="alert">Could not load canvases. <button type="button" onClick={() => { void queryClient.invalidateQueries({ queryKey: ['canvases'] }); }}>Retry</button></p>}
                  {canvasGroups.map((group) => (
                    <div key={group.key} className="notes-group">
                      <p className="notes-group__label">{group.label}</p>
                      {group.canvases.map((c) => (
                        <div
                          key={c.id}
                          className={`notes-list-item${selectedCanvasId === c.id ? ' notes-list-item--active' : ''}`}
                          aria-label={c.title}
                          role="button"
                          tabIndex={0}
                          data-ctx-title={c.title}
                          data-ctx-type="note"
                          onClick={() => { setSelectedCanvasId(c.id); setMobilePane('editor'); }}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                            e.preventDefault(); setSelectedCanvasId(c.id); setMobilePane('editor');
                          }}
                        >
                          <button
                            className="notes-list-item__delete"
                            title="Delete canvas"
                            aria-label={`Delete canvas ${c.title}`}
                            onClick={(e) => { e.stopPropagation(); void handleDeleteCanvas(c.id, c.title); }}
                          >
                            <TrashCan size={14} />
                          </button>
                          <p className="notes-list-item-title">{c.title}</p>
                          {c.linkedNotes.length > 0 && (
                            <p className="notes-list-item-preview mm-list-notes">↳ {c.linkedNotes.map((n) => n.title).join(', ')}</p>
                          )}
                          <div className="notes-list-item-bottom">
                            <span className="mm-canvas-type">{c.canvasType === 'diagram' ? 'Diagram' : 'Brainstorm'}</span>
                            <span className="notes-list-item-date">
                              {new Date(c.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {canvasGroups.length === 0 && (
                    <p className="notes-list-empty">
                      {canvases.length === 0
                        ? 'No canvases yet. Start one here, or use “Canvas” on any note.'
                        : 'No top-level canvases yet. Subdiagrams are accessed from their parent canvas.'}
                    </p>
                  )}
                </div>
              )}
              <div className="notes-list-footer">
                <div className="mm-newmap-anchor mm-newmap-anchor--up">
                  <button className="kh-btn-accent" onClick={() => { requestNewMap('footer'); }}>+ New canvas</button>
                  {newMapMenu === 'footer' && (
                    <NewMapMenu
                      noteTitle={openDoc?.title}
                      onPin={() => { if (openDoc !== null) void createPinnedMap(openDoc.id); }}
                      onBlank={() => { setNewMapMenu(null); void handleCreateCanvas(); }}
                      onDiagram={() => { void handleCreateCanvas('diagram'); }}
                      onAiFlow={() => { void handleCreateCanvas('diagram', undefined, 'ai-flow'); }}
                      onClose={() => { setNewMapMenu(null); }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        )}

        {/* ── Right: editor area ── */}
        {mode === 'sparks' ? (
          <>
            <div className="notes-editor-area notes-editor-area--sparks">
              <SparkPanel onDevelop={(prompt) => { setSparksPrompt((prev) => ({ prompt, sequence: (prev?.sequence ?? 0) + 1 })); }} />
            </div>
            <SideTabsPanel
              storageKey="sparks-side"
              label="Sparks side panel"
              defaultTab="athena"
              width={SPARKS_SIDE_WIDTH}
              selectTab={sparksPrompt ? { id: 'athena', seq: sparksPrompt.sequence } : undefined}
              tabs={[{
                id: 'athena', label: 'Athena', dot: sparksAthenaBusy ? 'busy' : 'idle', keepMounted: true, fill: true,
                content: <SparksAthenaPanel onBusyChange={setSparksAthenaBusy} promptRequest={sparksPrompt} />,
              }]}
            />
          </>
        ) : mode === 'canvas' ? (
          <div className="notes-editor-area notes-editor-area--map">
            {selectedCanvasId !== null ? (
              <ThinkCanvas
                key={selectedCanvasId}
                canvasId={selectedCanvasId}
                openTab={canvasOpenTab}
                initialFootnote={canvasFootnote}
                onOpenNote={openNoteFromMap}
                onNoteChanged={refreshNoteIfOpen}
                onDeleted={() => { setSelectedCanvasId(null); }}
              />
            ) : (
              <div className="notes-empty-state">Select a canvas, start a new one, or use “Canvas” on any note</div>
            )}
          </div>
        ) : (
          <div className="notes-editor-area">
            <NoteEditorHost enabled={parentOpen || openDoc !== null || loadingNoteId !== null} loading={loadingNoteId !== null}>
            {selectedDesign ? <DesignParent key={selectedDesign} id={selectedDesign} actionsSlot={docActionsSlot}
              workspaceBusy={loadingNoteId !== null} onOpenNote={id => { void handleSelectNote(id); }} onOpenMap={openMap} />
            : selectedEpisode ? <PodcastEpisodeParent key={selectedEpisode} id={selectedEpisode} actionsSlot={docActionsSlot}
              workspaceBusy={loadingNoteId !== null} onOpenNote={id => { void handleSelectNote(id); }} onOpenMap={openMap}
              onPresent={presentHandler} onStopPresenting={stopPresentingHandler} onSaveReady={registerPresentationSave} /> : openDoc !== null ? (
              <NoteEditor key={openDoc.id} doc={openDoc} campaignRequest={campaignRequest?.noteId === openDoc.id ? campaignRequest.sequence : undefined} externalBusy={loadingNoteId !== null} onSaved={handleNoteSaved} onDelete={(id) => { void handleDeleteNote(id); }} actionsSlot={docActionsSlot} onShowEditor={showEditor} onMapNote={(id) => { void mapNote(id); }} onOpenMap={openMap} onImport={() => { setImportModalOpen(true); }} onRecovery={() => { setRecoveryOpen(true); }}
                onPresent={presentHandler} onOpenVisuals={openVisualsHandler} onStopPresenting={stopPresentingHandler} onSaveReady={registerPresentationSave}
                onCreateDiagram={async (id) => { if (!await handleCreateCanvas('diagram', id)) throw new Error('Could not create the linked diagram. Please retry.'); }} />
            ) : (
              <div className="notes-empty-state">Select a document or create a new one</div>
            )}
            </NoteEditorHost>
          </div>
        )}
        {useCaseId !== null && <SideTabsPanel key={useCaseId} storageKey="think-use-case" label="Use case properties"
        selectTab={{ id: 'details', seq: 1 }}
        defaultTab="details" width={SPARKS_SIDE_WIDTH} tabs={[{ id: 'details', label: 'Use case',
          content: <UseCaseDetailPanel id={useCaseId} onClosed={() => { setSearchParams({}, { replace: true }); }} /> }]} />}
      </div>

      {requestedCreation === 'use-case' && <CreateUseCaseDialog initialProjectId={searchParams.get('project')}
        onClose={() => { const next = new URLSearchParams(searchParams); next.delete('new'); next.delete('project'); setSearchParams(next, { replace: true }); }}
        onCreated={created => { setMode('notes'); setSearchParams({ useCase: created.id }, { replace: true }); }} />}

      {!!parentChoices.length && <AppDialog title="Choose the Design" onClose={() => { setParentChoices([]); }}
        actions={<button type="button" className="kh-btn-ghost" onClick={() => { setParentChoices([]); }}>Cancel</button>}>
        <p>This document belongs to more than one Design. Choose which to open.</p>
        {parentChoices.map(parent => <button type="button" className="kh-btn-ghost" key={parent.id}
          onClick={() => { selectDesign(parent.parentNoteId, parent.role, choiceSourceId ?? undefined); setParentChoices([]); }}>{parent.title}</button>)}
      </AppDialog>}

      {(importModalOpen || importHasOpened) && <ImportNoteModal
        open={importModalOpen}
        onClose={() => { setImportModalOpen(false); }}
        onImported={(doc) => { void handleImported(doc); }}
      />}

      <QuickSparkModal open={sparkModalOpen} onClose={() => { setSparkModalOpen(false); }} />
    </div>
  );
};

const ThinkCanvas: React.FC<React.ComponentProps<typeof CanvasEditor> & { initialFootnote?: number | undefined }> = ({ initialFootnote, ...props }) => {
  const { data, isLoading, isError, refetch } = useQuery<CanvasFullApi>({
    queryKey: ['canvas', props.canvasId],
    queryFn: async () => {
      const result = await api.getCanvas(props.canvasId);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    refetchOnWindowFocus: false,
  });
  if (isLoading) return <InlineLoading description="Loading canvas..." />;
  if (isError || !data) return <p className="mm-canvas-error" role="alert">Could not load canvas. <button type="button" onClick={() => { void refetch(); }}>Retry</button></p>;
  return data.canvasType === 'diagram'
    ? <DiagramEditor canvasId={props.canvasId} onDeleted={props.onDeleted} onOpenNote={props.onOpenNote} initialFootnote={initialFootnote} />
    : <CanvasEditor {...props} />;
};

/** The choice offered by "New map" when a note is open. */
const NewMapMenu: React.FC<{ noteTitle: string | undefined; onPin: () => void; onBlank: () => void; onDiagram: () => void; onAiFlow: () => void; onClose: () => void }> = ({ noteTitle, onPin, onBlank, onDiagram, onAiFlow, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} className="mm-newmap-menu" role="menu" aria-label="New canvas">
      {noteTitle !== undefined && <button type="button" role="menuitem" className="mm-newmap-menu__item" autoFocus onClick={onPin}>
        <span className="mm-newmap-menu__title">Brainstorm around “{noteTitle}”</span>
        <span className="mm-newmap-menu__desc">Recommended — the note is the first card; pull related notes, documents, meetings and chats in around it. The canvas joins the note in the knowledge graph.</span>
      </button>}
      <button type="button" role="menuitem" className="mm-newmap-menu__item" autoFocus={noteTitle === undefined} onClick={onBlank}>
        <span className="mm-newmap-menu__title">Brainstorm</span>
        <span className="mm-newmap-menu__desc">Start from a single idea card and pin notes later.</span>
      </button>
      <button type="button" role="menuitem" className="mm-newmap-menu__item" onClick={onDiagram}>
        <span className="mm-newmap-menu__title">Diagram</span>
        <span className="mm-newmap-menu__desc">Architecture diagrams and process flows with shapes, containers, arrows and PNG/SVG icons.</span>
      </button>
      <button type="button" role="menuitem" className="mm-newmap-menu__item" onClick={onAiFlow}>
        <span className="mm-newmap-menu__title">AI flow / governance diagram</span>
        <span className="mm-newmap-menu__desc">Swimlane process flow mapped to agents, tools and governance controls, with built-in governance checks.</span>
      </button>
    </div>
  );
};
