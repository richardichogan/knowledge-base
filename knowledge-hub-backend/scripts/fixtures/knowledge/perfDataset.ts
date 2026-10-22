import { PINNED_NOW_ISO, seededRandom, stableUuid } from './constants.js';

/** Fixed seed: the performance corpus must be byte-identical across runs and machines. */
export const PERF_SEED = 20261022;

export interface PerfCounts {
  records: number;
  longRecords: number;
  passagesPerLong: number;
  tasks: number;
  projects: number;
  edges: number;
}

/** Spec section 10 / 12.3 sizes; `scale` shrinks everything proportionally for unit tests. */
export function perfCounts(scale = 1): PerfCounts {
  const s = (n: number) => Math.max(1, Math.round(n * scale));
  return { records: s(50_000), longRecords: s(5_000), passagesPerLong: 10, tasks: s(10_000), projects: Math.max(2, s(100)), edges: s(100_000) };
}

export type PerfKind = 'long' | 'task' | 'note' | 'discover-article' | 'library-document';
export type PerfTaskStatus = 'open' | 'blocked' | 'completed' | 'archived';

export interface PerfRecord {
  index: number;
  id: string;
  kind: PerfKind;
  projectId: string;
  title: string;
  /** Canonical text; for long records this is the passages joined by a blank line. */
  text: string;
  passages: string[];
  status?: PerfTaskStatus;
  /** Date-only due value (YYYY-MM-DD). */
  due?: string;
  updatedAt: string;
}

export interface PerfEdge { id: string; from: string; to: string; type: string; provenance: 'explicit' | 'inferred' }

export interface GoldenQuery {
  id: string;
  query: string;
  goldIds: string[];
  /** Zero-based passage that must be retrieved for long records. */
  passageIndex?: number;
  kind: 'exact-token' | 'long-passage';
}

const WORDS = ('claims policy adjuster threshold review approval workflow orchestration queue triage settlement vendor risk register decision ' +
  'owner evidence source summary version release deployment pipeline note task project theme spark canvas diagram person memory output ' +
  'budget forecast schedule meeting calendar email digest feed article podcast episode newsletter blog draft publish audit control gate ' +
  'model catalogue prompt token latency index passage cursor boundary partition replica tenant region cluster policy rollout').split(' ');

const MS_DAY = 86_400_000;
const NOW_MS = Date.parse(PINNED_NOW_ISO);

const rngFor = (index: number, salt: number) => seededRandom((PERF_SEED ^ Math.imul(index + 1, 2654435761) ^ salt) >>> 0);

function sentence(rnd: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!);
  return out.join(' ');
}

export const perfProjectId = (n: number) => `perf-p-${String(n).padStart(3, '0')}`;

/** Golden records sit at fixed stride positions so relevance is known without searching. */
export function goldenIndices(counts: PerfCounts): { long: number[]; note: number[] } {
  const strideLong = Math.max(1, Math.floor(counts.longRecords / 25));
  const long = Array.from({ length: 25 }, (_, i) => i * strideLong).filter((i) => i < counts.longRecords);
  const otherStart = counts.longRecords + counts.tasks;
  const otherSpan = Math.max(1, counts.records - otherStart);
  const strideNote = Math.max(1, Math.floor(otherSpan / 25));
  const note = Array.from({ length: 25 }, (_, i) => otherStart + i * strideNote).filter((i) => i < counts.records);
  return { long, note };
}

export const goldenToken = (index: number) => `gq${String(index).padStart(6, '0')}x`;

export function perfRecordAt(index: number, counts: PerfCounts = perfCounts()): PerfRecord {
  const rnd = rngFor(index, 0x9e3779b9);
  const projectId = perfProjectId(index % counts.projects);
  const id = stableUuid(`perf:${index}`);
  const golden = goldenIndices(counts);
  const updatedAt = new Date(NOW_MS - Math.floor(rnd() * 90) * MS_DAY).toISOString();
  if (index < counts.longRecords) {
    const passages = Array.from({ length: counts.passagesPerLong }, () => `${sentence(rnd, 90)}.`);
    if (golden.long.includes(index)) {
      const k = index % counts.passagesPerLong;
      passages[k] = `${passages[k]} Golden fact ${goldenToken(index)} is recorded here.`;
    }
    return { index, id, kind: 'long', projectId, title: `Long record ${index}`, text: passages.join('\n\n'), passages, updatedAt };
  }
  if (index < counts.longRecords + counts.tasks) {
    const r = rnd();
    const status: PerfTaskStatus = r < 0.6 ? 'open' : r < 0.7 ? 'blocked' : r < 0.9 ? 'completed' : 'archived';
    const due = new Date(NOW_MS + (Math.floor(rnd() * 61) - 30) * MS_DAY).toISOString().slice(0, 10);
    return { index, id, kind: 'task', projectId, title: `Task ${index}: ${sentence(rnd, 4)}`, text: sentence(rnd, 12), passages: [], status, due, updatedAt };
  }
  const kinds: PerfKind[] = ['note', 'discover-article', 'library-document'];
  const kind = kinds[index % kinds.length]!;
  const title = golden.note.includes(index) ? `Golden ${kind} ${goldenToken(index)}` : `${kind} ${index}: ${sentence(rnd, 3)}`;
  return { index, id, kind, projectId, title, text: `${sentence(rnd, 60)}.`, passages: [], updatedAt };
}

export function* generatePerfRecords(counts: PerfCounts = perfCounts()): Generator<PerfRecord> {
  for (let i = 0; i < counts.records; i++) yield perfRecordAt(i, counts);
}

export function* generatePerfEdges(counts: PerfCounts = perfCounts()): Generator<PerfEdge> {
  const types = ['links', 'mentions', 'related', 'sourced-from'];
  for (let j = 0; j < counts.edges; j++) {
    const rnd = rngFor(j, 0x85ebca6b);
    const from = Math.floor(rnd() * counts.records);
    let to = Math.floor(rnd() * counts.records);
    if (to === from) to = (to + 1) % counts.records;
    const provenance = rnd() < 0.8 ? 'explicit' : 'inferred';
    yield { id: stableUuid(`perf-edge:${j}`), from: stableUuid(`perf:${from}`), to: stableUuid(`perf:${to}`), type: types[j % types.length]!, provenance };
  }
}

/** Small golden-query subset with known relevance (50 queries at full scale). */
export function goldenQueries(counts: PerfCounts = perfCounts()): GoldenQuery[] {
  const g = goldenIndices(counts);
  return [
    ...g.long.map((i): GoldenQuery => ({
      id: `golden-long-${i}`, kind: 'long-passage', query: goldenToken(i), goldIds: [stableUuid(`perf:${i}`)], passageIndex: i % counts.passagesPerLong,
    })),
    ...g.note.map((i): GoldenQuery => ({ id: `golden-note-${i}`, kind: 'exact-token', query: goldenToken(i), goldIds: [stableUuid(`perf:${i}`)] })),
  ];
}

/** Exact structured expectation: open or blocked tasks with a due date before the pinned local day. */
export function expectedOverdueTasks(counts: PerfCounts = perfCounts()): Record<string, number> {
  const today = PINNED_NOW_ISO.slice(0, 10);
  const out: Record<string, number> = {};
  for (let i = counts.longRecords; i < counts.longRecords + counts.tasks; i++) {
    const r = perfRecordAt(i, counts);
    if ((r.status === 'open' || r.status === 'blocked') && r.due! < today) out[r.projectId] = (out[r.projectId] ?? 0) + 1;
  }
  return out;
}
