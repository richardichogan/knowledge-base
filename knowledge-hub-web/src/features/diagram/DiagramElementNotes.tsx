import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

/** Loads every note title once (shared cache with the diagram's own note picker). */
export function useNotePicker(enabled: boolean): ReturnType<typeof useQuery<Array<{ id: string; title: string }>>> {
  return useQuery({
    queryKey: ['diagram-note-picker'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const rows: Array<{ id: string; title: string }> = [];
      let page = 1;
      for (;;) {
        const response = await api.getNoteSummaries(page, 100);
        if (!response.success) throw new Error(response.error.message);
        rows.push(...response.data.items.map((n) => ({ id: n.id, title: n.title || 'Untitled' })));
        if (!response.data.hasMore) return rows;
        if (response.data.items.length === 0) throw new Error('Note pagination returned no results. Retry loading notes.');
        page++;
      }
    },
  });
}

/** Think notes linked to one shape, connector or footnote. */
export function DiagramElementNotes({ canvasId, elementId, notes, onOpenNote, beforeChange, compact = false, title = 'Linked notes' }: {
  canvasId: string;
  elementId: string;
  notes: ReadonlyArray<{ noteId: string; title: string }>;
  onOpenNote?: ((id: string) => void) | undefined;
  /** Saves pending edits first, so a brand-new shape exists on the server before it gets a link. */
  beforeChange: () => Promise<boolean>;
  compact?: boolean;
  title?: string;
}): React.ReactElement {
  const client = useQueryClient();
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useNotePicker(picker);
  async function change(noteId: string, unlink: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (!unlink && !(await beforeChange())) throw new Error('Save the diagram first, then link the note.');
      const response = unlink ? await api.unlinkElementNote(canvasId, elementId, noteId) : await api.linkElementNote(canvasId, elementId, noteId);
      if (!response.success) throw new Error(response.error.message);
      client.setQueryData(['canvas', canvasId], response.data);
      await client.invalidateQueries({ queryKey: ['canvases'] });
      if (!unlink) { setPicker(false); setSearch(''); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update note link'); }
    finally { setBusy(false); }
  }
  const matches = candidates.data?.filter((n) => !notes.some((l) => l.noteId === n.id) && n.title.toLowerCase().includes(search.toLowerCase())).slice(0, 30);
  return <section className={`dg-element-notes${compact ? ' dg-element-notes--compact' : ''}`} aria-label={title}>
    {!compact && <h4>{title}</h4>}
    <div className="dg-element-notes__list">
      {notes.map((note) => <span className="dg-element-notes__chip" key={note.noteId}>
        <a href={`/think?noteId=${encodeURIComponent(note.noteId)}`} onClick={onOpenNote === undefined ? undefined : (e) => { e.preventDefault(); onOpenNote(note.noteId); }}>{note.title}</a>
        <button type="button" disabled={busy} aria-label={`Unlink ${note.title}`} title="Unlink" onClick={() => { void change(note.noteId, true); }}>×</button>
      </span>)}
      <button type="button" className="dg-text-btn" disabled={busy} aria-expanded={picker} onClick={() => { setPicker(!picker); }}>
        {notes.length === 0 ? 'Link a think note' : '+ Note'}
      </button>
    </div>
    {error !== null && <p role="alert" className="dg-element-notes__error">{error}</p>}
    {picker && <div className="dg-note-links__picker">
      <label>Find a note<input aria-label="Find a note" autoFocus value={search} onChange={(e) => { setSearch(e.target.value); }} /></label>
      {candidates.isLoading && <p role="status">Loading notes...</p>}
      {candidates.isError && <p role="alert">Could not load notes. <button type="button" onClick={() => { void candidates.refetch(); }}>Retry</button></p>}
      {matches?.map((note) =>
        <button type="button" className="dg-note-links__choice" disabled={busy} key={note.id} onClick={() => { void change(note.id, false); }}>{note.title}</button>)}
      {matches?.length === 0 && <p>No matching unlinked notes.</p>}
    </div>}
  </section>;
}
