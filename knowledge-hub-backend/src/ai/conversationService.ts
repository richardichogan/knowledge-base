import type { NoteEditProposal } from './noteEdits.js';
import { buildStandingInstructionsBlock } from './athenaMemory.js';
import type { Pool } from 'pg';
import { getFoundryClient, AiStoppedError } from './foundryClient.js';
import { describeToolActivity } from './turnActivity.js';
import { ASSET_WRITE_TOOLS } from './assetTools.js';
import type { ModelRoute } from './modelChoices.js';
import { spreadsheetsBlock } from './chatFiles.js';
import { getExcludedSources, filterExcluded, recordToolSources, recordToolEvidence, attachEvidence, type ContextUsed } from './contextUsage.js';
import { createLedger, ledgerCounts } from './knowledge/evidence.js';
import { recordTurnAudit, looksAbstained, type TurnAuditRow } from './knowledge/turnAudit.js';
import { RECORD_TOOLS } from './knowledge/toolRecords.js';
import { collectIds, resolveAnswer, stripUnseenIds } from './knowledge/citations.js';
import { TurnBudget, TRANSCRIPT_REVIEW_BUDGET, DETERMINISTIC_TOOLS, budgetLimitation, finalizeKnowledgeAnswer, isDeterministicResultComplete, isKnowledgeOrchestrationEnabled, isTranscriptReviewRequest } from './knowledge/budgets.js';

const RETRIEVAL_TOOLS = new Set(['search_diagrams', 'read_diagram', 'search_knowledge_base', 'search_library', 'search_past_chats', 'read_past_chat', 'search_knowledge_graph', 'read_output', 'traverse_relationships', 'read_knowledge_record', ...STRUCTURED_TOOL_NAMES]);
import { STRUCTURED_TOOL_NAMES } from './knowledge/structuredTools.js';
import { buildOutputsBlock } from './chatOutputs.js';
import { buildDecisionsBlock } from './chatDecisions.js';
import { buildScreensBlock } from './chatScreens.js';
import type { LlmMessage, LlmToolChoice } from './foundryClient.js';
import type { ToolImages } from './chatTools.js';
import { buildAiContext, assembleMessages } from './contextBuilder.js';
import { getToolDefinitions, executeToolCall } from './chatTools.js';
import { scrubExcludedHistory } from '../services/knowledge/historyScrub.js';
import { resolveStrictProjectScope } from '../services/knowledge/scope.js';
import { AI_MAX_TOOL_ITERATIONS, AI_WRAP_UP_ROUND_MIN_MS, SHOW_NOTES_MAX_TOOL_ITERATIONS, AI_CHAT_MAX_TOKENS, AI_REASONING_MODEL_MAX_TOKENS, AI_CONVERSATION_TURN_BUDGET_MS, AI_MIN_TOOL_ROUND_BUDGET_MS } from '../config/constants.js';
import type { ConversationMessage } from '../types/aiContext.js';
import type { AiModel, ChatPageContext } from '../types/aiContext.js';
import { getSessionProjectId, readPastChat, searchReferencedPastChats } from './chatSessionStore.js';
import { focusTools, selectKnowledgeRetrievalChoice, selectRequiredToolChoice } from './toolRouting.js';
import { openFoundInstruction, unreadFoundCandidates } from './knowledge/openFound.js';
import { isImagineDemoBriefRequest } from './imagineDemoBriefSkill.js';
import { DEMO_SPECIFICATION_WRITE_TOOL, isDemoSpecificationRequest } from './demoSpecification.js';
import { getCanvas } from '../services/canvasService.js';
import { buildPeopleContext } from '../services/peopleContext.js';
import { buildCanvasContext } from '../services/canvasContent.js';
import { findDiagramContext, DIAGRAM_READING_GUIDANCE } from '../services/diagramContext.js';
import type { MapChangeProposal } from './mapEdits.js';
import { LOCAL_FILE_TOOLS, localFilesPrompt, type LocalFileWriteProposal, type LocalFolder } from './localFiles.js';
import { looksLikeMeetingList, importMeetingList } from '../integrations/ibm/ibmMeetings.js';
import { ukClock } from '../sync/ukClock.js';

/** Recent messages that count when deciding whether a follow-up still needs a specialised tool group. */
const TOOL_FOCUS_HISTORY_MESSAGES = 4;
const RAG_USED_LIMIT = 10;
const TOOL_ERROR_LOG_CHARS = 400;
const MAX_ROUND_SCREENSHOTS = 6;
const PASTED_EDIT_REPLY_CHARS = 900;
const NOTE_SUMMARY_MAX_TOKENS = 400;
const ROLLUP_MAX_TOKENS = 400;
const SESSION_SUMMARY_MAX_TOKENS = 1_000;
const EXPORT_MAX_TOKENS = 1_500;
const EXPORT_SEPARATOR = '---';
const TITLE_SOURCE_CHARS = 1_500;
const TITLE_MAX_TOKENS = 24;
const NOT_FOLLOWED_LIVE = (): void => { /* not followed live */ };

