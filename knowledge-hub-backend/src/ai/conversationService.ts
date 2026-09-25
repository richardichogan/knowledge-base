import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import type { LlmMessage } from './foundryClient.js';
import { buildAiContext, assembleMessages } from './contextBuilder.js';
import { getToolDefinitions, executeToolCall } from './chatTools.js';
import { AI_MAX_TOOL_ITERATIONS, AI_DEFAULT_MAX_TOKENS, AI_REASONING_MODEL_MAX_TOKENS, AI_CONVERSATION_TURN_BUDGET_MS, AI_MIN_TOOL_ROUND_BUDGET_MS } from '../config/constants.js';
import type { ConversationMessage } from '../types/aiContext.js';
import type { AiModel, ChatPageContext } from '../types/aiContext.js';
import { getSessionProjectId } from './chatSessionStore.js';
import { selectRequiredToolChoice } from './toolRouting.js';

/**
 * Handles a single conversation turn.
 * Builds three-layer context, assembles message history, calls Azure AI Foundry.
 * Supports function calling — the model may request search_knowledge_base,
 * create_task, update_task, create_note_draft, or tool calls live from the
 * Microsoft Learn MCP server (microsoft_docs_search/microsoft_docs_fetch/etc.)
 * and Tavily MCP server (tavily-search/tavily-extract, real internet search —
 * distinct from fetch_web_page, which can only read an already-known URL),
 * which are executed here and fed back in a loop (capped at
 * AI_MAX_TOOL_ITERATIONS) until the model produces a final text reply.
 */
export async function handleConversationTurn(
  db: Pool,
  history: ConversationMessage[],
  userMessage: string,
  model: AiModel = 'gpt-4o',
  persona?: string,
  sessionId?: string,
  pageContext?: ChatPageContext,
): Promise<string> {
  const context = await buildAiContext(db, userMessage, history, sessionId);
  const activeProjectId = sessionId !== undefined ? await getSessionProjectId(db, sessionId) : null;
  const baseMessages = await assembleMessages(context, history, userMessage, persona, pageContext);
  const messages: LlmMessage[] = baseMessages.map((m) => ({ role: m.role, content: m.content }) as LlmMessage);

  const client = getFoundryClient();
  const tools = await getToolDefinitions();
  const requiredFirstTool = selectRequiredToolChoice(
    userMessage,
    tools,
    context.projectReferences,
    context.activeProjectName,
  );
  const maxTokens = model === 'gpt-5.4' ? AI_REASONING_MODEL_MAX_TOKENS : AI_DEFAULT_MAX_TOKENS;

  // Reasoning-model turns that also call tools can take long enough,
  // round after round, that the frontend's own request timeout fires first
  // — leaving the user staring at a confusing client-side "timed out"
  // message while the backend is still (slowly) working. Track a wall-clock
  // budget across the whole loop so a round that can't realistically finish
  // in time is never started, and clamp each round's own request timeout to
  // whatever's left so we always have time to return a clear message.
  const turnStart = Date.now();

  for (let i = 0; i < AI_MAX_TOOL_ITERATIONS; i++) {
    const remainingBudgetMs = AI_CONVERSATION_TURN_BUDGET_MS - (Date.now() - turnStart);
    if (i > 0 && remainingBudgetMs < AI_MIN_TOOL_ROUND_BUDGET_MS) {
      console.warn(`[ai] Stopping tool loop after ${i} round(s) — turn budget exhausted`);
      return "This is taking longer than expected — could you try again, or ask a more specific question?";
    }

    const response = await client.chatWithTools(
      model,
      messages,
      tools,
      maxTokens,
      i === 0 && requiredFirstTool !== undefined ? requiredFirstTool : 'auto',
      Math.max(remainingBudgetMs, AI_MIN_TOOL_ROUND_BUDGET_MS),
    );

    if (response.toolCalls.length === 0) {
      if (response.content && response.content.trim() !== '') {
        return response.content;
      }
      // A reasoning model (or a content filter) can return an empty visible
      // reply — surfacing that as a blank chat bubble looks like the app is
      // broken. Tell the user something concrete instead, and log why.
      console.warn(
        `[ai] Empty completion content from ${model} (finish_reason=${response.finishReason ?? 'unknown'})`,
      );
      return response.finishReason === 'length'
        ? "That response got cut off before it produced any visible text — could you try a shorter or more focused request?"
        : "I didn't get a usable response back from the AI model that time — could you try again?";
    }

    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls });

    for (const call of response.toolCalls) {
      let result: unknown;
      try {
        result = await executeToolCall(db, call.function.name, call.function.arguments, activeProjectId ?? undefined);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return "I wasn't able to finish that after a few tool calls — could you rephrase or simplify the request?";
}

/**
 * Generates a short on-demand summary of a note's content, shown as a
 * "summary card" in the Think-embedded Athena panel when the user switches
 * to a note that has no chat started yet — gives them something useful to
 * look at instead of a blank composer.
 */
export async function summarizeNoteContent(title: string, content: string): Promise<string> {
  const client = getFoundryClient();
  const NOTE_SUMMARY_CONTENT_CHAR_LIMIT = 12_000;
  const trimmed = content.length > NOTE_SUMMARY_CONTENT_CHAR_LIMIT
    ? `${content.slice(0, NOTE_SUMMARY_CONTENT_CHAR_LIMIT)}\n\n[truncated]`
    : content;
  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content:
        'You summarise a note from a personal knowledge hub so its owner can quickly see what it covers ' +
        'before deciding what to ask about it. Write 3-5 tight sentences of plain prose covering what the ' +
        'note is about, its key points, and any open questions or actions it implies. No headings, no bullet points.',
    },
    {
      role: 'user',
      content: `Title: ${title}\n\nContent:\n${trimmed.trim() !== '' ? trimmed : '(this note is empty)'}`,
    },
  ];

  return client.chat('gpt-4o-mini', messages, 400);
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

