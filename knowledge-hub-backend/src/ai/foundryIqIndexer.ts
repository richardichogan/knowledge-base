/**
 * Foundry IQ single-document indexer.
 *
 * scripts/foundryIqIndex.mjs handles the bulk backfill of content_items into
 * Azure AI Search. This module reuses the exact same embed+push logic for a
 * single row so newly-created content (e.g. a user's uploaded document) is
 * searchable immediately, instead of waiting for the next manual backfill.
 *
 * Best-effort: any failure here is logged and swallowed by the caller — a
 * user upload should still succeed (and be answerable in the current chat
 * turn via the injected context) even if the Search push fails.
 */

import { env } from '../config/env.js';
import type { ContentItem } from '../types/index.js';
import { embed } from './embeddings.js';

const SEARCH_API_VERSION = '2024-07-01';
const INDEX_NAME = 'kh-content-items';
/**
 * How much of the body feeds the embedding and the stored index document.
 * text-embedding-3-small accepts 8191 tokens, so ~8000 characters stays
 * comfortably inside a single embedding call while covering the bulk of a
 * typical note or transcript. The previous 2000 was set when note bodies were
 * raw BlockNote JSON and truncated most real prose out of the vector.
 */
const BODY_CHARS_FOR_EMBEDDING = 8000;

interface IndexingResult {
  key?: string;
  status?: boolean;
  statusCode?: number;
  errorMessage?: string | null;
}

interface IndexingResponse {
  value?: IndexingResult[];
}


/** True when both Foundry IQ Search and the embedding model are configured. */
export function canIndexToFoundryIq(): boolean {
  return Boolean(
    env.FOUNDRY_IQ_SEARCH_ENDPOINT && env.FOUNDRY_IQ_SEARCH_ADMIN_KEY && env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY,
  );
}

/**
 * Pushes a single content_items row into the Azure AI Search index so it's
 * immediately retrievable via search_knowledge_base, mirroring the schema
 * `foundryIqIndex.mjs --backfill` uses.
 */
export async function indexContentItem(item: ContentItem): Promise<void> {
  if (!canIndexToFoundryIq()) return;

  const embedInput = `${item.title}\n${item.summary}\n${(item.body || '').substring(0, BODY_CHARS_FOR_EMBEDDING)}`;
  const contentVector = await embed(embedInput);

  const doc = {
    '@search.action': 'mergeOrUpload',
    id: item.id,
    source: item.source,
    title: item.title,
    summary: item.summary,
    body: (item.body || '').substring(0, BODY_CHARS_FOR_EMBEDDING),
    url: item.url ?? '',
    projectContext: item.projectContext,
    tags: item.tags ?? [],
    publishedAt: new Date(item.publishedAt).toISOString(),
    contentVector,
  };

  const url = `${env.FOUNDRY_IQ_SEARCH_ENDPOINT}/indexes/${INDEX_NAME}/docs/index?api-version=${SEARCH_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.FOUNDRY_IQ_SEARCH_ADMIN_KEY ?? '' },
    body: JSON.stringify({ value: [doc] }),
  });
  if (!res.ok) {
    throw new Error(`Foundry IQ index push failed: ${res.status} ${await res.text()}`);
  }

  // Azure AI Search returns HTTP 200 for a batch request even when an
  // individual document in that batch failed. Treat an absent or unsuccessful
  // item result as an error so callers never mark a failed push as indexed.
  const result = (await res.json()) as IndexingResponse;
  const itemResult = result.value?.[0];
  if (itemResult?.status !== true) {
    const detail = itemResult?.errorMessage ?? 'missing item-level indexing result';
    throw new Error(
      `Foundry IQ index push failed for ${item.id}: ${itemResult?.statusCode ?? 'unknown'} ${detail}`,
    );
  }
}
