/**
 * features/autocue/ScriptSelector.tsx
 * Lists all Think notes with contentType === 'podcast' for selection.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchNotes } from '../../notes/noteStorage';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const ScriptSelector: React.FC = () => {
  const navigate = useNavigate();

  const { data: notes = [], isPending } = useQuery({
    queryKey: ['autocue-scripts'],
    queryFn: fetchNotes,
  });

  const scripts = notes.filter((n) => n.contentType === 'podcast');

  return (
    <div className="ac-selector">
      <p className="ac-selector__label">Select a script</p>

      {isPending && (
        <p className="ac-selector__empty">Loading…</p>
      )}

      {!isPending && scripts.length === 0 && (
        <p className="ac-selector__empty">
          No scripts found. Create a note in Think with type 'Podcast Script'.
        </p>
      )}

      {!isPending && scripts.length > 0 && (
        <div className="ac-selector__list">
          {scripts.map((script) => (
            <button
              key={script.id}
              className="ac-selector__card"
              onClick={() => navigate(script.id)}
            >
              <span className="ac-selector__card-title">{script.title}</span>
              <span className="ac-selector__card-date">{formatDate(script.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
