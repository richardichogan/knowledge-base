/**
 * Typed API client for the Knowledge Hub backend.
 * Base URL and token come from Vite env vars (VITE_* prefix).
 */

import axios, { type AxiosInstance } from 'axios';
import type {
  ApiResponse,
  PaginatedList,
  ContentItemSummary,
  ChatRequest,
  ChatResponse,
  ChatTurnEvent,
  SessionTurnState,
  ChatOutputSummary,
  ChatOutput,
  ChatDecision,
  DecisionTracking,
  ChatScreen,
  ModelChoiceApi,
  ChatAlternate,
  UsedSourceApi,
  ChatMessage,
  ChatSessionSummary,
  AthenaPersona,
  ExportToThinkResponse,
  CreateTaskInput,
  CreateNoteInput,
  Note,
  NoteSummary,
  WriteActionProposal,
  AthenaMemory,
  MemoryScopeType,
} from '../types';
import { getApiToken } from './auth';
import type { DiagramAsset, DiagramDocument, DiagramSnapshot } from '../features/diagram/diagramTypes';
import type { GitHubPublication, GitHubPushPayload } from '../notes/types';

// Use relative base URL so all requests go through the Vite dev proxy.
const BASE_URL = import.meta.env['VITE_API_URL'] as string | undefined ?? '';
/** Backend origin ('' in dev, where Vite proxies /api and /auth). */
export const API_BASE_URL = BASE_URL;
const TOKEN = import.meta.env['VITE_API_TOKEN'] as string | undefined ?? '';

const TIMEOUT_MS = 8_000;
// Blob upload + OCR polling on the backend can take up to ~40s; give image
// uploads a much longer client-side timeout than regular API calls.
const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;
// AI chat turns can chain several tool calls (KG search, Library search, task
// writes) plus an LLM generation pass — this routinely exceeds the default
// 8s timeout, which was silently killing the request with no visible error.
// Kept just above the backend's own AI_CONVERSATION_TURN_BUDGET_MS (110s,
// see constants.ts) so a reasoning-model (gpt-5.4) turn that legitimately
// needs the full backend budget still gets a chance to finish before the
// client gives up on it.
const CHAT_TIMEOUT_MS = 120_000;

function makeClient(baseURL: string, token: string): AxiosInstance {
  const client = axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== '' && { Authorization: `Bearer ${token}` }),
    },
  });
  // Microsoft sign-in token (production) takes precedence over the static one.
  client.interceptors.request.use(async (config) => {
    const signedIn = await getApiToken();
    if (signedIn !== '') config.headers.set('Authorization', `Bearer ${signedIn}`);
    return config;
  });
  return client;
}

/**
 * Reads a chat turn's live events (server-sent events over fetch, so the
 * sign-in header can be sent). Resolves when the stream ends; the caller
 * decides whether to reconnect.
 */
