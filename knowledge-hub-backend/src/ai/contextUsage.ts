/**
 * ai/contextUsage.ts — what a reply drew on (the "Used:" line under it), and
 * the per-chat "Don't use this" list that keeps items out of searches and
 * auto-retrieval for the rest of the chat.
 */
import type { Pool } from 'pg';
import { RECORD_TOOLS, recordRecordTool, recordStructuredTool, STRUCTURED_RESULT_TOOLS } from './knowledge/toolRecords.js';
import { markUnavailable, noteFound, noteRead, summariseLedger, type EvidenceLedger, type EvidenceSummary } from './knowledge/evidence.js';

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
  else if (toolName === 'list_tasks' || toolName === 'find_files') {
    const rows = (toolName === 'list_tasks' ? (result as { tasks?: unknown }).tasks : (result as { files?: unknown }).files);
    for (const x of Array.isArray(rows) ? rows as Array<{ id?: string; title?: string; url?: string }> : []) {
      push(used.found, { id: x.id ?? '', kind: toolName === 'list_tasks' ? 'task' : 'item', title: x.title ?? 'Untitled', url: x.url ?? null });
    }
  }  else if ((toolName === 'search_diagrams' || toolName === 'read_diagram') && Array.isArray(r.results)) {
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

const UNAVAILABLE_STATUSES = new Set(['not_found', 'unavailable']);

interface KnowledgeReadResult {
  status?: string; code?: string;
  record?: { ref?: { kind?: string; id?: string }; title?: string; content?: string; version?: string; projectId?: string | null; startOffset?: number };
  review?: { ref: { kind: string; id: string }; title: string; version: string; complete: boolean; excerpts: Array<{ text: string; start: number }> };
}

/** read_knowledge_record: opened records are Read; failed or unavailable ones are flagged, excluded ones are dropped. */
function recordKnowledgeRead(ledger: EvidenceLedger, result: KnowledgeReadResult, args: Record<string, unknown>): void {
  const kind = typeof args['kind'] === 'string' ? args['kind'] : '';
  const id = typeof args['id'] === 'string' ? args['id'] : '';
  if (result.status === 'ok' || result.status === 'partial') {
    if (result.review !== undefined) {
      const review = result.review;
      const previous = ledger.entries.get(`${review.ref.kind}:${review.ref.id}`);
      if (previous !== undefined && previous.version !== review.version) {
        ledger.entries.delete(previous.key); ledger.texts.delete(previous.key);
      }
      noteRead(ledger, review.ref, { title: review.title, version: review.version,
        fields: [review.complete ? 'full_stored_document_processed' : 'partial_document_review'] });
      for (const excerpt of review.excerpts) noteRead(ledger, review.ref, { text: excerpt.text, start: excerpt.start });
      return;
    }
    const rec = result.record;
    const ref = { kind: rec?.ref?.kind ?? kind, id: rec?.ref?.id ?? id };
    if (rec === undefined || ref.id === '') return;
    const previous = ledger.entries.get(`${ref.kind}:${ref.id}`);
    if (previous?.version !== null && previous?.version !== undefined && rec.version !== undefined && previous.version !== rec.version) {
      ledger.entries.delete(`${ref.kind}:${ref.id}`);
      ledger.texts.delete(`${ref.kind}:${ref.id}`);
    }
    noteRead(ledger, ref, { title: rec.title ?? null, version: rec.version ?? null, projectId: rec.projectId ?? null, text: rec.content ?? '', start: rec.startOffset ?? 0 });
  } else if (id !== '' && result.status === 'excluded') {
    for (const [key, e] of [...ledger.entries]) if (e.ref.id === id) { ledger.entries.delete(key); ledger.texts.delete(key); }
  } else if (id !== '' && result.status !== undefined && UNAVAILABLE_STATUSES.has(result.status) && result.code !== 'exclusions_unavailable') {
    markUnavailable(ledger, { kind, id });
  }
}

/** Feeds the evidence ledger: search hits are Found; opened records are Read. */
export function recordToolEvidence(ledger: EvidenceLedger, toolName: string, result: unknown, args: Record<string, unknown> = {}): void {
  if (typeof result !== 'object' || result === null) return;
  if (toolName === 'read_knowledge_record') { recordKnowledgeRead(ledger, result as KnowledgeReadResult, args); return; }
  if ('error' in result) return;
  if (RECORD_TOOLS.has(toolName)) { recordRecordTool(ledger, toolName, result); return; }
  if (STRUCTURED_RESULT_TOOLS.has(toolName)) { recordStructuredTool(ledger, toolName, result, args); return; }
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

const UNAVAILABLE_WARNING = 'A source could not be opened, so it was not read.';
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
  }
  for (const e of summary.entries) if (!e.available) out.push({ message: UNAVAILABLE_WARNING, sourceId: e.ref.id });
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
