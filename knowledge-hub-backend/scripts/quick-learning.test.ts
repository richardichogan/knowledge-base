import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { evidence, learningExplanation, parseQuestion, sourcePassages, type LearningSource } from '../src/learning/contracts.js';
import { learningSourceHash, officialDocumentationUrl, LEARNING_TOPICS, learningTopicId } from '../src/learning/sources.js';
import { learningProgress, learningTopicHistory, planLearningQuestions, type TopicProgress } from '../src/learning/progress.js';
import { learningDailyDate } from '../src/learning/schedule.js';
import { createLearningSession, getLearningItem, learningSessionDetail, learningSessionHasAllQuestions } from '../src/learning/store.js';

const source: LearningSource = {
  url: 'https://docs.github.com/en/example', title: 'Fixture official documentation',
  text: 'The documented example is explicitly supported. The alternative requires an additional approval.',
  hash: 'fixture', checkedAt: '2026-10-30T00:00:00Z',
};
const refs = [{ source: 0, passage: 0 }];
const candidate = {
  topic: 'Example', question: 'Which choice follows the documented guidance?', correct: 2,
  explanation: 'The documented example follows the explicitly supported guidance.', evidence: refs,
  options: ['First choice', 'Second choice', 'Documented example', 'Fourth choice'].map(value =>
    ({ text: value, explanation: 'Fixture explanation for validation only.', evidence: refs })),
};
test('learning admission requires four distinct answers, one valid key and exact official evidence', () => {
  assert.equal(parseQuestion(candidate, [source], 'strategy', 'practitioner', 'GitHub').correct, 2);
  assert.throws(() => parseQuestion({ ...candidate, correct: 4 }, [source], 'strategy', 'practitioner', 'GitHub'), /exactly one/);
  assert.throws(() => parseQuestion({ ...candidate, options: candidate.options.slice(1) }, [source], 'strategy', 'practitioner', 'GitHub'), /four options/);
  assert.throws(() => parseQuestion({ ...candidate, options: candidate.options.map(() => candidate.options[0]) },
    [source], 'strategy', 'practitioner', 'GitHub'), /distinct/);
  assert.throws(() => evidence([], [source]), /require/);
  assert.throws(() => evidence([{ source: 0, passage: 99 }], [source]), /missing/);
  assert.throws(() => evidence([{ source: 1, passage: 0 }], [source]), /valid/);
  assert.throws(() => evidence([{ source: 0, quote: 'A model-supplied quotation cannot establish provenance.' }], [source]), /valid/);
  assert.deepEqual(evidence(refs, [source]), [{ source: 0, quote: source.text }], 'quotations come from actual fetched text, not model output');
});
test('numbered learning passages cover the full source without fabricated text', () => {
  const original = 'A documented constraint. '.repeat(200);
  const passages = sourcePassages(original);
  assert.ok(passages.length > 1);
  assert.deepEqual(passages.map(p => p.id), passages.map((_, index) => index));
  assert.equal(passages.map(p => p.text).join(' ').trim(), original.trim());
  for (const passage of passages) assert.ok(original.includes(passage.text));
});
test('learner explanations cannot leak internal answer indices or ambiguous positional labels', () => {
  for (const explanation of ['Option 2 is correct.', 'Answer 0 follows the guidance.', 'Choice B is correct.',
    'The third option is supported.', 'The 2nd answer is wrong.', 'Option number 3 is correct.']) {
    assert.throws(() => learningExplanation(explanation, 'Explanation', 3500), /identify answers by their content/);
    assert.throws(() => parseQuestion({ ...candidate, explanation }, [source], 'strategy', 'practitioner', 'GitHub'), /identify answers by their content/);
  }
  assert.throws(() => parseQuestion({ ...candidate, options: candidate.options.map(option => ({ ...option, explanation: 'Option 2 is wrong.' })) },
    [source], 'strategy', 'practitioner', 'GitHub'), /identify answers by their content/);
  assert.equal(learningExplanation('Start with business scenarios to prioritise outcomes.', 'Explanation', 3500),
    'Start with business scenarios to prioritise outcomes.');
});
test('learning sources accept only exact official documentation hosts and secure URLs', () => {
  assert.equal(officialDocumentationUrl('https://learn.microsoft.com/en-us/azure/#reference'), 'https://learn.microsoft.com/en-us/azure/');
  for (const url of ['http://docs.github.com/en/example', 'https://docs.github.com.evil.invalid/en/example',
    'https://example.com/en/example', 'https://user:secret@docs.github.com/en/example', 'https://docs.github.com:8443/en/example']) {
    assert.throws(() => officialDocumentationUrl(url));
  }
});
test('learning source changes ignore presentation whitespace but never changed wording', () => {
  assert.equal(learningSourceHash('A documented fact.\n\nA constraint.'), learningSourceHash('A documented fact. A constraint.'));
  assert.notEqual(learningSourceHash('A documented fact.'), learningSourceHash('An unsupported assertion.'));
});
const emptyProgress = (): TopicProgress[] => LEARNING_TOPICS.map(topic => ({
  id: topic.id, label: topic.label, ecosystem: topic.ecosystem, answered: 0, correct: 0, accuracy: null,
  recentAnswered: 0, recentCorrect: 0, recentAccuracy: null, lastAnsweredAt: null,
}));
test('ten-question plans balance cold-start coverage and target six weak-area questions only with sufficient history', () => {
  const progress = emptyProgress();
  const initial = planLearningQuestions(progress, 10, 4);
  assert.equal(initial.length, 10);
  assert.equal(new Set(initial.map(item => item.topicId)).size, 10);
  assert.equal(initial.filter(item => item.ecosystem === 'GitHub').length, 4);
  assert.equal(initial.filter(item => item.focus === 'practice').length, 0);
  Object.assign(progress[2]!, { answered: 2, correct: 0, recentAnswered: 2, recentCorrect: 0, recentAccuracy: 0 });
  assert.equal(planLearningQuestions(progress, 10, 0).filter(item => item.focus === 'practice').length, 0);
  Object.assign(progress[2]!, { answered: 3, recentAnswered: 3 });
  const adapted = planLearningQuestions(progress, 10, 0);
  assert.equal(adapted.filter(item => item.focus === 'practice' && item.topicId === 'zero-trust').length, 6);
  assert.equal(adapted.filter(item => item.focus === 'breadth').length, 4);
  assert.equal(new Set(adapted.filter(item => item.focus === 'breadth').map(item => item.topicId)).size, 4);
  assert.equal(planLearningQuestions(progress, 5, 0).length, 5, 'legacy sessions retain their size');
  Object.assign(progress[2]!, { recentCorrect: 3, recentAccuracy: 100 });
  assert.equal(planLearningQuestions(progress, 10, 0).filter(item => item.focus === 'practice').length, 0, 'recovered topics do not remain weak forever');
});
test('nightly learning uses 22:00 UK time Sunday–Thursday with correct DST boundaries', () => {
  for (const [at, expected] of [
    ['2026-10-25T21:59:59Z', null], ['2026-10-25T22:00:00Z', '2026-10-26'],
    ['2026-07-12T20:59:59Z', null], ['2026-07-12T21:00:00Z', '2026-07-13'],
    ['2026-07-16T21:00:00Z', '2026-07-17'], ['2026-07-17T21:00:00Z', null],
    ['2026-07-18T21:00:00Z', null], ['2026-07-19T22:45:00Z', '2026-07-20'],
    ['2026-03-29T21:00:00Z', '2026-03-30'],
  ] as const) assert.equal(learningDailyDate(new Date(at)), expected, at);
});
test('topic identities come from the catalog, including existing questions without model-provided IDs', () => {
  const topic = LEARNING_TOPICS[2]!;
  assert.equal(learningTopicId({ sources: [{ url: topic.url }] }), 'zero-trust');
  assert.equal(learningTopicId({ topicId: 'made-up', sources: [{ url: `${topic.url}/` }] }), 'zero-trust');
  assert.equal(learningTopicId({ sources: [{ url: 'https://docs.github.com/en/copilot/get-started/about-github-copilot' }] }), 'github-copilot');
  assert.equal(learningTopicId({ sources: [{ url: 'https://docs.github.com/en/enterprise-cloud@latest/admin/concepts/enterprise-fundamentals/enterprise-accounts' }] }), 'github-enterprise');
  assert.throws(() => learningTopicId({ sources: [{ url: 'https://docs.github.com/en/example' }] }), /recognised/);
});
test('daily persistence, ten-question migration and per-owner topic history work in isolated PostgreSQL', async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const pool = new Pool({ connectionString: 'postgresql://isolated.invalid/learning' });
  t.after(async () => { await pg.close(); await pool.end(); });
  await pg.exec(await readFile(new URL('../src/db/migrations/121_quick_learning.sql', import.meta.url), 'utf8'));
  const legacy = randomUUID();
  await pg.query('INSERT INTO learning_sessions(id,owner_id) VALUES($1,$2)', [legacy, 'learner']);
  await pg.exec(await readFile(new URL('../src/db/migrations/122_learning_daily_progress.sql', import.meta.url), 'utf8'));
  await pg.exec('CREATE TABLE agent_jobs(id UUID PRIMARY KEY,subject_type TEXT,subject_id TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT now())');
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    const result = await pg.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows };
  };
  t.mock.method(pool, 'query', query);
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }));
  const manual = await createLearningSession(pool, 'learner');
  assert.equal(manual.question_count, 5, 'unfinished legacy session is resumed unchanged');
  const daily = await createLearningSession(pool, 'learner', '2026-11-02');
  assert.equal(daily.question_count, 10);
  assert.equal((await createLearningSession(pool, 'learner', '2026-11-02')).id, daily.id, 'scheduler ticks cannot duplicate a daily test');
  assert.notEqual((await createLearningSession(pool, 'other', '2026-11-02')).id, daily.id, 'daily tests are owner-scoped');
  await assert.rejects(() => pg.query('INSERT INTO learning_items(session_id,position,question_id) VALUES($1,10,$2)', [daily.id, randomUUID()]), /check constraint/);
  const question = { ...parseQuestion(candidate, [source], 'strategy', 'practitioner', 'GitHub'), topicId: 'zero-trust' };
  const inserted = [];
  for (let position = 0; position < 10; position++) {
    const id = randomUUID(); inserted.push(id);
    await pg.query('INSERT INTO learning_questions(id,payload) VALUES($1,$2)', [id, JSON.stringify(question)]);
    await pg.query(`INSERT INTO learning_items(session_id,position,question_id,chosen,answered_at)
      VALUES($1,$2,$3,$4,$5)`, [daily.id, position, id, position < 4 ? question.correct : 0, new Date(Date.UTC(2026, 10, 2, 9, position))]);
  }
  assert.equal(await learningSessionHasAllQuestions(pool, daily.id), true);
  await pg.query("UPDATE learning_sessions SET status='ready' WHERE id=$1", [daily.id]);
  assert.equal((await learningSessionDetail(pool, daily.id, 'learner') as { questionCount: number }).questionCount, 10);
  assert.equal((await getLearningItem(pool, daily.id, 9, 'learner')).position, 9);
  await assert.rejects(() => getLearningItem(pool, daily.id, 9, 'other'), /not found/);
  const progress = (await learningProgress(pool, 'learner')).find(topic => topic.id === 'zero-trust')!;
  assert.equal(progress.answered, 10); assert.equal(progress.correct, 4); assert.equal(progress.recentAccuracy, 40);
  assert.equal((await learningProgress(pool, 'other')).find(topic => topic.id === 'zero-trust')!.answered, 0);
  const history = await learningTopicHistory(pool, 'learner', 'zero-trust', 0) as { answers: { position: number; correct: boolean }[]; hasMore: boolean };
  assert.equal(history.answers.length, 10); assert.equal(history.answers[0]!.position, 9); assert.equal(history.hasMore, false);
  await pg.query("UPDATE learning_questions SET status='held' WHERE id=$1", [inserted[0]]);
  assert.equal(await learningSessionHasAllQuestions(pool, daily.id), false);
  const heldProgress = (await learningProgress(pool, 'learner')).find(topic => topic.id === 'zero-trust')!;
  assert.equal(heldProgress.answered, 10, 'historical scores survive withdrawal');
  assert.equal(heldProgress.recentAnswered, 9, 'withdrawn questions do not affect adaptive ranking');
});
