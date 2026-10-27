import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { parseJob, readyToEnable, type JobDefinition, type JobRun } from '../src/jobs/contracts.js';
import { nextOccurrence, occurrences } from '../src/jobs/schedule.js';
import { addPublishingSchema } from './publishing-fixture.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/jobs';
process.env.BLOG_POSTS_API_KEY = 'fixture-not-a-secret';
process.env.BLOG_POSTS_URL = 'https://blog.fixture.invalid/posts';
const store = await import('../src/jobs/store.js');
const { executeRun, step, UnconfirmedDelivery, completedSyncWithSourceErrors } = await import('../src/jobs/runner.js');
const { reviewWeeklyJob } = await import('../src/jobs/editorial.js');
const { materializeWeeklyPackage, parseWeeklyPackage } = await import('../src/jobs/weeklyPackage.js');
const { blogLinkForCopyBudget } = await import('../src/services/blogPublisher.js');
const { blueskyCopyAllowance, composeBlueskyText } = await import('../src/integrations/social/bluesky.js');
const { applyEditorialEdits } = await import('../src/publishing/editorial.js');
const { env } = await import('../src/config/env.js');
const migration = readFileSync(new URL('../src/db/migrations/099_managed_jobs.sql', import.meta.url), 'utf8');
const definition = (overrides: Partial<JobDefinition> = {}): JobDefinition => ({
  name: 'Fixture', kind: 'prompt', prompt: 'Summarise the saved evidence', schedule: { timezone: 'Europe/London', days: [0, 1, 2, 3, 4, 5, 6], times: ['06:00', '13:00'] },
  approval: 'required', deviceId: '', inputFolder: '', outputFolder: '', outputs: [], ...overrides,
});
async function fixture(): Promise<{ pg: PGlite; db: Pool }> {
  const pg = new PGlite();
  await pg.exec(migration);
  await addPublishingSchema(pg);
  await pg.exec('CREATE TABLE sync_state(source TEXT PRIMARY KEY,last_cursor TEXT)');
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    const result = await pg.query(sql, values);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  };
  const client = { query, release() {} };
  const db = { query, connect: async () => client } as unknown as Pool;
  return { pg, db };
}

test('sync completion preserves partial source success but not a total outage', () => {
  const result = { totalIndexed: 1799, totalErrors: 11, totalDurationMs: 100,
    results: [{ source: 'feeds', indexed: 16, errors: 2, durationMs: 50 }, { source: 'cms', indexed: 94, errors: 0, durationMs: 50 }] };
  assert.equal(completedSyncWithSourceErrors(result), true);
  assert.equal(completedSyncWithSourceErrors({ ...result, totalIndexed: 0 }), true);
  assert.equal(completedSyncWithSourceErrors({ ...result, totalIndexed: 0, results: [{ source: 'feeds', indexed: 0, errors: 2, durationMs: 50 }] }), false);
  assert.equal(completedSyncWithSourceErrors({ ...result, totalErrors: 0 }), false);
});
test('weekly accuracy and voice checks start together and settle before saving', { timeout: 5000 }, async () => {
  const { pg, db } = await fixture();
  try {
    let release!: () => void;
    const accuracy = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    let saved = false;
    const passed = await reviewWeeklyJob(db, { markdown: 'Microsoft updated Azure.', sources: [] }, '',
      async () => { assert.deepEqual(started, ['accuracy', 'voice']); saved = true; }, {
        preferences: async () => '',
        chat: async system => {
          if (system.includes('Perform the accuracy')) { started.push('accuracy'); await accuracy; }
          else { started.push('voice'); assert.equal(saved, false); release(); }
          return { outcome: 'pass', findings: [] };
        },
      });
    assert.equal(passed, true);
    assert.equal(saved, true);
  } finally { await pg.close(); }
});

