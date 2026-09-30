/**
 * components/athena/MapChangeCard.tsx — preview of changes Athena proposed to
 * the open mind map, with Apply / Discard. Applied through the open map editor
 * when it's showing (instant, ⌘Z to undo), otherwise saved directly.
 */
import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MapChange } from '../../types';
import { api } from '../../services/api';
import { getActiveMindMap } from '../../features/canvas/activeMindMap';

type Status = 'pending' | 'applying' | 'applied' | 'discarded' | 'failed';

export const MapChangeCard: React.FC<{ changes: MapChange[]; mapId: string }> = ({ changes, mapId }) => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('pending');
  const [error, setError] = useState('');

  async function apply(): Promise<void> {
    const ops = changes.flatMap((c) => c.ops);
    const editor = getActiveMindMap(mapId);
    if (editor !== null) {
      editor.commit(ops);
      setStatus('applied');
      return;
    }
    setStatus('applying');
    const r = await api.applyCanvasOps(mapId, ops);
    if (!r.success) { setError(r.error.message); setStatus('failed'); return; }
    queryClient.setQueryData(['canvas', mapId], r.data);
    void queryClient.invalidateQueries({ queryKey: ['canvases'] });
    setStatus('applied');
  }

  return (
    <div className={`note-edit-card note-edit-card--${status === 'applied' ? 'applied' : status === 'discarded' ? 'discarded' : 'pending'}`}>
      <div className="note-edit-card__head">
        <span className="note-edit-card__title">Proposed change{changes.length === 1 ? '' : 's'} to this map</span>
        {status === 'applied' && <span className="note-edit-card__done">Applied — ⌘Z in the map to undo</span>}
        {status === 'discarded' && <span className="note-edit-card__done">Discarded</span>}
      </div>
      <ol className="note-edit-card__list">
        {changes.map((c, i) => (
          <li key={i} className="note-edit-card__item"><p className="note-edit-card__summary">{c.summary}</p></li>
        ))}
      </ol>
      {status === 'failed' && <p className="note-edit-card__failed">Couldn’t apply: {error}</p>}
      {(status === 'pending' || status === 'failed' || status === 'applying') && (
        <div className="note-edit-card__actions">
          <button type="button" className="ai-feedback__action" disabled={status === 'applying'} onClick={() => { void apply(); }}>
            {status === 'applying' ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { setStatus('discarded'); }}>Discard</button>
        </div>
      )}
    </div>
  );
};
