/**
 * Receipts for directly applied note edits, or Apply/Discard for explicitly
 * requested previews. All edits use the protected live editor and save path.
 */
import React, { useState } from 'react';
import type { NoteEdit } from '../../types';
import type { NoteEditDeliveryResult } from '../../types/ai';
import { renderMarkdown } from '../../utils/markdown';
import { applyNoteEdits } from '../../utils/noteEditApplier';
import { getActiveBlockNoteEditor, getActiveNoteId, isActiveScriptEditor, runNoteAction } from '../../utils/activeBlockNoteEditor';

const ACTION_LABEL: Record<NoteEdit['action'], string> = {
  append: 'Add to end',
  prepend: 'Add at top',
  add_to_section: 'Add to section',
  replace_section: 'Rewrite section',
  delete_section: 'Remove section',
  replace_text: 'Replace text',
  replace_all: 'Rewrite the whole note',
  set_section_direction: 'Set section delivery direction',
};

const LONG_PREVIEW_WORDS = 220;

function wordCount(markdown: string | undefined): number {
  return markdown === undefined ? 0 : (markdown.match(/\S+/g) ?? []).length;
}

type Status = { state: 'pending' } | { state: 'applied'; failed: string[] } | { state: 'discarded' };

export const NoteEditCard: React.FC<{ edits: NoteEdit[]; noteId: string; result?: NoteEditDeliveryResult | undefined }> = ({ edits, noteId, result }) => {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  const [, rerender] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalWords = edits.reduce((n, e) => n + wordCount(e.markdown), 0);
  const noteOpen = getActiveNoteId() === noteId && getActiveBlockNoteEditor() !== null;

  async function apply(): Promise<void> {
    if (applying) return;
    const editor = getActiveBlockNoteEditor();
    if (editor === null || getActiveNoteId() !== noteId) { rerender((n) => n + 1); return; }
    setApplying(true);
    setError(null);
    try {
      const protect = edits.some(edit => ['replace_all', 'replace_section', 'replace_text', 'delete_section'].includes(edit.action));
      let failed: string[] = [];
      await runNoteAction(noteId, protect, () => {
        failed = applyNoteEdits(editor, edits, { script: isActiveScriptEditor() }).failed;
      });
      setStatus({ state: 'applied', failed });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm the note save. Check the note before repeating the edit.');
    } finally { setApplying(false); }
  }

  if (result) return (
    <div className={`note-edit-card note-edit-card--${result.state === 'blocked' ? 'pending' : 'applied'}`}>
      <div className="note-edit-card__head">
        <span className="note-edit-card__title">{result.state === 'saved' ? 'Note updated' : result.state === 'partial' ? 'Note partly updated' : 'Note update not confirmed'}</span>
        {result.state !== 'blocked' && <span className="note-edit-card__done" role="status">Saved — Ctrl/⌘Z in the note to undo</span>}
      </div>
      <ol className="note-edit-card__list">
        {edits.map((edit, index) => <li key={index} className="note-edit-card__item"><p className="note-edit-card__summary">{edit.summary}</p></li>)}
      </ol>
      {result.failed.length > 0 && <p className="note-edit-card__failed" role="alert">Couldn’t apply: {result.failed.join('; ')}</p>}
      {result.error && <p className="note-edit-card__failed" role="alert">{result.error}</p>}
    </div>
  );
  return (
    <div className={`note-edit-card note-edit-card--${status.state}`}>
      <div className="note-edit-card__head">
        <span className="note-edit-card__title">
          Proposed change{edits.length === 1 ? '' : 's'} to this note
          {(edits.length > 1 || totalWords > LONG_PREVIEW_WORDS) && (
            <span className="note-edit-card__size"> · {edits.length.toString()} edit{edits.length === 1 ? '' : 's'}{totalWords > 0 ? `, about ${totalWords.toLocaleString('en-GB')} words` : ''}</span>
          )}
        </span>
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
            {e.action === 'set_section_direction' && <p className="note-edit-card__summary">{e.direction || 'Clear delivery direction'}</p>}
            {e.action !== 'replace_text' && e.action !== 'delete_section' && e.markdown !== undefined && status.state === 'pending' && (
              <>
                <div
                  className={`note-edit-card__preview ai-bubble-text--md${wordCount(e.markdown) > LONG_PREVIEW_WORDS && !expanded.has(i) ? ' note-edit-card__preview--clamped' : ''}`}
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(e.markdown) }}
                />
                {wordCount(e.markdown) > LONG_PREVIEW_WORDS && (
                  <button
                    type="button"
                    className="note-edit-card__more"
                    onClick={() => { setExpanded((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; }); }}
                  >
                    {expanded.has(i) ? 'Show less' : `Show all ${wordCount(e.markdown).toLocaleString('en-GB')} words`}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      {status.state === 'applied' && status.failed.length > 0 && (
        <p className="note-edit-card__failed">Couldn’t apply: {status.failed.join('; ')}</p>
      )}

      {status.state === 'pending' && (
        <div className="note-edit-card__actions">
          <button type="button" className="ai-feedback__action" disabled={!noteOpen || applying} onClick={() => { void apply(); }}>{applying ? 'Preserving note...' : 'Apply'}</button>
          <button type="button" className="ai-feedback__action ai-feedback__action--quiet" disabled={applying} onClick={() => { setStatus({ state: 'discarded' }); }}>Discard</button>
          {!noteOpen && <span className="note-edit-card__hint">Open that note in Think to apply.</span>}
        </div>
      )}
      {error !== null && <p role="alert" className="note-edit-card__failed">{error}</p>}
    </div>
  );
};
