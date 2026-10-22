/**
 * Process-level admission control for knowledge retrieval and indexing
 * queries (spec section 8). A semaphore per request cannot protect the shared
 * pool, so every retrieval query passes through one per-turn limit and one
 * process-wide limit; index-worker queries have their own single slot.
 * The counters track real in-flight queries so tests can assert the limits.
 */

export const ADMISSION_LIMITS = { perTurn: 2, perProcess: 4, indexWorker: 1 } as const;

export type AdmissionScope = { kind: 'turn'; turnId: string } | { kind: 'index' };

export class AdmissionAbortedError extends Error {
  constructor() { super('Admission wait aborted'); this.name = 'AbortError'; }
}

class Semaphore {
  inFlight = 0;
  maxObserved = 0;
  private readonly waiters: { grant: () => void }[] = [];
  constructor(readonly limit: number) {}

  get waiting(): number { return this.waiters.length; }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new AdmissionAbortedError();
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new AdmissionAbortedError());
        };
        const waiter = { grant: (): void => { signal?.removeEventListener('abort', onAbort); resolve(); } };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(waiter);
      });
    }
    this.inFlight += 1;
    this.maxObserved = Math.max(this.maxObserved, this.inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.waiters.shift()?.grant();
    };
  }
}

export interface AdmissionStats {
  retrievalInFlight: number;
  retrievalMaxInFlight: number;
  retrievalWaiting: number;
  indexInFlight: number;
  indexMaxInFlight: number;
  maxInFlightPerTurn: number;
}

export interface Admission {
  run<T>(scope: AdmissionScope, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  stats(): AdmissionStats;
  resetStats(): void;
}

export function createAdmission(limits: { perTurn: number; perProcess: number; indexWorker: number } = ADMISSION_LIMITS): Admission {
  const processSlots = new Semaphore(limits.perProcess);
  const indexSlots = new Semaphore(limits.indexWorker);
  const turns = new Map<string, Semaphore>();
  let maxPerTurn = 0;

  const turnSemaphore = (turnId: string): Semaphore => {
    let sem = turns.get(turnId);
    if (sem === undefined) { sem = new Semaphore(limits.perTurn); turns.set(turnId, sem); }
    return sem;
  };

  return {
    async run<T>(scope: AdmissionScope, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (scope.kind === 'index') {
        const release = await indexSlots.acquire(signal);
        try { return await fn(); } finally { release(); }
      }
      // Turn slot first, then process slot: a consistent order cannot deadlock.
      const turn = turnSemaphore(scope.turnId);
      const releaseTurn = await turn.acquire(signal);
      let releaseProcess: (() => void) | undefined;
      try {
        releaseProcess = await processSlots.acquire(signal);
        maxPerTurn = Math.max(maxPerTurn, turn.inFlight);
        return await fn();
      } finally {
        releaseProcess?.();
        releaseTurn();
        if (turn.inFlight === 0 && turn.waiting === 0) turns.delete(scope.turnId);
      }
    },
    stats: () => ({
      retrievalInFlight: processSlots.inFlight,
      retrievalMaxInFlight: processSlots.maxObserved,
      retrievalWaiting: processSlots.waiting,
      indexInFlight: indexSlots.inFlight,
      indexMaxInFlight: indexSlots.maxObserved,
      maxInFlightPerTurn: maxPerTurn,
    }),
    resetStats: (): void => { processSlots.maxObserved = processSlots.inFlight; indexSlots.maxObserved = indexSlots.inFlight; maxPerTurn = 0; },
  };
}

export const processAdmission: Admission = createAdmission();

export interface QueryRows<R> { rows: R[]; rowCount?: number | null }
export interface AdmittedQuery {
  query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryRows<R>>;
}

/** Wraps a pool (or client) so every query is admitted before it starts. */
export function admitQueries(
  db: { query: (...args: never[]) => unknown },
  scope: AdmissionScope,
  options: { signal?: AbortSignal; admission?: Admission } = {},
): AdmittedQuery {
  const admission = options.admission ?? processAdmission;
  const raw = db as unknown as { query: (sql: string, values?: unknown[]) => Promise<QueryRows<never>> };
  return {
    query: <R,>(sql: string, values?: unknown[]) =>
      admission.run(scope, () => raw.query(sql, values) as Promise<QueryRows<R>>, options.signal),
  };
}
