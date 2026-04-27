/**
 * AI conversation types — mirrors the backend aiContext types.
 */

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  timestamp: string;
}

export type AiModel = 'gpt-4o' | 'gpt-4o-mini';

export interface ChatRequest {
  message: string;
  sessionId?: string;
  model?: AiModel;
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
  pendingActions: WriteActionProposal[];
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
