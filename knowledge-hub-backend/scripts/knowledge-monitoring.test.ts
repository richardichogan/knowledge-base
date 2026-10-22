import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { classifyTurn, recordTurnAudit, looksAbstained, type TurnAuditRow, type TurnSignals } from '../src/ai/knowledge/turnAudit.js';
import { buildDailyReview, runKnowledgeNightlyReviewJob, yesterdayUtc } from '../src/jobs/knowledgeNightlyReviewJob.js';
import { getKnowledgeHealth, parseHealthQuery } from '../src/health/knowledgeHealth.js';

const base: TurnSignals = {
  retrievalUsed: true, deterministicPath: false, found: 3, read: 2, cited: 1, strippedIds: 0, unverifiedQuotes: 0, repairsUsed: 0,
  abstained: false, budgetExhausted: [], partial: false, toolErrorCount: 0, unavailableSources: [],
};
const ON = { KNOWLEDGE_ORCHESTRATION: 'true' } as NodeJS.ProcessEnv;
const row = (o: Partial<TurnAuditRow> = {}): TurnAuditRow => ({
  ...base, sessionId: 's1', assistantMessageId: null, persona: 'general', familiesRead: ['note'], durationMs: 120, modelRounds: 2, ...o,
});

async function migratedDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../src/db/migrations/092_knowledge_turn_audit.sql', import.meta.url), 'utf8'));
  return db;
}

test('classifier returns each category', () => {
  const cases: Array<[Partial<TurnSignals>, string]> = [
    [{}, 'ok'],
    [{ retrievalUsed: false, found: 0, read: 0, cited: 0 }, 'no_retrieval'],
    [{ read: 0, cited: 0 }, 'found_not_read'],
    [{ strippedIds: 1 }, 'bad_citation'],
    [{ repairsUsed: 1 }, 'bad_citation'],
    [{ unverifiedQuotes: 1 }, 'unverified_quote'],
    [{ abstained: true }, 'wrong_abstain'],
    [{ abstained: true, found: 0, read: 0, cited: 0 }, 'ok'],
    [{ budgetExhausted: ['wall_time'], partial: true }, 'budget_hit'],
    [{ unavailableSources: ['note'] }, 'source_unavailable'],
    [{ toolErrorCount: 1, unavailableSources: ['note'] }, 'tool_error'],
    [{ partial: true }, 'partial'],
    [{ retrievalUsed: false, deterministicPath: true }, 'ok'],
  ];
  for (const [over, expected] of cases) assert.equal(classifyTurn({ ...base, ...over }), expected, JSON.stringify(over));
  assert.equal(looksAbstained("I couldn't find anything about that."), true);
  assert.equal(looksAbstained('Here is the summary.'), false);
});

test('recorder never throws on DB failure and is skipped when the flag is off', async () => {
  const calls: unknown[][] = [];
  const failing = { query: async (): Promise<unknown> => { throw new Error('connection refused'); } };
  assert.equal(await recordTurnAudit(failing, row(), ON), false);
  const spy = { query: async (_sql: string, values?: unknown[]): Promise<unknown> => { calls.push(values ?? []); return {}; } };
  assert.equal(await recordTurnAudit(spy, row(), {} as NodeJS.ProcessEnv), false);
  assert.equal(calls.length, 0);
  assert.equal(await recordTurnAudit(spy, row({ strippedIds: 2 }), ON), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.at(-1), 'bad_citation');
});

test('recorder inserts a row through the real schema without storing text', async () => {
  const db = await migratedDb();
  assert.equal(await recordTurnAudit(db, row({ budgetExhausted: ['source_chars'], unavailableSources: ['note'] }), ON), true);
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM knowledge_turn_audit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['category'], 'source_unavailable');
  assert.deepEqual(rows[0]?.['families_read'], ['note']);
});

test('review flags follow the thresholds', () => {
  const mk = (category: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${category}${i.toString()}`, session_id: 's', category, duration_ms: i }));
  const low = buildDailyReview([...mk('ok', 3)]);
  assert.equal(low.flags.lowSample, true);
  const healthy = buildDailyReview(mk('ok', 100));
  assert.deepEqual(Object.values(healthy.flags), [false, false, false, false]);
  const atLimit = buildDailyReview([...mk('ok', 95), ...mk('bad_citation', 5)]);
  assert.equal(atLimit.flags.criticalRate, false);
  const critical = buildDailyReview([...mk('ok', 94), ...mk('bad_citation', 6)]);
  assert.equal(critical.flags.criticalRate, true);
  assert.equal(critical.worstTurns.length, 6);
  const noRet = buildDailyReview([...mk('ok', 89), ...mk('no_retrieval', 11)]);
  assert.equal(noRet.flags.noRetrievalRate, true);
  const abstain = buildDailyReview([...mk('ok', 94), ...mk('wrong_abstain', 6)]);
  assert.equal(abstain.flags.abstainWithEvidence, true);
  assert.equal(buildDailyReview([...mk('tool_error', 30)]).worstTurns.length, 10);
});

test('nightly job aggregates yesterday, upserts, and prunes rows older than 90 days', async () => {
  const db = await migratedDb();
  const now = new Date('2026-06-10T02:00:00Z');
  assert.equal(yesterdayUtc(now), '2026-06-09');
  const insert = (at: string, category: string) => db.query(
    'INSERT INTO knowledge_turn_audit (created_at, category, session_id) VALUES ($1, $2, $3)', [at, category, 'sess']);
  for (let i = 0; i < 6; i++) await insert('2026-06-09T10:00:00Z', 'ok');
  await insert('2026-06-09T11:00:00Z', 'bad_citation');
  await insert('2026-06-08T23:59:00Z', 'tool_error');
  await insert('2026-06-10T00:30:00Z', 'tool_error');
  await insert('2026-03-01T10:00:00Z', 'ok');
  const review = await runKnowledgeNightlyReviewJob(db as unknown as Pool, now);
  assert.equal(review.turns, 7);
  assert.equal(review.categoryCounts['bad_citation'], 1);
  assert.equal(review.flags.criticalRate, true);
  assert.equal(review.flags.lowSample, false);
  await runKnowledgeNightlyReviewJob(db as unknown as Pool, now);
  const reviews = await db.query<{ turns: number; worst_turns: Array<{ category: string }> }>('SELECT turns, worst_turns FROM knowledge_daily_review');
  assert.equal(reviews.rows.length, 1);
  assert.equal(reviews.rows[0]?.worst_turns[0]?.category, 'bad_citation');
  const left = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM knowledge_turn_audit');
  assert.equal(left.rows[0]?.n, 9);
});

test('health turnReview section is isolated and reports latest plus trend', async () => {
  const filters = parseHealthQuery({}, new Date('2026-06-10T10:00:00Z'));
  const empty = new PGlite();
  const missing = await getKnowledgeHealth(empty as unknown as Pool, filters, new Date('2026-06-10T10:00:00Z'));
  assert.equal(missing.turnReview.available, false);
  assert.equal(missing.usage.available, false);

  const db = await migratedDb();
  for (const day of ['2026-06-07', '2026-06-08', '2026-06-09']) {
    await db.query(`INSERT INTO knowledge_daily_review (review_date, turns, category_counts, rates, worst_turns, flags) VALUES ($1, 9, '{}', '{}', '[]', '{}')`, [day]);
  }
  const health = await getKnowledgeHealth(db as unknown as Pool, filters, new Date('2026-06-10T10:00:00Z'));
  assert.ok(health.turnReview.available);
  assert.equal(health.turnReview.data.latest?.reviewDate, '2026-06-09');
  assert.equal(health.turnReview.data.trend.length, 3);
});
