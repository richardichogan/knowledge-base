/**
 * AIChatPage — streaming AI conversation with write-action confirmation.
 * Renders full-page (Discover-style) by default, or `compact` for use inside
 * the floating chat widget (FloatingAIChat.tsx) — same logic, lighter chrome.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Button,
  Tile,
  InlineLoading,
} from '@carbon/react';
import { Send, Checkmark, Close, Renew, Microphone, StopFilled, VolumeUp, VolumeMute, Attachment, ChatLaunch, TrashCan, Add, Search, Menu, ChevronLeft, ChevronRight, Idea, Notebook, Export, Compass, Copy, Blog } from '@carbon/icons-react';
import { api } from '../services/api';
import { PROJECTS } from '../config/projects';
import { renderMarkdown } from '../utils/markdown';
import { createNote } from '../notes/noteStorage';
import { markdownToNoteBlocks } from '../notes/markdownToBlocks';
import type { ContentType } from '../notes/constants';
import type { ChatMessage, ChatSessionSummary, WriteActionProposal, AthenaPersona } from '../types';

import type { AthenaPageContext } from '../context/AthenaContext';

type AthenaThinkContentType = Extract<ContentType, 'blog' | 'newsletter'>;

interface PendingThinkSave {
  response: ChatMessage;
  messageIndex: number;
  projectId: string;
  projectName: string;
  title: string;
  prompt: string;
}

interface AIChatPageProps {
  /** Renders without the page header/wrapper padding, for use in a floating widget. */
  compact?: boolean;
  /** Adapts compact controls for constrained embedded surfaces. */
  compactVariant?: 'default' | 'narrow';
  /** Renders as a centered, full-height desktop layout, for use as an installed PWA (see /chat route). */
  standalone?: boolean;
  /**
   * Optional context about the currently selected/visible item in the app.
   * When provided, Athena is primed with this context so questions like
   * "what is this?" or "summarise this" make sense without re-explaining.
   */
  pageContext?: AthenaPageContext | undefined;
  /**
   * Persona this page opens into by default (and resets to on "New chat"),
   * instead of "general". Used by dedicated persona pages like /blog-post.
   * The user can still switch personas via the switcher — this only sets
   * the starting point and its own separate chat history.
   */
  initialPersona?: AthenaPersona;
  /** Overrides the "Athena" page-header title (page-root layout only). */
  title?: string;
  /**
   * Reports whether Athena is currently generating a reply. Used by embedded
   * surfaces (e.g. the Think metadata sidebar) that want to show a live
   * status indicator in their own outer header instead of duplicating one
   * inside this component.
   */
  onBusyChange?: ((busy: boolean) => void) | undefined;
}

// Azure Speech STT reliably handles PCM WAV only, so we capture raw 16kHz mono
// PCM via AudioContext and encode a WAV ourselves — same approach as the
// client-demo FNOL/Steward voice components, ported for this app's Foundry
// Speech instance.
const STT_SAMPLE_RATE = 16000;
// Cap on how much of an attached file's text we send as pageContext.detail.
// Was 12,000 chars — far too small for meeting transcripts (a ~52KB transcript
// got cut off before the Q&A section, so Athena answered as if no questions had
// been asked at all). 100,000 chars (~25k tokens) comfortably covers most
// documents/transcripts while staying well under the backend's 1mb JSON body limit.
const ATTACHED_FILE_CONTEXT_CHAR_LIMIT = 100000;
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function isChatImage(file: File): boolean {
  return CHAT_IMAGE_TYPES.has(file.type.toLowerCase());
}

