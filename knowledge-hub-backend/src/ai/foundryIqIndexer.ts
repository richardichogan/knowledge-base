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
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../config/constants.js';

const SEARCH_API_VERSION = '2024-07-01';
const INDEX_NAME = 'kh-content-items';
const DELETE_BATCH_SIZE = 500;
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

export async function deleteIndexedContentItems(ids: string[]): Promise<void> {
  if (!env.FOUNDRY_IQ_SEARCH_ENDPOINT || !env.FOUNDRY_IQ_SEARCH_ADMIN_KEY || ids.length === 0) return;
  for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DELETE_BATCH_SIZE);
    const response = await fetch(`${env.FOUNDRY_IQ_SEARCH_ENDPOINT}/indexes/${INDEX_NAME}/docs/index?api-version=${SEARCH_API_VERSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.FOUNDRY_IQ_SEARCH_ADMIN_KEY },
      body: JSON.stringify({ value: batch.map(id => ({ '@search.action': 'delete', id })) }),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Foundry IQ deletion failed: ${response.status} ${await response.text()}`);
    const result = await response.json() as IndexingResponse;
    if (result.value?.length !== batch.length || result.value.some(item => item.status !== true)) {
      throw new Error('Foundry IQ deletion failed for one or more documents.');
    }
  }
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

const PASSAGE_INDEX_NAME = 'kh-content-passages';
const PASSAGE_EMBED_BATCH = 16;

/** Sources whose full text is chunked into the passage index. */
export const PASSAGE_INDEXED_SOURCES: ReadonlySet<string> = new Set([
  'user-upload', 'github-doc', 'github-content-store', 'onedrive-document', 'ica-document', 'note',
]);

export class PassageIndexError extends Error {
  constructor(readonly failedKeys: string[]) {
    super(`Passage indexing failed for ${failedKeys.length} document(s)`);
    this.name = 'PassageIndexError';
  }
}

/** Per-item results: a batch-level HTTP 200 with any failed item is a failure (never "indexed"). */
export function assertAllPassagesIndexed(expectedKeys: string[], response: IndexingResponse): void {
  const byKey = new Map((response.value ?? []).map(r => [r.key, r.status === true]));
  const failed = expectedKeys.filter(key => byKey.get(key) !== true);
  if (failed.length > 0) throw new PassageIndexError(failed);
}

export interface PassageIndexDeps {
  embedBatch(texts: string[]): Promise<number[][]>;
  post(indexName: string, actions: Record<string, unknown>[]): Promise<IndexingResponse>;
}

const defaultPassageDeps: PassageIndexDeps = {
  embedBatch: async texts => (await import('./embeddings.js')).embedBatch(texts),
  async post(indexName, actions) {
    const res = await fetch(`${env.FOUNDRY_IQ_SEARCH_ENDPOINT}/indexes/${indexName}/docs/index?api-version=${SEARCH_API_VERSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.FOUNDRY_IQ_SEARCH_ADMIN_KEY ?? '' },
      body: JSON.stringify({ value: actions }),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Foundry IQ passage push failed: ${res.status}`);
    return (await res.json()) as IndexingResponse;
  },
};

export interface PassageIndexOutcome {
  /** ordinal -> chunk hash now present in the index */
  indexed: Map<number, string>;
  staleOrdinals: number[];
  embedded: number;
  skipped: number;
}

/**
 * Chunks the item, embeds only passages whose hash changed, pushes them and
 * deletes stale ones. Throws (so the caller leaves the item not indexed) if
 * any passage fails.
 */
export async function indexItemPassages(
  item: Pick<ContentItem, 'id' | 'source' | 'title' | 'body' | 'projectContext'>,
  previousHashes: ReadonlyMap<number, string>,
  deps: PassageIndexDeps = defaultPassageDeps,
): Promise<PassageIndexOutcome> {
  const { chunkText, planChunks } = await import('../services/knowledge/chunking.js');
  const chunks = chunkText(item.id, item.body || '');
  const plan = planChunks(chunks, previousHashes);
  const indexed = new Map<number, string>();
  for (const chunk of chunks) if (previousHashes.get(chunk.ordinal) === chunk.hash) indexed.set(chunk.ordinal, chunk.hash);

  for (let i = 0; i < plan.toEmbed.length; i += PASSAGE_EMBED_BATCH) {
    const batch = plan.toEmbed.slice(i, i + PASSAGE_EMBED_BATCH);
    const vectors = await deps.embedBatch(batch.map(c => `${item.title}\n${c.headingPath.join(' > ')}\n${c.text}`));
    if (vectors.length !== batch.length) throw new PassageIndexError(batch.map(c => c.id));
    const response = await deps.post(PASSAGE_INDEX_NAME, batch.map((c, n) => ({
      '@search.action': 'mergeOrUpload',
      id: c.id, parentId: item.id, ordinal: c.ordinal, startOffset: c.startOffset, endOffset: c.endOffset,
      headingPath: c.headingPath, version: c.version, title: item.title, content: c.text,
      projectContext: item.projectContext, source: item.source, contentVector: vectors[n],
    })));
    assertAllPassagesIndexed(batch.map(c => c.id), response);
    for (const c of batch) indexed.set(c.ordinal, c.hash);
  }

  if (plan.staleOrdinals.length > 0) {
    const keys = plan.staleOrdinals.map(o => `${item.id}_${o}`);
    assertAllPassagesIndexed(keys, await deps.post(PASSAGE_INDEX_NAME, keys.map(id => ({ '@search.action': 'delete', id }))));
  }
  return { indexed, staleOrdinals: plan.staleOrdinals, embedded: plan.toEmbed.length, skipped: plan.unchanged.length };
}

/** Removes every passage of a parent (used for deletions). */
export async function deleteItemPassages(
  parentId: string, ordinals: number[], deps: PassageIndexDeps = defaultPassageDeps,
): Promise<void> {
  if (ordinals.length === 0) return;
  const keys = ordinals.map(o => `${parentId}_${o}`);
  assertAllPassagesIndexed(keys, await deps.post(PASSAGE_INDEX_NAME, keys.map(id => ({ '@search.action': 'delete', id }))));
}
