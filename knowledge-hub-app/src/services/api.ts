/**
 * Typed API client for the Knowledge Hub backend.
 * All requests include the JWT Bearer token.
 */

import axios, { type AxiosInstance } from 'axios';
import type {
  ApiResponse,
  PaginatedList,
  ContentItemSummary,
  ChatRequest,
  ChatResponse,
  CreateTaskInput,
  Task,
  WriteActionProposal,
} from '../types';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface TimelineQuery {
  page?: number;
  pageSize?: number;
  source?: string;
  projectContext?: string;
}

export interface SearchQuery {
  q: string;
  page?: number;
  pageSize?: number;
}

/**
 * Creates an Axios instance pre-configured for the Knowledge Hub backend.
 */
export function createApiClient(baseURL: string, token: string): AxiosInstance {
  const client = axios.create({
    baseURL,
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  return client;
}

/**
 * Knowledge Hub API wrapper — typed methods over the Axios instance.
 */
export class KnowledgeHubApi {
  private readonly client: AxiosInstance;

  constructor(baseURL: string, token: string) {
    this.client = createApiClient(baseURL, token);
  }

  // ─── Timeline ────────────────────────────────────────────────────────────

  async getTimeline(
    query: TimelineQuery = {},
  ): Promise<ApiResponse<PaginatedList<ContentItemSummary>>> {
    const response = await this.client.get<
      ApiResponse<PaginatedList<ContentItemSummary>>
    >('/api/timeline', { params: query });
    return response.data;
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async search(
    query: SearchQuery,
  ): Promise<ApiResponse<PaginatedList<ContentItemSummary>>> {
    const response = await this.client.get<
      ApiResponse<PaginatedList<ContentItemSummary>>
    >('/api/search', { params: query });
    return response.data;
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  async getSources(): Promise<ApiResponse<unknown>> {
    const response = await this.client.get<ApiResponse<unknown>>('/api/sources');
    return response.data;
  }

  async triggerSync(): Promise<ApiResponse<unknown>> {
    const response = await this.client.post<ApiResponse<unknown>>(
      '/api/sources/sync',
    );
    return response.data;
  }

  // ─── AI Chat ──────────────────────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ApiResponse<ChatResponse>> {
    const response = await this.client.post<ApiResponse<ChatResponse>>(
      '/api/ai/chat',
      request,
    );
    return response.data;
  }

  async endSession(sessionId: string): Promise<ApiResponse<{ summary: string }>> {
    const response = await this.client.post<ApiResponse<{ summary: string }>>(
      `/api/ai/session/${sessionId}/end`,
    );
    return response.data;
  }

  async confirmAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const response = await this.client.post<ApiResponse<WriteActionProposal>>(
      '/api/ai/actions/confirm',
      { proposalId },
    );
    return response.data;
  }

  async cancelAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const response = await this.client.post<ApiResponse<WriteActionProposal>>(
      '/api/ai/actions/cancel',
      { proposalId },
    );
    return response.data;
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<ApiResponse<Task>> {
    const response = await this.client.post<ApiResponse<Task>>(
      '/api/tasks',
      input,
    );
    return response.data;
  }
}
