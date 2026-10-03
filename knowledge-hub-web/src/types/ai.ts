import type { MapOp } from '../services/api';
/**
 * AI conversation types — mirrors backend aiContext types.
 */

// 'gpt-5.4' is used automatically for reasoning personas (backend picks it by
// default) — not currently selectable from the frontend.
export type AiModel = 'standard' | 'light' | 'reasoning';

export type AthenaPersona = 'general' | 'brainstorming' | 'copilot_coach' | 'blog_post' | 'demo_designer' | 'podcast_prep' | 'web_designer' | 'podcast_show_notes';

export interface ChatPageContext {
  /** e.g. "content-item", "task", "note", "spark", "document" */
  type: string;
  title: string;
  detail?: string;
  /** Mind map: the selected idea. */
  selectedId?: string;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  model?: AiModel;
  persona?: AthenaPersona;
  projectId?: string | null;
  /**
   * What the user is currently viewing (e.g. the note open alongside this
   * chat). Sent as a separate field — NOT glued into `message` — so the
   * backend can inject it as a clearly-labeled, high-priority source while
   * keeping the auto-RAG search query limited to what the user actually
   * typed. Gluing a large document body into the search query used to cause
   * unrelated same-project documents to surface as "background context" and
   * get blended into answers about the document in view.
   */
  pageContext?: ChatPageContext;
  /**
   * The Think note this chat belongs to, if any. When present, the backend
   * links the session to this note so the Think-embedded Athena panel can
   * restore the right conversation when the user switches back to it later.
   */
  noteId?: string;
  /** Look at the chat's screens together first: the journey, or the marked areas of some screens. */
  screenReview?: { mode: 'journey' | 'focus'; screenIds?: string[] };
  /** False when this view has no Outputs panel (Think, the floating chat, mobile): deliverables go in the reply. */
  outputsPanel?: boolean;
}

export interface ChatMessage {
  /** Saved message id (assistant replies) — for "Ask another model". */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Persona that produced an assistant reply. */
  persona?: AthenaPersona;
  /** Tool names the reply drew on (e.g. 'list_tasks'), shown as "From: Plan". */
  sources?: string[];
  /** Standing instructions Athena saved during this turn (shown as "Remembered: …" with Undo). */
  memoriesCreated?: SavedMemory[];
  /** Edits Athena proposed to the open Think note (previewed; applied on click). */
  noteEdits?: NoteEdit[];
  /** The note those edits were written for. */
  noteEditsFor?: string;
  /** Changes Athena proposed to the open mind map (previewed; applied on click). */
  mapChanges?: MapChange[];
  /** The map those changes were written for. */
  mapChangesFor?: string;
  /** Outputs Athena saved or revised in this reply (chips that open the Outputs panel). */
  outputsChanged?: OutputChange[];
  /** What the reply drew on (the "Used:" line). */
  contextUsed?: ContextUsedApi;
  /** Suggested next steps (buttons under the latest reply). */
  nextSteps?: string[];
}

/** An item a reply drew on. */
export interface UsedSourceApi {
  id: string;
  /** note | document | item | node */
  kind: string;
  title: string;
  url?: string | null;
}

/** What a reply drew on (the "Used:" line under it). */
export interface ContextUsedApi {
  project: string | null;
  instructions: number;
  inView: string | null;
  found: UsedSourceApi[];
  auto: UsedSourceApi[];
  outputs: number;
  decisions: number;
  screens: number;
}

/** An output saved or revised in a turn. */
export interface OutputChange {
  id: string;
  title: string;
  version: number;
}

/** A deliverable kept with a chat (the Outputs panel). */
export interface ChatOutputSummary {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  /** markdown = rendered; text = one copyable block (e.g. a prompt). */
  format: 'markdown' | 'text' | 'html';
  version: number;
  updatedAt: string;
}

export interface ChatOutputVersion {
  version: number;
  content: string;
  author: 'athena' | 'user';
  note: string | null;
  createdAt: string;
}

export interface ChatOutput extends ChatOutputSummary {
  versions: ChatOutputVersion[];
}

