/**
 * notes/NotesPage.tsx — Think page: three-column layout.
 * Left: NoteList (260px). Centre: Editor. Right: Metadata panel (220px).
 */

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { fetchNotes, fetchNote, createNote, deleteNote } from './noteStorage';
import type { NoteDocument, NoteListItem } from './types';
import { SparkPanel } from '../features/sparks/SparkPanel';
import { CanvasEditor } from '../features/canvas/CanvasEditor';
import { api } from '../services/api';
import { useAthenaContext } from '../context/AthenaContext';
import type { CanvasSummaryApi } from '../services/api';

type ViewMode = 'notes' | 'sparks' | 'canvas';

export const NotesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId,       setSelectedId]       = useState<string | null>(null);
  const [openDoc,          setOpenDoc]          = useState<NoteDocument | null>(null);
  const [mode,             setMode]             = useState<ViewMode>('notes');
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [deletingNoteId,   setDeletingNoteId]   = useState<string | null>(null);
  const { setAthenaContext } = useAthenaContext();

  const { data: notes = [], isLoading, isError, refetch } = useQuery<NoteListItem[]>({
    queryKey: ['notes-list'],
    queryFn: fetchNotes,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: canvases = [], isLoading: canvasLoading } = useQuery<CanvasSummaryApi[]>({
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

  async function handleSelectNote(id: string): Promise<void> {
    if (id === selectedId) return;
    const doc = await fetchNote(id);
    if (doc !== null) { setSelectedId(id); setOpenDoc(doc); }
  }

  async function handleCreateNote(): Promise<void> {
    const doc = await createNote({ title: 'Untitled', contentType: 'note', contentJson: '[]' });
    if (doc !== null) {
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      setSelectedId(doc.id);
      setOpenDoc(doc);
    }
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
    setOpenDoc((prev) => {
      if (prev?.title !== updated.title) void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      return updated;
    });
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

  // Guards against re-running the image lookup on every autosave tick — the
  // editor's autosave interval/debounce hands back a *new* NoteDocument object
  // (new `updatedAt`) even when nothing actually changed, and openDoc was
  // previously a direct effect dependency, so this used to refire the lookup
  // in a tight loop and flood the backend. Only re-run when the note's id or
  // its actual serialized content changes.
  const lastLookupKeyRef = useRef<string | null>(null);
  const noteId = mode === 'notes' ? openDoc?.id ?? null : null;
  const noteContentJson = mode === 'notes' ? openDoc?.contentJson ?? null : null;
  const noteTitle = mode === 'notes' ? openDoc?.title ?? null : null;
  const noteContentType = mode === 'notes' ? openDoc?.contentType ?? null : null;

  useEffect(() => {
    if (mode === 'notes' && openDoc !== null) {
      const lookupKey = `${openDoc.id}:${noteContentJson ?? ''}`;

      // Prime with basic context immediately, then upgrade it once any
      // embedded images' vision analysis has loaded (async, may take a beat).
      setAthenaContext({
        type: 'note',
        title: openDoc.title,
        detail: `Content type: ${openDoc.contentType}`,
      });

      if (lastLookupKeyRef.current === lookupKey) {
        return () => { setAthenaContext(null); };
      }
      lastLookupKeyRef.current = lookupKey;

      let cancelled = false;
      void (async (): Promise<void> => {
        let blocks: unknown;
        try {
          blocks = JSON.parse(openDoc.contentJson);
        } catch {
          return;
        }
        const imageUrls = extractImageUrls(blocks);
        if (imageUrls.length === 0) return;

        const r = await api.lookupImages(imageUrls);
        if (cancelled || !r.success) return;

        const descriptions = r.data.items
          .map((img, i) => {
            const parts: string[] = [];
            if (img.visionAnalysis !== undefined) parts.push(img.visionAnalysis);
            else if (img.ocrText !== undefined) parts.push(`Text in image: ${img.ocrText}`);
            if (img.caption !== undefined) parts.push(`Caption: ${img.caption}`);
            return parts.length > 0 ? `[Image ${(i + 1).toString()}] ${parts.join(' — ').slice(0, 600)}` : null;
          })
          .filter((d): d is string => d !== null);

        if (descriptions.length === 0 || cancelled) return;

        setAthenaContext({
          type: 'note',
          title: openDoc.title,
          detail: `Content type: ${openDoc.contentType}. Contains ${imageUrls.length.toString()} embedded image(s):\n${descriptions.join('\n')}`,
        });
      })();

      return () => { cancelled = true; setAthenaContext(null); };
    }
    if (mode === 'canvas' && selectedCanvasId !== null) {
      const selectedCanvas = canvases.find((c) => c.id === selectedCanvasId) ?? null;
      if (selectedCanvas !== null) {
        setAthenaContext({
          type: 'canvas',
          title: selectedCanvas.title,
          detail: `Updated: ${new Date(selectedCanvas.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
        });
        return () => { setAthenaContext(null); };
      }
    }
    setAthenaContext(null);
    return undefined;
    // Depend on primitive fields, not the `openDoc` object reference — autosave
    // hands back a new object (new updatedAt) on every save tick even when
    // nothing changed, which would otherwise refire this effect (and the image
    // lookup fetch inside it) in a tight loop on a timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, noteId, noteContentJson, noteTitle, noteContentType, selectedCanvasId, canvases, setAthenaContext]);

  if (isLoading) return <InlineLoading description="Loading documents…" />;
  if (isError) return (
    <div className="notes-error-state">
      <p>Failed to load documents.</p>
      <button className="notes-retry-btn" onClick={() => { void refetch(); }}>Retry</button>
    </div>
  );

  return (
    <div className="notes-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Think</h1>
          {mode === 'notes' && <p className="page-subtitle">{notes.length} note{notes.length !== 1 ? 's' : ''}</p>}
          {mode === 'canvas' && <p className="page-subtitle">{canvases.length} canvas{canvases.length !== 1 ? 'es' : ''}</p>}
        </div>
      </div>

      <div className="notes-root">
        {/* ── Left panel ── */}
        <div className="notes-list-panel">
          <div className="notes-mode-switcher">
            <button className={`notes-mode-btn${mode === 'notes'  ? ' notes-mode-btn--active' : ''}`} onClick={() => { setMode('notes'); }}>Notes</button>
            <button className={`notes-mode-btn${mode === 'sparks' ? ' notes-mode-btn--active' : ''}`} onClick={() => { setMode('sparks'); }}>Sparks</button>
            <button className={`notes-mode-btn${mode === 'canvas' ? ' notes-mode-btn--active' : ''}`} onClick={() => { setMode('canvas'); }}>Canvas</button>
          </div>

          {mode === 'notes' && (
            <>
              <NoteList
                notes={notes}
                selectedId={selectedId}
                onSelect={(id) => { void handleSelectNote(id); }}
                onDelete={(id) => { void handleDeleteNote(id); }}
                deletingId={deletingNoteId}
              />
              <div className="notes-list-footer">
                <button className="kh-btn-accent" onClick={() => { void handleCreateNote(); }}>+ New note</button>
              </div>
            </>
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
              <NoteEditor key={openDoc.id} doc={openDoc} onSaved={handleNoteSaved} onDelete={(id) => { void handleDeleteNote(id); }} />
            ) : (
              <div className="notes-empty-state">Select a document or create a new one</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
