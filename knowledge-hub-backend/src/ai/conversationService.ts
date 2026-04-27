import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import { buildAiContext, assembleMessages } from './contextBuilder.js';
import type { ConversationMessage } from '../types/aiContext.js';
import type { AiModel } from '../types/aiContext.js';

/**
 * Handles a single conversation turn.
 * Builds three-layer context, assembles message history, calls Azure AI Foundry.
 * Returns the assistant's response text.
 */
export async function handleConversationTurn(
  db: Pool,
  history: ConversationMessage[],
  userMessage: string,
  model: AiModel = 'gpt-4o',
): Promise<string> {
  const context = await buildAiContext(db, userMessage);
  const messages = assembleMessages(context, history, userMessage);
  const client = getFoundryClient();
  return client.chat(model, messages);
}

/**
 * Generates a session summary by asking GPT-4o mini to summarise the
 * conversation. The summary is returned as markdown for blob storage.
 */
export async function summariseSession(
  history: ConversationMessage[],
): Promise<string> {
  const client = getFoundryClient();
  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content:
        'You are summarising a knowledge hub session. Write a concise markdown summary ' +
        'covering key decisions, topics discussed, and any action items. ' +
        'Be factual and structured. Use headings.',
    },
    {
      role: 'user',
      content: `Summarise this conversation:\n\n${history
        .map((m) => `**${m.role}**: ${m.content}`)
        .join('\n\n')}`,
    },
  ];

  return client.chat('gpt-4o-mini', messages, 1_000);
}
