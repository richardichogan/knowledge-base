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
import { Send, Checkmark, Close, Renew, Microphone, StopFilled, VolumeUp, VolumeMute } from '@carbon/icons-react';
import { api } from '../services/api';
import { renderMarkdown } from '../utils/markdown';
import type { ChatMessage, WriteActionProposal } from '../types';

interface AIChatPageProps {
  /** Renders without the page header/wrapper padding, for use in a floating widget. */
  compact?: boolean;
  /** Renders as a centered, full-height desktop layout, for use as an installed PWA (see /chat route). */
  standalone?: boolean;
}

// Azure Speech STT reliably handles PCM WAV only, so we capture raw 16kHz mono
// PCM via AudioContext and encode a WAV ourselves — same approach as the
// client-demo FNOL/Steward voice components, ported for this app's Foundry
// Speech instance.
const STT_SAMPLE_RATE = 16000;

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, (samples[i] ?? 0) * 32768));
  }
  const dataLen = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const le = true;
  v.setUint32(0, 0x52494646, false); // 'RIFF'
  v.setUint32(4, 36 + dataLen, le);
  v.setUint32(8, 0x57415645, false); // 'WAVE'
  v.setUint32(12, 0x666d7420, false); // 'fmt '
  v.setUint32(16, 16, le);
  v.setUint16(20, 1, le);
  v.setUint16(22, 1, le);
  v.setUint32(24, sampleRate, le);
  v.setUint32(28, sampleRate * 2, le);
  v.setUint16(32, 2, le);
  v.setUint16(34, 16, le);
  v.setUint32(36, 0x64617461, false); // 'data'
  v.setUint32(40, dataLen, le);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error as Error);
    reader.readAsDataURL(blob);
  });
}

