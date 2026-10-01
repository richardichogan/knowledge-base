import { env } from '../config/env.js';
import { AiError } from '../types/errors.js';
import {
  AI_DEFAULT_MAX_TOKENS,
  AI_REQUEST_TIMEOUT_MS,
  AI_REASONING_MODEL_REQUEST_TIMEOUT_MS,
} from '../config/constants.js';
import type { ConversationMessage, AiModel } from '../types/aiContext.js';
import type { ModelRoute } from './modelChoices.js';

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

/** Tool-selection mode accepted by Azure OpenAI chat completions. */
export type LlmToolChoice =
  | 'auto'
  | { type: 'function'; function: { name: string } };

/**
 * Message shape used internally for tool-calling turns — a superset of
 * ConversationMessage that also allows assistant tool_calls and tool results.
 */
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: LlmToolCall[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Azure AI Foundry client for GPT-4o, GPT-4o mini, and GPT-5.5.
 * All AI usage billed against MSDN credits via Azure AI Foundry endpoint(s).
 * GPT-5.5 is served from a separate Foundry resource (see env.ts) — it needs
 * its own endpoint/key, not just a different deployment name on the main one.
 * No Anthropic API — Azure AI Foundry only.
 */
export class FoundryClient {
  private getDeployment(model: AiModel): string {
    if (model === 'gpt-4o') return env.AZURE_OPENAI_DEPLOYMENT_GPT4O;
    if (model === 'gpt-5.4') return env.AZURE_OPENAI_DEPLOYMENT_GPT54;
    return env.AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI;
  }

  /** Resolves the endpoint + api key to use for a given model — gpt-5.4 can live on a separate resource. */
  private getConnection(model: AiModel): { endpoint: string | undefined; apiKey: string | undefined } {
    if (model === 'gpt-5.4' && env.AZURE_OPENAI_ENDPOINT_GPT54) {
      return { endpoint: env.AZURE_OPENAI_ENDPOINT_GPT54, apiKey: env.AZURE_OPENAI_API_KEY_GPT54 };
    }
    return { endpoint: env.AZURE_OPENAI_ENDPOINT, apiKey: env.AZURE_OPENAI_API_KEY };
  }

  /** gpt-5.4 (reasoning) needs a much longer per-request timeout than gpt-4o/gpt-4o mini — see constants.ts. */
  private getDefaultTimeoutMs(model: AiModel): number {
    return model === 'gpt-5.4' ? AI_REASONING_MODEL_REQUEST_TIMEOUT_MS : AI_REQUEST_TIMEOUT_MS;
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
  ): Promise<string> {
    const data = await this.request(model, messages, undefined, maxTokens);
    const content = data.choices[0]?.message.content;

    if (!content) {
      throw new AiError('Empty response from AI model');
    }

    return content;
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
  ): Promise<{ content: string | null; toolCalls: LlmToolCall[]; finishReason: string | undefined }> {
    const data = await this.request(model, messages, tools, maxTokens, toolChoice, timeoutMs);
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
  ): Promise<{ content: string | null; toolCalls: LlmToolCall[]; finishReason: string | undefined }> {
    const deployment = route?.deployment ?? this.getDeployment(model);
    const { endpoint, apiKey } = this.getConnection(model);
    const viaResponses = model === 'gpt-5.4' && (route?.api ?? env.AZURE_OPENAI_GPT54_API) === 'responses';
    const url = viaResponses
      ? `${endpoint}/openai/v1/responses`
      : `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
    const body = viaResponses
      ? { ...responsesBody(deployment, messages, tools, maxTokens, toolChoice), stream: true }
      : {
          messages,
          max_completion_tokens: maxTokens,
          ...(this.supportsCustomTemperature(model) && { temperature: 0.7 }),
          ...(tools.length > 0 && { tools, tool_choice: toolChoice }),
          stream: true,
        };
    const timeout = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey !== undefined && { 'api-key': apiKey }),
        } as Record<string, string>,
        body: JSON.stringify(body),
        signal: signal !== undefined ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw streamError(model, err, timeoutMs, signal);
    }
    if (!response.ok || response.body === null) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }

    let content = '';
    let finishReason: string | undefined;
    const toolCalls: LlmToolCall[] = [];
    const partialCalls = new Map<number, LlmToolCall>();
    const handle = (data: string): void => {
      if (data === '[DONE]') return;
      const evt = JSON.parse(data) as Record<string, unknown>;
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
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          const r = evt['response'] as { status?: string; incomplete_details?: { reason?: string } | null } | undefined;
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
    return { content: content === '' ? null : content, toolCalls, finishReason };
  }

  /**
   * Reasoning-family models (currently gpt-5.4) reject any `temperature`
   * value other than the API default of 1 — Azure returns a 400
   * "Unsupported value" error if we send 0.7 like we do for gpt-4o/gpt-4o
   * mini. Omit the field entirely for those models instead of sending it.
   */
  private supportsCustomTemperature(model: AiModel): boolean {
    return model !== 'gpt-5.4';
  }

  private async request(
    model: AiModel,
    messages: ConversationMessage[] | LlmMessage[],
    tools: LlmToolDefinition[] | undefined,
    maxTokens: number,
    toolChoice: LlmToolChoice = 'auto',
    timeoutMsOverride?: number,
  ): Promise<ChatCompletionResponse> {
    const deployment = this.getDeployment(model);
    const { endpoint, apiKey } = this.getConnection(model);
    const timeoutMs = timeoutMsOverride ?? this.getDefaultTimeoutMs(model);
    if (model === 'gpt-5.4' && env.AZURE_OPENAI_GPT54_API === 'responses') {
      return this.requestViaResponses(model, deployment, endpoint, apiKey, messages, tools, maxTokens, toolChoice, timeoutMs);
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
          ...(this.supportsCustomTemperature(model) && { temperature: 0.7 }),
          ...(tools !== undefined && tools.length > 0 && { tools, tool_choice: toolChoice }),
        }),
        // Never hang forever — a slow/unreachable endpoint must not stall sync jobs.
        signal: AbortSignal.timeout(timeoutMs),
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
  ): Promise<ChatCompletionResponse> {
    let response: Response;
    try {
      response = await fetch(`${endpoint}/openai/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey !== undefined && { 'api-key': apiKey }),
        } as Record<string, string>,
        body: JSON.stringify(responsesBody(deployment, messages, tools, maxTokens, toolChoice)),
        signal: AbortSignal.timeout(timeoutMs),
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
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    const output = data.output ?? [];
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
      : data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop';
    return {
      choices: [{ message: { role: 'assistant', content: text === '' ? null : text, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) }, finish_reason: finishReason }],
      usage: { prompt_tokens: data.usage?.input_tokens ?? 0, completion_tokens: data.usage?.output_tokens ?? 0, total_tokens: data.usage?.total_tokens ?? 0 },
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
  return new AiError(
    isTimeout
      ? `Request to ${model} timed out after ${timeoutMs.toString()}ms`
      : `Request to ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Chat-completions messages and tools translated into a Responses API request body. */
function responsesBody(
  deployment: string,
  messages: ConversationMessage[] | LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
  maxTokens: number,
  toolChoice: LlmToolChoice,
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
      input.push({ role: m.role, content: m.content });
    }
  }
  const hasTools = tools !== undefined && tools.length > 0;
  return {
    model: deployment,
    input,
    max_output_tokens: maxTokens,
    store: false,
    ...(hasTools && {
      tools: tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })),
      tool_choice: toolChoice === 'auto' ? 'auto' : { type: 'function', name: toolChoice.function.name },
    }),
  };
}

let foundryClientInstance: FoundryClient | undefined;

export function getFoundryClient(): FoundryClient {
  if (!foundryClientInstance) {
    foundryClientInstance = new FoundryClient();
  }
  return foundryClientInstance;
}
