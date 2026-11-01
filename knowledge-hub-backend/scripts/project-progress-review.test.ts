import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { validateProgressAssessment, type ProgressEvidence } from '../src/projects/progressReview.js';

const since = '2026-10-25T12:00:00.000Z';
const until = '2026-11-01T12:00:00.000Z';
const evidence: ProgressEvidence[] = [{
  id: 'note:one', kind: 'note', title: 'Workshop findings', href: '/think?noteId=one',
  content: 'Workshop identified an unresolved approval dependency.', updatedAt: '2026-10-30T12:00:00.000Z',
  truncated: false, role: 'current-context',
}];
const assessment = {
  summary: 'Learning advanced; delivery is not demonstrated.',
  progress: [{ text: 'A recorded workshop clarified the approval dependency.', evidenceIds: ['note:one'] }],
  activity: [],
  blockers: [{ text: 'Approval ownership remains unclear in the saved findings.', evidenceIds: ['note:one'] }],
  nextMove: { text: 'Confirm who can approve.', why: 'This resolves the documented dependency before further work.', evidenceIds: ['note:one'] },
};

test('review validation preserves supported findings and rejects invented or out-of-period evidence', () => {
  assert.deepEqual(validateProgressAssessment(assessment, evidence, since, until), assessment);
  for (const ids of [[], ['invented:id']]) {
    assert.throws(() => validateProgressAssessment({ ...assessment, progress: [{ text: 'Claim', evidenceIds: ids }] }, evidence, since, until));
  }
  for (const updatedAt of [since, '2026-11-02T12:00:00.000Z']) {
    assert.throws(() => validateProgressAssessment(assessment, [{ ...evidence[0]!, updatedAt }], since, until));
  }
  assert.throws(() => validateProgressAssessment({ ...assessment, nextMove: { ...assessment.nextMove, why: '' } }, evidence, since, until));
  assert.throws(() => validateProgressAssessment({ ...assessment, progress: Array(7).fill(assessment.progress[0]) }, evidence, since, until));
});

test('absence of evidence permits an honest uncertainty review, not invented progress', () => {
  const unknown = { ...assessment, summary: 'No linked evidence was retrieved.', progress: [], activity: [],
    blockers: [{ text: 'Progress cannot be assessed without saved evidence.', evidenceIds: [] }],
    nextMove: { text: 'Record the relevant project evidence.', why: 'It is needed to assess the saved direction.', evidenceIds: [] } };
  assert.deepEqual(validateProgressAssessment(unknown, [], since, until), unknown);
});

test('progress review migration retains dated history, deduplicates retries and respects project ownership', async () => {
  const db = new PGlite();
  const migration = readFileSync(new URL('../src/db/migrations/131_project_progress_reviews.sql', import.meta.url), 'utf8');
  try {
    await db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      INSERT INTO projects(id,updated_at) VALUES ('first','2026-11-01T12:00:00.123456Z'),('second',NOW());`);
    await db.exec(migration);
    const revision = (await db.query<{ revision: string }>("SELECT updated_at::text AS revision FROM projects WHERE id='first'")).rows[0]!.revision;
    assert.equal((await db.query("SELECT id FROM projects WHERE id='first' AND updated_at=$1::timestamptz", [revision])).rows.length, 1);
    assert.equal((await db.query("SELECT id FROM projects WHERE id='first' AND updated_at=$1::timestamptz", [new Date(revision).toISOString()])).rows.length, 0);
    const id = '00000000-0000-4000-8000-000000000001';
    const request = '00000000-0000-4000-8000-000000000002';
    await db.query('INSERT INTO project_progress_reviews(id,project_id,request_id,payload) VALUES($1,$2,$3,$4::jsonb)', [id, 'first', request, JSON.stringify(assessment)]);
    await db.exec(migration);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM project_progress_reviews')).rows[0]?.['n'], 1);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM project_progress_reviews WHERE project_id='second'")).rows[0]?.['n'], 0);
    await assert.rejects(db.query(`INSERT INTO project_progress_reviews(id,project_id,request_id,payload)
      VALUES('00000000-0000-4000-8000-000000000003','first',$1,'{}')`, [request]), /unique/);
    await assert.rejects(db.query(`INSERT INTO project_progress_reviews(id,project_id,request_id,payload)
      VALUES('00000000-0000-4000-8000-000000000004','missing',$1,'{}')`, [request]), /foreign key/);
    await assert.rejects(db.query(`UPDATE project_progress_reviews SET payload='[]' WHERE id=$1`, [id]), /check constraint/);
    await db.exec("DELETE FROM projects WHERE id='first'");
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM project_progress_reviews')).rows[0]?.['n'], 0);
  } finally { await db.close(); }
});
