/**
 * features/canvas/NoteMaps.tsx — the mind maps linked to a note, shown at the
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
  const { data: maps = [] } = useQuery({
    queryKey: ['canvases', 'for-note', noteId],
    queryFn: async () => {
      const r = await api.listCanvases(noteId);
      return r.success ? r.data : [];
    },
    staleTime: 30_000,
  });

  return (
    <div className="mm-note-maps">
      <p className="mm-note-maps__title">Maps</p>
      {maps.length === 0 ? (
        onMapNote !== undefined && (
          <button type="button" className="mm-note-maps__item mm-note-maps__item--new" onClick={() => { onMapNote(noteId); }}>
            <Add size={16} /> Map this note
          </button>
        )
      ) : (
        maps.map((m) => (
          <button key={m.id} type="button" className="mm-note-maps__item" onClick={() => { onOpenMap(m.id); }}>
            <Diagram size={16} />
            <span className="mm-note-maps__name">{m.title}</span>
            <span className="mm-note-maps__count">{m.nodeCount} ideas</span>
          </button>
        ))
      )}
    </div>
  );
};
