/**
 * jobs/inferredEdgeJob.ts
 * Nightly job — creates thematically_related edges using GPT-4o-mini.
 *
 * For each node modified in the past 7 days, fetches up to 30 candidate nodes
 * from the past 90 days and asks the AI which are meaningfully related.
 * Caps inferred edges at 5 per source node per run.
 */
import type { Pool } from 'pg';
import { FoundryClient } from '../ai/foundryClient.js';
import { upsertEdge } from '../services/edgeService.js';
import { JOB_DB_CONCURRENCY } from '../config/constants.js';

const RECENT_MODIFIED_DAYS = 7;
const CANDIDATE_LOOKBACK_DAYS = 90;
const MAX_CANDIDATES = 30;
const MAX_EDGES_PER_NODE = 5;
const SUMMARY_MAX_CHARS = 500;
const MIN_CONFIDENCE = 0.5;
const AI_MAX_TOKENS = 800;
const MS_PER_DAY = 86_400_000;

interface NodeRow {
  id: string;
  ref_id: string;
  ref_type: string;
  title: string;
}

interface AiRelatedResponse {
  related: Array<{ candidate_id: string; confidence: number; reason: string }>;
}

/**
 * Runs the nightly inferred edge job.
 * All errors are logged, never thrown.
 */
export async function runInferredEdgeJob(db: Pool): Promise<void> {
  try {
    const recentCutoff = new Date(Date.now() - RECENT_MODIFIED_DAYS * MS_PER_DAY).toISOString();
    const candidateCutoff = new Date(Date.now() - CANDIDATE_LOOKBACK_DAYS * MS_PER_DAY).toISOString();

    const sources = await db.query<NodeRow>(
      `SELECT id, ref_id, ref_type, title FROM nodes WHERE updated_at >= $1`,
      [recentCutoff],
    );

    const client = new FoundryClient();

    for (const source of sources.rows) {
      try {
        await processNode(db, client, source, candidateCutoff);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[InferredEdgeJob] Error on node ${source.id}:`, msg);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[InferredEdgeJob] Fatal error:', msg);
  }
}

async function processNode(
  db: Pool,
  client: FoundryClient,
  source: NodeRow,
  candidateCutoff: string,
): Promise<void> {
  const sourceSummary = await getNodeSummary(db, source);

  // Fetch candidates: nodes from the lookback window with no existing edge to source
  const candidates = await db.query<NodeRow>(
    `SELECT n.id, n.ref_id, n.ref_type, n.title
     FROM nodes n
     WHERE n.created_at >= $1
       AND n.id != $2
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE (e.source_node_id = $2 AND e.target_node_id = n.id)
            OR (e.source_node_id = n.id AND e.target_node_id = $2)
       )
     ORDER BY n.created_at DESC
     LIMIT $3`,
    [candidateCutoff, source.id, MAX_CANDIDATES],
  );
  if (candidates.rows.length === 0) return;

  // Resolve summaries in small bounded batches. Firing all 30 candidate reads
  // at once checked out more pool clients than live API traffic could spare,
  // which starved the pool and 500'd every route. Cap concurrency so the job
  // always leaves connections free.
  const candidateList: Array<{ id: string; title: string; type: string; summary: string }> = [];
  for (let i = 0; i < candidates.rows.length; i += JOB_DB_CONCURRENCY) {
    const batch = candidates.rows.slice(i, i + JOB_DB_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (c) => ({
        id: c.id,
        title: c.title,
        type: c.ref_type,
        summary: await getNodeSummary(db, c),
      })),
    );
    candidateList.push(...resolved);
  }

  const userMsg = JSON.stringify({
    source: { title: source.title, type: source.ref_type, summary: sourceSummary },
    candidates: candidateList,
  });

  const raw = await client.chat('gpt-4o-mini', [
    {
      role: 'system',
      content: `You are a thematic relationship analyst. Given a source content item and a list of candidate items from a personal knowledge hub, identify which candidates are meaningfully related to the source — not by surface keyword match but by underlying intellectual connection. Return only candidates where the relationship would be useful to surface to the user.\n\nReturn ONLY valid JSON. No preamble, no explanation, no markdown fences.\n\nFormat:\n{\n  "related": [\n    {\n      "candidate_id": "uuid-from-input",\n      "confidence": 0.0,\n      "reason": "One sentence explaining the connection."\n    }\n  ]\n}\n\nConfidence scoring:\n- 0.8–1.0: Strong intellectual connection.\n- 0.5–0.79: Useful adjacency.\n- Below 0.5: Do not include.`,
    },
    { role: 'user', content: userMsg },
  ], AI_MAX_TOKENS);

  const parsed = JSON.parse(raw) as AiRelatedResponse;
  const scored = parsed.related
    .filter((r) => r.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_EDGES_PER_NODE);

  for (const rel of scored) {
    const [src, tgt] = [source.id, rel.candidate_id].sort() as [string, string];
    await upsertEdge(db, src, tgt, 'thematically_related', rel.confidence, { reason: rel.reason });
  }
}

async function getNodeSummary(db: Pool, node: NodeRow): Promise<string> {
  try {
    if (node.ref_type === 'note') {
      const r = await db.query<{ content: string }>(
        `SELECT content FROM notes WHERE id = $1::uuid`, [node.ref_id],
      );
      return (r.rows[0]?.content ?? '').slice(0, SUMMARY_MAX_CHARS);
    }
    if (node.ref_type === 'spark') {
      const r = await db.query<{ body: string }>(
        `SELECT body FROM sparks WHERE id = $1::uuid`, [node.ref_id],
      );
      return r.rows[0]?.body ?? '';
    }
    if (node.ref_type === 'commit') {
      const r = await db.query<{ message: string }>(
        `SELECT message FROM timeline_items WHERE id = $1::uuid`, [node.ref_id],
      );
      return r.rows[0]?.message ?? '';
    }
  } catch {
    // Best-effort — return title as fallback
  }
  return node.title;
}
