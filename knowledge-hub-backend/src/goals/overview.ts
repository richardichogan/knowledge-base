/**
 * goals/overview.ts — one read model for the Today Goals panel and Athena's manage_goals tool, plus background starts
 * for the slow brief and scorecard generations so the UI can poll instead of holding a request open.
 */
import type { Pool } from 'pg';
import { goalsStatus, type GoalStatus } from './goals.js';
import { getGoalBrief, goalBriefRunning, refreshGoalBrief, type GoalBrief } from './brief.js';
import { getScorecard, refreshScorecard, scorecardRunning, type Scorecard } from './scorecard.js';
import { goalSettings, runGoalReview } from './goalReview.js';

export interface GoalsOverview {
  goals: GoalStatus[];
  brief: (GoalBrief & { current: boolean }) | null;
  scorecard: (Scorecard & { current: boolean; undoUntil: string | null }) | null;
  briefRunning: boolean; scorecardRunning: boolean;
  briefError: string | null; scorecardError: string | null;
  /** Monthly review: pending adjustments, effective measures, workstream/task links. */
  settings: Awaited<ReturnType<typeof goalSettings>>; reviewRunning: boolean; reviewError: string | null;
}

const errors: { brief: string | null; scorecard: string | null; review: string | null } = { brief: null, scorecard: null, review: null };
let review: Promise<unknown> | null = null;

export async function goalsOverview(db: Pool): Promise<GoalsOverview> {
  const [goals, brief, scorecard, settings] = await Promise.all([goalsStatus(db), getGoalBrief(db), getScorecard(db), goalSettings(db)]);
  return { goals, brief, scorecard, briefRunning: goalBriefRunning(), scorecardRunning: scorecardRunning(),
    briefError: errors.brief, scorecardError: errors.scorecard, settings, reviewRunning: review !== null, reviewError: errors.review };
}

/** Starts the goal review now (outside the monthly schedule) without waiting. */
export function startGoalReview(db: Pool, trigger: 'manual' | 'athena'): void {
  if (review) return;
  errors.review = null;
  review = runGoalReview(db, trigger).catch((error: unknown) => {
    errors.review = 'The goal review could not be run. Try again.';
    console.error('[Goals] review failed:', error);
  }).finally(() => { review = null; });
}

/** Starts a generation without waiting; failures are kept for the next overview read. */
export function startGoalGeneration(db: Pool, which: 'brief' | 'scorecard', trigger: 'manual' | 'athena'): void {
  errors[which] = null;
  const run = which === 'brief' ? refreshGoalBrief(db, trigger) : refreshScorecard(db, trigger);
  void run.catch((error: unknown) => {
    errors[which] = `The ${which === 'brief' ? 'Monday brief' : 'Friday scorecard'} could not be generated. Try again.`;
    console.error(`[Goals] ${which} generation failed:`, error);
  });
}
