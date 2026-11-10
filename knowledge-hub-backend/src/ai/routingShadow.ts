import { env } from '../config/env.js';
import type { ChatPageContext, ConversationMessage } from '../types/aiContext.js';
import { deferredTurnTraceRecorder } from './turnTrace.js';

/**
 * Shadow routing: Microsoft Decision-1 predicts which capability families a chat turn needs and
 * whether it authorises a saved change. The prediction is only recorded in the turn trace and
 * compared with the tools the main model actually used during trace review. It never alters the turn.
 */
const SHADOW_VERSION = 'decision-1-shadow-v3';
const TIMEOUT_MS = 8_000;
const PREDICT_THRESHOLD = 0.5;
/** Confidence above which a turn is moved to the background straight away. */
const LONG_TASK_THRESHOLD = 0.7;
const MESSAGE_CHARS = 1_500;
const HISTORY_CHARS = 500;

export const ROUTING_FAMILIES = {
  knowledge: 'Search or read saved notes, records, tags and their relationships',
  library: 'Search uploaded library documents such as PDFs, decks and specs',
  past_chats: 'Search or read earlier Athena conversations',
  diagrams: 'Find, read, create or change diagrams',
  tasks: 'Read or change Plan tasks, work items, progress reviews or deliverables',
  calendar: 'Read today\'s schedule, meetings or email',
  discover: 'Discover feeds, sources, watchlists, articles and digests',
  web: 'Fetch a web page or search the internet',
  note_edit: 'Change the open note or canvas, or create a new note draft or spark',
  design: 'Design packages, use cases, specifications, build specs or readiness',
  podcast: 'Podcast scripts, campaigns or episode material',
  publishing: 'Publishing feeds, scheduled jobs or automation',
  memory: 'Save or forget a standing instruction or preference',
  handoff: 'Hand the job to a background specialist agent instead of doing it inside this chat answer: combining, consolidating or reviewing many documents, deep multi-source research, or long writing that cannot be finished within one answer; not needed for a quick lookup or a single short document',
  decisions: 'Look up the decisions and assumptions recorded in the Decisions area; not needed when a decision is merely discussed or being drafted in the open note',
} as const;
export type RoutingFamily = keyof typeof ROUTING_FAMILIES;

const FAMILY_RULES: Array<[RoutingFamily, RegExp]> = [
  ['handoff', /^hand_off_to_specialist$|^check_specialist_jobs$|^check_workforce_assignments$/],
  ['podcast', /podcast/],
  ['publishing', /publish|scheduled_jobs/],
  ['discover', /discover|digest|watchlist/],
  ['design', /design|use_case|build_spec|demo_specification|readiness/],
  ['diagrams', /diagram/],
  ['decisions', /decision/],
  ['memory', /^(?:remember|forget_memory)$/],
  ['past_chats', /past_chat/],
  ['library', /library/],
  ['calendar', /schedule|calendar|meeting|email/],
  ['web', /^fetch_web_page$|tavily|web_search|microsoft_docs/],
  ['note_edit', /propose_note_edit|read_note_layout|propose_map_changes|create_note_draft|update_note|create_spark|script_visuals|save_output/],
  ['tasks', /task|work_content|deliverable|progress_review|content_plan/],
  ['knowledge', /knowledge|note_tags|relationship|read_output/],
];

/** The capability family a tool belongs to; undefined for tools outside the predicted families. */
export function toolFamily(name: string): RoutingFamily | undefined {
  const lower = name.toLowerCase();
  return FAMILY_RULES.find(([, pattern]) => pattern.test(lower))?.[0];
}

interface ShadowInput {
  userMessage: string;
  history: ConversationMessage[];
  pageContext?: ChatPageContext | undefined;
  persona?: string | undefined;
  /** Called when the turn looks like a long job, so it can run in the background at once. */
  onLongTask?: (() => void) | undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shadowState(input: ShadowInput): string {
  const recent = input.history.slice(-4).map(message => ({ role: message.role, content: clip(message.content, HISTORY_CHARS) }));
  return JSON.stringify({
    latestUserMessage: clip(input.userMessage, MESSAGE_CHARS),
    recentConversation: recent,
    openItem: input.pageContext ? { type: input.pageContext.type, title: input.pageContext.title ?? null } : null,
    persona: input.persona ?? 'general',
  });
}

function shadowQuestions(): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [family, description] of Object.entries(ROUTING_FAMILIES)) {
    questions[`needs_${family}`] = {
      type: 'noul',
      instructions: `To answer or act on the latest user message, does the assistant need this capability: ${description}?`,
    };
  }
  questions['authorises_edit'] = {
    type: 'noul',
    instructions: 'Does the latest user message, read with the recent conversation, authorise creating or changing saved content?',
    criteria: { true: 'Explicitly asks for, or approves, a save, edit, creation or deletion', false: 'Discussion, a question, opinion or review only' },
  };
  questions['long_task'] = {
    type: 'noul',
    instructions: 'Will doing what the latest user message asks take the assistant more than about 20 seconds, so it is better done as a background task while the chat carries on?',
    criteria: {
      true: 'Several edits across a long note or document, reading or comparing several documents, research, restructuring, or long writing',
      false: 'A greeting, a quick question, a short answer, a single small edit or a lookup',
    },
  };
  questions['turn_mode'] = {
    type: 'choice',
    instructions: 'What kind of turn is the latest user message?',
    criteria: {
      answer: 'Asks a question to be answered',
      explore: 'Thinking aloud or asking for an opinion',
      deliver: 'Asks for a result to be produced or changed',
      correction: 'Corrects the assistant',
      follow_up: 'Answers the assistant\'s previous question',
    },
  };
  return questions;
}

