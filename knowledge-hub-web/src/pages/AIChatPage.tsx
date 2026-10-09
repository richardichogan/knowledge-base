/**
 * AIChatPage — streaming AI conversation with write-action confirmation.
 * Renders full-page (Discover-style) by default, or `compact` for use inside
 * the floating chat widget (FloatingAIChat.tsx) — same logic, lighter chrome.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Button,
  Tile,
  InlineLoading,
} from '@carbon/react';
import { Send, Checkmark, Close, Renew, Microphone, StopFilled, VolumeUp, VolumeMute, Attachment, ChatLaunch, Menu, Idea, Notebook, Export, Copy, View, OverflowMenuHorizontal, Document as DocumentIcon, Compare } from '@carbon/icons-react';
import { api } from '../services/api';
import { confirmDialog, alertDialog } from '../services/appDialogs';
import { PROJECTS } from '../config/projects';
import { renderAssistantMessage, handleCodeCopyClick } from '../components/athena/renderReply';
import { LiveReply } from '../components/athena/LiveReply';
import { SideTabsPanel } from '../components/SideTabsPanel';
import { ChatOutputsTab } from '../components/athena/ChatOutputsTab';
import { ChatDecisionsTab } from '../components/athena/ChatDecisionsTab';
import { ChatScreensTab } from '../components/athena/ChatScreensTab';
import { ReplyAlternates } from '../components/athena/ReplyAlternates';
import { CompareWithPanel } from '../components/athena/CompareWithPanel';
import { MoveToThink } from '../components/athena/MoveToThink';
import { UsedLine } from '../components/athena/UsedLine';
import type { PaneWidthOptions } from '../hooks/usePersistedState';
import { useChatDraft } from '../hooks/useChatDraft';
import { sendChatTurn, followChatTurn, TurnDetachedError, type LiveTurnHandlers } from '../services/chatTurns';
import { encodeWav, blobToBase64, stripMarkdownForSpeech, splitForSpeech } from '../components/athena/speech';
import { CHAT_IMAGE_TYPES, isChatImage, clipboardImageName } from '../components/athena/attachments';
import { createNote } from '../notes/noteStorage';
import { markdownToNoteBlocks } from '../notes/markdownToBlocks';
import type { ContentType } from '../notes/constants';
import {
  buildComposerIntent,
  composeMessageText,
  stripProjectMentions,
  COMPOSER_ACTIONS,
  COMPOSER_ACTION_LABELS, stripActionDirective } from '../chat/composerIntent';
import type { ComposerAction } from '../chat/composerIntent';
import { stripContextPrefix, stripHistoryContextPrefixes } from '../chat/contextPrefix';
import type { ChatMessage, ChatSessionSummary, WriteActionProposal, AthenaPersona, SavedMemory, NoteEdit, MapChange, OutputChange, ChatScreen, ChatRequest, ChatAlternate, ModelChoiceApi, ContextUsedApi } from '../types';

import type { AthenaPageContext } from '../context/AthenaContext';
import { ChatSidebar } from '../components/athena/ChatSidebar';
import { ReplyMeta } from '../components/athena/ReplyMeta';
import { RememberedNotice } from '../components/athena/RememberedNotice';
import { ReplyFeedback } from '../components/athena/ReplyFeedback';
import { NoteEditCard } from '../components/athena/NoteEditCard';
import { MapChangeCard } from '../components/athena/MapChangeCard';
import { briefingSeenToday, markBriefingSeen } from '../utils/morningBriefing';
import { PERSONAS, getPersona } from '../components/athena/personas';

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
  prepareDemoBrief?: (() => Promise<string>) | undefined;
  promptRequest?: { prompt: string; sequence: number } | undefined;
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


// Persisted so a page reload or reopening the standalone Athena PWA window
// restores the same conversation instead of starting blank — the backend
// now keeps history in Postgres (ai_chat_sessions/messages), so this just
// needs to remember which session ID to ask for.
//
// The floating in-app widget and the standalone /chat window are separate
// contexts (quick lookup vs a dedicated deep-work session) and each gets its
// own storage key so they no longer show the same conversation.
// Starter prompts offered in an empty chat — grounded in the user's own data
// so a blank window suggests what Athena is actually good at.
const STARTER_PROMPTS: readonly string[] = [
  "What's overdue or due this week?",
  'What should I focus on today?',
  'Summarise my notes from this week',
  'Draft a blog post outline from my latest notes',
];

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


/** The Outputs / Decisions panel beside the standalone chat. */
const CHAT_PANEL_WIDTH: PaneWidthOptions = { compact: 380, wide: 460, min: 300, max: (viewport) => Math.round(viewport * 0.45) };
export const AIChatPage: React.FC<AIChatPageProps> = ({
  compact = false,
  compactVariant = 'default',
  standalone = false,
  pageContext,
  initialPersona,
  prepareDemoBrief,
  promptRequest,
  title,
  onBusyChange,
}) => {
  // The Think-embedded panel manages its own per-note session (see the
  // note-linking effect below) instead of sharing localStorage-persisted
  // session state with the floating widget / full-page chat.
  const isNoteLinkedPanel = compact && compactVariant === 'narrow';
  // Think notes and Library documents each keep their own linked conversation.
  // Canvases too (id "map:<id>"), so each canvas keeps its own chat and Athena can propose changes to it.
  const currentNoteId = isNoteLinkedPanel && (pageContext?.type === 'note' || pageContext?.type === 'document' || pageContext?.type === 'canvas') ? pageContext.id : undefined;
  // In Think, the open note's project grounds the chat (no project chip there).
  const noteProjectId = isNoteLinkedPanel ? pageContext?.projectId : undefined;

  // Dismissing the context chip opts this chat out of sending the page's
  // content. Keyed by the dismissed context rather than a plain boolean, so
  // opening a *different* note re-arms grounding automatically — a sticky
  // flag would silently leave every later note ungrounded too.
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null);
  const pageContextKey = pageContext !== undefined
    ? `${pageContext.type}:${pageContext.id ?? ''}:${pageContext.title}`
    : null;
  const isContextDismissed = pageContextKey !== null && dismissedContextKey === pageContextKey;
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
      // /chat?session=<id> — opens that chat (e.g. from a Plan task's linked chat).
      const linked = standalone ? new URLSearchParams(window.location.search).get('session') : null;
      if (linked !== null && linked !== '') {
        window.localStorage.setItem(SESSION_STORAGE_KEY, linked);
        return linked;
      }
      return window.localStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [isRestoringHistory, setIsRestoringHistory] = useState(sessionId !== null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [noteSummary, setNoteSummary] = useState<string | null>(null);
  const [isNoteSummaryLoading, setIsNoteSummaryLoading] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  // Shown once the user has scrolled well up from the latest message.
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const draftPrefix = isNoteLinkedPanel
    ? `kh-athena-draft-note-${currentNoteId ?? 'unlinked'}`
    : `${SESSION_STORAGE_KEY}-draft`;
  const draftKeyForSession = (id: string | null): string => isNoteLinkedPanel ? draftPrefix : `${draftPrefix}-${id ?? 'new'}`;
  const [input, setInput, moveDraft] = useChatDraft(draftKeyForSession(sessionId));
  const hasUserWorkRef = useRef(false);
  hasUserWorkRef.current = sessionId !== null || input !== '' || messages.length > 0;
  const [persona, setPersona] = useState<AthenaPersona>(initialPersona ?? 'general');
  const [activeProjectId, setActiveProjectId] = useState('');
  // Per-message chip override. 'none' = user cleared the action chip, null = let
  // the parser/inference decide. Deliberately separate from `persona`, which is
  // thread-scoped and drives backend model routing.
  const [actionOverride, setActionOverride] = useState<ComposerAction | 'none' | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [pendingActions, setPendingActions] = useState<WriteActionProposal[]>([]);
  const [pendingThinkSave, setPendingThinkSave] = useState<PendingThinkSave | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingImagePreviewUrl, setPendingImagePreviewUrl] = useState<string | null>(null);
  // The screenshot this chat is about, with the chat it belongs to — it is only ever sent with that chat's messages.
  const [activeImage, setActiveImage] = useState<{ chatId: string; context: AthenaPageContext } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ filename: string; percent: number; startedAt?: number } | null>(null);
  // A pasted screenshot is stored with the chat and read as soon as it's
  // attached (while the question is typed) rather than on Send — Demo
  // Designer's detailed read takes ~20s.
  const imageReadRef = useRef<{ file: File; persona: string; startedAt: number; result: ReturnType<typeof api.uploadChatScreen> } | null>(null);
  // A new chat's id, chosen here when a screenshot is stored before the first message.
  const pendingSessionIdRef = useRef<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [uploadProjectId, setUploadProjectId] = useState('personal');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceOutputOn, setVoiceOutputOn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  /** After he sends, room below the thread so his prompt can sit at the top while the reply comes in. */
  const [holdPromptTop, setHoldPromptTop] = useState(false);
  const promptRoomRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped on every new reply / stop so an older reply's remaining chunks never play.
  const ttsRunRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appliedPromptRef = useRef<number | null>(null);
  useEffect(() => {
    if (promptRequest === undefined || isRestoringHistory || appliedPromptRef.current === promptRequest.sequence) return;
    appliedPromptRef.current = promptRequest.sequence;
    setInput(promptRequest.prompt);
    setActiveProjectId(pageContext?.projectId ?? '');
    textareaRef.current?.focus();
  }, [promptRequest, pageContext?.projectId, isRestoringHistory]);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  // The reply being worked on server-side: live activity line + streamed text.
  const [liveTurn, setLiveTurn] = useState<{ activity: string; text: string; startedAt: number } | null>(null);
  const liveTurnIdRef = useRef<string | null>(null);
  const turnRunRef = useRef(0);
  // Outputs / Decisions side panel: refresh after replies, open on a changed output.
  const [panelRefresh, setPanelRefresh] = useState(0);
  const [outputFocus, setOutputFocus] = useState<{ id: string; seq: number } | undefined>(undefined);
  const [panelTab, setPanelTab] = useState<{ id: string; seq: number } | undefined>(undefined);
  // Second opinions: other models' answers per reply, and the "Compare with…" box.
  const [alternatesByMessage, setAlternatesByMessage] = useState<Record<string, ChatAlternate[]>>({});
  const [modelChoices, setModelChoices] = useState<ModelChoiceApi[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  // "Don't use this" items for the open chat.
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  // A message whose turn was cut off by a server restart (offered for resend).
  const [interruptedTurn, setInterruptedTurn] = useState<{ sessionId: string; message: string } | null>(null);

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

  useEffect(() => {
    if (pendingFile === null || !isChatImage(pendingFile)) return;
    if (imageReadRef.current?.file === pendingFile) return;
    const result = api.uploadChatScreen(chatIdForUploads(), pendingFile, persona);
    result.catch(() => { /* surfaced when the message is sent */ });
    imageReadRef.current = { file: pendingFile, persona, startedAt: Date.now(), result };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFile]);

  useEffect(() => {
    if (uploadProgress?.startedAt === undefined) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => { setNowTick(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [uploadProgress?.startedAt]);
  /** Prevents the Android Share auto-send from firing more than once per page load. */
  const shareProcessedRef = useRef(false);
  /** Tracks the last pageContext payload we've already injected into a message, so
   *  switching notes or receiving updated note image/OCR context re-primes Athena
   *  instead of only ever doing it once for a brand new session. */
  const lastInjectedContextKeyRef = useRef<string | null>(null);
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
      if (!result.success) throw new Error(result.error.message);
      if (result.success && result.data.messages.length > 0) {
        setMessages(stripHistoryContextPrefixes(result.data.messages));
      }
      if (result.success && result.data.persona) {
        setPersona(result.data.persona);
      }
      if (result.success) setActiveProjectId(result.data.projectId ?? '');
      setIsRestoringHistory(false);
      resumeSessionTurn(sessionId);
    }).catch((error: unknown) => {
      if (!cancelled) reportHistoryError(error);
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
    detachLiveTurn();
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
    setNoteSummary(null);
    setIsRestoringHistory(true);
    setHistoryError(null);

    void api.getSessionIdForNote(currentNoteId).then(async (result) => {
      if (cancelled) return;
      if (!result.success) throw new Error(result.error.message);
      const linkedSessionId = result.success ? result.data.sessionId : null;
      if (linkedSessionId !== null) {
        setSessionId(linkedSessionId);
        const history = await api.getSessionHistory(linkedSessionId);
        if (cancelled) return;
        if (!history.success) throw new Error(history.error.message);
        if (history.success) {
          setMessages(stripHistoryContextPrefixes(history.data.messages));
          if (history.data.persona) setPersona(history.data.persona);
          setActiveProjectId(history.data.projectId ?? '');
        }
        setIsRestoringHistory(false);
        resumeSessionTurn(linkedSessionId);
      } else {
        setIsRestoringHistory(false);
        // Canvas detail is metadata only; the server reads its saved structure on each chat turn.
        if (pageContext?.type !== 'canvas') await loadNoteSummary(pageContext?.title ?? 'Untitled', pageContext?.detail ?? '');
      }
    }).catch((error: unknown) => {
      if (!cancelled) reportHistoryError(error);
    });

    return () => {
      cancelled = true;
      // If this run is cancelled (the effect re-runs, or the panel is remounted on the same note), the next run
      // must load the conversation again — otherwise the "already handled this note" guard leaves it stuck.
      if (noteSwitchTrackingRef.current === currentNoteId) noteSwitchTrackingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNoteId]);

  function persistSessionId(id: string, creating = false): void {
    if (sessionId === null && creating) moveDraft(draftKeyForSession(id));
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
      // Titles written before the context marker was kept out of them can
      // still start with "[Viewing …]"; strip it for display rather than
      // rewriting stored rows.
      if (result.success) {
        setChatSessions(result.data.sessions.map((session) => ({
          ...session,
          title: stripContextPrefix(session.title),
          preview: stripContextPrefix(session.preview),
        })));
      }
    }).catch(() => {
      // Non-fatal — sidebar just won't update until the next successful load.
    });
  }

  useEffect(() => {
    refreshSessionList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reportHistoryError(error: unknown): void {
    setIsRestoringHistory(false);
    setHistoryError(`Could not load the saved conversation. It has not been deleted. ${error instanceof Error ? error.message : String(error)}`);
  }

  function handleSelectSession(id: string, retry = false): void {
    setIsMobileSidebarOpen(false);
    if (id === sessionId && !retry) return;
    stopTts();
    detachLiveTurn();
    setActiveImage(null);
    pendingSessionIdRef.current = null;
    persistSessionId(id);
    setMessages([]);
    setPendingActions([]);
    setPendingThinkSave(null);
    setIsRestoringHistory(true);
    setHistoryError(null);
    const view = turnRunRef.current;
    void api.getSessionHistory(id).then((result) => {
      if (view !== turnRunRef.current) return;
      if (!result.success) throw new Error(result.error.message);
      if (result.success) setMessages(stripHistoryContextPrefixes(result.data.messages));
      if (result.success && result.data.persona) setPersona(result.data.persona);
      if (result.success) setActiveProjectId(result.data.projectId ?? '');
      setIsRestoringHistory(false);
      resumeSessionTurn(id);
    }).catch((error: unknown) => {
      if (view === turnRunRef.current) reportHistoryError(error);
    });
  }

  // The first time Athena is opened each day she opens on the morning briefing
  // (not in the per-note/canvas panels, which keep their own chats).
  useEffect(() => {
    if (isNoteLinkedPanel || promptRequest !== undefined) return undefined;
    // Opened on a specific chat (e.g. from a Plan task) — that chat wins.
    if (standalone && new URLSearchParams(window.location.search).get('session')) return undefined;
    let cancelled = false;
    void api.getMorningBriefing().then((r) => {
      if (cancelled || hasUserWorkRef.current || !r.success || r.data === null || briefingSeenToday(r.data.date)) return;
      markBriefingSeen(r.data.date);
      if (r.data.sessionId !== sessionId) handleSelectSession(r.data.sessionId);
    }).catch(() => { /* no briefing — open as usual */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeleteSession(id: string, e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (!await confirmDialog('Delete this chat? This cannot be undone.', { title: 'Delete chat', confirmLabel: 'Delete', tone: 'danger' })) return;
    void api.deleteChatSession(id).then(() => {
      setChatSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === sessionId) handleNewChat();
    }).catch(() => {
      void alertDialog('Could not delete this chat. Please try again.', { title: 'Delete failed', tone: 'danger' });
    });
  }

  function stopTts(): void {
    ttsRunRef.current++;
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
      ttsAudioRef.current = null;
    }
  }

  /**
   * Speaks the reply progressively: every chunk is synthesised at once (in
   * parallel), and playback starts as soon as the short first chunk is ready.
   */
  function playReply(text: string): void {
    if (!voiceOutputOn) return;
    const clean = stripMarkdownForSpeech(text);
    if (clean === '') return;
    stopTts();
    const run = ttsRunRef.current;
    const pending = splitForSpeech(clean).map((chunk) => api.synthesizeVoice(chunk).catch(() => null));
    void (async () => {
      for (const next of pending) {
        const result = await next;
        if (ttsRunRef.current !== run) return;
        // Voice output is a nice-to-have — skip a failed chunk rather than surfacing an error.
        if (result === null || !result.success) continue;
        const audio = new Audio(`data:${result.data.mimeType};base64,${result.data.audioBase64}`);
        ttsAudioRef.current = audio;
        const finished = new Promise<void>((resolve) => { audio.onended = () => { resolve(); }; audio.onerror = () => { resolve(); }; });
        try {
          await audio.play();
        } catch {
          // Autoplay can be blocked without a user gesture — non-fatal, text reply still shown.
          return;
        }
        await finished;
        if (ttsRunRef.current !== run) return;
        ttsAudioRef.current = null;
      }
    })();
  }

  const chatMutation = useMutation({
    onMutate: () => {
      // Fresh controller per turn — Stop only ever aborts the request that's actually in flight.
      chatAbortControllerRef.current = new AbortController();
    },
    mutationFn: async ({ text, composerDraft, pageContext: ctx, resumeTurnId, resumeStartedAt, screenReview }: { text: string; composerDraft?: string; pageContext?: AthenaPageContext; resumeTurnId?: string; resumeStartedAt?: string; screenReview?: ChatRequest['screenReview'] }) => {
      // Runs on the server in the background; this view follows it live and
      // can let go (switching chats) without losing the answer.
      const run = ++turnRunRef.current;
      const signal = (chatAbortControllerRef.current ?? new AbortController()).signal;
      const startedAt = resumeStartedAt !== undefined ? Date.parse(resumeStartedAt) : Date.now();
      // Remember the destination before token renewal/network I/O, not only
      // after the server response (which a refresh may never receive).
      const requestSessionId = sessionId ?? pendingSessionIdRef.current ?? crypto.randomUUID();
      if (resumeTurnId === undefined && sessionId === null) persistSessionId(requestSessionId, true);
      setLiveTurn({ activity: 'Sending', text: '', startedAt });
      liveTurnIdRef.current = resumeTurnId ?? null;
      const handlers: LiveTurnHandlers = {
        onStarted: (turnId, newSessionId) => {
          if (turnRunRef.current !== run) return;
          liveTurnIdRef.current = turnId;
          if (sessionId === null) persistSessionId(newSessionId, true);
          if (composerDraft !== undefined) setInput((current) => current === composerDraft ? '' : current);
        },
        onActivity: (activity) => { if (turnRunRef.current === run) setLiveTurn((t) => (t === null ? t : { ...t, activity })); },
        onText: (liveText) => { if (turnRunRef.current === run) setLiveTurn((t) => (t === null ? t : { ...t, text: liveText })); },
      };
      try {
        const result = resumeTurnId !== undefined
          ? await followChatTurn(resumeTurnId, handlers, signal)
          : await sendChatTurn(
          {
            message: text,
            persona,
            projectId: noteProjectId ?? (activeProjectId !== '' ? activeProjectId : null),
            sessionId: requestSessionId,
            ...(ctx && { pageContext: ctx }),
            ...(isNoteLinkedPanel && currentNoteId !== undefined && { noteId: currentNoteId }),
            ...(screenReview !== undefined && { screenReview }),
            outputsPanel: standalone && !isMobile,
          },
          handlers,
          signal,
        );
        // He switched chats while it finished: it's saved in its own chat — never show it in this one.
        if (turnRunRef.current !== run) throw new TurnDetachedError();
        return result;
      } finally {
        if (turnRunRef.current === run) {
          setLiveTurn(null);
          liveTurnIdRef.current = null;
        }
      }
    },
    onSuccess: (result) => {
      if (!result.success && result.error.code === 'TURN_GONE' && sessionId !== null) {
        // Finished while we were reconnecting (it's in the saved history), or
        // lost in a server restart (the interrupted notice offers a resend).
        const id = sessionId;
        void api.getSessionHistory(id).then((h) => {
          if (h.success) setMessages(stripHistoryContextPrefixes(h.data.messages));
          resumeSessionTurn(id);
        });
        return;
      }
      if (!result.success) {
        appendMessage('assistant', `Error: ${result.error.message}`);
        return;
      }
      if (sessionId === null) persistSessionId(result.data.sessionId, true);
      appendMessage('assistant', result.data.reply, {
        persona: result.data.persona,
        sources: result.data.sources,
        memoriesCreated: result.data.memoriesCreated,
        noteEdits: result.data.noteEdits,
        noteEditsFor: result.data.noteEditsFor,
        mapChanges: result.data.mapChanges,
        mapChangesFor: result.data.mapChangesFor,
        outputsChanged: result.data.outputsChanged,
        id: result.data.assistantMessageId,
        contextUsed: result.data.contextUsed,
        nextSteps: result.data.nextSteps,
      });
      // Athena saved or revised an output: refresh the panel and open it there.
      const changed = result.data.outputsChanged ?? [];
      setPanelRefresh((n) => n + 1);
      if (changed.length > 0) openOutput(changed[changed.length - 1]!.id);
      // The Decisions list is updated just after the reply — pick that up.
      window.setTimeout(() => { setPanelRefresh((n) => n + 1); }, 5_000);
      window.setTimeout(() => { setPanelRefresh((n) => n + 1); }, 12_000);
      playReply(result.data.reply);
      refreshSessionList();
      if (result.data.pendingActions.length > 0) {
        setPendingActions((prev) => [...prev, ...result.data.pendingActions]);
      }
      // The AI may have created/updated tasks, notes or Sparks via tool calls this turn —
      // refresh the relevant lists so they show up without a manual reload.
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      void queryClient.invalidateQueries({ queryKey: ['sparks'] });
      void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] });
      void queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] });
      void queryClient.invalidateQueries({ queryKey: ['today-sparks-recent'] });
      void queryClient.invalidateQueries({ queryKey: ['today', 'clusters'] });
      // No scroll here: his prompt stays at the top of the view with the reply beneath it.
    },
    onError: (err: unknown) => {
      // This view let go of the turn (switched chats) — it finishes in its own chat.
      if (err instanceof TurnDetachedError) return;
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

  /** Stops the entire background turn, including context preparation. */
  function handleStopGenerating(): void {
    const turnId = liveTurnIdRef.current;
    if (turnId === null) {
      // Not accepted by the server yet — just stop waiting.
      chatAbortControllerRef.current?.abort();
      appendMessage('assistant', '⏹️ Stopped.');
      return;
    }
    void api.cancelChatTurn(turnId).catch(() => {
      chatAbortControllerRef.current?.abort();
      appendMessage('assistant', 'Could not stop Athena on the server. Reopen this chat to check its status.');
    });
  }

  /** The chat id to store screenshots under — chosen now for a chat that hasn't started yet. */
  function chatIdForUploads(): string {
    if (sessionId !== null) return sessionId;
    pendingSessionIdRef.current ??= crypto.randomUUID();
    return pendingSessionIdRef.current;
  }

  /**
   * The chat a message is being sent from, captured before any wait (upload,
   * screenshot read, project change). If he switches chats during the wait,
   * the message still goes to — and is answered in — the chat it was written in.
   */
  function captureSendTarget(): { view: number; request: Pick<ChatRequest, 'persona' | 'projectId' | 'sessionId'> } {
    return {
      view: turnRunRef.current,
      request: { persona, projectId: noteProjectId ?? (activeProjectId !== '' ? activeProjectId : null), sessionId: chatIdForUploads() },
    };
  }

  /** True (and the turn is started in its own chat, in the background) when he has switched chats since `target` was captured. */
  function sentFromAnotherChat(target: ReturnType<typeof captureSendTarget>, message: string, ctx?: AthenaPageContext): boolean {
    if (turnRunRef.current === target.view) return false;
    void api.startChatTurn({ ...target.request, message, ...(ctx && { pageContext: ctx }) })
      .then(() => { refreshSessionList(); })
      .catch(() => { /* the chat shows nothing new; he can resend there */ });
    return true;
  }

  /** Removes the pending attachment; a screenshot already stored for it is deleted. */
  function discardPendingFile(): void {
    const early = imageReadRef.current;
    imageReadRef.current = null;
    if (early !== null && early.file === pendingFile) {
      void early.result.then((r) => { if (r.success) void api.deleteChatScreen(r.data.screen.id); }).catch(() => { /* nothing stored */ });
    }
    setPendingFile(null);
  }

  /** Other models' answers for this chat's replies (tabs under each reply). */
  function loadAlternates(id: string): void {
    setAlternatesByMessage({});
    void api.listAlternates(id).then((r) => {
      if (!r.success) return;
      const byMessage: Record<string, ChatAlternate[]> = {};
      for (const a of r.data) (byMessage[a.messageId] ??= []).push(a);
      setAlternatesByMessage(byMessage);
    }).catch(() => { /* none */ });
  }

  /** "Compare with…": the other AI's answer goes in as the document in view. */
  function handleCompare(source: string, answer: string): void {
    setCompareOpen(false);
    appendMessage('user', `⚖️ Compare with ${source}`);
    chatMutation.mutate({
      text: [
        `Compare your previous answer with ${source}'s answer (the document in view). Be specific and fair:`,
        '1. What both caught.',
        `2. What only ${source} caught that you missed, and whether it matters.`,
        '3. What only you caught.',
        '4. Where you disagree, who is right, and why.',
        '5. A merged best version that keeps the best of both. If it is a deliverable (a prompt, spec, user stories, ' +
          'script …), save it with save_output — as a new version of the existing output if there is one.',
      ].join('\n'),
      pageContext: { type: 'comparison', title: `${source}'s answer`, detail: answer },
    });
  }

  /** "Review this journey" in the Screens panel. */
  function handleReviewJourney(question: string): void {
    const text = question.trim() !== '' ? question.trim() : 'Review this journey: what should change between the steps, and what doesn’t?';
    appendMessage('user', `🧭 ${text}`);
    chatMutation.mutate({ text, screenReview: { mode: 'journey' } });
  }

  /** "Ask about the marked areas" on a screen. */
  function handleAskAboutMarked(screen: ChatScreen): void {
    const text = `Look at the areas I marked on "${screen.name}"${screen.annotationNote !== null ? `: ${screen.annotationNote}` : ''}`;
    appendMessage('user', `🔍 ${text}`);
    chatMutation.mutate({ text, screenReview: { mode: 'focus', screenIds: [screen.id] } });
  }

  /** Opens the side panel on an output (a reply's chip, or after Athena saves one). */
  function openOutput(id: string): void {
    setOutputFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }));
    setPanelTab((t) => ({ id: 'outputs', seq: (t?.seq ?? 0) + 1 }));
  }

  /** Stops following the current turn without stopping it (it lands in its own chat). */
  function detachLiveTurn(): void {
    turnRunRef.current += 1;
    chatAbortControllerRef.current?.abort();
    setLiveTurn(null);
    liveTurnIdRef.current = null;
    setInterruptedTurn(null);
  }

  /** After opening a chat: reattach to a turn still running there, or offer to resend one cut off by a restart. */
  function resumeSessionTurn(id: string): void {
    loadAlternates(id);
    setExcludedIds(new Set());
    void api.listExclusions(id).then((r) => { if (r.success) setExcludedIds(new Set(r.data.map((x) => x.id))); }).catch(() => { /* none */ });
    void api.getSessionTurn(id).then((r) => {
      if (!r.success || r.data === null) return;
      if (r.data.status === 'running') {
        appendMessage('user', stripActionDirective(r.data.message));
        chatMutation.mutate({ text: r.data.message, resumeTurnId: r.data.turnId, resumeStartedAt: r.data.startedAt });
      } else {
        setInterruptedTurn({ sessionId: id, message: r.data.message });
      }
    }).catch(() => { /* nothing to resume */ });
  }

  function handleResendInterrupted(): void {
    if (interruptedTurn === null) return;
    const { sessionId: id, message } = interruptedTurn;
    setInterruptedTurn(null);
    void api.dismissSessionTurn(id).catch(() => { /* cosmetic */ });
    appendMessage('user', stripActionDirective(message));
    chatMutation.mutate({ text: message });
  }

  function handleDismissInterrupted(): void {
    if (interruptedTurn === null) return;
    void api.dismissSessionTurn(interruptedTurn.sessionId).catch(() => { /* cosmetic */ });
    setInterruptedTurn(null);
  }

  useEffect(() => {
    void api.listModelChoices(persona).then((r) => { if (r.success) setModelChoices(r.data); }).catch(() => { /* menu stays empty */ });
  }, [persona]);

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

  function appendMessage(
    role: 'user' | 'assistant',
    content: string,
    meta: {
      persona?: AthenaPersona | undefined;
      sources?: string[] | undefined;
      memoriesCreated?: SavedMemory[] | undefined;
      noteEdits?: NoteEdit[] | undefined;
      noteEditsFor?: string | null | undefined;
      mapChanges?: MapChange[] | undefined;
      mapChangesFor?: string | null | undefined;
      outputsChanged?: OutputChange[] | undefined;
      id?: string | undefined;
      contextUsed?: ContextUsedApi | undefined;
      nextSteps?: string[] | undefined;
    } = {},
  ): void {
    setMessages((prev) => [
      ...prev,
      {
        role,
        content,
        timestamp: new Date().toISOString(),
        ...(meta.persona !== undefined && { persona: meta.persona }),
        ...(meta.sources !== undefined && meta.sources.length > 0 && { sources: meta.sources }),
        ...(meta.memoriesCreated !== undefined && meta.memoriesCreated.length > 0 && { memoriesCreated: meta.memoriesCreated }),
        ...(meta.noteEdits !== undefined && meta.noteEdits.length > 0 && typeof meta.noteEditsFor === 'string' && { noteEdits: meta.noteEdits, noteEditsFor: meta.noteEditsFor }),
        ...(meta.mapChanges !== undefined && meta.mapChanges.length > 0 && typeof meta.mapChangesFor === 'string' && { mapChanges: meta.mapChanges, mapChangesFor: meta.mapChangesFor }),
        ...(meta.outputsChanged !== undefined && meta.outputsChanged.length > 0 && { outputsChanged: meta.outputsChanged }),
        ...(meta.id !== undefined && meta.id !== '' && { id: meta.id }),
        ...(meta.contextUsed !== undefined && { contextUsed: meta.contextUsed }),
        ...(meta.nextSteps !== undefined && meta.nextSteps.length > 0 && { nextSteps: meta.nextSteps }),
      },
    ]);
    if (role === 'user') {
      // Bring his prompt to the top of the view and keep it there while the reply
      // arrives beneath it (the space below the thread makes room for that).
      setHoldPromptTop(true);
      window.setTimeout(() => {
        const prompts = messagesRef.current?.querySelectorAll<HTMLElement>('.ai-bubble--user');
        const last = prompts !== undefined && prompts.length > 0 ? prompts[prompts.length - 1] : undefined;
        if (last !== undefined) scrollMessagesTo(last);
      }, 80);
    }
  }

  /** Scrolls the thread so `el` sits just below its top edge. */
  function scrollMessagesTo(el: HTMLElement): void {
    const box = messagesRef.current;
    if (box === null) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /** Jumps to the previous or next of his own messages in the thread. */
  function jumpToPrompt(direction: 'prev' | 'next'): void {
    const box = messagesRef.current;
    if (box === null) return;
    const prompts = [...box.querySelectorAll<HTMLElement>('.ai-bubble--user')];
    const boxTop = box.getBoundingClientRect().top;
    const offsets = prompts.map((el) => el.getBoundingClientRect().top - boxTop);
    const target = direction === 'prev'
      ? prompts.filter((_el, i) => offsets[i]! < -4).pop()
      : prompts.find((_el, i) => offsets[i]! > 12);
    if (target !== undefined) scrollMessagesTo(target);
  }

  // Alt+↑ / Alt+↓ jump between his prompts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      jumpToPrompt(e.key === 'ArrowUp' ? 'prev' : 'next');
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, []);

  const promptCount = messages.filter((m) => m.role === 'user').length;
  const lastAssistantIndex = messages.reduce((last, m, idx) => (m.role === 'assistant' ? idx : last), -1);

  // Size the room below the thread to just what keeps his last prompt at the top of
  // the view — it shrinks to nothing as the reply fills the screen.
  useLayoutEffect(() => {
    const box = messagesRef.current;
    const room = promptRoomRef.current;
    if (!holdPromptTop || box === null || room === null) return;
    const sizeRoom = (): void => {
      const prompts = box.querySelectorAll<HTMLElement>('.ai-bubble--user');
      const last = prompts.length > 0 ? prompts[prompts.length - 1] : undefined;
      const bottom = bottomRef.current;
      if (last === undefined || bottom === null || box.clientHeight === 0) return;
      const style = getComputedStyle(box);
      const gap = Number.parseFloat(style.rowGap) || 0;
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const boxTop = box.getBoundingClientRect().top + borderTop;
      const roomVisible = getComputedStyle(room).display !== 'none';
      const contentBottom = bottom.getBoundingClientRect().bottom - boxTop + box.scrollTop
        - room.offsetHeight - (roomVisible ? gap : 0) + paddingBottom;
      // Do not create a scroll range just to pin a prompt in an otherwise short conversation.
      if (contentBottom <= box.clientHeight) {
        room.style.display = 'none';
        room.style.height = '0px';
        return;
      }
      room.style.display = '';
      const promptTop = last.getBoundingClientRect().top - boxTop + box.scrollTop;
      const roomTop = room.getBoundingClientRect().top - boxTop + box.scrollTop;
      room.style.height = `${Math.max(0, box.clientHeight - (roomTop - promptTop) - paddingBottom - gap - 8)}px`;
    };
    sizeRoom();
    const observer = new ResizeObserver(sizeRoom);
    observer.observe(box);
    return () => { observer.disconnect(); };
  });

  // Opening a chat (its history just loaded): jump straight to the last message.
  const wasRestoringRef = useRef(isRestoringHistory);
  useEffect(() => {
    if (wasRestoringRef.current && !isRestoringHistory) {
      setHoldPromptTop(false);
      const toEnd = (): void => {
        const box = messagesRef.current;
        if (box !== null) box.scrollTop = box.scrollHeight;
      };
      // Once rendered, and again shortly after in case late content (images, cards) changes the height.
      window.setTimeout(toEnd, 0);
      window.setTimeout(toEnd, 400);
    }
    wasRestoringRef.current = isRestoringHistory;
  }, [isRestoringHistory]);

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
    if (e.key === 'ArrowUp' && input === '') {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser !== undefined) {
        e.preventDefault();
        setInput(lastUser.content);
      }
      return;
    }
    // Enter sends; Shift+Enter adds a new line. (Skip while an IME is
    // composing, e.g. accented/CJK input, where Enter confirms a character.)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submitMessage();
    }
  }

  async function submitMessage(): Promise<void> {
    if (chatMutation.isPending || isRestoringHistory || historyError !== null || uploadProgress !== null) return;
    const intent = buildComposerIntent({
      input,
      projects: uploadProjectOptions,
      activeProjectId,
      actionOverride,
    });
    const text = intent.rawText || (pendingFile !== null && isChatImage(pendingFile)
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

    // An `@project` mention grounds the whole conversation, so persist it via the
    // same path the project chip uses before the turn goes out.
    const outgoing = composeMessageText(text, intent.effectiveAction);
    if (intent.explicitProjectId !== undefined && intent.explicitProjectId !== activeProjectId) {
      const target = captureSendTarget();
      await handleProjectChange(intent.explicitProjectId);
      if (sentFromAnotherChat({ ...target, request: { ...target.request, projectId: intent.explicitProjectId } }, outgoing)) return;
    }

    appendMessage('user', outgoing);
    setActionOverride(null);
    // Tell Athena what the user is currently viewing on the first message of a
    // session, or whenever they've navigated to a different note/canvas/item
    // since we last told her about one — otherwise she keeps answering with
    // stale or no context. Sent as a separate `pageContext` field (not glued
    // into the message text) so the backend can search using only what the
    // user actually typed, rather than running full-text search using an
    // entire note's body as the query — which used to drag in unrelated
    // same-project documents as "background context".
    const isFirstMessage = messages.length === 0 && sessionId === null;
    const contextKey = pageContext !== undefined
      ? `${pageContext.type}:${pageContext.id ?? ''}:${pageContext.title}:${pageContext.detail ?? ''}:${pageContext.images ?? ''}`
      : null;
    const contextChanged = contextKey !== null && lastInjectedContextKeyRef.current !== contextKey;
    // In Think the chat is about the open note, so send it with every message
    // — otherwise follow-up questions reached Athena without the note (or its
    // images) at all, since history only keeps a short "[Viewing …]" marker.
    const activeImageContext = activeImage !== null && activeImage.chatId === (sessionId ?? pendingSessionIdRef.current) ? activeImage.context : null;
    if (activeImageContext !== null) {
      chatMutation.mutate({ text: outgoing, composerDraft: input, pageContext: activeImageContext });
    } else if ((isFirstMessage || contextChanged || isNoteLinkedPanel) && pageContext && !isContextDismissed) {
      lastInjectedContextKeyRef.current = contextKey;
      chatMutation.mutate({ text: outgoing, composerDraft: input, pageContext });
    } else {
      chatMutation.mutate({ text: outgoing, composerDraft: input });
    }
  }

  function handleAttachClick(): void {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    if (!isChatImage(file) && !/\.(md|markdown|txt|docx|xlsx|csv|pptx|pdf)$/i.test(file.name)) {
      appendMessage(
        'assistant',
        '⚠️ Please attach an image (PNG, JPEG, WebP, or GIF), Markdown, text, Word, Excel, CSV, PowerPoint, or PDF file.',
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
    const target = captureSendTarget();
    try {
      let fileText: string;
      let storedIn: string;
      let extraNote = '';

      if (isChatImage(file)) {
        const early = imageReadRef.current;
        const useEarly = early?.file === file;
        setUploadProgress({ filename: file.name, percent: 0, startedAt: useEarly ? early.startedAt : Date.now() });
        const res = await (useEarly ? early.result : api.uploadChatScreen(chatIdForUploads(), file, persona, question));
        imageReadRef.current = null;
        if (!res.success) throw new Error(res.error?.message ?? 'image analysis failed');
        fileText = res.data.reading;
        storedIn = `this chat's Screens panel as "${res.data.screen.name}"`;
        setPanelRefresh((n) => n + 1);
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
        // Spreadsheets are linked to the chat, so Athena can calculate with them.
        const isSheet = /\.(xlsx|csv)$/i.test(file.name);
        const res = await api.uploadDocument(file, uploadProjectId, undefined, uploadProjectName, (percent) => {
          setUploadProgress({ filename: file.name, percent });
        }, isSheet ? chatIdForUploads() : undefined);
        if (!res.success) throw new Error(res.error?.message ?? 'upload failed');
        fileText = res.data.text;
        storedIn = `the Documents library under ${res.data.projectName}${isSheet ? ' (and loaded into the calculator for this chat)' : ''}`;
        if (res.data.truncated) extraNote = ' The extract below is truncated because the file is large.';
      }

      setUploadProgress({ filename: file.name, percent: 100 });
      setPendingFile(null);
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
          ? `Screenshot pasted into this chat, kept in ${storedIn}. Visual analysis:\n\n${fileText}`
          : `Stored in ${storedIn}.${extraNote} Full content:\n\n${fileText.slice(0, ATTACHED_FILE_CONTEXT_CHAR_LIMIT)}`,
      };
      // Switched chats while it uploaded/read: answer it in the chat it was sent from.
      if (sentFromAnotherChat(target, question, attachedContext)) return;
      appendMessage('user', `${question}\n\n${isChatImage(file) ? '🖼️' : '📎'} ${file.name}`);
      if (isChatImage(file) && target.request.sessionId !== undefined && target.request.sessionId !== null) {
        setActiveImage({ chatId: target.request.sessionId, context: attachedContext });
      }
      chatMutation.mutate({
        text: question,
        composerDraft: input,
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
    setHistoryError(null);
    setIsMobileSidebarOpen(false);
    detachLiveTurn();
    pendingSessionIdRef.current = null;
    setCompareOpen(false);
    setAlternatesByMessage({});
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
    setPendingThinkSave(null);
    setPersona(initialPersona ?? 'general');
    setActiveProjectId('');
    setActionOverride(null);
    setProjectError(null);
    discardPendingFile();
    setActiveImage(null);
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

  const [preparingBrief, setPreparingBrief] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const briefContextRef = useRef({ noteId: currentNoteId, sessionId, input });
  briefContextRef.current = { noteId: currentNoteId, sessionId, input };
  const briefMountedRef = useRef(true);
  useEffect(() => {
    briefMountedRef.current = true;
    return () => { briefMountedRef.current = false; };
  }, []);
  async function prepareImagineBrief(): Promise<void> {
    if (prepareDemoBrief === undefined || preparingBrief || chatMutation.isPending || isRestoringHistory) return;
    const original = briefContextRef.current;
    if (input.trim() !== '' && !await confirmDialog('Replace your unsent chat prompt with the IMAGINE demo brief request? The Use case note will not change.', {
      title: 'Prepare demo brief', confirmLabel: 'Replace prompt',
    })) return;
    setPreparingBrief(true);
    setBriefError(null);
    try {
      const prompt = await prepareDemoBrief();
      if (!briefMountedRef.current) return;
      const current = briefContextRef.current;
      if (original.noteId !== current.noteId || original.sessionId !== current.sessionId || original.input !== current.input) {
        setBriefError('The note, chat or unsent prompt changed while preparing the brief. Nothing was replaced; retry in the intended note.');
        return;
      }
      handlePersonaChange('demo_designer');
      setActionOverride('none');
      setInput(prompt);
      textareaRef.current?.focus();
    } catch (error) {
      console.error('[IMAGINE brief] Could not read Use case:', error);
      setBriefError(error instanceof Error ? error.message : 'Could not read the Use case. Your note and prompt are unchanged; retry.');
    } finally { setPreparingBrief(false); }
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
      void alertDialog(`"${result.data.title}" has been saved to Think.`, { title: 'Saved to Think', tone: 'success' });
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
    const projectId = noteProjectId ?? (activeProjectId !== '' ? activeProjectId : ATHENA_DEFAULT_PROJECT_ID);
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

  /** Delegated clicks inside rendered replies: code "Copy" and task-card actions. */
  function handleThreadClick(e: React.MouseEvent<HTMLElement>): void {
    handleCodeCopyClick(e);
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
    if (!btn || btn.disabled) return;
    const taskId = btn.dataset['taskId'];
    const action = btn.dataset['taskAction'];
    if (taskId === undefined || (action !== 'done' && action !== 'snooze')) return;
    const actionsRow = btn.closest<HTMLElement>('.kh-task-card__actions');
    actionsRow?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = true; });
    const snoozeDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const input = action === 'done' ? { status: 'completed' } : { dueDate: snoozeDate };
    void api.updateTask(taskId, input).then((r) => {
      if (!r.success) throw new Error('update failed');
      void queryClient.invalidateQueries({ queryKey: ['today-tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      if (actionsRow) {
        actionsRow.querySelectorAll('button').forEach((b) => { b.remove(); });
        const note = document.createElement('span');
        note.className = 'kh-task-card__status-note';
        note.textContent = action === 'done'
          ? '✓ Marked done'
          : `✓ Snoozed to ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(snoozeDate))}`;
        actionsRow.appendChild(note);
      }
    }).catch(() => {
      actionsRow?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = false; });
      btn.textContent = 'Failed — retry';
    });
  }
  const composerIntent = buildComposerIntent({
    input,
    projects: uploadProjectOptions,
    activeProjectId,
    actionOverride,
  });
  const chipProjectId = composerIntent.effectiveProjectId ?? '';
  const chipProjectName = chipProjectId !== '' ? projectNameById.get(chipProjectId) ?? chipProjectId : '';
  const isProjectInferred = chipProjectId !== '' && chipProjectId !== activeProjectId;
  const isActionInferred =
    composerIntent.effectiveAction !== undefined
    && actionOverride === null
    && composerIntent.explicitAction === undefined;


  /**
   * Project chip edits are authoritative: any stale `@project` mention still in
   * the input is cleared first, so the chip never appears to ignore the pick.
   */
  function handleProjectChipChange(nextProjectId: string): void {
    if (composerIntent.explicitProjectId !== undefined) {
      setInput((current) => stripProjectMentions(current, uploadProjectOptions));
    }
    void handleProjectChange(nextProjectId);
  }

  // Persona chip (every surface) + "more" menu (Think side panel, which has
  // no top icon row).
  const activePersona = getPersona(persona);
  const PersonaChipIcon = activePersona.Icon;
  const canExportChat = messages.length > 0 && sessionId !== null && !isExporting && !chatMutation.isPending;
  const canStartNewChat = messages.length > 0 && !chatMutation.isPending;

  const composerChipBar = (
    <div className="kh-composer-chips">
      <div className="kh-composer-chip kh-composer-chip--persona" title={`Persona: ${activePersona.description}`}>
        <PersonaChipIcon size={14} className="kh-composer-chip__icon" />
        <span className="kh-composer-chip__value">{activePersona.label}</span>
        <select
          className="kh-composer-chip__select"
          aria-label="Athena persona"
          value={persona}
          onChange={(event) => { handlePersonaChange(event.target.value as AthenaPersona); }}
        >
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      {pageContext !== undefined && !isContextDismissed && (
        <div className="kh-composer-chip kh-composer-chip--context">
          <View size={14} className="kh-composer-chip__icon" />
          <span className="kh-composer-chip__value" title={pageContext.title}>
            Viewing: {pageContext.title}
          </span>
          <button
            type="button"
            className="kh-composer-chip__remove"
            aria-label="Stop using this page as context"
            onClick={() => { setDismissedContextKey(pageContextKey); }}
          >
            <Close size={12} />
          </button>
        </div>
      )}

      <div className={`kh-composer-chip kh-composer-chip--action${composerIntent.effectiveAction === undefined ? ' kh-composer-chip--empty' : ''}${isActionInferred ? ' kh-composer-chip--inferred' : ''}`}
        title={`Action for this message. Shortcut: start your message with ${COMPOSER_ACTIONS.map((a) => `/${a}`).join(', ')}`}
      >
        <Idea size={14} className="kh-composer-chip__icon" />
        <span className="kh-composer-chip__value">
          {composerIntent.effectiveAction !== undefined
            ? COMPOSER_ACTION_LABELS[composerIntent.effectiveAction]
            : 'Any action'}
          {isActionInferred && <span className="kh-composer-chip__hint">suggested</span>}
        </span>
        <select
          className="kh-composer-chip__select"
          aria-label="Action for this message"
          value={composerIntent.effectiveAction ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            setActionOverride(next === '' ? 'none' : (next as ComposerAction));
          }}
        >
          <option value="">Any action</option>
          {COMPOSER_ACTIONS.map((action) => (
            <option key={action} value={action}>{COMPOSER_ACTION_LABELS[action]}</option>
          ))}
        </select>
        {composerIntent.effectiveAction !== undefined && (
          <button
            type="button"
            className="kh-composer-chip__remove"
            aria-label="Clear action"
            onClick={() => { setActionOverride('none'); }}
          >
            <Close size={12} />
          </button>
        )}
      </div>

      {!isNoteLinkedPanel && (
      <div title="Project to ground this chat in. Shortcut: type @project anywhere in your message" className={`kh-composer-chip kh-composer-chip--project${chipProjectId === '' ? ' kh-composer-chip--empty' : ''}${isProjectInferred ? ' kh-composer-chip--inferred' : ''}`}>
        <Notebook size={14} className="kh-composer-chip__icon" />
        <span className="kh-composer-chip__value">
          {chipProjectId !== '' ? chipProjectName : 'No project'}
          {isProjectInferred && <span className="kh-composer-chip__hint">suggested</span>}
        </span>
        <select
          className="kh-composer-chip__select"
          aria-label="Conversation project"
          value={chipProjectId}
          onChange={(event) => { handleProjectChipChange(event.target.value); }}
        >
          <option value="">No project</option>
          {uploadProjectOptions.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
        {chipProjectId !== '' && (
          <button
            type="button"
            className="kh-composer-chip__remove"
            aria-label="Clear project grounding"
            onClick={() => { handleProjectChipChange(''); }}
          >
            <Close size={12} />
          </button>
        )}
      </div>
      )}

      {isNoteLinkedPanel && (
        <div className="kh-composer-chip kh-composer-chip--more" title="More">
          <OverflowMenuHorizontal size={14} className="kh-composer-chip__icon" />
          <select
            className="kh-composer-chip__select"
            aria-label="More chat actions"
            value=""
            onChange={(event) => {
              const choice = event.target.value;
              if (choice === 'export') handleExportToThink();
              else if (choice === 'new') handleNewChat();
              else if (choice === 'voice') { stopTts(); setVoiceOutputOn((v) => !v); }
            }}
          >
            <option value="" disabled>More…</option>
            <option value="new" disabled={!canStartNewChat}>New chat</option>
            <option value="export" disabled={!canExportChat}>{isExporting ? 'Saving to Think…' : 'Export chat to Think'}</option>
            <option value="voice">{voiceOutputOn ? 'Turn voice replies off' : 'Turn voice replies on'}</option>
          </select>
        </div>
      )}

      {projectError !== null && <span className="kh-composer-chips__error" role="alert">{projectError}</span>}
    </div>
  );

  const actionButtons = (
    <>
      {messages.length > 0 && sessionId !== null && !isNoteLinkedPanel && (
        <MoveToThink
          sessionId={sessionId}
          projectId={activeProjectId}
          disabled={isExporting || chatMutation.isPending}
          onExportSummary={handleExportToThink}
        />
      )}
      {messages.length > 0 && sessionId !== null && isNoteLinkedPanel && (
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
      {messages.length > 0 && !standalone && (
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
        <ChatSidebar
          sessions={chatSessions}
          activeSessionId={sessionId}
          projectNameById={projectNameById}
          onSelect={handleSelectSession}
          onNewChat={handleNewChat}
          newChatDisabled={chatMutation.isPending}
          onDelete={handleDeleteSession}
          onSessionPatched={(id, patch) => {
            setChatSessions((prev) => {
              const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
              // Pinned chats sort first, then most recent — mirrors the backend order.
              return next.sort((x, y) => Number(y.pinned === true) - Number(x.pinned === true)
                || new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime());
            });
          }}
          collapsed={isDesktopSidebarCollapsed}
          onToggleCollapsed={() => { setIsDesktopSidebarCollapsed((v) => !v); }}
          isMobile={isMobile}
          mobileOpen={isMobileSidebarOpen}
        />
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
      {!standalone && !isNoteLinkedPanel && (
        <div className={compact ? 'ai-new-chat-row ai-new-chat-row--compact' : 'ai-new-chat-row'}>
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

        <div
          ref={messagesRef}
          className={`${compact ? 'ai-messages ai-messages--compact' : 'ai-messages cds--tile'}${showJumpToLatest || promptCount > 1 ? ' ai-messages--with-tools' : ''}`}
          onClick={handleThreadClick}
          onScroll={(e) => {
            const el = e.currentTarget;
            setShowJumpToLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
          }}
        >
          {messages.length === 0 && isRestoringHistory && (
            <div className="ai-empty">
              <InlineLoading description="Restoring conversation…" />
            </div>
          )}
          {messages.length === 0 && !isRestoringHistory && historyError === null && isNoteLinkedPanel && currentNoteId !== undefined && (
            <div className="ai-note-summary-card">
              <p className="ai-note-summary-card__label">Summary</p>
              {isNoteSummaryLoading ? (
                <InlineLoading description="Summarising this note…" />
              ) : noteSummary !== null ? (
                <p className="ai-note-summary-card__text">{noteSummary}</p>
              ) : (
                <p className="ai-note-summary-card__text ai-note-summary-card__text--muted">
                  Ask Athena anything about this {pageContext?.type === 'document' ? 'document' : 'note'} below.
                </p>
              )}
            </div>
          )}
          {messages.length === 0 && !isRestoringHistory && historyError === null && !(isNoteLinkedPanel && currentNoteId !== undefined) && (
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
              <div className="ai-starters">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="ai-starter"
                    onClick={() => { setInput(prompt); textareaRef.current?.focus(); }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={msg.role === 'user' ? 'ai-bubble ai-bubble--user' : 'ai-bubble ai-bubble--ai'}
              aria-label={msg.role === 'user' ? 'You' : 'Athena'}
            >
              {msg.role === 'user' ? (
                <div className="ai-bubble-text">{msg.content}</div>
              ) : (
                <div
                  className="ai-bubble-text ai-bubble-text--md"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: renderAssistantMessage(msg.content, { projectNameById }) }}
                />
              )}
              {msg.role === 'assistant' && <ReplyMeta persona={msg.persona} sources={msg.sources} />}
              {msg.role === 'assistant' && msg.contextUsed !== undefined && sessionId !== null && (
                <UsedLine
                  used={msg.contextUsed}
                  excluded={excludedIds}
                  onExclude={(source) => {
                    void api.excludeSource(sessionId, source).then((r) => { if (r.success) setExcludedIds(new Set(r.data.map((x) => x.id))); });
                  }}
                  onInclude={(sourceId) => {
                    void api.includeSource(sessionId, sourceId).then((r) => { if (r.success) setExcludedIds(new Set(r.data.map((x) => x.id))); });
                  }}
                />
              )}
              {msg.role === 'assistant' && msg.noteEdits !== undefined && msg.noteEditsFor !== undefined && (
                <NoteEditCard edits={msg.noteEdits} noteId={msg.noteEditsFor} />
              )}
              {msg.role === 'assistant' && msg.mapChanges !== undefined && msg.mapChangesFor !== undefined && (
                <MapChangeCard changes={msg.mapChanges} mapId={msg.mapChangesFor} />
              )}
              {msg.role === 'assistant' && msg.outputsChanged !== undefined && (
                <div className="ai-output-chips">
                  {msg.outputsChanged.map((o) => (
                    <button
                      key={`${o.id}-${o.version.toString()}`}
                      type="button"
                      className="ai-output-chip"
                      onClick={() => {
                        if (standalone && !isMobile) openOutput(o.id);
                        else if (sessionId !== null) window.open(`/chat?session=${encodeURIComponent(sessionId)}`, '_blank', 'noopener');
                      }}
                      title={standalone && !isMobile ? 'Open in the Outputs panel' : 'Open this chat in the full Athena window, where Outputs are shown'}
                    >
                      <DocumentIcon size={14} aria-hidden="true" />
                      {o.version > 1 ? 'Updated' : 'Saved'}: {o.title} · v{o.version}
                      <span className="ai-output-chip__open">{standalone && !isMobile ? 'Open' : 'Open in Athena'}</span>
                    </button>
                  ))}
                </div>
              )}
              {msg.role === 'assistant' && msg.memoriesCreated !== undefined && <RememberedNotice memories={msg.memoriesCreated} />}
              {/* "Continue in Think" under the latest reply, where he is reading — always offered, never guessed. */}
              {msg.role === 'assistant' && i === lastAssistantIndex && sessionId !== null && !isNoteLinkedPanel && messages.length >= 3
                && !chatMutation.isPending && !/^(Error:|⏹️|⚠️|📓)/.test(msg.content) && (
                <div className="ai-reply-think">
                  <MoveToThink
                    variant="inline"
                    sessionId={sessionId}
                    projectId={activeProjectId}
                    disabled={isExporting}
                    onExportSummary={handleExportToThink}
                  />
                </div>
              )}
              {msg.role === 'assistant' && msg.id !== undefined && sessionId !== null && modelChoices.length > 0 && !/^(Error:|⏹️|⚠️)/.test(msg.content) && (
                <ReplyAlternates
                  sessionId={sessionId}
                  messageId={msg.id}
                  alternates={alternatesByMessage[msg.id] ?? []}
                  models={modelChoices}
                  renderContext={{ projectNameById }}
                  onAdded={(alt) => { setAlternatesByMessage((m) => ({ ...m, [alt.messageId]: [...(m[alt.messageId] ?? []), alt] })); }}
                  onUsed={(messageId, content) => {
                    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
                    loadAlternates(sessionId);
                  }}
                />
              )}
              {msg.role === 'assistant' && !/^(Error:|⏹️|⚠️)/.test(msg.content) && (
                <ReplyFeedback reply={msg.content} persona={msg.persona ?? persona} sessionId={sessionId} />
              )}
              <div className="ai-bubble-footer">
                <div className="ai-bubble-time" title={formatMessageTime(msg.timestamp)}>
                  {formatMessageTime(msg.timestamp)}
                </div>
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
          {!chatMutation.isPending && (() => {
            const last = messages[messages.length - 1];
            if (last?.role !== 'assistant' || last.nextSteps === undefined) return null;
            return (
              <div className="ai-next-steps" aria-label="Suggested next steps">
                {last.nextSteps.map((step) => (
                  <button
                    key={step}
                    type="button"
                    className="ai-next-step"
                    onClick={() => { appendMessage('user', step); chatMutation.mutate({ text: step }); }}
                  >
                    {step}
                  </button>
                ))}
              </div>
            );
          })()}
          {chatMutation.isPending && (liveTurn !== null ? (
            <LiveReply activity={liveTurn.activity} text={liveTurn.text} startedAt={liveTurn.startedAt} renderContext={{ projectNameById }} />
          ) : (
            <div className="ai-bubble ai-bubble--ai ai-bubble--thinking">
              <InlineLoading description="Athena is thinking…" />
            </div>
          ))}
          {holdPromptTop && <div ref={promptRoomRef} className="ai-prompt-room" aria-hidden="true" />}
          <div ref={bottomRef} />
        </div>

        {(showJumpToLatest || promptCount > 1) && (
          <div className="ai-scroll-tools">
            {promptCount > 1 && (
              <div className="ai-prompt-nav" role="group" aria-label="Jump between your messages">
                <button type="button" onClick={() => { jumpToPrompt('prev'); }} title="Previous message you sent (Alt+↑)" aria-label="Previous message you sent">↑</button>
                {!compact && <span className="ai-prompt-nav__label">Your messages</span>}
                <button type="button" onClick={() => { jumpToPrompt('next'); }} title="Next message you sent (Alt+↓)" aria-label="Next message you sent">↓</button>
              </div>
            )}
            {showJumpToLatest && (
              <button
                type="button"
                className="ai-jump-latest"
                onClick={() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
              >
                ↓ Latest
              </button>
            )}
          </div>
        )}

        <div className="ai-composer">
        {prepareDemoBrief !== undefined && (
          <div className="ai-demo-brief-skill">
            <button type="button" className="ai-demo-brief-skill__button" disabled={preparingBrief || chatMutation.isPending || isRestoringHistory}
              onClick={() => { void prepareImagineBrief(); }}>{preparingBrief ? 'Reading Use case...' : 'Create IMAGINE demo brief'}</button>
            <p className="ai-demo-brief-skill__hint">Uses the full live Use case note. Review the prompt, then send; the brief is saved in Outputs for GHCP.</p>
            {briefError !== null && <p role="alert" className="ai-demo-brief-skill__error">{briefError}</p>}
          </div>
        )}
        {compareOpen && <CompareWithPanel onSend={handleCompare} onClose={() => { setCompareOpen(false); }} />}
        {interruptedTurn !== null && interruptedTurn.sessionId === sessionId && !chatMutation.isPending && (
          <div className="ai-interrupted" role="status">
            <span className="ai-interrupted__text">
              Your last message didn&apos;t get an answer — the server restarted while Athena was working on it.
            </span>
            <button type="button" className="ai-interrupted__btn" onClick={handleResendInterrupted}>Resend</button>
            <button type="button" className="ai-interrupted__btn ai-interrupted__btn--quiet" onClick={handleDismissInterrupted}>Dismiss</button>
          </div>
        )}
        {uploadProgress && (
          <div className="ai-upload-progress" role="status">
            <div className="ai-upload-progress-label">
              {uploadProgress.startedAt !== undefined
                ? `Reading the screenshot in detail (usually 15–30s) ${uploadProgress.filename}… ${Math.max(0, Math.round((nowTick - uploadProgress.startedAt) / 1000)).toString()}s`
                : `Uploading ${uploadProgress.filename}… ${uploadProgress.percent.toString()}%`}
            </div>
            <div className="ai-upload-progress-track">
              <div className="ai-upload-progress-fill" style={{ width: `${uploadProgress.startedAt !== undefined ? Math.min(90, (nowTick - uploadProgress.startedAt) / 300).toString() : uploadProgress.percent.toString()}%` }} />
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
              onClick={() => { discardPendingFile(); }}
            >
              <Close size={14} />
            </button>
          </div>
        )}

        {composerChipBar}

        {historyError !== null && <div className="ai-history-error" role="alert">
          <p>{historyError}</p>
          {sessionId !== null && <Button kind="ghost" size="sm" onClick={() => handleSelectSession(sessionId, true)}>Retry loading conversation</Button>}
        </div>}

        <form onSubmit={handleSend} className="ai-input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,.md,.markdown,.txt,text/markdown,text/plain,.docx,.xlsx,.csv,text/csv,.pptx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf"
            className="ai-file-input-hidden"
            onChange={handleFileSelected}
          />
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
            {messages.some((m) => m.role === 'assistant') && (
              <Button
                type="button"
                kind="ghost"
                hasIconOnly
                size="sm"
                renderIcon={Compare}
                iconDescription="Compare with another AI's answer"
                tooltipPosition="top"
                className="ai-attach-button ai-attach-button--inline"
                onClick={() => { setCompareOpen((o) => !o); }}
                disabled={chatMutation.isPending}
              />
            )}
            <textarea
              ref={textareaRef}
              id="ai-chat-input"
              className="ai-input-textarea"
              rows={1}
              placeholder={isRecording ? 'Listening…' : isTranscribing ? 'Transcribing…' : pendingFile !== null ? 'Ask a question about the attached file…' : 'Ask Athena…'}
              value={input}
              onChange={(e) => { hasUserWorkRef.current = true; setInput(e.target.value); }}
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
              disabled={isRestoringHistory || historyError !== null || uploadProgress !== null || (input.trim() === '' && pendingFile === null)}
            />
          )}
        </form>
        {standalone && !isMobile && (
          <p className="ai-composer__hint">Enter to send · Shift+Enter for a new line · ↑ to edit your last message</p>
        )}
        </div>
      </div>
      </div>
      {standalone && !isMobile && (
        <SideTabsPanel
          storageKey="athena-chat-side"
          label="Outputs and decisions"
          defaultTab="outputs"
          defaultCollapsed
          width={CHAT_PANEL_WIDTH}
          selectTab={panelTab}
          tabs={[
            { id: 'outputs', label: 'Outputs', content: <ChatOutputsTab sessionId={sessionId} refreshKey={panelRefresh} focus={outputFocus} /> },
            { id: 'decisions', label: 'Decisions', content: <ChatDecisionsTab sessionId={sessionId} refreshKey={panelRefresh} /> },
            {
              id: 'screens', label: 'Screens',
              content: (
                <ChatScreensTab
                  sessionId={sessionId}
                  refreshKey={panelRefresh}
                  busy={chatMutation.isPending}
                  onReviewJourney={handleReviewJourney}
                  onAskAboutMarked={handleAskAboutMarked}
                />
              ),
            },
          ]}
        />
      )}
    </div>
  );
};
