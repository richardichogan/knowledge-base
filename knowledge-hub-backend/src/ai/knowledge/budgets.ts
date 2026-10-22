/**
 * Per-turn retrieval budgets (spec 8) and the single orchestration feature flag.
 */
export const BUDGET_LIMITS = {
  sourceChars: 48_000,
  retrievalExecutions: 8,
  retrievalWallMs: 10_000,
  maxModelRounds: 10,
} as const;

export type BudgetKind = 'source_chars' | 'tool_executions' | 'wall_time' | 'aborted' | 'model_rounds';

/** Server flag gating the new orchestration; the previous path stays the default. */
export function isKnowledgeOrchestrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env['KNOWLEDGE_ORCHESTRATION'] ?? '').trim());
}

export class TurnBudget {
  sourceChars = 0;
  retrievalExecutions = 0;
  retrievalMs = 0;
  readonly exhausted = new Set<BudgetKind>();
  private readonly limits: typeof BUDGET_LIMITS;

  constructor(
    private readonly signal?: AbortSignal,
    limits: Partial<typeof BUDGET_LIMITS> = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = { ...BUDGET_LIMITS, ...limits };
  }

  get aborted(): boolean {
    if (this.signal?.aborted === true) { this.exhausted.add('aborted'); return true; }
    return false;
  }

  /** Whether another retrieval tool execution may start. Aborted turns launch nothing new. */
  canStartRetrieval(): { ok: true } | { ok: false; reason: BudgetKind } {
    if (this.aborted) return { ok: false, reason: 'aborted' };
    if (this.retrievalExecutions >= this.limits.retrievalExecutions) { this.exhausted.add('tool_executions'); return { ok: false, reason: 'tool_executions' }; }
    if (this.retrievalMs >= this.limits.retrievalWallMs) { this.exhausted.add('wall_time'); return { ok: false, reason: 'wall_time' }; }
    return { ok: true };
  }

  /** Remaining retrieval time, for clamping provider/DB timeouts. */
  remainingRetrievalMs(): number {
    return Math.max(0, this.limits.retrievalWallMs - this.retrievalMs);
  }

  /** Runs one retrieval, timing it against the cumulative wall budget. */
  async runRetrieval<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: BudgetKind }> {
    const gate = this.canStartRetrieval();
    if (!gate.ok) return gate;
    this.retrievalExecutions++;
    const started = this.clock();
    try {
      return { ok: true, value: await fn() };
    } finally {
      this.retrievalMs += this.clock() - started;
      if (this.retrievalMs >= this.limits.retrievalWallMs) this.exhausted.add('wall_time');
    }
  }

  /** Counts text sent to the model; returns the part that still fits. */
  admitSource(text: string): { text: string; truncated: boolean } {
    const room = Math.max(0, this.limits.sourceChars - this.sourceChars);
    if (text.length <= room) { this.sourceChars += text.length; return { text, truncated: false }; }
    this.sourceChars += room;
    this.exhausted.add('source_chars');
    return { text: text.slice(0, room), truncated: true };
  }

  noteModelRounds(rounds: number): void {
    if (rounds >= this.limits.maxModelRounds) this.exhausted.add('model_rounds');
  }

  get partial(): boolean { return this.exhausted.size > 0; }
}

const SCOPE_TEXT: Record<BudgetKind, string> = {
  source_chars: 'the source text limit for one answer was reached',
  tool_executions: 'the limit on searches and reads for one answer was reached',
  wall_time: 'the time allowed for looking things up was used up',
  aborted: 'the request was cancelled',
  model_rounds: 'the step limit for one answer was reached',
};

/** Honest scope statement; empty when nothing was limited. */
export function budgetLimitation(budget: TurnBudget): string {
  if (!budget.partial) return '';
  const why = [...budget.exhausted].map((k) => SCOPE_TEXT[k]).join('; ');
  return `Not everything was checked: ${why}. This answer covers only what I actually read.`;
}

