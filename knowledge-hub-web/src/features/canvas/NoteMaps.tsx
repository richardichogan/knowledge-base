/**
 * features/canvas/NoteMaps.tsx — the canvases pinned to a note, shown at the
 * top of the note's Connections tab.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Diagram, Add } from '@carbon/icons-react';
import { api } from '../../services/api';

interface Props {
  noteId: string;
  onOpenMap: (mapId: string) => void;
  onMapNote?: (noteId: string) => void;
}

export const NoteMaps: React.FC<Props> = ({ noteId, onOpenMap, onMapNote }) => {
  const { data: maps = [], isError, refetch } = useQuery({
    queryKey: ['canvases', 'for-note', noteId],
    queryFn: async () => {
      const r = await api.listCanvases(noteId);
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    staleTime: 30_000,
  });

  return (
    <div className="mm-note-maps">
      <p className="mm-note-maps__title">Canvases</p>
      {isError && <p className="mm-canvas-error" role="alert">Could not load linked canvases. <button type="button" onClick={() => { void refetch(); }}>Retry</button></p>}
      {maps.length === 0 ? (
        onMapNote !== undefined && (
          <button type="button" className="mm-note-maps__item mm-note-maps__item--new" onClick={() => { onMapNote(noteId); }}>
            <Add size={16} /> Create a canvas for this note
          </button>
        )
      ) : (
        maps.map((m) => (
          <button key={m.id} type="button" className="mm-note-maps__item" onClick={() => { onOpenMap(m.id); }}>
            <Diagram size={16} />
            <span className="mm-note-maps__name">{m.title}</span>
            <span className="mm-note-maps__count">{m.canvasType === 'diagram' ? 'Diagram' : `${m.nodeCount} ideas`}</span>
          </button>
        ))
      )}
    </div>
  );
};
