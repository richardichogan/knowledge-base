import type { NoteEditProposal } from './noteEdits.js';
import { buildStandingInstructionsBlock } from './athenaMemory.js';
import type { Pool } from 'pg';
import { getFoundryClient, AiStoppedError } from './foundryClient.js';
import { describeToolActivity } from './turnActivity.js';
import type { ModelRoute } from './modelChoices.js';
import { spreadsheetsBlock } from './chatFiles.js';
import { getExcludedSources, filterExcluded, recordToolSources, type ContextUsed } from './contextUsage.js';
import { buildOutputsBlock } from './chatOutputs.js';
import { buildDecisionsBlock } from './chatDecisions.js';
import { buildScreensBlock } from './chatScreens.js';
import type { LlmMessage } from './foundryClient.js';
import type { ToolImages } from './chatTools.js';
import { buildAiContext, assembleMessages } from './contextBuilder.js';
import { getToolDefinitions, executeToolCall } from './chatTools.js';
import { AI_MAX_TOOL_ITERATIONS, AI_DEFAULT_MAX_TOKENS, AI_REASONING_MODEL_MAX_TOKENS, AI_CONVERSATION_TURN_BUDGET_MS, AI_MIN_TOOL_ROUND_BUDGET_MS } from '../config/constants.js';
import type { ConversationMessage } from '../types/aiContext.js';
import type { AiModel, ChatPageContext } from '../types/aiContext.js';
import { getSessionProjectId } from './chatSessionStore.js';
import { selectRequiredToolChoice } from './toolRouting.js';
import { getCanvas } from '../services/canvasService.js';
import { buildCanvasContext } from '../services/canvasContent.js';
import type { MapChangeProposal } from './mapEdits.js';
import { looksLikeMeetingList, importMeetingList, buildTodayScheduleBlock } from '../integrations/ibm/ibmMeetings.js';


/** Live hooks for a background chat turn. */
export interface TurnHooks {
  onDelta?: (text: string) => void;
  /** The text streamed so far was a preamble to tool calls — clear it. */
  onReset?: () => void;
  onActivity?: (line: string) => void;
  signal?: AbortSignal;
  budgetMs?: number;
  /** A specific deployment for the reasoning slot ("Ask another model"; streaming turns only). */
  modelRoute?: ModelRoute;
  /** Only tools that read — for re-answering, so nothing is created twice. */
  readOnlyTools?: boolean;
  /** Filled in with what the reply drew on (the "Used:" line). */
  contextUsed?: ContextUsed;
  /** Spreadsheets loaded into the model's code tool (needs the Responses API route). */
  codeFiles?: { ids: string[]; names: string[] };
  /** Screenshots from this chat to show the model with this message (it sees the pictures, not just their reads). */
  screenImages?: Array<{ label: string; url: string }>;
  /** This view shows no Outputs panel: deliverables go in the reply, not save_output. */
  noOutputsPanel?: boolean;
}

const NO_OUTPUTS_PANEL_NOTE = [
  '## Where he is reading this chat',
  'He is in a compact Athena panel (Think, the floating chat, or his phone) that has NO Outputs panel, Decisions ' +
    'panel or Screens panel visible. Ignore any instruction to save deliverables with save_output: put the full ' +
    'deliverable (spec, stories, prompt, draft) in your reply itself, with prompts and code in a fenced code block ' +
    'so he can copy them. Do not say you saved anything to Outputs. If an earlier deliverable is listed under ' +
    'Outputs below, he cannot see it here — give him its content in the reply when he needs it.',
].join('\n');

/** Tools that change something; left out when a turn must only read. */
const WRITE_TOOLS = new Set(['set_content_plan', 'create_task', 'update_task', 'create_note_draft', 'propose_note_edit', 'propose_map_changes', 'remember', 'forget_memory', 'save_output']);

