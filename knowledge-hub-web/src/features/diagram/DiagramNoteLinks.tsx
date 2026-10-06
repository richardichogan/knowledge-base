import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

export function DiagramNoteLinks({ canvasId, notes, onOpenNote }: {
  canvasId: string; notes: Array<{ id: string; title: string }>;
  onOpenNote?: ((id: string) => void) | undefined;
}): React.ReactElement {
  const client = useQueryClient();
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useQuery({
    queryKey: ['diagram-note-picker'],
    enabled: picker,
    staleTime: 0,
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
  async function change(noteId: string, unlink: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = unlink ? await api.unlinkCanvasNote(canvasId, noteId) : await api.linkCanvasNote(canvasId, noteId);
      if (!response.success) throw new Error(response.error.message);
      client.setQueryData(['canvas', canvasId], response.data);
      await client.invalidateQueries({ queryKey: ['canvases'] });
      if (!unlink) setPicker(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update note link'); }
    finally { setBusy(false); }
  }
  const matches = candidates.data?.filter((n) => !notes.some((linked) => linked.id === n.id) && n.title.toLowerCase().includes(search.toLowerCase()));
  return <section className="dg-note-links" aria-label="Linked notes">
    <h4>Linked notes</h4>
    {notes.length === 0 && <p>No linked notes yet.</p>}
    {notes.map((note) => <div className="dg-note-links__row" key={note.id}>
      <a href={`/think?noteId=${encodeURIComponent(note.id)}`} onClick={onOpenNote === undefined ? undefined : (e) => { e.preventDefault(); onOpenNote(note.id); }}>{note.title}</a>
      <button type="button" disabled={busy} aria-label={`Unlink ${note.title}`} onClick={() => { void change(note.id, true); }}>Unlink</button>
    </div>)}
    <button type="button" className="dg-text-btn" disabled={busy} aria-expanded={picker} onClick={() => { setPicker(!picker); }}>Link a note</button>
    {error !== null && <p role="alert">{error}</p>}
    {picker && <div className="dg-note-links__picker">
      <label>Find a note<input aria-label="Find a note" value={search} onChange={(e) => { setSearch(e.target.value); }} /></label>
      {candidates.isLoading && <p role="status">Loading notes...</p>}
      {candidates.isError && <p role="alert">Could not load notes. <button type="button" onClick={() => { void candidates.refetch(); }}>Retry</button></p>}
      {matches?.map((note) =>
        <button type="button" className="dg-note-links__choice" disabled={busy} key={note.id} onClick={() => { void change(note.id, false); }}>{note.title}</button>)}
      {matches?.length === 0 && <p>No matching unlinked notes.</p>}
    </div>}
    <p>The note's Connections tab links back to this editable diagram.</p>
  </section>;
}