// Converts an ISO YYYY-MM-DD date to a natural spoken form, e.g. "29 April
// 2026" instead of reading out each digit group. Falls back to the raw
// string if it doesn't parse as a real date.
function formatDateForSpeech(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// Strip markdown syntax before TTS so voice replies read as clean, natural
// prose. Also drops IDs/URLs — those are useful to see on screen but tedious
// and unhelpful to hear read aloud; the spoken reply should stick to the
// salient points (status, priority, due date, etc.).
function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*(ID|Url|URL|Link)\s*:.*$/gim, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    // ISO dates (e.g. "2026-04-29") → natural spoken date. Must run before
    // the slug un-concatenation below, or the hyphens here would just get
    // split into "2026 04 29" instead of a real date.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (iso) => formatDateForSpeech(iso))
    // Slugs like "ibm-thought-leadership" or paths like "owner/repo" read as
    // one garbled run-on word — split hyphens/underscores/slashes into
    // separate words so project and repo names are actually intelligible.
    .replace(/\b[a-zA-Z0-9]+(?:[-_/][a-zA-Z0-9]+)+\b/g, (slug) => slug.replace(/[-_/]/g, ' '))
    .replace(/&/g, ' and ')
    .replace(/[—–]/g, ', ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, '')
    .replace(/[!?]{2,}/g, (m) => m.charAt(0))
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .replace(/\.\s*\.\s*/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Colour-coded status chip rules applied to assistant replies before markdown
// rendering — turns plain-text status words into small pill badges so dense
// task-list replies are scannable at a glance instead of a wall of text.
const STATUS_CHIP_RULES: Array<[RegExp, string]> = [
  [/\bhigh priority\b/gi, '<span class="kh-chip kh-chip--danger">🔴 High priority</span>'],
  [/\bmedium priority\b/gi, '<span class="kh-chip kh-chip--warning">🟠 Medium priority</span>'],
  [/\blow priority\b/gi, '<span class="kh-chip kh-chip--neutral">⚪ Low priority</span>'],
  [/\bin progress\b/gi, '<span class="kh-chip kh-chip--info">🔵 In progress</span>'],
  [/\bto-review\b/gi, '<span class="kh-chip kh-chip--info">👀 To review</span>'],
  [/\bbacklog\b/gi, '<span class="kh-chip kh-chip--neutral">📥 Backlog</span>'],
  [/\boverdue\b/gi, '<span class="kh-chip kh-chip--danger">⚠️ Overdue</span>'],
];

// Turns "Overdue tasks: N" (bolded or plain) into a prominent alert banner
// instead of a plain heading — the single most important line in a task
// summary reply deserves to stand out.
function enrichOverdueBanner(text: string): string {
  return text.replace(/\*{0,2}Overdue tasks:\s*(\d+)\*{0,2}/gi, (_match, n: string) => {
    const count = parseInt(n, 10);
    if (count === 0) return '<div class="kh-alert kh-alert--success">✅ No overdue tasks</div>';
    return `<div class="kh-alert kh-alert--danger">⚠️ <strong>${count}</strong> overdue task${count === 1 ? '' : 's'} need attention</div>`;
  });
}

// Applies the chip/banner enrichment to assistant text only, skipping the
// inside of fenced code blocks so real code snippets are left untouched.
function enrichAssistantText(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced code block — leave as-is
      let out = enrichOverdueBanner(part);
      for (const [re, replacement] of STATUS_CHIP_RULES) {
        out = out.replace(re, replacement);
      }
      return out;
    })
    .join('');
}

export const AIChatPage: React.FC<AIChatPageProps> = ({ compact = false, standalone = false }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingActions, setPendingActions] = useState<WriteActionProposal[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceOutputOn, setVoiceOutputOn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const queryClient = useQueryClient();

  function stopTts(): void {
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
      ttsAudioRef.current = null;
    }
  }

  function playReply(text: string): void {
    if (!voiceOutputOn) return;
    const clean = stripMarkdownForSpeech(text);
    if (clean === '') return;
    stopTts();
    void api.synthesizeVoice(clean).then((result) => {
      if (!result.success) return;
      const audio = new Audio(`data:${result.data.mimeType};base64,${result.data.audioBase64}`);
      ttsAudioRef.current = audio;
      void audio.play().catch(() => {
        // Autoplay can be blocked without a user gesture — non-fatal, text reply still shown.
      });
      audio.onended = () => { ttsAudioRef.current = null; };
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

  async function startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor();
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated but remains the most broadly supported
      // way to get raw PCM samples synchronously — same choice as client-demo.
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      pcmChunksRef.current = [];
      processor.onaudioprocess = (e) => {
        pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      audioCtxRef.current = ctx;
      processorRef.current = processor;
      streamRef.current = stream;
      setIsRecording(true);
    } catch {
      appendMessage('assistant', '⚠️ Could not access the microphone. Check your browser permissions and try again.');
    }
  }

  async function stopRecording(): Promise<void> {
    const ctx = audioCtxRef.current;
    const processor = processorRef.current;
    const stream = streamRef.current;
    if (!ctx || !processor) {
      setIsRecording(false);
      return;
    }
    processor.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    const nativeSampleRate = ctx.sampleRate;
    await ctx.close();
    audioCtxRef.current = null;
    processorRef.current = null;
    streamRef.current = null;
    setIsRecording(false);

    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    if (totalLen === 0) return;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    // Downsample to 16kHz mono for the Azure Speech REST API.
    const ratio = nativeSampleRate / STT_SAMPLE_RATE;
    const resampled = new Float32Array(Math.round(merged.length / ratio));
    for (let i = 0; i < resampled.length; i++) {
      resampled[i] = merged[Math.min(merged.length - 1, Math.round(i * ratio))] ?? 0;
    }
    const wavBlob = encodeWav(resampled, STT_SAMPLE_RATE);

    setIsTranscribing(true);
    try {
      const audioBase64 = await blobToBase64(wavBlob);
      const result = await api.transcribeVoice(audioBase64, 'audio/wav');
      const text = result.success ? result.data.text.trim() : '';
      if (text !== '') {
        // Speaking a message auto-enables spoken replies for the rest of the
        // session, matching FNOL/Steward — typing doesn't opt you back in.
        setVoiceOutputOn(true);
        appendMessage('user', text);
        chatMutation.mutate(text);
      }
    } catch {
      appendMessage('assistant', '⚠️ Could not transcribe that recording. Please try again or type your message.');
    } finally {
      setIsTranscribing(false);
    }
  }

  function handleMicClick(): void {
    if (isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  }

  const actionButtons = (
    <>
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
      <Button
        size="sm"
        kind="ghost"
        hasIconOnly
        renderIcon={voiceOutputOn ? VolumeUp : VolumeMute}
        iconDescription={voiceOutputOn ? 'Voice replies on — click to mute' : 'Voice replies off — click to enable'}
        tooltipPosition="bottom"
        className="ai-voice-toggle"
        onClick={() => { stopTts(); setVoiceOutputOn((v) => !v); }}
      />
    </>
  );

  return (
    <div className={standalone ? 'ai-chat-standalone' : compact ? 'ai-chat-compact' : 'page-root'}>
      {!compact && !standalone && (
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">AI Chat</h1>
          </div>
        </div>
      )}
      {standalone && (
        <div className="ai-chat-standalone__topbar">
          <div className="ai-chat-standalone__brand">
            <img src="/favicon.svg" alt="" className="ai-chat-standalone__logo" />
            <span>Knowledge Hub</span>
          </div>
          <div className="ai-new-chat-row ai-chat-standalone__actions">
            {actionButtons}
          </div>
        </div>
      )}
      {!standalone && (
        <div className="ai-new-chat-row">
          {actionButtons}
        </div>
      )}
      <div className={standalone ? 'ai-chat-standalone__body' : ''}>
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
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(enrichAssistantText(msg.content)) }}
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
          <Button
            type="button"
            kind={isRecording ? 'danger' : 'ghost'}
            hasIconOnly
            renderIcon={isRecording ? StopFilled : Microphone}
            iconDescription={isRecording ? 'Stop recording' : 'Voice input'}
            tooltipPosition="top"
            className="ai-mic-button"
            onClick={handleMicClick}
            disabled={chatMutation.isPending || isTranscribing}
          />
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
    </div>
  );
};

