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
 * Azure AI Foundry client for GPT-4o and GPT-4o mini.
 * All AI usage billed against MSDN credits via Azure AI Foundry endpoint.
 * No Anthropic API — Azure AI Foundry only.
 */
export class FoundryClient {
  private getDeployment(model: AiModel): string {
    return model === 'gpt-4o'
      ? env.AZURE_OPENAI_DEPLOYMENT_GPT4O
      : env.AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI;
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

  private async request(
    model: AiModel,
    messages: ConversationMessage[] | LlmMessage[],
    tools: LlmToolDefinition[] | undefined,
    maxTokens: number,
  ): Promise<ChatCompletionResponse> {
    const deployment = this.getDeployment(model);
    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.AZURE_OPENAI_API_KEY !== undefined && { 'api-key': env.AZURE_OPENAI_API_KEY }),
      } as Record<string, string>,
      body: JSON.stringify({
        messages,
        max_completion_tokens: maxTokens,
        temperature: 0.7,
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

  /** True when the Foundry instance has a Whisper deployment configured for speech-to-text. */
  public hasSpeechToText(): boolean {
    return env.AZURE_OPENAI_DEPLOYMENT_WHISPER !== undefined;
  }

  /** True when the Foundry instance has a TTS deployment configured for speech synthesis. */
  public hasTextToSpeech(): boolean {
    return env.AZURE_OPENAI_DEPLOYMENT_TTS !== undefined;
  }

  /**
   * Transcribes an audio buffer via the Foundry Whisper deployment.
   * @param audio Raw audio bytes (webm/ogg/wav/mp3 — whatever the browser recorded).
   * @param mimeType Content-Type of the audio, used to name the multipart file part.
   */
  public async transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
    const deployment = env.AZURE_OPENAI_DEPLOYMENT_WHISPER;
    if (deployment === undefined) {
      throw new AiError('Speech-to-text is not configured (AZURE_OPENAI_DEPLOYMENT_WHISPER unset)');
    }

    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/audio/transcriptions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
    const extension = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3' : 'webm';

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${extension}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...(env.AZURE_OPENAI_API_KEY !== undefined && { 'api-key': env.AZURE_OPENAI_API_KEY }),
      } as Record<string, string>,
      body: form,
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }

    const data = (await response.json()) as { text?: string };
    return data.text ?? '';
  }

  /**
   * Synthesises speech audio from text via the Foundry TTS deployment.
   * Returns raw MP3 bytes.
   */
  public async synthesiseSpeech(text: string, voice = 'alloy'): Promise<Buffer> {
    const deployment = env.AZURE_OPENAI_DEPLOYMENT_TTS;
    if (deployment === undefined) {
      throw new AiError('Text-to-speech is not configured (AZURE_OPENAI_DEPLOYMENT_TTS unset)');
    }

    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/audio/speech?api-version=${env.AZURE_OPENAI_API_VERSION}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.AZURE_OPENAI_API_KEY !== undefined && { 'api-key': env.AZURE_OPENAI_API_KEY }),
      } as Record<string, string>,
      body: JSON.stringify({ input: text, voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

let foundryClientInstance: FoundryClient | undefined;

export function getFoundryClient(): FoundryClient {
  if (!foundryClientInstance) {
    foundryClientInstance = new FoundryClient();
  }
  return foundryClientInstance;
}
