import { env } from '../config/env.js';
import { AiError, AiOutputLimitError } from '../types/errors.js';
import {
  AI_DEFAULT_MAX_TOKENS,
  AI_REQUEST_TIMEOUT_MS,
  AI_REASONING_MODEL_REQUEST_TIMEOUT_MS,
} from '../config/constants.js';
import type { ConversationMessage, AiModel } from '../types/aiContext.js';
import type { ModelRoute } from './modelChoices.js';
import { recordAiUsage, tokenUsageFrom } from './aiUsage.js';
import type { TokenUsage } from './aiUsage.js';
import { request as requestHttp } from 'undici';
import { STATUS_CODES } from 'node:http';
import { reviewContextTokens } from './knowledge/reviewContext.js';

const DEFAULT_CHAT_TEMPERATURE = 0.7;
const AI_RESPONSE_HEADERS_TIMEOUT_MS = 30_000;
const NATIVE_FETCH_HEADERS_TIMEOUT_MS = 300_000;
const MAX_ERROR_DETAILS_CHARS = 300;

function transportCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return error.cause !== error ? transportCode(error.cause) : undefined;
}

/** Retry only before headers: no tool execution or partial answer is replayed. */
async function fetchModelStream(
  url: string, init: RequestInit, signal: AbortSignal,
  onActivity?: (line: string) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const headersTimeout = setTimeout(() => {
      controller.abort(new Error('The model endpoint did not send response headers within 30 seconds'));
    }, AI_RESPONSE_HEADERS_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, controller.signal]) });
      clearTimeout(headersTimeout);
      return response;
    } catch (error) {
      clearTimeout(headersTimeout);
      if (signal.aborted) throw error;
      const code = transportCode(error);
      const stalled = controller.signal.aborted;
      const retryable = stalled || code !== undefined && [
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
        'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
      ].includes(code);
      console.warn('[ai] Model connection failed before response headers', {
        attempt: attempt + 1, code: stalled ? 'AI_HEADERS_TIMEOUT' : code ?? 'UNKNOWN_TRANSPORT_ERROR',
        retrying: retryable && attempt === 0,
      });
      if (!retryable || attempt > 0) {
        const failure = new Error(stalled
          ? 'The model endpoint did not respond within 30 seconds'
          : `Model connection failed${code !== undefined ? ` (${code})` : ''}`, { cause: error });
        throw failure;
      }
      onActivity?.('Reconnecting to the model after a connection problem');
    }
  }
}

/** A single tool call the model wants the caller to execute. */
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI/Azure AI Foundry function-calling tool definition. */
export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

/** Tool-selection mode accepted by Azure OpenAI chat completions. */
export type LlmToolChoice =
  | 'auto'
  | 'none'
  | { type: 'function'; function: { name: string } };

/**
 * Message shape used internally for tool-calling turns — a superset of
 * ConversationMessage that also allows assistant tool_calls and tool results.
 */
/** A user message can carry pictures (e.g. a screenshot being reviewed) alongside its text. */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LlmContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: LlmToolCall[] };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number; completion_tokens: number; total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | undefined;
}

/**
 * Azure AI Foundry client for GPT-4o, GPT-4o mini, and GPT-5.5.
 * All AI usage billed against MSDN credits via Azure AI Foundry endpoint(s).
 * GPT-5.5 is served from a separate Foundry resource (see env.ts) — it needs
 * its own endpoint/key, not just a different deployment name on the main one.
 * No Anthropic API — Azure AI Foundry only.
 */
export class FoundryClient {
  private context: { persona?: string | undefined; sessionId?: string | undefined } = {};

  /** `feature` names what the calls are for ('decisions', 'article-scoring', …) in the usage log. */
  constructor(private readonly feature = 'unlabelled') {}

  /** A copy of this client whose calls are logged against a persona and chat. */
  public scoped(context: { persona?: string | undefined; sessionId?: string | undefined }): FoundryClient {
    return Object.assign(Object.create(this) as FoundryClient, { context });
  }

  private logCall(
    model: AiModel | 'bulk', deployment: string, api: 'chat' | 'responses', startedAt: number,
    usage: TokenUsage | undefined, error?: unknown,
  ): void {
    recordAiUsage({
      feature: this.feature, persona: this.context.persona, sessionId: this.context.sessionId,
      slot: model, deployment, api, durationMs: Date.now() - startedAt, ok: error === undefined,
      error: error === undefined ? undefined : error instanceof AiStoppedError ? 'Cancelled: Stopped'
        : error instanceof Error ? error.message : String(error),
      ...usage,
    });
  }