test('weekly editorial checks repair only the flagged passage and re-review the exact outgoing package', async () => {
  const { pg, db } = await fixture();
  try {
    const content = 'In plain terms, Microsoft updated Azure.\n\nRead [the source](https://example.com/source).';
    const packageData = { title: 'Azure update', summary: 'Microsoft updated Azure.', excerpt: 'An Azure update.',
      bodyMarkdown: content, categories: ['Microsoft Azure'], tags: ['Azure'], keyTakeaways: ['Azure has changed.'],
      slug: 'azure-update', imagePrompt: 'An Azure illustration.', featuredImageUrl: 'None available, use the image prompt',
      linkedin: 'Microsoft updated Azure.', twitterCopy: 'Microsoft updated Azure.', postType: 'weekly', status: 'published' };
    const markdown = String(materializeWeeklyPackage(packageData).markdown);
    const saved: Array<{ content: Record<string, unknown>; outcome: string }> = [];
    const calls: string[] = [];
    const passed = await reviewWeeklyJob(db, { blog: packageData, markdown, sources: [{ title: 'Azure update', summary: 'Microsoft updated Azure.' }], slackText: 'Microsoft updated Azure.' },
      'Preserve links.', async (value, review) => { saved.push({ content: value, outcome: review.outcome }); }, {
        preferences: async () => 'Use British English.',
        chat: async (system, input, _tokens, schema) => {
          calls.push(schema.name);
          assert.match(system, /Preserve links/);
          if (schema.name === 'editorial_passage_edits') return { edits: [{ field: 'bodyMarkdown',
            before: 'In plain terms, Microsoft updated Azure.', after: 'Microsoft updated Azure.' }] };
          assert.ok(input && typeof input === 'object' && 'content' in input);
          const reviewInput = input as { previousReview?: unknown; content?: unknown; repairedPassages?: unknown[] };
          if (system.includes('Perform the voice') && reviewInput.previousReview) {
            assert.equal(reviewInput.content, undefined);
            assert.ok(reviewInput.repairedPassages?.length);
            assert.deepEqual(reviewInput.repairedPassages, [
              { field: 'bodyMarkdown', before: 'In plain terms, Microsoft', after: 'Microsoft' },
            ]);
          }
          return { outcome: 'pass', findings: [] };
        },
      });
    assert.equal(passed, true);
    assert.deepEqual(calls, ['editorial_review', 'editorial_review', 'editorial_passage_edits', 'editorial_review', 'editorial_review']);
    assert.deepEqual(saved.map(item => item.outcome), ['revise', 'pass']);
    assert.equal(saved[0]!.content.bodyMarkdown, content);
    assert.equal(saved[1]!.content.content, '<p>Microsoft updated Azure.</p>\n<p>Read <a href="https://example.com/source">the source</a>.</p>\n');
    assert.equal(saved[1]!.content.slackText, 'Microsoft updated Azure.');
    assert.deepEqual(saved[1]!.content.tags, ['Azure']);
    assert.equal(saved[1]!.content.markdown, markdown.replace('In plain terms, ', ''));
  } finally { await pg.close(); }
});
test('weekly editorial repairs an overlength blog teaser before approval, leaving the article intact', async () => {
  const { pg, db } = await fixture();
  try {
    const blog = { title: 'Azure update', summary: 'Microsoft updated Azure.', excerpt: 'An Azure update.',
      bodyMarkdown: 'Microsoft updated Azure.', categories: ['Microsoft Azure'], tags: ['Azure'], keyTakeaways: ['Azure has changed.'],
      slug: 'github-tightens-the-screws-microsoft-chases-supply-chain-fallout',
      imagePrompt: 'An Azure illustration.', featuredImageUrl: 'None available, use the image prompt',
      linkedin: 'Microsoft updated Azure.', twitterCopy: 'Microsoft updated Azure.', postType: 'weekly', status: 'published' };
    const original = 'A practical Microsoft week: GitHub shipped governance and security changes, while Microsoft published three security posts worth proper attention on the LiteLLM compromise, Storm-0940’s use of agentic AI in cloud intrusion, and agent security controls.';
    const revised = 'GitHub updated governance and security; Microsoft covered LiteLLM, cloud intrusion and agent security.';
    const saved: Array<{ content: Record<string, unknown>; validation: string[]; outcome: string }> = [];
    const link = blogLinkForCopyBudget(blog);
    const passed = await reviewWeeklyJob(db, { blog, bluesky: original, sources: [] }, '',
      async (content, review) => { saved.push({ content, validation: review.validation, outcome: review.outcome }); }, {
        preferences: async () => '',
        chat: async (system, _input, _tokens, schema) => {
          if (schema.name === 'editorial_passage_edits') {
            assert.ok(system.includes(`${blueskyCopyAllowance(link)} graphemes`));
            return { edits: [{ field: 'bluesky', before: original, after: revised }] };
          }
          return { outcome: 'pass', findings: [] };
        },
      });
    assert.equal(passed, true);
    assert.deepEqual(saved.map(item => item.outcome), ['revise', 'pass']);
    assert.match(saved[0]!.validation.join(' '), /Bluesky allows 300/);
    assert.equal(saved[1]!.content.bluesky, revised);
    assert.equal(saved[1]!.content.bodyMarkdown, blog.bodyMarkdown);
    assert.equal(saved[1]!.content.slug, blog.slug);
    assert.equal(composeBlueskyText(revised, link), `${revised}\n\n${link}`);
  } finally { await pg.close(); }
});

