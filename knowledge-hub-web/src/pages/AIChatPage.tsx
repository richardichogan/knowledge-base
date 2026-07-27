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
import { Send, Checkmark, Close, Renew, Microphone, StopFilled, VolumeUp, VolumeMute, Attachment, ChatLaunch, TrashCan, Add, Search } from '@carbon/icons-react';
import { api } from '../services/api';
import { renderMarkdown } from '../utils/markdown';
import type { ChatMessage, ChatSessionSummary, WriteActionProposal } from '../types';

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
      out = enrichSourceLinks(out);
      for (const [re, replacement] of STATUS_CHIP_RULES) {
        out = out.replace(re, replacement);
      }
      return out;
    })
    .join('');
}

// Turns a standalone "Link: <url>" line (e.g. after a create_note_draft
// reply) into a clickable button instead of a raw, awkward-to-read URL —
// only used for links that fall outside a task card block (see
// buildTaskCardHtml for the in-card version).
function enrichSourceLinks(text: string): string {
  return text.replace(/^Link:\s*(\S+)\s*$/gim, (_m, url: string) =>
    `<a class="kh-source-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">🔗 Open in Knowledge Hub</a>`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Short, scannable date for card display, e.g. "24 Jul 2026" — distinct from
// formatDateForSpeech() above, which spells the month out for TTS.
function formatDueDateShort(due: string): string {
  const m = due.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!m) return escapeHtml(due);
  const d = new Date(`${due}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return escapeHtml(due);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function statusChipHtml(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('progress')) return '<span class="kh-chip kh-chip--info">🔵 In progress</span>';
  if (s.includes('review')) return '<span class="kh-chip kh-chip--info">👀 To review</span>';
  if (s.includes('backlog')) return '<span class="kh-chip kh-chip--neutral">📥 Backlog</span>';
  if (s.includes('blocked')) return '<span class="kh-chip kh-chip--danger">⛔ Blocked</span>';
  if (s.includes('done') || s.includes('complete')) return '<span class="kh-chip kh-chip--success">✅ Done</span>';
  return `<span class="kh-chip kh-chip--neutral">${escapeHtml(status)}</span>`;
}

function priorityChipHtml(priority: string): string {
  const p = priority.toLowerCase();
  if (p === 'urgent') return '<span class="kh-chip kh-chip--danger">🔺 Urgent</span>';
  if (p === 'high') return '<span class="kh-chip kh-chip--danger">🔴 High priority</span>';
  if (p === 'medium' || p === 'normal') return '<span class="kh-chip kh-chip--warning">🟠 Medium priority</span>';
  if (p === 'low') return '<span class="kh-chip kh-chip--neutral">⚪ Low priority</span>';
  return `<span class="kh-chip kh-chip--neutral">${escapeHtml(priority)}</span>`;
}

// A single task summary block — "**Title**" followed by Status:/Priority:/
// Project:/Due: lines — rendered as a proper card rather than a wall of bold
// text and colons, so dense task-list replies are actually scannable.
function buildTaskCardHtml(title: string, fields: Record<string, string>, overdue: boolean): string {
  const priorityClass = fields.priority ? ` kh-task-card--${fields.priority.toLowerCase()}` : '';
  const overdueClass = overdue ? ' kh-task-card--overdue' : '';
  const metaRow = [
    fields.status ? statusChipHtml(fields.status) : '',
    fields.priority ? priorityChipHtml(fields.priority) : '',
  ].filter(Boolean).join('');
  const detailRow = [
    fields.project
      ? `<span class="kh-task-card__detail"><span class="kh-task-card__detail-icon">📁</span>${escapeHtml(fields.project)}</span>`
      : '',
    fields.due
      ? `<span class="kh-task-card__detail"><span class="kh-task-card__detail-icon">📅</span>${formatDueDateShort(fields.due)}</span>`
      : '',
  ].filter(Boolean).join('');
  return [
    `<div class="kh-task-card${priorityClass}${overdueClass}">`,
    overdue ? '<span class="kh-task-card__overdue-flag">⚠️ Overdue</span>' : '',
    `<div class="kh-task-card__title">${escapeHtml(title)}</div>`,
    metaRow ? `<div class="kh-task-card__meta">${metaRow}</div>` : '',
    detailRow ? `<div class="kh-task-card__details">${detailRow}</div>` : '',
    fields.link
      ? `<a class="kh-task-card__link" href="${escapeHtml(fields.link)}" target="_blank" rel="noreferrer">Open in Knowledge Hub →</a>`
      : '',
    '</div>',
  ].filter(Boolean).join('');
}

const TASK_TITLE_RE = /^\*\*(.+?)\*\*\s*$/;
const TASK_FIELD_RE = /^(Status|Priority|Project|Due|Link)\s*:\s*(.+)$/i;
const TASK_OVERDUE_RE = /^(?:⚠️\s*)?overdue\s*$/i;

// Scans assistant text line-by-line for task-summary blocks and swaps them
// for real cards, running everything else through the normal markdown +
// chip pipeline unchanged.
function renderAssistantMessage(raw: string): string {
  const lines = raw.split('\n');
  const htmlParts: string[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      htmlParts.push(renderMarkdown(enrichAssistantText(textBuf.join('\n'))));
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    let idx = i;
    let overdue = false;
    if (TASK_OVERDUE_RE.test((lines[idx] ?? '').trim())) {
      overdue = true;
      idx += 1;
    }
    const titleMatch = TASK_TITLE_RE.exec((lines[idx] ?? '').trim());
    if (titleMatch) {
      const fields: Record<string, string> = {};
      let j = idx + 1;
      while (j < lines.length) {
        const l = (lines[j] ?? '').trim();
        const fieldMatch = TASK_FIELD_RE.exec(l);
        if (fieldMatch) {
          fields[fieldMatch[1]!.toLowerCase()] = fieldMatch[2]!.trim();
          j += 1;
          continue;
        }
        if (TASK_OVERDUE_RE.test(l)) {
          overdue = true;
          j += 1;
          continue;
        }
        break;
      }
      if (Object.keys(fields).length >= 2) {
        flushText();
        htmlParts.push(buildTaskCardHtml(titleMatch[1] ?? '', fields, overdue));
        i = j;
        continue;
      }
    }
    textBuf.push(lines[i] ?? '');
    i += 1;
  }
  flushText();

  return htmlParts.join('\n');
}

// Relative time for messages sent today, absolute date prefix otherwise —
// keeps the timeline scannable without seconds-level noise.
function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return time;
  const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${datePart}, ${time}`;
}

// Compact relative label for the sidebar list ("2h ago", "3d ago", or a date
// once it's old enough that a relative label stops being useful).
function formatSessionTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Delegated click handler for the "Copy" button injected into fenced code
// blocks by renderMarkdown() — avoids attaching a listener per code block
// inside dangerouslySetInnerHTML content.
function handleCodeCopyClick(e: React.MouseEvent<HTMLElement>): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;
  const code = btn.parentElement?.querySelector('pre code');
  if (!code?.textContent) return;
  void navigator.clipboard.writeText(code.textContent).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('kh-code-copy-btn--copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('kh-code-copy-btn--copied');
    }, 1500);
  });
}

