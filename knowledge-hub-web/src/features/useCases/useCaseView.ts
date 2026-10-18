/**
 * features/useCases/useCaseView.ts — pure helpers for the Plan "Use cases" view.
 */
import { CLOSED_STAGES, PRODUCT_KINDS, SOURCE_TYPE_LABELS, type ProductKind, type UseCase, type UseCaseSource, type UseCaseSourceRef, type UseCaseSourceType, type UseCaseStage } from '../../types/useCases';

export type StageFilter = 'active' | 'all' | UseCaseStage;
export type KindFilter = 'all' | ProductKind;

const CLOSED = CLOSED_STAGES;
const DAY_MS = 86_400_000;
const STALLED_DAYS = 14;
const SLUG_CHARS = 60;
const TITLE_CHARS = 200;
const LABEL_CHARS = 60;

export function filterUseCases(list: readonly UseCase[], f: { stage: StageFilter; kind: KindFilter; project: string }): UseCase[] {
  return list.filter((u) => (f.stage === 'all' || (f.stage === 'active' ? !CLOSED.includes(u.stage) : u.stage === f.stage))
    && (f.kind === 'all' || u.productKind === f.kind)
    && (f.project === '' || u.projectId === f.project));
}

/** Groups in product order, most recently updated first; empty groups are left out. */
export function groupByProduct(list: readonly UseCase[]): Array<{ kind: ProductKind; items: UseCase[] }> {
  return PRODUCT_KINDS
    .map((kind) => ({ kind, items: list.filter((u) => u.productKind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
    .filter((g) => g.items.length > 0);
}

/** "today", "1 day", "5 days", "3 weeks" since the last update. */
export function sinceLabel(iso: string, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));
  if (days === 0) return 'today';
  if (days < STALLED_DAYS) return days === 1 ? '1 day' : `${days.toString()} days`;
  return `${Math.floor(days / 7).toString()} weeks`;
}

/** Refining or spec-ready with no update for two weeks: the same rule as the backend's countStalled. */
export function isStalled(u: Pick<UseCase, 'stage' | 'updatedAt'>, now: number = Date.now()): boolean {
  return (u.stage === 'refining' || u.stage === 'spec_ready') && now - Date.parse(u.updatedAt) >= STALLED_DAYS * DAY_MS;
}

export function sourceHref(s: Pick<UseCaseSource, 'sourceType' | 'sourceId' | 'url'>): { href: string; external: boolean } | null {
  switch (s.sourceType) {
    case 'note': return { href: `/think?noteId=${encodeURIComponent(s.sourceId)}`, external: false };
    case 'canvas': return { href: `/think?mapId=${encodeURIComponent(s.sourceId)}`, external: false };
    case 'discover': return s.url !== null ? { href: s.url, external: true } : null;
    case 'spark': return null;
  }
}

export function slugify(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_CHARS).replace(/-+$/, '');
  return s === '' ? 'use-case' : s;
}

/** Mirrors the backend default so the handoff dialog can show the path before publishing. */
export function defaultHandoffPath(title: string, kind: ProductKind): string {
  return `${kind === 'product' ? 'docs/specs' : 'docs/prds'}/${slugify(title)}.md`;
}

const REF_SOURCE: Record<string, UseCaseSourceType> = { discover_item: 'discover', spark: 'spark', note: 'note', canvas: 'canvas' };

/** What a right-clicked item (data-ctx-ref-type / ref-id) contributes to a use case, or null if it cannot be a source. */
export function launchFromRef(refType: string | undefined, refId: string | undefined, title: string): { title: string; sources: UseCaseSourceRef[]; sourceLabel: string } | null {
  const sourceType = refType === undefined ? undefined : REF_SOURCE[refType];
  if (sourceType === undefined || refId === undefined || refId === '') return null;
  const clean = title.trim().replace(/\s+/g, ' ');
  return {
    title: clean.slice(0, TITLE_CHARS),
    sources: [{ sourceType, sourceId: refId }],
    sourceLabel: `${SOURCE_TYPE_LABELS[sourceType]} “${clean.length > LABEL_CHARS ? `${clean.slice(0, LABEL_CHARS)}…` : clean}”`,
  };
}

/** Today's one-line nudge about use cases that stopped moving, or null when there are none. */
export function stalledNudge(list: readonly Pick<UseCase, 'stage' | 'updatedAt'>[], now: number = Date.now()): string | null {
  const count = list.filter((u) => isStalled(u, now)).length;
  if (count === 0) return null;
  return count === 1 ? '1 use case has not moved in two weeks' : `${count.toString()} use cases have not moved in two weeks`;
}
