/**
 * Saves the conversation summary and transcript to Think without leaving the chat.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Export } from '@carbon/icons-react';
import { useAnchoredPopovers } from '../../hooks/useAnchoredPopovers';

interface MoveToThinkProps {
  sessionId: string;
  /** The chat's project, so the note is filed under it. */
  projectId: string;
  disabled: boolean;
  /** 'header' = an icon in the command bar; 'inline' = under a reply, opening upwards. */
  variant?: 'header' | 'inline';
  /** The older "summary + transcript" export. */
  onExportSummary: () => void;
  /** A note-linked panel must keep its conversation linked to the original note. */
  linkConversation?: boolean;
}

export const MoveToThink: React.FC<MoveToThinkProps> = ({ disabled, variant = 'header', onExportSummary }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useAnchoredPopovers(rootRef, open ? '.ai-move__panel' : null, variant === 'inline');

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => { if (busy === null && rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mousedown', onDown); };
  }, [open, busy]);

  return (
    <div className={`ai-move ai-move--${variant}`} ref={rootRef}
      onKeyDown={event => { if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation();
        if (busy === null) { setOpen(false); rootRef.current?.querySelector('button')?.focus(); }
      } }}>
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
            <input type="radio" name="move-kind" checked readOnly />
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
              onClick={() => { setOpen(false); onExportSummary(); }}
            >
              Save to Think
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
