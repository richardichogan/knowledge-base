/**
 * notes/NotesPage.tsx — Think page: three-column layout.
 * Left: NoteList (260px). Centre: Editor (flex). Right: Metadata panel (220px).
 */

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Pen } from '@carbon/icons-react';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { fetchNotes, fetchNote, createNote } from './noteStorage';
import type { NoteDocument, NoteListItem } from './types';

type ViewMode = 'notes' | 'canvas';

export const NotesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<NoteDocument | null>(null);
  const [mode, setMode] = useState<ViewMode>('notes');

  const { data: notes = [], isLoading, isError, refetch } = useQuery<NoteListItem[]>({
    queryKey: ['notes-list'],
    queryFn: fetchNotes,
    staleTime: 30_000,
    retry: 1,
  });

  async function handleSelect(id: string): Promise<void> {
    if (id === selectedId) return;
    const doc = await fetchNote(id);
    if (doc !== null) {
      setSelectedId(id);
      setOpenDoc(doc);
    }
  }

  async function handleCreate(): Promise<void> {
    const doc = await createNote({
      title: 'Untitled',
      contentType: 'note',
      contentJson: '[]',
    });
    if (doc !== null) {
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      setSelectedId(doc.id);
      setOpenDoc(doc);
    }
  }

  function handleSaved(updated: NoteDocument): void {
    setOpenDoc((prev) => {
      if (prev?.title !== updated.title) {
        void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      }
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
          <p className="page-subtitle">{notes.length} note{notes.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <div className="notes-root">
        {/* Left: note list panel */}
        <div className="notes-list-panel">
          {/* Mode switcher */}
          <div className="notes-mode-switcher">
            <button
              className={`notes-mode-btn${mode === 'notes' ? ' notes-mode-btn--active' : ''}`}
              onClick={() => { setMode('notes'); }}
            >
              Notes
            </button>
            <button
              className={`notes-mode-btn${mode === 'canvas' ? ' notes-mode-btn--active' : ''}`}
              onClick={() => { setMode('canvas'); }}
            >
              Canvas
            </button>
          </div>

          {mode === 'notes' && (
            <>
              <NoteList
                notes={notes}
                selectedId={selectedId}
                onSelect={(id) => { void handleSelect(id); }}
              />
              <div className="notes-list-footer">
                <button className="kh-btn-accent" onClick={() => { void handleCreate(); }}>
                  + New note
                </button>
              </div>
            </>
          )}

          {mode === 'canvas' && (
            <div className="notes-canvas-list-placeholder">
              <p className="notes-canvas-placeholder-text">Canvas — coming soon</p>
            </div>
          )}
        </div>

        {/* Centre + Right */}
        {mode === 'notes' ? (
          <div className="notes-editor-area">
            {openDoc !== null ? (
              <NoteEditor
                key={openDoc.id}
                doc={openDoc}
                onSaved={handleSaved}
              />
            ) : (
              <div className="notes-empty-state">
                Select a document or create a new one
              </div>
            )}
          </div>
        ) : (
          <div className="notes-canvas-placeholder">
            <Pen size={40} className="notes-canvas-icon" />
            <span className="notes-canvas-label">Canvas — coming soon</span>
          </div>
        )}
      </div>
    </div>
  );
};
