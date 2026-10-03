import { isCopilotImport, COPILOT_IMPORT_CAUTION } from './copilotImport.js';
import type { Pool } from 'pg';
import { getProjectContextItems, getLibraryRagItems } from '../db/queries.js';
import { getKnowledgeBaseItems } from './chatTools.js';
import { RAG_ITEMS_LIMIT } from '../config/constants.js';
import type { ContentItem } from '../types/contentItem.js';

/**
 * Messages that are too short/generic to search meaningfully. Running FTS on
 * these (especially the single-common-word OR-fallback in getRagItems) tends
 * to surface essentially random, unrelated content — which then gets glued
 * onto the user's message with no framing, making the model think the user
 * supplied that content. Skip retrieval entirely for these rather than risk
 * injecting noise.
 */
const LOW_SIGNAL_MESSAGES = new Set([
  'thanks', 'thank you', 'thanks!', 'thank you!', 'ok', 'okay', 'cool', 'great', 'nice', 'perfect',
  'yes', 'no', 'yep', 'yup', 'nope', 'sure', 'sure?', 'are you sure', 'are you sure?', 'like', 'like.',
  'got it', 'sounds good', 'awesome', 'good', 'good.', 'right', 'correct', 'yep.', 'ok.', 'okay.',
]);

/** A message is low-signal if it's on the stoplist, or just too short (<=2 words) to carry search intent. */
export function isLowSignalMessage(query: string): boolean {
  const normalised = query.trim().toLowerCase();
  if (normalised === '') return true;
  if (LOW_SIGNAL_MESSAGES.has(normalised)) return true;
  const wordCount = normalised.split(/\s+/).filter(Boolean).length;
  return wordCount <= 2 && normalised.length <= 12;
}

/**
 * Retrieves the most relevant indexed content items for a given query, via
 * getKnowledgeBaseItems — which merges Postgres full-text search (covers
 * everything in content_items, including notes) with Foundry IQ semantic
 * search (catches paraphrased/semantically-related documents that literal
 * FTS misses, e.g. "approved LLM list" vs. a note phrased as "model
 * governance constraints"). Used to build the auto-RAG context per turn.
 */
export async function retrieveRagItems(db: Pool, query: string, projectContext?: string): Promise<ContentItem[]> {
  const projectId = projectContext?.trim() ?? '';
  if (!query.trim() || isLowSignalMessage(query)) {
    return projectId !== '' ? getProjectContextItems(db, projectId, RAG_ITEMS_LIMIT) : [];
  }

  const [general, library] = await Promise.all([
    getKnowledgeBaseItems(db, query, RAG_ITEMS_LIMIT, projectId),
    getLibraryRagItems(db, query, RAG_LIBRARY_SLOTS, projectId === '' ? undefined : projectId)
      .catch(() => [] as ContentItem[]),
  ]);
  // Reserve up to RAG_LIBRARY_SLOTS for Library documents, interleaved with
  // the general results so both share the content budget in formatRagContext.
  const seen = new Set<string>();
  const libraryPicks = library.filter((i) => !seen.has(i.id) && (seen.add(i.id), true));
  const generalPicks = general
    .filter((i) => !seen.has(i.id) && (seen.add(i.id), true))
    .slice(0, Math.max(0, RAG_ITEMS_LIMIT - libraryPicks.length));
  const merged: ContentItem[] = [];
  for (let k = 0; k < Math.max(generalPicks.length, libraryPicks.length); k++) {
    if (k < generalPicks.length) merged.push(generalPicks[k]!);
    if (k < libraryPicks.length) merged.push(libraryPicks[k]!);
  }
  return merged;
}

// Automatic-context slots reserved for Library documents (PRDs, specs, ADRs).
const RAG_LIBRARY_SLOTS = 4;

// Per-item and total content passed to the model from auto-retrieved items.
// Was a flat 400 chars from the start of each item, so a retrieved PRD or long
// note contributed its opening lines rather than the section that answered.
const RAG_ITEM_CONTENT_CHARS = 1_500;
const RAG_TOTAL_CONTENT_CHARS = 12_000;
const RAG_PASSAGE_CHARS = 500;

const EXCERPT_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'with', 'that', 'this', 'from', 'have', 'has', 'you', 'your', 'what',
  'which', 'who', 'how', 'why', 'when', 'where', 'can', 'could', 'would', 'should', 'about', 'into', 'any',
  'there', 'their', 'them', 'they', 'our', 'out', 'not', 'but', 'all', 'also', 'its', 'it’s', 'did', 'does',
  'tell', 'give', 'show', 'please', 'anything', 'something', 'thing', 'things',
]);