/**
 * Formats a full Athena conversation into a Think note: a short title plus a
 * cleaned-up markdown body (headings for key points/decisions/open questions,
 * not just a raw transcript dump). Used by "Export to Think". Persona is
 * passed through so a brainstorming session is framed as "ideas explored"
 * rather than "tasks discussed".
 */
export async function formatSessionForThink(
  history: ConversationMessage[],
  persona?: string,
): Promise<{ title: string; bodyMarkdown: string }> {
  const client = getFoundryClient();
  const framing =
    persona === 'brainstorming'
      ? 'This was a brainstorming/sounding-board session — organise the note around the idea explored, the load-bearing question(s) raised, and where the thinking landed, not as a task log.'
      : persona === 'blog_post'
        ? 'This was a blog post drafting session for The Microsoft Cloud Blog — organise the note around the finished CMS package (title, content, excerpt, key takeaways, etc.) and social posts, preserving them as delivered rather than summarising them away.'
        : 'This was a general working session — organise the note around what was discussed, decided, and any follow-ups.';

  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content: [
        'You turn an Athena chat transcript into a well-formatted note for the Knowledge Hub "Think" library.',
        framing,
        'Respond in EXACTLY this format, nothing else:',
        'TITLE: <a short, specific title, no quotes>',
        '---',
        '<markdown body using ## headings, short paragraphs and bullet points where useful>',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Format this conversation:\n\n${history.map((m) => `**${m.role}**: ${m.content}`).join('\n\n')}`,
    },
  ];

  const raw = await client.chat('gpt-4o-mini', messages, 1_500);
  const separatorIndex = raw.indexOf('---');
  const titleLine = separatorIndex === -1 ? raw.split('\n')[0] ?? 'Athena export' : raw.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? raw : raw.slice(separatorIndex + 3);

  const title = titleLine.replace(/^TITLE:\s*/i, '').trim() || 'Athena export';
  const bodyMarkdown = body.trim() || raw.trim();

  return { title, bodyMarkdown };
}
