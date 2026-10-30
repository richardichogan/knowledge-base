import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import { LEARNING_TOPICS, TOPIC_SOURCE_MAP, type LearningTopicId } from './sources.js';
import { LEARNING_LIMITS, type LearningQuestion } from './contracts.js';

const ANSWERS = `SELECT i.session_id,i.position,i.answered_at,q.status,q.payload,i.chosen,
  i.chosen=(q.payload->>'correct')::int AS correct,
  COALESCE(q.payload->>'topicId',$2::jsonb->>rtrim(q.payload->'sources'->0->>'url','/')) AS topic_id
  FROM learning_items i JOIN learning_sessions s ON s.id=i.session_id JOIN learning_questions q ON q.id=i.question_id
  WHERE s.owner_id=$1 AND i.chosen IS NOT NULL`;
export interface TopicProgress {
  id: LearningTopicId; label: string; ecosystem: string; answered: number; correct: number; accuracy: number | null;
  recentAnswered: number; recentCorrect: number; recentAccuracy: number | null; lastAnsweredAt: string | null;
}
export async function learningProgress(db: Pool, owner: string): Promise<TopicProgress[]> {
  const result = await db.query<{ topic_id: string; answered: number; correct: number; recent_answered: number;
    recent_correct: number; last_answered: Date }>(`WITH answers AS (${ANSWERS}), ranked AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY topic_id ORDER BY answered_at DESC,session_id,position) AS recent
      FROM answers WHERE status='ready'
    ) SELECT a.topic_id,COUNT(*)::int AS answered,COUNT(*) FILTER(WHERE a.correct)::int AS correct,
      (SELECT COUNT(*)::int FROM ranked r WHERE r.topic_id=a.topic_id AND recent<=10) AS recent_answered,
      (SELECT COUNT(*)::int FROM ranked r WHERE r.topic_id=a.topic_id AND recent<=10 AND r.correct) AS recent_correct,
      MAX(a.answered_at) AS last_answered FROM answers a GROUP BY a.topic_id`, [owner, JSON.stringify(TOPIC_SOURCE_MAP)]);
  return LEARNING_TOPICS.map(topic => {
    const row = result.rows.find(item => item.topic_id === topic.id);
    const answered = row?.answered ?? 0;
    const recentAnswered = row?.recent_answered ?? 0;
    return { id: topic.id, label: topic.label, ecosystem: topic.ecosystem, answered, correct: row?.correct ?? 0,
      accuracy: answered ? Math.round((row?.correct ?? 0) * LEARNING_LIMITS.percent / answered) : null,
      recentAnswered, recentCorrect: row?.recent_correct ?? 0,
      recentAccuracy: recentAnswered ? Math.round((row?.recent_correct ?? 0) * LEARNING_LIMITS.percent / recentAnswered) : null,
      lastAnsweredAt: row?.last_answered?.toISOString() ?? null };
  });
}
export async function learningTopicHistory(db: Pool, owner: string, topic: string, offset: number): Promise<unknown> {
  if (!LEARNING_TOPICS.some(item => item.id === topic)) throw new ValidationError('Unknown learning topic.');
  const result = await db.query<{ session_id: string; position: number; answered_at: Date; payload: LearningQuestion;
    chosen: number; correct: boolean; status: string }>(`WITH answers AS (${ANSWERS})
    SELECT * FROM answers WHERE topic_id=$3 ORDER BY answered_at DESC,session_id,position LIMIT 21 OFFSET $4`,
  [owner, JSON.stringify(TOPIC_SOURCE_MAP), topic, offset]);
  return { answers: result.rows.slice(0, LEARNING_LIMITS.historyPage).map(row => ({
    sessionId: row.session_id, position: row.position, answeredAt: row.answered_at, question: row.payload.question,
    category: row.payload.category, level: row.payload.level, correct: row.correct, withdrawn: row.status !== 'ready',
    chosenAnswer: row.payload.options[row.chosen]!.text, correctAnswer: row.payload.options[row.payload.correct]!.text,
  })), hasMore: result.rows.length > LEARNING_LIMITS.historyPage };
}
export interface LearningTarget {
  topicId: LearningTopicId; ecosystem: LearningQuestion['ecosystem']; category: LearningQuestion['category'];
  level: LearningQuestion['level']; focus: 'practice' | 'breadth';
}
export function planLearningQuestions(progress: TopicProgress[], count: number, rotation: number): LearningTarget[] {
  const weak = progress.filter(topic => topic.recentAnswered >= LEARNING_LIMITS.minimumHistory && topic.recentCorrect < topic.recentAnswered)
    .sort((a, b) => a.recentCorrect / a.recentAnswered - b.recentCorrect / b.recentAnswered
      || (a.lastAnsweredAt ?? '').localeCompare(b.lastAnsweredAt ?? '') || a.id.localeCompare(b.id));
  const focusCount = weak.length ? Math.round(count * LEARNING_LIMITS.focusFraction) : 0;
  const broad = [...LEARNING_TOPICS].sort((a, b) => {
    const ap = progress.find(topic => topic.id === a.id);
    const bp = progress.find(topic => topic.id === b.id);
    return (ap?.answered ?? 0) - (bp?.answered ?? 0)
      || (ap?.lastAnsweredAt ?? '').localeCompare(bp?.lastAnsweredAt ?? '')
      || ((LEARNING_TOPICS.indexOf(a) + rotation) % LEARNING_TOPICS.length)
        - ((LEARNING_TOPICS.indexOf(b) + rotation) % LEARNING_TOPICS.length);
  });
  const breadth = broad.filter(topic => !weak.slice(0, focusCount).some(item => item.id === topic.id));
  const choices = breadth.length ? breadth : broad;
  const categories: LearningQuestion['category'][] = ['strategy', 'enablement', 'product'];
  const levels: LearningQuestion['level'][] = ['practitioner', 'foundation', 'practitioner', 'advanced'];
  return Array.from({ length: count }, (_, index) => {
    const practice = index < focusCount;
    const id = practice ? weak[index % weak.length]!.id : choices[(index - focusCount) % choices.length]!.id;
    const topic = LEARNING_TOPICS.find(item => item.id === id)!;
    return { topicId: topic.id, ecosystem: topic.ecosystem, category: categories[index % categories.length]!,
      level: levels[index % levels.length]!, focus: practice ? 'practice' : 'breadth' };
  });
}
