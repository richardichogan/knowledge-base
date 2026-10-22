/**
 * Per-turn evidence ledger (spec 7.1). Tracks Found -> Read -> Cited per canonical ref.
 * Passage text is held in memory only so quotes can be checked; it is never part of
 * the summary sent to the client or to logs.
 */
export interface EvidenceRef { kind: string; id: string }
export type EvidenceState = 'found' | 'read' | 'cited';
export type EvidenceOrigin = 'human' | 'imported' | 'ai-generated' | 'derived' | 'live';

export interface EvidenceRelationPath {
  /** Canonical keys from the starting record to this one. */
  via: string[];
  relation: string;
  explicit: boolean;
  confidence?: number;
}

export interface EvidenceEntry {
  key: string;
  ref: EvidenceRef;
  title: string | null;
  projectId: string | null;
  version: string | null;
  locator: string | null;
  origin: EvidenceOrigin | null;
  state: EvidenceState;
  sourceTime: string | null;
  readAt: string | null;
  freshness: string | null;
  /** Character offsets of passages read, or structured field names / query filter. */
  passages: Array<{ start: number; end: number }>;
  fields: string[];
  path: EvidenceRelationPath | null;
  /** False when the target was deleted, excluded or could not be opened. */
  available: boolean;
}

export interface EvidenceMeta {
  title?: string | null;
  projectId?: string | null;
  version?: string | null;
  locator?: string | null;
  origin?: EvidenceOrigin | null;
  sourceTime?: string | null;
  freshness?: string | null;
  path?: EvidenceRelationPath | null;
}

export interface ReadInput extends EvidenceMeta {
  /** Text actually shown to the model; kept in memory for quote checks only. */
  text?: string;
  start?: number;
  fields?: string[];
}

export const MAX_LEDGER_ENTRIES = 200;
const MAX_PASSAGE_CHARS = 48_000;

export const refKey = (ref: EvidenceRef): string => `${ref.kind}:${ref.id}`;

export interface EvidenceLedger {
  entries: Map<string, EvidenceEntry>;
  texts: Map<string, string[]>;
  now: () => Date;
}

export function createLedger(now: () => Date = () => new Date()): EvidenceLedger {
  return { entries: new Map(), texts: new Map(), now };
}

function blank(ref: EvidenceRef, meta: EvidenceMeta): EvidenceEntry {
  return {
    key: refKey(ref), ref: { kind: ref.kind, id: ref.id }, title: meta.title ?? null, projectId: meta.projectId ?? null,
    version: meta.version ?? null, locator: meta.locator ?? null, origin: meta.origin ?? null, state: 'found',
    sourceTime: meta.sourceTime ?? null, readAt: null, freshness: meta.freshness ?? null, passages: [], fields: [], path: meta.path ?? null, available: true,
  };
}

function merge(entry: EvidenceEntry, meta: EvidenceMeta): void {
  entry.title = meta.title ?? entry.title;
  entry.projectId = meta.projectId ?? entry.projectId;
  entry.version = meta.version ?? entry.version;
  entry.locator = meta.locator ?? entry.locator;
  entry.origin = meta.origin ?? entry.origin;
  entry.sourceTime = meta.sourceTime ?? entry.sourceTime;
  entry.freshness = meta.freshness ?? entry.freshness;
  entry.path = meta.path ?? entry.path;
}

/** Discovery only: a search hit or graph neighbour. Returns false when the bounded ledger is full. */
export function noteFound(ledger: EvidenceLedger, ref: EvidenceRef, meta: EvidenceMeta = {}): boolean {
  const key = refKey(ref);
  const existing = ledger.entries.get(key);
  if (existing !== undefined) { merge(existing, meta); return true; }
  if (ledger.entries.size >= MAX_LEDGER_ENTRIES) return false;
  ledger.entries.set(key, blank(ref, meta));
  return true;
}

/** The model was actually shown this record/passage/structured result. */
export function noteRead(ledger: EvidenceLedger, ref: EvidenceRef, input: ReadInput = {}): boolean {
  if (!noteFound(ledger, ref, input)) return false;
  const entry = ledger.entries.get(refKey(ref));
  if (entry === undefined) return false;
  if (entry.state === 'found') entry.state = 'read';
  entry.readAt = ledger.now().toISOString();
  if (input.text !== undefined) {
    const start = input.start ?? 0;
    entry.passages.push({ start, end: start + input.text.length });
    const kept = ledger.texts.get(entry.key) ?? [];
    if (kept.reduce((n, t) => n + t.length, 0) + input.text.length <= MAX_PASSAGE_CHARS) kept.push(input.text);
    ledger.texts.set(entry.key, kept);
  }
  for (const f of input.fields ?? []) if (!entry.fields.includes(f)) entry.fields.push(f);
  return true;
}

/** Marks a read record as cited. Unread records cannot be cited. */
export function noteCited(ledger: EvidenceLedger, ref: EvidenceRef): boolean {
  const entry = ledger.entries.get(refKey(ref));
  if (entry === undefined || entry.state === 'found') return false;
  entry.state = 'cited';
  return true;
}

export function isRead(ledger: EvidenceLedger, ref: EvidenceRef): boolean {
  const s = ledger.entries.get(refKey(ref))?.state;
  return s === 'read' || s === 'cited';
}

export function ledgerCounts(ledger: EvidenceLedger): { found: number; read: number; cited: number } {
  let read = 0;
  let cited = 0;
  for (const e of ledger.entries.values()) {
    if (e.state === 'cited') { cited++; read++; } else if (e.state === 'read') read++;
  }
  return { found: ledger.entries.size, read, cited };
}

export interface EvidenceSummary {
  counts: { found: number; read: number; cited: number };
  entries: Array<{
    ref: EvidenceRef; title: string | null; projectId: string | null; version: string | null; locator: string | null;
    state: EvidenceState; origin: EvidenceOrigin | null; explicit: boolean | null; available: boolean;
  }>;
}

/** Client-safe view: identifiers and lifecycle only, never passage text. */
export function summariseLedger(ledger: EvidenceLedger): EvidenceSummary {
  return {
    counts: ledgerCounts(ledger),
    entries: [...ledger.entries.values()].map((e) => ({
      ref: e.ref, title: e.title, projectId: e.projectId, version: e.version, locator: e.locator, state: e.state,
      origin: e.origin, explicit: e.path === null ? null : e.path.explicit, available: e.available,
    })),
  };
}

/** Drops excluded or deleted records so they cannot be cited later in the turn. */
export function dropFromLedger(ledger: EvidenceLedger, ref: EvidenceRef): void {
  ledger.entries.delete(refKey(ref));
  ledger.texts.delete(refKey(ref));
}

/** Records that a target could not be opened (deleted, excluded or missing) so the UI can show it as unavailable. */
export function markUnavailable(ledger: EvidenceLedger, ref: EvidenceRef): void {
  if (!noteFound(ledger, ref)) return;
  const entry = ledger.entries.get(refKey(ref));
  if (entry !== undefined) entry.available = false;
}