export async function readChatTurnEvents(
  turnId: string,
  onEvent: (e: ChatTurnEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const signedIn = await getApiToken();
  const auth = signedIn !== '' ? signedIn : TOKEN;
  const response = await fetch(`${BASE_URL}/api/ai/chat/turns/${turnId}/events`, {
    headers: auth !== '' ? { Authorization: `Bearer ${auth}` } : {},
    signal,
  });
  if (!response.ok || response.body === null) throw new Error(`Turn events failed: ${response.status.toString()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data !== '') onEvent(JSON.parse(data) as ChatTurnEvent);
    }
  }
}

export interface NoteVersionSummary {
  id: string; revision: number; writing_updated_at: string; created_at: string;
  reason: 'automatic' | 'before_athena' | 'before_restore' | 'before_github'; restored_from: string | null;
}
export interface NoteVersion extends NoteVersionSummary {
  writing: { title: string; contentType: string; contentJson: string };
}

export interface TimelineQuery {
  since?: string; // Recent activity by source update time, excluding future events
  page?: number;
  pageSize?: number;
  source?: string;
  projectContext?: string;
  before?: string; // ISO date cursor for day-boundary pagination
}

export interface SearchQuery {
  q: string;
  page?: number;
  pageSize?: number;
}

export interface SourceStatus {
  source: string;
  lastSyncAt: string | null;
  itemCount: number;
  lastError: string | null;
  syncCadenceMinutes: number | null;
  status: 'ok' | 'error' | 'never-synced';
}

export type DocType = 'blog-draft' | 'spec' | 'newsletter' | 'readme' | 'doc';

export interface DocEntry {
  id: string;
  /** Database id — the document's knowledge-graph node id; absent for live GitHub listings. */
  contentItemId?: string;
  title: string;
  type: DocType;
  repo: string;
  path: string;
  sourceLabel: string;
  projectId: string;
  htmlUrl: string;
  size: number;
  tags: string[];
  taxonomyTagIds?: string[];
}

export interface AllianceStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  connectedAt: string | null;
  lastError: string | null;
  root: string;
  syncRunning: boolean;
  sync: { lastSyncAt: string | null; fileCount: number; documentCount: number; lastError: string | null };
}

export interface DocumentContent {
  path: string;
  content: string;
  sha: string;
  /** True when GitHub was unreachable and this is the indexed (plain-text) copy. */
  fromIndex?: boolean;
}

export type DiscoverWorkflowState = 'to-review' | 'saved' | 'blog' | 'archived' | 'published' | 'shelved';

/** Workflow states for CFP items (separate from article workflow) */
export type CfpWorkflowState = 'to_review' | 'saved' | 'submitted' | 'archived';

export interface CfpItem {
  id: string;
  source: 'callingallpapers' | 'adatosystems';
  conferenceName: string;
  description: string | null;
  tags: string[];
  eventUri: string | null;
  cfpUri: string;
  cfpDeadline: string;
  eventStart: string | null;
  eventEnd: string | null;
  location: string | null;
  isVirtual: boolean;
  relevanceScore: number | null;
  relevanceReason: string | null;
  workflowState: CfpWorkflowState;
  discoveredAt: string;
}

export type ProjectColour = 'blue' | 'cyan' | 'teal' | 'purple' | 'green' | 'magenta' | 'warm-gray' | 'gray' | 'red';
export type ProjectCategory = 'work' | 'personal' | 'side-hustle';
export type ProjectPriority = 'low' | 'medium' | 'high';
export type ProjectType = 'standard' | 'formal-client';
export type ProjectLifecycleState = 'active' | 'paused' | 'completed' | 'archived';
export type ProjectImportance = 'critical' | 'high' | 'normal' | 'low';

export interface ProjectLink { label: string; url: string; }

export interface Project {
  id: string;
  name: string;
  colour: ProjectColour;
  category: ProjectCategory;
  priority: ProjectPriority;
  projectType: ProjectType;
  description: string;
  goal: string;
  role: string;
  ownership: string;
  lifecycleState: ProjectLifecycleState;
  startDate: string | null;
  targetEndDate: string | null;
  importance: ProjectImportance;
  expectedOutputs: string[];
  gitlabPaths: string[];
  githubRepos: string[];
  hasIcaDocumentCollection: boolean;
  icaDocumentCollectionName: string;
  icaDocumentCollectionId: string;
  links: ProjectLink[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoTagMapping {
  id: string;
  tagId: string;
  tagName: string;
  tagColour: string | null;
  githubRepos: string[];
  gitlabPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaxonomyTag {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  colour: string | null;
  role: 'filing' | 'concept';
  usageCount: number;
  children?: TaxonomyTag[];
}

export interface PendingSuggestion {
  id: string;
  suggestedName: string;
  suggestedCount: number;
  exampleContent: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'merged';
  mergedToId: string | null;
  createdAt: string;
  likelyMatch?: { id: string; name: string } | null;
}

export interface Spark {
  id: string;
  sourceId: string | null;
  sourceType: string | null;
  body: string;
  tags: string[];
  clusterId: string | null;
  createdAt: string;
}

export interface SparkCluster {
  id: string;
  theme: string;
  sparkCount: number;
  surfaced: boolean;
  surfacedAt: string | null;
  dismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionEdge {
  edgeId: string;
  edgeType: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  connectedNode: { id: string; refId: string; refType: string; title: string; url?: string | null };
  createdAt: string;
}

export type ConnectionsResponse = Record<string, ConnectionEdge[]>;

export interface GraphNode {
  id: string;
  refId: string;
  refType: string;
  title: string;
  tags: string[];
  createdAt: string;
  conceptParent: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    filteredNodes: number;
    filteredEdges: number;
    truncated: boolean;
  };
}

export interface DiscoverItem {
  id: string;
  sourceId: string;
  title: string;
  url: string | null;
  description: string | null;
  publishedAt: string;
  indexedAt: string;
  sourceTitle: string;
  workflowState: DiscoverWorkflowState;
  relevanceScore: number | null;
  relevanceExplanation: string | null;
  /** URL of the user's own blog post written about this article */
  publishedUrl: string | null;
  /** Taxonomy tag UUIDs from discover_item_tags */
  taxonomyTagIds: string[];
  /** AI-classified article type */
  articleType: string | null;
  /** Treatment plan: Full Blog Post, LinkedIn Standalone, Newsletter Candidate, Archive, Podcast */
  platform: string | null;
  /** Source type: Formal, Community, Case Study, Advertorial */
  sourceType: string | null;
  /** Spark flag indicating high value */
  spark: boolean | null;
  /** Reason for spark flag */
  sparkReason: string | null;
  /** Composite relevance score 0-10 */
  compositeScore: number | null;
  /** 0 = not covered, 1 = same story from another angle, 2 = he has already made this argument */
  alreadyCovered?: number | null;
  /** Title of his own piece that covers it */
  coveredBy?: string | null;
  /** Vendor group of the feed it came from */
  sourceGroup?: string | null;
  /** When it was shelved */
  shelvedAt?: string | null;
  /** Why: 'low' = scored as not worth content, 'stale' = unactioned for its time in To Review */
  shelvedReason?: string | null;
}

/** A feed Athena reads for article discovery. */
export interface DiscoveryFeed {
  id: string;
  title: string;
  feedUrl: string;
  groupName: string;
  isActive: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastNewCount: number;
  articlesFound: number;
}

export class KnowledgeHubApi {
  private readonly client: AxiosInstance;

  constructor(baseURL = BASE_URL) {
    this.client = makeClient(baseURL, TOKEN);
  }

  // ─── Timeline ────────────────────────────────────────────────────────────

  async getTimeline(
    query: TimelineQuery = {},
  ): Promise<ApiResponse<PaginatedList<ContentItemSummary>>> {
    const r = await this.client.get<
      ApiResponse<PaginatedList<ContentItemSummary>>
    >('/api/timeline', { params: query });
    return r.data;
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async search(
    query: SearchQuery,
  ): Promise<ApiResponse<PaginatedList<ContentItemSummary>>> {
    const r = await this.client.get<
      ApiResponse<PaginatedList<ContentItemSummary>>
    >('/api/search', { params: query });
    return r.data;
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  async getSources(): Promise<ApiResponse<SourceStatus[]>> {
    const r = await this.client.get<ApiResponse<SourceStatus[]>>('/api/sources');
    return r.data;
  }

  async triggerSync(): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>('/api/sources/sync');
    return r.data;
  }

  // ─── Notes (Change 002) ───────────────────────────────────────────────────

  async getNotes(
    page = 1,
    pageSize = 20,
  ): Promise<ApiResponse<PaginatedList<Note>>> {
    const r = await this.client.get<ApiResponse<PaginatedList<Note>>>(
      '/api/notes',
      { params: { page, pageSize } },
    );
    return r.data;
  }

  /** Lightweight note list for the Think sidebar: titles/previews only, no bodies. */
  async getNoteSummaries(page = 1, pageSize = 100): Promise<ApiResponse<PaginatedList<NoteSummary>>> {
    const r = await this.client.get<ApiResponse<PaginatedList<NoteSummary>>>(
      '/api/notes',
      { params: { page, pageSize, view: 'summary' } },
    );
    return r.data;
  }

  /** One note with its full body. */
  async getNote(id: string): Promise<ApiResponse<Note>> {
    const r = await this.client.get<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}`);
    return r.data;
  }

  async getNoteGitHub(id: string, check = false): Promise<ApiResponse<GitHubPublication | null>> {
    return (await this.client.get<ApiResponse<GitHubPublication | null>>(`/api/notes/${encodeURIComponent(id)}/github`, {
      params: { check }, timeout: 60_000,
    })).data;
  }

  async getNoteGitHubRepositories(page = 1): Promise<ApiResponse<{ items: { name: string; defaultBranch: string; private: boolean }[]; hasMore: boolean }>> {
    return (await this.client.get<ApiResponse<{ items: { name: string; defaultBranch: string; private: boolean }[]; hasMore: boolean }>>('/api/notes/github/repositories', { params: { page }, timeout: 60_000 })).data;
  }

  async getNoteGitHubFolders(repo: string, folder: string): Promise<ApiResponse<{ folders: string[]; branch: string }>> {
    return (await this.client.get<ApiResponse<{ folders: string[]; branch: string }>>('/api/notes/github/folders', { params: { repo, folder }, timeout: 60_000 })).data;
  }

  async publishNoteToGitHub(payload: GitHubPushPayload): Promise<ApiResponse<GitHubPublication>> {
    return (await this.client.post<ApiResponse<GitHubPublication>>(`/api/notes/${encodeURIComponent(payload.noteId)}/github`, payload, { timeout: 120_000 })).data;
  }

  async getNoteGitHubRemote(id: string): Promise<ApiResponse<{ sha: string | null; markdown: string | null }>> {
    return (await this.client.get<ApiResponse<{ sha: string | null; markdown: string | null }>>(`/api/notes/${encodeURIComponent(id)}/github/remote`, { timeout: 60_000 })).data;
  }

  async resolveNoteGitHub(id: string, choice: 'think' | 'github', remoteSha: string | null, expectedRevision: number): Promise<ApiResponse<GitHubPublication>> {
    return (await this.client.post<ApiResponse<GitHubPublication>>(`/api/notes/${encodeURIComponent(id)}/github/resolve`,
      { choice, remoteSha, expectedRevision }, { timeout: 120_000 })).data;
  }

  async createNote(input: CreateNoteInput): Promise<ApiResponse<Note>> {
    const r = await this.client.post<ApiResponse<Note>>('/api/notes', input);
    return r.data;
  }

  async deleteNote(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/notes/${id}`);
    return r.data;
  }

  /** Updates a note. `tags` is only sent when given — omitting it leaves the stored tags untouched. */
  async patchNote(id: string, content: string, tags?: string[], projectId?: string | null, expectedRevision?: number): Promise<ApiResponse<Note>> {
    const body: Record<string, unknown> = { content, expectedRevision };
    if (tags !== undefined) body['tags'] = tags;
    if (projectId !== undefined) body['projectId'] = projectId;
    const r = await this.client.patch<ApiResponse<Note>>(`/api/notes/${id}`, body);
    return r.data;
  }

  async getNoteHistory(id: string): Promise<ApiResponse<NoteVersionSummary[]>> {
    return (await this.client.get<ApiResponse<NoteVersionSummary[]>>(`/api/notes/${encodeURIComponent(id)}/history`)).data;
  }

  async getNoteVersion(id: string, versionId: string): Promise<ApiResponse<NoteVersion>> {
    return (await this.client.get<ApiResponse<NoteVersion>>(`/api/notes/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}`)).data;
  }

  async checkpointNote(id: string, content: string, expectedRevision: number): Promise<ApiResponse<Note>> {
    return (await this.client.post<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}/checkpoint`, { content, expectedRevision })).data;
  }

  async restoreNoteVersion(id: string, versionId: string, expectedRevision: number, content?: string): Promise<ApiResponse<Note>> {
    return (await this.client.post<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}/restore`, { expectedRevision, content })).data;
  }

  // ─── Images (Change 003) ──────────────────────────────────────────────────

  async uploadImage(
    file: File,
    caption?: string,
  ): Promise<ApiResponse<{ id: string; blobUrl: string }>> {
    // Backend expects a raw binary body (express.raw), not multipart/form-data.
    // The response returns as soon as the blob upload completes — OCR/vision
    // analysis run afterwards in the background on the server, so this is
    // fast even though the blob upload itself can still take a moment.
    const buffer = await file.arrayBuffer();
    const r = await this.client.post<
      ApiResponse<{ id: string; blobUrl: string }>
    >('/api/images', buffer, {
      headers: { 'Content-Type': file.type !== '' ? file.type : 'application/octet-stream' },
      params: caption !== undefined && caption !== '' ? { caption } : undefined,
      timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
    return r.data;
  }

  /** Analyzes an ephemeral image for Athena without storing it in the image library. */
  async analyzeChatImage(
    file: File,
    question?: string,
    persona?: string,
  ): Promise<ApiResponse<{ analysis: string }>> {
    const buffer = await file.arrayBuffer();
    const r = await this.client.post<ApiResponse<{ analysis: string }>>(
      '/api/images/analyze-chat',
      buffer,
      {
        headers: { 'Content-Type': file.type },
        params: { ...(question?.trim() && { question: question.trim() }), ...(persona !== undefined && { persona }) },
        // Demo Designer's detailed screen read uses the slower reasoning model.
        timeout: persona === 'demo_designer' || persona === 'web_designer' ? 2 * IMAGE_UPLOAD_TIMEOUT_MS : IMAGE_UPLOAD_TIMEOUT_MS,
      },
    );
    return r.data;
  }

  /**
   * Look up stored vision analysis / OCR text for image blobs already embedded
   * in a note or canvas (matched by the blob name in each URL). Used to prime
   * Athena with what a pasted screenshot/diagram actually shows, instead of
   * just its filename.
   */
  async lookupImages(
    blobUrls: string[],
  ): Promise<ApiResponse<{ items: Array<{ id: string; visionAnalysis?: string; ocrText?: string; caption?: string }> }>> {
    // The /api/images mount uses express.raw() for every content-type, so send
    // JSON as a raw buffer rather than relying on axios's default JSON headers.
    const r = await this.client.post<
      ApiResponse<{ items: Array<{ id: string; visionAnalysis?: string; ocrText?: string; caption?: string }> }>
    >('/api/images/lookup', JSON.stringify({ blobUrls }), {
      headers: { 'Content-Type': 'application/json' },
    });
    return r.data;
  }

  // ─── AI Chat ──────────────────────────────────────────────────────────────

  /** Starts a chat turn that runs on the server in the background (see services/chatTurns.ts). */
  async startChatTurn(request: ChatRequest): Promise<ApiResponse<{ turnId: string; sessionId: string }>> {
    const r = await this.client.post<ApiResponse<{ turnId: string; sessionId: string }>>('/api/ai/chat/turns', request);
    return r.data;
  }

  /** Stops a running chat turn (the Stop button). */
  async cancelChatTurn(turnId: string): Promise<void> {
    await this.client.post(`/api/ai/chat/turns/${turnId}/cancel`);
  }

  /** A turn still running for this chat (to reattach to) or one interrupted by a restart. */
  async getSessionTurn(sessionId: string): Promise<ApiResponse<SessionTurnState>> {
    const r = await this.client.get<ApiResponse<SessionTurnState>>(`/api/ai/session/${sessionId}/turn`);
    return r.data;
  }

  async dismissSessionTurn(sessionId: string): Promise<void> {
    await this.client.delete(`/api/ai/session/${sessionId}/turn`);
  }

  // ─── Chat side panel: Outputs and Decisions ─────────────────────────────────

  async listChatOutputs(sessionId: string): Promise<ApiResponse<ChatOutputSummary[]>> {
    const r = await this.client.get<ApiResponse<ChatOutputSummary[]>>(`/api/ai/session/${sessionId}/outputs`);
    return r.data;
  }

  async getChatOutput(outputId: string): Promise<ApiResponse<ChatOutput>> {
    const r = await this.client.get<ApiResponse<ChatOutput>>(`/api/ai/outputs/${outputId}`);
    return r.data;
  }

  /** Saves the user's edit as a new version. */
  async addChatOutputVersion(outputId: string, content: string): Promise<ApiResponse<{ id: string; version: number }>> {
    const r = await this.client.post<ApiResponse<{ id: string; version: number }>>(`/api/ai/outputs/${outputId}/versions`, { content });
    return r.data;
  }

  async renameChatOutput(outputId: string, title: string): Promise<void> {
    await this.client.patch(`/api/ai/outputs/${outputId}`, { title });
  }

  async deleteChatOutput(outputId: string): Promise<void> {
    await this.client.delete(`/api/ai/outputs/${outputId}`);
  }

  async saveChatOutputToThink(outputId: string, version: number): Promise<ApiResponse<{ noteId: string; title: string; url: string }>> {
    const r = await this.client.post<ApiResponse<{ noteId: string; title: string; url: string }>>(`/api/ai/outputs/${outputId}/save-to-think`, { version });
    return r.data;
  }

  async getChatDecisions(sessionId: string): Promise<ApiResponse<{ tracking: DecisionTracking; decisions: ChatDecision[] }>> {
    const r = await this.client.get<ApiResponse<{ tracking: DecisionTracking; decisions: ChatDecision[] }>>(`/api/ai/session/${sessionId}/decisions`);
    return r.data;
  }

  async addChatDecision(sessionId: string, status: ChatDecision['status'], text: string): Promise<void> {
    await this.client.post(`/api/ai/session/${sessionId}/decisions`, { status, text });
  }

  async updateChatDecision(decisionId: string, patch: { status?: ChatDecision['status']; text?: string }): Promise<void> {
    await this.client.patch(`/api/ai/decisions/${decisionId}`, patch);
  }

  async deleteChatDecision(decisionId: string): Promise<void> {
    await this.client.delete(`/api/ai/decisions/${decisionId}`);
  }

  async setDecisionTracking(sessionId: string, enabled: boolean | null): Promise<void> {
    await this.client.put(`/api/ai/session/${sessionId}/decision-tracking`, { enabled });
  }

  /** Stores a screenshot with a chat and reads it (a detailed read for Demo Designer). */
  async uploadChatScreen(sessionId: string, file: File, persona: string, question?: string): Promise<ApiResponse<{ screen: ChatScreen; reading: string }>> {
    const r = await this.client.post<ApiResponse<{ screen: ChatScreen; reading: string }>>(
      `/api/ai/session/${sessionId}/screens`,
      await file.arrayBuffer(),
      {
        headers: { 'Content-Type': file.type },
        params: { name: file.name.replace(/\.[a-z0-9]+$/i, ''), persona, ...(question?.trim() && { question: question.trim() }) },
        timeout: 2 * IMAGE_UPLOAD_TIMEOUT_MS,
      },
    );
    return r.data;
  }

  async listChatScreens(sessionId: string): Promise<ApiResponse<ChatScreen[]>> {
    const r = await this.client.get<ApiResponse<ChatScreen[]>>(`/api/ai/session/${sessionId}/screens`);
    return r.data;
  }

  /** The screenshot (or its marked-up copy) as a blob, fetched with sign-in. */
  async fetchChatScreenImage(screenId: string, annotated: boolean): Promise<Blob> {
    const r = await this.client.get<Blob>(`/api/ai/screens/${screenId}/image`, {
      params: annotated ? { annotated: 1 } : {}, responseType: 'blob', timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
    return r.data;
  }

  async updateChatScreen(screenId: string, patch: { name?: string; inJourney?: boolean }): Promise<void> {
    await this.client.patch(`/api/ai/screens/${screenId}`, patch);
  }

  async reorderChatScreens(sessionId: string, ids: string[]): Promise<void> {
    await this.client.put(`/api/ai/session/${sessionId}/screens/order`, { ids });
  }

  async saveScreenAnnotation(screenId: string, png: Blob, note: string): Promise<void> {
    await this.client.put(`/api/ai/screens/${screenId}/annotation`, png, {
      headers: { 'Content-Type': 'image/png' }, params: { note }, timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
  }

  async clearScreenAnnotation(screenId: string): Promise<void> {
    await this.client.delete(`/api/ai/screens/${screenId}/annotation`);
  }

  async deleteChatScreen(screenId: string): Promise<void> {
    await this.client.delete(`/api/ai/screens/${screenId}`);
  }

  // ─── Second opinions: "Ask another model" ──────────────────────────────────

  async listModelChoices(persona?: string): Promise<ApiResponse<ModelChoiceApi[]>> {
    const r = await this.client.get<ApiResponse<ModelChoiceApi[]>>('/api/ai/models', { params: persona !== undefined ? { persona } : undefined });
    return r.data;
  }

  /** Re-answers a reply with another model, in the background; follow it with followChatTurn. */
  async askAnotherModel(sessionId: string, messageId: string, model: string): Promise<ApiResponse<{ turnId: string }>> {
    const r = await this.client.post<ApiResponse<{ turnId: string }>>(`/api/ai/session/${sessionId}/messages/${messageId}/alternates`, { model });
    return r.data;
  }

  async listAlternates(sessionId: string): Promise<ApiResponse<ChatAlternate[]>> {
    const r = await this.client.get<ApiResponse<ChatAlternate[]>>(`/api/ai/session/${sessionId}/alternates`);
    return r.data;
  }

  /** Makes an alternative the answer the chat continues from. */
  async useAlternate(alternateId: string): Promise<ApiResponse<{ messageId: string; content: string }>> {
    const r = await this.client.post<ApiResponse<{ messageId: string; content: string }>>(`/api/ai/alternates/${alternateId}/use`);
    return r.data;
  }

  // ─── "Don't use this" (per chat) ────────────────────────────────────────────

  async listExclusions(sessionId: string): Promise<ApiResponse<UsedSourceApi[]>> {
    const r = await this.client.get<ApiResponse<UsedSourceApi[]>>(`/api/ai/session/${sessionId}/exclusions`);
    return r.data;
  }

  async excludeSource(sessionId: string, source: UsedSourceApi): Promise<ApiResponse<UsedSourceApi[]>> {
    const r = await this.client.post<ApiResponse<UsedSourceApi[]>>(`/api/ai/session/${sessionId}/exclusions`, source);
    return r.data;
  }

  async includeSource(sessionId: string, sourceId: string): Promise<ApiResponse<UsedSourceApi[]>> {
    const r = await this.client.delete<ApiResponse<UsedSourceApi[]>>(`/api/ai/session/${sessionId}/exclusions/${sourceId}`);
    return r.data;
  }

  /** A table (rows of text) as an .xlsx download. */
  async exportXlsx(filename: string, sheets: Array<{ name: string; rows: string[][] }>): Promise<Blob> {
    const r = await this.client.post<Blob>('/api/ai/export/xlsx', { filename, sheets }, { responseType: 'blob', timeout: IMAGE_UPLOAD_TIMEOUT_MS });
    return r.data;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ApiResponse<ChatResponse>> {
    const r = await this.client.post<ApiResponse<ChatResponse>>(
      '/api/ai/chat',
      request,
      { timeout: CHAT_TIMEOUT_MS, ...(signal && { signal }) },
    );
    return r.data;
  }

  // ─── Voice (Azure Speech, ported from client-demo's voiceRoutes.ts) ────────

  /** Transcribes base64-encoded audio (16kHz mono WAV) via /api/voice/transcribe. */
  async transcribeVoice(
    audioBase64: string,
    mimeType: string,
    language?: string,
  ): Promise<ApiResponse<{ text: string; provider: string }>> {
    const r = await this.client.post<ApiResponse<{ text: string; provider: string }>>(
      '/api/voice/transcribe',
      { audioBase64, mimeType, language },
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Synthesises speech for the given text via /api/voice/synthesize. Returns base64 audio. */
  async synthesizeVoice(
    text: string,
    voice?: string,
  ): Promise<ApiResponse<{ audioBase64: string; mimeType: string; provider: string }>> {
    const r = await this.client.post<ApiResponse<{ audioBase64: string; mimeType: string; provider: string }>>(
      '/api/voice/synthesize',
      { text, voice },
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Fetches (and lazily creates) a session's persisted message history, so a reload/reopen can restore it. */
  async getSessionHistory(
    sessionId: string,
  ): Promise<ApiResponse<{ sessionId: string; messages: ChatMessage[]; persona?: AthenaPersona; projectId: string | null }>> {
    const r = await this.client.get<ApiResponse<{ sessionId: string; messages: ChatMessage[]; persona?: AthenaPersona; projectId: string | null }>>(
      `/api/ai/session/${sessionId}/history`,
    );
    return r.data;
  }

  /** Lists past chat sessions for the sidebar, most recently active first. */
  /** The main chat list: chats started from a Think note stay with their note, not here. */
  async listChatSessions(): Promise<ApiResponse<{ sessions: ChatSessionSummary[] }>> {
    const r = await this.client.get<ApiResponse<{ sessions: ChatSessionSummary[] }>>('/api/ai/sessions', { params: { excludeThink: '1' } });
    return r.data;
  }

  /** Deletes a chat session and its messages. */
  async deleteChatSession(sessionId: string): Promise<ApiResponse<{ deleted: true }>> {
    const r = await this.client.delete<ApiResponse<{ deleted: true }>>(`/api/ai/session/${sessionId}`);
    return r.data;
  }

  /** All of Athena's memories (instructions, examples, profile, suggestions). */
  async listMemories(): Promise<ApiResponse<{ memories: AthenaMemory[] }>> {
    const r = await this.client.get<ApiResponse<{ memories: AthenaMemory[] }>>('/api/memories');
    return r.data;
  }

  async createMemory(input: { content: string; scopeType: MemoryScopeType; scopeValue?: string | null }): Promise<ApiResponse<AthenaMemory>> {
    const r = await this.client.post<ApiResponse<AthenaMemory>>('/api/memories', input);
    return r.data;
  }

  async updateMemory(id: string, patch: Partial<Pick<AthenaMemory, 'content' | 'scopeType' | 'scopeValue' | 'status'>>): Promise<ApiResponse<AthenaMemory>> {
    const r = await this.client.patch<ApiResponse<AthenaMemory>>(`/api/memories/${id}`, patch);
    return r.data;
  }

  async deleteMemory(id: string): Promise<ApiResponse<{ deleted: true }>> {
    const r = await this.client.delete<ApiResponse<{ deleted: true }>>(`/api/memories/${id}`);
    return r.data;
  }

  /** 👍 saves the reply as an example; 👎 + note returns a suggested instruction. */
  async sendReplyFeedback(input: { sessionId: string | null; rating: 'up' | 'down'; comment?: string; replyContent: string; persona?: string }): Promise<ApiResponse<{ memory: AthenaMemory | null }>> {
    const r = await this.client.post<ApiResponse<{ memory: AthenaMemory | null }>>('/api/memories/feedback', input);
    return r.data;
  }

  /** Renames a chat (locks the title against automatic re-titling). */
  async renameChatSession(sessionId: string, title: string): Promise<ApiResponse<{ sessionId: string; title: string }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; title: string }>>(
      `/api/ai/session/${sessionId}/title`, { title },
    );
    return r.data;
  }

  /** Pins or unpins a chat in the sidebar. */
  async setChatSessionPinned(sessionId: string, pinned: boolean): Promise<ApiResponse<{ sessionId: string; pinned: boolean }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; pinned: boolean }>>(
      `/api/ai/session/${sessionId}/pinned`, { pinned },
    );
    return r.data;
  }

  /** Full-text search across chat titles and message text; returns matching session ids. */
  async searchChatSessions(query: string): Promise<ApiResponse<{ ids: string[] }>> {
    const r = await this.client.get<ApiResponse<{ ids: string[] }>>('/api/ai/sessions/search', { params: { q: query } });
    return r.data;
  }

  /** Looks up the chat session already linked to a Think note, if any — used by the embedded Athena panel to restore the right conversation when the user switches notes. */
  async getSessionIdForNote(noteId: string): Promise<ApiResponse<{ sessionId: string | null }>> {
    const r = await this.client.get<ApiResponse<{ sessionId: string | null }>>(
      `/api/ai/sessions/note/${encodeURIComponent(noteId)}`,
    );
    return r.data;
  }

  /** Generates an on-demand summary of a note's content, shown when a note has no chat started yet. */
  async summarizeNote(title: string, content: string): Promise<ApiResponse<{ summary: string }>> {
    const r = await this.client.post<ApiResponse<{ summary: string }>>(
      '/api/ai/summarize-note',
      { title, content },
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Switches a session's persona (e.g. "general" <-> "brainstorming"). */
  async setSessionPersona(
    sessionId: string,
    persona: AthenaPersona,
  ): Promise<ApiResponse<{ sessionId: string; persona: AthenaPersona }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; persona: AthenaPersona }>>(
      `/api/ai/session/${sessionId}/persona`,
      { persona },
    );
    return r.data;
  }

  /** Assigns or clears the project associated with a chat session. */
  async setSessionProject(
    sessionId: string,
    projectId: string | null,
  ): Promise<ApiResponse<{ sessionId: string; projectId: string | null }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; projectId: string | null }>>(
      `/api/ai/session/${sessionId}/project`,
      { projectId },
    );
    return r.data;
  }

  /** Formats a session's conversation into a note and saves it to Think, returning a deep link. */
  /** A structured first draft of a spec note from the conversation (title + Markdown). */
  async draftSpecFromSession(sessionId: string): Promise<ApiResponse<{ title: string; markdown: string }>> {
    return (await this.client.post<ApiResponse<{ title: string; markdown: string }>>(`/api/ai/session/${sessionId}/spec-draft`, {}, { timeout: 2 * CHAT_TIMEOUT_MS })).data;
  }

  /** Moves the chat in alongside a note: Think shows this conversation for that note. */
  async linkSessionToNote(sessionId: string, noteId: string, title: string): Promise<ApiResponse<{ linkedTasks: number }>> {
    return (await this.client.post<ApiResponse<{ linkedTasks: number }>>(`/api/ai/session/${sessionId}/link-note`, { noteId, title })).data;
  }

  async exportSessionToThink(sessionId: string): Promise<ApiResponse<ExportToThinkResponse>> {
    const r = await this.client.post<ApiResponse<ExportToThinkResponse>>(
      `/api/ai/session/${sessionId}/export-to-think`,
      {},
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  async endSession(
    sessionId: string,
  ): Promise<ApiResponse<{ summary: string }>> {
    const r = await this.client.post<ApiResponse<{ summary: string }>>(
      `/api/ai/session/${sessionId}/end`,
    );
    return r.data;
  }

  async confirmAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const r = await this.client.post<ApiResponse<WriteActionProposal>>(
      `/api/ai/actions/${proposalId}/confirm`,
    );
    return r.data;
  }

  async cancelAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const r = await this.client.post<ApiResponse<WriteActionProposal>>(
      `/api/ai/actions/${proposalId}/cancel`,
    );
    return r.data;
  }

  // ─── Taxonomy ─────────────────────────────────────────────────────────────

  async getTaxonomy(): Promise<ApiResponse<TaxonomyTag[]>> {
    const r = await this.client.get<ApiResponse<TaxonomyTag[]>>('/api/taxonomy');
    return r.data;
  }

  async createTag(input: { name: string; parentId?: string | null; colour?: string | null }): Promise<ApiResponse<TaxonomyTag>> {
    const r = await this.client.post<ApiResponse<TaxonomyTag>>('/api/taxonomy', input);
    return r.data;
  }

  async updateTag(id: string, input: { name?: string; colour?: string | null }): Promise<ApiResponse<{ id: string }>> {
    const r = await this.client.patch<ApiResponse<{ id: string }>>(`/api/taxonomy/${id}`, input);
    return r.data;
  }

  async deleteTag(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/taxonomy/${id}`);
    return r.data;
  }

  async suggestTagSplit(id: string): Promise<ApiResponse<{ suggestions: string[] }>> {
    const r = await this.client.post<ApiResponse<{ suggestions: string[] }>>(`/api/tag-suggestions/${id}/split`, {});
    return r.data;
  }

  async getPendingTags(): Promise<ApiResponse<Array<{ suggestion: string; item_id: string; item_title: string }>>> {
    const r = await this.client.get<ApiResponse<Array<{ suggestion: string; item_id: string; item_title: string }>>>('/api/taxonomy/pending');
    return r.data;
  }

  async dismissPendingTag(suggestion: string): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>('/api/taxonomy/pending/dismiss', { suggestion });
    return r.data;
  }

  async getTagSuggestions(all = false): Promise<ApiResponse<PendingSuggestion[]>> {
    const r = await this.client.get<ApiResponse<PendingSuggestion[]>>('/api/tag-suggestions', { params: all ? { all: 1 } : {} });
    return r.data;
  }

  async getTagSuggestionCounts(): Promise<ApiResponse<{ strong: number; weak: number }>> {
    const r = await this.client.get<ApiResponse<{ strong: number; weak: number }>>('/api/tag-suggestions/counts');
    return r.data;
  }

  async acceptTagSuggestion(id: string, parentId: string | null): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>(`/api/tag-suggestions/${id}/accept`, { parentId });
    return r.data;
  }

  async rejectTagSuggestion(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>(`/api/tag-suggestions/${id}/reject`, {});
    return r.data;
  }

  async rejectAllTagSuggestions(): Promise<ApiResponse<{ rejected: number }>> {
    const r = await this.client.post<ApiResponse<{ rejected: number }>>('/api/tag-suggestions/reject-all', {});
    return r.data;
  }

  async mergeTagSuggestion(id: string, mergeToId: string): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>(`/api/tag-suggestions/${id}/merge`, { mergeToId });
    return r.data;
  }

  async getHealthReport(): Promise<ApiResponse<{ content: string; generatedAt: string | null }>> {
    const r = await this.client.get<ApiResponse<{ content: string; generatedAt: string | null }>>('/api/tag-suggestions/health');
    return r.data;
  }

  async triggerRetag(all = false): Promise<ApiResponse<{ queued: number; message: string }>> {
    const r = await this.client.post<ApiResponse<{ queued: number; message: string }>>(
      `/api/taxonomy/retag${all ? '?all=true' : ''}`,
      {},
    );
    return r.data;
  }

  async getRetagStatus(): Promise<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>> {
    const r = await this.client.get<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>>('/api/taxonomy/retag/status');
    return r.data;
  }

  async triggerDocRetag(extraRepos: string[] = []): Promise<ApiResponse<{ queued: number; message: string }>> {
    const r = await this.client.post<ApiResponse<{ queued: number; message: string }>>('/api/documents/retag', { repos: extraRepos });
    return r.data;
  }

  async getDocRetagStatus(): Promise<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>> {
    const r = await this.client.get<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>>('/api/documents/retag/status');
    return r.data;
  }

  async getNoteTags(noteId: string): Promise<ApiResponse<TaxonomyTag[]>> {
    const r = await this.client.get<ApiResponse<TaxonomyTag[]>>(`/api/notes/${noteId}/tags`);
    return r.data;
  }

  async retagNote(noteId: string): Promise<ApiResponse<{ applied: number; skipped?: string }>> {
    const r = await this.client.post<ApiResponse<{ applied: number; skipped?: string }>>(`/api/notes/${noteId}/tags/retag`, {});
    return r.data;
  }

  async setNoteTags(noteId: string, tagIds: string[]): Promise<ApiResponse<unknown>> {
    const r = await this.client.put<ApiResponse<unknown>>(`/api/notes/${noteId}/tags`, { tagIds });
    return r.data;
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  async getTasks(params?: { status?: string; projectId?: string }): Promise<ApiResponse<unknown>> {
    const r = await this.client.get<ApiResponse<unknown>>('/api/tasks', { params });
    return r.data;
  }

  async createTask(input: CreateTaskInput): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>('/api/tasks', input);
    return r.data;
  }

  async updateTask(id: string, input: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    const r = await this.client.patch<ApiResponse<unknown>>(`/api/tasks/${id}`, input);
    return r.data;
  }

  async deleteTask(id: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.delete<ApiResponse<unknown>>(`/api/tasks/${id}`);
    return r.data;
  }

  async getTaskNotes(taskId: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.get<ApiResponse<unknown>>(`/api/tasks/${taskId}/notes`);
    return r.data;
  }

  async addTaskNote(taskId: string, body: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>(`/api/tasks/${taskId}/notes`, { body });
    return r.data;
  }

  async getTaskLinks(taskId: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.get<ApiResponse<unknown>>(`/api/tasks/${taskId}/links`);
    return r.data;
  }

  async addTaskLink(taskId: string, link: { targetType: string; targetId: string; targetTitle: string }): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>(`/api/tasks/${taskId}/links`, link);
    return r.data;
  }

  async removeTaskLink(taskId: string, linkId: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.delete<ApiResponse<unknown>>(`/api/tasks/${taskId}/links/${linkId}`);
    return r.data;
  }

  async importTasks(content: string, type: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>('/api/tasks/import', { content, type });
    return r.data;
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  async getProjects(): Promise<ApiResponse<Project[]>> {
    const r = await this.client.get<ApiResponse<Project[]>>('/api/projects');
    return r.data;
  }

  async createProject(input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ApiResponse<Project>> {
    const r = await this.client.post<ApiResponse<Project>>('/api/projects', input);
    return r.data;
  }

  async updateProject(id: string, input: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ApiResponse<Project>> {
    const r = await this.client.patch<ApiResponse<Project>>(`/api/projects/${id}`, input);
    return r.data;
  }

  async deleteProject(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/projects/${id}`);
    return r.data;
  }

  // ─── Repo-Tag Mappings ────────────────────────────────────────────────────

  async getRepoMappings(): Promise<ApiResponse<RepoTagMapping[]>> {
    const r = await this.client.get<ApiResponse<RepoTagMapping[]>>('/api/repo-mappings');
    return r.data;
  }

  async createRepoMapping(input: { tagId: string; githubRepos: string[]; gitlabPaths: string[] }): Promise<ApiResponse<RepoTagMapping>> {
    const r = await this.client.post<ApiResponse<RepoTagMapping>>('/api/repo-mappings', input);
    return r.data;
  }

  async updateRepoMapping(id: string, input: { tagId?: string; githubRepos?: string[]; gitlabPaths?: string[] }): Promise<ApiResponse<RepoTagMapping>> {
    const r = await this.client.patch<ApiResponse<RepoTagMapping>>(`/api/repo-mappings/${id}`, input);
    return r.data;
  }

  async deleteRepoMapping(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/repo-mappings/${id}`);
    return r.data;
  }

  // ─── Tags (Change 007) ────────────────────────────────────────────────────

  async getTags(q?: string): Promise<ApiResponse<string[]>> {
    const r = await this.client.get<ApiResponse<string[]>>('/api/tags', { params: q ? { q } : {} });
    return r.data;
  }

  // ─── IBM Calendar manual import (Change 004) ──────────────────────────────

  async importIbmCalendar(events: unknown[]): Promise<ApiResponse<{ imported: number }>> {
    const r = await this.client.post<ApiResponse<{ imported: number }>>(
      '/api/capture/ibm-calendar',
      { events },
    );
    return r.data;
  }

  // ─── Documents library ───────────────────────────────────────────────────

  async getDocumentLibrary(
    extraRepos: string[] = [],
    repoLabels: Record<string, string> = {},
  ): Promise<ApiResponse<DocEntry[]>> {    const params: Record<string, unknown> = {};
    if (extraRepos.length > 0) params['repos'] = extraRepos;
    if (Object.keys(repoLabels).length > 0) params['repoLabels'] = JSON.stringify(repoLabels);
    const r = await this.client.get<ApiResponse<DocEntry[]>>('/api/documents/library', { params });
    return r.data;
  }

  /** OneDrive (IBM Alliance tenant) connection + sync status. */
  async getAllianceStatus(): Promise<ApiResponse<AllianceStatus>> {
    const r = await this.client.get<ApiResponse<AllianceStatus>>('/api/integrations/alliance/status');
    return r.data;
  }

  /** Starts a OneDrive sync in the background. */
  async syncOneDrive(): Promise<ApiResponse<{ started: boolean }>> {
    const r = await this.client.post<ApiResponse<{ started: boolean }>>('/api/integrations/alliance/sync');
    return r.data;
  }

  async getDocumentContent(repo: string, path: string): Promise<ApiResponse<DocumentContent>> {
    const r = await this.client.get<ApiResponse<DocumentContent>>('/api/documents/content', { params: { repo, path } });
    return r.data;
  }

  async setDocumentTags(docId: string, tagIds: string[]): Promise<ApiResponse<string[]>> {
    const r = await this.client.put<ApiResponse<string[]>>('/api/documents/tags', { docId, tagIds });
    return r.data;
  }

  /**
   * Uploads a Word/Excel/PowerPoint/PDF/Markdown/text file: extracts plain
   * text, stores the original file in Azure Blob Storage, and persists it as
   * a searchable `user-upload` content item (visible in the Documents
   * library). Returns the extracted text too, so the caller can inject it as
   * immediate chat context without a second round trip.
   */
  async uploadDocument(
    file: File,
    projectId = 'personal',
    title?: string,
    projectName?: string,
    onProgress?: (percent: number) => void,
    /** Chat to link a spreadsheet to (for the calculator). */
    chatSessionId?: string,
  ): Promise<ApiResponse<{ contentItemId: string; filename: string; text: string; truncated: boolean; blobUrl: string; projectId: string; projectName: string }>> {
    const formData = new FormData();
    formData.append('file', file);
    if (chatSessionId !== undefined) formData.append('sessionId', chatSessionId);
    formData.append('projectId', projectId);
    if (projectName !== undefined && projectName.trim() !== '') formData.append('projectName', projectName.trim());
    if (title !== undefined && title.trim() !== '') formData.append('title', title.trim());
    const r = await this.client.post<
      ApiResponse<{ contentItemId: string; filename: string; text: string; truncated: boolean; blobUrl: string; projectId: string; projectName: string }>
    >('/api/documents/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: IMAGE_UPLOAD_TIMEOUT_MS,
      onUploadProgress: (evt) => {
        if (!onProgress || !evt.total) return;
        onProgress(Math.round((evt.loaded / evt.total) * 100));
      },
    });
    return r.data;
  }

  // ─── Discover ─────────────────────────────────────────────────────────────

  async createLinkedInDraft(id: string): Promise<ApiResponse<{ post: string; sourceUrl: string | null; sourceKind: 'email' | 'discovered-article' }>> {
    return (await this.client.post<ApiResponse<{ post: string; sourceUrl: string | null; sourceKind: 'email' | 'discovered-article' }>>(
      `/api/discover/${id}/linkedin-draft`,
      {},
      { timeout: CHAT_TIMEOUT_MS },
    )).data;
  }

  async getDiscoverFeed(
    state: DiscoverWorkflowState = 'to-review',
    source?: string,
    page = 1,
    pageSize = 50,
    title?: string,
  ): Promise<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>> {
    const r = await this.client.get<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>>(
      '/api/discover',
      { params: { state, source, page, pageSize, title } },
    );
    return r.data;
  }

  async getDiscoverSources(state?: string): Promise<ApiResponse<Array<{ title: string; count: number }>>> {
    const r = await this.client.get<ApiResponse<Array<{ title: string; count: number }>>>('/api/discover/sources', {
      params: state ? { state } : undefined,
    });
    return r.data;
  }

  async listDiscoveryFeeds(): Promise<ApiResponse<DiscoveryFeed[]>> {
    return (await this.client.get<ApiResponse<DiscoveryFeed[]>>('/api/discover/feeds')).data;
  }

  /** Adds a feed; the server checks the address first and says if it isn't a working feed. */
  async addDiscoveryFeed(feed: { title: string; feedUrl: string; groupName: string }): Promise<ApiResponse<DiscoveryFeed & { itemsInFeed: number }>> {
    try {
      return (await this.client.post<ApiResponse<DiscoveryFeed & { itemsInFeed: number }>>('/api/discover/feeds', feed)).data;
    } catch (err) {
      const body = (err as { response?: { data?: ApiResponse<never> } }).response?.data;
      if (body !== undefined) return body;
      throw err;
    }
  }

  async updateDiscoveryFeed(id: string, patch: { isActive?: boolean; title?: string; groupName?: string }): Promise<ApiResponse<DiscoveryFeed>> {
    return (await this.client.patch<ApiResponse<DiscoveryFeed>>(`/api/discover/feeds/${id}`, patch)).data;
  }

  async deleteDiscoveryFeed(id: string): Promise<ApiResponse<unknown>> {
    return (await this.client.delete<ApiResponse<unknown>>(`/api/discover/feeds/${id}`)).data;
  }

  async checkDiscoveryFeeds(): Promise<ApiResponse<{ started: boolean }>> {
    return (await this.client.post<ApiResponse<{ started: boolean }>>('/api/discover/feeds/check')).data;
  }

  async updateDiscoverWorkflow(id: string, state: DiscoverWorkflowState): Promise<ApiResponse<unknown>> {
    const r = await this.client.patch<ApiResponse<unknown>>(`/api/discover/${id}/workflow`, { state });
    return r.data;
  }

  async updateDiscoverPublishedUrl(id: string, publishedUrl: string | null): Promise<ApiResponse<unknown>> {
    const r = await this.client.patch<ApiResponse<unknown>>(`/api/discover/${id}/published-url`, { publishedUrl });
    return r.data;
  }

  // ─── CFPs ─────────────────────────────────────────────────────────────────

  async getCfpItems(
    workflowState: CfpWorkflowState = 'to_review',
    limit = 50,
    offset = 0,
  ): Promise<ApiResponse<CfpItem[]>> {
    const r = await this.client.get<ApiResponse<CfpItem[]>>('/api/cfps', {
      params: { workflow_state: workflowState, limit, offset },
    });
    return r.data;
  }

  async updateCfpState(id: string, state: CfpWorkflowState): Promise<ApiResponse<unknown>> {
    const r = await this.client.put<ApiResponse<unknown>>(`/api/cfps/${id}/state`, { state });
    return r.data;
  }

  async triggerCfpSync(): Promise<ApiResponse<{ indexed: number; errors: number }>> {
    const r = await this.client.post<ApiResponse<{ indexed: number; errors: number }>>('/api/cfps/sync');
    return r.data;
  }

  // ─── Sparks ──────────────────────────────────────────────────────────────

  async createSpark(input: {
    body: string;
    tags?: string[];
    source_id?: string | null;
    source_type?: string | null;
  }): Promise<ApiResponse<Spark>> {
    const r = await this.client.post<ApiResponse<Spark>>('/api/sparks', input);
    return r.data;
  }

  async listSparks(params?: {
    source_id?: string;
    source_type?: string;
    cluster_id?: string;
    attached?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse<Spark[]>> {
    const r = await this.client.get<ApiResponse<Spark[]>>('/api/sparks', { params });
    return r.data;
  }

  async deleteSpark(id: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.delete<ApiResponse<unknown>>(`/api/sparks/${id}`);
    return r.data;
  }

  // ─── Spark clusters ───────────────────────────────────────────────────────

  async listSparkClusters(params?: {
    surfaced?: boolean;
    dismissed?: boolean;
  }): Promise<ApiResponse<SparkCluster[]>> {
    const r = await this.client.get<ApiResponse<SparkCluster[]>>('/api/spark-clusters', { params });
    return r.data;
  }

  async updateSparkCluster(id: string, patch: {
    dismissed?: boolean;
    surfaced?: boolean;
  }): Promise<ApiResponse<unknown>> {
    const r = await this.client.patch<ApiResponse<unknown>>(`/api/spark-clusters/${id}`, patch);
    return r.data;
  }

  /** Returns count of clusters with spark_count >= 4 that haven't been surfaced yet. */
  async getUnsurfacedClusterCount(): Promise<ApiResponse<{ count: number }>> {
    const r = await this.client.get<ApiResponse<{ count: number }>>('/api/spark-clusters/unsurfaced-count');
    return r.data;
  }

  // ─── Connections ──────────────────────────────────────────────────────────

  async getConnections(refId: string, refType: string): Promise<ApiResponse<ConnectionsResponse>> {
    const r = await this.client.get<ApiResponse<ConnectionsResponse>>('/api/connections', {
      params: { ref_id: refId, ref_type: refType },
    });
    return r.data;
  }

  // ─── Certification Scores ─────────────────────────────────────────────────

  async postCertScore(payload: { cert_code: string; score: number; task_id?: string; notes?: string }): Promise<ApiResponse<Record<string, unknown>>> {
    const r = await this.client.post<ApiResponse<Record<string, unknown>>>('/api/cert-scores', payload);
    return r.data;
  }

  async getCertScores(certCode: string): Promise<ApiResponse<Record<string, unknown>[]>> {
    const r = await this.client.get<ApiResponse<Record<string, unknown>[]>>('/api/cert-scores', { params: { cert_code: certCode } });
    return r.data;
  }

  // ─── Graph ────────────────────────────────────────────────────────────────

  /** Fetches graph nodes and edges for the visualisation page. */
  async getGraph(params: {
    days?: number;
    seed?: string;
    depth?: number;
    edgeTypes?: string[];
    nodeTypes?: string[];
  }): Promise<ApiResponse<GraphResponse>> {
    const p: Record<string, string> = {};
    if (params.days !== undefined) p['days'] = String(params.days);
    if (params.seed !== undefined) p['seed'] = params.seed;
    if (params.depth !== undefined) p['depth'] = String(params.depth);
    if (params.edgeTypes?.length) p['edge_types'] = params.edgeTypes.join(',');
    if (params.nodeTypes?.length) p['node_types'] = params.nodeTypes.join(',');
    const r = await this.client.get<ApiResponse<GraphResponse>>('/api/graph', { params: p });
    return r.data;
  }

  /** Resolve a graph node by ref_id + ref_type. */
  async getGraphNodeByRef(refId: string, refType: string): Promise<ApiResponse<{ id: string; refId: string; refType: string; title: string; tags: string[] }>> {
    const r = await this.client.get<ApiResponse<{ id: string; refId: string; refType: string; title: string; tags: string[] }>>(
      '/api/connections/node-by-ref',
      { params: { ref_id: refId, ref_type: refType } },
    );
    return r.data;
  }

  // ── Morning briefing ────────────────────────────────────────────────────────

  /** Today's morning briefing (null before 09:00 UK time, or if not made yet). */
  async getMorningBriefing(): Promise<ApiResponse<MorningBriefingApi | null>> {
    const r = await this.client.get<ApiResponse<MorningBriefingApi | null>>('/api/today/briefing');
    return r.data;
  }

  /** Makes (or remakes) today's briefing now. */
  async generateMorningBriefing(): Promise<ApiResponse<MorningBriefingApi>> {
    const r = await this.client.post<ApiResponse<MorningBriefingApi>>('/api/today/briefing', {}, { timeout: CHAT_TIMEOUT_MS });
    return r.data;
  }

  // ── Mind maps (Think → Canvas) ──────────────────────────────────────────────

  async listCanvases(noteId?: string): Promise<ApiResponse<CanvasSummaryApi[]>> {
    const r = await this.client.get<ApiResponse<CanvasSummaryApi[]>>('/api/canvases', { params: noteId !== undefined ? { noteId } : {} });
    return r.data;
  }

  async createCanvas(input: { title?: string; rootLabel?: string; noteId?: string; project?: string; canvasType?: 'brainstorm' | 'diagram' } = {}): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>('/api/canvases', input);
    return r.data;
  }

  async getCanvas(id: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.get<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}`);
    return r.data;
  }

  async getDiagram(id: string): Promise<ApiResponse<DiagramSnapshot>> {
    return (await this.client.get<ApiResponse<DiagramSnapshot>>(`/api/canvases/${id}/diagram`)).data;
  }

  async saveDiagram(id: string, revision: number, document: DiagramDocument): Promise<ApiResponse<DiagramSnapshot>> {
    return (await this.client.put<ApiResponse<DiagramSnapshot>>(`/api/canvases/${id}/diagram`, { revision, document })).data;
  }

  async uploadDiagramAsset(id: string, file: Blob, name: string): Promise<ApiResponse<DiagramAsset>> {
    return (await this.client.post<ApiResponse<DiagramAsset>>(`/api/canvases/${id}/assets`, file, {
      headers: { 'Content-Type': file.type }, params: { name }, timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    })).data;
  }

  async getDiagramAsset(id: string, assetId: string): Promise<Blob> {
    return (await this.client.get<Blob>(`/api/canvases/${id}/assets/${assetId}`, { responseType: 'blob' })).data;
  }

  async updateCanvas(id: string, patch: { title?: string; description?: string; project?: string | null; viewport?: object }): Promise<ApiResponse<CanvasSummaryApi>> {
    const r = await this.client.patch<ApiResponse<CanvasSummaryApi>>(`/api/canvases/${id}`, patch);
    return r.data;
  }

  async deleteCanvas(id: string): Promise<void> {
    await this.client.delete(`/api/canvases/${id}`);
  }

  /** Applies changes to a map (all-or-nothing); returns the updated map. */
  async applyCanvasOps(id: string, ops: MapOp[]): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/ops`, { ops });
    return r.data;
  }

  /** Adds an item to a canvas as a card ("Send to Canvas"); it's placed automatically when the canvas opens. */
  async addToCanvas(id: string, item: { label: string; body?: string; url?: string; refType?: string; refId?: string }): Promise<ApiResponse<CanvasFullApi>> {
    const refType = MAP_REF_TYPES.find((t) => t === item.refType);
    return this.applyCanvasOps(id, [{
      op: 'add', id: crypto.randomUUID(), label: item.label,
      ...(item.body !== undefined && { body: item.body }),
      ...(item.url !== undefined && { url: item.url }),
      ...(refType !== undefined && item.refId !== undefined && { refType, refId: item.refId }),
    }]);
  }

  /** The full content behind a card (Preview tab). */
  async getCanvasCardContent(id: string, nodeId: string): Promise<ApiResponse<CanvasCardContentApi>> {
    const r = await this.client.get<ApiResponse<CanvasCardContentApi>>(`/api/canvases/${id}/nodes/${nodeId}/content`, { timeout: CHAT_TIMEOUT_MS });
    return r.data;
  }

  async linkCanvasNote(id: string, noteId: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/notes`, { noteId });
    return r.data;
  }

  async unlinkCanvasNote(id: string, noteId: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.delete<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/notes/${noteId}`);
    return r.data;
  }

  /** Related content for an idea; its current text is sent so unsaved edits count. */
  async getCanvasSuggestions(id: string, idea: { nodeId?: string; label?: string; body?: string; contextLabels?: string } = {}): Promise<ApiResponse<MapSuggestionApi[]>> {
    const r = await this.client.get<ApiResponse<MapSuggestionApi[]>>(`/api/canvases/${id}/suggestions`, {
      params: idea, timeout: CHAT_TIMEOUT_MS,
    });
    return r.data;
  }

  /** A card and its connections as a new note (pinned to the canvas), or added to `noteId`. */
  async canvasBranchToNote(id: string, nodeId: string, noteId?: string): Promise<ApiResponse<{ noteId: string; created: boolean }>> {
    const r = await this.client.post<ApiResponse<{ noteId: string; created: boolean }>>(
      `/api/canvases/${id}/nodes/${nodeId}/to-note`, noteId !== undefined ? { noteId } : {});
    return r.data;
  }

  async getCanvasMarkdown(id: string): Promise<ApiResponse<{ markdown: string }>> {
    const r = await this.client.get<ApiResponse<{ markdown: string }>>(`/api/canvases/${id}/markdown`);
    return r.data;
  }

  // ─── Today dashboard ───────────────────────────────────────────────────────

  /** Fetches mapped GitHub commits/PRs for the Today card. */
  async getTodayGitHubActivity(): Promise<ApiResponse<TodayGitHubActivityResponse>> {
    const r = await this.client.get<ApiResponse<TodayGitHubActivityResponse>>('/api/today/github-activity');
    return r.data;
  }

  /** Fetches repo mapping config (connected repos + filing tags + current mappings). */
  async getRepoProjectMappingConfig(): Promise<ApiResponse<RepoProjectMappingConfig>> {
    const r = await this.client.get<ApiResponse<RepoProjectMappingConfig>>('/api/repo-project-mappings/config');
    return r.data;
  }

  /** Upserts one repo->project tag mapping row. Null projectTagId removes mapping. */
  async saveRepoProjectMapping(
    repoFullName: string,
    projectTagId: string | null,
  ): Promise<ApiResponse<{ repoFullName: string; projectTagId: string | null }>> {
    const r = await this.client.put<ApiResponse<{ repoFullName: string; projectTagId: string | null }>>(
      '/api/repo-project-mappings',
      { repoFullName, projectTagId },
    );
    return r.data;
  }

  // ─── Build pipeline (spec → tasks → cloud coding agents) ─────────────────

  async listBuildSpecs(): Promise<ApiResponse<BuildSpecSummary[]>> {
    const r = await this.client.get<ApiResponse<BuildSpecSummary[]>>('/api/build/specs');
    return r.data;
  }

  async getBuildSpec(id: string): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.get<ApiResponse<BuildSpecWithTasks>>(`/api/build/specs/${id}`);
    return r.data;
  }

  async createBuildSpec(input: { title: string; repo: string; specMarkdown?: string; baseBranch?: string; maxParallel?: number; autoMerge?: boolean; useWorkBranch?: boolean }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>('/api/build/specs', input);
    return r.data;
  }

  async createBuildSpecFromNote(input: { noteId: string; repo: string; baseBranch?: string }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>('/api/build/specs/from-note', input);
    return r.data;
  }

  async createBuildSpecFromOutput(input: { outputId: string; repo: string; baseBranch?: string }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>('/api/build/specs/from-output', input);
    return r.data;
  }

  async updateBuildSpec(id: string, patch: Partial<Pick<BuildSpec, 'title' | 'specMarkdown' | 'repo' | 'baseBranch' | 'maxParallel' | 'autoMerge' | 'useWorkBranch'>>): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.patch<ApiResponse<BuildSpecWithTasks>>(`/api/build/specs/${id}`, patch);
    return r.data;
  }

  async deleteBuildSpec(id: string): Promise<ApiResponse<{ id: string }>> {
    const r = await this.client.delete<ApiResponse<{ id: string }>>(`/api/build/specs/${id}`);
    return r.data;
  }

  /** start | pause | sync | decompose | merge-final (merge the integration branch into the target) */
  async buildSpecAction(id: string, action: 'decompose' | 'start' | 'pause' | 'sync' | 'merge-final'): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>(`/api/build/specs/${id}/${action}`, {});
    return r.data;
  }

  async listBuildEvents(id: string): Promise<ApiResponse<BuildEvent[]>> {
    const r = await this.client.get<ApiResponse<BuildEvent[]>>(`/api/build/specs/${id}/events`);
    return r.data;
  }

  async updateBuildTask(id: string, patch: Partial<Pick<BuildTask, 'title' | 'bodyMarkdown' | 'agent' | 'dependsOn'>>): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.patch<ApiResponse<BuildSpecWithTasks>>(`/api/build/tasks/${id}`, patch);
    return r.data;
  }

  async buildTaskAction(id: string, action: 'retry' | 'cancel' | 'merge'): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>(`/api/build/tasks/${id}/${action}`, {});
    return r.data;
  }

  async listBuildAgents(repo: string): Promise<ApiResponse<BuildAgent[]>> {
    const r = await this.client.get<ApiResponse<BuildAgent[]>>('/api/build/agents', { params: { repo } });
    return r.data;
  }

  async listBuildBranches(repo: string): Promise<ApiResponse<{ defaultBranch: string; branches: string[] }>> {
    const r = await this.client.get<ApiResponse<{ defaultBranch: string; branches: string[] }>>('/api/build/branches', { params: { repo } });
    return r.data;
  }
}

