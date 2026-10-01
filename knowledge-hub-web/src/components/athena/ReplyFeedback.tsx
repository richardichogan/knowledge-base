/**
 * components/athena/ReplyFeedback.tsx — 👍 / 👎 on an Athena reply.
 *  👍  saves the reply as an example for its persona (Memory page).
 *  👎  asks what should change, then offers a suggested standing
 *      instruction to Save (active) or Dismiss — never applied silently.
 */
import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown } from '@carbon/icons-react';
import { api } from '../../services/api';
import { getPersona } from './personas';
import type { AthenaMemory, AthenaPersona } from '../../types';

interface ReplyFeedbackProps {
  reply: string;
  persona: AthenaPersona | undefined;
  sessionId: string | null;
}

type State =
  | { step: 'idle' }
  | { step: 'liked'; memoryId: string | null }
  | { step: 'asking'; note: string; sending: boolean }
  | { step: 'suggested'; memory: AthenaMemory }
  | { step: 'done'; message: string };

export const ReplyFeedback: React.FC<ReplyFeedbackProps> = ({ reply, persona, sessionId }) => {
  const [state, setState] = useState<State>({ step: 'idle' });

  function like(): void {
    setState({ step: 'liked', memoryId: null });
    void api.sendReplyFeedback({ sessionId, rating: 'up', replyContent: reply, persona: persona ?? 'general' })
      .then((r) => { if (r.success && r.data.memory !== null) setState({ step: 'liked', memoryId: r.data.memory.id }); })
      .catch(() => { setState({ step: 'idle' }); });
  }

  function undoLike(memoryId: string): void {
    void api.deleteMemory(memoryId).then(() => { setState({ step: 'done', message: 'Removed — not kept as an example.' }); });
  }

  function sendDown(note: string): void {
    setState({ step: 'asking', note, sending: true });
    void api.sendReplyFeedback({ sessionId, rating: 'down', comment: note, replyContent: reply, persona: persona ?? 'general' })
      .then((r) => {
        if (r.success && r.data.memory !== null) setState({ step: 'suggested', memory: r.data.memory });
        else setState({ step: 'done', message: 'Thanks — feedback noted.' });
      })
      .catch(() => { setState({ step: 'asking', note, sending: false }); });
  }

  function decide(memory: AthenaMemory, status: 'active' | 'dismissed'): void {
    void api.updateMemory(memory.id, { status }).then(() => {
      setState({ step: 'done', message: status === 'active' ? 'Saved — Athena will follow this from now on.' : 'Dismissed.' });
    });
  }

  const active = state.step !== 'idle';
  return (
    <div className={`ai-feedback${active ? ' ai-feedback--active' : ''}`}>
      {(state.step === 'idle' || state.step === 'liked') && (
        <div className="ai-feedback__buttons">
          <button
            type="button"
            className={`ai-feedback__btn${state.step === 'liked' ? ' ai-feedback__btn--on' : ''}`}
            aria-label="Good reply — save as an example"
            title="Good reply — save as an example"
            disabled={state.step === 'liked'}
            onClick={like}
          >
            <ThumbsUp size={14} />
          </button>
          {state.step === 'idle' && (
            <button
              type="button"
              className="ai-feedback__btn"
              aria-label="Could be better — tell Athena what to change"
              title="Could be better — tell Athena what to change"
              onClick={() => { setState({ step: 'asking', note: '', sending: false }); }}
            >
              <ThumbsDown size={14} />
            </button>
          )}
          {state.step === 'liked' && (
            <span className="ai-feedback__msg">
              Saved as an example of a good {getPersona(persona).label} reply — Athena follows its style.
              {state.memoryId !== null && (
                <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { undoLike(state.memoryId!); }}>Undo</button>
              )}
            </span>
          )}
        </div>
      )}

      {state.step === 'asking' && (
        <form
          className="ai-feedback__form"
          onSubmit={(e) => { e.preventDefault(); if (state.note.trim() !== '') sendDown(state.note.trim()); }}
        >
          <input
            className="ai-feedback__input"
            placeholder="What should be different next time?"
            aria-label="What should be different next time?"
            value={state.note}
            autoFocus
            disabled={state.sending}
            onChange={(e) => { setState({ step: 'asking', note: e.target.value, sending: false }); }}
          />
          <button type="submit" className="ai-feedback__action" disabled={state.sending || state.note.trim() === ''}>
            {state.sending ? 'Drafting…' : 'Send'}
          </button>
          <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { setState({ step: 'idle' }); }}>
            Cancel
          </button>
        </form>
      )}

      {state.step === 'suggested' && (
        <div className="ai-feedback__suggestion">
          <span className="ai-feedback__label">Suggested instruction</span>
          <span className="ai-feedback__text">{state.memory.content}</span>
          <div className="ai-feedback__row">
            <button type="button" className="ai-feedback__action" onClick={() => { decide(state.memory, 'active'); }}>Save</button>
            <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { decide(state.memory, 'dismissed'); }}>Dismiss</button>
          </div>
        </div>
      )}

      {state.step === 'done' && <span className="ai-feedback__msg">{state.message}</span>}
    </div>
  );
};
