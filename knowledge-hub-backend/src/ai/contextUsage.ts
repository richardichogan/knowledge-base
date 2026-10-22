/**
 * ai/contextUsage.ts — what a reply drew on (the "Used:" line under it), and
 * the per-chat "Don't use this" list that keeps items out of searches and
 * auto-retrieval for the rest of the chat.
 */
import type { Pool } from 'pg';
import { noteFound, noteRead, summariseLedger, type EvidenceLedger, type EvidenceSummary } from './knowledge/evidence.js';

export interface UsedSource {
  id: string;
  /** note | document | item (synced content) | node (knowledge graph) */
  kind: string;
  title: string;
  url?: string | null;
  /** Found → Read → Cited; present only when knowledge orchestration is on. */
  lifecycle?: 'found' | 'read' | 'cited';
  /** False when the record was deleted or could not be opened. */
  available?: boolean;
}

export interface UsedWarning {
  message: string;
  sourceId?: string;
  family?: string;
}

export interface ContextUsed {
  /** Honest limits for this turn (budget, partial reads, unavailable targets). */
  warnings?: UsedWarning[];
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
  /** Found/Read/Cited lifecycle for this turn; present only when knowledge orchestration is on. */
  evidence?: EvidenceSummary;
  /** Character counts for the initial model request, not token estimates or source contents. */
  initialSize?: {
    systemChars: number;
    historyChars: number;
    turnChars: number;
    toolSchemaChars: number;
    outputsIndexChars: number;
  };
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
  if (toolName === 'traverse_relationships') recordTraversalSources(used, result);
  else if ((toolName === 'search_diagrams' || toolName === 'read_diagram') && Array.isArray(r.results)) {
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

const SEARCH_TOOLS = new Set(['search_diagrams', 'search_knowledge_base', 'search_library', 'search_past_chats', 'search_knowledge_graph', 'traverse_relationships']);
const READ_TOOLS = new Set(['read_diagram', 'read_output', 'read_past_chat']);

/** Feeds the evidence ledger: search hits are Found; opened records are Read. */
export function recordToolEvidence(ledger: EvidenceLedger, toolName: string, result: unknown): void {
  if (typeof result !== 'object' || result === null || 'error' in result) return;
  const r = result as Record<string, unknown>;
  const kind = toolName.includes('diagram') ? 'diagram' : toolName.includes('library') ? 'document' : toolName.includes('chat') ? 'chat' : toolName.includes('output') ? 'output' : 'item';
  const list = Array.isArray(r['results']) ? r['results'] : Array.isArray(r['documents']) ? r['documents'] : [];
  const rows = list as Array<{ id?: string; title?: string; url?: string | null; version?: string; content?: string; updatedAt?: string; projectId?: string | null }>;
  if (SEARCH_TOOLS.has(toolName)) {
    for (const x of rows) {
      if (typeof x.id !== 'string' || x.id === '') continue;
      const rowKind = toolName === 'traverse_relationships' ? (x as { type?: string }).type ?? kind : kind;
      noteFound(ledger, { kind: rowKind, id: x.id }, { title: x.title ?? null, locator: x.url ?? null, projectId: x.projectId ?? null });
    }
  } else if (READ_TOOLS.has(toolName)) {
    const id = typeof r['id'] === 'string' ? r['id'] : rows[0]?.id;
    if (typeof id === 'string' && id !== '') {
      const text = typeof r['content'] === 'string' ? r['content'] : JSON.stringify(r);
      noteRead(ledger, { kind, id }, { title: typeof r['title'] === 'string' ? r['title'] : null, text });
    }
  }
}

/** Adds the traversal tool's targets to the Found list (they are unread until opened). */
function recordTraversalSources(used: ContextUsed, result: unknown): void {
  const list = (result as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return;
  for (const x of list as Array<{ id?: string; type?: string; title?: string }>) {
    push(used.found, { id: x.id ?? '', kind: x.type === 'note' ? 'note' : 'item', title: x.title ?? 'Untitled' });
  }
}

/** Copies the ledger lifecycle onto the source payload and adds warnings; additive to existing fields. */
export function attachEvidence(used: ContextUsed, ledger: EvidenceLedger, warnings: string[] = []): void {
  const summary = summariseLedger(ledger);
  used.evidence = summary;
  const byId = new Map(summary.entries.map((e) => [e.ref.id, e]));
  const out: UsedWarning[] = [];
  for (const s of [...used.found, ...used.auto]) {
    const e = byId.get(s.id);
    if (e === undefined) continue;
    s.lifecycle = e.state;
    s.available = e.available;
    if (!e.available) out.push({ message: `"${s.title}" is no longer available to open.`, sourceId: s.id });
  }
  for (const message of warnings) out.push({ message });
  if (out.length > 0) used.warnings = out;
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
