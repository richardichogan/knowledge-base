import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { fetchLearningSource } from './sources.js';
import { learningExplanation, LEARNING_LIMITS, type Evidence, type LearningQuestion } from './contracts.js';
import { learningProgress, type LearningTarget } from './progress.js';
import { ukClock } from '../sync/ukClock.js';
import { env } from '../config/env.js';

type Db = Pool | PoolClient;
const SESSION_STATUS = `CASE WHEN s.status='preparing' AND
  (SELECT j.status FROM agent_jobs j WHERE j.subject_type='learning-session' AND j.subject_id=s.id::text
   ORDER BY j.created_at DESC LIMIT 1)='failed' THEN 'failed' ELSE s.status END`;
export interface SessionRow {
  id: string; owner_id: string; status: 'preparing' | 'ready' | 'failed'; error: string | null; created_at: Date;
  question_count: number; daily_for: string | null; question_plan: LearningTarget[] | null;
}
export interface ItemRow {
  session_id: string; position: number; question_id: string; chosen: number | null; answered_at: Date | null; skipped: boolean;
  payload: LearningQuestion; status: 'ready' | 'held'; hold_reason: string | null;
}
export async function learningTransaction<T>(db: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function getLearningSession(db: Db, id: string, owner?: string): Promise<SessionRow> {
  const result = await db.query<SessionRow>(`SELECT s.*,to_char(s.daily_for,'YYYY-MM-DD') AS daily_for,${SESSION_STATUS} AS status FROM learning_sessions s WHERE s.id=$1 AND ($2::text IS NULL OR s.owner_id=$2)`, [id, owner ?? null]);
  if (!result.rows[0]) throw new NotFoundError('Learning session');
  return result.rows[0];
}
export async function createLearningSession(db: Pool, owner: string, dailyFor?: string): Promise<SessionRow> {
  return learningTransaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`learning:${owner}`]);
    const active = dailyFor
      ? await client.query<SessionRow>('SELECT * FROM learning_sessions WHERE owner_id=$1 AND daily_for=$2::date', [owner, dailyFor])
      : await client.query<SessionRow>(`SELECT s.* FROM learning_sessions s WHERE owner_id=$1
        AND (daily_for IS NULL OR daily_for<=$2::date)
        AND (status='preparing' OR (status='ready' AND EXISTS (SELECT 1 FROM learning_items i WHERE i.session_id=s.id AND chosen IS NULL AND NOT skipped)))
        ORDER BY (daily_for=$2::date) DESC NULLS LAST,created_at DESC LIMIT 1`, [owner, ukClock().day]);
    if (active.rows[0]) return active.rows[0];
    const result = await client.query<SessionRow>('INSERT INTO learning_sessions(id,owner_id,question_count,daily_for) VALUES($1,$2,10,$3::date) RETURNING *',
      [randomUUID(), owner, dailyFor ?? null]);
    return result.rows[0]!;
  });
}
export async function learningOverview(db: Pool, owner: string): Promise<unknown> {
  const rows = await db.query<{ id: string; status: string; error: string | null; createdAt: Date; total: number; answered: number; skipped: number; correct: number }>(
    `SELECT s.id,${SESSION_STATUS} AS status,s.error,s.created_at AS "createdAt",s.question_count AS total,to_char(s.daily_for,'YYYY-MM-DD') AS "dailyFor",
      COUNT(i.chosen)::int AS answered,COUNT(*) FILTER(WHERE i.skipped)::int AS skipped,
      COUNT(*) FILTER(WHERE i.chosen=(q.payload->>'correct')::int)::int AS correct
     FROM learning_sessions s LEFT JOIN learning_items i ON i.session_id=s.id
     LEFT JOIN learning_questions q ON q.id=i.question_id WHERE s.owner_id=$1
     GROUP BY s.id ORDER BY s.created_at DESC LIMIT 20`, [owner]);
  const today = ukClock().day;
  const daily = await db.query(`SELECT s.id,${SESSION_STATUS} AS status,s.error,s.question_count AS total,
    to_char(s.daily_for,'YYYY-MM-DD') AS "dailyFor" FROM learning_sessions s
    WHERE s.owner_id=$1 AND s.daily_for>=$2::date ORDER BY daily_for LIMIT 2`, [owner, today]);
  return { sessions: rows.rows, topics: await learningProgress(db, owner), daily: daily.rows,
    schedule: { time: '22:00', timezone: 'Europe/London', nights: 'Sunday–Thursday', automatic: env.isProduction } };
}
export async function learningSessionDetail(db: Pool, id: string, owner: string): Promise<unknown> {
  const session = await getLearningSession(db, id, owner);
  const result = await db.query<{ position: number; answered: boolean; skipped: boolean }>(
    `SELECT position,chosen IS NOT NULL AS answered,skipped FROM learning_items WHERE session_id=$1 ORDER BY position`, [id]);
  const incomplete = session.status === 'ready' && !await learningSessionHasAllQuestions(db, id)
    && result.rows.some(item => !item.answered && !item.skipped);
  return { id: session.id, status: incomplete ? 'failed' : session.status,
    error: incomplete ? `This session needs ${session.question_count} approved questions. Retry preparation to replace rejected drafts; saved answers will be preserved.` : session.error,
    questionCount: session.question_count, dailyFor: session.daily_for, items: result.rows };
}
export async function learningSessionHasAllQuestions(db: Db, id: string): Promise<boolean> {
  const result = await db.query<{ complete: boolean }>(`SELECT s.question_count=COUNT(*) FILTER(
    WHERE q.status='ready' AND i.position<s.question_count) AS complete FROM learning_sessions s
    LEFT JOIN learning_items i ON i.session_id=s.id LEFT JOIN learning_questions q ON q.id=i.question_id
    WHERE s.id=$1 GROUP BY s.id`, [id]);
  return result.rows[0]?.complete === true;
}
export async function getLearningItem(db: Db, id: string, position: number, owner: string): Promise<ItemRow> {
  const result = await db.query<ItemRow>(`SELECT i.*,q.payload,q.status,q.hold_reason FROM learning_items i
    JOIN learning_sessions s ON s.id=i.session_id JOIN learning_questions q ON q.id=i.question_id
    WHERE i.session_id=$1 AND i.position=$2 AND i.position<s.question_count AND s.owner_id=$3 AND s.status='ready'`, [id, position, owner]);
  if (!result.rows[0]) throw new NotFoundError('Learning question');
  return result.rows[0];
}
export async function checkLearningItem(db: Pool, item: ItemRow): Promise<{ checkedAt: string; reason: string | null }> {
  if (item.status === 'held') return { checkedAt: new Date().toISOString(), reason: item.hold_reason ?? 'This question has been withheld pending rechecking.' };
  try {
    learningExplanation(item.payload.explanation, 'Explanation', LEARNING_LIMITS.explanationChars);
    for (const option of item.payload.options) learningExplanation(option.explanation, 'Option explanation', LEARNING_LIMITS.optionExplanationChars);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    console.warn('[Learning] Saved explanation failed validation:', item.question_id, error.message);
    const reason = 'This saved explanation contains an ambiguous answer reference. The question is withheld pending correction.';
    await db.query("UPDATE learning_questions SET status='held',hold_reason=$2 WHERE id=$1", [item.question_id, reason]);
    return { checkedAt: new Date().toISOString(), reason };
  }
  try {
    const sources = await Promise.all(item.payload.sources.map(source => fetchLearningSource(source.url)));
    if (sources.some((source, index) => source.hash !== item.payload.sources[index]!.hash || source.url !== item.payload.sources[index]!.url)) {
      const reason = 'Official documentation has changed. This question is withheld pending rechecking.';
      await db.query("UPDATE learning_questions SET status='held',hold_reason=$2 WHERE id=$1", [item.question_id, reason]);
      return { checkedAt: new Date().toISOString(), reason };
    }
    // A report may have arrived while the source requests were in flight.
    const current = await db.query<{ status: string; hold_reason: string | null }>('SELECT status,hold_reason FROM learning_questions WHERE id=$1', [item.question_id]);
    return { checkedAt: new Date().toISOString(), reason: current.rows[0]?.status === 'ready' ? null : current.rows[0]?.hold_reason ?? 'This question is withheld.' };
  } catch (error) {
    console.error('[Learning] Official source check failed:', item.question_id, error);
    return { checkedAt: new Date().toISOString(), reason: 'Official sources could not be checked. The question is withheld for now; retry when they are available.' };
  }
}
export function requireChecked(check: { reason: string | null }): void {
  if (check.reason) throw new ConflictError(check.reason, 'LEARNING_WITHHELD');
}
export async function learningQuestionView(db: Pool, id: string, position: number, owner: string): Promise<unknown> {
  const item = await getLearningItem(db, id, position, owner);
  const check = await checkLearningItem(db, item);
  if (check.reason) return { blocked: true, reason: check.reason, position, chosen: item.chosen, skipped: item.skipped };
  const q = item.payload;
  const reviewed = item.chosen !== null;
  const messages = await db.query<{ id: string; question: string; answer: string; evidence: Evidence[]; checkedAt: Date }>(
    'SELECT id,question,answer,evidence,checked_at AS "checkedAt" FROM learning_messages WHERE session_id=$1 AND position=$2 ORDER BY created_at,id', [id, position]);
  return { blocked: false, position, questionId: item.question_id, topic: q.topic, category: q.category, level: q.level, ecosystem: q.ecosystem,
    question: q.question, options: q.options.map(option => option.text), chosen: item.chosen, skipped: item.skipped,
    sources: q.sources.map(source => ({ url: source.url, title: source.title })), checkedAt: check.checkedAt,
    review: reviewed ? { correct: q.correct, explanation: q.explanation, evidence: q.evidence,
      options: q.options.map(option => ({ explanation: option.explanation, evidence: option.evidence })) } : null,
    messages: reviewed ? messages.rows : [] };
}
export async function answerLearningQuestion(db: Pool, id: string, position: number, owner: string, chosen: unknown): Promise<void> {
  if (typeof chosen !== 'number' || !Number.isInteger(chosen) || chosen < 0 || chosen > LEARNING_LIMITS.maxAnswerIndex) throw new ValidationError('Choose one of the four answers.');
  const item = await getLearningItem(db, id, position, owner);
  requireChecked(await checkLearningItem(db, item));
  const result = await db.query(`UPDATE learning_items i SET chosen=$4,answered_at=NOW() FROM learning_questions q
    WHERE i.session_id=$1 AND i.position=$2 AND i.question_id=q.id AND q.status='ready' AND i.chosen IS NULL AND NOT i.skipped
    AND EXISTS(SELECT 1 FROM learning_sessions s WHERE s.id=i.session_id AND s.owner_id=$3) RETURNING i.position`, [id, position, owner, chosen]);
  if (!result.rowCount) throw new ConflictError('This answer was already submitted, skipped or withheld. Reload the question.', 'LEARNING_CHANGED');
}
export async function skipLearningQuestion(db: Pool, id: string, position: number, owner: string): Promise<void> {
  await getLearningItem(db, id, position, owner);
  await db.query('UPDATE learning_items SET skipped=TRUE WHERE session_id=$1 AND position=$2 AND chosen IS NULL', [id, position]);
}
export async function reportLearningQuestion(db: Pool, id: string, position: number, owner: string, reason: string): Promise<void> {
  const item = await getLearningItem(db, id, position, owner);
  await learningTransaction(db, async client => {
    await client.query('INSERT INTO learning_reports(id,session_id,position,reason) VALUES($1,$2,$3,$4)', [randomUUID(), id, position, reason]);
    await client.query("UPDATE learning_questions SET status='held',hold_reason='A learner reported this question. It is withheld pending rechecking.' WHERE id=$1", [item.question_id]);
  });
}
