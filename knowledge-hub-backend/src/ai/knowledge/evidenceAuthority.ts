/**
 * Conflict and authority rules (spec 7.3): provenance labels, syndicated-copy
 * de-duplication, Watchlist coverage interpretation, chat summary vs verbatim,
 * and the prompt block that tells the model how to phrase each.
 */
import type { EvidenceOrigin } from './evidence.js';

export type AuthorityLabel =
  | 'recorded decision' | 'AI suggestion' | 'reconstruction (not a transcript)' | 'note'
  | 'AI analysis (not independent corroboration)' | 'live state' | 'transcript';

export interface AuthorityInput {
  kind: string;
  origin: EvidenceOrigin | null;
  /** e.g. copilot_import, transcript, decision, watchlist_finding */
  subtype?: string | null;
}

export function authorityLabel(i: AuthorityInput): AuthorityLabel {
  if (i.subtype === 'transcript') return 'transcript';
  if (i.subtype === 'copilot_import' || i.subtype === 'copilot-import') return 'reconstruction (not a transcript)';
  if (i.subtype === 'watchlist_finding' || i.kind === 'watchlist_finding') return 'AI analysis (not independent corroboration)';
  if (i.origin === 'live') return 'live state';
  if (i.subtype === 'decision' && i.origin === 'human') return 'recorded decision';
  if (i.origin === 'ai-generated') return 'AI suggestion';
  return 'note';
}

/** Verb the answer may use for a source: a note "says", only a recorded human decision "decided". */
export function attributionVerb(label: AuthorityLabel): string {
  switch (label) {
    case 'recorded decision': return 'The recorded decision says';
    case 'AI suggestion': return 'A previous AI answer suggested';
    case 'reconstruction (not a transcript)': return 'The note says';
    case 'AI analysis (not independent corroboration)': return 'The analysis suggests';
    case 'live state': return 'The current state shows';
    case 'transcript': return 'The transcript says';
    default: return 'The note says';
  }
}

/** Phrases that overstate a source's authority. Returns the problems found in `text` for a source label. */
export function overclaimProblems(text: string, label: AuthorityLabel): string[] {
  const problems: string[] = [];
  if (label === 'reconstruction (not a transcript)' && /\b(the meeting|they|we)\s+(decided|agreed|concluded)\b/i.test(text)) problems.push('reconstruction presented as meeting decision');
  if (label === 'AI suggestion' && /\b(agreed|decided|accepted|approved)\b/i.test(text)) problems.push('AI suggestion presented as agreed');
  if (label === 'AI analysis (not independent corroboration)' && /\b(independently|corroborat\w+|confirmed by)\b/i.test(text)) problems.push('AI analysis presented as independent corroboration');
  return problems;
}

export interface CopyCandidate { id: string; url?: string | null; title: string; contentHash?: string | null; body?: string | null }

const canonicalTitle = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const BODY_KEY_MIN_CHARS = 200;
const BODY_KEY_CHARS = 400;

function bodyFingerprint(c: CopyCandidate): string | null {
  if (c.contentHash != null && c.contentHash !== '') return `h:${c.contentHash}`;
  if (c.body != null && c.body.length >= BODY_KEY_MIN_CHARS) return `b:${canonicalTitle(c.body).slice(0, BODY_KEY_CHARS)}`;
  return null;
}

/** Syndicated copies of the same article count once: same content hash/body prefix or same normalised title. */
export function dedupeSyndicated<T extends CopyCandidate>(items: T[]): { unique: T[]; duplicates: Array<{ kept: string; dropped: string }> } {
  const seen = new Map<string, string>();
  const unique: T[] = [];
  const duplicates: Array<{ kept: string; dropped: string }> = [];
  for (const item of items) {
    const keys = [bodyFingerprint(item), `t:${canonicalTitle(item.title)}`].filter((k): k is string => k !== null && k !== 't:');
    const hit = keys.map((k) => seen.get(k)).find((v) => v !== undefined);
    if (hit !== undefined) { duplicates.push({ kept: hit, dropped: item.id }); continue; }
    for (const k of keys) seen.set(k, item.id);
    unique.push(item);
  }
  return { unique, duplicates };
}

export type WatchOutcome = 'failed' | 'insufficient_coverage' | 'quiet_covered' | 'findings' | 'running';

/** A failed run, or one with empty coverage, is never a "no change" result. */
export function interpretWatchRun(run: { status: string; coverage?: Record<string, unknown> | null }): WatchOutcome {
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  const covered = run.coverage != null && Object.keys(run.coverage).length > 0;
  if (run.status === 'insufficient_coverage' || !covered) return 'insufficient_coverage';
  return run.status === 'no_meaningful_change' ? 'quiet_covered' : 'findings';
}

export function watchStatement(outcome: WatchOutcome, priorFindingsDate?: string | null): string {
  switch (outcome) {
    case 'failed': return `The latest run failed${priorFindingsDate != null ? `; the most recent completed findings are from ${priorFindingsDate}` : ''}. I can't say whether anything changed since.`;
    case 'insufficient_coverage': return "The run didn't cover enough sources to say anything changed or didn't.";
    case 'quiet_covered': return 'No meaningful change was found within the sources and interval this run covered; that is not a claim about the wider market.';
    case 'running': return 'The run is still in progress.';
    default: return 'The run reported findings.';
  }
}

export type ChatEvidenceKind = 'summary' | 'verbatim' | 'decision';

/** Exact quotes of what was said or decided need the original exchange or a saved decision, not a summary. */
export function chatQuoteAllowed(kind: ChatEvidenceKind, wantsExactQuote: boolean): boolean {
  return !wantsExactQuote || kind === 'verbatim' || kind === 'decision';
}

export const CONFLICT_AUTHORITY_PROMPT = [
  'Evidence rules:',
  '- Cite only records you read this turn, as [[cite:kind:id@version|short exact quote]]. Never cite search hits you did not open.',
  '- Where sources disagree, state each position with its date/version and cite both; do not decide a winner unless live state settles it. Later is not automatically more correct.',
  '- Live structured state beats old snapshots for current fields. A recorded human decision is not an AI suggestion; say which one it is.',
  '- Copilot-import notes are reconstructions: say "the note says", never "the meeting decided". Chat summaries are summaries; exact quotes need the original messages.',
  '- Watchlist findings are AI analysis, not independent corroboration. A failed or empty-coverage run is not "no change". Syndicated copies count once.',
  '- Graph links labelled inferred are suggestions; say so and cite the records behind them. Never claim an inferred link is a dependency.',
  '- If a limit was reached say "not everything was checked" and name what is covered. Never claim to have checked everything or give exact counts from search results.',
].join('\n');
