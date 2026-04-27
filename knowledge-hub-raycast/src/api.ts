/**
 * Shared API client for Raycast extension commands.
 * Calls the Knowledge Hub backend capture endpoints.
 */

import axios, { type AxiosInstance } from 'axios';

const BASE_URL = process.env['KNOWLEDGE_HUB_API_URL'] ?? 'http://localhost:3000';
const TOKEN = process.env['KNOWLEDGE_HUB_API_TOKEN'] ?? '';

const TIMEOUT_MS = 10_000;

/** Singleton Axios instance used by both commands. */
const client: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  },
});

export interface CaptureTaskInput {
  title: string;
  body?: string;
  destination: 'todo' | 'github-issue';
  projectContext?: string;
}

export interface CaptureSessionInput {
  /** Filename slug: must match YYYY-MM-DD-topic-slug.md */
  filename: string;
  /** Full markdown content of the session summary. */
  content: string;
}

export interface CaptureResult {
  success: boolean;
  message: string;
}

/**
 * POST /api/capture/task — creates a task via the backend.
 */
export async function captureTask(input: CaptureTaskInput): Promise<CaptureResult> {
  try {
    const response = await client.post<{ success: boolean; data: unknown }>(
      '/api/capture/task',
      input,
    );
    if (response.data.success) {
      return { success: true, message: 'Task created successfully.' };
    }
    return { success: false, message: 'Backend returned failure.' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, message: msg };
  }
}

/**
 * POST /api/capture/session — pushes a Claude session markdown to blob storage.
 */
export async function captureSession(input: CaptureSessionInput): Promise<CaptureResult> {
  try {
    const response = await client.post<{ success: boolean; data: unknown }>(
      '/api/capture/session',
      input,
    );
    if (response.data.success) {
      return { success: true, message: 'Session exported to blob storage.' };
    }
    return { success: false, message: 'Backend returned failure.' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, message: msg };
  }
}
