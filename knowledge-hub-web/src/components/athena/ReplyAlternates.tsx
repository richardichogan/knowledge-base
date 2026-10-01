/**
 * components/athena/ReplyAlternates.tsx — "Ask another model" under one of
 * Athena's replies: re-answer the same question with GPT-4o, GPT-5.4 or
 * GPT-6 Astra (streamed live), compare the answers as tabs, and "Use this
 * one" to make an alternative the answer the chat continues from.
 */
import React, { useEffect, useRef, useState } from 'react';
import { InlineLoading } from '@carbon/react';
import { ChevronDown } from '@carbon/icons-react';
import { api } from '../../services/api';
import { followChatTurn, TurnStoppedError } from '../../services/chatTurns';
import type { ChatAlternate, ModelChoiceApi } from '../../types';
import { renderAssistantMessage } from './renderReply';

interface ReplyAlternatesProps {
  sessionId: string;
  messageId: string;
  alternates: ChatAlternate[];
  models: ModelChoiceApi[];
  renderContext: Parameters<typeof renderAssistantMessage>[1];
  /** A new alternative arrived. */
  onAdded: (alt: ChatAlternate) => void;
  /** "Use this one" swapped it in: the reply's new text, and the refreshed alternatives. */
  onUsed: (messageId: string, content: string) => void;
}

export const ReplyAlternates: React.FC<ReplyAlternatesProps> = ({ sessionId, messageId, alternates, models, renderContext, onAdded, onUsed }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState<{ label: string; activity: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => { controllerRef.current?.abort(); }, []);

  const ask = (model: ModelChoiceApi): void => {
    setMenuOpen(false);
    setError(null);
    setRunning({ label: model.label, activity: 'Starting', text: '' });
    const controller = new AbortController();
    controllerRef.current = controller;
    void api.askAnotherModel(sessionId, messageId, model.id)
      .then((start) => {
        if (!start.success) throw new Error(start.error.message);
        return followChatTurn<ChatAlternate>(start.data.turnId, {
          onActivity: (activity) => { setRunning((r) => (r === null ? r : { ...r, activity })); },
          onText: (text) => { setRunning((r) => (r === null ? r : { ...r, text })); },
        }, controller.signal);
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error.message);
        const alt: ChatAlternate = { ...result.data, createdAt: new Date().toISOString() };
        onAdded(alt);
        setSelected(alt.id);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || err instanceof TurnStoppedError) return;
        setError(`${model.label} couldn’t answer: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => { if (controllerRef.current === controller) setRunning(null); });
  };

  const shown = alternates.find((a) => a.id === selected) ?? (selected === null ? undefined : alternates[alternates.length - 1]);

  return (
    <div className="ai-alts">
      <div className="ai-alts__bar">
        {alternates.length > 0 && (
          <div className="ai-alts__tabs" role="tablist" aria-label="Other answers">
            {alternates.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={shown?.id === a.id}
                className={`ai-alts__tab${shown?.id === a.id ? ' ai-alts__tab--on' : ''}`}
                onClick={() => { setSelected(shown?.id === a.id ? null : a.id); }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        <span className="ai-alts__ask">
          <button
            type="button"
            className="ai-alts__ask-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={running !== null}
            onClick={() => { setMenuOpen((o) => !o); }}
          >
            Ask another model <ChevronDown size={12} aria-hidden="true" />
          </button>
          {menuOpen && (
            <ul className="ai-alts__menu" role="menu">
              {models.map((m) => (
                <li key={m.id} role="none">
                  <button type="button" role="menuitem" onClick={() => { ask(m); }}>{m.label}</button>
                </li>
              ))}
            </ul>
          )}
        </span>
      </div>

      {running !== null && (
        <div className="ai-alts__panel" aria-live="polite">
          <div className="ai-alts__panel-head">{running.label}</div>
          {running.text !== '' && (
            <div
              className="ai-bubble-text ai-bubble-text--md"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: renderAssistantMessage(running.text, renderContext) }}
            />
          )}
          <InlineLoading description={`${running.text !== '' ? 'Writing' : running.activity}…`} />
        </div>
      )}
      {error !== null && <p className="ai-alts__error" role="alert">{error}</p>}

      {running === null && shown !== undefined && (
        <div className="ai-alts__panel">
          <div className="ai-alts__panel-head">
            {shown.label}{shown.model === 'original' ? ' — the answer you replaced' : ''}
            <button
              type="button"
              className="ai-output__primary ai-alts__use"
              onClick={() => {
                void api.useAlternate(shown.id).then((r) => {
                  if (!r.success) { setError('Couldn’t switch to that answer.'); return; }
                  setSelected(null);
                  onUsed(r.data.messageId, r.data.content);
                });
              }}
            >
              Use this one
            </button>
          </div>
          <div
            className="ai-bubble-text ai-bubble-text--md"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderAssistantMessage(shown.content, renderContext) }}
          />
        </div>
      )}
    </div>
  );
};
