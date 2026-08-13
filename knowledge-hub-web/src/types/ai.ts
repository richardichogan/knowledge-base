/**
 * AI conversation types — mirrors backend aiContext types.
 */

// 'gpt-5.5' is used automatically for the brainstorming persona (backend
// picks it by default) — not currently selectable from the frontend.
export type AiModel = 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5.5';

export type AthenaPersona = 'general' | 'brainstorming' | 'copilot_coach';

export interface ChatRequest {
  message: string;
  sessionId?: string;
  model?: AiModel;
  persona?: AthenaPersona;
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
}

export interface ExportToThinkResponse {
  noteId: string;
  title: string;
  url: string;
}
