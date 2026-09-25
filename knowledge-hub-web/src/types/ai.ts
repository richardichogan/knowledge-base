/**
 * AI conversation types — mirrors backend aiContext types.
 */

// 'gpt-5.4' is used automatically for reasoning personas (backend picks it by
// default) — not currently selectable from the frontend.
export type AiModel = 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5.4';

export type AthenaPersona = 'general' | 'brainstorming' | 'copilot_coach' | 'blog_post';

export interface ChatPageContext {
  /** e.g. "content-item", "task", "note", "spark", "document" */
  type: string;
  title: string;
  detail?: string;
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
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
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
  pendingActions: WriteActionProposal[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  preview: string;
  persona?: AthenaPersona;
  projectId: string | null;
}

export interface ExportToThinkResponse {
  noteId: string;
  title: string;
  url: string;
}