function isStopped(hooks: TurnHooks): boolean {
  return hooks.signal?.aborted === true;
}

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
  /** Called with each tool name the model invokes — lets the caller report the reply's sources. */
  onToolCall?: (toolName: string) => void,
  /** Per-turn tool context: the open Think note, and a collector for proposed edits to it. */
  toolContext: { noteId?: string | undefined; noteEdits?: NoteEditProposal[]; mapChanges?: MapChangeProposal[] } = {},
  /** Live turn hooks (background turns): streamed text, activity lines, Stop, a longer time budget. */
  hooks: TurnHooks = {},
): Promise<string> {
  // A mind map open beside the chat (noteId "map:<id>"): Athena gets its outline and can propose changes.
  const mapId = toolContext.noteId?.startsWith('map:') === true ? toolContext.noteId.slice('map:'.length) : undefined;
  const openMap = mapId !== undefined ? await getCanvas(mapId).catch(() => null) : null;
  const mapOutlineResult = openMap !== null
    ? await buildCanvasContext(db, openMap, userMessage, pageContext?.selectedId).catch((err: unknown) => {
      console.error('[canvas] context failed:', err);
      return null;
    })
    : null;
  const context = await buildAiContext(db, userMessage, history, sessionId);
  // "Don't use this" items stay out of auto-retrieval and search results for this chat.
  const excluded = new Set(sessionId !== undefined
    ? (await getExcludedSources(db, sessionId).catch(() => [])).map((s) => s.id)
    : []);
  if (excluded.size > 0) context.ragItems = context.ragItems.filter((item) => !excluded.has(item.id));
  const used = hooks.contextUsed;
  const activeProjectId = sessionId !== undefined ? await getSessionProjectId(db, sessionId) : null;
  // Learned standing instructions + liked examples for this persona/project.
  const standingBlock = await buildStandingInstructionsBlock(db, { persona, projectId: activeProjectId })
    .catch((err: unknown) => { console.error('[memory] could not load standing instructions:', err); return ''; });
  // A pasted M365 Copilot meeting list is saved as today's IBM diary before Athena replies.
  let meetingImportNote = '';
  if (looksLikeMeetingList(userMessage)) {
    try {
      const r = await importMeetingList(db, userMessage);
      meetingImportNote = [
        '## Meeting list saved',
        `The user's message is their IBM meeting list for ${r.date}. It has already been saved to their calendar ` +
          `(${r.imported.toString()} meetings${r.removed > 0 ? `, ${r.removed.toString()} earlier entries no longer listed were removed` : ''}).`,
        r.tasksCreated.length > 0 ? `Prep tasks added to the Plan: ${r.tasksCreated.join('; ')}.` : 'No new Plan tasks were added.',
        r.tasksAlreadyThere.length > 0 ? `Already on the Plan (not duplicated): ${r.tasksAlreadyThere.join('; ')}.` : '',
        'Confirm this briefly, point out clashes and the meetings that need prep, and do NOT call create_task for these meetings.',
      ].filter(Boolean).join('\n');
    } catch (err) {
      console.error('[meetings] import failed:', err);
    }
  }
  // Today's date and meetings (personal calendar + pasted IBM diary), always.
  const scheduleBlock = await buildTodayScheduleBlock(db)
    .catch((err: unknown) => { console.error('[meetings] schedule block failed:', err); return ''; });
  const mapBlock = mapOutlineResult === null ? '' : [
    '## Canvas in view (the user is working on this canvas: cards of related content joined by typed connections)',
    'Cards are shown with aliases in brackets (c1, c2 …), followed by the content behind each card. Treat this as the ' +
      'primary material for questions about the canvas, and cite cards by title. Use propose_map_changes to change it.',
    mapOutlineResult.text,
  ].join('\n');
  // The chat's Outputs and Decisions panels.
  const outputsBlock = sessionId !== undefined
    ? await buildOutputsBlock(db, sessionId).catch((err: unknown) => { console.error('[outputs] context failed:', err); return ''; })
    : '';
  const decisionsBlock = sessionId !== undefined
    ? await buildDecisionsBlock(db, sessionId).catch((err: unknown) => { console.error('[decisions] context failed:', err); return ''; })
    : '';
  const screensBlock = sessionId !== undefined
    ? await buildScreensBlock(db, sessionId).catch((err: unknown) => { console.error('[screens] context failed:', err); return ''; })
    : '';
  if (used !== undefined) {
    used.project = context.activeProjectName;
    used.instructions = (standingBlock.match(/^- /gm) ?? []).length;
    used.inView = pageContext?.title ?? null;
    used.auto = context.ragItems.slice(0, 10).map((item) => ({ id: item.id, kind: item.source === 'note' ? 'note' : 'item', title: item.title, url: item.url ?? null }));
    used.outputs = (outputsBlock.match(/^### /gm) ?? []).length;
    used.decisions = (decisionsBlock.match(/^- /gm) ?? []).length;
    used.screens = (screensBlock.match(/^### /gm) ?? []).length;
  }
  const sheetsBlock = spreadsheetsBlock(hooks.codeFiles?.names ?? []);
  const systemExtras = [hooks.noOutputsPanel === true ? NO_OUTPUTS_PANEL_NOTE : '', standingBlock, scheduleBlock, meetingImportNote, mapBlock, decisionsBlock, outputsBlock, screensBlock, sheetsBlock].filter((b) => b !== '').join('\n\n---\n\n');
  const baseMessages = await assembleMessages(context, history, userMessage, persona, pageContext, systemExtras);
  const messages: LlmMessage[] = baseMessages.map((m) => ({ role: m.role, content: m.content }) as LlmMessage);
  const images = hooks.screenImages ?? [];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  if (images.length > 0 && lastUser !== -1) {
    const text = messages[lastUser]!.content as string;
    messages[lastUser] = {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.flatMap((img) => [
          { type: 'text' as const, text: `[The screen "${img.label}" from this chat, attached so you can see it — judge its layout and visual design from the picture itself.]` },
          { type: 'image_url' as const, image_url: { url: img.url, detail: 'high' as const } },
        ]),
      ],
    };
  }

  const client = getFoundryClient();
  const allTools = await getToolDefinitions();
  const tools = (hooks.readOnlyTools === true ? allTools.filter((t) => !WRITE_TOOLS.has(t.function.name)) : allTools)
    .filter((t) => hooks.noOutputsPanel !== true || t.function.name !== 'save_output');
  const requiredFirstTool = selectRequiredToolChoice(
    userMessage,
    tools,
    context.projectReferences,
    context.activeProjectName,
    toolContext.noteId !== undefined && toolContext.noteId !== '' && !toolContext.noteId.startsWith('doc:') && mapId === undefined,
    mapOutlineResult !== null,
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
  const turnBudgetMs = hooks.budgetMs ?? AI_CONVERSATION_TURN_BUDGET_MS;

  for (let i = 0; i < AI_MAX_TOOL_ITERATIONS; i++) {
    if (isStopped(hooks)) throw new AiStoppedError();
    hooks.onActivity?.(i === 0 ? 'Thinking' : 'Reading what I found');
    const remainingBudgetMs = turnBudgetMs - (Date.now() - turnStart);
    if (i > 0 && remainingBudgetMs < AI_MIN_TOOL_ROUND_BUDGET_MS) {
      console.warn(`[ai] Stopping tool loop after ${i} round(s) — turn budget exhausted`);
      return "This is taking longer than expected — could you try again, or ask a more specific question?";
    }

    const roundToolChoice = i === 0 && requiredFirstTool !== undefined ? requiredFirstTool : 'auto';
    const roundTimeoutMs = Math.max(remainingBudgetMs, AI_MIN_TOOL_ROUND_BUDGET_MS);
    // Streams when someone is following live, or when a specific deployment is chosen (only the streaming call takes one).
    const response = hooks.onDelta !== undefined || hooks.modelRoute !== undefined
      ? await client.chatWithToolsStream(model, messages, tools, maxTokens, roundToolChoice, roundTimeoutMs, hooks.onDelta ?? (() => { /* not followed live */ }), hooks.signal, hooks.modelRoute, {
        ...(hooks.codeFiles !== undefined && hooks.codeFiles.ids.length > 0 && {
          builtInTools: [{ type: 'code_interpreter', container: { type: 'auto', file_ids: hooks.codeFiles.ids } }],
        }),
        ...(hooks.onActivity !== undefined && { onActivity: hooks.onActivity }),
      })
      : await client.chatWithTools(model, messages, tools, maxTokens, roundToolChoice, roundTimeoutMs);

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
    // Any text streamed this round was a preamble to tool calls, not the answer.
    if (response.content !== null && response.content !== '') hooks.onReset?.();

    const roundImages: Array<{ label: string; url: string }> = [];
    for (const call of response.toolCalls) {
      let result: unknown;
      if (isStopped(hooks)) throw new AiStoppedError();
      onToolCall?.(call.function.name);
      hooks.onActivity?.(describeToolActivity(call.function.name, call.function.arguments));
      try {
        result = filterExcluded(
          await executeToolCall(db, call.function.name, call.function.arguments, activeProjectId ?? undefined, { sessionId, ...toolContext, mapAliases: mapOutlineResult?.aliases, mapCanvas: openMap ?? undefined }),
          excluded,
        );
        if (used !== undefined) recordToolSources(used, call.function.name, result);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
      }
      // Pictures a tool captured (screenshots) go to the model as images, not as text.
      if (result !== null && typeof result === 'object' && '__images' in result) {
        const { __images, ...rest } = result as Record<string, unknown> & ToolImages;
        roundImages.push(...(__images ?? []));
        result = rest;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (roundImages.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '[Screenshots you just captured — look at them and use them in your answer. This is not a new request from him.]' },
          ...roundImages.slice(0, 6).flatMap((img) => [
            { type: 'text' as const, text: img.label },
            { type: 'image_url' as const, image_url: { url: img.url, detail: 'high' as const } },
          ]),
        ],
      });
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
 * Short sidebar title (3–6 words) for a chat, from its opening exchange.
 * Replaces the "first 60 characters of the first message" default, which
 * produced a sidebar full of chats called "hello".
 */
export async function generateSessionTitle(userMessage: string, reply: string): Promise<string> {
  const client = getFoundryClient();
  return client.chat(
    'gpt-4o-mini',
    [
      {
        role: 'system',
        content:
          'Write a 3 to 6 word title for this chat, in sentence case, naming its actual topic. ' +
          'No quotes, no trailing punctuation, no words like "chat" or "conversation". ' +
          'If it is only a greeting with no topic, reply with exactly: Quick check-in',
      },
      { role: 'user', content: `User: ${userMessage.slice(0, 1_500)}\n\nAssistant: ${reply.slice(0, 1_500)}` },
    ],
    24,
  );
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
        : persona === 'podcast_prep'
          ? 'This was a podcast prep session for Cloudy with a Chance of Insights — organise the note around the chosen topics, the opener, the running order and segment notes, plus what was ruled out as already covered.'
        : persona === 'web_designer'
          ? 'This was a website design session — organise the note around the agreed design direction (audience and goals, page structure, visual choices, accessibility and performance points), the options considered and the one chosen, and the build prompt, preserving specs as delivered.'
        : persona === 'demo_designer'
          ? 'This was a demo design session — organise the note as a demo spec (audience and storyline, users, user stories with acceptance criteria, screens, demo script and sample data, open questions), preserving the stories and screen specs as delivered rather than summarising them away.'
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
