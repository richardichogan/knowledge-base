/**
 * goals/overview.ts — one read model for the Today Goals panel and Athena's manage_goals tool, plus background starts
 * for the slow brief and scorecard generations so the UI can poll instead of holding a request open.
 */
import type { Pool } from 'pg';
import { goalsStatus, type GoalStatus } from './goals.js';
import { getGoalBrief, goalBriefRunning, refreshGoalBrief, type GoalBrief } from './brief.js';
import { getScorecard, refreshScorecard, scorecardRunning, type Scorecard } from './scorecard.js';

export interface GoalsOverview {
  goals: GoalStatus[];
  brief: (GoalBrief & { current: boolean }) | null;
  scorecard: (Scorecard & { current: boolean; undoUntil: string | null }) | null;
  briefRunning: boolean; scorecardRunning: boolean;
  briefError: string | null; scorecardError: string | null;
}

const errors: { brief: string | null; scorecard: string | null } = { brief: null, scorecard: null };

export async function goalsOverview(db: Pool): Promise<GoalsOverview> {
  const [goals, brief, scorecard] = await Promise.all([goalsStatus(db), getGoalBrief(db), getScorecard(db)]);
  return { goals, brief, scorecard, briefRunning: goalBriefRunning(), scorecardRunning: scorecardRunning(),
    briefError: errors.brief, scorecardError: errors.scorecard };
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
