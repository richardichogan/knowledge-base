/**
 * ai/contextUsage.ts — what a reply drew on (the "Used:" line under it), and
 * the per-chat "Don't use this" list that keeps items out of searches and
 * auto-retrieval for the rest of the chat.
 */
import type { Pool } from 'pg';

export interface UsedSource {
  id: string;
  /** note | document | item (synced content) | node (knowledge graph) */
  kind: string;
  title: string;
  url?: string | null;
}

export interface ContextUsed {
  project: string | null;
  /** Standing instructions and liked examples applied. */
  instructions: number;
  /** The document / screen / comparison in view, if any. */
  inView: string | null;
  /** Found by her searches this turn. */
  found: UsedSource[];
  /** Retrieved automatically as background. */
  auto: UsedSource[];
  outputs: number;
  decisions: number;
  screens: number;
}

export function emptyContextUsed(): ContextUsed {
  return { project: null, instructions: 0, inView: null, found: [], auto: [], outputs: 0, decisions: 0, screens: 0 };
}

const MAX_SOURCES = 25;

function push(list: UsedSource[], s: UsedSource): void {
  if (s.id === '' || list.some((x) => x.id === s.id) || list.length >= MAX_SOURCES) return;
  list.push(s);
}

/** Records the items a search tool returned. */
export function recordToolSources(used: ContextUsed, toolName: string, result: unknown): void {
  if (typeof result !== 'object' || result === null) return;
  const r = result as { results?: unknown; documents?: unknown };
  if ((toolName === 'search_diagrams' || toolName === 'read_diagram') && Array.isArray(r.results)) {
    for (const item of r.results as Array<{ id?: string; title?: string; url?: string }>) {
      push(used.found, { id: item.id ?? '', kind: 'diagram', title: item.title ?? 'Untitled diagram', url: item.url ?? null });
    }
  } else if (toolName === 'search_knowledge_base' && Array.isArray(r.results)) {
    for (const item of r.results as Array<{ id?: string; source?: string; title?: string; url?: string | null }>) {
      push(used.found, { id: item.id ?? '', kind: item.source === 'note' ? 'note' : 'item', title: item.title ?? 'Untitled', url: item.url ?? null });
    }
  } else if (toolName === 'search_library' && Array.isArray(r.documents)) {
    for (const d of r.documents as Array<{ id?: string; title?: string; url?: string }>) {
      push(used.found, { id: d.id ?? '', kind: 'document', title: d.title ?? 'Untitled', url: d.url !== '' ? d.url ?? null : null });
    }
  }
}

/** Removes excluded items from a search tool's result before Athena sees it. */
export function filterExcluded(result: unknown, excluded: Set<string>): unknown {
  if (excluded.size === 0 || typeof result !== 'object' || result === null) return result;
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  for (const key of ['results', 'documents']) {
    const list = r[key];
    if (Array.isArray(list)) {
      const kept = (list as Array<{ id?: string }>).filter((x) => x.id === undefined || !excluded.has(x.id));
      out[key] = kept;
      if ('resultCount' in r) out['resultCount'] = kept.length;
    }
  }
  return out;
}

export async function getExcludedSources(db: Pool, sessionId: string): Promise<UsedSource[]> {
  const { rows } = await db.query<{ excluded_sources: UsedSource[] | null }>(
    `SELECT excluded_sources FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.excluded_sources ?? [];
}

export async function excludeSource(db: Pool, sessionId: string, source: UsedSource): Promise<UsedSource[]> {
  const current = await getExcludedSources(db, sessionId);
  const next = current.some((s) => s.id === source.id) ? current : [...current, { id: source.id, kind: source.kind, title: source.title, url: source.url ?? null }];
  await db.query(
    `INSERT INTO ai_chat_sessions (id, excluded_sources) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET excluded_sources = EXCLUDED.excluded_sources`,
    [sessionId, JSON.stringify(next)],
  );
  return next;
}

export async function includeSource(db: Pool, sessionId: string, sourceId: string): Promise<UsedSource[]> {
  const next = (await getExcludedSources(db, sessionId)).filter((s) => s.id !== sourceId);
  await db.query(`UPDATE ai_chat_sessions SET excluded_sources = $2 WHERE id = $1`, [sessionId, JSON.stringify(next)]);
  return next;
}
