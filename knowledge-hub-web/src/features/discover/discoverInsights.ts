/**
 * Turns Discover's internal scoring into things a reader can act on: a plain
 * relevance band instead of a number, the reasons an item was picked, and the
 * "since you last looked" briefing.
 */
import type { DiscoverItem } from '../../services/api';
import { DISCOVER_FORMATS } from '../../types/discover';

export type RelevanceBand = 'must-read' | 'worth-a-look' | 'background';

export const BAND_LABEL: Record<RelevanceBand, string> = {
  'must-read': 'Must read',
  'worth-a-look': 'Worth a look',
  background: 'Background',
};

// Calibrated against the live weighted-rank spread (roughly 60–135).
const MUST_READ_RANK = 1.1;
const WORTH_A_LOOK_RANK = 0.85;
const STANDOUT_RANK = 1.2;
const MAX_STANDOUTS = 6;

export function relevanceBand(item: DiscoverItem): RelevanceBand | null {
  if (item.rankScore == null) return null;
  if (item.rankScore >= MUST_READ_RANK) return 'must-read';
  if (item.rankScore >= WORTH_A_LOOK_RANK) return 'worth-a-look';
  return 'background';
}

const DAY_MS = 86_400_000;

function ageLabel(iso: string, now: number): string | null {
  const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  if (Number.isNaN(days) || days < 0) return null;
  if (days === 0) return 'Published today.';
  if (days === 1) return 'Published yesterday.';
  if (days <= 7) return `Published ${days.toString()} days ago.`;
  return null;
}

/** Plain-English reasons Athena ranked this item where it is. */
export function whyPicked(item: DiscoverItem, now = Date.now()): string[] {
  const reasons: string[] = [];
  const editorial = item.rankFactors?.editorial ?? item.relevanceScore;
  if (editorial != null && editorial >= 0.85) reasons.push('Strong match with your editorial priorities.');
  else if (editorial != null && editorial >= 0.7) reasons.push('Good match with your editorial priorities.');

  const hook = (item.sparkReason ?? '').trim();
  if (item.spark === true && hook !== '') reasons.push(`Specific hook: ${hook}`);

  const fits = [...(item.projectFit ?? [])].sort((a, b) => b.fit - a.fit);
  for (const fit of fits) {
    reasons.push(`${fit.fit === 2 ? 'Directly relevant to' : 'Useful background for'} ${fit.name}: ${fit.why}.`);
  }

  if (item.alreadyCovered === 1 && item.coveredBy) reasons.push(`A fresh angle on your piece “${item.coveredBy}”.`);
  if (item.alreadyCovered === 2 && item.coveredBy) reasons.push(`You’ve already made this argument in “${item.coveredBy}”, so it ranks lower.`);

  if ((item.rankFactors?.authority ?? 0) >= 1.15 && item.sourceAuthorityTier) {
    reasons.push(`Primary source (${item.sourceAuthorityTier}).`);
  }

  const age = ageLabel(item.publishedAt, now);
  if (age !== null) reasons.push(age);

  const strong = DISCOVER_FORMATS.filter((f) => (item.formatFit?.[f.id] ?? 0) === 3).map((f) => f.label);
  if (strong.length > 0) reasons.push(`Strong fit for: ${strong.join(', ')}.`);

  return reasons;
}

export interface DiscoverBriefing {
  assessed: number;
  /** Items that clear the relevance bar (new ones, or the current best on fallback). */
  relevantCount: number;
  /** The handful worth actually spending time on. */
  standouts: DiscoverItem[];
  /** Relevant enough to keep, but not standouts. */
  alsoRelevant: DiscoverItem[];
  busiest: Array<{ name: string; count: number }>;
  quiet: string[];
  /** True when nothing relevant arrived and the sections show the current best instead. */
  fallback: boolean;
}

/**
 * Builds the briefing from To Review items already ordered by weighted rank.
 * `tagName` resolves taxonomy ids to names.
 */
export function buildBriefing(
  items: DiscoverItem[],
  since: Date,
  tagName: (id: string) => string | undefined,
): DiscoverBriefing {
  const fresh = items.filter((i) => new Date(i.indexedAt).getTime() > since.getTime());
  const notable = (list: DiscoverItem[]): DiscoverItem[] => list.filter((i) => {
    const band = relevanceBand(i);
    return band === 'must-read' || band === 'worth-a-look';
  });
  const freshNotable = notable(fresh);
  const fallback = freshNotable.length === 0;
  const relevant = fallback ? notable(items) : freshNotable;
  const standoutPool = relevant.filter((i) => (i.rankScore ?? 0) >= STANDOUT_RANK);
  const standouts = (standoutPool.length > 0 ? standoutPool : relevant).slice(0, standoutPool.length > 0 ? MAX_STANDOUTS : 3);
  const standoutIds = new Set(standouts.map((i) => i.id));
  const alsoRelevant = relevant.filter((i) => !standoutIds.has(i.id));

  const topicCounts = new Map<string, number>();
  for (const item of freshNotable) {
    for (const id of item.taxonomyTagIds ?? []) {
      const name = tagName(id);
      if (name) topicCounts.set(name, (topicCounts.get(name) ?? 0) + 1);
    }
  }
  const busiest = [...topicCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const freshGroups = new Set(fresh.map((i) => i.sourceGroup).filter((g): g is string => !!g));
  const quiet = [...new Set(items.map((i) => i.sourceGroup).filter((g): g is string => !!g))]
    .filter((g) => !freshGroups.has(g))
    .sort();

  return { assessed: fresh.length, relevantCount: relevant.length, standouts, alsoRelevant, busiest, quiet, fallback };
}

const LAST_SEEN_KEY = 'kh.discover.lastSeenAt';
const PREVIOUS_SEEN_KEY = 'kh.discover.previousSeenAt';
const VISIT_GAP_MS = 30 * 60_000;
const DEFAULT_LOOKBACK_MS = 7 * DAY_MS;

/**
 * When the user last looked at Discover. A new visit only starts after 30
 * minutes away, so reloads don't reset the briefing to nothing.
 */
export function readSinceLastLooked(now = Date.now()): Date {
  try {
    const last = Number(localStorage.getItem(LAST_SEEN_KEY));
    const previous = Number(localStorage.getItem(PREVIOUS_SEEN_KEY));
    let since = previous > 0 ? previous : now - DEFAULT_LOOKBACK_MS;
    if (!(last > 0) || now - last > VISIT_GAP_MS) {
      since = last > 0 ? last : now - DEFAULT_LOOKBACK_MS;
      localStorage.setItem(PREVIOUS_SEEN_KEY, String(since));
    }
    localStorage.setItem(LAST_SEEN_KEY, String(now));
    return new Date(Math.max(since, now - 30 * DAY_MS));
  } catch {
    return new Date(now - DEFAULT_LOOKBACK_MS);
  }
}
