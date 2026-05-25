/**
 * notes/NotesPage.tsx — Think page: three-column layout.
 * Left: NoteList (260px). Centre: Editor. Right: Metadata panel (220px).
 */

import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { fetchNotes, fetchNote, createNote } from './noteStorage';
import type { NoteDocument, NoteListItem } from './types';
import { SparkPanel } from '../features/sparks/SparkPanel';

type ViewMode = 'notes' | 'sparks';

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
          {mode === 'notes' && (
            <p className="page-subtitle">{notes.length} note{notes.length !== 1 ? 's' : ''}</p>
          )}
        </div>
      </div>

      <div className="notes-root">
        {/* Left panel */}
        <div className="notes-list-panel">
          <div className="notes-mode-switcher">
            <button className={`notes-mode-btn${mode === 'notes' ? ' notes-mode-btn--active' : ''}`} onClick={() => { setMode('notes'); }}>Notes</button>
            <button className={`notes-mode-btn${mode === 'sparks' ? ' notes-mode-btn--active' : ''}`} onClick={() => { setMode('sparks'); }}>Sparks</button>
          </div>

          {mode === 'notes' && (
            <>
              <NoteList notes={notes} selectedId={selectedId} onSelect={(id) => { void handleSelectNote(id); }} />
              <div className="notes-list-footer">
                <button className="kh-btn-accent" onClick={() => { void handleCreateNote(); }}>+ New note</button>
              </div>
            </>
          )}
        </div>

        {/* Centre + Right */}
        {mode === 'sparks' ? (
          <div className="notes-editor-area"><SparkPanel /></div>
        ) : (
          <div className="notes-editor-area">
            {openDoc !== null ? (
              <NoteEditor key={openDoc.id} doc={openDoc} onSaved={handleNoteSaved} />
            ) : (
              <div className="notes-empty-state">Select a document or create a new one</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};