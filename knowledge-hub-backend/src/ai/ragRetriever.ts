import type { Pool } from 'pg';
import { getRagItems } from '../db/queries.js';
import { RAG_ITEMS_LIMIT } from '../config/constants.js';
import type { ContentItem } from '../types/contentItem.js';

/**
 * Retrieves the most relevant indexed content items for a given query
 * using PostgreSQL full-text search. Used to build RAG context per turn.
 */
export async function retrieveRagItems(db: Pool, query: string): Promise<ContentItem[]> {
  if (!query.trim()) {
    return [];
  }
  return getRagItems(db, query, RAG_ITEMS_LIMIT);
}

/**
 * Formats RAG items into a text block suitable for injection into a
 * system or user message. Keeps token usage bounded.
 */
export function formatRagContext(items: ContentItem[]): string {
  if (items.length === 0) {
    return 'No relevant content found in the knowledge index for this query.';
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

  return `## Relevant content from your knowledge hub\n\n${lines.join('\n\n---\n\n')}`;
}