test('weekly editorial hold retains draft and findings without attempting a rewrite', async () => {
  const { pg, db } = await fixture();
  try {
    let calls = 0;
    let outcome = '';
    const passed = await reviewWeeklyJob(db, { markdown: 'Microsoft updated Azure.', sources: [] }, '',
      async (content, review) => { assert.equal(content.content, 'Microsoft updated Azure.'); outcome = review.outcome; }, {
        preferences: async () => '',
        chat: async () => { calls++; return { outcome: 'hold', findings: ['The source does not establish availability.'] }; },
      });
    assert.equal(passed, false);
    assert.equal(calls, 2);
    assert.equal(outcome, 'hold');
  } finally { await pg.close(); }
});
test('weekly editorial stops after two passage repair rounds', async () => {
  const { pg, db } = await fixture();
  try {
    const outcomes: string[] = [];
    let repairs = 0;
    const passed = await reviewWeeklyJob(db, { markdown: 'Original wording.', sources: [] }, '',
      async (_content, review) => { outcomes.push(review.outcome); }, {
        preferences: async () => '',
        chat: async (_system, input, _tokens, schema) => {
          if (schema.name !== 'editorial_passage_edits') return { outcome: 'revise', findings: ['Clarify the saved passage.'] };
          const content = (input as { content: { content: string } }).content.content;
          return { edits: [{ field: 'content', before: content, after: `Repaired wording ${++repairs}.` }] };
        },
      });
    assert.equal(passed, false);
    assert.equal(repairs, 2);
    assert.deepEqual(outcomes, ['revise', 'revise', 'revise']);
  } finally { await pg.close(); }
});
test('weekly voice findings remain blocking after the first repair', async () => {
  const { pg, db } = await fixture();
  try {
    let repairs = 0;
    const passed = await reviewWeeklyJob(db, { markdown: 'Original wording.', sources: [] }, '', async () => {}, {
      preferences: async () => '',
      chat: async (system, input, _tokens, schema) => {
        if (schema.name === 'editorial_passage_edits') return { edits: [{ field: 'content',
          before: (input as { content: { content: string } }).content.content, after: `Edited wording ${++repairs}.` }] };
        return system.includes('Perform the voice')
          ? { outcome: 'revise', findings: ['Invented personal experience.'] } : { outcome: 'pass', findings: [] };
      },
    });
    assert.equal(passed, false);
    assert.equal(repairs, 2);
  } finally { await pg.close(); }
});
test('rejected no-op repairs are recorded and only genuine subsequent reviews can pass', async () => {
  const { pg, db } = await fixture();
  try {
    for (const remainsInvalid of [false, true]) {
      let reviews = 0;
      const diagnostics: string[] = [];
      const passed = await reviewWeeklyJob(db, { markdown: 'Original wording.', sources: [] }, '',
        async (_content, review) => { diagnostics.push(...review.repairErrors ?? []); }, {
          preferences: async () => '',
          chat: async (_system, _input, _tokens, schema) => {
            if (schema.name === 'editorial_passage_edits') return {
              edits: [{ field: 'content', before: 'Original wording.', after: 'Original wording.' }],
            };
            return ++reviews <= 2 || remainsInvalid
              ? { outcome: 'revise', findings: ['Review the saved wording.'] }
              : { outcome: 'pass', findings: [] };
          },
        });
      assert.equal(passed, !remainsInvalid);
      assert.ok(diagnostics.some(message => message.includes('unchanged passage')));
      assert.ok(reviews >= 4);
    }
  } finally { await pg.close(); }
});
test('weekly CMS parser preserves multiline prose and rejects missing or duplicate sections', () => {
  const fields = { title: 'Azure update', slug: 'azure-update', featuredImageUrl: 'None available', imagePrompt: 'An illustration.',
    bodyMarkdown: 'Opening paragraph.\n\n### Azure\n\nAnother paragraph with [source](https://example.com).',
    excerpt: 'Preview.', summary: 'Summary.', keyTakeaways: ['First insight.', 'Second insight.'], categories: ['Microsoft Azure'],
    tags: ['Azure'], linkedin: 'LinkedIn copy.', twitterCopy: 'Twitter copy.' };
  const rendered = materializeWeeklyPackage(fields);
  const parsed = parseWeeklyPackage(String(rendered.markdown));
  assert.deepEqual(parsed.keyTakeaways, fields.keyTakeaways);
  assert.equal(parsed.bodyMarkdown, fields.bodyMarkdown);
  assert.equal(parsed.content, rendered.content);
  assert.throws(() => parseWeeklyPackage(String(rendered.markdown).replace('## Tags', '## Missing')), /missing Tags/);
  assert.throws(() => parseWeeklyPackage(`${rendered.markdown}\n\n## Tags\nDuplicate`), /repeats Tags/);
});
test('weekly contradictory reviewer decisions require a corrected agent response', async () => {
  const { pg, db } = await fixture();
  try {
    let calls = 0;
    const passed = await reviewWeeklyJob(db, { markdown: 'Microsoft updated Azure.', sources: [] }, '',
      async () => {}, {
        preferences: async () => '',
        chat: async (_system, input) => {
          calls++;
          return (input as { contractError?: string }).contractError
            ? { outcome: 'pass', findings: [] }
            : { outcome: 'pass', findings: ['The previous issue is resolved.'] };
        },
      });
    assert.equal(passed, true);
    assert.equal(calls, 4);
  } finally { await pg.close(); }
});
test('weekly repairs can remove a flagged tag without silently accepting invalid edits', () => {
  const content = { tags: ['Azure', 'Unsupported'], bodyMarkdown: 'Original paragraph.' };
  const edit = { field: 'tags', before: 'Unsupported', after: '' };
  assert.deepEqual(applyEditorialEdits('blog', content, { edits: [edit] }, ['tags']).tags, ['Azure']);
  assert.throws(() => applyEditorialEdits('blog', content, { edits: [edit,
    { field: 'bodyMarkdown', before: 'Nonexistent wording', after: 'Replacement.' }] }, ['tags', 'bodyMarkdown']), /exact saved passage/);
  assert.deepEqual(content.tags, ['Azure', 'Unsupported']);
});
test('weekly approval cannot bypass a missing or unresolved editorial review', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ kind: 'weekly-microsoft' }), true, 'user');
    const run = await store.enqueue(db, job, new Date(), 'manual:weekly-review', false, 'user');
    await pg.query("UPDATE managed_job_runs SET status='awaiting-approval' WHERE id=$1", [run.id]);
    await assert.rejects(store.decideRun(db, run.id, true, 'user'), /editorial review/);
    await pg.query("UPDATE managed_job_runs SET artifacts=$2 WHERE id=$1", [run.id, JSON.stringify({ editorialOutcome: 'hold' })]);
    await assert.rejects(store.decideRun(db, run.id, true, 'user'), /editorial review/);
    await pg.query("UPDATE managed_job_runs SET artifacts=$2 WHERE id=$1", [run.id, JSON.stringify({ editorialOutcome: 'pass' })]);
    await store.decideRun(db, run.id, true, 'user');
    assert.ok((await store.getRun(db, run.id)).approvedAt);
  } finally { await pg.close(); }
});
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

