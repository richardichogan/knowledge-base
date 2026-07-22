/**
 * AIChatPage — streaming AI conversation with write-action confirmation.
 * Renders full-page (Discover-style) by default, or `compact` for use inside
 * the floating chat widget (FloatingAIChat.tsx) — same logic, lighter chrome.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  TextInput,
  Tile,
  InlineLoading,
} from '@carbon/react';
import { Send, Checkmark, Close, Renew, Microphone, MicrophoneOff, VolumeUp, VolumeMute } from '@carbon/icons-react';
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
  const [voiceConfig, setVoiceConfig] = useState({ speechToText: false, textToSpeech: false });
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceOutputOn, setVoiceOutputOn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    void api.getVoiceConfig().then((result) => {
      if (result.success) setVoiceConfig(result.data);
    });
  }, []);

  function playReply(text: string): void {
    if (!voiceOutputOn || !voiceConfig.textToSpeech) return;
    void api.textToSpeech(text).then((blob) => {
      const url = URL.createObjectURL(blob);
      audioPlayerRef.current?.pause();
      const audio = new Audio(url);
      audioPlayerRef.current = audio;
      void audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
    }).catch(() => {
      // Voice output is a nice-to-have — fail silently rather than surfacing an error bubble.
    });
  }

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
      playReply(result.data.reply);
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

  async function handleMicClick(): Promise<void> {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setIsRecording(false);
        setIsTranscribing(true);
        void api.speechToText(blob)
          .then((result) => {
            if (result.success && result.data.text.trim() !== '') {
              setInput((prev) => (prev.trim() === '' ? result.data.text : `${prev} ${result.data.text}`));
            }
          })
          .finally(() => setIsTranscribing(false));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      appendMessage('assistant', '⚠️ Could not access the microphone. Check your browser permissions and try again.');
    }
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
      {(messages.length > 0 || voiceConfig.textToSpeech) && (
        <div className="ai-new-chat-row">
          {messages.length > 0 && (
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
          )}
          {voiceConfig.textToSpeech && (
            <Button
              size="sm"
              kind="ghost"
              hasIconOnly
              renderIcon={voiceOutputOn ? VolumeUp : VolumeMute}
              iconDescription={voiceOutputOn ? 'Voice replies on — click to mute' : 'Voice replies off — click to enable'}
              tooltipPosition="bottom"
              className="ai-voice-toggle"
              onClick={() => setVoiceOutputOn((v) => !v)}
            />
          )}
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
            placeholder={isRecording ? 'Listening…' : isTranscribing ? 'Transcribing…' : 'Ask your knowledge hub…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={chatMutation.isPending}
            autoFocus
          />
        </div>
        {voiceConfig.speechToText && (
          <Button
            type="button"
            kind={isRecording ? 'danger' : 'ghost'}
            hasIconOnly
            renderIcon={isRecording ? MicrophoneOff : Microphone}
            iconDescription={isRecording ? 'Stop recording' : 'Voice input'}
            tooltipPosition="top"
            className="ai-mic-button"
            onClick={() => void handleMicClick()}
            disabled={chatMutation.isPending || isTranscribing}
          />
        )}
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

