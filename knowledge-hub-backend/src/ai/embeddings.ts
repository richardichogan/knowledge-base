/**
 * Shared Azure OpenAI embeddings helper — used by foundryIqIndexer.ts (whole
 * document indexing into Azure AI Search) and contextBuilder.ts (semantic
 * excerpt selection for long documents currently in view). Kept as a single
 * module so both call sites share the same deployment/endpoint config and
 * batching behaviour instead of duplicating the fetch logic.
 */

import { env } from '../config/env.js';

const EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
const EMBEDDING_API_VERSION = '2024-06-01';

/** True when the Azure OpenAI embedding deployment is configured. */
export function isEmbeddingConfigured(): boolean {
  return Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY);
}

/**
 * Embeds a batch of texts in a single request (Azure OpenAI's embeddings
 * endpoint accepts an `input` array natively) and returns vectors in the
 * same order as the input.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(
    `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${EMBEDDING_API_VERSION}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.AZURE_OPENAI_API_KEY ?? '' },
      body: JSON.stringify({ input: texts }),
    },
  );
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  const byIndex = new Map(data.data.map((d) => [d.index, d.embedding]));
  return texts.map((_, i) => {
    const embedding = byIndex.get(i);
    if (!embedding) throw new Error(`Embedding response missing vector for input ${String(i)}`);
    return embedding;
  });
}

/** Embeds a single text — convenience wrapper around embedBatch. */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  if (!vector) throw new Error('Embedding response contained no vector');
  return vector;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