interface DecisionAnswer { noul?: number; choice?: string; confidence?: number }

/**
 * Starts the shadow prediction without delaying the turn. The result is written to the turn trace
 * whenever it arrives, even after the reply has been sent.
 */
export function startRoutingShadow(input: ShadowInput): void {
  const endpoint = env.DECISION1_ENDPOINT;
  const apiKey = env.DECISION1_API_KEY;
  if (!endpoint || !apiKey) return;
  const record = deferredTurnTraceRecorder() ?? (input.onLongTask ? async () => undefined : null);
  if (!record) return;
  const startedAt = Date.now();
  void (async () => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ model: env.DECISION1_DEPLOYMENT, state: shadowState(input), questions: shadowQuestions() }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null) as { answers?: Record<string, DecisionAnswer>; usage?: unknown; error?: { message?: string } } | null;
      if (!response.ok || !body?.answers) {
        await record('routing.shadow', { version: SHADOW_VERSION, status: 'error', latencyMs: Date.now() - startedAt,
          reason: body?.error?.message ?? `HTTP ${response.status}` });
        return;
      }
      const families = Object.fromEntries(Object.keys(ROUTING_FAMILIES)
        .map(family => [family, Number(body.answers?.[`needs_${family}`]?.noul ?? 0)]));
      const longTask = Number(body.answers['long_task']?.noul ?? 0);
      if (longTask >= LONG_TASK_THRESHOLD) input.onLongTask?.();
      const mode = body.answers['turn_mode'];
      await record('routing.shadow', {
        version: SHADOW_VERSION, status: 'ok', latencyMs: Date.now() - startedAt, threshold: PREDICT_THRESHOLD,
        families, authorisesEdit: Number(body.answers['authorises_edit']?.noul ?? 0),
        longTask, turnMode: mode?.choice ?? null, turnModeConfidence: mode?.confidence ?? null, usage: body.usage ?? null,
      });
    } catch (error) {
      await record('routing.shadow', { version: SHADOW_VERSION, status: 'error', latencyMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    }
  })();
}

interface ReviewEvent { sequence: number; kind: string; payload: unknown }
export interface RoutingShadowCheck {
  criterion: 'routing_shadow'; verdict: 'pass' | 'uncertain'; reason: string; evidenceSequences: number[];
}

/** Compares the recorded Decision-1 prediction with the tools the main model actually called. */
export function reviewRoutingShadow(events: ReviewEvent[]): RoutingShadowCheck {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  const shadow = events.find(event => event.kind === 'routing.shadow');
  if (!shadow) return { criterion: 'routing_shadow', verdict: 'uncertain', evidenceSequences: [],
    reason: 'No Decision-1 shadow prediction was recorded for this turn (not configured, timed out before capture, or an older trace).' };
  const prediction = object(shadow.payload);
  if (prediction.status !== 'ok') return { criterion: 'routing_shadow', verdict: 'uncertain', evidenceSequences: [shadow.sequence],
    reason: `Decision-1 shadow call failed: ${String(prediction.reason ?? 'unknown error')}.` };
  const threshold = typeof prediction.threshold === 'number' ? prediction.threshold : PREDICT_THRESHOLD;
  const scores = object(prediction.families);
  const predicted = new Set(Object.entries(scores).filter(([, p]) => typeof p === 'number' && p >= threshold).map(([family]) => family));
  const writeTools = new Set<string>();
  const called = new Set<string>();
  const evidence = [shadow.sequence];
  for (const event of events) {
    const payload = object(event.payload);
    if (event.kind === 'capability.catalog' && Array.isArray(payload.capabilities)) {
      for (const capability of payload.capabilities.map(object)) if (capability.write === true && typeof capability.name === 'string') writeTools.add(capability.name);
    }
    if (event.kind === 'tool.result' && typeof payload.name === 'string' && payload.name !== 'load_tools') {
      called.add(payload.name);
      evidence.push(event.sequence);
    }
  }
  // Traces recorded before a family existed carry no score for it, so it cannot count as a miss.
  const actual = new Set<string>([...called].map(toolFamily).filter((family): family is RoutingFamily => family !== undefined && family in scores));
  const missed = [...actual].filter(family => !predicted.has(family));
  const extra = [...predicted].filter(family => !actual.has(family));
  const predictedEdit = typeof prediction.authorisesEdit === 'number' && prediction.authorisesEdit >= threshold;
  const actualEdit = [...called].some(name => writeTools.has(name));
  const percent = (value: unknown): string => typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a';
  const summary = `Decision-1 predicted [${[...predicted].join(', ') || 'none'}], edit ${percent(prediction.authorisesEdit)}, mode ${String(prediction.turnMode ?? 'n/a')}; `
    + `the main model used [${[...actual].join(', ') || 'none'}]${actualEdit ? ' including a write' : ', no write'}.`;
  const agrees = missed.length === 0 && extra.length === 0 && predictedEdit === actualEdit;
  return {
    criterion: 'routing_shadow', verdict: agrees ? 'pass' : 'uncertain', evidenceSequences: evidence,
    reason: agrees ? `Shadow routing agreed. ${summary}`
      : `Shadow routing disagreed${missed.length ? `; missed ${missed.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}`
        + `${predictedEdit !== actualEdit ? `; edit ${predictedEdit ? 'predicted but not made' : 'made but not predicted'}` : ''}. ${summary} `
        + 'A disagreement is a review signal: either router may be wrong.',
  };
}