/** A decided or still-open point in a chat (the Decisions panel). */
export interface ChatDecision {
  id: string;
  status: 'decided' | 'open';
  text: string;
  source: 'auto' | 'user';
  createdAt: string;
  updatedAt: string;
}

/** A screenshot kept with a chat (the Screens panel). */
export interface ChatScreen {
  id: string;
  sessionId: string;
  /** Step name in the journey. */
  name: string;
  contentType: string;
  position: number;
  inJourney: boolean;
  hasReading: boolean;
  /** Has a marked-up copy (boxes drawn on it). */
  annotated: boolean;
  annotationNote: string | null;
  createdAt: string;
}

export interface DecisionTracking {
  enabled: boolean;
  /** The chat's own setting; null = the persona default. */
  explicit: boolean | null;
  personaDefault: boolean;
}

/** One change Athena proposes to the open mind map (a summary plus the ops that make it). */
export interface MapChange {
  summary: string;
  ops: MapOp[];
}

/** One edit Athena proposes to the open Think note. */
export interface NoteEdit {
  action: 'append' | 'prepend' | 'add_to_section' | 'replace_section' | 'delete_section' | 'replace_text' | 'replace_all';
  heading?: string;
  find?: string;
  markdown?: string;
  summary: string;
}

/** A standing instruction just saved via chat. */
export interface SavedMemory {
  id: string;
  content: string;
  scopeType: MemoryScopeType;
  scopeValue: string | null;
}

export type MemoryScopeType = 'global' | 'persona' | 'project' | 'output';
export type MemoryStatus = 'active' | 'paused' | 'suggested' | 'dismissed';

/** Athena's learned memory (Memory page). */
export interface AthenaMemory {
  id: string;
  kind: 'instruction' | 'example' | 'profile';
  content: string;
  scopeType: MemoryScopeType;
  scopeValue: string | null;
  status: MemoryStatus;
  origin: 'chat' | 'feedback' | 'weekly' | 'manual' | 'profile-import';
  sourceExcerpt: string | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WriteActionType =
  | 'cms-publish-post'
  | 'cms-update-social-push'
  | 'todo-create-task'
  | 'todo-update-task'
  | 'github-create-issue'
  | 'blob-save-markdown';

export interface WriteActionProposal {
  id: string;
  type: WriteActionType;
  description: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed';
  createdAt: string;
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
  persona?: AthenaPersona;
  sources?: string[];
  memoriesCreated?: SavedMemory[];
  noteEdits?: NoteEdit[];
  noteEditsFor?: string | null;
  mapChanges?: MapChange[];
  mapChangesFor?: string | null;
  outputsChanged?: OutputChange[];
  /** The saved reply's id (for "Ask another model"). */
  assistantMessageId?: string;
  contextUsed?: ContextUsedApi;
  nextSteps?: string[];
  pendingActions: WriteActionProposal[];
}

/** A model offered for "Ask another model". */
export interface ModelChoiceApi {
  id: string;
  label: string;
  /** This is the model that wrote the persona's replies, so asking it again would just repeat the reply. */
  current?: boolean;
}

/** Another model's answer to one of Athena's replies ('original' = an answer replaced by "Use this one"). */
export interface ChatAlternate {
  id: string;
  messageId: string;
  model: string;
  label: string;
  content: string;
  createdAt: string;
}

/** Live events for a chat turn running on the server (GET /api/ai/chat/turns/:id/events). */
export type ChatTurnEvent =
  | { type: 'snapshot'; message: string; activity: string; text: string }
  | { type: 'activity'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; data: ChatResponse }
  | { type: 'error'; message: string; stopped: boolean }
  | { type: 'gone' };

/** A chat's turn still running on the server, or one cut off by a restart. */
export type SessionTurnState =
  | { status: 'running'; turnId: string; message: string; startedAt: string }
  | { status: 'interrupted'; message: string; startedAt: string }
  | null;

export interface ChatSessionSummary {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  preview: string;
  persona?: AthenaPersona;
  projectId: string | null;
  pinned?: boolean;
}

export interface ExportToThinkResponse {
  noteId: string;
  title: string;
  url: string;
}
