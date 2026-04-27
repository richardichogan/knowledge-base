import { env } from '../config/env.js';
import { AiError } from '../types/errors.js';
import { AI_DEFAULT_MAX_TOKENS } from '../config/constants.js';
import type { ConversationMessage, AiModel } from '../types/aiContext.js';

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
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
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AiError(`${response.status} ${response.statusText}: ${text}`);
    }

    const data = await response.json() as ChatCompletionResponse;
    const content = data.choices[0]?.message.content;

    if (!content) {
      throw new AiError('Empty response from AI model');
    }

    return content;
  }
}

let foundryClientInstance: FoundryClient | undefined;

export function getFoundryClient(): FoundryClient {
  if (!foundryClientInstance) {
    foundryClientInstance = new FoundryClient();
  }
  return foundryClientInstance;
}
