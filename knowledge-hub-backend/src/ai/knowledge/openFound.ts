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