const EXHAUSTIVE = /\b(all|every|everything|each|count|how many|none|nothing|any|no\s+\w+\s+(?:mention|record|note)s?|complete(?:ly)?|exhaustive(?:ly)?)\b/i;
const CHECKED_EVERYTHING = /\b(have you|did you|are you sure you)\b.*\b(checked|searched|looked|read)\b.*\b(everything|all|every)\b/i;

export function isExhaustiveQuery(query: string): boolean {
  return EXHAUSTIVE.test(query);
}

export function isCompletenessChallenge(query: string): boolean {
  return CHECKED_EVERYTHING.test(query);
}

/**
 * Exhaustive questions need a deterministic (structured/paged) path; otherwise the answer is
 * qualified as a sample. Returns the sentence to prepend, or null when none is needed.
 */
export function exhaustiveQualification(query: string, opts: { deterministicPath: boolean; complete: boolean }): string | null {
  if (!isExhaustiveQuery(query)) return null;
  if (opts.deterministicPath && opts.complete) return null;
  return opts.deterministicPath
    ? 'This is a partial result: the query did not run to completion, so the list and any count are incomplete.'
    : "I can't give an exact count or say none exist from search alone; this reflects the records I found and read, not everything stored.";
}

/** Answer to "have you checked everything?" — never comprehensive when a limit was hit or only samples were read. */
export function completenessAnswer(budget: TurnBudget, counts: { found: number; read: number }): string {
  const scope = `I found ${counts.found} record${counts.found === 1 ? '' : 's'} and read ${counts.read}.`;
  return budget.partial
    ? `No. ${scope} ${budgetLimitation(budget)}`
    : `Not necessarily everything. ${scope} I only checked what my searches surfaced, so I can't promise nothing else exists.`;
}

/** Applies the exhaustive-query and "checked everything?" rules to a validated final answer. */
/** Exact, paged Phase 2 tools whose totals come from the database, not from search. */
export const DETERMINISTIC_TOOLS: ReadonlySet<string> = new Set(['knowledge_count_tasks', 'knowledge_list_tasks', 'knowledge_list_changes']);

/** A deterministic result is complete unless it errored, was cut off, or has another page. */
export function isDeterministicResultComplete(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;
  if ('error' in r || r['partial'] === true || r['truncated'] === true || r['hasMore'] === true) return false;
  if (r['status'] !== undefined && r['status'] !== 'ok') return false;
  const cursor = r['nextCursor'];
  return cursor === undefined || cursor === null || cursor === '';
}

const RAW_METADATA_REQUEST_PATTERN =
  /\b(?:raw|hidden|internal|underlying|excluded|secret|private)\s+(?:metadata|fields?|properties|attributes)\b|\bmetadata\s+(?:dump|blob|json)\b/i;

export const RAW_METADATA_REFUSAL =
  'Raw metadata fields are not available to me: they are excluded from what I read, so I will not list or reconstruct them. I can describe the note\'s visible content if that helps.';

export function finalizeKnowledgeAnswer(
  query: string,
  answer: string,
  turn: { budget: TurnBudget; counts: { found: number; read: number }; retrievalUsed: boolean; deterministicPath: boolean; deterministicComplete?: boolean },
): string {
  if (RAW_METADATA_REQUEST_PATTERN.test(query)) return RAW_METADATA_REFUSAL;
  if (isCompletenessChallenge(query)) return completenessAnswer(turn.budget, turn.counts);
  const qualification = turn.retrievalUsed || turn.deterministicPath
    ? exhaustiveQualification(query, { deterministicPath: turn.deterministicPath, complete: turn.deterministicComplete ?? !turn.budget.partial })
    : null;
  const limit = budgetLimitation(turn.budget);
  const nothingFound = turn.retrievalUsed && !turn.deterministicPath && turn.counts.found === 0 && turn.counts.read === 0 ? NOTHING_FOUND_NOTE : null;
  return [qualification, nothingFound, answer, limit === '' ? null : limit].filter((p): p is string => p !== null).join('\n\n');
}

/** Retrieval ran but registered no record: say so, so an unsupported answer is never read as a confirmed one. */
export const NOTHING_FOUND_NOTE = 'I did not find any matching record in what I could search, so I cannot confirm this from your saved sources.';
