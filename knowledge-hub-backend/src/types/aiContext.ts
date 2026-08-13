/**
 * AI conversation and context types.
 */

import type { ContentItem } from './contentItem.js';

// 'gpt-5.5' is served from a separate Azure AI Foundry resource (a different
// subscription/project) than 'gpt-4o' / 'gpt-4o-mini' — see foundryClient.ts.
// It is used for the brainstorming persona, which benefits from stronger
// reasoning for critique than the main conversational model provides.
export type AiModel = 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5.5';

/**
 * Athena persona — selectable per chat session. "general" is the default
 * operational assistant (tasks, drafting, execution). "brainstorming" is the
 * ideas sounding board persona, adapted from the user's M365 Copilot agent,
 * for stress-testing early-stage or half-formed ideas rather than executing
 * on them.
 */
export type AthenaPersona = 'general' | 'brainstorming';

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ConversationMessage {
  role: MessageRole;
  content: string;
}

/**
 * Three-layer context built for each conversation turn.
 * Static + project layers form the system prompt.
 * Dynamic context is injected alongside the user message.
 */
export interface AiContext {
  /** Static system context — user prefs, code standards, identity rules. */
  staticContext: string;
  /** Project context — current architecture decisions, active projects. */
  projectContext: string;
  /**
   * Dynamic RAG context — top-N relevant content items retrieved from
   * PostgreSQL FTS for the current user query.
   */
  ragItems: ContentItem[];
}

/** A single conversation session stored in PostgreSQL. */
export interface ConversationSession {
  id: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601 — null if session is still active. */
  endedAt: string | null;
  messages: ConversationMessage[];
  /** Path in blob storage where the session summary markdown was saved. */
  summaryBlobPath?: string;
}

/**
 * Write action payload — AI proposes a write action, user must confirm
 * before execution. Stored server-side until confirmed or cancelled.
 */
export interface WriteActionProposal {
  id: string;
  sessionId: string;
  actionType: WriteActionType;
  /** Human-readable description shown to the user for confirmation. */
  description: string;
  /** Typed payload specific to the action type. */
  payload: WriteActionPayload;
  /** ISO 8601. */
  proposedAt: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed';
}

export type WriteActionType =
  | 'cms-publish-post'
  | 'cms-update-social-push'
  | 'todo-create-task'
  | 'todo-update-task'
  | 'github-create-issue'
  | 'blob-save-markdown';

export type WriteActionPayload =
  | CmsPublishPostPayload
  | CmsUpdateSocialPushPayload
  | TodoCreateTaskPayload
  | TodoUpdateTaskPayload
  | GithubCreateIssuePayload
  | BlobSaveMarkdownPayload;

export interface CmsPublishPostPayload {
  type: 'cms-publish-post';
  postId: string;
  title: string;
  content: string;
  categories: string[];
  tags: string[];
  excerpt: string;
  slug: string;
}

export interface CmsUpdateSocialPushPayload {
  type: 'cms-update-social-push';
  postId: string;
  platform: 'linkedin' | 'x' | 'bluesky';
}

export interface TodoCreateTaskPayload {
  type: 'todo-create-task';
  title: string;
  body?: string;
  dueDateTime?: string;
  listName?: string;
}

export interface TodoUpdateTaskPayload {
  type: 'todo-update-task';
  taskId: string;
  updates: Partial<{ title: string; body: string; status: string; dueDateTime: string }>;
}

export interface GithubCreateIssuePayload {
  type: 'github-create-issue';
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

export interface BlobSaveMarkdownPayload {
  type: 'blob-save-markdown';
  /** e.g. "2026-04-12-topic-slug.md" */
  filename: string;
  content: string;
}
