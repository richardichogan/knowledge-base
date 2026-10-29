/**
 * AIChatPage — streaming AI conversation with write-action confirmation.
 * Renders full-page (Discover-style) by default, or `compact` for use inside
 * the floating chat widget (FloatingAIChat.tsx) — same logic, lighter chrome.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { notifyPromptCompleted, requestCompletionNotifications } from '../chat/completionNotification';
import { usePageTitle } from '../navigation/PageTitle';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Button,
  Tile,
} from '@carbon/react';
import { Send, Checkmark, Close, Renew, Microphone, StopFilled, VolumeUp, VolumeMute, Attachment, Menu, Idea, Notebook, Copy, View, Document as DocumentIcon, Compare } from '@carbon/icons-react';
import { api } from '../services/api';
import { prepareDesignChat } from '../utils/activeBlockNoteEditor';
import { authSession } from '../services/authSession';
import { describeApiError, requireApiData } from '../services/apiError';
import { confirmDialog, alertDialog } from '../services/appDialogs';
import { useProjects } from '../hooks/useProjects';
import { ProjectOptions, type ProjectPickerItem } from '../components/ProjectOptions';
import { DataNotice } from '../components/DataNotice';
import { renderAssistantMessage, handleCodeCopyClick } from '../components/athena/renderReply';
import { LiveReply, ThinkingReply } from '../components/athena/LiveReply';
import { AthenaPresence } from '../components/athena/AthenaPresence';
import { AthenaRibbon } from '../components/athena/AthenaRibbon';
import { ComposerSuggestion, composerSuggestions } from '../components/athena/ComposerSuggestion';
import { ComposerControl } from '../components/athena/ComposerControl';
import { useAthenaMood } from '../chat/athenaMood';
import { ChatBubble } from '../components/athena/ChatBubble';
import { athenaMotionPhase, athenaExpressiveEase, microphoneLevel, ATHENA_ANSWER_MS, ATHENA_MIN_THINK_MS, ATHENA_TYPING_IDLE_MS } from '../chat/athenaMotion';
import { SideTabsPanel } from '../components/SideTabsPanel';
import { ChatOutputsTab } from '../components/athena/ChatOutputsTab';
import { ChatDecisionsTab } from '../components/athena/ChatDecisionsTab';
import { ChatScreensTab } from '../components/athena/ChatScreensTab';
import { ReplyAlternates } from '../components/athena/ReplyAlternates';
import { CompareWithPanel } from '../components/athena/CompareWithPanel';
import { MoveToThink } from '../components/athena/MoveToThink';
import { AnswerText } from '../components/athena/AnswerText';
import { UsedLine } from '../components/athena/UsedLine';
import { AtRiskChatCard } from '../features/plan/AtRiskChatCard';
import type { PaneWidthOptions } from '../hooks/usePersistedState';
import { useChatDraft } from '../hooks/useChatDraft';
import { sendChatTurn, followChatTurn, TurnDetachedError, type LiveTurnHandlers } from '../services/chatTurns';
import { encodeWav, resampleVoiceAudio, blobToBase64, stripMarkdownForSpeech, splitForSpeech } from '../components/athena/speech';
import { playSpeechChunks, type SpeechPlaybackAudio } from '../components/athena/speechPlayback';
import { getVoiceVolume, MAX_VOICE_VOLUME, useVoiceVolume } from '../components/athena/voiceVolume';
import { VoiceVolumeControl } from '../components/athena/VoiceVolumeControl';
import { CHAT_IMAGE_TYPES, isChatImage, clipboardImageName } from '../components/athena/attachments';
import { createNote } from '../notes/noteStorage';
import type { ContentType } from '../notes/constants';
import {
  buildComposerIntent,
  composeMessageText,
  stripProjectMentions,
  COMPOSER_ACTIONS,
  COMPOSER_ACTION_LABELS, stripActionDirective, conversationProjectId } from '../chat/composerIntent';
import type { ComposerAction } from '../chat/composerIntent';
import { stripContextPrefix, stripHistoryContextPrefixes } from '../chat/contextPrefix';
import type { ChatMessage, ChatSessionSummary, WriteActionProposal, AthenaPersona, SavedMemory, NoteEdit, MapChange, LocalFileWrite, OutputChange, ChatScreen, ChatRequest, ChatAlternate, ModelChoiceApi, ContextUsedApi } from '../types';
import { JobChatConfirmations } from '../components/jobs/JobReview';

import type { AthenaPageContext } from '../context/AthenaContext';
import { ChatSidebar } from '../components/athena/ChatSidebar';
import { ReplyMeta } from '../components/athena/ReplyMeta';
import { RememberedNotice } from '../components/athena/RememberedNotice';
import { ReplyFeedback } from '../components/athena/ReplyFeedback';
import { NoteEditCard } from '../components/athena/NoteEditCard';
import { MapChangeCard } from '../components/athena/MapChangeCard';
import { LocalFileWriteCard } from '../components/athena/LocalFileWriteCard';
import { desktopErrorMessage, getDesktop } from '../types/desktop';
import { useDesktopCommand } from '../services/desktopCommands';
import { appendVoiceTranscript, finishVoiceTranscript, submitVoiceTranscript } from '../services/voiceTranscript';
import { briefingSeenToday, markBriefingSeen } from '../utils/morningBriefing';
import { PERSONAS, getPersona } from '../components/athena/personas';
import { ChatMentionSuggestions } from '../chat/ChatMentionSuggestions';
import { PeopleMessageText } from '../people/PeopleMessageText';

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
  /** Pins the chat to one existing conversation (e.g. a podcast episode's prep), without New chat or shared storage. */
  fixedSessionId?: string | undefined;
}

// Send filtered 16kHz mono WAV to full-recording transcription.
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
const LAST_SHARE_STORAGE_KEY = 'kh-athena-last-share';
/** A second delivery of the same share within this window is treated as a duplicate. */
const REPEAT_SHARE_WINDOW_MS = 2 * 60_000;

interface SharedLink { title: string; url: string; text: string }

