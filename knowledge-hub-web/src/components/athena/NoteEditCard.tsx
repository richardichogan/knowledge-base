/**
 * components/athena/NoteEditCard.tsx — preview of edits Athena proposed to
 * the open Think note, with Apply / Discard. Applied inside the live editor
 * (one ⌘Z step); only enabled while the same note is open.
 */
import React, { useState } from 'react';
import type { NoteEdit } from '../../types';
import { renderMarkdown } from '../../utils/markdown';
import { applyNoteEdits } from '../../utils/noteEditApplier';
import { getActiveBlockNoteEditor, getActiveNoteId } from '../../utils/activeBlockNoteEditor';

const ACTION_LABEL: Record<NoteEdit['action'], string> = {
  append: 'Add to end',
  prepend: 'Add at top',
  add_to_section: 'Add to section',
  replace_section: 'Rewrite section',
  delete_section: 'Remove section',
  replace_text: 'Replace text',
  replace_all: 'Rewrite the whole note',
};

type Status = { state: 'pending' } | { state: 'applied'; failed: string[] } | { state: 'discarded' };

export const NoteEditCard: React.FC<{ edits: NoteEdit[]; noteId: string }> = ({ edits, noteId }) => {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  const [, rerender] = useState(0);
  const noteOpen = getActiveNoteId() === noteId && getActiveBlockNoteEditor() !== null;

  function apply(): void {
    const editor = getActiveBlockNoteEditor();
    if (editor === null || getActiveNoteId() !== noteId) { rerender((n) => n + 1); return; }
    const result = applyNoteEdits(editor, edits);
    setStatus({ state: 'applied', failed: result.failed });
  }

  return (
    <div className={`note-edit-card note-edit-card--${status.state}`}>
      <div className="note-edit-card__head">
        <span className="note-edit-card__title">Proposed change{edits.length === 1 ? '' : 's'} to this note</span>
        {status.state === 'applied' && <span className="note-edit-card__done">Applied{status.failed.length > 0 ? ' (partly)' : ''} — ⌘Z in the note to undo</span>}
        {status.state === 'discarded' && <span className="note-edit-card__done">Discarded</span>}
      </div>

      <ol className="note-edit-card__list">
        {edits.map((e, i) => (
          <li key={i} className="note-edit-card__item">
            <p className="note-edit-card__summary">
              <span className="note-edit-card__action">{ACTION_LABEL[e.action]}</span>
              {e.heading !== undefined && <span className="note-edit-card__target">“{e.heading}”</span>}
              {' '}{e.summary}
            </p>
            {e.action === 'replace_text' && (
              <div className="note-edit-card__diff">
                <del>{e.find}</del>
                <ins>{e.markdown}</ins>
              </div>
            )}
            {e.action !== 'replace_text' && e.action !== 'delete_section' && e.markdown !== undefined && status.state === 'pending' && (
              <div
                className="note-edit-card__preview ai-bubble-text--md"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: renderMarkdown(e.markdown) }}
              />
            )}
          </li>
        ))}
      </ol>

      {status.state === 'applied' && status.failed.length > 0 && (
        <p className="note-edit-card__failed">Couldn’t apply: {status.failed.join('; ')}</p>
      )}

      {status.state === 'pending' && (
        <div className="note-edit-card__actions">
          <button type="button" className="ai-feedback__action" disabled={!noteOpen} onClick={apply}>Apply</button>
          <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { setStatus({ state: 'discarded' }); }}>Discard</button>
          {!noteOpen && <span className="note-edit-card__hint">Open that note in Think to apply.</span>}
        </div>
      )}
    </div>
  );
};
