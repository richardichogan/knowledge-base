import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import type { LlmMessage } from './foundryClient.js';
import { buildAiContext, assembleMessages } from './contextBuilder.js';
import { getToolDefinitions, executeToolCall } from './chatTools.js';
import { AI_MAX_TOOL_ITERATIONS } from '../config/constants.js';
import type { ConversationMessage } from '../types/aiContext.js';
import type { AiModel } from '../types/aiContext.js';

/**
 * Handles a single conversation turn.
 * Builds three-layer context, assembles message history, calls Azure AI Foundry.
 * Supports function calling — the model may request search_knowledge_base,
 * create_task, update_task, or create_note_draft tool calls, which are
 * executed here and fed back in a loop (capped at AI_MAX_TOOL_ITERATIONS)
 * until the model produces a final text reply.
 */
export async function handleConversationTurn(
  db: Pool,
  history: ConversationMessage[],
  userMessage: string,
  model: AiModel = 'gpt-4o',
): Promise<string> {
  const context = await buildAiContext(db, userMessage);
  const baseMessages = assembleMessages(context, history, userMessage);
  const messages: LlmMessage[] = baseMessages.map((m) => ({ role: m.role, content: m.content }) as LlmMessage);

  const client = getFoundryClient();
  const tools = getToolDefinitions();

  for (let i = 0; i < AI_MAX_TOOL_ITERATIONS; i++) {
    const response = await client.chatWithTools(model, messages, tools);

    if (response.toolCalls.length === 0) {
      return response.content ?? '';
    }

    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls });

    for (const call of response.toolCalls) {
      let result: unknown;
      try {
        result = await executeToolCall(db, call.function.name, call.function.arguments);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return "I wasn't able to finish that after a few tool calls — could you rephrase or simplify the request?";
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

/**
 * Rolls an older batch of messages into (or alongside) a session's existing
 * rolling summary, producing a compact plain-prose paragraph — not a
 * structured report like summariseSession — since this gets re-injected as
 * context on every future turn and needs to stay short. Called by
 * chatSessionStore.rollUpSummaryIfNeeded once a session accumulates more
 * than AI_ROLLING_SUMMARY_TRIGGER_MESSAGES unsummarized messages, so a long
 * chat doesn't replay its full history — and cost — on every turn.
 */
export async function rollUpConversationSummary(
  previousSummary: string | null,
  batch: ConversationMessage[],
): Promise<string> {
  const client = getFoundryClient();
  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content:
        'Fold the given older messages into a single short rolling summary of this ongoing conversation. ' +
        'Write 2-4 tight sentences of plain prose (no headings, no bullet points) capturing what was ' +
        'discussed, decided, or created, and anything the user will likely refer back to later. If a ' +
        'previous summary is given, merge it with the new messages rather than replacing it — keep ' +
        'everything still relevant, drop anything superseded.',
    },
    {
      role: 'user',
      content: [
        previousSummary != null && previousSummary.trim() !== ''
          ? `Previous summary:\n${previousSummary}`
          : 'No previous summary yet.',
        `Older messages to fold in:\n\n${batch.map((m) => `**${m.role}**: ${m.content}`).join('\n\n')}`,
      ].join('\n\n---\n\n'),
    },
  ];

  return client.chat('gpt-4o-mini', messages, 400);
}