/**
 * The passages of `body` that best match `query`, up to `maxChars`, in their
 * original order. Scores ~500-char passages by query-term hits (rarer terms
 * count more); falls back to the opening when nothing matches.
 */
export function relevantExcerpt(body: string, query: string, maxChars: number): string {
  const text = body.replace(/\s+\n/g, '\n').trim();
  if (text.length <= maxChars) return text;

  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .filter((t) => !EXCERPT_STOPWORDS.has(t)))];
  if (terms.length === 0) return `${text.slice(0, maxChars)}…`;

  // Passages on paragraph/sentence boundaries, merged up to ~RAG_PASSAGE_CHARS.
  const pieces = text.split(/(?<=[.!?])\s+|\n{2,}/);
  const passages: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length + piece.length > RAG_PASSAGE_CHARS && current !== '') {
      passages.push(current);
      current = '';
    }
    current = current === '' ? piece : `${current} ${piece}`;
  }
  if (current !== '') passages.push(current);

  const lower = passages.map((p) => p.toLowerCase());
  const docFreq = new Map(terms.map((t) => [t, lower.filter((p) => p.includes(t)).length]));
  const scored = lower.map((p, i) => {
    let score = 0;
    for (const t of terms) {
      const df = docFreq.get(t) ?? 0;
      if (df > 0 && p.includes(t)) score += 1 / df; // rarer terms weigh more
    }
    return { i, score };
  });
  if (scored.every((s) => s.score === 0)) return `${text.slice(0, maxChars)}…`;

  const chosen: number[] = [];
  let used = 0;
  for (const { i, score } of [...scored].sort((a, b) => b.score - a.score)) {
    if (score === 0) break;
    const len = passages[i]!.length + 3;
    if (used + len > maxChars) continue;
    chosen.push(i);
    used += len;
  }
  return chosen
    .sort((a, b) => a - b)
    .map((i, k, arr) => (k > 0 && i !== arr[k - 1]! + 1 ? `… ${passages[i]!}` : passages[i]!))
    .join(' ');
}

/**
 * Formats RAG items into a text block suitable for injection into a
 * system or user message. Keeps token usage bounded.
 *
 * Explicitly labelled as auto-retrieved background context — the model must
 * never treat this as something the user typed or pasted themselves.
 */
export function formatRagContext(items: ContentItem[], query = ''): string {
  if (items.length === 0) {
    return '';
  }

  // Share a total budget across items in rank order, so the best matches get
  // their most relevant passages rather than every item getting its opening.
  let remaining = RAG_TOTAL_CONTENT_CHARS;
  const lines = items.map((item, index) => {
    const date = item.publishedAt.substring(0, 10);
    const url = item.url ? ` (${item.url})` : '';
    const budget = Math.min(RAG_ITEM_CONTENT_CHARS, remaining);
    const excerpt = item.body && budget > 200 ? relevantExcerpt(item.body, query, budget) : '';
    remaining -= excerpt.length;
    return [
      `[${index + 1}] ${item.source.toUpperCase()} — ${date}${url}`,
      `Title: ${item.title}`,
      isCopilotImport(item.title) ? COPILOT_IMPORT_CAUTION : '',
      `Summary: ${item.summary}`,
      excerpt ? `Relevant content: ${excerpt}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    '## Auto-retrieved background context (system-generated, NOT written or pasted by the user)',
    'This is a best-effort full-text search match against the knowledge hub, run automatically for every ' +
      'message using only what the user actually typed — it is independent of and separate from any ' +
      '"Document in view" block above. It may be irrelevant to what the user actually said below — use it ' +
      'only if it genuinely helps answer their message, and never present it as being part of, or evidence ' +
      'about, a different document already provided to you. Never claim the user provided, pasted, or ' +
      'attached this content, and never refer to it in your reply as "snippets", "background context", or ' +
      'similar meta-language — synthesize it into your actual answer as if you simply knew it.',
    'It is optional reference, never the subject: do not summarise, review or describe these items unless his ' +
      'message asks about them. A word match is not relevance (e.g. "clouds" matching a podcast called "Cloudy"). ' +
      'If his message does not need them, ignore them completely and just answer what he asked.',
    '',
    lines.join('\n\n---\n\n'),
  ].join('\n');
}
