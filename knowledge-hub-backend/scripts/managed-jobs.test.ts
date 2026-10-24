import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { parseJob, readyToEnable, type JobDefinition, type JobRun } from '../src/jobs/contracts.js';
import { nextOccurrence, occurrences } from '../src/jobs/schedule.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/jobs';
process.env.BLOG_POSTS_API_KEY = 'fixture-not-a-secret';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/posts';
const store = await import('../src/jobs/store.js');
const { executeRun, step, UnconfirmedDelivery } = await import('../src/jobs/runner.js');
const { env } = await import('../src/config/env.js');
const migration = readFileSync(new URL('../src/db/migrations/099_managed_jobs.sql', import.meta.url), 'utf8');
const definition = (overrides: Partial<JobDefinition> = {}): JobDefinition => ({
  name: 'Fixture', kind: 'prompt', prompt: 'Summarise the saved evidence', schedule: { timezone: 'Europe/London', days: [0, 1, 2, 3, 4, 5, 6], times: ['06:00', '13:00'] },
  approval: 'required', deviceId: '', inputFolder: '', outputFolder: '', outputs: [], ...overrides,
});
async function fixture(): Promise<{ pg: PGlite; db: Pool }> {
  const pg = new PGlite();
  await pg.exec(migration);
  await pg.exec('CREATE TABLE sync_state(source TEXT PRIMARY KEY,last_cursor TEXT)');
  const query = async (sql: string, values?: unknown[]) => {
    const result = await pg.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const client = { query, release() {} };
  const db = { query, connect: async () => client } as unknown as Pool;
  return { pg, db };
}

test('job schedules use 06:00 and 13:00 UK with weekday and full-week choices', () => {
  const schedule = definition().schedule;
  assert.deepEqual(occurrences(schedule, new Date('2026-10-24T00:00Z'), new Date('2026-10-24T23:59Z')).map(d => d.toISOString()), ['2026-10-24T05:00:00.000Z', '2026-10-24T12:00:00.000Z']);
  assert.equal(nextOccurrence({ ...schedule, days: [1, 2, 3, 4, 5] }, new Date('2026-10-23T13:00Z')).toISOString(), '2026-10-26T06:00:00.000Z');
  assert.equal(nextOccurrence(schedule, new Date('2026-10-24T12:00Z')).toISOString(), '2026-10-25T06:00:00.000Z');
});
test('DST repeats once at the earlier instant and spring gaps move to the next valid minute', () => {
  const schedule = { timezone: 'Europe/London', days: [0], times: ['01:30'] };
  assert.deepEqual(occurrences(schedule, new Date('2026-10-25T00:00Z'), new Date('2026-10-25T04:00Z')).map(d => d.toISOString()), ['2026-10-25T00:30:00.000Z']);
  assert.equal(nextOccurrence(schedule, new Date('2026-10-25T00:45Z')).toISOString(), '2026-11-01T01:30:00.000Z');
  assert.equal(nextOccurrence(schedule, new Date('2026-03-28T23:00Z')).toISOString(), '2026-03-29T01:00:00.000Z');
});
test('typed actions reject invalid times, days, outputs and incomplete desktop access', () => {
  assert.throws(() => parseJob({ ...definition(), schedule: { timezone: 'Europe/London', days: [], times: ['06:00'] } }));
  assert.throws(() => parseJob({ ...definition(), schedule: { timezone: 'Europe/London', days: [1], times: ['25:00'] } }));
  assert.throws(() => parseJob(definition({ outputs: ['linkedin'] })));
  assert.throws(() => readyToEnable(definition({ kind: 'm365-import' })));
  assert.throws(() => parseJob(definition({ kind: 'm365-import', outputs: ['blog'] })));
  assert.deepEqual(parseJob(definition()), definition());
});
test('migration is idempotent and seeds only two daily content-sync times with publishing approval', async () => {
  const { pg, db } = await fixture();
  try {
    await pg.exec(migration);
    const jobs = await store.listJobs(db);
    assert.equal(jobs.length, 3);
    assert.deepEqual(jobs.find(j => j.definition.kind === 'content-sync')!.definition.schedule.times, ['06:00', '13:00']);
    assert.equal(jobs.find(j => j.definition.kind === 'weekly-microsoft')!.definition.approval, 'required');
    assert.equal(jobs.find(j => j.definition.kind === 'm365-import')!.enabled, false);
  } finally { await pg.close(); }
});
test('revision checks prevent chat and UI from overwriting one another and preserve audit revisions', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition(), false, 'fixture-user');
    const changed = await store.saveJob(db, job.id, job.revision, definition({ name: 'Updated' }), true, 'fixture-user');
    assert.equal(changed.revision, 2);
    await assert.rejects(store.saveJob(db, job.id, job.revision, definition(), false, 'stale-chat'), /changed/);
    assert.equal((await store.getJob(db, job.id)).definition.name, 'Updated');
    assert.equal((await pg.query('SELECT * FROM managed_job_revisions WHERE job_id=$1', [job.id])).rows.length, 2);
    assert.equal((await pg.query('SELECT * FROM managed_job_events WHERE job_id=$1', [job.id])).rows.length, 2);
  } finally { await pg.close(); }
});
test('late ticks coalesce backlog, produce one unique occurrence and move next run forward', async () => {
  const { pg, db } = await fixture();
  try {
    await pg.exec("UPDATE managed_jobs SET enabled=FALSE");
    const job = await store.saveJob(db, undefined, 0, definition(), true, 'user');
    await pg.query('UPDATE managed_jobs SET next_at=$2 WHERE id=$1', [job.id, '2026-10-20T05:00Z']);
    const now = new Date('2026-10-24T14:00Z');
    await store.scheduleDueJobs(db, now);
    await store.scheduleDueJobs(db, now);
    const result = await pg.query<{ scheduled_at: Date }>('SELECT * FROM managed_job_runs WHERE job_id=$1', [job.id]);
    assert.equal(result.rows.length, 1);
    assert.equal(new Date(result.rows[0]!.scheduled_at).toISOString(), '2026-10-24T12:00:00.000Z');
    assert.ok(new Date((await store.getJob(db, job.id)).nextAt!).getTime() > now.getTime());
  } finally { await pg.close(); }
});
test('unique leases exclude simultaneous worker/device claims and expired leases recover', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition(), true, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:lease-test', false, 'user');
    const claim = await store.leaseRun(db);
    assert.equal(claim?.run.id, run.id);
    assert.equal(await store.leaseRun(db), null);
    await assert.rejects(store.persistRun(db, run, randomUUID()), /lease expired/);
    await pg.query("UPDATE managed_job_runs SET status='running',lease_until=NOW()-INTERVAL '1 minute' WHERE id=$1", [run.id]);
    const recovered = await store.leaseRun(db);
    assert.equal(recovered!.run.id, run.id);
    assert.notEqual(recovered!.lease, claim!.lease);
    await assert.rejects(store.persistRun(db, run, claim!.lease), /lease expired/);
  } finally { await pg.close(); }
});
test('approval is bound to the saved run revision and edits invalidate pending approval', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ outputs: ['blog'] }), true, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:approval', false, 'user');
    await pg.query("UPDATE managed_job_runs SET status='awaiting-approval' WHERE id=$1", [run.id]);
    await store.saveJob(db, job.id, job.revision, definition({ name: 'Changed permissions' }), true, 'user');
    assert.equal((await store.getRun(db, run.id)).status, 'rejected');
    await assert.rejects(store.decideRun(db, run.id, true, 'user'), /no longer current/);
  } finally { await pg.close(); }
});
test('preview never posts, saves notes, writes files or asks for delivery approval', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ outputs: ['blog', 'linkedin', 'file'], deviceId: 'fixture', outputFolder: 'C:\\Reports' }), false, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:preview', true, 'user');
    const claim = await store.leaseRun(db);
    assert.ok(claim);
    const prepared: JobRun = { ...claim.run, artifacts: { markdown: 'Preview' }, steps: [{ key: 'generate', status: 'succeeded', startedAt: new Date().toISOString(), result: { markdown: 'Preview' } }] };
    await executeRun(db, prepared, claim.lease);
    assert.equal((await store.getRun(db, run.id)).status, 'succeeded');
    assert.equal((await store.getRun(db, run.id)).steps.length, 1);
  } finally { await pg.close(); }
});
test('required approval gates all external delivery and records the exact artifacts', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ outputs: ['blog'] }), true, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:gate', false, 'user');
    const claim = (await store.leaseRun(db))!;
    const artifacts = { markdown: 'Approved exact copy', blog: { title: 'Fixture post' } };
    claim.run.artifacts = artifacts;
    claim.run.steps = [{ key: 'generate', status: 'succeeded', startedAt: new Date().toISOString(), result: artifacts }];
    await executeRun(db, claim.run, claim.lease);
    assert.equal((await store.getRun(db, run.id)).status, 'awaiting-approval');
    assert.deepEqual((await store.getRun(db, run.id)).artifacts, artifacts);
    await store.releaseRun(db, run.id, claim.lease);
    await store.decideRun(db, run.id, true, 'user');
    assert.equal((await store.getRun(db, run.id)).status, 'queued');
    assert.ok((await store.getRun(db, run.id)).approvedAt);
  } finally { await pg.close(); }
});
test('successful steps are not repeated and uncertain publishing blocks automatic retries', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition(), true, 'user');
    await store.enqueue(db, job, new Date(), 'manual:steps', false, 'user');
    const claim = (await store.leaseRun(db))!;
    let calls = 0;
    const post = async () => { calls++; return { url: 'https://blog.fixture.invalid/post' }; };
    await step(db, claim.run, claim.lease, 'blog', post, true);
    await step(db, claim.run, claim.lease, 'blog', post, true);
    assert.equal(calls, 1);
    await assert.rejects(step(db, claim.run, claim.lease, 'linkedin', async () => { throw new UnconfirmedDelivery('timeout'); }, true), /timeout/);
    await assert.rejects(step(db, claim.run, claim.lease, 'linkedin', post, true), /Reconcile/);
    assert.equal(calls, 1);
    await assert.rejects(store.retryRun(db, claim.run.id, 'user'));
  } finally { await pg.close(); }
});
test('missing local files wait only until the next occurrence and are then audited as missed', async () => {
  const { pg, db } = await fixture();
  try {
    await pg.query('INSERT INTO managed_job_devices(id,name,folders) VALUES($1,$2,$3)', ['device-a', 'Fixture PC', JSON.stringify([{ path: 'C:\\Reports' }])]);
    const job = await store.saveJob(db, undefined, 0, definition({ kind: 'm365-import', deviceId: 'device-a', inputFolder: 'C:\\Reports' }), true, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:desktop', false, 'user');
    const claim = (await store.leaseRun(db))!;
    await executeRun(db, claim.run, claim.lease);
    await store.releaseRun(db, run.id, claim.lease);
    assert.equal((await store.getRun(db, run.id)).status, 'waiting-file');
    assert.equal(await store.leaseRun(db, 'device-b'), null);
    assert.ok(await store.leaseRun(db, 'device-a'));
    await pg.query('UPDATE managed_job_runs SET lease=NULL,lease_until=NULL WHERE id=$1', [run.id]);
    await store.scheduleDueJobs(db, new Date(new Date(run.deadline).getTime() + 60000));
    assert.equal((await store.getRun(db, run.id)).status, 'missed');
  } finally { await pg.close(); }
});

test('blog URL gates socials; a partial social failure resumes without reposting the blog or successful social', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ approval: 'automatic', outputs: ['blog', 'bluesky', 'linkedin'] }), true, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:publish', false, 'user');
    const claim = (await store.leaseRun(db))!;
    const artifacts = { markdown: 'Fixture', blog: { title: 'A practical update', summary: 'A useful change.', content: '<p>A practical change for administrators.</p>',
      categories: [], tags: [], keyTakeaways: [], excerpt: '', postType: 'article', status: 'published' },
    bluesky: 'A practical update.', linkedin: 'A practical update for administrators.', linkedinAccount: { id: 'member' },
    publishTargets: { blogHost: new URL(env.BLOG_POSTS_URL).host, blueskyAccount: env.BLUESKY_IDENTIFIER ?? '(not connected)' } };
    claim.run.artifacts = artifacts;
    claim.run.steps = [{ key: 'generate', status: 'succeeded', startedAt: new Date().toISOString(), result: artifacts }];
    const counts = { blog: 0, bluesky: 0, linkedin: 0 };
    const url = 'https://published.fixture.invalid/update';
    const delivery = {
      blog: async () => { counts.blog++; return { httpStatus: 200, payload: { success: true as const, data: { url, editUrl: null, status: 'published' as const } } }; },
      bluesky: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); counts.bluesky++; return { uri: 'fixture-uri', url: 'https://bsky.app/fixture' }; },
      linkedin: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); counts.linkedin++; if (counts.linkedin === 1) throw new Error('Definite rejection'); return { urn: 'fixture-urn', url: 'https://www.linkedin.com/fixture' }; },
    };
    await executeRun(db, claim.run, claim.lease, delivery);
    assert.equal((await store.getRun(db, run.id)).status, 'partial');
    await store.releaseRun(db, run.id, claim.lease);
    await store.retryRun(db, run.id, 'user');
    const retry = (await store.leaseRun(db))!;
    await executeRun(db, retry.run, retry.lease, delivery);
    assert.equal((await store.getRun(db, run.id)).status, 'succeeded');
    assert.deepEqual(counts, { blog: 1, bluesky: 1, linkedin: 2 });
  } finally { await pg.close(); }
});
test('a blog response with no public URL becomes unconfirmed and neither social channel runs', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ approval: 'automatic', outputs: ['blog', 'bluesky'] }), true, 'user');
    await store.enqueue(db, job, new Date(), 'manual:no-url', false, 'user');
    const claim = (await store.leaseRun(db))!;
    claim.run.artifacts = { markdown: 'Fixture', blog: { title: 'Practical update', summary: 'A useful change.', content: '<p>Administrators can use this.</p>', status: 'published' },
      publishTargets: { blogHost: new URL(env.BLOG_POSTS_URL).host } };
    claim.run.steps = [{ key: 'generate', status: 'succeeded', startedAt: new Date().toISOString(), result: claim.run.artifacts }];
    const neverSocial = async (): Promise<never> => { assert.fail('Social must not run without a public blog URL.'); };
    await executeRun(db, claim.run, claim.lease, {
      blog: async () => ({ httpStatus: 200, payload: { success: true, data: { url: null, editUrl: null, status: 'published' } } }),
      bluesky: neverSocial, linkedin: neverSocial,
    });
    assert.equal((await store.getRun(db, claim.run.id)).status, 'unconfirmed');
    assert.equal(claim.run.steps.find(s => s.key === 'blog')!.status, 'unconfirmed');
  } finally { await pg.close(); }
});