export type BuildAgent = 'copilot' | 'claude';
export type BuildSpecStatus = 'draft' | 'decomposing' | 'decomposed' | 'running' | 'paused' | 'done' | 'failed';
export type BuildTaskStatus = 'pending' | 'dispatched' | 'pr_open' | 'awaiting_approval' | 'merged' | 'blocked' | 'failed' | 'cancelled';

export interface BuildSpec {
  id: string;
  projectId: string | null;
  noteId: string | null;
  chatOutputId: string | null;
  title: string;
  specMarkdown: string;
  repo: string;
  /** Target branch: the integration branch is cut from it and merged back into it. */
  baseBranch: string;
  useWorkBranch: boolean;
  /** build/<slug> integration branch the agents work on (set when the build starts). */
  workBranch: string | null;
  finalPrNumber: number | null;
  finalPrUrl: string | null;
  finalPrMergedAt: string | null;
  status: BuildSpecStatus;
  maxParallel: number;
  autoMerge: boolean;
  planNotes: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildTask {
  id: string;
  specId: string;
  seq: number;
  title: string;
  bodyMarkdown: string;
  agent: BuildAgent;
  agentReason: string;
  size: 'S' | 'M' | 'L';
  dependsOn: string[];
  status: BuildTaskStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  fixAttempts: number;
  lastError: string | null;
  dispatchedAt: string | null;
  mergedAt: string | null;
  updatedAt: string;
}

export interface BuildEvent {
  id: string;
  taskId: string | null;
  kind: string;
  message: string;
  createdAt: string;
}

export interface BuildSpecWithTasks extends BuildSpec { tasks: BuildTask[] }
export interface BuildSpecSummary extends BuildSpec { taskCounts: Partial<Record<BuildTaskStatus, number>>; taskTotal: number }

/** Singleton instance — used by all React Query hooks. */
export const api = new KnowledgeHubApi();

/** Athena's morning briefing (also saved as a pinned Athena chat). */
export interface MorningBriefingApi {
  date: string;
  sessionId: string;
  markdown: string;
  generatedAt: string;
}

// ── Mind map API types ────────────────────────────────────────────────────────

export const MAP_REF_TYPES = ['discover_item', 'spark', 'note', 'content_item', 'ai_session'] as const;
export type MapRefType = typeof MAP_REF_TYPES[number];

export interface CanvasSummaryApi {
  id: string; title: string; description: string | null;
  canvasType: 'brainstorm' | 'diagram';
  project: string | null; createdAt: string; updatedAt: string;
  linkedNotes: Array<{ id: string; title: string }>;
  nodeCount: number;
}

/** A card on a canvas: content (refType/refId) or your own idea. `body` is your annotation. */
export interface CanvasNodeApi {
  id: string; canvasId: string; nodeType: string;
  refType: MapRefType | null; refId: string | null;
  label: string | null; body: string | null;
  url: string | null; tags: string[] | null;
  x: number; y: number; placed: boolean;
  createdAt: string;
}

/** A typed connection between two cards. */
export interface CanvasEdgeApi {
  id: string; canvasId: string; sourceId: string; targetId: string;
  type: string; label: string | null; createdAt: string;
}

export interface CanvasCardContentApi {
  kind: string; title: string; text: string; url: string | null; date: string | null;
}

export interface CanvasFullApi extends CanvasSummaryApi {
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNodeApi[];
  edges: CanvasEdgeApi[];
}

/** One change to a canvas (ids are client-generated UUIDs). */
export type MapOp =
  | { op: 'add'; id: string; label?: string; body?: string; nodeType?: string; refType?: MapRefType; refId?: string; url?: string;
      tags?: string[]; x?: number; y?: number; connectTo?: { nodeId: string; edgeId: string; type?: string } }
  | { op: 'update'; id: string; label?: string; body?: string }
  | { op: 'position'; id: string; x: number; y: number }
  | { op: 'delete'; id: string }
  | { op: 'link'; id: string; sourceId: string; targetId: string; type?: string; label?: string }
  | { op: 'update_link'; id: string; type?: string; label?: string }
  | { op: 'unlink'; id: string };

export interface MapSuggestionApi {
  kind: 'note' | 'document' | 'meeting' | 'post' | 'article' | 'chat';
  refType: MapRefType;
  refId: string;
  title: string;
  excerpt: string;
  date: string | null;
  url: string | null;
  via: 'search' | 'graph';
}

// ── Today dashboard API types ─────────────────────────────────────────────────

/** A single mapped GitHub activity item returned by GET /api/today/github-activity. */
export interface GitHubActivityItem {
  id: string;
  source: string;
  title: string;
  summary: string | null;
  published_at: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  repo_full_name: string;
  project_tag_id: string;
  project_tag_name: string;
}

/** Today GitHub activity API envelope payload. */
export interface TodayGitHubActivityResponse {
  hasMappings: boolean;
  items: GitHubActivityItem[];
}

/** Connected repository source row for repo mapping settings. */
export interface ConnectedRepo {
  repoFullName: string;
  provider: 'github' | 'gitlab';
}

/** Existing repo->project mapping row from settings config endpoint. */
export interface RepoProjectMapping {
  repoFullName: string;
  projectTagId: string;
  projectTagName: string;
  updatedAt: string;
}

/** Repo mapping settings bootstrap payload. */
export interface RepoProjectMappingConfig {
  repos: ConnectedRepo[];
  filingTags: Array<{ id: string; name: string; parentName: string | null }>;
  mappings: RepoProjectMapping[];
}
