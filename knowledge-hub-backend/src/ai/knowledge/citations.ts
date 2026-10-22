/**
 * Citation validation (spec 7.2): identity, version, scope, locator and quote
 * match against evidence actually read this turn. At most one repair, then a
 * shorter supported answer with the gap stated.
 */
import { isRead, noteCited, refKey, type EvidenceLedger, type EvidenceRef } from './evidence.js';

export interface Citation {
  ref: EvidenceRef;
  version?: string | null;
  locator?: string | null;
  quote?: string | null;
  /** The raw marker in the answer text, used for degrading. */
  marker?: string;
}

export type CitationProblem = 'unknown_ref' | 'unread' | 'version_mismatch' | 'scope_denied' | 'locator_mismatch' | 'quote_mismatch';

export interface CitationVerdict { citation: Citation; ok: boolean; problem?: CitationProblem }

export interface CitationScope {
  /** When set, only evidence from these project ids (or no project) may be cited. */
  allowedProjectIds?: ReadonlySet<string>;
}

/** Documented normalisation: every run of Unicode whitespace becomes one space, ends trimmed. Case is preserved. */
export function normaliseWhitespace(text: string): string {
  return text.replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
}

export function validateCitation(ledger: EvidenceLedger, citation: Citation, scope: CitationScope = {}): CitationVerdict {
  const fail = (problem: CitationProblem): CitationVerdict => ({ citation, ok: false, problem });
  const entry = ledger.entries.get(refKey(citation.ref));
  if (entry === undefined) return fail('unknown_ref');
  if (!isRead(ledger, citation.ref)) return fail('unread');
  if (citation.version != null && entry.version !== null && citation.version !== entry.version) return fail('version_mismatch');
  if (scope.allowedProjectIds !== undefined && entry.projectId !== null && !scope.allowedProjectIds.has(entry.projectId)) return fail('scope_denied');
  if (citation.locator != null && entry.locator !== null && citation.locator !== entry.locator) return fail('locator_mismatch');
  if (citation.quote != null && citation.quote.trim() !== '') {
    const wanted = normaliseWhitespace(citation.quote);
    const texts = ledger.texts.get(entry.key) ?? [];
    if (!texts.some((t) => normaliseWhitespace(t).includes(wanted))) return fail('quote_mismatch');
  }
  return { citation, ok: true };
}

export function validateCitations(ledger: EvidenceLedger, citations: Citation[], scope: CitationScope = {}): CitationVerdict[] {
  return citations.map((c) => validateCitation(ledger, c, scope));
}

const MARKER = /\[\[cite:([a-z_-]+):([^\s|@\]]+)(?:@([^\s|\]]+))?(?:\|([^\]]*))?\]\]/gi;

/** Parses `[[cite:kind:id@version|quote]]` markers. */
export function parseCitations(answer: string): Citation[] {
  return [...answer.matchAll(MARKER)].map(([marker, kind, id, version, quote]) => ({
    ref: { kind: kind as string, id: id as string },
    version: version ?? null,
    quote: quote ?? null,
    marker,
  }));
}

export type AnswerDecision =
  | { action: 'release'; answer: string }
  | { action: 'repair'; invalid: CitationVerdict[]; instruction: string; mayOpen: boolean }
  | { action: 'partial'; answer: string; invalid: CitationVerdict[] };

export const CITATION_GAP_NOTE = 'Some statements were left out because I could not tie them to a record I read in this chat.';
export const QUOTE_GAP_NOTE = 'Some quoted wording could not be matched exactly to the source text, so treat it as a paraphrase.';
export const CITATION_FAILURE = "I couldn't support that answer with records I read this turn, so I'm not going to state it as fact. Ask me to look again and I'll check the source directly.";

/** Removes the sentences carrying unsupported citations; keeps everything else, qualifications included. */
export function degradeAnswer(answer: string, invalid: CitationVerdict[]): string {
  const markers = invalid.map((v) => v.citation.marker).filter((m): m is string => m !== undefined);
  if (markers.length === 0) return answer;
  const kept = answer.split(/(?<=[.!?])\s+|\n{2,}/).filter((s) => !markers.some((m) => s.includes(m)));
  const body = kept.join(' ').trim();
  return body === '' ? CITATION_FAILURE : `${body}\n\n${CITATION_GAP_NOTE}`;
}

/** Strips citation markers for display once validated. */
export function stripMarkers(answer: string): string {
  return answer.replace(MARKER, '').replace(/[ \t]+([.,;!?])/g, '$1');
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Ids present in the given texts, lower-cased. */
export function collectIds(...texts: string[]): Set<string> {
  const ids = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(UUID)) ids.add(m[0].toLowerCase());
  return ids;
}

/**
 * Removes record ids and links the turn never saw (not found, read or supplied by the user): a link keeps its
 * label, a bare id is dropped. Runs on the final text so an answer cannot name a record no tool returned.
 */
export function stripUnseenIds(answer: string, seen: ReadonlySet<string>): string {
  const unseen = (text: string): boolean => (text.match(UUID) ?? []).some((id) => !seen.has(id.toLowerCase()));
  const linked = answer.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (whole, label: string, target: string) => (unseen(target) ? label : whole));
  return linked
    .replace(UUID, (id) => (seen.has(id.toLowerCase()) ? id : ''))
    .replace(/(?:`\s*`|\(\s*\))/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

export interface ResolveOptions {
  scope?: CitationScope;
  repairsUsed: number;
  /** False when time or call budget no longer allows a repair round. */
  canRepair: boolean;
}

export function resolveAnswer(ledger: EvidenceLedger, answer: string, opts: ResolveOptions): AnswerDecision {
  const verdicts = validateCitations(ledger, parseCitations(answer), opts.scope);
  const invalid = verdicts.filter((v) => !v.ok);
  if (invalid.length === 0) {
    for (const v of verdicts) noteCited(ledger, v.citation.ref);
    return { action: 'release', answer: stripMarkers(answer) };
  }
  if (opts.repairsUsed < 1 && opts.canRepair) {
    const lines = invalid.map((v) => `${refKey(v.citation.ref)}: ${v.problem}`).join('; ');
    const unread = invalid.filter((v) => v.problem === 'unread');
    const mayOpen = unread.length > 0;
    const rest = mayOpen
      ? `Records marked unread were only found, not opened: open each one that supports a claim with its read tool, or remove that citation.`
      : 'Rewrite the answer using only records you already read this turn; do not search again.';
    return {
      action: 'repair', invalid, mayOpen,
      instruction: `Some citations could not be verified (${lines}). ${rest} Cite only record ids a tool returned this turn. Copy any quote exactly from the record text or omit the quote. Remove claims you cannot support and keep every qualification and conflict.`,
    };
  }
  // A read record whose quote did not match exactly keeps its sentence, flagged as a paraphrase; everything else is dropped.
  const soft = invalid.filter((v) => v.problem === 'quote_mismatch');
  const hard = invalid.filter((v) => v.problem !== 'quote_mismatch');
  const supported = [...verdicts.filter((v) => v.ok), ...soft];
  for (const v of supported) noteCited(ledger, v.citation.ref);
  let text = hard.length > 0 ? degradeAnswer(answer, hard) : answer;
  if (soft.length > 0 && text !== CITATION_FAILURE) text = `${text}\n\n${QUOTE_GAP_NOTE}`;
  return { action: 'partial', answer: stripMarkers(text), invalid };
}