const READ_ONLY_REFUSAL = 'This request is read-only: it permits reading context and saving Outputs where allowed. The source note and other records cannot be changed.';

function parseToolArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}


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
  /** Route persists this after the accepted reply has an assistant-message id. */
  onAudit?: (row: TurnAuditRow) => void;
  /** Spreadsheets loaded into the model's code tool (needs the Responses API route). */
  codeFiles?: { ids: string[]; names: string[] };
  /** Screenshots from this chat to show the model with this message (it sees the pictures, not just their reads). */
  screenImages?: Array<{ label: string; url: string }>;
  /** This view shows no Outputs panel: deliverables go in the reply, not save_output. */
  noOutputsPanel?: boolean;
  /** Saved documents resolved from explicit @mentions, independently of automatic retrieval. */
  referenceBlock?: string;
}

const NO_OUTPUTS_PANEL_NOTE = [
  '## Where he is reading this chat',
  'He is in a compact Athena panel (Think, the floating chat, or his phone) that has NO Outputs panel, Decisions ' +
    'panel or Screens panel visible. Ignore any instruction to save deliverables with save_output: put the full ' +
    'deliverable (spec, stories, prompt, draft) in your reply itself, with prompts and code in a fenced code block ' +
    'so he can copy them. Do not say you saved anything to Outputs. If an earlier deliverable is listed under ' +
    'Outputs below, he cannot see it here — give him its content in the reply when he needs it.',
].join('\n');

/** Output budget for a turn that edits the open note: a long redraft must not be cut off. */
const NOTE_EDIT_MAX_TOKENS = 14_000;
const PAST_CHAT_QUERY_MIN_TERM_LENGTH = 3;
const PAST_CHAT_QUERY_MAX_TERMS = 6;
const PAST_CHAT_QUERY_MIN_DISTINCT_TERMS = 2;
const PAST_CHAT_CONTEXT_MAX_MATCHES = 3;
const PAST_CHAT_CONTEXT_MESSAGES = 3;
const PAST_CHAT_REFERENCE_PATTERN =
  /\b(?:earlier|previous|prior|past|latest)\b[\s\S]{0,35}\b(?:athena\s+)?(?:chat|conversation|discussion)\b|\b(?:we|you)\s+(?:discussed|talked about|covered)\b|\b(?:chat|conversation|discussion)\b[\s\S]{0,70}\b(?:in think|on mobile|on my phone|earlier|before|today)\b|\bwhat we discussed\b/i;
const PAST_CHAT_QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'i', 'you', 'we', 'they', 'my', 'our',
  'this', 'that', 'these', 'those', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'would',
  'should', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'but', 'as', 'from', 'about',
  'around', 'based', 'conversation', 'discussion', 'chat', 'think', 'earlier', 'previous', 'prior',
  'past', 'latest', 'today', 'accurately', 'describing', 'review', 'find', 'read', 'please',
]);

function pastChatSearchQuery(message: string): string | null {
  const topicMatch = [
    /\b(?:conversation|discussion|chat)\s+(?:about|around|on|regarding)\s+(.+?)(?=\s+\b(?:in|on)\s+(?:think|mobile|my phone)\b|\b(?:earlier|before|today)\b|[?.]|$)/i,
    /\b(?:we|you)\s+(?:discussed|talked about|covered)\s+(.+?)(?=\b(?:earlier|before|today)\b|[?.]|$)/i,
  ].map((pattern) => pattern.exec(message)).find((match) => match?.[1] !== undefined);
  const source = topicMatch?.[1] ?? message;
  const terms = source.toLowerCase().match(/[\p{L}\p{N}-]+/gu)
    ?.filter((term) => term.length >= PAST_CHAT_QUERY_MIN_TERM_LENGTH && !PAST_CHAT_QUERY_STOPWORDS.has(term)) ?? [];
  const distinctTerms = [...new Set(terms)].slice(0, PAST_CHAT_QUERY_MAX_TERMS);
  return distinctTerms.length >= PAST_CHAT_QUERY_MIN_DISTINCT_TERMS ? distinctTerms.join(' ') : null;
}

