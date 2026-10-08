/**
 * Saves a structured first-draft note or summary without leaving the chat.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Export } from '@carbon/icons-react';
import { api } from '../../services/api';
import { createNote } from '../../notes/noteStorage';
import { markdownToNoteBlocks } from '../../notes/markdownToBlocks';
import { alertDialog } from '../../services/appDialogs';

interface MoveToThinkProps {
  sessionId: string;
  /** The chat's project, so the note is filed under it. */
  projectId: string;
  disabled: boolean;
  /** 'header' = the pill at the top of the thread; 'inline' = under a reply, opening upwards. */
  variant?: 'header' | 'inline';
  /** The older "summary + transcript" export. */
  onExportSummary: () => void;
}

export const MoveToThink: React.FC<MoveToThinkProps> = ({ sessionId, projectId, disabled, variant = 'header', onExportSummary }) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'spec' | 'summary'>('spec');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => { if (busy === null && rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mousedown', onDown); };
  }, [open, busy]);

  async function createSpec(): Promise<void> {
    let savedTitle: string | null = null;
    setError(null);
    setBusy('Writing the first draft from this chat… about 15–30 seconds');
    try {
      const draft = await api.draftSpecFromSession(sessionId);
      if (!draft.success) throw new Error(draft.error.message);
      setBusy('Creating the note…');
      const note = await createNote({ title: draft.data.title, contentType: 'note', contentJson: JSON.stringify(markdownToNoteBlocks(draft.data.markdown)) }, projectId !== '' ? projectId : undefined);
      if (note === null) throw new Error('The note could not be saved.');
      savedTitle = note.title;
      void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      const linked = await api.linkSessionToNote(sessionId, note.id, draft.data.title);
      if (!linked.success) {
        setOpen(false);
        await alertDialog(`"${note.title}" was saved to Think, but the conversation could not be linked: ${linked.error.message}. Your chat remains here.`, { title: 'Note saved; linking failed', tone: 'danger' });
        return;
      }
      setOpen(false);
      await alertDialog(`"${note.title}" has been saved to Think.`, { title: 'Saved to Think', tone: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      if (savedTitle !== null) {
        setOpen(false);
        await alertDialog(`"${savedTitle}" was saved to Think, but the conversation could not be linked: ${message}. Your chat remains here.`, { title: 'Note saved; linking failed', tone: 'danger' });
      } else setError(message);
    } finally { setBusy(null); }
  }

  return (
    <div className={`ai-move${variant === 'inline' ? ' ai-move--inline' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="ai-move__button"
        aria-expanded={open}
        aria-label="Save to Think"
        title="Save this conversation as a Think note without leaving chat"
        disabled={disabled}
        onClick={() => { setOpen((o) => !o); setError(null); }}
      >
        <Export size={16} aria-hidden="true" />
        <span className="ai-move__label">Save to Think</span>
      </button>
      {open && (
        <div className="ai-move__panel" role="dialog" aria-label="Save to Think">
          <h3 className="ai-move__title">Save to Think</h3>
          <label className="ai-move__option">
            <input type="radio" name="move-kind" checked={kind === 'spec'} onChange={() => { setKind('spec'); }} disabled={busy !== null} />
            <span>
              <strong>Spec note</strong>
              <span className="ai-move__hint">A structured first draft from this conversation: what you&rsquo;ve established, decisions, open questions, sources. Saved to Think; your chat stays here.</span>
            </span>
          </label>
          <label className="ai-move__option">
            <input type="radio" name="move-kind" checked={kind === 'summary'} onChange={() => { setKind('summary'); }} disabled={busy !== null} />
            <span>
              <strong>Summary and transcript</strong>
              <span className="ai-move__hint">An archive copy. The chat stays here.</span>
            </span>
          </label>
          {busy !== null && <p className="ai-move__status" role="status">{busy}</p>}
          {error !== null && <p className="ai-move__error" role="alert">{error}</p>}
          <div className="ai-move__actions">
            <button type="button" className="ai-move__cancel" onClick={() => { setOpen(false); }} disabled={busy !== null}>Cancel</button>
            <button
              type="button"
              className="ai-move__go"
              disabled={busy !== null}
              onClick={() => { if (kind === 'spec') void createSpec(); else { setOpen(false); onExportSummary(); } }}
            >
              {kind === 'spec' ? 'Create spec note' : 'Save to Think'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