function hasShareParams(params: URLSearchParams): boolean {
  return ['title', 'url', 'text'].some((key) => (params.get(key) ?? '').trim() !== '');
}

/** Share params, with the link pulled out of `text` when the sharing app puts it there (Android usually does). */
function readSharedLink(params: URLSearchParams): SharedLink {
  const title = (params.get('title') ?? '').trim();
  let url = (params.get('url') ?? '').trim();
  let text = (params.get('text') ?? '').trim();
  if (url === '') {
    const found = /https?:\/\/\S+/.exec(text);
    if (found !== null) {
      url = found[0];
      text = text.replace(found[0], '').trim();
    }
  }
  if (text === url || text === title) text = '';
  return { title, url, text };
}

function isRepeatShare(share: SharedLink): boolean {
  const key = `${share.url}|${share.title}|${share.text}`;
  try {
    const previous = JSON.parse(window.sessionStorage.getItem(LAST_SHARE_STORAGE_KEY) ?? 'null') as { key: string; at: number } | null;
    const repeat = previous !== null && previous.key === key && Date.now() - previous.at < REPEAT_SHARE_WINDOW_MS;
    window.sessionStorage.setItem(LAST_SHARE_STORAGE_KEY, JSON.stringify({ key, at: Date.now() }));
    return repeat;
  } catch {
    return false;
  }
}

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
let desktopVoiceOwner: symbol | null = null;
export const AIChatPage: React.FC<AIChatPageProps> = ({
  compact = false,
  compactVariant = 'default',
  standalone = false,
  pageContext,
  initialPersona,
  promptRequest,
  title,
  onBusyChange,
  fixedSessionId,
}) => {
  // The Think-embedded panel manages its own per-note session (see the
  // note-linking effect below) instead of sharing localStorage-persisted
  // session state with the floating widget / full-page chat.
  const isNoteLinkedPanel = compact && compactVariant === 'narrow';
  // Think notes and Library documents each keep their own linked conversation.
  // Canvases too (id "map:<id>"), so each canvas keeps its own chat and Athena can propose changes to it.
  const currentNoteId = isNoteLinkedPanel && (pageContext?.type === 'note' || pageContext?.type === 'document' || pageContext?.type === 'canvas') ? pageContext.conversationId ?? pageContext.id : undefined;
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
  const SESSION_STORAGE_KEY = fixedSessionId !== undefined ? ''
    : standalone
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
  // A link shared from the phone or browser (manifest share_target → /chat?title&text&url) always starts a new chat.
  const [isShareLaunch] = useState(() => standalone && hasShareParams(new URLSearchParams(window.location.search)));
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (fixedSessionId !== undefined) return fixedSessionId;
    if (isNoteLinkedPanel || isShareLaunch) return null;
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
  const [noteSummaryError, setNoteSummaryError] = useState<string | null>(null);
  const noteSummaryRequest = useRef(0);
  const noteSummaryIdentity = useRef(currentNoteId);
  noteSummaryIdentity.current = currentNoteId;
  useEffect(() => () => { noteSummaryRequest.current++; }, []);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  usePageTitle({ item: standalone ? chatSessions.find((s) => s.id === sessionId)?.title : null });
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
  const [voiceVolume, setVoiceVolume] = useVoiceVolume();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const promptScrollFrameRef = useRef(0);
  useEffect(() => () => { window.cancelAnimationFrame(promptScrollFrameRef.current); }, []);
  const conversationRef = useRef<HTMLDivElement>(null);
  const [presenceDock, setPresenceDock] = useState<HTMLSpanElement | null>(null);
  const [presenceThinker, setPresenceThinker] = useState<HTMLSpanElement | null>(null);
  const [replyArrival, setReplyArrival] = useState<{ startedAt: number; complete: boolean } | null>(null);
  const [revealingAnswer, setRevealingAnswer] = useState(false);
  const [promptArrivalAt, setPromptArrivalAt] = useState<number | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [typingActive, setTypingActive] = useState(false);
  const typingTimerRef = useRef<number>();
  const voiceLevelRef = useRef(0);
  const noteTyping = (): void => {
    setTypingActive(true);
    window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => { setTypingActive(false); }, ATHENA_TYPING_IDLE_MS);
  };
  useEffect(() => () => { window.clearTimeout(typingTimerRef.current); }, []);
  useEffect(() => {
    if (replyArrival === null) {
      setRevealingAnswer(false);
      return;
    }
    if (replyArrival === null || revealingAnswer) return;
    const timer = window.setTimeout(() => { setReplyArrival(null); },
      Math.max(0, replyArrival.startedAt + ATHENA_ANSWER_MS - Date.now()));
    return () => { window.clearTimeout(timer); };
  }, [replyArrival, revealingAnswer]);
  /** After he sends, room below the thread so his prompt can sit at the top while the reply comes in. */
  const [holdPromptTop, setHoldPromptTop] = useState(false);
  const promptRoomRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const ttsAudioRef = useRef<SpeechPlaybackAudio | null>(null);
  const ttsControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (ttsAudioRef.current) ttsAudioRef.current.volume = voiceVolume / MAX_VOICE_VOLUME;
  }, [voiceVolume]);
  useEffect(() => () => { ttsControllerRef.current?.abort(); }, []);
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
  const [liveTurn, setLiveTurn] = useState<{ activity: string; startedAt: number } | null>(null);
  const liveTurnIdRef = useRef<string | null>(null);
  const turnRunRef = useRef(0);
  // Outputs / Decisions side panel: refresh after replies, open on a changed output.
  const [panelRefresh, setPanelRefresh] = useState(0);
  const [outputFocus, setOutputFocus] = useState<{ id: string; seq: number } | undefined>(() => {
    const output = standalone ? new URLSearchParams(window.location.search).get('output') : null;
    return output ? { id: output, seq: 1 } : undefined;
  });
  const [panelTab, setPanelTab] = useState<{ id: string; seq: number } | undefined>(() =>
    standalone && new URLSearchParams(window.location.search).get('output') ? { id: 'outputs', seq: 1 } : undefined);
  // Second opinions: other models' answers per reply, and the "Compare with…" box.
  const [alternatesByMessage, setAlternatesByMessage] = useState<Record<string, ChatAlternate[]>>({});
  const [modelChoices, setModelChoices] = useState<ModelChoiceApi[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  // "Don't use this" items for the open chat.
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  // A message whose turn was cut off by a server restart (offered for resend).
  const [interruptedTurn, setInterruptedTurn] = useState<{ sessionId: string; message: string } | null>(null);

  const projectsQuery = useProjects();
  const uploadProjectOptions: ProjectPickerItem[] = [...(projectsQuery.data ?? [])];
  if (!uploadProjectOptions.some((project) => project.id === 'personal')) {
    uploadProjectOptions.unshift({ id: 'personal', name: 'Personal / unassigned', groupName: 'Personal' });
  }
  for (const id of [uploadProjectId, activeProjectId]) {
    if (id !== '' && !uploadProjectOptions.some((project) => project.id === id)) {
      uploadProjectOptions.push({ id, name: `Legacy / unknown project: ${id}` });
    }
  }
  const uploadProjectName = uploadProjectOptions.find((p) => p.id === uploadProjectId)?.name ?? uploadProjectId;

  // Auto-grow the message textarea up to a max height, then let it scroll —
  // Recalculate on text changes and when a hidden/narrow panel becomes visible.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let width = -1;
    const resize = (): void => {
      if (el.clientWidth === 0) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      if (el.value === '') el.scrollTop = 0;
    };
    resize();
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
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
  const location = useLocation();
  const firstLocationKeyRef = useRef(location.key);

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
    const request = ++noteSummaryRequest.current;
    const noteId = currentNoteId;
    const isCurrent = (): boolean => request === noteSummaryRequest.current && noteSummaryIdentity.current === noteId;
    setNoteSummary(null);
    setNoteSummaryError(null);
    setIsNoteSummaryLoading(true);
    try {
      const result = requireApiData(await api.summarizeNote(noteTitle, noteDetail));
      if (isCurrent()) setNoteSummary(result.summary);
    } catch (error) {
      if (isCurrent()) setNoteSummaryError(describeApiError(error));
    } finally {
      if (isCurrent()) setIsNoteSummaryLoading(false);
    }
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
    noteSummaryRequest.current++;

    let cancelled = false;
    detachLiveTurn();
    setMessages([]);
    setSessionId(null);
    setPendingActions([]);
    setNoteSummary(null);
    setNoteSummaryError(null);
    setIsNoteSummaryLoading(false);
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

  // Share Target handler (phone or installed browser app). The page was opened
  // with no stored session (see isShareLaunch), so the share always lands in a
  // brand-new chat rather than an unrelated existing one. Params come from the
  // manifest share_target GET action: /chat?title=...&text=...&url=...
  useEffect(() => {
    if (!isShareLaunch) return;
    if (shareProcessedRef.current) return;
    shareProcessedRef.current = true;
    // Clean the share params from the URL so a reload doesn't re-trigger.
    setSearchParams({}, { replace: true });
    const share = readSharedLink(searchParams);
    // The OS sometimes delivers the same share twice; send it once.
    if (isRepeatShare(share)) return;
    const { title: sharedTitle, url: sharedUrl, text: sharedText } = share;

    const contextLines: string[] = ['[Shared link]'];
    if (sharedTitle) contextLines.push(`Title: ${sharedTitle}`);
    if (sharedUrl)   contextLines.push(`URL: ${sharedUrl}`);
    if (sharedText) contextLines.push(`Description: ${sharedText}`);

    // The user-visible bubble is a short label; the message Athena receives
    // has full context and the question — mirrors the file-upload pattern.
    const displayLabel = `📤 Shared: ${sharedTitle || sharedUrl || sharedText.slice(0, 60)}`;
    const athenaMessage = [
      contextLines.join('\n'),
      '',
      'The user has shared a link from their phone or browser. This is a new chat about this link only.',
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

  // A history load that failed because the sign-in lapsed retries itself once the user is signed in again.
  useEffect(() => {
    if (historyError === null || sessionId === null) return;
    return authSession.subscribe(() => {
      if (!authSession.isExpired()) handleSelectSession(sessionId, true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyError, sessionId]);

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

  // A chat link opened while this window is already open (ChatLinkReceiver navigates here): switch in place.
  // The first location is handled by the initial state above.
  useEffect(() => {
    if (!standalone || location.key === firstLocationKeyRef.current) return;
    const linked = searchParams.get('session');
    if (linked === null || linked === '') return;
    handleSelectSession(linked);
    const output = searchParams.get('output');
    if (output) openOutput(output);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // The first time Athena is opened each day she opens on the morning briefing
  // (not in the per-note/canvas panels, which keep their own chats).
  useEffect(() => {
    if (isNoteLinkedPanel || promptRequest !== undefined || fixedSessionId !== undefined) return undefined;
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
    ttsControllerRef.current?.abort();
    ttsControllerRef.current = null;
    ttsAudioRef.current?.pause();
    ttsAudioRef.current = null;
    setVoiceError(null);
  }

  function playReply(text: string): void {
    if (!voiceOutputOn) return;
    const clean = stripMarkdownForSpeech(text);
    if (clean === '') return;
    stopTts();
    const controller = new AbortController();
    ttsControllerRef.current = controller;
    void playSpeechChunks(splitForSpeech(clean),
      async (chunk, signal) => requireApiData(await api.synthesizeVoice(chunk, undefined, signal)),
      controller.signal,
      audio => {
        if (ttsControllerRef.current !== controller) return;
        if (audio) audio.volume = getVoiceVolume() / MAX_VOICE_VOLUME;
        ttsAudioRef.current = audio;
      },
    ).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setVoiceError(`Spoken reply stopped. The full reply is still available as text. ${describeApiError(error)}`);
      }
    }).finally(() => {
      controller.abort();
      if (ttsControllerRef.current === controller) ttsControllerRef.current = null;
    });
  }

  const chatMutation = useMutation({
    onMutate: ({ resumeTurnId }) => {
      if (resumeTurnId === undefined) requestCompletionNotifications();
      // Fresh controller per turn — Stop only ever aborts the request that's actually in flight.
      chatAbortControllerRef.current = new AbortController();
      setReplyArrival(null);
      clearEmotion();
    },
    mutationFn: async ({ text, composerDraft, pageContext: ctx, resumeTurnId, resumeStartedAt, screenReview }: { text: string; composerDraft?: string; pageContext?: AthenaPageContext; resumeTurnId?: string; resumeStartedAt?: string; screenReview?: ChatRequest['screenReview'] }) => {
      // Runs on the server in the background; this view follows it live and
      // can let go (switching chats) without losing the answer.
      const run = ++turnRunRef.current;
      const signal = (chatAbortControllerRef.current ?? new AbortController()).signal;
      const startedAt = resumeStartedAt !== undefined ? Date.parse(resumeStartedAt) : Date.now();
      let notificationTurnId = resumeTurnId;
      // Remember the destination before token renewal/network I/O, not only
      // after the server response (which a refresh may never receive).
      const requestSessionId = sessionId ?? pendingSessionIdRef.current ?? crypto.randomUUID();
      if (resumeTurnId === undefined && sessionId === null) persistSessionId(requestSessionId, true);
      setLiveTurn({ activity: 'Sending', startedAt });
      liveTurnIdRef.current = resumeTurnId ?? null;
      const handlers: LiveTurnHandlers = {
        onStarted: (turnId, newSessionId) => {
          notificationTurnId = turnId;
          if (turnRunRef.current !== run) return;
          liveTurnIdRef.current = turnId;
          if (sessionId === null) persistSessionId(newSessionId, true);
          if (composerDraft !== undefined) setInput((current) => current === composerDraft ? '' : current);
        },
        onActivity: (activity) => { if (turnRunRef.current === run) setLiveTurn((t) => (t === null ? t : { ...t, activity })); },
        // Deltas are provisional: tool rounds and evidence repairs can reset them.
        // Only the successful turn result is an accepted answer to reveal.
        onText: () => {},
      };
      let finishDesign: ((changed: boolean) => Promise<void>) | undefined;
      let designChanged = true;
      try {
        if (ctx?.conversationId && isNoteLinkedPanel) finishDesign = await prepareDesignChat(ctx.conversationId);
        // In Athena Desktop, Athena may read and propose changes to the folders he chose on this PC.
      const desktop = getDesktop();
      let localFolders: Array<{ name: string; path: string }> = [];
      if (desktop !== null && resumeTurnId === undefined) {
        try {
          localFolders = (await desktop.listFolders()).map((f) => ({ name: f.name, path: f.path }));
        } catch (err) {
          throw new Error(`Could not read the folders on this PC: ${desktopErrorMessage(err)}`);
        }
      }
      const result = resumeTurnId !== undefined
          ? await followChatTurn(resumeTurnId, handlers, signal)
          : await sendChatTurn(
          {
            message: text,
            persona,
            projectId: conversationProjectId(isNoteLinkedPanel, noteProjectId, activeProjectId),
            sessionId: requestSessionId,
            ...(ctx && { pageContext: ctx }),
            ...(isNoteLinkedPanel && currentNoteId !== undefined && { noteId: currentNoteId }),
            ...(screenReview !== undefined && { screenReview }),
            outputsPanel: standalone && !isMobile,
            ...(localFolders.length > 0 && { localFolders }),
          },
          handlers,
          signal,
        );
        if (result.success) designChanged = result.data.designChanged !== undefined;
        if (result.success) {
          const remaining = ATHENA_MIN_THINK_MS - (Date.now() - startedAt);
          if (remaining > 0) await new Promise<void>(resolve => { window.setTimeout(resolve, remaining); });
          if (signal.aborted) throw new axios.CanceledError('Stopped');
        }
        if (result.success && result.data.reply.trim() && notificationTurnId !== undefined) {
          notifyPromptCompleted(notificationTurnId, startedAt, result.data.sessionId,
            isNoteLinkedPanel ? currentNoteId : undefined);
        }
        // He switched chats while it finished: it's saved in its own chat — never show it in this one.
        if (turnRunRef.current !== run) throw new TurnDetachedError();
        return result;
      } finally {
        await finishDesign?.(designChanged);
        if (turnRunRef.current === run) {
          liveTurnIdRef.current = null;
        }
      }
    },
    onSuccess: (result, { text }) => {
      setLiveTurn(null);
      if (!result.success) setReplyArrival(null);
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
      if (!result.data.reply.trim()) {
        appendMessage('assistant', 'Error: Athena returned no answer. Please try again.');
        return;
      }
      setReplyArrival({ startedAt: Date.now(), complete: true });
      setRevealingAnswer(true);
      appendMessage('assistant', result.data.reply, {
        persona: result.data.persona,
        sources: result.data.sources,
        memoriesCreated: result.data.memoriesCreated,
        noteEdits: result.data.noteEdits,
        noteEditsFor: result.data.noteEditsFor,
        mapChanges: result.data.mapChanges,
        mapChangesFor: result.data.mapChangesFor,
        localFileWrites: result.data.localFileWrites,
        outputsChanged: result.data.outputsChanged,
        id: result.data.assistantMessageId,
        contextUsed: result.data.contextUsed,
        nextSteps: result.data.nextSteps,
      });
      if (result.data.contextUsed?.warnings?.length) emote('unsure', ATHENA_ANSWER_MS);
      else if (/^(thanks|thank you|cheers)[!.\s]*$/i.test(text.trim())) emote('happy', ATHENA_ANSWER_MS);
      else if (result.data.outputsChanged?.length) emote('excited', ATHENA_ANSWER_MS);
      else if (result.data.nextSteps?.length || result.data.pendingActions.length) emote('curious', ATHENA_ANSWER_MS);
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
      setLiveTurn(null);
      setReplyArrival(null);
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
      console.error('[Athena] Could not send message:', describeApiError(err));
      appendMessage(
        'assistant',
        isTimeout
          ? "⚠️ That took too long and timed out. The backend may still be working on it — try again in a moment, or ask a more specific question."
          : `⚠️ Could not send that message: ${describeApiError(err)}`,
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
      request: { persona, projectId: conversationProjectId(isNoteLinkedPanel, noteProjectId, activeProjectId), sessionId: chatIdForUploads() },
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
    setReplyArrival(null);
    setPromptArrivalAt(null);
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
  const busyChangeRef = useRef(onBusyChange);
  busyChangeRef.current = onBusyChange;
  useEffect(() => () => { busyChangeRef.current?.(false); }, []);

  useEffect(() => {
    if (!isNoteLinkedPanel || !currentNoteId) return;
    let active = true;
    const reload = (event: Event): void => {
      if (!(event instanceof CustomEvent) || (event.detail as { noteId?: string } | null)?.noteId !== currentNoteId || chatMutation.isPending || isRestoringHistory) return;
      void api.getSessionIdForNote(currentNoteId).then(async result => {
        if (!result.success) throw new Error(result.error.message);
        if (!result.data.sessionId || !active) return;
        const history = await api.getSessionHistory(result.data.sessionId);
        if (!active) return;
        if (!history.success) throw new Error(history.error.message);
        setSessionId(result.data.sessionId);
        setMessages(stripHistoryContextPrefixes(history.data.messages));
      }).catch((error: unknown) => { if (active) reportHistoryError(error); });
    };
    window.addEventListener('athena-conversation-updated', reload);
    return () => { active = false; window.removeEventListener('athena-conversation-updated', reload); };
  }, [currentNoteId, isNoteLinkedPanel, chatMutation.isPending, isRestoringHistory]);

  // A specialist reported back into this conversation.
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const reload = (event: Event): void => {
      if (!(event instanceof CustomEvent) || (event.detail as { sessionId?: string } | null)?.sessionId !== sessionId || chatMutation.isPending || isRestoringHistory) return;
      void api.getSessionHistory(sessionId).then(history => {
        if (!active) return;
        if (!history.success) throw new Error(history.error.message);
        setMessages(stripHistoryContextPrefixes(history.data.messages));
      }).catch((error: unknown) => { if (active) reportHistoryError(error); });
    };
    window.addEventListener('athena-conversation-updated', reload);
    return () => { active = false; window.removeEventListener('athena-conversation-updated', reload); };
  }, [sessionId, chatMutation.isPending, isRestoringHistory]);

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
      localFileWrites?: LocalFileWrite[] | undefined;
      outputsChanged?: OutputChange[] | undefined;
      id?: string | undefined;
      contextUsed?: ContextUsedApi | undefined;
      nextSteps?: string[] | undefined;
    } = {},
  ): void {
    if (role === 'user') clearEmotion();
    else if (/^(Error:|⚠️)/.test(content)) emote('sorry');
    else if (content.startsWith('✅')) emote('excited');
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
        ...(meta.localFileWrites !== undefined && meta.localFileWrites.length > 0 && { localFileWrites: meta.localFileWrites }),
        ...(meta.outputsChanged !== undefined && meta.outputsChanged.length > 0 && { outputsChanged: meta.outputsChanged }),
        ...(meta.id !== undefined && meta.id !== '' && { id: meta.id }),
        ...(meta.contextUsed !== undefined && { contextUsed: meta.contextUsed }),
        ...(meta.nextSteps !== undefined && meta.nextSteps.length > 0 && { nextSteps: meta.nextSteps }),
      },
    ]);
    if (role === 'user') {
      setPromptArrivalAt(Date.now());
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
    const transform = getComputedStyle(el).transform;
    const entranceOffset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
    const top = el.getBoundingClientRect().top - entranceOffset - box.getBoundingClientRect().top + box.scrollTop - 8;
    window.cancelAnimationFrame(promptScrollFrameRef.current);
    const target = Math.max(0, top);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      box.scrollTop = target;
      return;
    }
    const from = box.scrollTop, started = performance.now();
    const scroll = (now: number): void => {
      const progress = Math.min(1, (now - started) / 400);
      box.scrollTop = from + (target - from) * athenaExpressiveEase(progress);
      promptScrollFrameRef.current = progress < 1 ? window.requestAnimationFrame(scroll) : 0;
    };
    promptScrollFrameRef.current = window.requestAnimationFrame(scroll);
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
  const lastUserIndex = messages.reduce((last, m, idx) => (m.role === 'user' ? idx : last), -1);

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

  async function submitMessage(inputOverride?: string): Promise<void> {
    if (chatMutation.isPending || isRestoringHistory || historyError !== null || uploadProgress !== null) return;
    const composerDraft = inputOverride ?? input;
    const intent = buildComposerIntent({
      input: composerDraft,
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
        emote('unsure');
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
      chatMutation.mutate({ text: outgoing, composerDraft, pageContext: activeImageContext });
    } else if ((isFirstMessage || contextChanged || isNoteLinkedPanel) && pageContext && !isContextDismissed) {
      lastInjectedContextKeyRef.current = contextKey;
      chatMutation.mutate({ text: outgoing, composerDraft, pageContext });
    } else {
      chatMutation.mutate({ text: outgoing, composerDraft });
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
        if (imageReadRef.current?.file === file) imageReadRef.current = null;
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
          contentJson: JSON.stringify((await import('../notes/markdownToBlocks')).markdownToNoteBlocks(fileText)),
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
      if (imageReadRef.current?.file === file) imageReadRef.current = null;
      const message = describeApiError(err);
      appendMessage('assistant', `⚠️ Couldn't upload "${file.name}" — ${message}.`);
    } finally {
      setUploadProgress(null);
    }
  }


  function handleNewChat(): void {
    stopTts();
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
        contentJson: JSON.stringify((await import('../notes/markdownToBlocks')).markdownToNoteBlocks(noteMarkdown)),
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

  const reviewRecordingRef = useRef(false);
  const sendVoiceTranscript = useRef<(transcript: string) => Promise<void>>(async () => {});
  sendVoiceTranscript.current = transcript => submitVoiceTranscript(transcript, input,
    !chatMutation.isPending && !isRestoringHistory && historyError === null && uploadProgress === null,
    setInput, submitMessage);
  const desktopVoiceBusyRef = useRef(false);
  const desktopVoiceId = useRef(Symbol('desktop-voice'));
  const chatRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const owner = desktopVoiceId.current;
    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
      processorRef.current?.disconnect();
      const context = audioCtxRef.current;
      if (context && context.state !== 'closed') void context.close().catch(error => {
        console.error('[Voice input] Could not close audio context:', error);
      });
      if (desktopVoiceOwner === owner) {
        desktopVoiceOwner = null;
        void getDesktop()?.voiceState?.({ recording: false, transcribing: false }).catch(error => {
          console.error('[Stream Deck] Could not clear voice state:', error);
        });
      }
    };
  }, []);
  useEffect(() => {
    if (desktopVoiceOwner !== desktopVoiceId.current) return;
    void getDesktop()?.voiceState?.({ recording: isRecording, transcribing: isTranscribing }).catch(error => {
      console.error('[Stream Deck] Could not publish voice state:', error);
    });
  }, [isRecording, isTranscribing]);
  useDesktopCommand('speak', async () => {
    if (desktopVoiceBusyRef.current || isTranscribing || (!streamRef.current && (chatMutation.isPending || isRestoringHistory))) {
      throw new Error('Chat is busy. Wait for it to finish before recording.');
    }
    desktopVoiceOwner = desktopVoiceId.current;
    desktopVoiceBusyRef.current = true;
    try {
      if (streamRef.current) await stopRecording(true, true);
      else {
        reviewRecordingRef.current = true;
        await startRecording();
        if (!streamRef.current) throw new Error('Microphone access failed. Allow access in the main Athena window and try again.');
      }
    } finally { desktopVoiceBusyRef.current = false; }
  }, () => !standalone && chatRootRef.current?.isConnected === true && chatRootRef.current.getClientRects().length > 0);

  async function startRecording(): Promise<void> {
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioContextCtor();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated but remains the most broadly supported
      // way to get raw PCM samples synchronously — same choice as client-demo.
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      pcmChunksRef.current = [];
      processor.onaudioprocess = (e) => {
        const samples = new Float32Array(e.inputBuffer.getChannelData(0));
        pcmChunksRef.current.push(samples);
        voiceLevelRef.current = microphoneLevel(samples);
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      audioCtxRef.current = ctx;
      processorRef.current = processor;
      streamRef.current = stream;
      setIsRecording(true);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (ctx && ctx.state !== 'closed') await ctx.close().catch(closeError => {
        console.error('[Voice input] Could not close failed capture:', closeError);
      });
      console.error('[Voice input] Microphone capture failed:', error);
      appendMessage('assistant', '⚠️ Could not access the microphone. Check your browser permissions and try again.');
    }
  }

  async function stopRecording(reviewOnly = reviewRecordingRef.current, sendOnFinish = false): Promise<void> {
    const ctx = audioCtxRef.current;
    const processor = processorRef.current;
    const stream = streamRef.current;
    if (!ctx || !processor) {
      setIsRecording(false);
      return;
    }
    processor.disconnect();
    voiceLevelRef.current = 0;
    stream?.getTracks().forEach((t) => t.stop());
    const nativeSampleRate = ctx.sampleRate;
    audioCtxRef.current = null;
    processorRef.current = null;
    streamRef.current = null;
    setIsRecording(false);

    setIsTranscribing(true);
    try {
      await ctx.close();
      const chunks = pcmChunksRef.current;
      pcmChunksRef.current = [];
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      if (totalLen === 0) throw new Error('No audio was captured. Your draft is unchanged.');
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      const resampled = await resampleVoiceAudio(merged, nativeSampleRate, STT_SAMPLE_RATE);
      const wavBlob = encodeWav(resampled, STT_SAMPLE_RATE);
      const audioBase64 = await blobToBase64(wavBlob);
      const result = await api.transcribeVoice(audioBase64, 'audio/wav', 'en-GB', resampled.length / STT_SAMPLE_RATE * 1000);
      if (!result.success) throw new Error(result.error.message);
      const text = result.success ? result.data.text.trim() : '';
      if (text !== '') {
        if (sendOnFinish) {
          await sendVoiceTranscript.current(text);
          return;
        }
        await finishVoiceTranscript(text, reviewOnly, transcript => {
          setInput(current => appendVoiceTranscript(current, transcript));
          textareaRef.current?.focus();
        }, async transcript => {
          // On-screen voice input retains its existing spoken-reply behavior.
          setVoiceOutputOn(true);
          await sendVoiceTranscript.current(transcript);
        });
        return;
      }
      throw new Error('No speech was recognised. Your existing draft is unchanged.');
    } catch (error) {
      console.error('[Voice input] Transcription failed:', error);
      appendMessage('assistant', `⚠️ ${describeApiError(error)}`);
      if (reviewOnly) throw error;
    } finally {
      reviewRecordingRef.current = false;
      setIsTranscribing(false);
    }
  }

  function handleMicClick(): void {
    if (isRecording) {
      void stopRecording().catch(error => { console.error('[Voice input] Recording failed:', error); });
    } else {
      reviewRecordingRef.current = false;
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
      if (action === 'done') emote('excited');
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
      emote('sorry');
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

  const activePersona = getPersona(persona);
  const PersonaChipIcon = activePersona.Icon;

  const composerChipBar = (
    <div className="kh-composer-chips">
      <ComposerControl label={`Persona: ${activePersona.label}`} icon={<PersonaChipIcon size={16} />} active={persona !== 'general'}>
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
      </ComposerControl>
      {pageContext !== undefined && !isContextDismissed && (
        <ComposerControl label={`Context: ${pageContext.title}`} icon={<View size={16} />} active>
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
        </ComposerControl>
      )}

      <ComposerControl label={`Action: ${composerIntent.effectiveAction ? COMPOSER_ACTION_LABELS[composerIntent.effectiveAction] : 'Any action'}`}
        icon={<Idea size={16} />} active={composerIntent.effectiveAction !== undefined}>
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
      </ComposerControl>

      {!isNoteLinkedPanel && (
      <ComposerControl label={`Project: ${chipProjectName || 'No project'}`} icon={<Notebook size={16} />} active={chipProjectId !== ''}>
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
          <ProjectOptions projects={uploadProjectOptions} selected={chipProjectId} />
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
      </ComposerControl>
      )}

    </div>
  );

  const promptNavigation = promptCount > 1 && (
    <div className="ai-prompt-nav" role="group" aria-label="Jump between your messages">
      <button type="button" onClick={() => { jumpToPrompt('prev'); }} title="Previous message you sent (Alt+↑)" aria-label="Previous message you sent">↑</button>
      <button type="button" onClick={() => { jumpToPrompt('next'); }} title="Next message you sent (Alt+↓)" aria-label="Next message you sent">↓</button>
    </div>
  );

  const actionButtons = (
    <>
      {composerChipBar}
      {messages.length > 0 && sessionId !== null && (
        <MoveToThink
          sessionId={sessionId}
          projectId={activeProjectId}
          disabled={isExporting || chatMutation.isPending}
          onExportSummary={handleExportToThink}
          linkConversation={!isNoteLinkedPanel}
        />
      )}
      {messages.length > 0 && !standalone && fixedSessionId === undefined && (
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
      <VoiceVolumeControl value={voiceVolume} onChange={setVoiceVolume} />
    </>
  );

  const motionPhase = athenaMotionPhase({
    pending: chatMutation.isPending,
    activity: liveTurn?.activity ?? 'Sending',
    recording: isRecording,
    transcribing: isTranscribing,
    summarizing: messages.length === 0 && !isRestoringHistory && isNoteLinkedPanel && isNoteSummaryLoading,
    typing: inputFocused && typingActive && input.trim() !== '',
    answered: replyArrival !== null,
  });
  const { mood, emote, clearEmotion } = useAthenaMood(motionPhase, currentNoteId ?? sessionId ?? 'new');
  const latestMessage = messages[messages.length - 1];
  const composerNextSteps = composerSuggestions(
    latestMessage?.role === 'assistant' ? latestMessage.nextSteps : undefined,
    pageContext?.type,
    messages.length ? ['Summarise our conversation', 'What should we do next?', 'Explain the key points in more detail'] : STARTER_PROMPTS,
  );

  const responsePresence = (
    <div className="ai-presence-dock ai-presence-dock--response">
      <span ref={setPresenceDock} className="ai-presence-anchor" aria-hidden="true" />
      {motionPhase === 'typing' && <span className="ai-presence-typing" role="status">Reading your message…</span>}
      <span className="ai-presence-dock__status" role="status">{isRecording ? 'Listening…' : isTranscribing ? 'Transcribing…' : ''}</span>
      {motionPhase === 'idle' && input.trim() === '' && !isRestoringHistory
        && composerNextSteps.length > 0 && (
        <ComposerSuggestion key={`${currentNoteId ?? sessionId ?? 'new'}:${messages.length}`} steps={composerNextSteps}
          onChoose={step => {
            hasUserWorkRef.current = true;
            setInput(step);
            noteTyping();
            textareaRef.current?.focus();
          }} />
      )}
    </div>
  );

  return (
    <div ref={chatRootRef} className={standalone ? 'ai-chat-standalone' : compact ? `ai-chat-compact ai-chat-compact--${compactVariant}` : 'page-root'}>
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
            {promptNavigation}
            {actionButtons}
          </div>
        </div>
      )}
      {!standalone && (
        <div className={compact ? 'ai-new-chat-row ai-new-chat-row--compact' : 'ai-new-chat-row'}>
          {promptNavigation}
          <div className="ai-new-chat-row__actions">
            {actionButtons}
          </div>
        </div>
      )}
      <div ref={conversationRef} className={`ai-conversation${standalone ? ' ai-chat-standalone__body' : compact ? ' ai-chat-compact__body' : ''}`}>
        <AthenaPresence mood={mood} phase={motionPhase} pending={chatMutation.isPending}
          dock={presenceDock} thinker={presenceThinker} voiceLevel={voiceLevelRef} />
        <JobChatConfirmations sessionId={sessionId} />
        {voiceError !== null && <div className="ai-voice-error" role="alert">{voiceError}</div>}
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
            <div className="ai-live-activity" role="status">Restoring conversation</div>
          )}
          {messages.length === 0 && !isRestoringHistory && historyError === null && isNoteLinkedPanel && currentNoteId !== undefined && (
            <div className="ai-note-summary-card">
              <p className="ai-note-summary-card__label">Summary</p>
              {isNoteSummaryLoading ? (
                <ThinkingReply activity="Summarising this note" presenceRef={setPresenceThinker} />
              ) : noteSummaryError !== null ? (
                <div className="ai-history-error" role="alert">
                  <p>Could not summarise this note: {noteSummaryError}</p>
                  <Button kind="ghost" size="sm" onClick={() => { void loadNoteSummary(pageContext?.title ?? 'Untitled', pageContext?.detail ?? ''); }}>Retry summary</Button>
                </div>
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
              <AthenaRibbon mood={mood} size={240} track className="ai-empty__icon" />
              <p className="ai-empty__title">Athena</p>
              {pageContext ? (
                <p className="ai-empty__subtitle ai-empty__context">
                  <span className="ai-empty__context-label">Context:</span> {pageContext.title}
                </p>
              ) : (
                <p className="ai-empty__subtitle">Notes, tasks, commits, articles, sparks — ask anything.</p>
              )}
              <AtRiskChatCard />
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatBubble
              key={i}
              role={msg.role}
              arrivalAt={msg.role === 'user' ? i === lastUserIndex ? promptArrivalAt : null
                : i === lastAssistantIndex && replyArrival?.complete ? replyArrival.startedAt : null}
            >
              {msg.role === 'assistant' && (
                <div className={`ai-reply-heading${i === lastAssistantIndex && motionPhase === 'writing' ? ' ai-reply-heading--answering' : ''}`} aria-hidden="true">
                  <span className="ai-reply-heading__mark">
                    <AthenaRibbon size={20}
                      mood={i === lastAssistantIndex && motionPhase === 'writing' ? 'answering' : 'resting'}
                      still={i !== lastAssistantIndex || motionPhase !== 'writing'} />
                  </span>
                  <span>{i === lastAssistantIndex && motionPhase === 'writing' ? 'Athena · Answering' : 'Athena'}</span>
                </div>
              )}
              {msg.role === 'user' ? (
                <div className="ai-bubble-text"><PeopleMessageText text={msg.content} /></div>
              ) : (
                <AnswerText html={renderAssistantMessage(msg.content, { projectNameById })}
                  arrivalAt={i === lastAssistantIndex && replyArrival?.complete ? replyArrival.startedAt : null}
                  onComplete={() => { setRevealingAnswer(false); }} />
              )}
              {msg.role === 'assistant' && (
                <details className="ai-reply-details">
                  <summary className="ai-reply-details__toggle">Response details</summary>
                  <div className="ai-reply-references">
                  <ReplyMeta persona={msg.persona} sources={msg.sources} />
                  {msg.contextUsed !== undefined && sessionId !== null && (
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
                  </div>
                  {msg.id !== undefined && sessionId !== null && modelChoices.length > 0 && !/^(Error:|⏹️|⚠️)/.test(msg.content) && (
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
                </details>
              )}
              {msg.role === 'assistant' && msg.noteEdits !== undefined && msg.noteEditsFor !== undefined && (
                <NoteEditCard edits={msg.noteEdits} noteId={msg.noteEditsFor} />
              )}
              {msg.role === 'assistant' && msg.mapChanges !== undefined && msg.mapChangesFor !== undefined && (
                <MapChangeCard changes={msg.mapChanges} mapId={msg.mapChangesFor} />
              )}
              {msg.role === 'assistant' && msg.localFileWrites !== undefined && (
                <LocalFileWriteCard writes={msg.localFileWrites} />
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
              <div className="ai-bubble-footer">
                {msg.role === 'assistant' && !/^(Error:|⏹️|⚠️)/.test(msg.content) && (
                  <ReplyFeedback reply={msg.content} persona={msg.persona ?? persona} sessionId={sessionId}
                    onPositive={() => { emote('happy'); }} />
                )}
                <div className="ai-bubble-time" title={formatMessageTime(msg.timestamp)}>
                  {formatMessageTime(msg.timestamp)}
                </div>
                {msg.role === 'assistant' && (
                  <div className="ai-bubble-actions">
                    <button
                      type="button"
                      className="ai-bubble-action-button"
                      aria-label={savingResponseIndex === i ? 'Saving to Think' : 'Save response to Think'}
                      title={savingResponseIndex === i ? 'Saving to Think…' : 'Save response to Think'}
                      disabled={savingResponseIndex !== null}
                      onClick={() => { void handleSaveResponseToThink(msg, i); }}
                    >
                      {savingResponseIndex === i ? <Checkmark size={14} aria-hidden="true" /> : <Notebook size={14} aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="ai-bubble-action-button ai-bubble-copy-button"
                      aria-label={copiedIndex === i ? 'Copied!' : 'Copy response'}
                      title={copiedIndex === i ? 'Copied!' : 'Copy response'}
                      onClick={() => { void handleCopyMessage(msg.content, i); }}
                    >
                      {copiedIndex === i ? <Checkmark size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                    </button>
                  </div>
                )}
              </div>
              {msg.role === 'assistant' && i === lastAssistantIndex && !chatMutation.isPending && responsePresence}
            </ChatBubble>
          ))}
          {chatMutation.isPending && replyArrival?.complete !== true && (liveTurn !== null ? (
            <LiveReply activity={liveTurn.activity} startedAt={liveTurn.startedAt} thinkerRef={setPresenceThinker} />
          ) : (
            <ThinkingReply activity="Athena is thinking" presenceRef={setPresenceThinker} />
          ))}
          {(lastAssistantIndex < 0 || chatMutation.isPending) && responsePresence}
          {holdPromptTop && <div ref={promptRoomRef} className="ai-prompt-room" aria-hidden="true" />}
          <div ref={bottomRef} />
        </div>

        {showJumpToLatest && (
          <div className="ai-scroll-tools">
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

        <div className={`ai-composer${motionPhase === 'listening' || motionPhase === 'typing' ? ' ai-composer--asking' : ''}${isRecording ? ' ai-composer--listening' : ''}`}>
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
                <ProjectOptions projects={uploadProjectOptions} selected={uploadProjectId} />
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

        {historyError !== null && <div className="ai-history-error" role="alert">
          <p>{historyError}</p>
          {sessionId !== null && <Button kind="ghost" size="sm" onClick={() => handleSelectSession(sessionId, true)}>Retry loading conversation</Button>}
        </div>}

        {projectsQuery.error !== null && <DataNotice title="Project choices could not be refreshed." error={projectsQuery.error}
          onRetry={() => { void projectsQuery.refetch(); }} />}
        <form onSubmit={handleSend} className="ai-input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,.md,.markdown,.txt,text/markdown,text/plain,.docx,.xlsx,.csv,text/csv,.pptx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf"
            className="ai-file-input-hidden"
            onChange={handleFileSelected}
          />
          <div className="ai-input-field">
            <ChatMentionSuggestions input={input} textarea={textareaRef} onChange={value => { hasUserWorkRef.current = true; setInput(value); noteTyping(); }} onProject={handleProjectChipChange} />
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
              onChange={(e) => { hasUserWorkRef.current = true; setInput(e.target.value); noteTyping(); }}
              onFocus={() => { setInputFocused(true); }}
              onBlur={() => { setInputFocused(false); }}
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
        {projectError !== null && <p className="kh-composer-chips__error" role="alert">{projectError}</p>}
        <p className="ai-composer__hint">@ references · /spec specification</p>
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
