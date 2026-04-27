/**
 * AI conversation types — mirrors backend aiContext types.
 */

export type AiModel = 'gpt-4o' | 'gpt-4o-mini';

export interface ChatRequest {
  message: string;
  sessionId?: string;
  model?: AiModel;
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
  pendingActions: WriteActionProposal[];
}