/** Tools that change something; left out when a turn must only read. */
const WRITE_TOOLS = new Set(['set_content_plan', 'create_task', 'update_task', 'create_note_draft', 'create_spark', 'propose_note_edit', 'propose_map_changes', 'propose_local_file_write', 'remember', 'forget_memory', 'save_output', DEMO_SPECIFICATION_WRITE_TOOL, ...ASSET_WRITE_TOOLS]);

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
  model: AiModel = 'standard',
  persona?: string,
  sessionId?: string,
  pageContext?: ChatPageContext,
  /** Called with each tool name the model invokes — lets the caller report the reply's sources. */
  onToolCall?: (toolName: string) => void,
  /** Per-turn tool context: the open Think note, and a collector for proposed edits to it. */
  toolContext: {
    noteId?: string | undefined; noteEdits?: NoteEditProposal[]; mapChanges?: MapChangeProposal[];
    localFolders?: LocalFolder[]; localFileWrites?: LocalFileWriteProposal[];
  } = {},
  /** Live turn hooks (background turns): streamed text, activity lines, Stop, a longer time budget. */
  hooks: TurnHooks = {},
): Promise<string> {
  hooks.signal?.throwIfAborted();
  hooks.onActivity?.('Loading context');
  // A mind map open beside the chat (noteId "map:<id>"): Athena gets its outline and can propose changes.
  const mapId = toolContext.noteId?.startsWith('map:') === true ? toolContext.noteId.slice('map:'.length) : undefined;
  // Diagram structure is read separately; brainstorm mutation tools remain unavailable to diagrams.
  const openCanvas = mapId !== undefined ? await getCanvas(mapId).catch((err: unknown) => {
    console.error('[canvas] could not load open canvas:', err);
    return null;
  }) : null;
  const openMap = openCanvas !== null && openCanvas.canvasType === 'brainstorm' ? openCanvas : null;
  const openDiagram = openCanvas !== null && openCanvas.canvasType === 'diagram' && pageContext?.type === 'canvas' ? openCanvas : null;
  const mapOutlineResult = openMap !== null
    ? await buildCanvasContext(db, openMap, userMessage, pageContext?.selectedId).catch((err: unknown) => {
      console.error('[canvas] context failed:', err);
      return null;
    })
    : null;
  const context = await buildAiContext(db, userMessage, history, sessionId, persona);
  hooks.signal?.throwIfAborted();
  // "Don't use this" items stay out of auto-retrieval and search results for this chat.
  let exclusionsFailed = false;
  const excluded = new Set(sessionId !== undefined
    ? (await getExcludedSources(db, sessionId).catch(() => { exclusionsFailed = true; return []; })).map((s) => s.id)
    : []);
  const used = hooks.contextUsed;
  if (exclusionsFailed) context.ragItems = [];
  if (excluded.size > 0) context.ragItems = context.ragItems.filter((item) => !excluded.has(item.id));
  const strictProjectId = await resolveStrictProjectScope(db, userMessage).catch(() => null);
  let pastChatBlock = '';
  if (!exclusionsFailed && PAST_CHAT_REFERENCE_PATTERN.test(userMessage)) {
    const query = pastChatSearchQuery(userMessage);
    if (query !== null) {
      hooks.onActivity?.('Finding the earlier conversation');
      const matches = await searchReferencedPastChats(db, query, sessionId);
      const candidates = matches.filter((match) => !excluded.has(match.sessionId)).slice(0, PAST_CHAT_CONTEXT_MAX_MATCHES);
      const readQuery = /\bdecision gates?\b/i.test(query) ? `${query} delegation acceptance` : query;
      const excerpts = await Promise.all(candidates.map(async (match) => {
        const chat = await readPastChat(db, match.sessionId, PAST_CHAT_CONTEXT_MESSAGES, readQuery);
        if (chat === null || chat.messages.length === 0) return null;
        return {
          match,
          text: chat.messages.map((message) => `${message.role.toUpperCase()} (${message.at}): ${message.content}`).join('\n\n'),
        };
      }));
      const retrieved = excerpts.filter((item): item is NonNullable<typeof item> => item !== null);
      if (retrieved.length > 0) {
        pastChatBlock = [
          '## Earlier conversation explicitly referenced by the user',
          'These are matching passages read directly from saved Athena chats, not topic-related notes. Use them as the source of truth for what was previously discussed. Prefer the exchange that directly answers the user’s reference. Do not substitute a related note or invent what the earlier discussion said. If the passages do not identify one clear conversation or do not contain enough detail, say so and ask rather than guessing.',
          ...retrieved.map(({ match, text }) =>
            `### [${match.title}](${match.href})${match.fromThink ? ' (started from Think)' : ''}\n${text}`),
        ].join('\n\n');
        if (used !== undefined) {
          for (const { match } of retrieved) {
            if (!used.found.some((source) => source.id === match.sessionId)) {
              used.found.push({
                id: match.sessionId, kind: 'chat', title: match.title, url: match.href,
              });
            }
          }
        }
      }
    }
  }
  const activeProjectId = sessionId !== undefined ? await getSessionProjectId(db, sessionId) : null;
  let diagramBlock = '';
  if (openDiagram !== null) {
    try {
      const result = await findDiagramContext(db, {
        diagramId: openDiagram.id,
        excludedIds: excluded,
        ...(pageContext?.selectedId !== undefined ? { selectedId: pageContext.selectedId } : {}),
      });
      const diagram = result.results.find(item => !excluded.has(item.id));
      diagramBlock = diagram === undefined
        ? 'The open diagram is excluded or unavailable. Do not infer its contents from its title.'
        : `${DIAGRAM_READING_GUIDANCE}\nSaved diagram in view (primary evidence; not unsaved editor changes):\n${JSON.stringify(diagram)}`;
    } catch (err) {
      console.error('[diagram] context failed:', err);
      diagramBlock = 'The open diagram could not be loaded. Tell the user; use read_diagram to retry, and do not claim to have seen its contents.';
    }
  }
  // Learned standing instructions + liked examples for this persona/project.
  const standingBlock = await buildStandingInstructionsBlock(db, { persona, projectId: activeProjectId })
    .catch((err: unknown) => { console.error('[memory] could not load standing instructions:', err); return ''; });
  // A pasted M365 Copilot meeting list is saved as today's IBM diary before Athena replies.
  let meetingImportNote = '';
  hooks.signal?.throwIfAborted();
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
  const clock = ukClock();
  const dateBlock = `Current UK date: ${clock.day}. Use get_today_schedule to read today's meetings when needed.`;
  const mapBlock = mapId !== undefined && openCanvas === null && pageContext?.type === 'canvas'
    ? `The open canvas (ID ${mapId}) could not be loaded. Tell the user and do not infer contents from its title. For a diagram, read_diagram can retry.`
    : openDiagram !== null ? [
    `## Diagram in view: "${openDiagram.title}"`,
    diagramBlock,
  ].join('\n') : mapOutlineResult === null ? '' : [
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
    used.auto = context.ragItems.slice(0, RAG_USED_LIMIT).map((item) => ({ id: item.id, kind: item.source === 'note' ? 'note' : 'item', title: item.title, url: item.url ?? null }));
    used.outputs = (outputsBlock.match(/^### /gm) ?? []).length;
    used.decisions = (decisionsBlock.match(/^- /gm) ?? []).length;
    used.screens = (screensBlock.match(/^### /gm) ?? []).length;
  }
  const sheetsBlock = spreadsheetsBlock(hooks.codeFiles?.names ?? []);
  const peopleBlock = await buildPeopleContext(db, [userMessage]);
  const localFolders = toolContext.localFolders ?? [];
  const systemExtras = [hooks.noOutputsPanel === true ? NO_OUTPUTS_PANEL_NOTE : '', hooks.referenceBlock ?? '', standingBlock, peopleBlock, dateBlock, meetingImportNote, mapBlock, pastChatBlock, decisionsBlock, outputsBlock, screensBlock, sheetsBlock, localFilesPrompt(localFolders)].filter((b) => b !== '').join('\n\n---\n\n');
  const safeHistory = await scrubExcludedHistory(db, history, excluded).catch(() => history.filter((m) => m.role !== 'assistant'));
  const baseMessages = await assembleMessages(context, safeHistory, userMessage, persona, pageContext, systemExtras);
  hooks.signal?.throwIfAborted();
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

  const client = getFoundryClient('chat').scoped({ persona, sessionId });
  hooks.onActivity?.('Loading tools');
  const allTools = [...await getToolDefinitions(), ...(localFolders.length > 0 ? LOCAL_FILE_TOOLS : [])];
  hooks.signal?.throwIfAborted();
  const briefOnly = isImagineDemoBriefRequest(persona, userMessage);
  const specificationOnly = isDemoSpecificationRequest(userMessage);
  const noteOpen = toolContext.noteId !== undefined && toolContext.noteId !== '' && !toolContext.noteId.startsWith('doc:') && mapId === undefined;
  // The note-edit and map-edit tools are the two largest definitions (about 1,400 tokens between them) and
  // only make sense with a note or canvas open, so they are not sent otherwise.
  // Specialised groups (diagram drawing, Discover admin) are only sent when this turn or the last
  // few messages point at them: fewer, more relevant tools make tool choice more accurate.
  const focusedTools = focusTools(allTools, {
    userMessage,
    recentText: history.slice(-TOOL_FOCUS_HISTORY_MESSAGES).map((message) => message.content).join('\n'),
    hasOpenDiagram: openDiagram !== null,
    knowledgeOrchestration: isKnowledgeOrchestrationEnabled(),
  });
  const tools = (hooks.readOnlyTools === true ? focusedTools.filter((t) => !WRITE_TOOLS.has(t.function.name)) : focusedTools)
    .filter((t) => !specificationOnly || !WRITE_TOOLS.has(t.function.name) || t.function.name === DEMO_SPECIFICATION_WRITE_TOOL)
    .filter((t) => specificationOnly || !briefOnly || !WRITE_TOOLS.has(t.function.name) || t.function.name === 'save_output')
    .filter((t) => hooks.noOutputsPanel !== true || t.function.name !== 'save_output')
    .filter((t) => t.function.name !== 'propose_note_edit' || noteOpen)
    .filter((t) => t.function.name !== 'propose_map_changes' || mapOutlineResult !== null);
  const runtimeCapabilities = [
    '## Current chat runtime capabilities (authoritative for this turn)',
    `Persona: ${persona ?? 'general'}. ${hooks.readOnlyTools === true ? 'Read-only turn: mutation tools are withheld.' : 'Only the supplied tools can perform actions.'}`,
    `Editable note preview: ${tools.some(tool => tool.function.name === 'propose_note_edit') ? 'available; Richard must Apply to save' : 'unavailable in this turn'}.`,
    `Canvas change preview: ${tools.some(tool => tool.function.name === 'propose_map_changes') ? 'available; requires user application' : 'unavailable in this turn'}.`,
    `Outputs panel: ${hooks.noOutputsPanel === true ? 'not visible here; deliver content in the reply' : 'use supplied output tools if available'}.`,
    `Connected local folders: ${localFolders.length > 0 ? 'user-selected folders only, through supplied local-file tools' : 'none supplied; no local filesystem access'}.`,
    `Available action/read tool names: ${tools.map(tool => tool.function.name).join(', ')}.`,
    'The function schemas describe exact permissions and inputs. Withheld specialised tools are not executable ' +
      'in this turn; do not infer that the whole app lacks those features. No external search is needed to explain this runtime context.',
  ].join('\n');
  const systemMessage = messages.find(message => message.role === 'system');
  if (systemMessage !== undefined && typeof systemMessage.content === 'string') {
    systemMessage.content += `\n\n${runtimeCapabilities}`;
  }
  if (used !== undefined) used.initialSize = {
    systemChars: typeof systemMessage?.content === 'string' ? systemMessage.content.length : 0,
    historyChars: baseMessages.slice(1, -1).reduce((total, message) => total + message.content.length, 0),
    turnChars: baseMessages.at(-1)?.content.length ?? 0,
    toolSchemaChars: JSON.stringify(tools).length,
    outputsIndexChars: outputsBlock.length,
  };
  const requiredFirstTool = specificationOnly ? { type: 'function' as const, function: { name: 'get_demo_specification_template' } } : selectRequiredToolChoice(
    userMessage,
    tools,
    context.projectReferences,
    context.activeProjectName,
    noteOpen,
    mapOutlineResult !== null,
    openDiagram !== null,
  ) ?? (isKnowledgeOrchestrationEnabled() && (persona === undefined || persona === 'general') && !briefOnly
    ? selectKnowledgeRetrievalChoice(userMessage, tools)
    : undefined);
  // Asked to change the open note: she may need to write a lot (a full redraft, a long spec), so the
  // output budget is raised well above the chat default — otherwise a long edit is cut off mid-call.
  const editsOpenNote = requiredFirstTool !== undefined && typeof requiredFirstTool === 'object'
    && requiredFirstTool.function.name === 'propose_note_edit';
  const maxTokens = editsOpenNote || specificationOnly
    ? NOTE_EDIT_MAX_TOKENS
    : model === 'reasoning' ? AI_REASONING_MODEL_MAX_TOKENS : AI_CHAT_MAX_TOKENS;
  let editRescued = false;
  let nextRoundTool: LlmToolChoice | undefined;

  // Reasoning-model turns that also call tools can take long enough,
  // round after round, that the frontend's own request timeout fires first
  // — leaving the user staring at a confusing client-side "timed out"
  // message while the backend is still (slowly) working. Track a wall-clock
  // budget across the whole loop so a round that can't realistically finish
  // in time is never started, and clamp each round's own request timeout to
  // whatever's left so we always have time to return a clear message.
  const turnStart = Date.now();
  const turnBudgetMs = hooks.budgetMs ?? AI_CONVERSATION_TURN_BUDGET_MS;
  // Knowledge orchestration (flagged): evidence ledger, retrieval budgets and citation validation. Off = previous path.
  const orchestrated = isKnowledgeOrchestrationEnabled();
  const ledger = orchestrated ? createLedger() : undefined;
  const transcriptReview = isTranscriptReviewRequest(userMessage);
  const budget = orchestrated
    ? new TurnBudget(hooks.signal, transcriptReview ? TRANSCRIPT_REVIEW_BUDGET : undefined)
    : undefined;
  let citationRepairs = 0;
  const FOUND_OPEN_RESERVE_ROUNDS = 2;
  let openedFound = false;
  let retrievalRan = false;
  let deterministicRan = false;
  let deterministicComplete = true;
  let toolErrorCount = 0;

  // Show Notes saves seven deliverables in three batches after one round of link checks, so it gets more rounds.
  const maxRounds = persona === 'podcast_show_notes' ? SHOW_NOTES_MAX_TOOL_ITERATIONS
    : transcriptReview ? Math.max(AI_MAX_TOOL_ITERATIONS, TRANSCRIPT_REVIEW_BUDGET.maxModelRounds)
      : AI_MAX_TOOL_ITERATIONS;
  for (let i = 0; i < maxRounds; i++) {
    if (isStopped(hooks)) throw new AiStoppedError();
    hooks.onActivity?.(i === 0 ? 'Thinking' : 'Reading what I found');
    const remainingBudgetMs = turnBudgetMs - (Date.now() - turnStart);
    const budgetLow = i > 0 && remainingBudgetMs < AI_MIN_TOOL_ROUND_BUDGET_MS;
    if (budgetLow && remainingBudgetMs < AI_WRAP_UP_ROUND_MIN_MS) {
      console.warn(`[ai] Stopping tool loop after ${i} round(s) — turn budget exhausted`);
      const proposed = toolContext.noteEdits?.length ?? 0;
      if (proposed > 0) {
        return `There ${proposed === 1 ? 'is 1 proposed edit' : `are ${proposed} proposed edits`} available in the preview. ` +
          'The time limit was reached before I could finish checking the complete request. These are not saved changes: ' +
          'review the preview and Apply or Discard it before requesting further edits. Do not repeat the original request, ' +
          'as that could duplicate the proposals.';
      }
      return 'The time limit was reached before I could finish. I cannot confirm that the whole request is complete. ' +
        'Check the recorded results before continuing from the unfinished step, rather than repeating the original request.';
    }
    // Out of rounds or time after tools have already run (and may have changed things): one last round with
    // tools off, so she reports what she actually did rather than a canned "couldn't finish".
    const wrapUp = i > 0 && (budgetLow || i === maxRounds - 1);
    if (wrapUp) {
      console.warn(`[ai] Wrapping up tool loop after ${i} round(s)${budgetLow ? ' — turn budget low' : ' — round limit'}`);
      messages.push({ role: 'user', content: WRAP_UP_INSTRUCTION });
    }

    const roundToolChoice: LlmToolChoice = wrapUp ? 'none' : nextRoundTool ?? (i === 0 && requiredFirstTool !== undefined ? requiredFirstTool : 'auto');
    nextRoundTool = undefined;
    const roundTimeoutMs = Math.max(remainingBudgetMs, AI_MIN_TOOL_ROUND_BUDGET_MS);
    // Streams when someone is following live, or when a specific deployment is chosen (only the streaming call takes one).
    const response = hooks.onDelta !== undefined || hooks.modelRoute !== undefined
      ? await client.chatWithToolsStream(model, messages, tools, maxTokens, roundToolChoice, roundTimeoutMs, hooks.onDelta ?? NOT_FOLLOWED_LIVE, hooks.signal, hooks.modelRoute, {
        ...(hooks.codeFiles !== undefined && hooks.codeFiles.ids.length > 0 && {
          builtInTools: [{ type: 'code_interpreter', container: { type: 'auto', file_ids: hooks.codeFiles.ids } }],
        }),
        ...(hooks.onActivity !== undefined && { onActivity: hooks.onActivity }),
      })
      : await client.chatWithTools(model, messages, tools, maxTokens, roundToolChoice, roundTimeoutMs);

    if (wrapUp && response.toolCalls.length > 0) {
      return "I ran out of steps before I could finish. Some of it may already be done — ask me to check what's in place and carry on from there.";
    }
    if (response.toolCalls.length === 0) {
      // Asked to edit the open note but nothing was proposed: she wrote the content into the reply, or her
      // edit call failed and she carried on as if it hadn't. One retry with the edit forced; if that fails
      // too, say so plainly rather than let her claim an edit that doesn't exist.
      if (editsOpenNote && (toolContext.noteEdits?.length ?? 0) === 0 && response.content !== null && response.content.trim() !== ''
        && (response.content.length > PASTED_EDIT_REPLY_CHARS || /\b(propos|apply|preview)/i.test(response.content))) {
        if (!editRescued) {
          editRescued = true;
          hooks.onReset?.();
          hooks.onActivity?.('Putting that into a proposed edit');
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: 'No edit has been proposed to the note yet. Call propose_note_edit now with the content you wrote (replace_all for a complete redraft, or section by section for a long one — several calls are fine), then reply in one short line. Do not paste the content in your reply.',
          });
          const forced = tools.find((t) => t.function.name === 'propose_note_edit');
          if (forced !== undefined) nextRoundTool = { type: 'function', function: { name: 'propose_note_edit' } };
          continue;
        }
        return "I couldn't put that edit together — it was probably too large for one go. Try asking for it a section at a time (for example \"rewrite the Users section\"), and I'll propose each one for you to apply.";
      }
      if (response.content && response.content.trim() !== '') {
        if (ledger !== undefined && budget !== undefined) {
          // Found but never opened: read the top hit of each family before answering (once per turn).
          if (!openedFound && retrievalRan && !deterministicRan && !wrapUp && !budget.aborted && !budget.partial && i < maxRounds - FOUND_OPEN_RESERVE_ROUNDS) {
            const candidates = unreadFoundCandidates(ledger);
            if (candidates.length > 0) {
              openedFound = true;
              hooks.onReset?.();
              messages.push({ role: 'user', content: openFoundInstruction(candidates) });
              continue;
            }
          }
          let answerText = response.content;
          const decision = resolveAnswer(ledger, response.content, { repairsUsed: citationRepairs, canRepair: !wrapUp && !budget.aborted && i < maxRounds - 1 });
          if (used !== undefined) attachEvidence(used, ledger, budget.partial ? [budgetLimitation(budget)] : []);
          if (decision.action === 'repair') {
            citationRepairs++;
            hooks.onReset?.();
            messages.push({ role: 'user', content: decision.instruction });
            nextRoundTool = decision.mayOpen ? undefined : 'none';
            continue;
          }
          answerText = decision.answer;
          if (used !== undefined) attachEvidence(used, ledger, budget.partial ? [budgetLimitation(budget)] : []);
          const seenIds = collectIds(userMessage, ...history.map((m) => m.content), ...[...ledger.entries.values()].map((e) => e.ref.id), ...(used?.auto ?? []).map((s) => s.id), ...(used?.found ?? []).map((s) => s.id));
          const idsBeforeStrip = collectIds(answerText).size;
          answerText = stripUnseenIds(answerText, seenIds);
          const counts = ledgerCounts(ledger);
          const entries = [...ledger.entries.values()];
          // Counts and categories only: the answer text is inspected in memory and never stored.
          const auditRow: TurnAuditRow = {
            sessionId: sessionId ?? null, assistantMessageId: null, persona: persona ?? 'general',
            retrievalUsed: retrievalRan, deterministicPath: deterministicRan,
            found: counts.found, read: counts.read, cited: counts.cited,
            familiesRead: [...new Set(entries.filter((e) => e.state !== 'found').map((e) => e.ref.kind))],
            strippedIds: Math.max(0, idsBeforeStrip - collectIds(answerText).size),
            unverifiedQuotes: decision.action === 'partial' ? decision.invalid.filter((v) => v.problem === 'quote_mismatch').length : 0,
            repairsUsed: citationRepairs, abstained: looksAbstained(answerText),
            budgetExhausted: [...budget.exhausted], partial: budget.partial, toolErrorCount,
            unavailableSources: [...new Set(entries.filter((e) => !e.available).map((e) => e.ref.kind))],
            durationMs: Date.now() - turnStart, modelRounds: i + 1,
          };
          if (persona === undefined || persona === 'general') {
            if (hooks.onAudit !== undefined) hooks.onAudit(auditRow);
            else setImmediate(() => { void recordTurnAudit(db, auditRow); });
          }
          return finalizeKnowledgeAnswer(userMessage, answerText, { budget, counts, retrievalUsed: retrievalRan, deterministicPath: deterministicRan, deterministicComplete: deterministicComplete && !budget.partial });
        }
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

    messages.push({ role: 'assistant', content: null, tool_calls: response.toolCalls });
    // Any text streamed this round was a preamble to tool calls, not the answer.
    if (response.content !== null && response.content !== '') hooks.onReset?.();

    const roundImages: Array<{ label: string; url: string }> = [];
    for (const call of response.toolCalls) {
      let result: unknown;
      if (isStopped(hooks)) throw new AiStoppedError();
      onToolCall?.(call.function.name);
      hooks.onActivity?.(describeToolActivity(call.function.name, call.function.arguments));
      try {
        if ((briefOnly || specificationOnly || hooks.readOnlyTools === true) && !tools.some((tool) => tool.function.name === call.function.name)) {
          throw new Error(READ_ONLY_REFUSAL);
        }
        const gate = budget !== undefined && RETRIEVAL_TOOLS.has(call.function.name) ? budget.canStartRetrieval() : { ok: true as const };
        if (!gate.ok) {
          result = { partial: true, note: `${budgetLimitation(budget as TurnBudget)} Do not search again; answer from what was read and say not everything was checked.` };
        } else {
          const run = async (): Promise<unknown> => filterExcluded(
            await executeToolCall(db, call.function.name, call.function.arguments, activeProjectId ?? undefined, { sessionId, ...toolContext, excludedIds: excluded, exclusionsFailed, strictProjectId, signal: hooks.signal, mapAliases: mapOutlineResult?.aliases, mapCanvas: openMap ?? undefined }),
            excluded,
          );
          if (budget !== undefined && RETRIEVAL_TOOLS.has(call.function.name)) {
            retrievalRan = true;
            const timed = await budget.runRetrieval(run);
            result = timed.ok ? timed.value : { partial: true, note: budgetLimitation(budget) };
          } else {
            result = await run();
          }
          if (DETERMINISTIC_TOOLS.has(call.function.name)) {
            deterministicRan = true;
            deterministicComplete &&= isDeterministicResultComplete(result);
          }
          if (RECORD_TOOLS.has(call.function.name)) retrievalRan = true;
        }
      } catch (err) {
        result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
      }
      if (result !== null && typeof result === 'object' && 'error' in result) {
        toolErrorCount++;
        console.warn(`[ai] tool ${call.function.name} returned an error: ${String((result as { error: unknown }).error).slice(0, TOOL_ERROR_LOG_CHARS)}`);
      }
      // Pictures a tool captured (screenshots) go to the model as images, not as text.
      if (result !== null && typeof result === 'object' && '__images' in result) {
        const { __images, ...rest } = result as Record<string, unknown> & ToolImages;
        roundImages.push(...(__images ?? []));
        result = rest;
      }
      let toolContent = JSON.stringify(result);
      if (budget !== undefined && ledger !== undefined && RETRIEVAL_TOOLS.has(call.function.name)) {
        const admitted = budget.admitResult(result);
        result = admitted.result;
        toolContent = admitted.content;
      }
      // Only register evidence actually sent to the model, not a discarded oversized payload.
      if (used !== undefined) recordToolSources(used, call.function.name, result);
      if (ledger !== undefined) {
        recordToolEvidence(ledger, call.function.name, result, parseToolArgs(call.function.arguments));
        if (used !== undefined) attachEvidence(used, ledger);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
    }
    if (roundImages.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '[Screenshots you just captured — look at them and use them in your answer. This is not a new request from him.]' },
          ...roundImages.slice(0, MAX_ROUND_SCREENSHOTS).flatMap((img) => [
            { type: 'text' as const, text: img.label },
            { type: 'image_url' as const, image_url: { url: img.url, detail: 'high' as const } },
          ]),
        ],
      });
    }
  }

  return "I ran out of steps before I could finish. Some of it may already be done — ask me to check what's in place and carry on from there.";
}

const WRAP_UP_INSTRUCTION = '[System: no more tool calls are available this turn.] Reply now. Say plainly what you actually completed (based only on the tool results above — successes and failures), and what is still left to do, if anything. Do not claim anything the tool results do not show, and do not apologise for running out of steps.';

/**
 * Generates a short on-demand summary of a note's content, shown as a
 * "summary card" in the Think-embedded Athena panel when the user switches
 * to a note that has no chat started yet — gives them something useful to
 * look at instead of a blank composer.
 */
export async function summarizeNoteContent(title: string, content: string): Promise<string> {
  const client = getFoundryClient('note-summary');
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

  return client.chat('light', messages, NOTE_SUMMARY_MAX_TOKENS);
}

/**
 * Short sidebar title (3–6 words) for a chat, from its opening exchange.
 * Replaces the "first 60 characters of the first message" default, which
 * produced a sidebar full of chats called "hello".
 */
export async function generateSessionTitle(userMessage: string, reply: string): Promise<string> {
  const client = getFoundryClient('chat-title');
  return client.chat(
    'light',
    [
      {
        role: 'system',
        content:
          'Write a 3 to 6 word title for this chat, in sentence case, naming its actual topic. ' +
          'No quotes, no trailing punctuation, no words like "chat" or "conversation". ' +
          'If it is only a greeting with no topic, reply with exactly: Quick check-in',
      },
      { role: 'user', content: `User: ${userMessage.slice(0, TITLE_SOURCE_CHARS)}\n\nAssistant: ${reply.slice(0, TITLE_SOURCE_CHARS)}` },
    ],
    TITLE_MAX_TOKENS,
  );
}

/**
 * Generates a session summary by asking GPT-4o mini to summarise the
 * conversation. The summary is returned as markdown for blob storage.
 */
export async function summariseSession(
  history: ConversationMessage[],
): Promise<string> {
  const client = getFoundryClient('chat-summary');
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

  return client.chat('light', messages, SESSION_SUMMARY_MAX_TOKENS);
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
  const client = getFoundryClient('chat-rollup');
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

  return client.chat('light', messages, ROLLUP_MAX_TOKENS);
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
  const client = getFoundryClient('chat-to-think');
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

  const raw = await client.chat('light', messages, EXPORT_MAX_TOKENS);
  const separatorIndex = raw.indexOf(EXPORT_SEPARATOR);
  const titleLine = separatorIndex === -1 ? raw.split('\n')[0] ?? 'Athena export' : raw.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? raw : raw.slice(separatorIndex + EXPORT_SEPARATOR.length);

  const title = titleLine.replace(/^TITLE:\s*/i, '').trim() || 'Athena export';
  const bodyMarkdown = body.trim() || raw.trim();

  return { title, bodyMarkdown };
}
