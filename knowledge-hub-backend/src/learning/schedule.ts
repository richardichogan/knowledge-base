import type { Pool } from 'pg';
import { ukClock } from '../sync/ukClock.js';
import { handOff } from '../agents/engine.js';
import { createLearningSession } from './store.js';

const PREPARATION_HOUR = 22;
const ISO_DATE_LENGTH = 10;
export function learningDailyDate(now = new Date()): string | null {
  const clock = ukClock(now);
  if (clock.hour < PREPARATION_HOUR || !['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(clock.weekday)) return null;
  const next = new Date(`${clock.day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, ISO_DATE_LENGTH);
}
export async function prepareDueLearning(db: Pool, now = new Date()): Promise<void> {
  const dailyFor = learningDailyDate(now);
  if (!dailyFor) return;
  const owners = await db.query<{ owner_id: string }>("SELECT DISTINCT owner_id FROM learning_sessions WHERE owner_id<>'dev-user'");
  for (const { owner_id: owner } of owners.rows) {
    try {
      const session = await createLearningSession(db, owner, dailyFor);
      if (session.status === 'ready') continue;
      const result = await handOff(db, { specialist: 'learning-question-writer', subjectId: session.id, requestedBy: 'app' });
      if (result.status === 'needs_confirmation') throw new Error(result.message);
      await db.query(`UPDATE learning_sessions SET status='preparing',error=NULL WHERE id=$1
        AND EXISTS(SELECT 1 FROM agent_jobs WHERE id=$2 AND status IN ('queued','running'))`, [session.id, result.job.id]);
    } catch (error) {
      console.error('[Learning] Nightly preparation could not be queued:', owner, dailyFor, error);
    }
  }
}
