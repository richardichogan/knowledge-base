/**
 * services/todayUrgencyService.ts
 * Pure urgency-scoring functions for the Today ranked list.
 * No React, no side effects — safe to test in isolation.
 */

import type { DiscoverItem, SparkCluster } from '../services/api';

// ── Task type (mirrored from tasks domain) ────────────────────────────────────

/** Minimal task shape needed for urgency scoring. */
export interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  projectId: string;
}

// ── UrgencyItem ───────────────────────────────────────────────────────────────

/** Urgency item types that enter the ranked list. */
export type UrgencyItemType = 'task' | 'to-review' | 'spark-cluster';

/** A single ranked item with computed urgency score. */
export interface UrgencyItem {
  /** Source record ID. */
  id: string;
  /** What kind of item this is. */
  type: UrgencyItemType;
  /** Display title. */
  title: string;
  /** Final weighted score — higher means more urgent. */
  score: number;
  /** Days overdue / days since discovery / fixed 10 for clusters. */
  rawDays: number;
  /** Human-readable context line, e.g. "Overdue by 3 days". */
  contextLine: string;
  /** Original source record — use type narrowing on `type` to cast. */
  payload: Task | DiscoverItem | SparkCluster;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const TASK_CAP = 30;
const DISCOVER_CAP = 14;

/**
 * Compute urgency score for an overdue task.
 * Days overdue × 1.5, capped at 30 days (max score 45).
 */
export function taskUrgencyScore(dueDate: string): number {
  const diffMs = Date.now() - new Date(dueDate).getTime();
  const days = Math.max(0, Math.ceil(diffMs / MS_PER_DAY));
  return Math.min(days, TASK_CAP) * 1.5;
}

/**
 * Compute urgency score for a to-review Discover item.
 * Days since discovery × 1.0, capped at 14 days (max score 14).
 */
export function discoverUrgencyScore(publishedAt: string): number {
  const diffMs = Date.now() - new Date(publishedAt).getTime();
  const days = Math.max(0, Math.ceil(diffMs / MS_PER_DAY));
  return Math.min(days, DISCOVER_CAP) * 1.0;
}

/** Fixed urgency score for a spark cluster: 10 × 1.2 = 12. */
export function sparkClusterUrgencyScore(): number {
  return 12;
}

// ── List builder ──────────────────────────────────────────────────────────────

/**
 * Build a ranked list from all three source arrays, sorted by score desc.
 * Returns top `limit` items (default 10).
 *
 * @param tasks        All tasks from the API.
 * @param discoverItems Items in "to-review" state.
 * @param clusters     Undismissed spark clusters.
 * @param today        ISO date string "YYYY-MM-DD" representing today.
 * @param limit        Max items to return (default 10).
 */
export function buildRankedList(
  tasks: Task[],
  discoverItems: DiscoverItem[],
  clusters: SparkCluster[],
  today: string,
  limit = 10,
): UrgencyItem[] {
  const items: UrgencyItem[] = [];

  for (const t of tasks) {
    if (t.status === 'completed' || t.dueDate === null) continue;
    if (t.dueDate > today) continue;
    const score = taskUrgencyScore(t.dueDate);
    const rawDays = Math.max(0, Math.ceil((new Date(today).getTime() - new Date(t.dueDate).getTime()) / MS_PER_DAY));
    const contextLine = rawDays === 0 ? 'Due today' : `Overdue by ${rawDays} day${rawDays === 1 ? '' : 's'}`;
    items.push({ id: t.id, type: 'task', title: t.title, score, rawDays, contextLine, payload: t });
  }

  for (const d of discoverItems) {
    const score = discoverUrgencyScore(d.publishedAt);
    const rawDays = Math.max(0, Math.ceil((Date.now() - new Date(d.publishedAt).getTime()) / MS_PER_DAY));
    const contextLine = rawDays === 0 ? 'Discovered today' : `Discovered ${rawDays}d ago`;
    items.push({ id: d.id, type: 'to-review', title: d.title, score, rawDays, contextLine, payload: d });
  }

  for (const c of clusters) {
    items.push({
      id: c.id,
      type: 'spark-cluster',
      title: c.theme,
      score: sparkClusterUrgencyScore(),
      rawDays: 10,
      contextLine: `${c.sparkCount} sparks`,
      payload: c,
    });
  }

  return items.sort((a, b) => b.score - a.score).slice(0, limit);
}
