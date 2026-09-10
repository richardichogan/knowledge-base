/**
 * Foundry IQ client — thin wrapper around the Azure AI Search agentic
 * retrieval REST API (`/knowledgeBases/{name}/retrieve`), used as the
 * retrieval backend for search_knowledge_base in place of Postgres FTS.
 *
 * Azure AI Search does the query decomposition, hybrid (vector + keyword)
 * search, and semantic reranking internally; we only need the ranked
 * `references[].docKey` list back out (each docKey is the content_items.id
 * the document was indexed under — see scripts/foundryIqIndex.mjs), which we
 * then hydrate from Postgres for the full row (see getContentItemsByIds).
 */

import { env } from '../config/env.js';

const API_VERSION = '2026-08-01-preview';

interface FoundryIqReference {
  docKey?: string;
  rerankerScore?: number;
}

interface FoundryIqRetrieveResponse {
  references?: FoundryIqReference[];
}

/** True when Foundry IQ is configured for this environment. */
export function isFoundryIqEnabled(): boolean {
  return Boolean(env.FOUNDRY_IQ_SEARCH_ENDPOINT && env.FOUNDRY_IQ_SEARCH_ADMIN_KEY);
}

/**
 * Retrieves the top-ranked content_items ids for a query via Foundry IQ.
 * Returns ids in descending rerankerScore order, deduplicated. Throws on any
 * HTTP/network failure — callers should catch and fall back to Postgres FTS
 * rather than surface a hard error to the user.
 */
export async function retrieveContentItemIds(query: string, limit: number): Promise<string[]> {
  if (!isFoundryIqEnabled()) throw new Error('Foundry IQ is not configured');

  const url =
    `${env.FOUNDRY_IQ_SEARCH_ENDPOINT}/knowledgebases('${encodeURIComponent(env.FOUNDRY_IQ_KNOWLEDGE_BASE)}')` +
    `/retrieve?api-version=${API_VERSION}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.FOUNDRY_IQ_SEARCH_ADMIN_KEY! },
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Foundry IQ retrieve failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as FoundryIqRetrieveResponse;
  const seen = new Set<string>();
  const ranked = (data.references ?? [])
    .filter((ref): ref is Required<Pick<FoundryIqReference, 'docKey'>> & FoundryIqReference =>
      typeof ref.docKey === 'string' && ref.docKey !== '')
    .sort((a, b) => (b.rerankerScore ?? 0) - (a.rerankerScore ?? 0));

  const ids: string[] = [];
  for (const ref of ranked) {
    if (seen.has(ref.docKey)) continue;
    seen.add(ref.docKey);
    ids.push(ref.docKey);
    if (ids.length >= limit) break;
  }
  return ids;
}
