import type { Pool } from 'pg';
import { getProjectContextItems, getRagItems } from '../db/queries.js';
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
 * Retrieves the most relevant indexed content items for a given query
 * using PostgreSQL full-text search. Used to build RAG context per turn.
 */
export async function retrieveRagItems(db: Pool, query: string, projectContext?: string): Promise<ContentItem[]> {
  const projectId = projectContext?.trim() ?? '';
  if (!query.trim() || isLowSignalMessage(query)) {
    return projectId !== '' ? getProjectContextItems(db, projectId, RAG_ITEMS_LIMIT) : [];
  }

  const directMatches = await getRagItems(db, query, RAG_ITEMS_LIMIT, projectId !== '' ? projectId : undefined);
  if (projectId === '' || directMatches.length >= Math.min(3, RAG_ITEMS_LIMIT)) {
    return directMatches;
  }

  const overviewItems = await getProjectContextItems(db, projectId, RAG_ITEMS_LIMIT);
  const seen = new Set(directMatches.map((item) => item.id));
  return [
    ...directMatches,
    ...overviewItems.filter((item) => !seen.has(item.id)),
  ].slice(0, RAG_ITEMS_LIMIT);
}

/**
 * Formats RAG items into a text block suitable for injection into a
 * system or user message. Keeps token usage bounded.
 *
 * Explicitly labelled as auto-retrieved background context — the model must
 * never treat this as something the user typed or pasted themselves.
 */
export function formatRagContext(items: ContentItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const lines = items.map((item, index) => {
    const date = item.publishedAt.substring(0, 10);
    const url = item.url ? ` (${item.url})` : '';
    return [
      `[${index + 1}] ${item.source.toUpperCase()} — ${date}${url}`,
      `Title: ${item.title}`,
      `Summary: ${item.summary}`,
      item.body ? `Content: ${item.body.substring(0, 400)}${item.body.length > 400 ? '...' : ''}` : '',
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
    '',
    lines.join('\n\n---\n\n'),
  ].join('\n');
}