// Persisted so a page reload or reopening the standalone Athena PWA window
// restores the same conversation instead of starting blank — the backend
// now keeps history in Postgres (ai_chat_sessions/messages), so this just
// needs to remember which session ID to ask for.
const SESSION_STORAGE_KEY = 'kh-athena-session-id';

export const AIChatPage: React.FC<AIChatPageProps> = ({ compact = false, standalone = false }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [isRestoringHistory, setIsRestoringHistory] = useState(sessionId !== null);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [isSidebarSearchOpen, setIsSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Restore persisted history for a stored session ID once on mount, so a
  // reload or reopening the standalone Athena window continues the same
  // conversation instead of starting blank.
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    void api.getSessionHistory(sessionId).then((result) => {
      if (cancelled) return;
      if (result.success && result.data.messages.length > 0) {
        setMessages(result.data.messages);
      }
      setIsRestoringHistory(false);
    }).catch(() => {
      if (!cancelled) setIsRestoringHistory(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persistSessionId(id: string): void {
    setSessionId(id);
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, id);
    } catch {
      // localStorage can be unavailable (private browsing) — session still works in-memory.
    }
  }

  // The chat history sidebar is only shown in the standalone window (see JSX
  // below) — the floating widget stays compact rather than growing a sidebar.
  function refreshSessionList(): void {
    if (!standalone) return;
    void api.listChatSessions().then((result) => {
      if (result.success) setChatSessions(result.data.sessions);
    }).catch(() => {
      // Non-fatal — sidebar just won't update until the next successful load.
    });
  }

  useEffect(() => {
    refreshSessionList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelectSession(id: string): void {
    if (id === sessionId) return;
    stopTts();
    persistSessionId(id);
    setMessages([]);
    setPendingActions([]);
    setIsRestoringHistory(true);
    void api.getSessionHistory(id).then((result) => {
      if (result.success) setMessages(result.data.messages);
      setIsRestoringHistory(false);
    }).catch(() => {
      setIsRestoringHistory(false);
    });
  }

  function handleDeleteSession(id: string, e: React.MouseEvent): void {
    e.stopPropagation();
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;
    void api.deleteChatSession(id).then(() => {
      setChatSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === sessionId) handleNewChat();
    }).catch(() => {
      // Non-fatal — the item just won't disappear from the sidebar until reload.
    });
  }

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
      if (sessionId === null) persistSessionId(result.data.sessionId);
      appendMessage('assistant', result.data.reply);
      playReply(result.data.reply);
      refreshSessionList();
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

  function handleAttachClick(): void {
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (!/\.(md|markdown)$/i.test(file.name)) {
      appendMessage('assistant', '⚠️ Please attach a Markdown (.md) file — podcast notes, a newsletter draft, etc.');
      return;
    }
    const text = (await file.text()).trim();
    if (text === '') {
      appendMessage('assistant', `⚠️ "${file.name}" looks empty — there's nothing to add.`);
      return;
    }
    appendMessage('user', `📎 Uploaded ${file.name}`);
    // The AI's own create_note_draft / create_task tools do the real work here —
    // no separate preview modal, this rides the same chat + tool-calling flow
    // as every other message.
    const prompt = [
      `I'm attaching a markdown file named "${file.name}" — likely podcast notes, a newsletter draft, or similar source material. Please:`,
      '1. Save the full content to my Think library as a new note (use create_note_draft), choosing a sensible title and the best-fitting content type.',
      "2. If the content implies any concrete action items, create them as tasks (use create_task) — use your judgement, most notes won't need any.",
      '3. Reply with a brief, conversational summary: what you titled/saved the note as, and any tasks you created (or say you created none). Do not repeat the raw file content back to me.',
      '',
      `--- ${file.name} ---`,
      text.slice(0, 12000),
    ].join('\n');
    chatMutation.mutate(prompt);
  }

  function handleNewChat(): void {
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Non-fatal — worst case the old session ID lingers until overwritten by a new one.
    }
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

  const filteredSidebarSessions = sidebarSearchQuery.trim() === ''
    ? chatSessions
    : chatSessions.filter((s) => s.title.toLowerCase().includes(sidebarSearchQuery.trim().toLowerCase()));

  const actionButtons = (
    <>
      {messages.length > 0 && (
        <Button
          size="sm"
          kind="ghost"
          hasIconOnly
          renderIcon={Renew}
          iconDescription="New chat"
          tooltipPosition="bottom"
          onClick={handleNewChat}
          disabled={chatMutation.isPending}
        />
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
      {standalone && (
        <aside className="kh-chat-sidebar">
          <div className="kh-chat-sidebar__header">
            <div className="kh-chat-sidebar__brand">
              <img src="/favicon.svg" alt="" className="kh-chat-sidebar__logo" />
              <span>Athena</span>
            </div>
            <Button
              size="sm"
              kind="ghost"
              hasIconOnly
              renderIcon={Search}
              iconDescription="Search chats"
              tooltipPosition="right"
              className="kh-chat-sidebar__header-action"
              onClick={() => setIsSidebarSearchOpen((open) => !open)}
            />
          </div>
          <nav className="kh-chat-sidebar__nav">
            <button
              type="button"
              className="kh-chat-sidebar__nav-item"
              onClick={handleNewChat}
              disabled={chatMutation.isPending}
            >
              <Add className="kh-chat-sidebar__nav-icon" />
              New chat
            </button>
          </nav>
          {isSidebarSearchOpen && (
            <div className="kh-chat-sidebar__search">
              <Search className="kh-chat-sidebar__search-icon" />
              <input
                type="text"
                className="kh-chat-sidebar__search-input"
                placeholder="Search chats"
                value={sidebarSearchQuery}
                onChange={(e) => setSidebarSearchQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <div className="kh-chat-sidebar__section-label">Recents</div>
          <div className="kh-chat-sidebar__list">
            {chatSessions.length === 0 && (
              <p className="kh-chat-sidebar__empty">Your past chats with Athena will show up here.</p>
            )}
            {chatSessions.length > 0 && filteredSidebarSessions.length === 0 && (
              <p className="kh-chat-sidebar__empty">No chats match "{sidebarSearchQuery}".</p>
            )}
            {filteredSidebarSessions.map((s) => (
              <div
                key={s.id}
                className={
                  s.id === sessionId
                    ? 'kh-chat-sidebar__item kh-chat-sidebar__item--active'
                    : 'kh-chat-sidebar__item'
                }
                onClick={() => handleSelectSession(s.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSelectSession(s.id); }}
              >
                <div className="kh-chat-sidebar__item-main">
                  <div className="kh-chat-sidebar__item-title">{s.title}</div>
                  <div className="kh-chat-sidebar__item-time">{formatSessionTime(s.updatedAt)}</div>
                </div>
                <Button
                  size="sm"
                  kind="ghost"
                  hasIconOnly
                  renderIcon={TrashCan}
                  iconDescription="Delete chat"
                  tooltipPosition="right"
                  className="kh-chat-sidebar__delete"
                  onClick={(e) => handleDeleteSession(s.id, e)}
                />
              </div>
            ))}
          </div>
        </aside>
      )}
      <div className={standalone ? 'ai-chat-standalone__main' : ''}>
      {!compact && !standalone && (
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">Athena</h1>
          </div>
        </div>
      )}
      {standalone && (
        <div className="ai-chat-standalone__topbar ai-chat-standalone__topbar--minimal">
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

        <Tile className="ai-messages" onClick={handleCodeCopyClick}>
          {messages.length === 0 && isRestoringHistory && (
            <div className="ai-empty">
              <InlineLoading description="Restoring conversation…" />
            </div>
          )}
          {messages.length === 0 && !isRestoringHistory && (
            <div className="ai-empty">
              <ChatLaunch size={28} className="ai-empty__icon" />
              <p className="ai-empty__title">Athena</p>
              <p className="ai-empty__subtitle">Notes, tasks, commits, articles, sparks — ask anything.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={msg.role === 'user' ? 'ai-bubble ai-bubble--user' : 'ai-bubble ai-bubble--ai'}
            >
              <div className="ai-bubble-label">
                {msg.role === 'user' ? 'You' : 'Athena'}
              </div>
              {msg.role === 'user' ? (
                <div className="ai-bubble-text">{msg.content}</div>
              ) : (
                <div
                  className="ai-bubble-text ai-bubble-text--md"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: renderAssistantMessage(msg.content) }}
                />
              )}
              <div className="ai-bubble-time">{formatMessageTime(msg.timestamp)}</div>
            </div>
          ))}
          {chatMutation.isPending && (
            <div className="ai-bubble ai-bubble--ai">
              <InlineLoading description="Athena is thinking…" />
            </div>
          )}
          <div ref={bottomRef} />
        </Tile>

        <form onSubmit={handleSend} className="ai-input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,text/markdown"
            className="ai-file-input-hidden"
            onChange={(e) => { void handleFileSelected(e); }}
          />
          <div className="ai-input-field">
            <Button
              type="button"
              kind="ghost"
              hasIconOnly
              size="sm"
              renderIcon={Attachment}
              iconDescription="Attach a Markdown file"
              tooltipPosition="top"
              className="ai-attach-button ai-attach-button--inline"
              onClick={handleAttachClick}
              disabled={chatMutation.isPending}
            />
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
            <Button
              type="button"
              kind={isRecording ? 'danger' : 'ghost'}
              hasIconOnly
              size="sm"
              renderIcon={isRecording ? StopFilled : Microphone}
              iconDescription={isRecording ? 'Stop recording' : 'Voice input'}
              tooltipPosition="top"
              className="ai-mic-button ai-mic-button--inline"
              onClick={handleMicClick}
              disabled={chatMutation.isPending || isTranscribing}
            />
          </div>
          <Button
            type="submit"
            hasIconOnly
            renderIcon={Send}
            iconDescription="Send"
            tooltipPosition="top"
            className="ai-send-button"
            disabled={chatMutation.isPending || input.trim() === ''}
          />
        </form>
      </div>
      </div>
    </div>
  );
};

