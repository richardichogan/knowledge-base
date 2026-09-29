/**
 * components/athena/RememberedNotice.tsx — confirms standing instructions
 * Athena saved during a turn ("Remembered: …") with a one-click Undo.
 */
import React, { useState } from 'react';
import { api } from '../../services/api';
import type { SavedMemory } from '../../types';

function scopeLabel(m: SavedMemory): string {
  if (m.scopeType === 'output') return `when producing ${m.scopeValue ?? 'that output'}`;
  if (m.scopeType === 'persona') return `${m.scopeValue ?? ''} persona`;
  if (m.scopeType === 'project') return `project ${m.scopeValue ?? ''}`;
  return 'everywhere';
}

export const RememberedNotice: React.FC<{ memories: SavedMemory[] }> = ({ memories }) => {
  const [undone, setUndone] = useState<Set<string>>(new Set());
  return (
    <div className="ai-remembered">
      {memories.map((m) => (
        <div key={m.id} className={`ai-remembered__item${undone.has(m.id) ? ' ai-remembered__item--undone' : ''}`}>
          <span className="ai-remembered__label">{undone.has(m.id) ? 'Forgotten' : 'Remembered'}</span>
          <span className="ai-remembered__text">{m.content}</span>
          <span className="ai-remembered__scope">· {scopeLabel(m)}</span>
          {!undone.has(m.id) && (
            <button
              type="button"
              className="ai-remembered__undo"
              onClick={() => { void api.deleteMemory(m.id).then(() => { setUndone((s) => new Set(s).add(m.id)); }); }}
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
