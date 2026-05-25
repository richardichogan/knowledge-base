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
  CreateTaskInput,
  CreateNoteInput,
  Note,
  WriteActionProposal,
} from '../types';

// Use relative base URL so all requests go through the Vite dev proxy.
const BASE_URL = import.meta.env['VITE_API_URL'] as string | undefined ?? '';
const TOKEN = import.meta.env['VITE_API_TOKEN'] as string | undefined ?? '';

const TIMEOUT_MS = 8_000;

function makeClient(baseURL: string, token: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== '' && { Authorization: `Bearer ${token}` }),
    },
  });
}

export interface TimelineQuery {
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
  title: string;
  type: DocType;
  repo: string;
  path: string;
  sourceLabel: string;
  htmlUrl: string;
  size: number;
  tags: string[];
  taxonomyTagIds?: string[];
}

export interface DocumentContent {
  path: string;
  content: string;
  sha: string;
}

export type DiscoverWorkflowState = 'to-review' | 'saved' | 'blog' | 'archived' | 'published';

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

export interface ProjectLink { label: string; url: string; }

export interface Project {
  id: string;
  name: string;
  colour: ProjectColour;
  category: ProjectCategory;
  priority: ProjectPriority;
  description: string;
  gitlabPaths: string[];
  githubRepos: string[];
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
  connectedNode: { id: string; refId: string; refType: string; title: string };
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

  async createNote(input: CreateNoteInput): Promise<ApiResponse<Note>> {
    const r = await this.client.post<ApiResponse<Note>>('/api/notes', input);
    return r.data;
  }

  async deleteNote(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/notes/${id}`);
    return r.data;
  }

  async patchNote(id: string, content: string, tags: string[], projectId?: string): Promise<ApiResponse<Note>> {
    const body: Record<string, unknown> = { content, tags };
    if (projectId !== undefined) body['projectId'] = projectId;
    const r = await this.client.patch<ApiResponse<Note>>(`/api/notes/${id}`, body);
    return r.data;
  }

  // ─── Images (Change 003) ──────────────────────────────────────────────────

  async uploadImage(
    file: File,
    caption?: string,
  ): Promise<ApiResponse<{ id: string; blobUrl: string; ocrText?: string }>> {
    const form = new FormData();
    form.append('image', file);
    if (caption !== undefined) form.append('caption', caption);
    const r = await this.client.post<
      ApiResponse<{ id: string; blobUrl: string; ocrText?: string }>
    >('/api/images', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return r.data;
  }

  // ─── AI Chat ──────────────────────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ApiResponse<ChatResponse>> {
    const r = await this.client.post<ApiResponse<ChatResponse>>(
      '/api/ai/chat',
      request,
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
      '/api/ai/actions/confirm',
      { proposalId },
    );
    return r.data;
  }

  async cancelAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const r = await this.client.post<ApiResponse<WriteActionProposal>>(
      '/api/ai/actions/cancel',
      { proposalId },
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

  async getTagSuggestions(): Promise<ApiResponse<PendingSuggestion[]>> {
    const r = await this.client.get<ApiResponse<PendingSuggestion[]>>('/api/tag-suggestions');
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

  async getDocumentContent(repo: string, path: string): Promise<ApiResponse<DocumentContent>> {
    const r = await this.client.get<ApiResponse<DocumentContent>>('/api/documents/content', { params: { repo, path } });
    return r.data;
  }

  async setDocumentTags(docId: string, tagIds: string[]): Promise<ApiResponse<string[]>> {
    const r = await this.client.put<ApiResponse<string[]>>('/api/documents/tags', { docId, tagIds });
    return r.data;
  }

  // ─── Discover ─────────────────────────────────────────────────────────────

  async getDiscoverFeed(
    state: DiscoverWorkflowState = 'to-review',
    source?: string,
    page = 1,
    pageSize = 50,
  ): Promise<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>> {
    const r = await this.client.get<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>>(
      '/api/discover',
      { params: { state, source, page, pageSize } },
    );
    return r.data;
  }

  async getDiscoverSources(): Promise<ApiResponse<Array<{ title: string; count: number }>>> {
    const r = await this.client.get<ApiResponse<Array<{ title: string; count: number }>>>('/api/discover/sources');
    return r.data;
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
}

/** Singleton instance — used by all React Query hooks. */
export const api = new KnowledgeHubApi();
