/**
 * components/today/TodayDocumentsCard.tsx
 * Recently updated notes list with a placeholder relatedness line.
 * Documents table does not exist yet — notes only for now.
 */

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchNotes } from '../../notes/noteStorage';
import type { NoteListItem } from '../../notes/types';

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Recently worked-on notes with stub relatedness lines. */
export const TodayDocumentsCard: React.FC = () => {
  const notesQuery = useQuery({
    queryKey: ['today-notes-recent'],
    queryFn: () => fetchNotes(),
  });

  const notes: NoteListItem[] = (notesQuery.data ?? [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);

  return (
    <div className="today-section-card">
      <div className="today-section-card__header">
        <span className="today-section-card__title">Recently worked on</span>
        <Link to="/think" style={{ fontSize: 12, color: 'var(--cds-text-secondary)' }}>
          All notes →
        </Link>
      </div>

      {notesQuery.isLoading && (
        <p style={{ padding: '12px 16px', fontSize: 13, color: 'var(--cds-text-secondary)', margin: 0 }}>
          Loading…
        </p>
      )}

      {!notesQuery.isLoading && notes.length === 0 && (
        <p style={{ padding: '12px 16px', fontSize: 13, color: 'var(--cds-text-secondary)', margin: 0 }}>
          No notes yet.
        </p>
      )}

      {notes.map((n) => (
        <div key={n.id} className="today-doc-row">
          <div className="today-ranked-row__body">
            <div className="today-ranked-row__title">
              <Link to="/think" style={{ color: 'inherit' }}>
                {n.title || 'Untitled note'}
              </Link>
            </div>
            <div className="today-ranked-row__context">
              <span className="today-doc-row__badge">Note</span>
              {' · '}
              {timeAgo(n.updatedAt)}
            </div>
            <div className="today-doc-row__relatedness">
              {/* TODO — wire to GET /api/connections/:nodeId once Gap 5 (nodes/edges) lands. See 03b-sparks-recovery.md. */}
              No connections yet
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
