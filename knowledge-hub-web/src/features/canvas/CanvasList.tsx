/**
 * CanvasList.tsx
 * Grid of canvas cards with create / delete actions.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Add, TrashCan, Diagram } from '@carbon/icons-react';
import { InlineLoading } from '@carbon/react';
import { api } from '../../services/api';
import type { CanvasSummaryApi } from '../../services/api';

interface Props { onSelect?: (id: string) => void; }

export const CanvasList: React.FC<Props> = ({ onSelect }) => {
  const queryClient  = useQueryClient();
  const [creating,   setCreating]   = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: canvases = [], isLoading, isError } = useQuery<CanvasSummaryApi[]>({
    queryKey: ['canvases'],
    queryFn: async () => {
      const r = await api.listCanvases();
      return r.success && r.data ? r.data : [];
    },
  });

  async function handleCreate(): Promise<void> {
    setCreating(true);
    const r = await api.createCanvas('Untitled Canvas');
    if (r.success && r.data) {
      await queryClient.invalidateQueries({ queryKey: ['canvases'] });
      onSelect?.(r.data.id);
    }
    setCreating(false);
  }

  async function handleDelete(e: React.MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    if (!window.confirm('Delete this canvas? This cannot be undone.')) return;
    setDeletingId(id);
    await api.deleteCanvas(id);
    await queryClient.invalidateQueries({ queryKey: ['canvases'] });
    setDeletingId(null);
  }

  if (isLoading) return <InlineLoading description="Loading canvases…" />;
  if (isError)   return <p className="cv-list-error">Failed to load canvases.</p>;

  return (
    <div className="cv-list-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Canvas</h1>
          <p className="page-subtitle">{canvases.length} canvas{canvases.length !== 1 ? 'es' : ''}</p>
        </div>
        <button
          className="kh-btn-accent"
          onClick={() => { void handleCreate(); }}
          disabled={creating}
        >
          {creating ? <InlineLoading /> : <><Add size={16} /> New canvas</>}
        </button>
      </div>

      {canvases.length === 0 ? (
        <div className="cv-list-empty">
          <Diagram size={48} />
          <p>No canvases yet. Create one to start thinking spatially.</p>
        </div>
      ) : (
        <div className="cv-list-grid">
          {canvases.map((c) => (
            <div
              key={c.id}
              className="cv-card"
              role="button"
              tabIndex={0}
              onClick={() => { onSelect?.(c.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(c.id); }}
            >
              <div className="cv-card__icon"><Diagram size={20} /></div>
              <div className="cv-card__body">
                <span className="cv-card__title">{c.title}</span>
                {c.description && <span className="cv-card__desc">{c.description}</span>}
                {c.project && <span className="cv-card__project">{c.project}</span>}
                <span className="cv-card__date">
                  {new Date(c.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              </div>
              <button
                className="cv-card__delete"
                title="Delete canvas"
                disabled={deletingId === c.id}
                onClick={(e) => { void handleDelete(e, c.id); }}
              >
                <TrashCan size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