test('blog then LinkedIn then Bluesky use the new blog URL and resume without reposting successes', async () => {
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
    const url = 'https://blog.fixture.invalid/update';
    const publicText = 'A practical change for administrators. '.repeat(10);
    artifacts.blog.content = `<p>${publicText}</p>`;
    const delivery = {
      blog: async () => { counts.blog++; return { httpStatus: 200, payload: { success: true as const, data: { url, editUrl: null, status: 'published' as const } } }; },
      bluesky: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); counts.bluesky++; return { uri: 'fixture-uri', url: 'https://bsky.app/fixture' }; },
      linkedin: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); counts.linkedin++; if (counts.linkedin === 1) throw new (await import('../src/types/errors.js')).IntegrationError('linkedin', 'Definite rejection'); return { urn: 'fixture-urn', url: 'https://www.linkedin.com/fixture' }; },
      read: async () => ({ title: artifacts.blog.title, text: publicText }),
    };
    await executeRun(db, claim.run, claim.lease, delivery);
    assert.equal((await store.getRun(db, run.id)).status, 'partial');
    assert.deepEqual(counts, { blog: 1, bluesky: 0, linkedin: 1 });
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
test('LinkedIn pacing keeps Bluesky queued behind it without republishing the blog', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ approval: 'automatic', outputs: ['blog', 'bluesky', 'linkedin'] }), true, 'user');
    await store.enqueue(db, job, new Date(), 'manual:pace', false, 'user');
    const claim = (await store.leaseRun(db))!;
    const prose = 'A documented practical change for administrators with clear permissions and a deployment path. '.repeat(10);
    const blog = { title: 'A practical update', summary: 'A useful change.', content: `<p>${prose}</p>`, excerpt: '' };
    const receipt = { url: 'https://blog.fixture.invalid/article', status: 'published' };
    claim.run.artifacts = { markdown: 'Fixture', blog, bluesky: 'A practical administration update.', linkedin: 'The practical implications.',
      linkedinAccount: { id: 'member' }, publishTargets: { blogHost: 'blog.fixture.invalid', blueskyAccount: env.BLUESKY_IDENTIFIER ?? '(not connected)' } };
    claim.run.steps = [
      { key: 'generate', status: 'succeeded', startedAt: new Date().toISOString(), result: claim.run.artifacts },
      { key: 'blog', status: 'succeeded', startedAt: new Date().toISOString(), result: receipt },
    ];
    await db.query(`INSERT INTO publishing_deliveries(identity,destination,account,status,published_at) VALUES('earlier','linkedin','member','sent',NOW())`);
    let blueSends = 0;
    const deliveries = {
      blog: async (): Promise<never> => { assert.fail('The accepted blog must not be republished.'); },
      bluesky: async () => { blueSends++; return { uri: 'uri', url: 'https://bsky.app/fixture' }; },
      linkedin: async (): Promise<never> => { assert.fail('LinkedIn must wait for its account-wide spacing.'); },
      read: async () => ({ title: blog.title, text: prose }),
    };
    await executeRun(db, claim.run, claim.lease, deliveries);
    assert.equal(claim.run.status, 'queued'); assert.equal(blueSends, 0);
    await executeRun(db, claim.run, claim.lease, deliveries);
    assert.equal(claim.run.status, 'queued'); assert.equal(blueSends, 0);
  } finally { await pg.close(); }
});

