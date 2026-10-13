/**
 * notes/NotesPage.tsx — Think page: page header + command bar, then a
 * three-column layout. Left: NoteList. Centre: Editor. Right: tabbed side
 * panel (Athena / Metadata / Connections).
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Search, Add, SidePanelOpen, SidePanelClose, DocumentImport, ChevronDown, Document, Idea, Draw, TrashCan, Renew } from '@carbon/icons-react';
import { NoteList } from './NoteList';
import { QuickSparkModal } from '../components/sparks/QuickSparkModal';
import { fetchNotesPage, fetchNote, createNote, deleteNote, extractNoteBlockText, buildPreview } from './noteStorage';
import type { NoteContentBlock, NoteListPage, NoteListFilters } from './noteStorage';
import type { NoteDocument, NoteListItem } from './types';
import { SparkPanel } from '../features/sparks/SparkPanel';
import { deferredView } from '../utils/deferredView';
import { api } from '../services/api';
import { confirmDialog, alertDialog } from '../services/appDialogs';
import { useAthenaContext } from '../context/AthenaContext';
import { usePersistedBoolean } from '../hooks/usePersistedState';
import type { CanvasFullApi, CanvasSummaryApi } from '../services/api';
import '../features/diagram/diagramIntegration.scss';
import { DataNotice } from '../components/DataNotice';

const NoteEditor = deferredView('Note editor', async () => ({ default: (await import('./NoteEditor')).NoteEditor }));
const CanvasEditor = deferredView('Brainstorm', async () => ({ default: (await import('../features/canvas/CanvasEditor')).CanvasEditor }));
const DiagramEditor = deferredView('Diagram', async () => ({ default: (await import('../features/diagram/DiagramEditor')).DiagramEditor }));
const ImportNoteModal = deferredView('Note import', async () => ({ default: (await import('./ImportNoteModal')).ImportNoteModal }));
const NoteRecoveryCentre = deferredView('Think recovery', async () => ({ default: (await import('./NoteRecoveryCentre')).NoteRecoveryCentre }));

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

export const NotesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId,       setSelectedId]       = useState<string | null>(null);
  const [openDoc,          setOpenDoc]          = useState<NoteDocument | null>(null);
  const [mode,             setMode]             = useState<ViewMode>('notes');
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
  const [listCollapsed, setListCollapsed] = usePersistedBoolean('kh_think_list_collapsed', false);
  // Incremented rather than set to `true`, so expanding from the rail's search
  // icon can pull focus into the box every time — a boolean would only fire on
  // the first expand of a session.
  const [focusSearchSignal, setFocusSearchSignal] = useState(0);
  const { setAthenaContext } = useAthenaContext();
  // Command-bar element NoteEditor portals its note actions (Export, Push, Delete) into.
  const [docActionsSlot, setDocActionsSlot] = useState<HTMLDivElement | null>(null);

  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const [listFilters, setListFilters] = useState<NoteListFilters>({ sort: 'modified' });
  const onListFilters = useCallback((next: NoteListFilters): void => {
    setListFilters((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, []);
  const { data: notePages, isLoading, isError, error: listError, isFetching, refetch,
    hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['notes-list', listFilters],
    queryFn: ({ pageParam }) => fetchNotesPage(pageParam, listFilters),
    initialPageParam: 1,
    getNextPageParam: (last) => last.hasMore ? last.page + 1 : undefined,
    staleTime: 30_000,
    retry: 1,
  });
  const notes = useMemo(() => {
    if (notePages === undefined) return NO_NOTES;
    const seen = new Set<string>();
    return notePages.pages.flatMap((page) => page.items).filter((note) => {
      if (seen.has(note.id)) return false;
      seen.add(note.id);
      return true;
    });
  }, [notePages]);
  const noteTotal = notePages?.pages[0]?.total ?? 0;

  async function refreshNotes(): Promise<void> {
    if (refreshInFlight.current || isFetching) return;
    refreshInFlight.current = true;
    setRefreshMessage(null);
    try {
      await refetch({ throwOnError: true });
    } catch (error) {
      console.error('[Think] Could not refresh notes:', error);
      setRefreshMessage('Could not refresh notes. Your open note is unchanged. Retry.');
    } finally { refreshInFlight.current = false; }
  }

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

  useEffect(() => {
    if (searchParams.get('view') === 'sparks') {
      setMode('sparks');
      searchParams.delete('view');
      setSearchParams(searchParams, { replace: true });
      return;
    }
    const linkedMapId = searchParams.get('mapId');
    if (linkedMapId !== null) {
      openMap(linkedMapId);
      const footnote = Number(searchParams.get('footnote'));
      if (Number.isInteger(footnote) && footnote > 0) setCanvasFootnote(footnote);
      searchParams.delete('mapId');
      searchParams.delete('footnote');
      setSearchParams(searchParams, { replace: true });
    }
    const linkedId = searchParams.get('noteId');
    if (linkedId !== null) {
      setMode('notes');
      void handleSelectNote(linkedId);
      searchParams.delete('noteId');
      setSearchParams(searchParams, { replace: true });
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
    if (id === selectedId) return;
    latestSelectRef.current = id;
    setSelectedId(id); // highlight immediately; the body follows
    try {
      const doc = await fetchNote(id);
      if (latestSelectRef.current !== id) return;
      if (doc !== null) setOpenDoc(doc);
    } catch (err) {
      console.error('[Think] Could not open note:', err);
      if (latestSelectRef.current !== id) return;
      latestSelectRef.current = openDoc?.id ?? null;
      setSelectedId(openDoc?.id ?? null);
      await alertDialog(err instanceof Error ? err.message : 'Could not open the note. Its saved content has not been changed.', { title: 'Could not open note', tone: 'danger' });
    }
  }

  async function handleCreateNote(): Promise<void> {
    if (creatingNoteRef.current) return;
    creatingNoteRef.current = true;
    try {
      const doc = await createNote({ title: 'Untitled', contentType: 'note', contentJson: '[]' });
      if (doc !== null) {
        await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
        latestSelectRef.current = doc.id;
        setSelectedId(doc.id);
        setOpenDoc(doc);
      }
    } catch (err) {
      await alertDialog(err instanceof Error ? err.message : 'Could not create the note.', { title: 'Could not create note', tone: 'danger' });
    } finally {
      creatingNoteRef.current = false;
    }
  }

  async function handleImported(doc: NoteDocument): Promise<void> {
    setImportModalOpen(false);
    await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    latestSelectRef.current = doc.id;
    setSelectedId(doc.id);
    setOpenDoc(doc);
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

  async function handleCreateCanvas(canvasType: 'brainstorm' | 'diagram' = 'brainstorm', noteId?: string): Promise<boolean> {
    setNewMapMenu(null);
    setCanvasError(null);
    try {
      const r = await api.createCanvas({
        title: canvasType === 'diagram' ? (noteId !== undefined && openDoc?.id === noteId ? `${openDoc.title} diagram` : 'Untitled diagram') : 'Untitled brainstorm', canvasType,
        ...(canvasType === 'brainstorm' ? { rootLabel: 'New idea' } : {}),
        ...(canvasType === 'diagram' && noteId !== undefined ? { noteId } : {}),
      });
      if (!r.success) throw new Error(r.error.message);
      await queryClient.invalidateQueries({ queryKey: ['canvases'] });
      openMap(r.data.id);
      return true;
    } catch (err) { setCanvasError(`Could not create canvas: ${err instanceof Error ? err.message : 'Unknown error'}`); return false; }
  }

  async function handleDeleteCanvas(id: string, title: string): Promise<void> {
    if (!await confirmDialog(`Delete the canvas “${title}”? This cannot be undone.`, { title: 'Delete canvas', confirmLabel: 'Delete', tone: 'danger' })) return;
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
    setMode('canvas');
    setCanvasOpenTab(tab);
    setCanvasFootnote(undefined);
    setSelectedCanvasId(mapId);
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
    setMode('notes');
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
    setOpenDoc(updated);
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
  const noteId = mode === 'notes' ? openDoc?.id ?? null : null;
  const noteContentJson = mode === 'notes' ? openDoc?.contentJson ?? null : null;
  const noteTitle = mode === 'notes' ? openDoc?.title ?? null : null;
  const noteContentType = mode === 'notes' ? openDoc?.contentType ?? null : null;
  const noteProjectId = mode === 'notes' ? openDoc?.projectId ?? null : null;

  useEffect(() => {
    if (mode === 'notes' && openDoc !== null) {
      // Give Athena the note's actual text, not just its title/type — otherwise
      // it has nothing to answer questions about the content you're viewing
      // and falls back to (possibly stale/unindexed) RAG search instead.
      let blocks: unknown = [];
      try { blocks = JSON.parse(openDoc.contentJson); } catch { blocks = []; }
      const bodyText = Array.isArray(blocks)
        ? extractNoteBlockText(blocks as NoteContentBlock[]).slice(0, NOTE_CONTEXT_MAX_CHARS)
        : '';
      const bodyBlock = bodyText !== '' ? `\n\nContent:\n${bodyText}` : '';
      const imageUrls = extractImageUrls(blocks);
      const imagesKey = imageUrls.join('|');
      const doc = openDoc;

      const publish = (descriptions: string[] | undefined): void => {
        const imageNote = imageUrls.length > 0
          ? `. Contains ${imageUrls.length.toString()} embedded image(s)`
          : '';
        setAthenaContext({
          type: 'note',
          title: doc.title,
          detail: `Content type: ${doc.contentType}${imageNote}${bodyBlock}`,
          id: doc.id,
          ...(doc.projectId ? { projectId: doc.projectId } : {}),
          ...(descriptions !== undefined && descriptions.length > 0 && { images: descriptions.join('\n\n') }),
        });
      };

      const cached = imageDescriptionsRef.current.get(imagesKey);
      publish(cached);
      if (imageUrls.length === 0 || cached !== undefined) {
        return () => { setAthenaContext(null); };
      }

      let cancelled = false;
      void api.lookupImages(imageUrls).then((r) => {
        if (!r.success) return;
        const descriptions = r.data.items
          .map((img, i) => {
            const parts: string[] = [];
            if (img.visionAnalysis !== undefined) parts.push(img.visionAnalysis);
            else if (img.ocrText !== undefined) parts.push(`Text in image: ${img.ocrText}`);
            if (img.caption !== undefined) parts.push(`Caption: ${img.caption}`);
            return parts.length > 0 ? `[Image ${(i + 1).toString()}] ${parts.join(' — ').slice(0, IMAGE_DESCRIPTION_MAX_CHARS)}` : null;
          })
          .filter((d): d is string => d !== null);
        // Cache even if this run was superseded, so the next run uses it.
        imageDescriptionsRef.current.set(imagesKey, descriptions);
        if (!cancelled) publish(descriptions);
      }).catch(() => { /* context stays without image detail */ });

      return () => { cancelled = true; setAthenaContext(null); };
    }
    setAthenaContext(null);
    return undefined;
    // Depend on primitive fields, not the `openDoc` object reference — autosave
    // hands back a new object (new updatedAt) on every save tick even when
    // nothing changed, which would otherwise refire this effect (and the image
    // lookup fetch inside it) in a tight loop on a timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, noteId, noteContentJson, noteTitle, noteContentType, noteProjectId, setAthenaContext]);

  return (
    <div className="notes-page">
      {/* ── Header + command bar (matches Plan / Library) ── */}
      <div className="page-header notes-header">
        <div className="page-title-group">
          <h1 className="page-title">Think</h1>
        </div>
        <div className="plan-header__right">
          {mode === 'notes' && <div className="notes-doc-actions-slot" ref={setDocActionsSlot} />}
          {mode === 'notes' && openDoc === null && (
            <div className="notes-export-anchor notes-more-anchor" ref={moreMenuRef}>
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
                      onClick={() => { setMoreMenuOpen(false); setRecoveryOpen(true); }}>
                      <Renew size={16} /> Recovery
                    </button>
                  </li>
                </ul>
              )}
            </div>
          )}
          <div className="plan-view-toggle" role="tablist" aria-label="Think view">
            {VIEW_MODES.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                className={`plan-view-btn${mode === key ? ' plan-view-btn--active' : ''}`}
                onClick={() => { setMode(key); }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
          {/* Always present (label follows the view) so the bar keeps its
              shape when switching Notes / Sparks / Canvas. */}
          <div className="mm-newmap-anchor">
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
                onClose={() => { setNewMapMenu(null); }}
              />
            )}
          </div>
        </div>
      </div>

      {recoveryOpen && <NoteRecoveryCentre onClose={() => setRecoveryOpen(false)}
        onOpenNote={id => { setMode('notes'); void handleSelectNote(id); }} />}
      {mode === 'notes' && refreshMessage !== null && <p className="notes-refresh-message notes-refresh-message--error"
        role="alert">{refreshMessage}</p>}
      {mode === 'notes' && isError && <DataNotice title="Note list is unavailable. Your open note is unchanged." error={listError} onRetry={() => { void refetch(); }} />}
      {canvasError !== null && <p className="mm-canvas-error" role="alert">{canvasError}</p>}
      <div className="notes-root">
        {/* ── Left panel ── */}
        {listCollapsed ? (
          // Collapsed rail. Search and "+" both expand the list rather than
          // opening cramped rail-width variants of those controls — at 56px
          // wide there is no room to show results or a title field.
          <div className="notes-list-rail">
            {mode === 'notes' && <button type="button" className="notes-refresh notes-refresh--rail"
              title="Refresh notes" aria-label="Refresh notes" disabled={isFetching}
              onClick={() => { void refreshNotes(); }}><Renew size={16} /></button>}
            <button
              type="button"
              className="notes-list-rail__btn"
              title="Expand note list"
              aria-label="Expand note list"
              onClick={() => { setListCollapsed(false); }}
            >
              <SidePanelOpen size={16} />
            </button>
            <button
              type="button"
              className="notes-list-rail__btn"
              title="Search notes"
              aria-label="Search notes"
              onClick={() => {
                setListCollapsed(false);
                setFocusSearchSignal((n) => n + 1);
              }}
            >
              <Search size={16} />
            </button>
            <button
              type="button"
              className="notes-list-rail__btn"
              title="New note"
              aria-label="New note"
              onClick={() => { setListCollapsed(false); void handleCreateNote(); }}
            >
              <Add size={16} />
            </button>
          </div>
        ) : (
        <div className="notes-list-panel">
          <div className="notes-list-panel__head">
            <span className="notes-list-panel__label">{VIEW_MODES.find((v) => v.key === mode)?.label}</span>
            {mode === 'notes' && <button type="button" className="notes-refresh"
              title="Refresh notes" aria-label="Refresh notes" disabled={isFetching}
              onClick={() => { void refreshNotes(); }}><Renew size={16} /></button>}
            <button
              type="button"
              className="notes-mode-collapse"
              title="Collapse list"
              aria-label="Collapse list"
              onClick={() => { setListCollapsed(true); }}
            >
              <SidePanelClose size={16} />
            </button>
          </div>

          {mode === 'notes' && (
            <NoteList
              notes={notes}
              selectedId={selectedId}
              onSelect={(id) => { void handleSelectNote(id); }}
              onDelete={(id) => { void handleDeleteNote(id); }}
              deletingId={deletingNoteId}
              focusSearchSignal={focusSearchSignal}
              onFiltersChange={onListFilters}
              total={noteTotal}
              loading={isLoading}
              unavailable={isError}
              hasMore={hasNextPage}
              loadingMore={isFetchingNextPage}
              onLoadMore={() => { void fetchNextPage(); }}
            />
          )}

          {mode === 'canvas' && (
            <>
              {canvasLoading ? (
                <div className="notes-list"><InlineLoading description="Loading…" /></div>
              ) : (
                <div className="notes-list">
                  {canvasListError && <p className="mm-canvas-error" role="alert">Could not load canvases. <button type="button" onClick={() => { void queryClient.invalidateQueries({ queryKey: ['canvases'] }); }}>Retry</button></p>}
                  {canvases.map((c) => (
                    <div
                      key={c.id}
                      className={`notes-list-item${selectedCanvasId === c.id ? ' notes-list-item--active' : ''}`}
                      role="button"
                      tabIndex={0}
                      data-ctx-title={c.title}
                      data-ctx-type="note"
                      onClick={() => { setSelectedCanvasId(c.id); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') setSelectedCanvasId(c.id); }}
                    >
                      <button
                        className="notes-list-item__delete"
                        title="Delete canvas"
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
                  {canvases.length === 0 && (
                    <p className="notes-list-empty">No canvases yet. Start one here, or use “Canvas” on any note.</p>
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
          <div className="notes-editor-area"><SparkPanel /></div>
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
            {openDoc !== null ? (
              <NoteEditor key={openDoc.id} doc={openDoc} onSaved={handleNoteSaved} onDelete={(id) => { void handleDeleteNote(id); }} actionsSlot={docActionsSlot} onMapNote={(id) => { void mapNote(id); }} onOpenMap={openMap} onImport={() => { setImportModalOpen(true); }} onRecovery={() => { setRecoveryOpen(true); }} onCreateDiagram={async (id) => { if (!await handleCreateCanvas('diagram', id)) throw new Error('Could not create the linked diagram. Please retry.'); }} />
            ) : (
              <div className="notes-empty-state">Select a document or create a new one</div>
            )}
          </div>
        )}
      </div>

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
const NewMapMenu: React.FC<{ noteTitle: string | undefined; onPin: () => void; onBlank: () => void; onDiagram: () => void; onClose: () => void }> = ({ noteTitle, onPin, onBlank, onDiagram, onClose }) => {
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
    </div>
  );
};