  public reviewContextTokens(model: AiModel, route?: ModelRoute): number {
    return reviewContextTokens(route?.deployment ?? this.getDeployment(model));
  }

  /** Context window of the deployment chatBulk actually calls, including its gpt-4o mini fallback. */
  public bulkContextTokens(): number {
    const configured = (env.AZURE_OPENAI_ENDPOINT_GPT54 ?? '') !== '' && (env.AZURE_OPENAI_API_KEY_GPT54 ?? '') !== '';
    return reviewContextTokens(configured ? env.AZURE_OPENAI_DEPLOYMENT_SCREEN_READ ?? 'gpt-5.4' : this.getDeployment('light'));
  }

  private getDeployment(model: AiModel): string {
    if (model === 'standard') return env.AZURE_OPENAI_DEPLOYMENT_GPT4O;
    if (model === 'reasoning') return env.AZURE_OPENAI_DEPLOYMENT_GPT54;
    return env.AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI;
  }

  /** Resolves the endpoint + api key to use for a given model — gpt-5.4 can live on a separate resource. */
  private getConnection(model: AiModel): { endpoint: string | undefined; apiKey: string | undefined } {
    if (model === 'standard' && env.AZURE_OPENAI_ENDPOINT_STANDARD) {
      return { endpoint: env.AZURE_OPENAI_ENDPOINT_STANDARD, apiKey: env.AZURE_OPENAI_API_KEY_STANDARD };
    }
    if (model === 'reasoning' && env.AZURE_OPENAI_ENDPOINT_GPT54) {
      return { endpoint: env.AZURE_OPENAI_ENDPOINT_GPT54, apiKey: env.AZURE_OPENAI_API_KEY_GPT54 };
    }
    return { endpoint: env.AZURE_OPENAI_ENDPOINT, apiKey: env.AZURE_OPENAI_API_KEY };
  }

  /** Only the light slot (small background calls) gets the short timeout; chat and reasoning replies can run long — see constants.ts. */
  private getDefaultTimeoutMs(model: AiModel): number {
    return model === 'light' ? AI_REQUEST_TIMEOUT_MS : AI_REASONING_MODEL_REQUEST_TIMEOUT_MS;
  }

  /**
   * Sends a chat completion request to Azure AI Foundry.
   * @param model GPT-4o for complex reasoning; GPT-4o mini for lightweight tasks.
   * @param messages Full conversation message array.
   * @param maxTokens Optional override.
   */
  public async chat(
    model: AiModel,
    messages: ConversationMessage[],
    maxTokens = AI_DEFAULT_MAX_TOKENS,
    timeoutMs?: number,
    signal?: AbortSignal,
    jsonSchema?: LlmJsonSchema,
    route?: ModelRoute,
  ): Promise<string> {
    const data = await this.request(model, messages, undefined, maxTokens, 'auto', timeoutMs, jsonSchema, signal, route);
    if (data.choices[0]?.finish_reason === 'length') throw new AiOutputLimitError();
    if (data.choices[0]?.finish_reason !== 'stop') throw new AiError('AI response was incomplete or refused');
    const content = data.choices[0]?.message.content;

    if (!content) {
      throw new AiError('Empty response from AI model');
    }

    return content;
  }