test('accepted blog 404 and LinkedIn rate limits recover in order without recreating the article', async () => {
  const { pg, db } = await fixture();
  try {
    const job = await store.saveJob(db, undefined, 0, definition({ approval: 'automatic', outputs: ['blog', 'linkedin', 'bluesky'] }), true, 'user');
    await store.enqueue(db, job, new Date(), 'manual:verify-blog', false, 'user');
    const claim = (await store.leaseRun(db))!;
    const prose = 'Administrators should check permissions before enabling the documented capability. '.repeat(10);
    const blog = { title: 'A practical update', summary: 'A useful change.', content: `<p>${prose}</p>`, excerpt: '', status: 'published' };
    claim.run.artifacts = { markdown: 'Fixture', blog, bluesky: 'A practical update.', linkedin: 'A practical administration update.',
      linkedinAccount: { id: 'member' }, publishTargets: { blogHost: 'blog.fixture.invalid', blueskyAccount: env.BLUESKY_IDENTIFIER ?? '(not connected)' } };
    claim.run.steps = [{ key: 'generate', status: 'succeeded', startedAt: new Date().toISOString(), result: claim.run.artifacts }];
    const url = 'https://blog.fixture.invalid/new-article';
    const order: string[] = [];
    let available = false;
    const delivery = {
      blog: async () => { order.push('blog'); return { httpStatus: 200, payload: { success: true as const, data: { url, editUrl: null, status: 'published' as const } } }; },
      read: async () => { if (!available) throw new Error('Page returned HTTP 404'); return { title: blog.title, text: prose }; },
      linkedin: async (_copy: string, link: { url: string } | null) => {
        assert.equal(link?.url, url); order.push('linkedin');
        if (order.filter(item => item === 'linkedin').length === 1) throw new (await import('../src/types/errors.js')).IntegrationError('linkedin', 'HTTP 429');
        return { urn: 'urn', url: 'https://www.linkedin.com/fixture' };
      },
      bluesky: async (_copy: string, link: { url: string } | null) => { assert.equal(link?.url, url); order.push('bluesky'); return { uri: 'uri', url: 'https://bsky.app/fixture' }; },
    };
    await executeRun(db, claim.run, claim.lease, delivery);
    assert.equal(claim.run.status, 'queued');
    assert.deepEqual(order, ['blog']);
    await store.releaseRun(db, claim.run.id, claim.lease);
    assert.equal(await store.leaseRun(db), null, 'verification backoff must not occupy the worker');
    await db.query(`UPDATE managed_job_runs SET artifacts=jsonb_set(artifacts,'{blogReceipt,nextVerificationAt}',to_jsonb((NOW()-INTERVAL '1 minute')::text)) WHERE id=$1`, [claim.run.id]);
    available = true;
    const retry = (await store.leaseRun(db))!;
    await executeRun(db, retry.run, retry.lease, delivery);
    assert.equal(retry.run.status, 'queued');
    assert.deepEqual(order, ['blog', 'linkedin']);
    await store.releaseRun(db, retry.run.id, retry.lease);
    await db.query("UPDATE publishing_deliveries SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE destination='linkedin' AND status='failed'");
    const socialRetry = (await store.leaseRun(db))!;
    await executeRun(db, socialRetry.run, socialRetry.lease, delivery);
    assert.equal(socialRetry.run.status, 'succeeded');
    assert.deepEqual(order, ['blog', 'linkedin', 'linkedin', 'bluesky']);
  } finally { await pg.close(); }
});
