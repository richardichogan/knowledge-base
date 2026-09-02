import { env } from '../config/env.js';
import { AiError } from '../types/errors.js';
import { AI_DEFAULT_MAX_TOKENS, AI_REQUEST_TIMEOUT_MS } from '../config/constants.js';
import type { ConversationMessage, AiModel } from '../types/aiContext.js';

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
    if (model === 'gpt-5.5') return env.AZURE_OPENAI_DEPLOYMENT_GPT55;
    return env.AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI;
  }

  /** Resolves the endpoint + api key to use for a given model — gpt-5.5 lives on a separate resource. */
  private getConnection(model: AiModel): { endpoint: string | undefined; apiKey: string | undefined } {
    if (model === 'gpt-5.5' && env.AZURE_OPENAI_ENDPOINT_GPT55) {
      return { endpoint: env.AZURE_OPENAI_ENDPOINT_GPT55, apiKey: env.AZURE_OPENAI_API_KEY_GPT55 };
    }
    return { endpoint: env.AZURE_OPENAI_ENDPOINT, apiKey: env.AZURE_OPENAI_API_KEY };
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
  ): Promise<{ content: string | null; toolCalls: LlmToolCall[] }> {
    const data = await this.request(model, messages, tools, maxTokens);
    const message = data.choices[0]?.message;

    if (!message) {
      throw new AiError('Empty response from AI model');
    }

    return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
  }

  /**
   * Reasoning-family models (currently gpt-5.5) reject any `temperature`
   * value other than the API default of 1 — Azure returns a 400
   * "Unsupported value" error if we send 0.7 like we do for gpt-4o/gpt-4o
   * mini. Omit the field entirely for those models instead of sending it.
   */
  private supportsCustomTemperature(model: AiModel): boolean {
    return model !== 'gpt-5.5';
  }

  private async request(
    model: AiModel,
    messages: ConversationMessage[] | LlmMessage[],
    tools: LlmToolDefinition[] | undefined,
    maxTokens: number,
  ): Promise<ChatCompletionResponse> {
    const deployment = this.getDeployment(model);
    const { endpoint, apiKey } = this.getConnection(model);
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey !== undefined && { 'api-key': apiKey }),
      } as Record<string, string>,
      body: JSON.stringify({
        messages,
        max_completion_tokens: maxTokens,
        ...(this.supportsCustomTemperature(model) && { temperature: 0.7 }),
        ...(tools !== undefined && tools.length > 0 && { tools, tool_choice: 'auto' }),
      }),
      // Never hang forever — a slow/unreachable endpoint must not stall sync jobs.
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }
}

let foundryClientInstance: FoundryClient | undefined;

export function getFoundryClient(): FoundryClient {
  if (!foundryClientInstance) {
    foundryClientInstance = new FoundryClient();
  }
  return foundryClientInstance;
}
