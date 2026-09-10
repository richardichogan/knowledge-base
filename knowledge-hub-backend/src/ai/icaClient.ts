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
