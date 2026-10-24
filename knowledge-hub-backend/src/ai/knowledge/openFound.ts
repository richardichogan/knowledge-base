/**
 * Cross-source synthesis: a search only finds records. Before the model answers, the top hit of
 * every source family that was found but never opened is put in front of it, so evidence from
 * each relevant family is read rather than guessed from titles.
 */
import { refKey, type EvidenceLedger } from './evidence.js';

/** Ledger kind -> how the model opens it. */
const READERS: Record<string, string> = {
  note: 'read_knowledge_record kind "note"',
  item: 'read_knowledge_record kind "content-item"',
  document: 'read_knowledge_record kind "content-item"',
  task: 'read_knowledge_record kind "task"',
  project: 'read_knowledge_record kind "project"',
  output: 'read_knowledge_record kind "output"',
  diagram: 'read_diagram with diagramId',
  chat: 'read_past_chat with sessionId',
};

const MAX_OPEN_SUGGESTIONS = 5;
const MIN_READS_WHEN_NONE = 3;

export interface UnreadCandidate { kind: string; id: string; title: string | null; reader: string }

/** Top found-only record per family that has nothing read yet; when nothing at all was read, the top few overall. */
export function unreadFoundCandidates(ledger: EvidenceLedger): UnreadCandidate[] {
  const readFamilies = new Set<string>();
  const readIds = new Set<string>();
  let anyRead = false;
  for (const e of ledger.entries.values()) if (e.state !== 'found') { readFamilies.add(e.ref.kind); readIds.add(e.ref.id); anyRead = true; }
  const picked = new Map<string, UnreadCandidate>();
  for (const e of ledger.entries.values()) {
    const reader = READERS[e.ref.kind];
    if (e.state !== 'found' || reader === undefined || !e.available || readIds.has(e.ref.id)) continue;
    if (readFamilies.has(e.ref.kind) || picked.has(e.ref.kind)) continue;
    picked.set(e.ref.kind, { kind: e.ref.kind, id: e.ref.id, title: e.title, reader });
  }
  const out = [...picked.values()];
  if (!anyRead) {
    for (const e of ledger.entries.values()) {
      if (out.length >= MIN_READS_WHEN_NONE) break;
      const reader = READERS[e.ref.kind];
      if (e.state === 'found' && reader !== undefined && e.available && !readIds.has(e.ref.id) && !out.some((c) => refKey(c) === refKey(e.ref))) out.push({ kind: e.ref.kind, id: e.ref.id, title: e.title, reader });
    }
  }
  return out.slice(0, MAX_OPEN_SUGGESTIONS);
}

export function openFoundInstruction(candidates: UnreadCandidate[]): string {
  const lines = candidates.map((c) => `- ${c.kind} "${c.title ?? 'Untitled'}" (id ${c.id}): ${c.reader}`).join('\n');
  return `[System: your searches found these records but you have not opened them, so you cannot state or cite what they say. Open each one that could bear on the question, in parallel, then answer from what you read. If the sources differ, state each position and cite each. If none is relevant, say so.]\n${lines}`;
}

export interface PendingRead { kind: string; id: string; cursor: string; title: string; endOffset: number; totalChars: number }

/** Only successful pages actually delivered to the model can advance a continuation. */
export function updatePendingRead(pending: Map<string, PendingRead>, args: Record<string, unknown>, result: unknown): void {
  const id = typeof args['id'] === 'string' ? args['id'] : '';
  if (typeof result !== 'object' || result === null) return;
  const r = result as Record<string, unknown>;
  if (r['status'] !== 'ok' && r['status'] !== 'partial') {
    if (typeof r['status'] === 'string' || 'error' in r) pending.delete(id);
    return;
  }
  const record = r['record'];
  if (typeof record !== 'object' || record === null) return;
  const rec = record as Record<string, unknown>;
  const ref = rec['ref'];
  if (typeof ref !== 'object' || ref === null) return;
  const canonical = ref as Record<string, unknown>;
  pending.delete(id);
  if (typeof canonical['id'] !== 'string' || typeof canonical['kind'] !== 'string') return;
  pending.delete(canonical['id']);
  if (typeof rec['nextCursor'] !== 'string') return;
  pending.set(canonical['id'], {
    kind: canonical['kind'], id: canonical['id'], cursor: rec['nextCursor'],
    title: typeof rec['title'] === 'string' ? rec['title'] : 'Untitled',
    endOffset: typeof rec['endOffset'] === 'number' ? rec['endOffset'] : 0,
    totalChars: typeof rec['totalChars'] === 'number' ? rec['totalChars'] : 0,
  });
}

export function continuationInstruction(pending: Iterable<PendingRead>): string {
  return '[System: the requested document review is unfinished. These are unread continuation pages, not failed body loads. ' +
    'Call read_knowledge_record with the supplied kind, id and cursor before answering. Do not substitute an earlier chat for the source.]\n' +
    JSON.stringify([...pending]);
}
