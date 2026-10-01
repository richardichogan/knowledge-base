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
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const saveEdit = (): void => {
    if (editing === null) return;
    const { id, text } = editing;
    setEditing(null);
    if (text.trim() === '') return;
    void api.updateMemory(id, { content: text.trim() }).then((r) => {
      if (r.success) setEdited((e) => ({ ...e, [id]: r.data.content }));
    });
  };

  return (
    <div className="ai-remembered">
      {memories.map((m) => (
        <div key={m.id} className={`ai-remembered__item${undone.has(m.id) ? ' ai-remembered__item--undone' : ''}`}>
          <span className="ai-remembered__label">{undone.has(m.id) ? 'Forgotten' : 'Remembered'}</span>
          {editing?.id === m.id ? (
            <input
              className="ai-remembered__input"
              value={editing.text}
              autoFocus
              aria-label="Edit what Athena remembers"
              onChange={(e) => { setEditing({ id: m.id, text: e.target.value }); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={saveEdit}
            />
          ) : (
            <span className="ai-remembered__text">{edited[m.id] ?? m.content}</span>
          )}
          <span className="ai-remembered__scope">· {scopeLabel(m)}</span>
          {!undone.has(m.id) && editing?.id !== m.id && (
            <>
              <button
                type="button"
                className="ai-remembered__undo"
                onClick={() => { setEditing({ id: m.id, text: edited[m.id] ?? m.content }); }}
              >
                Edit
              </button>
              <button
                type="button"
                className="ai-remembered__undo"
                onClick={() => { void api.deleteMemory(m.id).then(() => { setUndone((s) => new Set(s).add(m.id)); }); }}
              >
                Undo
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
};
