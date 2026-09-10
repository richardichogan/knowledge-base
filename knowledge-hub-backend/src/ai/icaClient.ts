/**
 * ICA client — IBM's internal Gen AI gateway (watsonx/Claude/GPT models over
 * an OpenAI-compatible REST API). Used by the search_ica tool to reach
 * ibm.com-domain work context that the Alliance-tenant M365 integration
 * cannot see (IBM does not permit that data to flow through Alliance-tenant
 * services), so the two sources are queried separately and combined by the
 * model rather than merged at the data layer.
 *
 * Auth is a single static bearer key per call (`ICA_API_KEY`) — no IAM/OAuth
 * token exchange, unlike the Graph/GitHub integrations.
 */

import { env } from '../config/env.js';

const ICA_TIMEOUT_MS = 120_000; // ICA responses can be slow on large prompts — longer than our default external timeout

export interface IcaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface IcaChatCompletionResponse {
  choices?: { message?: { role?: string; content?: string } }[];
  model?: string;
}

/** True when ICA is configured for this environment. */
export function isIcaEnabled(): boolean {
  return Boolean(env.ICA_API_KEY);
}

/**
 * True when the ICA "consulting"/developer key is configured — this is a
 * separate key from ICA_API_KEY, scoped to the OpenWebUI-native surface
 * (/assistants, /document-collections, /files) rather than the LiteLLM-proxy
 * /chat/completions route the coding-agent key uses. Required for
 * syncCollectionFiles().
 */
export function isIcaConsultingEnabled(): boolean {
  return Boolean(env.ICA_CONSULTING_KEY);
}

async function fetchWithRetry(url: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  const doFetch = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ICA_TIMEOUT_MS),
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch {
    // One retry on a network-level failure (timeout, DNS, connection reset).
    try {
      res = await doFetch();
    } catch (err2) {
      throw new Error(`ICA network error: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }

  if (!res.ok && res.status >= 500) {
    res = await doFetch(); // one retry on a transient 5xx
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ICA API error ${res.status}: ${text.slice(0, 500)}`);
  }

  return res;
}

/**
 * Sends a chat completion request to ICA and returns the assistant's reply
 * text. Throws on any HTTP/network failure — callers should catch and
 * surface a plain error result rather than let it bubble up as a hard tool
 * failure.
 */
export async function icaChat(
  messages: IcaChatMessage[],
  modelId: string = env.ICA_MODEL_ID,
): Promise<{ content: string; modelUsed: string }> {
  if (!isIcaEnabled()) throw new Error('ICA is not configured');

  const url = `${env.ICA_ENDPOINT}/chat/completions`;
  const body = {
    model: modelId,
    messages,
    max_tokens: 2048,
    // ICA's Claude models via LiteLLM only accept temperature=1 (they reject any override),
    // so we don't send a custom value — grounding is enforced via the system prompt instead.
    temperature: 1,
    stream: false,
  };

  const res = await fetchWithRetry(url, env.ICA_API_KEY!, body);
  const data = (await res.json()) as IcaChatCompletionResponse;
  return { content: data.choices?.[0]?.message?.content ?? '', modelUsed: data.model ?? modelId };
}

// ── Document collections ─────────────────────────────────────────────────────
// These use the separate "consulting"/developer key against the
// OpenWebUI-native surface (not the LiteLLM /chat/completions proxy the
// coding-agent key talks to) — confirmed working against the live gateway:
// GET /document-collections/{id} lists a collection's files, and
// GET /files/{id} returns each file's already-extracted plain-text content
// (OCR'd/parsed server-side by ICA), so no separate parsing step is needed.

export interface IcaCollectionFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: number; // unix seconds
  updatedAt: number; // unix seconds
}

export interface IcaFileContent {
  id: string;
  name: string;
  content: string;
  status: string;
}

async function icaConsultingGet(path: string): Promise<unknown> {
  if (!isIcaConsultingEnabled()) throw new Error('ICA consulting key is not configured');

  const doFetch = () =>
    fetch(`${env.ICA_ENDPOINT}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.ICA_CONSULTING_KEY!}` },
      signal: AbortSignal.timeout(ICA_TIMEOUT_MS),
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    throw new Error(`ICA network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok && res.status >= 500) res = await doFetch(); // one retry on transient 5xx

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ICA API error ${res.status}: ${text.slice(0, 500)}`);
  }

  return res.json();
}

/** Lists the files in an ICA document collection (by its collection/knowledge ID). */
export async function listCollectionFiles(collectionId: string): Promise<IcaCollectionFile[]> {
  const data = (await icaConsultingGet(`/document-collections/${collectionId}`)) as {
    files?: { id: string; meta?: { name?: string; content_type?: string; size?: number }; created_at?: number; updated_at?: number }[];
  };
  return (data.files ?? []).map(f => ({
    id: f.id,
    name: f.meta?.name ?? f.id,
    contentType: f.meta?.content_type ?? 'application/octet-stream',
    size: f.meta?.size ?? 0,
    createdAt: f.created_at ?? 0,
    updatedAt: f.updated_at ?? 0,
  }));
}

/** Fetches a single file's already-extracted text content from ICA. */
export async function getFileContent(fileId: string): Promise<IcaFileContent> {
  const data = (await icaConsultingGet(`/files/${fileId}`)) as {
    id: string;
    meta?: { name?: string };
    data?: { status?: string; content?: string };
  };
  return {
    id: data.id,
    name: data.meta?.name ?? data.id,
    content: data.data?.content ?? '',
    status: data.data?.status ?? 'unknown',
  };
}