  /**
   * Background and bulk work (article triage, deep dives): runs on the separate GPT-5.4
   * resource, which has its own, much larger quota — gpt-4o and gpt-4o mini are one shared
   * deployment limited to 50,000 tokens a minute, which live chat also depends on, so bulk
   * jobs must never run there. Falls back to gpt-4o mini where that resource isn't configured.
   */
  public async chatBulk(
    messages: ConversationMessage[],
    maxTokens = 1_500,
    timeoutMs = 120_000,
    /** More effort for work where quality matters (a spec); reasoning tokens count against maxTokens. */
    reasoningEffort: 'low' | 'medium' | 'high' = 'low',
    jsonSchema?: LlmJsonSchema,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const endpoint = env.AZURE_OPENAI_ENDPOINT_GPT54;
    const apiKey = env.AZURE_OPENAI_API_KEY_GPT54;
    if (endpoint === undefined || endpoint === '' || apiKey === undefined || apiKey === '') {
      if (jsonSchema !== undefined) {
        const data = await this.request('light', messages, undefined, maxTokens, 'auto', timeoutMs, jsonSchema, callerSignal);
        if (data.choices[0]?.finish_reason === 'length') throw new AiOutputLimitError();
        if (data.choices[0]?.finish_reason !== 'stop' || !data.choices[0].message.content) throw new AiError('Structured bulk extraction was incomplete or refused');
        return data.choices[0].message.content;
      }
      return this.chat('light', messages, maxTokens, timeoutMs, callerSignal);
    }
    const deployment = env.AZURE_OPENAI_DEPLOYMENT_SCREEN_READ ?? 'gpt-5.4';
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    let usage: TokenUsage | undefined;
    let response: Response;
    try {
      signal.throwIfAborted();
      const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ messages, max_completion_tokens: maxTokens, reasoning_effort: reasoningEffort,
          ...(jsonSchema !== undefined && { response_format: { type: 'json_schema', json_schema: { ...jsonSchema, strict: true } } }) }),
        signal,
      } as const;
      if (timeoutMs > NATIVE_FETCH_HEADERS_TIMEOUT_MS) {
        // Native fetch has a separate five-minute headers deadline; AbortSignal alone cannot extend it.
        const result = await requestHttp(url, { ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        response = new Response(await result.body.text(), { status: result.statusCode, statusText: STATUS_CODES[result.statusCode] ?? '' });
      } else {
        response = await fetch(url, options);
      }
      if (!response.ok) {
        throw new AiError(`${response.status.toString()} ${response.statusText}: ${(await response.text()).slice(0, MAX_ERROR_DETAILS_CHARS)}`);
      }
      const data = (await response.json()) as ChatCompletionResponse;
      usage = tokenUsageFrom(data.usage);
      const content = data.choices[0]?.message.content;
      if (data.choices[0]?.finish_reason === 'length') throw new AiOutputLimitError();
      if (data.choices[0]?.finish_reason !== 'stop') throw new AiError('Bulk response was incomplete or refused');
      if (!content) throw new AiError('Empty response from the bulk model');
      this.logCall('bulk', deployment, 'chat', startedAt, usage);
      return content;
    } catch (err) {
      const code = transportCode(err);
      const isTimeout = signal.aborted || err instanceof Error && err.name === 'TimeoutError'
        || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
      const failure = callerSignal?.aborted ? new AiStoppedError() : err instanceof AiError ? err
        : new AiError(isTimeout ? `Bulk request timed out after ${timeoutMs.toString()}ms${code ? ` (${code})` : ''}`
        : `Bulk request failed: ${err instanceof Error ? err.message : String(err)}${code ? ` (${code})` : ''}`);
      this.logCall('bulk', deployment, 'chat', startedAt, usage, failure);
      throw failure;
    }
  }

  /**
   * Sends a chat completion request that may invoke tools (function calling).
   * Returns the assistant's text (may be null when the model only wants to
   * call tools) plus any requested tool calls — the caller is responsible for
   * executing them and feeding results back via a `tool` role message.
   */
  public async chatWithTools(
    model: AiModel,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    maxTokens = AI_DEFAULT_MAX_TOKENS,
    toolChoice: LlmToolChoice = 'auto',
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ content: string | null; toolCalls: LlmToolCall[]; finishReason: string | undefined }> {
    const data = await this.request(model, messages, tools, maxTokens, toolChoice, timeoutMs, undefined, signal);
    const message = data.choices[0]?.message;

    if (!message) {
      throw new AiError('Empty response from AI model');
    }

    return {
      content: message.content ?? null,
      toolCalls: message.tool_calls ?? [],
      finishReason: data.choices[0]?.finish_reason,
    };
  }

  /**
   * Streaming version of chatWithTools: visible text is passed to onDelta as
   * it's written; resolves with the same result once the round ends.
   * `signal` lets the caller stop the request (the Stop button).
   */
  public async chatWithToolsStream(
    model: AiModel,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    maxTokens: number,
    toolChoice: LlmToolChoice,
    timeoutMs: number,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    /** Another deployment on the reasoning endpoint (e.g. "Ask another model"). */
    route?: ModelRoute,
    /** Responses API only: built-in tools (e.g. code_interpreter) and progress lines for them. */
    extras: { builtInTools?: Array<Record<string, unknown>>; onActivity?: (line: string) => void } = {},
  ): Promise<{ content: string | null; toolCalls: LlmToolCall[]; finishReason: string | undefined }> {
    const startedAt = Date.now();
    const deployment = route?.deployment ?? this.getDeployment(model);
    const api = model === 'reasoning' && (route?.api ?? env.AZURE_OPENAI_GPT54_API) === 'responses' ? 'responses' : 'chat';
    try {
      const { usage, ...result } = await this.streamRound(model, messages, tools, maxTokens, toolChoice, timeoutMs, onDelta, signal, route, extras);
      this.logCall(model, deployment, api, startedAt, usage);
      return result;
    } catch (err) {
      this.logCall(model, deployment, api, startedAt, undefined, err);
      throw err;
    }
  }

  private async streamRound(
    model: AiModel,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    maxTokens: number,
    toolChoice: LlmToolChoice,
    timeoutMs: number,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    /** Another deployment on the reasoning endpoint (e.g. "Ask another model"). */
    route?: ModelRoute,
    /** Responses API only: built-in tools (e.g. code_interpreter) and progress lines for them. */
    extras: { builtInTools?: Array<Record<string, unknown>>; onActivity?: (line: string) => void } = {},
  ): Promise<{ content: string | null; toolCalls: LlmToolCall[]; finishReason: string | undefined; usage: TokenUsage | undefined }> {
    const deployment = route?.deployment ?? this.getDeployment(model);
    const { endpoint, apiKey } = this.getConnection(model);
    const viaResponses = model === 'reasoning' && (route?.api ?? env.AZURE_OPENAI_GPT54_API) === 'responses';
    const url = viaResponses
      ? `${endpoint}/openai/v1/responses`
      : `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
    const body = viaResponses
      ? { ...responsesBody(deployment, messages, tools, maxTokens, toolChoice, extras.builtInTools), stream: true }
      : {
          messages,
          max_completion_tokens: maxTokens,
          ...(this.supportsCustomTemperature(model) && { temperature: 0.7 }),
          ...(tools.length > 0 && { tools, tool_choice: toolChoice }),
          stream: true,
          stream_options: { include_usage: true },
        };
    const timeout = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetchModelStream(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey !== undefined && { 'api-key': apiKey }),
        } as Record<string, string>,
        body: JSON.stringify(body),
      }, signal !== undefined ? AbortSignal.any([timeout, signal]) : timeout, extras.onActivity);
    } catch (err) {
      throw streamError(model, err, timeoutMs, signal);
    }
    if (!response.ok || response.body === null) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }

    let content = '';
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    const toolCalls: LlmToolCall[] = [];
    const partialCalls = new Map<number, LlmToolCall>();
    const handle = (data: string): void => {
      if (data === '[DONE]') return;
      const evt = JSON.parse(data) as Record<string, unknown>;
      if (!viaResponses && typeof evt['usage'] === 'object' && evt['usage'] !== null) usage = tokenUsageFrom(evt['usage'] as Record<string, unknown>);
      if (viaResponses) {
        const type = evt['type'] as string | undefined;
        if (type === 'response.output_text.delta') {
          const delta = String(evt['delta'] ?? '');
          content += delta;
          if (delta !== '') onDelta(delta);
        } else if (type === 'response.output_item.done') {
          const item = evt['item'] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
          if (item?.type === 'function_call') {
            toolCalls.push({ id: item.call_id ?? '', type: 'function', function: { name: item.name ?? '', arguments: item.arguments ?? '{}' } });
          }
        } else if (type === 'response.code_interpreter_call.in_progress') {
          extras.onActivity?.('Running a calculation on the spreadsheet');
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          const r = evt['response'] as { status?: string; incomplete_details?: { reason?: string } | null; usage?: Record<string, unknown> } | undefined;
          if (r?.usage !== undefined) usage = tokenUsageFrom(r.usage);
          finishReason = r?.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop';
        } else if (type === 'response.failed' || type === 'error') {
          throw new AiError(`Model stream failed: ${data.slice(0, 500)}`);
        }
        return;
      }
      const choice = (evt['choices'] as Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> | undefined)?.[0];
      if (choice === undefined) return; // e.g. the content-filter preamble
      const delta = choice.delta?.content ?? '';
      if (delta !== '') {
        content += delta;
        onDelta(delta);
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const call = partialCalls.get(tc.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (tc.id !== undefined) call.id = tc.id;
        if (tc.function?.name !== undefined) call.function.name += tc.function.name;
        if (tc.function?.arguments !== undefined) call.function.arguments += tc.function.arguments;
        partialCalls.set(tc.index, call);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (data !== '') handle(data);
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw streamError(model, err, timeoutMs, signal);
    }

    toolCalls.push(...[...partialCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c));
    if (toolCalls.length > 0) finishReason = 'tool_calls';
    return { content: content === '' ? null : content, toolCalls, finishReason, usage };
  }

  /**
   * Reasoning-family models (currently gpt-5.4) reject any `temperature`
   * value other than the API default of 1 — Azure returns a 400
   * "Unsupported value" error if we send 0.7 like we do for gpt-4o/gpt-4o
   * mini. Omit the field entirely for those models instead of sending it.
   */
  private supportsCustomTemperature(model: AiModel): boolean {
    return model !== 'reasoning';
  }

  private async request(
    model: AiModel,
    messages: ConversationMessage[] | LlmMessage[],
    tools: LlmToolDefinition[] | undefined,
    maxTokens: number,
    toolChoice: LlmToolChoice = 'auto',
    timeoutMsOverride?: number,
    jsonSchema?: LlmJsonSchema,
    signal?: AbortSignal,
    route?: ModelRoute,
  ): Promise<ChatCompletionResponse> {
    const startedAt = Date.now();
    const deployment = route?.deployment ?? this.getDeployment(model);
    const api = model === 'reasoning' && (route?.api ?? env.AZURE_OPENAI_GPT54_API) === 'responses' ? 'responses' : 'chat';
    let usage: TokenUsage | undefined;
    try {
      signal?.throwIfAborted();
      const data = await this.requestRaw(model, messages, tools, maxTokens, toolChoice, timeoutMsOverride, jsonSchema, signal, route);
      usage = tokenUsageFrom(data.usage);
      if (tools === undefined) {
        if (data.choices[0]?.finish_reason === 'length') throw new AiOutputLimitError();
        if (data.choices[0]?.finish_reason !== 'stop' || !data.choices[0]?.message.content) {
          throw new AiError('AI response was empty, incomplete or refused');
        }
      }
      this.logCall(model, deployment, api, startedAt, usage);
      return data;
    } catch (err) {
      const failure = signal?.aborted ? new AiStoppedError() : err;
      this.logCall(model, deployment, api, startedAt, usage, failure);
      throw failure;
    }
  }

  private async requestRaw(
    model: AiModel,
    messages: ConversationMessage[] | LlmMessage[],
    tools: LlmToolDefinition[] | undefined,
    maxTokens: number,
    toolChoice: LlmToolChoice = 'auto',
    timeoutMsOverride?: number,
    jsonSchema?: LlmJsonSchema,
    signal?: AbortSignal,
    route?: ModelRoute,
  ): Promise<ChatCompletionResponse> {
    const deployment = route?.deployment ?? this.getDeployment(model);
    const { endpoint, apiKey } = this.getConnection(model);
    const timeoutMs = timeoutMsOverride ?? this.getDefaultTimeoutMs(model);
    if (model === 'reasoning' && (route?.api ?? env.AZURE_OPENAI_GPT54_API) === 'responses') {
      return this.requestViaResponses(model, deployment, endpoint, apiKey, messages, tools, maxTokens, toolChoice, timeoutMs, signal, jsonSchema);
    }
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey !== undefined && { 'api-key': apiKey }),
        } as Record<string, string>,
        body: JSON.stringify({
          messages,
          max_completion_tokens: maxTokens,
          ...(jsonSchema !== undefined && { response_format: { type: 'json_schema', json_schema: { ...jsonSchema, strict: true } } }),
          ...(this.supportsCustomTemperature(model) && { temperature: jsonSchema !== undefined ? 0 : DEFAULT_CHAT_TEMPERATURE }),
          ...(tools !== undefined && tools.length > 0 && { tools, tool_choice: toolChoice }),
        }),
        // Never hang forever — a slow/unreachable endpoint must not stall sync jobs.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout() rejects with a raw DOMException, not an
      // AiError — left unwrapped it skipped our typed-error handling
      // entirely and only showed up in logs as "[Unhandled error]" with no
      // indication it was an AI timeout.
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new AiError(
        isTimeout
          ? `Request to ${model} timed out after ${timeoutMs}ms`
          : `Request to ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }


    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Same request via the Responses API, for deployments that only accept
   * function tools there (gpt-6-astra). Translates chat-completions messages
   * and tools in, and the output back into the chat-completions shape, so
   * callers are unchanged. Stateless: store=false, full history each turn.
   */
  private async requestViaResponses(
    model: AiModel,
    deployment: string,
    endpoint: string | undefined,
    apiKey: string | undefined,
    messages: ConversationMessage[] | LlmMessage[],
    tools: LlmToolDefinition[] | undefined,
    maxTokens: number,
    toolChoice: LlmToolChoice,
    timeoutMs: number,
    signal?: AbortSignal,
    jsonSchema?: LlmJsonSchema,
  ): Promise<ChatCompletionResponse> {
    let response: Response;
    try {
      response = await fetch(`${endpoint}/openai/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey !== undefined && { 'api-key': apiKey }),
        } as Record<string, string>,
        body: JSON.stringify({
          ...responsesBody(deployment, messages, tools, maxTokens, toolChoice),
          ...(jsonSchema ? { text: { format: { type: 'json_schema', ...jsonSchema, strict: true } } } : {}),
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new AiError(
        isTimeout
          ? `Request to ${model} timed out after ${timeoutMs}ms`
          : `Request to ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }

    const data = await response.json() as {
      status?: string;
      incomplete_details?: { reason?: string } | null;
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
    };
    const output = data.output ?? [];
    if (output.some(item => item.content?.some(part => part.type === 'refusal'))) {
      throw new AiError('AI response was incomplete or refused');
    }
    const text = output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
    const toolCalls: LlmToolCall[] = output
      .filter((o) => o.type === 'function_call')
      .map((o) => ({ id: o.call_id ?? '', type: 'function', function: { name: o.name ?? '', arguments: o.arguments ?? '{}' } }));
    const finishReason = toolCalls.length > 0
      ? 'tool_calls'
      : data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens' ? 'length'
        : data.status === 'completed' ? 'stop' : 'error';
    return {
      choices: [{ message: { role: 'assistant', content: text === '' ? null : text, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) }, finish_reason: finishReason }],
      usage: data.usage === undefined ? undefined : {
        prompt_tokens: data.usage.input_tokens ?? 0, completion_tokens: data.usage.output_tokens ?? 0, total_tokens: data.usage.total_tokens ?? 0,
        prompt_tokens_details: { cached_tokens: data.usage.input_tokens_details?.cached_tokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: data.usage.output_tokens_details?.reasoning_tokens ?? 0 },
      },
    };
  }
}

