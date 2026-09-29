/**
 * notes/NotesPage.tsx — Think page: page header + command bar, then a
 * three-column layout. Left: NoteList. Centre: Editor. Right: tabbed side
 * panel (Athena / Metadata / Connections).
 */

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Search, Add, SidePanelOpen, SidePanelClose, DocumentImport, Document, Idea, Draw } from '@carbon/icons-react';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { ImportNoteModal } from './ImportNoteModal';
import { QuickSparkModal } from '../components/sparks/QuickSparkModal';
import { fetchNotes, fetchNote, createNote, deleteNote, extractNoteBlockText, buildPreview } from './noteStorage';
import type { NoteContentBlock } from './noteStorage';
import type { NoteDocument, NoteListItem } from './types';
import { SparkPanel } from '../features/sparks/SparkPanel';
import { CanvasEditor } from '../features/canvas/CanvasEditor';
import { api } from '../services/api';
import { useAthenaContext } from '../context/AthenaContext';
import { usePersistedBoolean } from '../hooks/usePersistedState';
import type { CanvasSummaryApi } from '../services/api';

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
const NOTE_CONTEXT_MAX_CHARS = 100_000;

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
  const [importModalOpen,  setImportModalOpen]  = useState(false);
  const [sparkModalOpen,   setSparkModalOpen]   = useState(false);
  const [listCollapsed, setListCollapsed] = usePersistedBoolean('kh_think_list_collapsed', false);
  // Incremented rather than set to `true`, so expanding from the rail's search
  // icon can pull focus into the box every time — a boolean would only fire on
  // the first expand of a session.
  const [focusSearchSignal, setFocusSearchSignal] = useState(0);
  const { pageContext, setAthenaContext } = useAthenaContext();
  // Command-bar element NoteEditor portals its note actions (Export, Push, Delete) into.
  const [docActionsSlot, setDocActionsSlot] = useState<HTMLDivElement | null>(null);

  const { data: notes = NO_NOTES, isLoading, isError, refetch } = useQuery<NoteListItem[]>({
    queryKey: ['notes-list'],
    queryFn: fetchNotes,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: canvases = NO_CANVASES, isLoading: canvasLoading } = useQuery<CanvasSummaryApi[]>({
    queryKey: ['canvases'],
    queryFn: async () => {
      const r = await api.listCanvases();
      return r.success && r.data ? r.data : [];
    },
    enabled: mode === 'canvas',
    staleTime: 30_000,
  });

  useEffect(() => {
    const linkedId = searchParams.get('noteId');
    if (linkedId !== null) {
      void handleSelectNote(linkedId);
      searchParams.delete('noteId');
      setSearchParams(searchParams, { replace: true });
      return;
    }
    const first = notes[0];
    if (first !== undefined && selectedId === null) void handleSelectNote(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // The most recently clicked note. A slower earlier load must not replace
  // the note the user has since clicked on.
  const latestSelectRef = useRef<string | null>(null);

  async function handleSelectNote(id: string): Promise<void> {
    if (id === selectedId) return;
    latestSelectRef.current = id;
    setSelectedId(id); // highlight immediately; the body follows
    const doc = await fetchNote(id);
    if (latestSelectRef.current !== id) return;
    if (doc !== null) setOpenDoc(doc);
  }

  async function handleCreateNote(): Promise<void> {
    const doc = await createNote({ title: 'Untitled', contentType: 'note', contentJson: '[]' });
    if (doc !== null) {
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      setSelectedId(doc.id);
      setOpenDoc(doc);
    }
  }

  async function handleImported(doc: NoteDocument): Promise<void> {
    setImportModalOpen(false);
    await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    setSelectedId(doc.id);
    setOpenDoc(doc);
  }

  async function handleDeleteNote(id: string): Promise<void> {
    setDeletingNoteId(id);
    try {
      await deleteNote(id);
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      if (selectedId === id) {
        const remaining = notes.filter((n) => n.id !== id);
        const next = remaining[0];
        if (next !== undefined) {
          setSelectedId(null); // force re-fetch via handleSelectNote
          await handleSelectNote(next.id);
        } else {
          setSelectedId(null);
          setOpenDoc(null);
        }
      }
    } finally {
      setDeletingNoteId(null);
    }
  }

  async function handleCreateCanvas(): Promise<void> {
    const r = await api.createCanvas('Untitled Canvas');
    if (r.success && r.data) {
      await queryClient.invalidateQueries({ queryKey: ['canvases'] });
      setSelectedCanvasId(r.data.id);
    }
  }

  function handleNoteSaved(updated: NoteDocument): void {
    setOpenDoc(updated);
    // Patch the sidebar row in place rather than re-fetching the whole list
    // on every autosave that changes the title.
    const preview = buildPreview(updated.contentJson, updated.title);
    queryClient.setQueryData<NoteListItem[]>(['notes-list'], (list) => list?.map((n): NoteListItem => {
      if (n.id !== updated.id) return n;
      const { body: _body, projectId: _projectId, ...rest } = n;
      return {
        ...rest,
        title: updated.title,
        contentType: updated.contentType,
        updatedAt: new Date().toISOString(),
        ...(preview !== '' && { body: preview }),
        ...(updated.projectId !== undefined && { projectId: updated.projectId }),
      };
    }));
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
  const selectedCanvas = selectedCanvasId !== null ? canvases.find((c) => c.id === selectedCanvasId) ?? null : null;
  const selectedCanvasTitle = selectedCanvas?.title ?? null;
  const selectedCanvasUpdatedAt = selectedCanvas?.updatedAt ?? null;

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
    if (mode === 'canvas' && selectedCanvasTitle !== null && selectedCanvasUpdatedAt !== null) {
      setAthenaContext({
        type: 'canvas',
        title: selectedCanvasTitle,
        detail: `Updated: ${new Date(selectedCanvasUpdatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      });
      return () => { setAthenaContext(null); };
    }
    setAthenaContext(null);
    return undefined;
    // Depend on primitive fields, not the `openDoc` object reference — autosave
    // hands back a new object (new updatedAt) on every save tick even when
    // nothing changed, which would otherwise refire this effect (and the image
    // lookup fetch inside it) in a tight loop on a timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, noteId, noteContentJson, noteTitle, noteContentType, noteProjectId, selectedCanvasTitle, selectedCanvasUpdatedAt, setAthenaContext]);

  if (isLoading) return <InlineLoading description="Loading documents…" />;
  if (isError) return (
    <div className="notes-error-state">
      <p>Failed to load documents.</p>
      <button className="notes-retry-btn" onClick={() => { void refetch(); }}>Retry</button>
    </div>
  );

  return (
    <div className="notes-page">
      {/* ── Header + command bar (matches Plan / Library) ── */}
      <div className="page-header notes-header">
        <div className="page-title-group">
          <h1 className="page-title">Think</h1>
        </div>
        <div className="plan-header__right">
          {mode === 'notes' && <div className="notes-doc-actions-slot" ref={setDocActionsSlot} />}
          {mode === 'notes' && (
            <button type="button" className="kb-import-btn" onClick={() => { setImportModalOpen(true); }} title="Import a Markdown or text file as a note">
              <DocumentImport size={16} /> Import
            </button>
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
          <button
            type="button"
            className="docs-upload-btn notes-header__new"
            onClick={() => {
              if (mode === 'canvas') void handleCreateCanvas();
              else if (mode === 'sparks') setSparkModalOpen(true);
              else void handleCreateNote();
            }}
          >
            <Add size={20} />
            {mode === 'canvas' ? 'New canvas' : mode === 'sparks' ? 'New spark' : 'New note'}
          </button>
        </div>
      </div>

      <div className="notes-root">
        {/* ── Left panel ── */}
        {listCollapsed ? (
          // Collapsed rail. Search and "+" both expand the list rather than
          // opening cramped rail-width variants of those controls — at 56px
          // wide there is no room to show results or a title field.
          <div className="notes-list-rail">
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
              onCreate={() => { void handleCreateNote(); }}
              onImport={() => { setImportModalOpen(true); }}
              deletingId={deletingNoteId}
              focusSearchSignal={focusSearchSignal}
            />
          )}

          {mode === 'canvas' && (
            <>
              {canvasLoading ? (
                <div className="notes-list"><InlineLoading description="Loading…" /></div>
              ) : (
                <div className="notes-list">
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
                      <p className="notes-list-item-title">{c.title}</p>
                      <div className="notes-list-item-bottom">
                        <span className="notes-list-item-date">
                          {new Date(c.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                    </div>
                  ))}
                  {canvases.length === 0 && (
                    <p className="notes-list-empty">No canvases yet</p>
                  )}
                </div>
              )}
              <div className="notes-list-footer">
                <button className="kh-btn-accent" onClick={() => { void handleCreateCanvas(); }}>+ New canvas</button>
              </div>
            </>
          )}
        </div>
        )}

        {/* ── Right: editor area ── */}
        {mode === 'sparks' ? (
          <div className="notes-editor-area"><SparkPanel /></div>
        ) : mode === 'canvas' ? (
          <div className="notes-editor-area">
            {selectedCanvasId !== null ? (
              <CanvasEditor canvasId={selectedCanvasId} />
            ) : (
              <div className="notes-empty-state">Select a canvas or create a new one</div>
            )}
          </div>
        ) : (
          <div className="notes-editor-area">
            {openDoc !== null ? (
              <NoteEditor key={openDoc.id} doc={openDoc} onSaved={handleNoteSaved} onDelete={(id) => { void handleDeleteNote(id); }} actionsSlot={docActionsSlot} />
            ) : (
              <div className="notes-empty-state">Select a document or create a new one</div>
            )}
          </div>
        )}
      </div>

      <ImportNoteModal
        open={importModalOpen}
        onClose={() => { setImportModalOpen(false); }}
        onImported={(doc) => { void handleImported(doc); }}
      />

      <QuickSparkModal open={sparkModalOpen} onClose={() => { setSparkModalOpen(false); }} />
    </div>
  );
};
