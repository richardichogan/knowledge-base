/**
 * notes/NotesPage.tsx — Think page: three-column layout.
 * Left: NoteList (260px). Centre: Editor. Right: Metadata panel (220px).
 */

import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { UploadMarkdownModal } from './UploadMarkdownModal';
import { fetchNotes, fetchNote, createNote, deleteNote } from './noteStorage';
import type { NoteDocument, NoteListItem } from './types';
import { SparkPanel } from '../features/sparks/SparkPanel';
import { CanvasEditor } from '../features/canvas/CanvasEditor';
import { api } from '../services/api';
import type { CanvasSummaryApi } from '../services/api';

type ViewMode = 'notes' | 'sparks' | 'canvas';

export const NotesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [selectedId,       setSelectedId]       = useState<string | null>(null);
  const [openDoc,          setOpenDoc]          = useState<NoteDocument | null>(null);
  const [mode,             setMode]             = useState<ViewMode>('notes');
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [deletingNoteId,   setDeletingNoteId]   = useState<string | null>(null);
  const [showUploadModal,  setShowUploadModal]  = useState(false);

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

  async function handleUploadDone(noteId: string | null, taskCount: number): Promise<void> {
    setShowUploadModal(false);
    await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    if (taskCount > 0) await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    if (noteId !== null) {
      setSelectedId(null); // force re-fetch via handleSelectNote
      await handleSelectNote(noteId);
    }
  }

  function handleNoteSaved(updated: NoteDocument): void {
    setOpenDoc((prev) => {
      if (prev?.title !== updated.title) void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      return updated;
    });
  }

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
                <button className="kh-btn-ghost" onClick={() => setShowUploadModal(true)}>⬆ Upload .md</button>
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

      {showUploadModal && (
        <UploadMarkdownModal
          onClose={() => setShowUploadModal(false)}
          onDone={(noteId, taskCount) => { void handleUploadDone(noteId, taskCount); }}
        />
      )}
    </div>
  );
};