/** Thrown when the caller stopped the request (Stop button), as opposed to a failure. */
export class AiStoppedError extends AiError {
  constructor() { super('Stopped'); this.name = 'AiStoppedError'; }
}

function streamError(model: AiModel, err: unknown, timeoutMs: number, signal: AbortSignal | undefined): AiError {
  if (signal?.aborted === true) return new AiStoppedError();
  const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  const code = transportCode(err);
  const error = new AiError(
    isTimeout
      ? `Request to ${model} timed out after ${timeoutMs.toString()}ms`
      : `Request to ${model} failed: ${err instanceof Error ? err.message : String(err)}${code !== undefined ? ` [${code}]` : ''}`,
  );
  error.cause = err;
  return error;
}

/** Chat-completions messages and tools translated into a Responses API request body. */
function responsesBody(
  deployment: string,
  messages: ConversationMessage[] | LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
  maxTokens: number,
  toolChoice: LlmToolChoice,
  builtInTools: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const m of messages as LlmMessage[]) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    } else if (m.role === 'assistant') {
      if (m.content !== null && m.content !== '') input.push({ role: 'assistant', content: m.content });
      for (const call of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else {
      input.push({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => (p.type === 'text'
            ? { type: 'input_text', text: p.text }
            : { type: 'input_image', image_url: p.image_url.url, detail: p.image_url.detail ?? 'high' })),
      });
    }
  }
  const functionTools = (tools ?? []).map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false }));
  const allTools = [...functionTools, ...builtInTools];
  return {
    model: deployment,
    input,
    max_output_tokens: maxTokens,
    store: false,
    ...(allTools.length > 0 && {
      tools: allTools,
      tool_choice: toolChoice === 'auto' || toolChoice === 'none' || functionTools.length === 0 ? toolChoice === 'none' ? 'none' : 'auto' : { type: 'function', name: toolChoice.function.name },
    }),
  };
}

const foundryClients = new Map<string, FoundryClient>();

/** The shared client for a feature; `feature` is how its calls are labelled in the usage log. */
export function getFoundryClient(feature = 'unlabelled'): FoundryClient {
  let client = foundryClients.get(feature);
  if (!client) {
    client = new FoundryClient(feature);
    foundryClients.set(feature, client);
  }
  return client;
}
