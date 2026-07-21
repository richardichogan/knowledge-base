/**
 * AIChatPage — streaming AI conversation with write-action confirmation.
 * Renders full-page (Discover-style) by default, or `compact` for use inside
 * the floating chat widget (FloatingAIChat.tsx) — same logic, lighter chrome.
 */

import React, { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  TextInput,
  Tile,
  InlineLoading,
} from '@carbon/react';
import { Send, Checkmark, Close, Renew } from '@carbon/icons-react';
import { api } from '../services/api';
import { renderMarkdown } from '../utils/markdown';
import type { ChatMessage, WriteActionProposal } from '../types';

interface AIChatPageProps {
  /** Renders without the page header/wrapper padding, for use in a floating widget. */
  compact?: boolean;
}

export const AIChatPage: React.FC<AIChatPageProps> = ({ compact = false }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingActions, setPendingActions] = useState<WriteActionProposal[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const chatMutation = useMutation({
    mutationFn: (message: string) =>
      api.chat({
        message,
        ...(sessionId !== null && { sessionId }),
      }),
    onSuccess: (result) => {
      if (!result.success) {
        appendMessage('assistant', `Error: ${result.error.message}`);
        return;
      }
      if (sessionId === null) setSessionId(result.data.sessionId);
      appendMessage('assistant', result.data.reply);
      if (result.data.pendingActions.length > 0) {
        setPendingActions((prev) => [...prev, ...result.data.pendingActions]);
      }
      // The AI may have created/updated tasks or notes via tool calls this turn —
      // refresh the relevant lists so they show up without a manual reload.
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    },
    onError: (err: unknown) => {
      const isTimeout =
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'ECONNABORTED';
      appendMessage(
        'assistant',
        isTimeout
          ? "⚠️ That took too long and timed out. The backend may still be working on it — try again in a moment, or ask a more specific question."
          : '⚠️ Something went wrong sending that message. Please try again.',
      );
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) => api.confirmAction(id),
    onSuccess: (result, id) => {
      if (result.success) {
        setPendingActions((prev) => prev.filter((a) => a.id !== id));
        appendMessage('assistant', '✅ Action confirmed and executed.');
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelAction(id),
    onSuccess: (_, id) => {
      setPendingActions((prev) => prev.filter((a) => a.id !== id));
    },
  });

  function appendMessage(role: 'user' | 'assistant', content: string): void {
    setMessages((prev) => [
      ...prev,
      { role, content, timestamp: new Date().toISOString() },
    ]);
  }

  function handleSend(e: React.FormEvent): void {
    e.preventDefault();
    const text = input.trim();
    if (text === '') return;
    appendMessage('user', text);
    setInput('');
    chatMutation.mutate(text);
  }

  function handleNewChat(): void {
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
  }

  return (
    <div className={compact ? 'ai-chat-compact' : 'page-root'}>
      {!compact && (
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">AI Chat</h1>
          </div>
        </div>
      )}
      {messages.length > 0 && (
        <div className="ai-new-chat-row">
          <Button
            size="sm"
            kind="ghost"
            renderIcon={Renew}
            iconDescription="New chat"
            onClick={handleNewChat}
            disabled={chatMutation.isPending}
          >
            New chat
          </Button>
        </div>
      )}
      {pendingActions.map((action) => (
        <Tile key={action.id} className="ai-action-banner">
          <p className="ai-action-desc">{action.description}</p>
          <div className="ai-action-buttons">
            <Button
              size="sm"
              kind="primary"
              renderIcon={Checkmark}
              iconDescription="Confirm"
              onClick={() => confirmMutation.mutate(action.id)}
              disabled={confirmMutation.isPending}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              kind="ghost"
              renderIcon={Close}
              iconDescription="Cancel"
              onClick={() => cancelMutation.mutate(action.id)}
              disabled={cancelMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </Tile>
      ))}

      <Tile className="ai-messages">
        {messages.length === 0 && (
          <p className="ai-empty">Ask anything about your knowledge hub…</p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={msg.role === 'user' ? 'ai-bubble ai-bubble--user' : 'ai-bubble ai-bubble--ai'}
          >
            <div className="ai-bubble-label">
              {msg.role === 'user' ? 'You' : 'Knowledge Hub AI'}
            </div>
            {msg.role === 'user' ? (
              <div className="ai-bubble-text">{msg.content}</div>
            ) : (
              <div
                className="ai-bubble-text ai-bubble-text--md"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
              />
            )}
          </div>
        ))}
        {chatMutation.isPending && (
          <div className="ai-bubble ai-bubble--ai">
            <InlineLoading description="Knowledge Hub AI is thinking…" />
          </div>
        )}
        <div ref={bottomRef} />
      </Tile>

      <form onSubmit={handleSend} className="ai-input-row">
        <div className="ai-input-field">
          <TextInput
            id="ai-chat-input"
            labelText=""
            hideLabel
            placeholder="Ask your knowledge hub…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={chatMutation.isPending}
            autoFocus
          />
        </div>
        <Button
          type="submit"
          renderIcon={Send}
          iconDescription="Send"
          disabled={chatMutation.isPending || input.trim() === ''}
        >
          Send
        </Button>
      </form>
    </div>
  );
};

