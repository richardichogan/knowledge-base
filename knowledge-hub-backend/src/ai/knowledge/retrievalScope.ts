import type { ConversationMessage } from '../../types/aiContext.js';
import type { ContentSource } from '../../types/contentItem.js';
import { CONTENT_SOURCE_DISPOSITIONS } from './manifest.js';
import { explicitUtcInterval, parseRelativePhrase, resolveRelativeInterval } from '../../services/knowledge/intervalResolver.js';
import type { SearchFilter } from '../../services/knowledge/search.js';

const sourcesFor = (family: string): ContentSource[] =>
  (Object.keys(CONTENT_SOURCE_DISPOSITIONS) as ContentSource[]).filter(source => CONTENT_SOURCE_DISPOSITIONS[source].family === family);
const SHORT_FOLLOWUP_CHARS = 300;
const RECENT_USER_REQUESTS = 3;
const RANGE_BOUNDARIES = 2;
const DAY_MS = 86_400_000;
const DEFAULT_RECENT_DAYS = 7;

/** App vocabulary is distinct from graph entity kinds: an article and a note are both evidence, not interchangeable collections. */
export const RETRIEVAL_VOCABULARY = [
  { family: 'discover-article', aliases: 'Discover, discovery log/list/feed, Discover items', pattern: /\b(?:discover(?:y)?|article\s+discovery)\b/i,
    tool: 'search_knowledge_base', sources: sourcesFor('discover-article'), meaning: 'External articles in Discover; not notes, subscriptions or general web news.' },
  { family: 'note', aliases: 'Think notes, saved notes, meeting notes', pattern: /\b(?:notes?|think\s+notes?)\b/i,
    tool: 'search_knowledge_base', sources: sourcesFor('note'), meaning: 'Saved Think writing; an open note is reference context, not a restriction on unrelated requests.' },
  { family: 'library-document', aliases: 'Library, PDFs, uploaded documents', pattern: /\b(?:library|pdfs?|uploaded\s+(?:files?|documents?))\b/i,
    tool: 'search_knowledge_base', sources: sourcesFor('library-document'), meaning: 'Indexed imported documents/files; not Think notes or Discover articles.' },
  { family: 'chat', aliases: 'past chats, earlier conversations', pattern: /\b(?:(?:past|previous|earlier|saved|last)\s+(?:chats?|conversations?)|we\s+discussed)\b/i,
    tool: 'search_past_chats', sources: sourcesFor('chat'), meaning: 'Original saved conversations; indexed summaries are not verbatim exchanges.' },
  { family: 'task', aliases: 'tasks, to-dos, Plan board', pattern: /\b(?:tasks?|to-?dos?|plan\s+board)\b/i,
    tool: 'list_tasks', sources: sourcesFor('task'), meaning: 'Live task state; use structured task tools for exact counts, overdue and due-date queries.' },
  { family: 'decision', aliases: 'decision log, recorded decisions', pattern: /\b(?:decisions?|decided)\b/i,
    tool: 'review_decisions', sources: [], meaning: 'Recorded decisions with acceptance provenance, not any statement of intent.' },
  { family: 'canvas', aliases: 'diagrams, canvases, mind maps', pattern: /\b(?:diagrams?|canvases|mind\s+maps?)\b/i,
    tool: 'search_diagrams', sources: [], meaning: 'Saved editable structures; use search_diagrams/read_diagram, not screenshots or similarly titled notes.' },
  { family: 'watchlist', aliases: 'watchlists, competitor monitoring', pattern: /\bwatchlists?\b/i,
    tool: 'get_discover_watchlist_records', sources: [], meaning: 'Dated monitoring runs, findings and versioned baselines; not the article inbox.' },
  { family: 'discover-source', aliases: 'Discover sources, RSS/Atom feeds, subscriptions', pattern: /\b(?:rss|atom|subscriptions?)\b|\b(?:discover(?:y)?|feeds?)\b[\s\S]{0,80}\b(?:sources?|subscriptions?)\b|\b(?:sources?|soruces)\b[\s\S]{0,80}\b(?:discover(?:y)?|article\s+discovery)\b|\b(?:suggest|recommend|additional|configured|enabled|disabled|subscribe)\b[\s\S]{0,70}\bfeeds?\b/i,
    tool: 'get_discover_sources', sources: [], meaning: 'Configured feed subscriptions, including disabled feeds; not articles or project documents.' },
  { family: 'connected-activity', aliases: 'Activity, connected-system updates', pattern: /\b(?:activity|what['’]?s\s+new|what\s+is\s+new|what\s+(?:has\s+)?changed)\b/i,
    tool: 'search_knowledge_base', sources: Object.keys(CONTENT_SOURCE_DISPOSITIONS) as ContentSource[], meaning: 'Broad saved-hub updates when no narrower collection is named; not proof of the complete current remote system.' },
  { family: 'email', aliases: 'emails, mailbox', pattern: /\b(?:emails?|mailbox)\b/i,
    tool: 'search_knowledge_base', sources: ['email'], meaning: 'Indexed synced email, not the entire live mailbox.' },
] as const;

export type RetrievalFamily = (typeof RETRIEVAL_VOCABULARY)[number]['family'];
export interface RetrievalScope {
  families: RetrievalFamily[];
  tool: string;
  inherited: boolean;
  filter: SearchFilter;
  timeDefaulted: boolean;
}

export interface RetrievalAudit {
  families: RetrievalFamily[];
  inherited: boolean;
  dateField: SearchFilter['dateField'] | null;
  timeDefaulted: boolean;
  temporal: boolean;
  blockedCalls: number;
  deferredRecovery: boolean;
  documentReviews: number;
  documentReadChars: number;
  documentCheckpoints: number;
  resultSources: Record<string, number>;
}

export function createRetrievalAudit(scope?: RetrievalScope): RetrievalAudit {
  return { families: scope?.families ?? [], inherited: scope?.inherited ?? false, dateField: scope?.filter.dateField ?? null,
    timeDefaulted: scope?.timeDefaulted ?? false, temporal: scope?.filter.within !== undefined, blockedCalls: 0, deferredRecovery: false,
    documentReviews: 0, documentReadChars: 0, documentCheckpoints: 0, resultSources: {} };
}

/** A review signal, not a verdict: flag an inherited retry answered with permission to do that same lookup. */
export function flagDeferredRecovery(scope: RetrievalScope | undefined, answer: string): boolean {
  return scope?.inherited === true && /\bif\s+you\s+want\b[\s\S]{0,100}\b(?:check|search|look|read|retry|try)\b/i.test(answer);
}

export function isOutsideCollectionTool(name: string, scope?: RetrievalScope): boolean {
  if (scope === undefined || scope.tool === '') return false;
  if (scope.filter.sources === undefined) {
    return name !== scope.tool && ['search_knowledge_base', 'search_library', 'find_files', 'search_past_chats', 'search_diagrams', 'search_knowledge_graph'].includes(name);
  }
  return ['search_library', 'find_files', 'search_past_chats', 'read_past_chat', 'search_knowledge_graph',
    'search_diagrams', 'read_diagram', 'search_ica'].includes(name) || /tavily.*search/i.test(name);
}

const FOLLOWUP = /^\s*(?:(?:shall|can|could)\s+we\s+)?(?:try(?:\s+that)?\s+again|again|retry|what\s+about|how\s+about|only|just|includ(?:e|ing)|exclud(?:e|ing)|instead|no\b|not\b|those\b|these\b|the\s+(?:first|last|next)\b)/i;
const PERIOD = /\b(?:today|yesterday|tomorrow|(?:this|last|next)\s+(?:week|month))\b/i;
const TEMPORAL_REFINEMENT = /\b(?:\d{4}-\d{2}-\d{2}|(?:last|past)\s+\d+\s+days?|all\s+time)\b/i;
const RECENCY = /\b(?:latest|recent(?:ly)?|new(?:est)?|what['’]?s\s+new)\b/i;
const MUTATION = /\b(?:create|add|save|remember|update|delete|remove|draft|write|rewrite|schedule|send|rename|move|publish|formalising|formalizing)\b/i;
export const DISCOVER_STATES = ['to-review', 'saved', 'blog', 'published', 'shelved', 'archived'] as const;

function requestText(value: string): string {
  return value.replace(/^\[Viewing (?:note|canvas|document):[^\n]*\]\s*/i, '').replace(/\n\(Requested action[\s\S]*$/i, '');
}

function directFamilies(text: string): RetrievalFamily[] {
  const positive = text
    .replace(/\b(?:this|that|the\s+(?:open|current))\s+(?:note|document|diagram|canvas|transcript)\b/gi, '')
    .replace(/\b(?:not|excluding|exclude|rather than)\s+(?:the\s+)?(?:notes?|library|discover(?:y)?|emails?|sources?|subscriptions?|feeds?|watchlists?)\b/gi, '');
  const families = RETRIEVAL_VOCABULARY.filter(entry => entry.pattern.test(positive)).map(entry => entry.family);
  // Feed configuration and monitoring have dedicated meanings despite their shared Discover navigation.
  const specific = families.length > 1 ? families.filter(f => f !== 'connected-activity') : families;
  return specific.includes('discover-source') ? specific.filter(f => f !== 'discover-article')
    : specific.includes('watchlist') ? specific.filter(f => f !== 'discover-article') : specific;
}

export function resolveRetrievalScope(message: string, history: ConversationMessage[] = [], now = new Date()): RetrievalScope | undefined {
  const text = requestText(message);
  if (MUTATION.test(text) || /\b(?:who\s+are\s+you|your\s+(?:identity|capabilities|personality)|do\s+you\s+have\s+a\s+personality)\b/i.test(text)) return undefined;
  if (/\b(?:this|the\s+(?:open|current))\s+(?:note|document|diagram|canvas|transcript)\b/i.test(text)
    && !/\b(?:other|across|compare|find|search|latest|new|library|discover(?:y)?|past)\b/i.test(text)) return undefined;
  let families = directFamilies(text);
  let basis = text;
  let inherited = false;
  const refinements = [text];
  if (families.length === 0 && text.length < SHORT_FOLLOWUP_CHARS && (FOLLOWUP.test(text) || PERIOD.test(text) || TEMPORAL_REFINEMENT.test(text))) {
    const previous = history.filter(item => item.role === 'user').slice(-RECENT_USER_REQUESTS).reverse();
    for (const item of previous) {
      const prior = requestText(item.content);
      if (directFamilies(prior).length > 0) {
        families = directFamilies(prior); basis = `${prior}\n${[...refinements].reverse().join('\n')}`; inherited = true; break;
      }
      // Do not carry a collection across an intervening unrelated request.
      if (!FOLLOWUP.test(prior) && !PERIOD.test(prior) && !TEMPORAL_REFINEMENT.test(prior)) break;
      refinements.push(prior);
    }
  }
  if (families.length === 0) return undefined;
  const entries = RETRIEVAL_VOCABULARY.filter(entry => families.includes(entry.family));
  const contentOnly = entries.every(entry => entry.tool === 'search_knowledge_base');
  const filter: SearchFilter = {};
  const indexedEntries = entries.filter(entry => entry.tool === 'search_knowledge_base');
  if (indexedEntries.length > 0) filter.sources = [...new Set(indexedEntries.flatMap(entry => [...entry.sources]))];
  if (families.includes('discover-article')) {
    const positiveState = (value: string): string => value
      .replace(/\b(?:not|excluding|exclude)\s+(?:the\s+)?(?:saved|blog|published|archived|shelved)\b/gi, '')
      .replace(/\b(?:newly|recently)\s+published\b|\bpublished(?=\s+(?:today|yesterday|this|last|since|on|during|in\s+\d{4}))|\bblog(?=\s+posts?\b)/gi, '');
    const stateBasis = refinements.find(value => /\b(?:to-review|saved|blog|published|shelved|archived|all\s+states|everything|parked|parking)\b/i.test(positiveState(value))
      || /\b(?:not|excluding|exclude)\s+(?:the\s+)?(?:saved|blog|published|archived|shelved)\b/i.test(value)) ?? basis;
    const state = DISCOVER_STATES.find(value => new RegExp(`\\b${value}\\b`, 'i').test(positiveState(stateBasis)));
    const including = stateBasis.match(/\bincluding\s+(archived|shelved|saved|published|blog)\b/i);
    filter.states = /\b(?:all\s+states|everything)\b/i.test(stateBasis) ? [...DISCOVER_STATES]
      : including !== null ? ['to-review', including[1]!.toLowerCase()] : [state ?? 'to-review'];
    filter.parkedOnly = /\b(?:parked|parking\s+(?:lot|pool))\b/i.test(stateBasis);
    if (filter.parkedOnly && state === undefined) filter.states = [...DISCOVER_STATES];
  }
  const timeText = refinements.find(value => PERIOD.test(value) || TEMPORAL_REFINEMENT.test(value)) ?? basis;
  const period = timeText.match(PERIOD)?.[0];
  const recent = RECENCY.test(timeText);
  const dates = [...timeText.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
  const trailing = timeText.match(/\b(?:last|past)\s+(\d{1,2})\s+days?\b/i);
  if (filter.sources === undefined) return { families, tool: entries.length === 1 ? entries[0]!.tool : '', inherited, filter, timeDefaulted: false };
  if (dates.length === RANGE_BOUNDARIES) filter.within = explicitUtcInterval(dates[0]!, dates[1]!);
  else if (dates.length === 1 && /\bsince\b/i.test(timeText)) filter.within = explicitUtcInterval(dates[0]!, now.toISOString());
  else if (dates.length === 1 && /\bon\b/i.test(timeText)) {
    const end = new Date(`${dates[0]}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    filter.within = explicitUtcInterval(dates[0]!, end.toISOString());
  }
  else if (period !== undefined) {
    const kind = parseRelativePhrase(period.toLowerCase());
    if (kind !== null) filter.within = resolveRelativeInterval(kind, now);
  } else if (trailing !== null && Number(trailing[1]) > 0 && contentOnly) {
    filter.within = explicitUtcInterval(new Date(now.getTime() - Number(trailing[1]) * DAY_MS).toISOString(), now.toISOString());
  } else if (recent && contentOnly) {
    filter.within = explicitUtcInterval(new Date(now.getTime() - DEFAULT_RECENT_DAYS * DAY_MS).toISOString(), now.toISOString());
  }
  const dateBasis = refinements.find(value => /\b(?:published|publication|discovered|imported|added|ingested|updated|changed|edited)\b/i.test(value)) ?? basis;
  filter.dateField = /\b(?:discovered|imported|added|ingested)\b/i.test(dateBasis) && families.includes('discover-article')
    ? 'discovered' : families.includes('connected-activity') || families.includes('email') || /\b(?:updated|changed|edited)\b/i.test(dateBasis) ? 'updated' : 'published';
  return { families, tool: contentOnly ? 'search_knowledge_base' : entries.length === 1 ? entries[0]!.tool : '',
    inherited, filter, timeDefaulted: recent && period === undefined && dates.length === 0 && trailing === null && contentOnly };
}

export const RETRIEVAL_DICTIONARY = [
  '## App collections and retrieval contract',
  ...RETRIEVAL_VOCABULARY.map(entry => `${entry.aliases}: ${entry.meaning} Entry point: ${entry.tool}.${entry.sources.length > 0 ? ` Indexed sources: ${entry.sources.join(', ')}.` : ''}`),
  'Explicit collections are boundaries, not search keywords. Do not search the word "log" across notes when asked about the discovery log.',
  'For browsing a collection, search_knowledge_base accepts an empty query plus sources; supply topic words only when there is a topic. Search terms must not be "interesting", "latest", or the collection name.',
  'publishedAt is the stored source publication/creation timestamp; publicationDateKnown=false means ingestion supplied a fallback, not verified publication. discoveredAt is first discovery, indexedAt is last indexing and is never first discovery. lastActivityAt is source activity, not publication.',
  'Interesting does not mean recent. New/latest without a period defaults to a disclosed trailing seven days. Relative calendar periods use Europe/London; explicit start/end ranges are UTC, start included and end excluded.',
  'Never silently widen a collection, date window or state after no results. Report the applied scope and sparse/partial coverage. A ranked sample is not an exhaustive list or the exact order of the Discover UI.',
  'Resolve short corrections against recent USER requests, not an assistant’s mistaken topic. Complete already-requested read-only work without another "if you want". Explicit topic changes override old scope.',
  'Use concise paraphrases and your reasoned judgement for recommendations. Quote only exact text actually read; do not pad answers with repeated "the record says".',
].join('\n');

export class RetrievalScopeError extends Error {}

/** Model arguments may narrow, never erase server-derived collection/time/state constraints. */
export function resolveSearchFilter(args: Record<string, unknown>, scope?: RetrievalScope, now = new Date()): SearchFilter {
  const filter: SearchFilter = { ...scope?.filter };
  const allowedSources = Object.keys(CONTENT_SOURCE_DISPOSITIONS);
  for (const field of ['sources', 'states'] as const) {
    const value = args[field];
    if (value === undefined) continue;
    const allowed: readonly string[] = field === 'sources' ? allowedSources : DISCOVER_STATES;
    if (!Array.isArray(value) || value.length === 0 || value.some(v => typeof v !== 'string' || !allowed.includes(v))) {
      throw new RetrievalScopeError(`${field} must be a nonempty list of recognised values.`);
    }
    const requested = value as string[];
    const existing = filter[field];
    filter[field] = existing === undefined ? requested : existing.filter(v => requested.includes(v));
  }
  if (filter.sources?.includes('discovered-article') && filter.states === undefined) filter.states = ['to-review'];
  const field = args['dateField'];
  if (field !== undefined && !['published', 'discovered', 'updated'].includes(String(field))) throw new RetrievalScopeError('Unknown dateField.');
  if (scope === undefined && (field === 'published' || field === 'discovered' || field === 'updated')) filter.dateField = field;
  if (args['within'] !== undefined) {
    const within = args['within'];
    if (typeof within !== 'object' || within === null) throw new RetrievalScopeError('within must be a period or start/end object.');
    const range = within as Record<string, unknown>;
    const kind = typeof range['period'] === 'string' ? parseRelativePhrase(range['period']) : null;
    const parsed = kind !== null ? resolveRelativeInterval(kind, now)
      : typeof range['start'] === 'string' && typeof range['end'] === 'string' ? explicitUtcInterval(range['start'], range['end']) : undefined;
    if (parsed === undefined) throw new RetrievalScopeError('within needs a supported period or explicit start and end; no unbounded fallback.');
    if (filter.within === undefined) filter.within = parsed;
    else {
      const start = [parsed.startUtc, filter.within.startUtc].sort().at(-1)!;
      const end = [parsed.endUtc, filter.within.endUtc].sort()[0]!;
      if (start >= end) throw new RetrievalScopeError('Requested window does not overlap the user’s time boundary.');
      filter.within = explicitUtcInterval(start, end);
    }
  }
  return filter;
}