function clipboardImageName(mimeType: string): string {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] ?? 'png';
  return `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

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

function stripMarkdownForTitle(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveThinkTitle(response: string, projectName?: string): string {
  const heading = response
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line));
  const source = stripMarkdownForTitle(heading ?? response).split(/[.!?\n]/)[0]?.trim() ?? '';
  const title = source === '' ? 'Athena response' : source.slice(0, 90);
  return projectName && projectName !== 'personal' ? `${projectName}: ${title}` : title;
}

const ATHENA_DEFAULT_PROJECT_ID = 'ibm-thought-leadership';

function inferAthenaContentType(response: string, prompt: string, title: string): AthenaThinkContentType | null {
  const titleText = stripMarkdownForTitle(title).toLowerCase();
  const combined = `${title}\n${prompt}\n${response}`.toLowerCase();
  const newsletterSignal =
    /\bnewsletter\b/.test(combined) ||
    /\breaching for the cloud\b/.test(combined) ||
    /\bedition\s+\d+\b/.test(titleText);
  const blogSignal =
    /\bblog post\b/.test(combined) ||
    /\bquick post\b/.test(combined) ||
    /\bfull post\b/.test(combined) ||
    /\bcms package\b/.test(combined) ||
    /\bthe microsoft cloud blog\b/.test(combined);

  if (newsletterSignal && !blogSignal) return 'newsletter';
  if (blogSignal && !newsletterSignal) return 'blog';
  if (/\bnewsletter edition\b/.test(titleText)) return 'newsletter';
  return null;
}

function parseAthenaThinkContentTypeChoice(text: string): AthenaThinkContentType | null {
  const normalised = text.trim().toLowerCase();
  if (/\bnewsletter\b/.test(normalised)) return 'newsletter';
  if (/\bblog\b/.test(normalised)) return 'blog';
  return null;
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
//
// The floating in-app widget and the standalone /chat window are separate
// contexts (quick lookup vs a dedicated deep-work session) and each gets its
// own storage key so they no longer show the same conversation.
const SESSION_STORAGE_KEY_STANDALONE = 'kh-athena-session-id-standalone';
const SESSION_STORAGE_KEY_WIDGET = 'kh-athena-session-id-widget';
const SESSION_STORAGE_KEY_PAGE = 'kh-athena-session-id-page';

// Mobile breakpoint shared with the CSS in global.scss (.kh-chat-sidebar,
// .ai-float-panel mobile rules) — keep these in sync.
const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)';

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
  ));
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = (): void => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

export const AIChatPage: React.FC<AIChatPageProps> = ({
  compact = false,
  compactVariant = 'default',
  standalone = false,
  pageContext,
  initialPersona,
  title,
  onBusyChange,
}) => {
  // The Think-embedded panel manages its own per-note session (see the
  // note-linking effect below) instead of sharing localStorage-persisted
  // session state with the floating widget / full-page chat.
  const isNoteLinkedPanel = compact && compactVariant === 'narrow';
  const currentNoteId = isNoteLinkedPanel && pageContext?.type === 'note' ? pageContext.id : undefined;
  const SESSION_STORAGE_KEY = standalone
    ? SESSION_STORAGE_KEY_STANDALONE
    : isNoteLinkedPanel
      ? '' // no shared localStorage session for the Think-embedded panel — its session is driven entirely by the note-linking effect below.
      : compact
        ? SESSION_STORAGE_KEY_WIDGET
        : `${SESSION_STORAGE_KEY_PAGE}-${initialPersona ?? 'general'}`;
  const isMobile = useIsMobile();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [savingResponseIndex, setSavingResponseIndex] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (isNoteLinkedPanel) return null;
    try {
      return window.localStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [isRestoringHistory, setIsRestoringHistory] = useState(sessionId !== null);
  const [noteSummary, setNoteSummary] = useState<string | null>(null);
  const [isNoteSummaryLoading, setIsNoteSummaryLoading] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [isSidebarSearchOpen, setIsSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [input, setInput] = useState('');
  const [persona, setPersona] = useState<AthenaPersona>(initialPersona ?? 'general');
  const [activeProjectId, setActiveProjectId] = useState('');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [pendingActions, setPendingActions] = useState<WriteActionProposal[]>([]);
  const [pendingThinkSave, setPendingThinkSave] = useState<PendingThinkSave | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingImagePreviewUrl, setPendingImagePreviewUrl] = useState<string | null>(null);
  const [activeImageContext, setActiveImageContext] = useState<AthenaPageContext | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ filename: string; percent: number } | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState('personal');
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);

  const projectsQuery = useQuery({
    queryKey: ['projects', 'athena-upload'],
    queryFn: async () => {
      const res = await api.getProjects();
      return res.success && res.data.length > 0 ? res.data : PROJECTS;
    },
    staleTime: 30_000,
  });
  const uploadProjectOptions = projectsQuery.data && projectsQuery.data.length > 0 ? projectsQuery.data : PROJECTS;
  const uploadProjectName = uploadProjectOptions.find((p) => p.id === uploadProjectId)?.name ?? uploadProjectId;

  // Auto-grow the message textarea up to a max height, then let it scroll —
  // recalculated whenever the input text changes.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 200;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [input]);

  useEffect(() => {
    if (pendingFile === null || !isChatImage(pendingFile)) {
      setPendingImagePreviewUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(pendingFile);
    setPendingImagePreviewUrl(previewUrl);
    return () => { URL.revokeObjectURL(previewUrl); };
  }, [pendingFile]);
  /** Prevents the Android Share auto-send from firing more than once per page load. */
  const shareProcessedRef = useRef(false);
  /** Tracks the last pageContext title we've already injected into a message, so
   *  switching to a different note/canvas mid-session re-primes Athena instead
   *  of only ever doing it once for a brand new session. */
  const lastInjectedContextTitleRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Restore persisted history for a stored session ID once on mount, so a
  // reload or reopening the standalone Athena window continues the same
  // conversation instead of starting blank. The Think-embedded panel skips
  // this entirely — its session/history is restored per-note by the
  // note-linking effect further down instead.
  useEffect(() => {
    if (isNoteLinkedPanel) return;
    if (sessionId === null) return;
    let cancelled = false;
    void api.getSessionHistory(sessionId).then((result) => {
      if (cancelled) return;
      if (result.success && result.data.messages.length > 0) {
        setMessages(result.data.messages);
      }
      if (result.success && result.data.persona) {
        setPersona(result.data.persona);
      }
      if (result.success) setActiveProjectId(result.data.projectId ?? '');
      setIsRestoringHistory(false);
    }).catch(() => {
      if (!cancelled) setIsRestoringHistory(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Generates (or regenerates) the on-demand note summary card shown when
   * the currently-linked note has no chat started yet.
   */
  async function loadNoteSummary(noteTitle: string, noteDetail: string): Promise<void> {
    setNoteSummary(null);
    setIsNoteSummaryLoading(true);
    const result = await api.summarizeNote(noteTitle, noteDetail);
    setNoteSummary(result.success ? result.data.summary : null);
    setIsNoteSummaryLoading(false);
  }

  /** Tracks the note id the panel is currently showing a chat/summary for, so switching notes is only handled once per note. */
  const noteSwitchTrackingRef = useRef<string | null>(null);

  // Think-embedded panel only: whenever the user switches to a different
  // note, load that note's existing chat if one was already started, or
  // clear to a fresh chat and show an on-demand summary card if not —
  // instead of always showing whatever chat happened to be open before.
  useEffect(() => {
    if (!isNoteLinkedPanel || currentNoteId === undefined) return;
    if (noteSwitchTrackingRef.current === currentNoteId) return;
    noteSwitchTrackingRef.current = currentNoteId;

    let cancelled = false;
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
    setNoteSummary(null);
    setIsRestoringHistory(true);

    void api.getSessionIdForNote(currentNoteId).then(async (result) => {
      if (cancelled) return;
      const linkedSessionId = result.success ? result.data.sessionId : null;
      if (linkedSessionId !== null) {
        setSessionId(linkedSessionId);
        const history = await api.getSessionHistory(linkedSessionId);
        if (cancelled) return;
        if (history.success) {
          setMessages(history.data.messages);
          if (history.data.persona) setPersona(history.data.persona);
          setActiveProjectId(history.data.projectId ?? '');
        }
        setIsRestoringHistory(false);
      } else {
        setIsRestoringHistory(false);
        await loadNoteSummary(pageContext?.title ?? 'Untitled', pageContext?.detail ?? '');
      }
    }).catch(() => {
      if (!cancelled) setIsRestoringHistory(false);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNoteId]);

  function persistSessionId(id: string): void {
    setSessionId(id);
    if (SESSION_STORAGE_KEY === '') return; // Think-embedded panel — session tracked via note-linking, not localStorage.
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, id);
    } catch {
      // localStorage can be unavailable (private browsing) — session still works in-memory.
    }
  }

  // Android Share Target handler — fires once history restore is complete so
  // the auto-sent message lands in a fresh conversation without overwriting
  // existing history. Params come from the manifest share_target GET action:
  // /chat?title=...&text=...&url=...
  useEffect(() => {
    if (isRestoringHistory) return;
    if (shareProcessedRef.current) return;
    const sharedTitle = searchParams.get('title') ?? '';
    const sharedUrl   = searchParams.get('url')   ?? '';
    const sharedText  = searchParams.get('text')  ?? '';
    if (!sharedTitle && !sharedUrl && !sharedText) return;

    shareProcessedRef.current = true;
    // Clean the share params from the URL so a reload doesn't re-trigger.
    setSearchParams({}, { replace: true });

    const contextLines: string[] = ['[Shared from Android]'];
    if (sharedTitle) contextLines.push(`Title: ${sharedTitle}`);
    if (sharedUrl)   contextLines.push(`URL: ${sharedUrl}`);
    if (sharedText && sharedText.trim() !== sharedUrl.trim()) contextLines.push(`Description: ${sharedText}`);

    // The user-visible bubble is a short label; the message Athena receives
    // has full context and the question — mirrors the file-upload pattern.
    const displayLabel = `📤 Shared: ${sharedTitle || sharedUrl || sharedText.slice(0, 60)}`;
    const athenaMessage = [
      contextLines.join('\n'),
      '',
      'The user has shared a link from Android.',
      'First, ask a concise clarification question and wait for their reply.',
      'Offer these options: Spark, blog source, Think note, Discover item, or chat-only.',
      'Do not create, update, or file anything until the user explicitly chooses one option.',
    ].join('\n');

    appendMessage('user', displayLabel);
    chatMutation.mutate({ text: athenaMessage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestoringHistory]);

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
    setIsMobileSidebarOpen(false);
    if (id === sessionId) return;
    stopTts();
    persistSessionId(id);
    setMessages([]);
    setPendingActions([]);
    setPendingThinkSave(null);
    setIsRestoringHistory(true);
    void api.getSessionHistory(id).then((result) => {
      if (result.success) setMessages(result.data.messages);
      if (result.success && result.data.persona) setPersona(result.data.persona);
      if (result.success) setActiveProjectId(result.data.projectId ?? '');
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
    onMutate: () => {
      // Fresh controller per turn — Stop only ever aborts the request that's actually in flight.
      chatAbortControllerRef.current = new AbortController();
    },
    mutationFn: ({ text, pageContext: ctx }: { text: string; pageContext?: AthenaPageContext }) =>
      api.chat(
        {
          message: text,
          persona,
          projectId: activeProjectId !== '' ? activeProjectId : null,
          ...(sessionId !== null && { sessionId }),
          ...(ctx && { pageContext: ctx }),
          ...(isNoteLinkedPanel && currentNoteId !== undefined && { noteId: currentNoteId }),
        },
        chatAbortControllerRef.current?.signal,
      ),
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
      // User pressed Stop — the request was deliberately aborted client-side. Not a real
      // failure, but confirm it visibly so it's clear Stop actually did something. The reply
      // (if the backend finishes generating it anyway) is simply discarded from here on.
      if (axios.isCancel(err) || (err instanceof Error && err.name === 'CanceledError')) {
        appendMessage('assistant', '⏹️ Stopped.');
        return;
      }
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

  /** Aborts the in-flight chat request. The backend keeps running to completion, but the UI stops waiting and discards whatever comes back. */
  function handleStopGenerating(): void {
    chatAbortControllerRef.current?.abort();
  }

  useEffect(() => {
    onBusyChange?.(chatMutation.isPending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMutation.isPending]);

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
    if (role === 'user') {
      // Scroll immediately so the user's own message (and the "thinking"
      // indicator) is visible right away, rather than only once the reply
      // arrives — a reply can take 10-60s, during which the view previously
      // stayed scrolled to wherever it was before sending.
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }

  function handleSend(e: React.FormEvent): void {
    e.preventDefault();
    void submitMessage();
  }

  async function handleCopyMessage(content: string, index: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1800);
    } catch {
      // Clipboard access denied/unavailable — silently ignore, nothing else we can do.
    }
  }

  /** Shift+Enter submits from the textarea — Enter and Ctrl+Enter just insert a newline (native textarea behaviour). */
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  }

  async function submitMessage(): Promise<void> {
    const text = input.trim() || (pendingFile !== null && isChatImage(pendingFile)
      ? 'What is shown in this image?'
      : '');
    if (text === '') return;

    if (pendingThinkSave !== null) {
      appendMessage('user', text);
      setInput('');
      const contentType = parseAthenaThinkContentTypeChoice(text);
      if (contentType === null) {
        appendMessage('assistant', 'Please reply with either **blog** or **newsletter** so I can save the pending Athena response to Think.');
        return;
      }
      const save = pendingThinkSave;
      setPendingThinkSave(null);
      await persistResponseToThink(save, contentType);
      return;
    }

    if (pendingFile !== null) {
      await uploadAttachedFile(pendingFile, text);
      return;
    }

    appendMessage('user', text);
    setInput('');
    // Tell Athena what the user is currently viewing on the first message of a
    // session, or whenever they've navigated to a different note/canvas/item
    // since we last told her about one — otherwise she keeps answering with
    // stale or no context. Sent as a separate `pageContext` field (not glued
    // into the message text) so the backend can search using only what the
    // user actually typed, rather than running full-text search using an
    // entire note's body as the query — which used to drag in unrelated
    // same-project documents as "background context".
    const isFirstMessage = messages.length === 0 && sessionId === null;
    const contextChanged = pageContext !== undefined && lastInjectedContextTitleRef.current !== pageContext.title;
    if (activeImageContext !== null) {
      chatMutation.mutate({ text, pageContext: activeImageContext });
    } else if ((isFirstMessage || contextChanged) && pageContext) {
      lastInjectedContextTitleRef.current = pageContext.title;
      chatMutation.mutate({ text, pageContext });
    } else {
      chatMutation.mutate({ text });
    }
  }

  function handleAttachClick(): void {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    if (!isChatImage(file) && !/\.(md|markdown|txt|docx|xlsx|pptx|pdf)$/i.test(file.name)) {
      appendMessage(
        'assistant',
        '⚠️ Please attach an image (PNG, JPEG, WebP, or GIF), Markdown, text, Word, Excel, PowerPoint, or PDF file.',
      );
      return;
    }

    setPendingFile(file);
    textareaRef.current?.focus();
  }

  function handleInputPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const imageItem = Array.from(e.clipboardData.items).find(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    );
    if (imageItem === undefined) return;

    const imageBlob = imageItem.getAsFile();
    if (imageBlob === null || !CHAT_IMAGE_TYPES.has(imageBlob.type.toLowerCase())) {
      appendMessage('assistant', '⚠️ Pasted images must be PNG, JPEG, WebP, or GIF.');
      return;
    }

    e.preventDefault();
    const imageFile = new File(
      [imageBlob],
      clipboardImageName(imageBlob.type),
      { type: imageBlob.type, lastModified: Date.now() },
    );
    setPendingFile(imageFile);
    textareaRef.current?.focus();
  }

  async function uploadAttachedFile(file: File, question: string): Promise<void> {
    setUploadProgress({ filename: file.name, percent: 0 });
    try {
      let fileText: string;
      let storedIn: string;
      let extraNote = '';

      if (isChatImage(file)) {
        const res = await api.analyzeChatImage(file, question);
        if (!res.success) throw new Error(res.error?.message ?? 'image analysis failed');
        fileText = res.data.analysis;
        storedIn = 'this chat only';
      } else if (/\.(md|markdown)$/i.test(file.name)) {
        fileText = (await file.text()).trim();
        if (fileText === '') throw new Error('the file is empty');
        setUploadProgress({ filename: file.name, percent: 60 });
        const title = file.name.replace(/\.(md|markdown)$/i, '');
        const note = await createNote({
          title,
          contentType: 'note',
          contentJson: JSON.stringify(markdownToNoteBlocks(fileText)),
        }, uploadProjectId);
        if (!note) throw new Error('could not save the file to Think');
        storedIn = `Think under ${uploadProjectName}`;
      } else {
        const res = await api.uploadDocument(file, uploadProjectId, undefined, uploadProjectName, (percent) => {
          setUploadProgress({ filename: file.name, percent });
        });
        if (!res.success) throw new Error(res.error?.message ?? 'upload failed');
        fileText = res.data.text;
        storedIn = `the Documents library under ${res.data.projectName}`;
        if (res.data.truncated) extraNote = ' The extract below is truncated because the file is large.';
      }

      setUploadProgress({ filename: file.name, percent: 100 });
      setPendingFile(null);
      setInput('');
      appendMessage('user', `${question}\n\n${isChatImage(file) ? '🖼️' : '📎'} ${file.name}`);
      // Send the attached file's content as pageContext (not glued into the message
      // text) for the same reason as viewed-note context: gluing a large document
      // into the message meant the auto-RAG search ran full-text search using the
      // whole file as the query, dragging in unrelated matches.
      if (fileText.length > ATTACHED_FILE_CONTEXT_CHAR_LIMIT) {
        extraNote += ' The content below is truncated because the file is very large.';
      }
      const attachedContext: AthenaPageContext = {
        type: isChatImage(file) ? 'image' : 'document',
        title: file.name,
        detail: isChatImage(file)
          ? `Ephemeral image pasted into this chat (not stored). Visual analysis:\n\n${fileText}`
          : `Stored in ${storedIn}.${extraNote} Full content:\n\n${fileText.slice(0, ATTACHED_FILE_CONTEXT_CHAR_LIMIT)}`,
      };
      if (isChatImage(file)) setActiveImageContext(attachedContext);
      chatMutation.mutate({
        text: question,
        pageContext: attachedContext,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendMessage('assistant', `⚠️ Couldn't upload "${file.name}" — ${message}.`);
    } finally {
      setUploadProgress(null);
    }
  }


  function handleNewChat(): void {
    setIsMobileSidebarOpen(false);
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
    setPendingThinkSave(null);
    setPersona(initialPersona ?? 'general');
    setActiveProjectId('');
    setProjectError(null);
    setPendingFile(null);
    setActiveImageContext(null);
    if (SESSION_STORAGE_KEY !== '') {
      try {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Non-fatal — worst case the old session ID lingers until overwritten by a new one.
      }
    }
    // Starting a new chat for a note that already has one abandons the old
    // note→session link (the next message re-links to a fresh session) — so
    // show a freshly-regenerated summary card again instead of an empty state.
    if (isNoteLinkedPanel && currentNoteId !== undefined) {
      void loadNoteSummary(pageContext?.title ?? 'Untitled', pageContext?.detail ?? '');
    }
  }

  async function handleProjectChange(nextProjectId: string): Promise<void> {
    const previousProjectId = activeProjectId;
    setActiveProjectId(nextProjectId);
    setProjectError(null);
    if (sessionId === null) return;

    try {
      const result = await api.setSessionProject(sessionId, nextProjectId !== '' ? nextProjectId : null);
      if (!result.success) throw new Error(result.error.message);
      setChatSessions((current) => current.map((session) =>
        session.id === sessionId
          ? { ...session, projectId: result.data.projectId }
          : session,
      ));
    } catch (error) {
      setActiveProjectId(previousProjectId);
      setProjectError(error instanceof Error ? error.message : 'Could not update the conversation project');
    }
  }

  /** Switches persona for the current chat. Persists to the session immediately (if one exists) so the next turn — and a reload — picks it up. */
  function handlePersonaChange(next: AthenaPersona): void {
    if (next === persona) return;
    setPersona(next);
    if (sessionId !== null) {
      void api.setSessionPersona(sessionId, next).catch(() => {
        // Non-fatal — the next chat() call also carries the persona, so it still takes effect.
      });
    }
  }

  const exportMutation = useMutation({
    mutationFn: () => {
      if (sessionId === null) throw new Error('No active session to export');
      return api.exportSessionToThink(sessionId);
    },
    onMutate: () => setIsExporting(true),
    onSettled: () => setIsExporting(false),
    onSuccess: (result) => {
      if (!result.success) {
        appendMessage('assistant', `⚠️ Couldn't export to Think: ${result.error.message}`);
        return;
      }
      appendMessage('assistant', `📓 Saved to Think: **${result.data.title}**\n\n[Open note](${result.data.url})`);
      void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    },
    onError: () => {
      appendMessage('assistant', "⚠️ Couldn't export this chat to Think. Please try again.");
    },
  });

  function handleExportToThink(): void {
    if (sessionId === null || messages.length === 0 || isExporting) return;
    exportMutation.mutate();
  }

  function getPreviousUserPrompt(messageIndex: number): string {
    for (let i = messageIndex - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate?.role === 'user') return candidate.content;
    }
    return '';
  }

  async function persistResponseToThink(save: PendingThinkSave, contentType: AthenaThinkContentType): Promise<void> {
    setSavingResponseIndex(save.messageIndex);
    try {
      const contextLines = [
        'Source: Athena response',
        `Captured: ${new Date().toLocaleString()}`,
        `Persona: ${persona.replace(/_/g, ' ')}`,
        `Project: ${save.projectName}`,
        `Content type: ${contentType === 'newsletter' ? 'Newsletter edition' : 'Blog draft'}`,
        pageContext ? `Page context: ${pageContext.title}` : '',
      ].filter((line) => line !== '');
      const noteMarkdown = [
        `# ${save.title}`,
        contextLines.join('\n'),
        save.prompt !== '' ? `## User question\n\n${save.prompt}` : '',
        `## Athena response\n\n${save.response.content}`,
      ].filter((block) => block !== '').join('\n\n');

      const note = await createNote({
        title: save.title,
        contentType,
        contentJson: JSON.stringify(markdownToNoteBlocks(noteMarkdown)),
      }, save.projectId);
      if (note === null) throw new Error('Could not save response to Think');
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      appendMessage('assistant', `✅ Saved to Think under **${save.projectName}** as **${contentType === 'newsletter' ? 'Newsletter edition' : 'Blog draft'}**.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save response to Think';
      appendMessage('assistant', `⚠️ ${message}`);
    } finally {
      setSavingResponseIndex(null);
    }
  }

  async function handleSaveResponseToThink(response: ChatMessage, messageIndex: number): Promise<void> {
    if (response.role !== 'assistant' || savingResponseIndex !== null) return;
    const projectId = activeProjectId !== '' ? activeProjectId : ATHENA_DEFAULT_PROJECT_ID;
    const projectName = projectNameById.get(projectId) ?? projectId;
    const title = deriveThinkTitle(response.content);
    const prompt = getPreviousUserPrompt(messageIndex);
    const save: PendingThinkSave = { response, messageIndex, projectId, projectName, title, prompt };
    const contentType = inferAthenaContentType(response.content, prompt, title);
    if (contentType === null) {
      setPendingThinkSave(save);
      appendMessage(
        'assistant',
        'I can save this to Think, but I need one detail first: should this be saved as a **blog draft** or a **newsletter edition**?',
      );
      return;
    }
    await persistResponseToThink(save, contentType);
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
        chatMutation.mutate({ text });
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

  const projectNameById = new Map(uploadProjectOptions.map((project) => [project.id, project.name]));
  const filteredSidebarSessions = sidebarSearchQuery.trim() === ''
    ? chatSessions
    : chatSessions.filter((s) => {
        const query = sidebarSearchQuery.trim().toLowerCase();
        const projectName = s.projectId !== null ? projectNameById.get(s.projectId) ?? '' : '';
        return s.title.toLowerCase().includes(query) || projectName.toLowerCase().includes(query);
      });

  const personaSwitch = (
    <div className="kh-persona-switch" role="group" aria-label="Athena persona">
      <button
        type="button"
        className={`kh-persona-switch__btn${persona === 'general' ? ' kh-persona-switch__btn--active' : ''}`}
        onClick={() => handlePersonaChange('general')}
        title="General assistant"
      >
        <Notebook className="kh-persona-switch__icon" />
        <span className="kh-persona-switch__label">General</span>
      </button>
      <button
        type="button"
        className={`kh-persona-switch__btn${persona === 'brainstorming' ? ' kh-persona-switch__btn--active' : ''}`}
        onClick={() => handlePersonaChange('brainstorming')}
        title="Ideas sounding board — stress-tests and sharpens early-stage thinking"
      >
        <Idea className="kh-persona-switch__icon" />
        <span className="kh-persona-switch__label">Brainstorm</span>
      </button>
      <button
        type="button"
        className={`kh-persona-switch__btn${persona === 'copilot_coach' ? ' kh-persona-switch__btn--active' : ''}`}
        onClick={() => handlePersonaChange('copilot_coach')}
        title="Copilot Coach — expert guide on using GitHub Copilot agents, skills, and workflows"
      >
        <Compass className="kh-persona-switch__icon" />
        <span className="kh-persona-switch__label">Copilot Coach</span>
      </button>
      <button
        type="button"
        className={`kh-persona-switch__btn${persona === 'blog_post' ? ' kh-persona-switch__btn--active' : ''}`}
        onClick={() => handlePersonaChange('blog_post')}
        title="Blog Post — produces a full CMS-ready package for The Microsoft Cloud Blog"
      >
        <Blog className="kh-persona-switch__icon" />
        <span className="kh-persona-switch__label">Blog Post</span>
      </button>
    </div>
  );

  const conversationProjectPicker = (
    <label className={`ai-chat-project${compact ? ' ai-chat-project--compact' : ''}`}>
      <span className="ai-chat-project__label">Project</span>
      <select
        className="ai-chat-project__select"
        value={activeProjectId}
        onChange={(event) => { void handleProjectChange(event.target.value); }}
        aria-label="Conversation project"
      >
        <option value="">General chat</option>
        {uploadProjectOptions.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
      </select>
      {projectError !== null && <span className="ai-chat-project__error" role="alert">{projectError}</span>}
    </label>
  );

  const actionButtons = (
    <>
      {messages.length > 0 && sessionId !== null && (
        <Button
          size="sm"
          kind="ghost"
          hasIconOnly
          renderIcon={Export}
          iconDescription={isExporting ? 'Saving to Think…' : 'Export chat to Think'}
          tooltipPosition="bottom"
          onClick={handleExportToThink}
          disabled={isExporting || chatMutation.isPending}
        />
      )}
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
    <div className={standalone ? 'ai-chat-standalone' : compact ? `ai-chat-compact ai-chat-compact--${compactVariant}` : 'page-root'}>
      {standalone && (
        <aside className={`kh-chat-sidebar${isMobile && isMobileSidebarOpen ? ' kh-chat-sidebar--open' : ''}${!isMobile && isDesktopSidebarCollapsed ? ' kh-chat-sidebar--collapsed' : ''}`}>
          <div className="kh-chat-sidebar__header">
            <div className="kh-chat-sidebar__brand">
              <img src="/favicon.svg" alt="" className="kh-chat-sidebar__logo" />
              <span>Athena</span>
            </div>
            <div className="kh-chat-sidebar__header-actions">
              {!isMobile && (
                <Button
                  size="sm"
                  kind="ghost"
                  hasIconOnly
                  renderIcon={isDesktopSidebarCollapsed ? ChevronRight : ChevronLeft}
                  iconDescription={isDesktopSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  tooltipPosition="right"
                  className="kh-chat-sidebar__collapse-btn"
                  onClick={() => setIsDesktopSidebarCollapsed((v) => !v)}
                />
              )}
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
          {personaSwitch}
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
                  <div className="kh-chat-sidebar__item-meta">
                    {s.projectId !== null && (
                      <span className="kh-chat-sidebar__project">
                        {projectNameById.get(s.projectId) ?? s.projectId}
                      </span>
                    )}
                    <span className="kh-chat-sidebar__item-time">{formatSessionTime(s.updatedAt)}</span>
                  </div>
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
      {standalone && isMobile && isMobileSidebarOpen && (
        <div
          className="kh-chat-sidebar__backdrop"
          role="presentation"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}
      <div className={standalone ? 'ai-chat-standalone__main' : compact ? 'ai-chat-compact__wrap' : ''}>
      {!compact && !standalone && (
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">{title ?? 'Athena'}</h1>
          </div>
        </div>
      )}
      {standalone && (
        <div className="ai-chat-standalone__topbar ai-chat-standalone__topbar--minimal">
          <Button
            size="sm"
            kind="ghost"
            hasIconOnly
            renderIcon={Menu}
            iconDescription="Chat history"
            tooltipPosition="bottom"
            className="ai-chat-standalone__menu-toggle"
            onClick={() => setIsMobileSidebarOpen((open) => !open)}
          />
          <div className="ai-new-chat-row ai-chat-standalone__actions">
            {actionButtons}
          </div>
        </div>
      )}
      {!standalone && (
        <div className={compact ? 'ai-new-chat-row ai-new-chat-row--compact ai-new-chat-row--with-persona' : 'ai-new-chat-row ai-new-chat-row--with-persona'}>
          {personaSwitch}
          <div className="ai-new-chat-row__actions">
            {actionButtons}
          </div>
        </div>
      )}
      <div className={standalone ? 'ai-chat-standalone__body' : compact ? 'ai-chat-compact__body' : ''}>
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

        <div className={compact ? 'ai-messages ai-messages--compact' : 'ai-messages cds--tile'} onClick={handleCodeCopyClick}>
          {messages.length === 0 && isRestoringHistory && (
            <div className="ai-empty">
              <InlineLoading description="Restoring conversation…" />
            </div>
          )}
          {messages.length === 0 && !isRestoringHistory && isNoteLinkedPanel && currentNoteId !== undefined && (
            <div className="ai-note-summary-card">
              <p className="ai-note-summary-card__label">Summary</p>
              {isNoteSummaryLoading ? (
                <InlineLoading description="Summarising this note…" />
              ) : noteSummary !== null ? (
                <p className="ai-note-summary-card__text">{noteSummary}</p>
              ) : (
                <p className="ai-note-summary-card__text ai-note-summary-card__text--muted">
                  Ask Athena anything about this note below.
                </p>
              )}
            </div>
          )}
          {messages.length === 0 && !isRestoringHistory && !(isNoteLinkedPanel && currentNoteId !== undefined) && (
            <div className="ai-empty">
              <ChatLaunch size={28} className="ai-empty__icon" />
              <p className="ai-empty__title">Athena</p>
              {pageContext ? (
                <p className="ai-empty__subtitle ai-empty__context">
                  <span className="ai-empty__context-label">Context:</span> {pageContext.title}
                </p>
              ) : (
                <p className="ai-empty__subtitle">Notes, tasks, commits, articles, sparks — ask anything.</p>
              )}
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
              <div className="ai-bubble-footer">
                <div className="ai-bubble-time">{formatMessageTime(msg.timestamp)}</div>
                {msg.role === 'assistant' && (
                  <div className="ai-bubble-actions">
                    <Button
                      type="button"
                      kind="ghost"
                      hasIconOnly
                      size="sm"
                      renderIcon={savingResponseIndex === i ? Checkmark : Notebook}
                      iconDescription={savingResponseIndex === i ? 'Saving to Think…' : 'Save response to Think'}
                      tooltipPosition="top"
                      className="ai-bubble-action-button"
                      disabled={savingResponseIndex !== null}
                      onClick={() => { void handleSaveResponseToThink(msg, i); }}
                    />
                    <Button
                      type="button"
                      kind="ghost"
                      hasIconOnly
                      size="sm"
                      renderIcon={copiedIndex === i ? Checkmark : Copy}
                      iconDescription={copiedIndex === i ? 'Copied!' : 'Copy response'}
                      tooltipPosition="top"
                      className="ai-bubble-action-button ai-bubble-copy-button"
                      onClick={() => { void handleCopyMessage(msg.content, i); }}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
          {chatMutation.isPending && (
            <div className="ai-bubble ai-bubble--ai ai-bubble--thinking">
              <InlineLoading description="Athena is thinking…" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {uploadProgress && (
          <div className="ai-upload-progress" role="status">
            <div className="ai-upload-progress-label">
              {pendingFile !== null && isChatImage(pendingFile) ? 'Analysing' : 'Uploading'} {uploadProgress.filename}… {uploadProgress.percent}%
            </div>
            <div className="ai-upload-progress-track">
              <div className="ai-upload-progress-fill" style={{ width: `${uploadProgress.percent}%` }} />
            </div>
          </div>
        )}

        {pendingFile !== null && uploadProgress === null && (
          <div className={`ai-pending-file${isChatImage(pendingFile) ? ' ai-pending-file--image' : ''}`} role="status">
            {pendingImagePreviewUrl !== null && (
              <img
                className="ai-pending-file__preview"
                src={pendingImagePreviewUrl}
                alt="Pasted image preview"
              />
            )}
            {!isChatImage(pendingFile) && <Attachment size={16} className="ai-pending-file__icon" />}
            <span className="ai-pending-file__name">{pendingFile.name}</span>
            <span className="ai-pending-file__hint">
              {isChatImage(pendingFile) ? 'Ready — ask about the image or send to describe it' : 'Ready — type your question, then send'}
            </span>
            {!isChatImage(pendingFile) && <label className="ai-pending-file__project">
              <span className="ai-pending-file__project-label">Save to</span>
              <select
                className="ai-pending-file__project-select"
                value={uploadProjectId}
                onChange={(e) => { setUploadProjectId(e.target.value); }}
                aria-label="Project for attached file"
              >
                {uploadProjectOptions.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>}
            <button
              type="button"
              className="ai-pending-file__remove"
              aria-label={`Remove ${pendingFile.name}`}
              onClick={() => { setPendingFile(null); }}
            >
              <Close size={14} />
            </button>
          </div>
        )}

        <form onSubmit={handleSend} className="ai-input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,.md,.markdown,.txt,text/markdown,text/plain,.docx,.xlsx,.pptx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf"
            className="ai-file-input-hidden"
            onChange={handleFileSelected}
          />
          {(!compact || compactVariant !== 'narrow') && conversationProjectPicker}
          <div className="ai-input-field">
            <Button
              type="button"
              kind="ghost"
              hasIconOnly
              size="sm"
              renderIcon={Attachment}
              iconDescription="Attach an image or document"
              tooltipPosition="top"
              className="ai-attach-button ai-attach-button--inline"
              onClick={handleAttachClick}
              disabled={chatMutation.isPending}
            />
            <textarea
              ref={textareaRef}
              id="ai-chat-input"
              className="ai-input-textarea"
              rows={1}
              placeholder={isRecording ? 'Listening…' : isTranscribing ? 'Transcribing…' : pendingFile !== null ? 'Ask a question about the attached file…' : 'Ask your knowledge hub…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onPaste={handleInputPaste}
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
          {chatMutation.isPending ? (
            <Button
              type="button"
              hasIconOnly
              kind="danger"
              renderIcon={StopFilled}
              iconDescription="Stop"
              tooltipPosition="top"
              className="ai-send-button ai-send-button--stop"
              onClick={handleStopGenerating}
            />
          ) : (
            <Button
              type="submit"
              hasIconOnly
              renderIcon={Send}
              iconDescription="Send"
              tooltipPosition="top"
              className="ai-send-button"
              disabled={uploadProgress !== null || (input.trim() === '' && pendingFile === null)}
            />
          )}
        </form>
      </div>
      </div>
    </div>
  );
};
