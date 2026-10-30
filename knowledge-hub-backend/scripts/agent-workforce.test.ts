import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import {
  ASSIGNMENT_STATES, MANUAL_BLOG_STEPS, WORKFORCE_ROLES, canTransition, commissionSignature, contentSignature,
  isTerminalAssignment, parseAssignmentBrief, parseBudgetLimits, parseReviewFindings, type AssignmentBrief,
} from '../src/agents/workforce/contracts.js';
import {
  cancelAssignment, commissionAssignment, getAssignment, recordReservationUsage,
  pauseAssignmentBudget, reserveAssignmentCall, reserveAssignmentResearch, transitionAssignment, workforceTransaction,
} from '../src/agents/workforce/store.js';
import { currentAgentAttempt, lockAgentAttempt, withAgentAttempt } from '../src/agents/attempt.js';
import {
  completeManualBlogStep, type StepAcceptance, type StepAcceptanceAdapter, type StepAttempt,
} from '../src/agents/workforce/controller.js';
import {
  claimManualBlogStep, recoverAssignmentStep, recordAssignmentFailure, renewAssignmentLease, resumeAssignment,
} from '../src/agents/workforce/runtime.js';
import { ConflictError } from '../src/types/errors.js';
import { deliverAssignmentNotices } from '../src/agents/workforce/notices.js';
import { claimConfiguredAssignment, runManualBlogStep } from '../src/agents/workforce/dispatcher.js';
import { acknowledgeAssignmentNotice, getAssignmentSummary, listAssignmentNotices, listAssignmentSummaries } from '../src/agents/workforce/status.js';
import { getAgentJob, listAgentJobs, listLiveAgentJobs } from '../src/agents/engine.js';
import { beginManualBlogEdit, createManualBlogExecutor } from '../src/agents/workforce/blogDomain.js';
import { queueBlogRecheck, reviewedDraftSignature } from '../src/services/blogJobs.js';
import { critiqueInputSignature } from '../src/ai/blogEditorial.js';
import type { BlogDraft } from '../src/ai/blogDraft.js';
import { captureManualBlogSources, manualBlogSourceCapabilities } from '../src/agents/workforce/blogSources.js';
import { commissionManualBlogRecheck, commissionPreparedManualBlog, prepareManualBlogCommission, primaryBlogSelection, startChatManualBlogCommission, startManualBlogCommission, type TrustedChatBlogAction } from '../src/agents/workforce/blogCommission.js';
import { agentToolDefinitions, executeAgentTool } from '../src/ai/agentTools.js';
import { ToolCatalog } from '../src/ai/toolCatalog.js';
import { researchManualBlog } from '../src/agents/workforce/blogTeam.js';
import { assertWorkforceSchemaReady, WORKFORCE_MIGRATIONS } from '../src/agents/workforce/readiness.js';

const brief = (): AssignmentBrief => ({
  ownerId: 'fixture-owner', workflow: 'manual-blog', workflowVersion: 1, policyProfile: 'manual-blog',
  subjectType: 'blog-source', subjectId: 'discover:fixture-source', instruction: 'Write the agreed Article.',
  origin: { kind: 'app', requestId: randomUUID() },
  scope: {
    sources: [{ type: 'discover', id: 'fixture-source', version: 'v1' }],
    excludedSourceIds: [], projectId: null, readOnly: false,
  },
});

test('workforce roles are display identities, with no executable learning steward', () => {
  assert.equal(new Set(WORKFORCE_ROLES.map(role => role.id)).size, WORKFORCE_ROLES.length);
  assert.equal(WORKFORCE_ROLES.some(role => String(role.id) === 'mnemosyne'), false);
  assert.equal(MANUAL_BLOG_STEPS.revision.role, 'calliope');
  assert.equal(MANUAL_BLOG_STEPS.critique.role, 'momus');
  assert.equal(MANUAL_BLOG_STEPS.recheck.role, 'momus');
});

test('empty author grounding is rejected before the team spends on research or model calls', async () => {
  let calls = 0;
  await assert.rejects(researchManualBlog({
    instruction: 'Write the selected article.', length: 'long', earlierPosts: [], voiceSamples: [], authorRecords: [],
    source: { kind: 'spark-theme', theme: 'A controlled topic', ideas: [{ body: 'An idea to investigate.', sourceTitle: null }] },
  }, { chat: async () => { calls++; throw new Error('Empty context must not reach a model.'); } }), /requires scoped author grounding/);
  assert.equal(calls, 0);
});

test('workforce status is discoverable and fails closed without trusted owner identity', async t => {
  const catalog = new ToolCatalog(agentToolDefinitions());
  assert.match(catalog.describe(), /check_workforce_assignments/);
  catalog.load(['check_workforce_assignments']);
  assert.equal(catalog.schemas().some(tool => tool.function.name === 'check_workforce_assignments'), true);
  const db = new Pool();
  t.after(() => db.end());
  const query = t.mock.method(db, 'query', async () => { throw new Error('Untrusted owner must not reach storage.'); });
  const result = await executeAgentTool(db, 'check_workforce_assignments', { ownerId: 'someone-else' }, {});
  assert.match(JSON.stringify(result), /Authenticated owner identity is required/);
  assert.equal(query.mock.callCount(), 0);
});

test('workforce status reads use server identity, never an owner supplied in model arguments', async t => {
  const db = new Pool();
  t.after(() => db.end());
  const query = t.mock.method(db, 'query', async (_sql: string, values?: unknown[]) => {
    assert.equal(values?.[0], 'authenticated-owner');
    return { rows: [] };
  });
  const result = await executeAgentTool(db, 'check_workforce_assignments', { ownerId: 'someone-else' }, { userId: 'authenticated-owner' });
  assert.deepEqual(result, { assignments: [] });
  assert.equal(query.mock.callCount(), 1);
});

test('terminal assignments cannot be silently resumed or automatically retried', () => {
  for (const state of ASSIGNMENT_STATES) {
    if (isTerminalAssignment(state)) {
      for (const next of ASSIGNMENT_STATES) assert.equal(canTransition(state, next), false);
    }
  }
  assert.equal(canTransition('waiting', 'running'), true);
  assert.equal(canTransition('queued', 'completed'), false);
  assert.equal(canTransition('running', 'cancelled'), true);
});

test('commission input requires an explicit versioned scope, exclusions and restrictions', () => {
  assert.deepEqual(parseAssignmentBrief(brief()).scope.sources, [{ type: 'discover', id: 'fixture-source', version: 'v1' }]);
  for (const scope of [
    { sources: [] }, { sources: [{}], excludedSourceIds: [], readOnly: false, projectId: null },
    { ...brief().scope, excludedSourceIds: undefined }, { ...brief().scope, readOnly: undefined },
    { ...brief().scope, excludedSourceIds: ['fixture-source'] },
    { ...brief().scope, excludedSourceIds: ['discover:fixture-source'] },
    { ...brief().scope, sources: [...brief().scope.sources, ...brief().scope.sources] },
  ]) assert.throws(() => parseAssignmentBrief({ ...brief(), scope }));
  assert.throws(() => parseAssignmentBrief({ ...brief(), origin: { kind: 'schedule', requestId: 'r' } }));
});

test('commission identity ignores transport retries but not instruction, scope or source changes', () => {
  const first = brief();
  assert.equal(commissionSignature(first), commissionSignature({ ...first, origin: { ...first.origin, requestId: 'retry' } }));
  assert.notEqual(commissionSignature(first), commissionSignature({ ...first, instruction: 'Write a different Article.' }));
  assert.notEqual(commissionSignature(first), commissionSignature({ ...first, scope: { ...first.scope, projectId: 'other' } }));
  assert.notEqual(commissionSignature(first), commissionSignature({
    ...first, scope: { ...first.scope, sources: [{ ...first.scope.sources[0]!, version: 'v2' }] },
  }));
});

test('budget limits require finite positive integers, not success-shaped defaults', () => {
  assert.deepEqual(parseBudgetLimits({ calls: 5, tokens: 1000, durationMs: 2000 }), { calls: 5, tokens: 1000, durationMs: 2000 });
  for (const value of [0, -1, 1.5, NaN, Infinity, '5', undefined]) {
    assert.throws(() => parseBudgetLimits({ calls: value, tokens: 1000, durationMs: 2000 }));
  }
});

test('a critic cannot smuggle edits, stale signatures, invented quotations or broader sources into findings', () => {
  const artifact = { id: 'candidate', type: 'blog-draft', revision: '1', signature: 'exact-signature' };
  const finding = {
    artifact, field: 'content', quote: 'An assertion.', classification: 'advisory', reason: 'Qualify the assertion.',
    correction: 'Retain the documented qualification.', sources: brief().scope.sources,
  };
  const parse = (value: unknown) => parseReviewFindings(value, artifact, { content: '<p>An assertion.</p>' }, brief().scope.sources);
  assert.equal(parse([finding])[0]!.classification, 'advisory');
  for (const invalid of [
    { ...finding, after: 'An unsolicited rewrite.' },
    { ...finding, artifact: { ...artifact, revision: 'old' } },
    { ...finding, quote: 'Text not present in the candidate.' },
    { ...finding, sources: [{ type: 'private-note', id: 'excluded', version: '1' }] },
    { ...finding, classification: 'approved' },
  ]) assert.throws(() => parse([invalid]));
});

async function fixture(t: TestContext) {
  const pg = new PGlite();
  const db = new Pool({ connectionString: 'postgresql://isolated.invalid/workforce' });
  t.after(async () => { await pg.close(); await db.end(); });
  await pg.exec(await readFile(new URL('../src/db/migrations/110_agent_jobs.sql', import.meta.url), 'utf8'));
  const migration = await readFile(new URL('../src/db/migrations/123_workforce_foundation.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
  for (const name of ['027_ai_chat_sessions.sql', '038_ai_chat_pins_titles_sources.sql', '124_workforce_chat_notices.sql', '124_workforce_chat_notices.sql', '125_workforce_notice_acknowledgement.sql', '125_workforce_notice_acknowledgement.sql', '126_workforce_blog_revisions.sql', '126_workforce_blog_revisions.sql']) {
    await pg.exec(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  await pg.exec('CREATE TABLE ai_usage_log(id UUID PRIMARY KEY)');
  await pg.exec(await readFile(new URL('../src/db/migrations/117_ai_workflow_attribution.sql', import.meta.url), 'utf8'));
  const fault = { failNoticeTimestamp: false };
  const advisoryLocks: string[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      advisoryLocks.push(String(values?.[0]));
      return { rows: [], rowCount: 0 };
    }
    if (fault.failNoticeTimestamp && sql.includes('UPDATE ai_chat_sessions')) throw new Error('Fixture chat timestamp failure');
    const result = await pg.query(sql, values);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  t.mock.method(db, 'query', query);
  t.mock.method(db, 'connect', async () => ({ query, release() {} }));
  const profileId = randomUUID();
  await pg.query(`INSERT INTO agent_budget_profiles(id,workflow,workflow_version,policy_profile,version,limits,approved_by,approved_at)
    VALUES($1,'manual-blog',1,'manual-blog',1,$2,'fixture-owner',clock_timestamp())`,
  [profileId, JSON.stringify({ calls: 2, tokens: 1000, durationMs: 60000 })]);
  const options = {
    budgetProfileId: profileId, workerPool: 'fixture-pool', firstStep: MANUAL_BLOG_STEPS.research,
    specialist: 'fixture-research', subjectTitle: 'Fixture subject', subjectUrl: '/discover', input: {},
    authorise: async () => {},
  };
  return { pg, db, profileId, options, fault, advisoryLocks };
}

test('assignment chat notice and outbox receipt commit once, in the originating conversation and worker pool', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const conversationId = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id) VALUES($1)', [conversationId]);
  const commissioned = await commissionAssignment(db, {
    ...brief(), origin: { kind: 'chat', conversationId, requestId: randomUUID() },
  }, options);
  await workforceTransaction(db, async client => {
    const active = await transitionAssignment(client, commissioned.assignment.id, commissioned.assignment.revision, 'queued', 'running', { readiness: 'pending', reason: null });
    await transitionAssignment(client, active.id, active.revision, 'running', 'completed', { readiness: 'ready', reason: null });
  });
  await deliverAssignmentNotices(db, 'other-pool');
  assert.equal((await pg.query('SELECT id FROM ai_chat_messages')).rows.length, 0);
  await deliverAssignmentNotices(db, 'fixture-pool');
  await deliverAssignmentNotices(db, 'fixture-pool');
  const messages = await pg.query<{ session_id: string; content: string; workforce_event_id: string }>('SELECT session_id,content,workforce_event_id FROM ai_chat_messages');
  assert.equal(messages.rows.length, 1);
  assert.equal(messages.rows[0]!.session_id, conversationId);
  assert.match(messages.rows[0]!.content, /independent review.*not published/);
  const receipt = await pg.query<{ delivered_at: unknown; metadata: { notice: { status: string } } }>(
    'SELECT delivered_at,metadata FROM agent_assignment_events WHERE id=$1', [messages.rows[0]!.workforce_event_id],
  );
  assert.notEqual(receipt.rows[0]!.delivered_at, null);
  assert.equal(receipt.rows[0]!.metadata.notice.status, 'delivered');
  const current = await getAssignment(db, commissioned.assignment.id, 'fixture-owner');
  await pg.query("INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'budget-overrun')",
    [randomUUID(), current.id, current.revision]);
  await deliverAssignmentNotices(db, 'fixture-pool');
  assert.equal((await pg.query('SELECT id FROM ai_chat_messages')).rows.length, 1, 'a later event for the same outcome revision must not create another chat notice');
});

test('a chat timestamp failure rolls back the notice insert and receipt; the next delivery does not duplicate it', async t => {
  const { pg, db, profileId, options, fault } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const conversationId = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id) VALUES($1)', [conversationId]);
  const commissioned = await commissionAssignment(db, {
    ...brief(), origin: { kind: 'chat', conversationId, requestId: randomUUID() },
  }, options);
  await cancelAssignment(db, commissioned.assignment.id, commissioned.assignment.brief.ownerId, commissioned.assignment.revision);
  fault.failNoticeTimestamp = true;
  await assert.rejects(deliverAssignmentNotices(db, 'fixture-pool'), /Fixture chat timestamp failure/);
  assert.equal((await pg.query('SELECT id FROM ai_chat_messages')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_assignment_events WHERE delivered_at IS NOT NULL')).rows.length, 0);
  fault.failNoticeTimestamp = false;
  await deliverAssignmentNotices(db, 'fixture-pool');
  await deliverAssignmentNotices(db, 'fixture-pool');
  const messages = await pg.query<{ content: string }>('SELECT content FROM ai_chat_messages');
  assert.equal(messages.rows.length, 1);
  assert.match(messages.rows[0]!.content, /cancelled.*Saved drafts and reviews.*does not undo/);
});

test('a superseded waiting event never delivers a stale pause after cancellation', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const conversationId = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id) VALUES($1)', [conversationId]);
  const commissioned = await commissionAssignment(db, {
    ...brief(), origin: { kind: 'chat', conversationId, requestId: randomUUID() },
  }, options);
  const waiting = await workforceTransaction(db, client =>
    transitionAssignment(client, commissioned.assignment.id, commissioned.assignment.revision, 'queued', 'waiting', {
      readiness: 'blocked', reason: 'More evidence is needed.',
    }));
  await cancelAssignment(db, waiting.id, waiting.brief.ownerId, waiting.revision);
  await deliverAssignmentNotices(db, 'fixture-pool');
  const messages = await pg.query<{ content: string }>('SELECT content FROM ai_chat_messages');
  assert.equal(messages.rows.length, 1);
  assert.match(messages.rows[0]!.content, /cancelled/);
  const receipt = await pg.query<{ status: string }>("SELECT metadata->'notice'->>'status' AS status FROM agent_assignment_events WHERE kind='waiting'");
  assert.equal(receipt.rows[0]!.status, 'superseded-before-delivery');
});

test('deleted conversations are explicitly recorded as undeliverable, without inventing another conversation', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  t.mock.method(console, 'warn', () => {});
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const commissioned = await commissionAssignment(db, {
    ...brief(), origin: { kind: 'chat', conversationId: randomUUID(), requestId: randomUUID() },
  }, options);
  await cancelAssignment(db, commissioned.assignment.id, commissioned.assignment.brief.ownerId, commissioned.assignment.revision);
  await deliverAssignmentNotices(db, 'fixture-pool');
  assert.equal((await pg.query('SELECT id FROM ai_chat_messages')).rows.length, 0);
  const receipt = await pg.query<{ status: string }>("SELECT metadata->'notice'->>'status' AS status FROM agent_assignment_events WHERE kind='cancelled'");
  assert.equal(receipt.rows[0]!.status, 'conversation-unavailable');
});

test('additive storage is rerunnable, preserves legacy results and enables no workflow', async t => {
  const { pg } = await fixture(t);
  assert.deepEqual((await pg.query('SELECT enabled FROM agent_budget_profiles')).rows, [{ enabled: false }]);
  assert.deepEqual((await pg.query('SELECT id FROM agent_assignments')).rows, []);
  const id = randomUUID();
  await pg.query(`INSERT INTO agent_jobs(id,specialist,subject_type,subject_id,result,worker_pool)
    VALUES($1,'blog-writer','blog-source','discover:old',$2::jsonb,'fixture-pool')`, [id, JSON.stringify({ data: { draft: 'Original' } })]);
  const rows = await pg.query<{ protocol_version: number; assignment_id: string | null; result: unknown }>(
    'SELECT protocol_version,assignment_id,result FROM agent_jobs WHERE id=$1', [id],
  );
  assert.deepEqual(rows.rows, [{ protocol_version: 1, assignment_id: null, result: { data: { draft: 'Original' } } }]);
});

test('enabled workforce readiness refuses missing tracking, unapplied migrations and missing runtime columns', async t => {
  const { pg, db } = await fixture(t);
  await assert.rejects(assertWorkforceSchemaReady(db), /setup is missing/);
  await pg.exec('CREATE TABLE applied_migrations(filename TEXT PRIMARY KEY)');
  await assert.rejects(assertWorkforceSchemaReady(db), /setup is incomplete/);
  for (const filename of WORKFORCE_MIGRATIONS) {
    await pg.query('INSERT INTO applied_migrations(filename) VALUES($1)', [filename]);
  }
  await assertWorkforceSchemaReady(db);
  await pg.exec('ALTER TABLE agent_jobs DROP COLUMN lease_until');
  await assert.rejects(assertWorkforceSchemaReady(db), /lease_until/);
});

test('approved limits cannot be edited in place to silently increase an active allowance', async t => {
  const { pg, profileId } = await fixture(t);
  await assert.rejects(pg.query("UPDATE agent_budget_profiles SET limits='{}'::jsonb WHERE id=$1", [profileId]), /immutable/);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  assert.deepEqual((await pg.query('SELECT enabled FROM agent_budget_profiles WHERE id=$1', [profileId])).rows, [{ enabled: true }]);
});

test('commission requires explicit approval and trusted current-source authorisation', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await assert.rejects(commissionAssignment(db, brief(), options), /owner-approved/);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  await assert.rejects(commissionAssignment(db, brief(), {
    ...options, authorise: async () => { throw new Error('Source changed'); },
  }), /Source changed/);
  await assert.rejects(commissionAssignment(db, { ...brief(), scope: { ...brief().scope, readOnly: true } }, options), /Read-only/);
  assert.equal((await pg.query('SELECT id FROM agent_assignments')).rows.length, 0);
});

test('equivalent commissions deduplicate; changed briefs and reused request IDs conflict', async t => {
  const { pg, db, profileId, options, advisoryLocks } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const input = brief();
  const first = await commissionAssignment(db, input, options);
  assert.equal(first.existing, false);
  assert.deepEqual(advisoryLocks.slice(0, 2), [
    `agent-request:${JSON.stringify([input.ownerId, options.workerPool, input.origin.requestId])}`,
    `agent-subject:${input.subjectType}:${input.subjectId}`,
  ], 'same-action locking must precede subject locking even if competing requests select different subjects');
  const duplicate = await commissionAssignment(db, { ...input, origin: { kind: 'app', requestId: 'retry' } }, options);
  assert.equal(duplicate.assignment.id, first.assignment.id);
  assert.equal(duplicate.existing, true);
  await assert.rejects(commissionAssignment(db, { ...input, instruction: 'A different request.' }, options), /different commission/);
  await assert.rejects(commissionAssignment(db, {
    ...input, instruction: 'A different request.', origin: { kind: 'app', requestId: 'different-request' },
  }, options), /different brief/);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
});

test('initial editor projection and commissioning roll back together when the canonical save fails', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  await assert.rejects(commissionAssignment(db, brief(), {
    ...options,
    initialiseStep: async (client, jobId, assignmentId) => {
      const created = await client.query('SELECT id FROM agent_jobs WHERE id=$1 AND assignment_id=$2', [jobId, assignmentId]);
      assert.equal(created.rowCount, 1);
      throw new Error('Canonical projection save failed.');
    },
  }), /Canonical projection save failed/);
  assert.equal((await pg.query('SELECT id FROM agent_assignments')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 0);
});

test('a serialised exact receipt never reauthorises or initialises work after source or profile revocation', async t => {
  const { pg, db, profileId, options, advisoryLocks } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const input = brief();
  const first = await commissionAssignment(db, input, options);
  await pg.query('UPDATE agent_budget_profiles SET enabled=FALSE WHERE id=$1', [profileId]);
  advisoryLocks.length = 0;
  const revoked = {
    ...options,
    authorise: async () => { throw new Error('Current source authority has changed.'); },
    initialiseStep: async () => { throw new Error('A receipt must not save or start more work.'); },
  };
  const receipt = await commissionAssignment(db, input, revoked);
  assert.equal(receipt.assignment.id, first.assignment.id);
  assert.equal(receipt.existing, true);
  assert.deepEqual(advisoryLocks, [
    `agent-request:${JSON.stringify([input.ownerId, options.workerPool, input.origin.requestId])}`,
  ], 'receipt recovery must not acquire unrelated subject/source locks');
  await assert.rejects(commissionAssignment(db, { ...input, subjectId: 'discover:another-source' }, revoked), /different commission/);
  await assert.rejects(commissionAssignment(db, { ...input, origin: { kind: 'app', requestId: 'new-action' } }, revoked), /Current source authority has changed/);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
});

test('cancellation is revision-bound and retains artifacts and delivery-independent state', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const created = (await commissionAssignment(db, brief(), options)).assignment;
  await assert.rejects(cancelAssignment(db, created.id, 'other-owner', created.revision), /not found/);
  await assert.rejects(cancelAssignment(db, created.id, 'fixture-owner', created.revision + 1), /changed/);
  await pg.query(`INSERT INTO agent_artifacts(id,assignment_id,producer_job_id,producer_attempt,artifact_type,schema_version,
    content_signature,domain_reference,source_versions)
    SELECT $1,$2,id,1,'blog-evidence',1,'original',$3::jsonb,'[]'::jsonb FROM agent_jobs WHERE assignment_id=$2`,
  [randomUUID(), created.id, JSON.stringify({ retained: true })]);
  const cancelled = await cancelAssignment(db, created.id, 'fixture-owner', created.revision);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).readiness, 'blocked');
  assert.equal((await pg.query('SELECT id FROM agent_artifacts WHERE assignment_id=$1', [created.id])).rows.length, 1);
  assert.equal((await pg.query('SELECT id FROM agent_assignment_events WHERE assignment_id=$1', [created.id])).rows.length, 1);
  assert.equal((await cancelAssignment(db, created.id, 'fixture-owner', created.revision)).status, 'cancelled');
});

test('lease fencing rejects expired or superseded worker writes inside the domain transaction', async t => {
  const { pg, db } = await fixture(t);
  const id = randomUUID();
  const owner = randomUUID();
  await pg.query(`INSERT INTO agent_jobs(id,specialist,subject_type,subject_id,status,attempts,lease_owner,lease_until,worker_pool)
    VALUES($1,'fixture','fixture','subject','running',1,$2,clock_timestamp()+INTERVAL '1 minute','fixture-pool')`, [id, owner]);
  const run = () => withAgentAttempt({
    jobId: id, attempt: 1, owner, assignmentId: null, signal: new AbortController().signal,
  }, () => workforceTransaction(db, lockAgentAttempt));
  await run();
  await pg.query('UPDATE agent_jobs SET attempts=2 WHERE id=$1', [id]);
  await assert.rejects(run, /no longer owns/);
  await pg.query("UPDATE agent_jobs SET attempts=1,lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [id]);
  await assert.rejects(run, /no longer owns/);
});

test('budget calls share durable limits and unknown usage never replenishes reservations', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const created = (await commissionAssignment(db, brief(), options)).assignment;
  await workforceTransaction(db, client => transitionAssignment(client, created.id, created.revision, 'queued', 'running', { readiness: 'pending', reason: null }));
  const owner = randomUUID();
  const job = await pg.query<{ id: string }>(`UPDATE agent_jobs SET status='running',attempts=1,lease_owner=$2,
    lease_until=clock_timestamp()+INTERVAL '1 minute' WHERE assignment_id=$1 RETURNING id`, [created.id, owner]);
  const identity = { assignmentId: created.id, jobId: job.rows[0]!.id, attempt: 1, leaseOwner: owner };
  const reserve = (tokens: number) => workforceTransaction(db, client => reserveAssignmentCall(client, identity, tokens));
  const first = await reserve(400);
  await recordReservationUsage(db, first.id, null);
  await assert.rejects(recordReservationUsage(db, first.id, 0), /already reconciled/);
  await reserve(600);
  await assert.rejects(reserve(1), /budget is exhausted/);
  const counters = await pg.query<{ calls_reserved: number; tokens_reserved: number }>(
    'SELECT calls_reserved,tokens_reserved FROM agent_assignments WHERE id=$1', [created.id],
  );
  assert.equal(Number(counters.rows[0]!.calls_reserved), 2);
  assert.equal(Number(counters.rows[0]!.tokens_reserved), 1000);
});

test('underestimated provider usage is charged and blocks further work rather than silently passing', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const created = (await commissionAssignment(db, brief(), options)).assignment;
  await workforceTransaction(db, client => transitionAssignment(client, created.id, created.revision, 'queued', 'running', { readiness: 'pending', reason: null }));
  const owner = randomUUID();
  const job = await pg.query<{ id: string }>(`UPDATE agent_jobs SET status='running',attempts=1,lease_owner=$2,
    lease_until=clock_timestamp()+INTERVAL '1 minute' WHERE assignment_id=$1 RETURNING id`, [created.id, owner]);
  const identity = { assignmentId: created.id, jobId: job.rows[0]!.id, attempt: 1, leaseOwner: owner };
  const saved = await workforceTransaction(db, client => reserveAssignmentCall(client, identity, 100));
  await assert.rejects(recordReservationUsage(db, saved.id, 200), /exceeded its reservation/);
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'waiting');
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).readiness, 'blocked');
  await assert.rejects(workforceTransaction(db, client => reserveAssignmentCall(client, identity, 100)), /stopped/);
});

test('research consumes the same durable allowance as a model call without charging fictitious tokens', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const created = (await commissionAssignment(db, brief(), options)).assignment;
  await workforceTransaction(db, client => transitionAssignment(client, created.id, created.revision, 'queued', 'running', { readiness: 'pending', reason: null }));
  const owner = randomUUID();
  const jobs = await pg.query<{ id: string }>(
    `UPDATE agent_jobs SET status='running',attempts=1,lease_owner=$2,lease_until=clock_timestamp()+INTERVAL '1 minute'
      WHERE assignment_id=$1 RETURNING id`, [created.id, owner],
  );
  const identity = { assignmentId: created.id, jobId: jobs.rows[0]!.id, attempt: 1, leaseOwner: owner };
  const researched = await workforceTransaction(db, client => reserveAssignmentResearch(client, identity));
  await recordReservationUsage(db, researched.id, 0);
  await workforceTransaction(db, client => reserveAssignmentCall(client, identity, 1000));
  await assert.rejects(workforceTransaction(db, client => reserveAssignmentResearch(client, identity)), /budget is exhausted/);
  const saved = await pg.query<{ operation_kind: string; tokens_reserved: string }>(
    'SELECT operation_kind,tokens_reserved FROM agent_budget_reservations WHERE id=$1', [researched.id],
  );
  assert.equal(saved.rows[0]!.operation_kind, 'research');
  assert.equal(Number(saved.rows[0]!.tokens_reserved), 0);
});

test('budget suspension fences the attempt durably and never requeues work after user cancellation', async t => {
  const { pg, db, profileId, options } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const created = (await commissionAssignment(db, brief(), options)).assignment;
  await workforceTransaction(db, client => transitionAssignment(client, created.id, created.revision, 'queued', 'running', { readiness: 'pending', reason: null }));
  const owner = randomUUID();
  const jobs = await pg.query<{ id: string }>(
    `UPDATE agent_jobs SET status='running',attempts=1,lease_owner=$2,lease_until=clock_timestamp()+INTERVAL '1 minute'
      WHERE assignment_id=$1 RETURNING id`, [created.id, owner],
  );
  const identity = { assignmentId: created.id, jobId: jobs.rows[0]!.id, attempt: 1, leaseOwner: owner };
  await pauseAssignmentBudget(db, { ...identity, leaseOwner: randomUUID() }, 'Must not affect another owner.');
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'running');
  await pauseAssignmentBudget(db, identity, 'The shared allowance is exhausted.');
  const paused = await getAssignment(db, created.id, 'fixture-owner');
  assert.equal(paused.status, 'waiting');
  assert.equal(paused.readiness, 'blocked');
  await assert.rejects(withAgentAttempt({
    jobId: identity.jobId, assignmentId: created.id, attempt: 1, owner, signal: new AbortController().signal,
  }, () => workforceTransaction(db, lockAgentAttempt)), /no longer owns/);
  const cancelled = await cancelAssignment(db, created.id, 'fixture-owner', paused.revision);
  await pauseAssignmentBudget(db, identity, 'A late budget failure must not undo cancellation.');
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).revision, cancelled.revision);
  const job = await pg.query<{ status: string }>('SELECT status FROM agent_jobs WHERE id=$1', [identity.jobId]);
  assert.equal(job.rows[0]!.status, 'failed');
});

async function controllerFixture(t: TestContext) {
  const setup = await fixture(t);
  const { pg, db, profileId, options } = setup;
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const created = (await commissionAssignment(db, brief(), options)).assignment;
  await workforceTransaction(db, client => transitionAssignment(client, created.id, created.revision, 'queued', 'running', {
    readiness: 'pending', reason: null,
  }));
  await pg.exec('CREATE TABLE fixture_outputs (id TEXT PRIMARY KEY, content JSONB NOT NULL)');
  const claim = async (jobId?: string): Promise<StepAttempt> => {
    const owner = randomUUID();
    const result = await pg.query<{ id: string; attempts: number }>(
      `UPDATE agent_jobs SET status='running',attempts=attempts+1,lease_owner=$2,lease_until=clock_timestamp()+INTERVAL '1 minute'
        WHERE assignment_id=$1 AND status='queued' AND ($3::uuid IS NULL OR id=$3) RETURNING id,attempts`, [created.id, owner, jobId ?? null],
    );
    assert.equal(result.rows.length, 1);
    return {
      assignmentId: created.id, jobId: result.rows[0]!.id, attempt: result.rows[0]!.attempts,
      owner, workerPool: options.workerPool, signal: new AbortController().signal,
    };
  };
  const adapter: StepAcceptanceAdapter = {
    checkCurrent: async () => {},
    accept: async (client, context, proposal) => {
      await client.query('INSERT INTO fixture_outputs(id,content) VALUES($1,$2::jsonb)', [context.step, JSON.stringify(proposal)]);
      return {
        reference: {
          id: context.step, type: MANUAL_BLOG_STEPS[context.step].outputType, revision: '1',
          signature: contentSignature(proposal),
        },
        schemaVersion: 1, summary: 'Saved fixture output.',
        disposition: context.step === 'critique'
          ? { kind: 'review', requiresRevision: true, readiness: 'blocked', reason: 'Correct the documented claim.' }
          : context.step === 'recheck'
            ? { kind: 'review', requiresRevision: false, readiness: 'ready', reason: null } : { kind: 'continue' },
      };
    },
  };
  return { ...setup, created, claim, adapter };
}

test('canonical acceptance, artifact provenance and next step commit once; replay cannot regenerate or advance again', async t => {
  const { pg, db, claim, adapter } = await controllerFixture(t);
  const identity = await claim();
  const proposal = { evidence: 'An official source.' };
  const saved = await completeManualBlogStep(db, identity, proposal, adapter);
  assert.equal(saved.replayed, false);
  assert.ok(saved.nextJobId);
  const replay = await completeManualBlogStep(db, identity, proposal, {
    checkCurrent: async () => { throw new Error('Replay must not repeat acceptance.'); },
    accept: async () => { throw new Error('Replay must not rewrite the domain.'); },
  });
  assert.equal(replay.artifact.id, saved.artifact.id);
  assert.equal(replay.nextJobId, saved.nextJobId);
  assert.equal(replay.replayed, true);
  assert.equal((await pg.query('SELECT id FROM fixture_outputs')).rows.length, 1);
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 1);
  const next = await pg.query<{ role_id: string; depends_on: string; input: unknown }>('SELECT role_id,depends_on,input FROM agent_jobs WHERE id=$1', [saved.nextJobId]);
  assert.equal(next.rows[0]!.role_id, 'calliope');
  assert.equal(next.rows[0]!.depends_on, identity.jobId);
  assert.deepEqual(next.rows[0]!.input, { workforceArtifactIds: [saved.artifact.id] });
  await assert.rejects(completeManualBlogStep(db, identity, { evidence: 'A different output.' }, adapter), /no longer owns/);
});

test('invalid author approval rolls back its canonical write and does not create an artifact or successor', async t => {
  const { pg, db, claim, adapter } = await controllerFixture(t);
  const identity = await claim();
  await assert.rejects(completeManualBlogStep(db, identity, { evidence: 'Source' }, {
    ...adapter,
    accept: async (...args) => ({
      ...await adapter.accept(...args), disposition: { kind: 'review', requiresRevision: false, readiness: 'ready', reason: null },
    }),
  }), /Only the independent critic/);
  assert.equal((await pg.query('SELECT id FROM fixture_outputs')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
});

test('cancelled, expired, different-pool and stale-source attempts cannot accept or advance output', async t => {
  const { pg, db, claim, adapter, created } = await controllerFixture(t);
  const identity = await claim();
  const failIfAccepted: StepAcceptanceAdapter = {
    ...adapter, accept: async () => { throw new Error('Acceptance must not run.'); },
  };
  await assert.rejects(completeManualBlogStep(db, { ...identity, workerPool: 'other-pool' }, {}, failIfAccepted), /another pool/);
  await pg.query("UPDATE agent_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [identity.jobId]);
  await assert.rejects(completeManualBlogStep(db, identity, {}, failIfAccepted), /no longer owns/);
  await pg.query("UPDATE agent_jobs SET lease_until=clock_timestamp()+INTERVAL '1 minute' WHERE id=$1", [identity.jobId]);
  await assert.rejects(completeManualBlogStep(db, identity, {}, {
    ...failIfAccepted, checkCurrent: async () => { throw new Error('Controlling source changed.'); },
  }), /Controlling source changed/);
  const current = await getAssignment(db, created.id, 'fixture-owner');
  await cancelAssignment(db, current.id, 'fixture-owner', current.revision);
  await assert.rejects(completeManualBlogStep(db, identity, {}, failIfAccepted), /no longer owns/);
  assert.equal((await pg.query('SELECT id FROM fixture_outputs')).rows.length, 0);
});

test('a late source conflict rolls back the generated domain write instead of leaving an orphan candidate', async t => {
  const { pg, db, claim, adapter } = await controllerFixture(t);
  let checks = 0;
  await assert.rejects(completeManualBlogStep(db, await claim(), { evidence: 'Source' }, {
    ...adapter,
    checkCurrent: async () => {
      checks++;
      if (checks === 2) throw new Error('A controlling source changed before commit.');
    },
  }), /changed before commit/);
  assert.equal((await pg.query('SELECT id FROM fixture_outputs')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 0);
});

test('the fixed blog chain permits one author revision and independent recheck, never another automatic revision', async t => {
  const { pg, db, claim, adapter, created } = await controllerFixture(t);
  let jobId: string | undefined;
  for (const step of ['research', 'draft', 'critique', 'revision'] as const) {
    const completed = await completeManualBlogStep(db, await claim(jobId), { stage: step }, adapter);
    assert.ok(completed.nextJobId);
    jobId = completed.nextJobId;
  }
  const identity = await claim(jobId);
  const proposal = { review: 'Current complete review.' };
  await assert.rejects(completeManualBlogStep(db, identity, proposal, {
    ...adapter,
    accept: async (...args): Promise<StepAcceptance> => ({
      ...await adapter.accept(...args),
      disposition: { kind: 'review', requiresRevision: true, readiness: 'blocked', reason: 'One more rewrite.' },
    }),
  }), /one automatic author revision/);
  const finished = await completeManualBlogStep(db, identity, proposal, adapter);
  assert.equal(finished.assignment.status, 'completed');
  assert.equal(finished.assignment.readiness, 'ready');
  assert.equal(finished.nextJobId, null);
  assert.equal((await pg.query('SELECT id FROM agent_jobs WHERE assignment_id=$1', [created.id])).rows.length, 5);
  const artifacts = await pg.query<{ input_artifact_ids: string[] }>(
    'SELECT input_artifact_ids FROM agent_artifacts WHERE producer_job_id=$1', [identity.jobId],
  );
  assert.equal(artifacts.rows[0]!.input_artifact_ids.length, 4);
});

test('an incomplete review preserves its artifact, waits without creating a successor and never claims readiness', async t => {
  const { pg, db, claim, adapter } = await controllerFixture(t);
  const saved = await completeManualBlogStep(db, await claim(), { partial: 'Saved evidence requiring clarification.' }, {
    ...adapter,
    accept: async (...args) => ({
      ...await adapter.accept(...args), disposition: { kind: 'wait', reason: 'The controlling source needs clarification.' },
    }),
  });
  assert.equal(saved.assignment.status, 'waiting');
  assert.equal(saved.assignment.readiness, 'blocked');
  assert.equal(saved.nextJobId, null);
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 1);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
  const events = await pg.query<{ kind: string }>('SELECT kind FROM agent_assignment_events');
  assert.deepEqual(events.rows, [{ kind: 'waiting' }]);
});

async function queuedFixture(t: TestContext) {
  const setup = await fixture(t);
  await setup.pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [setup.profileId]);
  const created = (await commissionAssignment(setup.db, brief(), setup.options)).assignment;
  const claim = (owner = randomUUID(), pool = setup.options.workerPool) =>
    claimManualBlogStep(setup.db, pool, owner, new AbortController().signal, async () => {});
  return { ...setup, created, claim };
}

test('the real blog adapter retains immutable stage revisions and exposes the draft through the existing canonical checkpoint', async t => {
  const { db, pg, claim, created } = await controllerFixture(t);
  const executor = createManualBlogExecutor(db, {
    checkCurrent: async () => {},
    loadResearch: async () => { throw new Error('Acceptance must not run source/model work.'); },
  });
  const research = {
    prepared: { system: 'Bounded author instructions.', user: '{}', quick: false, sourceUrl: null, reference: null, allowedLinks: [] },
    evidence: '{}', voiceSamples: [],
  };
  const researchOutput = { step: 'research', research, original: null, draft: null, critique: null, stages: [] };
  const researched = await completeManualBlogStep(db, await claim(), researchOutput, executor.acceptance);
  assert.ok(researched.nextJobId);
  const candidate: BlogDraft = {
    postType: 'article', title: 'A controlled draft', excerpt: 'A scoped draft.', summary: 'A controlled draft for independent review.',
    content: '<p>Keep source evidence separate from decisions and record the reason for each decision.</p>',
    keyTakeaways: [], categories: [], tags: [], sourceUrl: null,
  };
  const output = { ...researchOutput, step: 'draft', original: candidate, draft: candidate };
  const identity = await claim(researched.nextJobId);
  const written = await completeManualBlogStep(db, identity, output, executor.acceptance);
  const canonical = await pg.query<{ input: { blogCheckpoint: { draft: unknown }; workforceBlogOutput: Record<string, unknown> }; result: { data: { draft: unknown; artifactId: string } } }>(
    'SELECT input,result FROM agent_jobs WHERE id=$1', [identity.jobId],
  );
  assert.deepEqual(canonical.rows[0]!.input.blogCheckpoint.draft, candidate);
  assert.deepEqual(canonical.rows[0]!.result.data.draft, candidate);
  assert.equal(canonical.rows[0]!.result.data.artifactId, written.artifact.id);
  assert.deepEqual(canonical.rows[0]!.input.workforceBlogOutput[String(identity.attempt)], output);
  await assert.rejects(pg.query("UPDATE agent_jobs SET input=input-'workforceBlogOutput' WHERE id=$1", [identity.jobId]), /immutable/);
  assert.ok(written.nextJobId);
  const successor = await pg.query<{ input: Record<string, unknown> }>('SELECT input FROM agent_jobs WHERE id=$1', [written.nextJobId]);
  assert.equal(successor.rows[0]!.input['workforceBlogOutput'], undefined);
  assert.equal(successor.rows[0]!.input['blogCheckpoint'], undefined);
  const criticIdentity = await claim(written.nextJobId);
  await assert.rejects(completeManualBlogStep(db, criticIdentity, {
    ...output, step: 'critique', draft: { ...candidate, title: 'A critic rewrite' },
    critique: { inputSignature: 'invalid', complete: false, verification: { verified: false, issues: ['Incomplete.'] }, findings: [], stages: [] },
  }, executor.acceptance), /critic cannot edit/);
  await pg.query("UPDATE agent_jobs SET input=jsonb_set(input,'{blogCheckpoint,draft,title}','\"A user edit\"'::jsonb) WHERE id=$1", [identity.jobId]);
  const assignment = await getAssignment(db, created.id, 'fixture-owner');
  await assert.rejects(workforceTransaction(db, client => executor.acceptance.checkCurrent(client, assignment)), /edits have been retained/);
  const retained = await pg.query<{ input: { blogCheckpoint: { draft: { title: string } } } }>('SELECT input FROM agent_jobs WHERE id=$1', [identity.jobId]);
  assert.equal(retained.rows[0]!.input.blogCheckpoint.draft.title, 'A user edit');
  await assert.rejects(beginManualBlogEdit(db, identity.jobId, 'someone-else', reviewedDraftSignature(candidate), randomUUID()), /not found/);
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'running');
  const editAction = randomUUID();
  const editing = await beginManualBlogEdit(db, identity.jobId, 'fixture-owner', reviewedDraftSignature(candidate), editAction);
  assert.equal(editing.changedBeforeEditing, true);
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'superseded');
  assert.deepEqual(await beginManualBlogEdit(db, identity.jobId, 'fixture-owner', reviewedDraftSignature(candidate), editAction), editing);
  assert.equal((await pg.query('SELECT id FROM agent_assignment_events WHERE kind=$1', ['superseded'])).rows.length, 1);
  await assert.rejects(completeManualBlogStep(db, criticIdentity, {
    ...output, step: 'critique',
    critique: { inputSignature: 'invalid', complete: false, verification: { verified: false, issues: ['Incomplete.'] }, findings: [], stages: [] },
  }, executor.acceptance), /no longer owns/);
  assert.equal((await pg.query<{ title: string }>("SELECT input->'blogCheckpoint'->'draft'->>'title' AS title FROM agent_jobs WHERE id=$1", [identity.jobId])).rows[0]!.title, 'A user edit');
});

async function sourceFixture(t: TestContext) {
  const setup = await fixture(t);
  await setup.pg.exec(`
    CREATE TABLE nodes(id UUID PRIMARY KEY,ref_id TEXT,ref_type TEXT,title TEXT);
    CREATE TABLE content_items(id UUID PRIMARY KEY,source TEXT,source_id TEXT,title TEXT,summary TEXT,body TEXT,url TEXT,project_context TEXT,metadata JSONB,published_at TIMESTAMPTZ);
    CREATE TABLE notes(id UUID PRIMARY KEY,project_id TEXT);
    ALTER TABLE ai_chat_sessions ADD COLUMN project_id TEXT,ADD COLUMN excluded_sources JSONB NOT NULL DEFAULT '[]';
  `);
  await setup.pg.exec(await readFile(new URL('../src/db/migrations/039_athena_memory.sql', import.meta.url), 'utf8'));
  const sourceId = randomUUID();
  await setup.pg.query(`INSERT INTO content_items(id,source,source_id,title,body,url,project_context,metadata) VALUES($1,'discovered-article','source-ref','Source title','Source body',NULL,'project-a','{}')`, [sourceId]);
  const subjectId = `discover:${sourceId}`;
  const scope = { projectId: 'project-a', excludedSourceIds: [] as string[], readOnly: false };
  const context = { ownerId: 'fixture-owner', origin: { kind: 'app' as const, requestId: randomUUID() }, ...scope };
  const request = { subjectId, instruction: 'Explain the source without inventing claims.', length: 'long',
    sources: [{ type: 'discover', id: sourceId }, { type: 'configured-profile', id: 'professional' }] };
  return { ...setup, sourceId, context, request };
}

test('manual blog commissioning requires an approved profile and binds the real owner, format and exact source revision', async t => {
  const { db, pg, profileId, context, request, sourceId, options } = await sourceFixture(t);
  await assert.rejects(prepareManualBlogCommission(db, request, context), /remains disabled/);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const prepared = await prepareManualBlogCommission(db, request, context);
  assert.equal(prepared.brief.ownerId, context.ownerId);
  assert.equal(prepared.brief.scope.sources.length, 2);
  await assert.rejects(commissionPreparedManualBlog(db, options.workerPool, prepared, { ...context, ownerId: 'other-owner' }), /authenticated owner/);
  await assert.rejects(commissionPreparedManualBlog(db, options.workerPool, { ...prepared, length: 'short' }, context), /format changed/);
  await pg.query('UPDATE content_items SET body=$2 WHERE id=$1', [sourceId, 'Changed source body']);
  await assert.rejects(commissionPreparedManualBlog(db, options.workerPool, prepared, context), /controlling content/);
  const current = await prepareManualBlogCommission(db, request, context);
  const first = await commissionPreparedManualBlog(db, options.workerPool, current, context);
  const replay = await commissionPreparedManualBlog(db, options.workerPool, current, context);
  assert.equal(first.assignment.id, replay.assignment.id);
  assert.equal(replay.existing, true);
  const capabilities = manualBlogSourceCapabilities();
  const research = await workforceTransaction(db, client => capabilities.loadResearch(client, first.assignment));
  assert.equal(research.instruction, request.instruction);
  assert.equal(research.source.kind, 'discover');
  assert.deepEqual(research.authorRecords.map(record => record.kind), ['profile']);
  assert.deepEqual(research.voiceSamples, []);
  assert.deepEqual(research.earlierPosts, []);
});

test('source-authorised retrieval fails closed for excluded aliases and other projects without broadening its source selection', async t => {
  const { pg, db, sourceId, context, request, profileId } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const alias = randomUUID();
  await pg.query('INSERT INTO nodes(id,ref_id) VALUES($1,$2)', [alias, sourceId]);
  await assert.rejects(prepareManualBlogCommission(db, request, { ...context, excludedSourceIds: [alias] }), /excluded/);
  await assert.rejects(prepareManualBlogCommission(db, request, { ...context, projectId: 'other-project' }), /outside the commissioned project/);
  const prepared = await prepareManualBlogCommission(db, request, context);
  const captured = await workforceTransaction(db, client => captureManualBlogSources(client, prepared.brief));
  assert.deepEqual(captured.sources, prepared.brief.scope.sources);
});

test('existing drafting actions retain explicit format, one primary source and bounded permitted author grounding', async t => {
  const { db, pg, context, request, profileId, options } = await sourceFixture(t);
  for (const id of ['', 'discover', 'discover:lookup-title', 'notes:' + randomUUID(), request.subjectId + ':other']) {
    assert.throws(() => primaryBlogSelection(id), /source|exact Discover/);
  }
  await assert.rejects(startManualBlogCommission(db, options.workerPool, { subjectId: request.subjectId }, context), /Choose Quick take/);
  await assert.rejects(startManualBlogCommission(db, options.workerPool, { subjectId: request.subjectId, length: 'long' }, context), /remains disabled/);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const result = await startManualBlogCommission(db, options.workerPool, { subjectId: request.subjectId, length: 'long' }, context);
  assert.equal(result.assignment.brief.scope.sources.filter(source => source.type === 'discover').length, 1);
  assert.ok(result.assignment.brief.scope.sources.some(source => source.type === 'configured-profile'));
  assert.equal(result.assignment.brief.ownerId, context.ownerId);
  assert.match(result.assignment.brief.instruction, /Do not publish/);
});

test('automatic grounding selects exact permitted records, separates voice from evidence and respects project/excluded aliases', async t => {
  const { db, pg, context, request, profileId, options } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const author = randomUUID();
  const projectMemory = randomUUID();
  const foreignMemory = randomUUID();
  await pg.query(`INSERT INTO athena_memories(id,kind,content,scope_type,scope_value) VALUES
    ($1,'profile','Documented professional background.','global',NULL),
    ($2,'instruction','An explicit project writing preference.','project','project-a'),
    ($3,'profile','Other project background must stay outside this scope.','project','project-b')`, [author, projectMemory, foreignMemory]);
  const voice = randomUUID();
  const excludedPost = randomUUID();
  const foreignPost = randomUUID();
  const postAlias = randomUUID();
  for (const [id, project] of [[voice, 'project-a'], [excludedPost, 'project-a'], [foreignPost, 'project-b']]) {
    await pg.query(`INSERT INTO content_items(id,source,source_id,title,summary,body,url,project_context,metadata,published_at)
      VALUES($1::uuid,'cms-blog',$1::text,'Source title: documented judgement','Source perspective',$2,'https://example.invalid/post/'||$1::text,$3,'{}',clock_timestamp())`,
    [id, 'Source title: an explicitly attributed design judgement. '.repeat(8), project]);
  }
  await pg.query('INSERT INTO nodes(id,ref_id) VALUES($1,$2)', [postAlias, excludedPost]);
  const chat = randomUUID();
  const foreignChat = randomUUID();
  const excludedChat = randomUUID();
  const chatAlias = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id,project_id) VALUES($1,$4),($2,$5),($3,$4)',
    [chat, foreignChat, excludedChat, 'project-a', 'project-b']);
  await pg.query('INSERT INTO nodes(id,ref_id) VALUES($1,$2)', [chatAlias, excludedChat]);
  const message = (await pg.query<{ id: string }>(
    `INSERT INTO ai_chat_messages(session_id,role,content) VALUES($1,'user','Source title: I prefer clearly recorded decisions.') RETURNING id::text`, [chat],
  )).rows[0]!.id;
  await pg.query(`INSERT INTO ai_chat_messages(session_id,role,content) VALUES
    ($1,'assistant','Source title: an assistant opinion is not the author.'),
    ($2,'user','Source title: another project position.'),
    ($3,'user','Source title: an excluded conversation position.')`, [chat, foreignChat, excludedChat]);
  const bounded = { ...context, excludedSourceIds: [postAlias, chatAlias].sort() };
  const prepared = await prepareManualBlogCommission(db, {
    ...request, length: 'short', sources: [request.sources[0]], autoContext: true,
  }, bounded);
  const sources = prepared.brief.scope.sources;
  assert.ok(sources.some(source => source.type === 'author-memory' && source.id === author));
  assert.ok(sources.some(source => source.type === 'author-memory' && source.id === projectMemory));
  assert.ok(sources.some(source => source.type === 'author-message' && source.id === message));
  assert.ok(sources.some(source => source.type === 'blog-voice' && source.id === voice));
  assert.ok(sources.some(source => source.type === 'blog-author-post' && source.id === voice));
  assert.ok(sources.some(source => source.type === 'earlier-post' && source.id === voice));
  assert.equal(sources.some(source => [foreignMemory, excludedPost, foreignPost].some(id => id === source.id)), false);
  assert.equal(sources.some(source => source.type === 'configured-profile'), false);
  const created = await commissionPreparedManualBlog(db, options.workerPool, prepared, bounded);
  const loaded = await workforceTransaction(db, client => manualBlogSourceCapabilities().loadResearch(client, created.assignment));
  assert.equal(loaded.voiceSamples.length, 1);
  assert.equal(loaded.earlierPosts.length, 1);
  assert.equal(loaded.authorRecords.filter(record => record.kind === 'user-message').length, 1);
  assert.equal(loaded.authorRecords.filter(record => record.kind === 'published-post').length, 1);
  await pg.query("UPDATE athena_memories SET status='paused' WHERE id=$1", [author]);
  await assert.rejects(workforceTransaction(db, client => manualBlogSourceCapabilities().checkCurrent(client, created.assignment)), /no longer active/);
});

test('automatic author grounding never revives a paused profile through configured background or an unapproved broader search', async t => {
  const { db, pg, context, request, profileId, options } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  await pg.query("INSERT INTO athena_memories(kind,status,content) VALUES('profile','paused','Do not reintroduce this background.')");
  await assert.rejects(startManualBlogCommission(db, options.workerPool, {
    subjectId: request.subjectId, length: 'long',
  }, context), /No permitted author grounding/);
  assert.equal((await pg.query('SELECT id FROM agent_assignments')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 0);
});

test('a committed drafting action retains its receipt across source changes and disabled profiles without creating or authorising more work', async t => {
  const { db, pg, context, request, profileId, options, sourceId } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const action = { subjectId: request.subjectId, length: 'long' };
  const first = await startManualBlogCommission(db, options.workerPool, action, context);
  await pg.query('UPDATE content_items SET body=$2 WHERE id=$1', [sourceId, 'Updated source after the action committed.']);
  await pg.query('UPDATE agent_budget_profiles SET enabled=FALSE WHERE id=$1', [profileId]);
  const replay = await startManualBlogCommission(db, options.workerPool, action, context);
  assert.equal(replay.existing, true);
  assert.equal(replay.assignment.id, first.assignment.id);
  await assert.rejects(startManualBlogCommission(db, options.workerPool, { ...action, length: 'short' }, context), /different blog action/);
  await assert.rejects(startManualBlogCommission(db, options.workerPool, action, { ...context, readOnly: true }), /read-only|restrictions/);
  await assert.rejects(startManualBlogCommission(db, options.workerPool, action, {
    ...context, origin: { kind: 'app', requestId: randomUUID() },
  }), /remains disabled/);
  assert.equal((await pg.query('SELECT id FROM agent_assignments')).rows.length, 1);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
});

test('chat commissioning refuses absent trusted identity, read-only turns and unsupported scope before accessing storage', async t => {
  const db = new Pool();
  t.after(() => db.end());
  const query = t.mock.method(db, 'query', async () => { throw new Error('Rejected chat actions must not query storage.'); });
  const turn: TrustedChatBlogAction = { userId: 'owner', sessionId: randomUUID(), workforceRequestId: randomUUID(),
    userMessage: 'Draft the article for review.', excludedIds: new Set(), strictProjectId: null, readOnly: false, exclusionsFailed: false };
  for (const change of [
    { userId: undefined }, { sessionId: undefined }, { workforceRequestId: undefined }, { userMessage: undefined },
    { readOnly: true }, { readOnly: undefined }, { exclusionsFailed: true }, { exclusionsFailed: undefined }, { excludedIds: undefined },
    { strictProjectId: undefined },
    { retrievalScope: { filter: { sources: ['cms-blog'] }, families: [], tool: 'search_knowledge_base', inherited: false, timeDefaulted: false } },
  ]) {
    await assert.rejects(async () => startChatManualBlogCommission(db, 'fixture-pool', {
      subjectId: `discover:${randomUUID()}`, length: 'long', confirmed: true, ownerId: 'invented-owner',
    }, { ...turn, ...change }), /authenticated|read-only|boundary/);
  }
  assert.equal(query.mock.callCount(), 0);
});

test('chat drafting binds owner, turn identity, project and exclusions without using model confirmation as authority', async t => {
  const { db, pg, context, request, profileId, options } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const sessionId = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id,project_id) VALUES($1,$2)', [sessionId, context.projectId]);
  const turn = { userId: context.ownerId, sessionId, userMessage: request.instruction, workforceRequestId: randomUUID(),
    excludedIds: new Set<string>(), strictProjectId: context.projectId, readOnly: false, exclusionsFailed: false };
  const input = { subjectId: request.subjectId, length: 'long', ownerId: 'forged-owner', confirmed: true };
  const first = await startChatManualBlogCommission(db, options.workerPool, input, turn);
  const retry = await startChatManualBlogCommission(db, options.workerPool, input, turn);
  assert.equal(first.assignment.id, retry.assignment.id);
  assert.equal(retry.existing, true);
  assert.equal(first.assignment.brief.ownerId, context.ownerId);
  assert.equal(first.assignment.brief.scope.projectId, context.projectId);
  assert.match(first.assignment.brief.instruction, new RegExp(request.instruction));
  assert.ok(first.assignment.brief.scope.sources.some(source => source.type === 'chat-scope' && source.id === sessionId));
});

test('explicit edited-draft recheck is independently budgeted, owner-bound, immutable and cannot schedule another rewrite', async t => {
  const { db, pg, context, request, profileId, options, sourceId } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const original = await startManualBlogCommission(db, options.workerPool, { subjectId: request.subjectId, length: 'long' }, context);
  const executor = createManualBlogExecutor(db, manualBlogSourceCapabilities());
  const claim = async () => {
    const result = await claimManualBlogStep(db, options.workerPool, randomUUID(), new AbortController().signal, executor.acceptance.checkCurrent);
    assert.ok(result);
    return result;
  };
  const research = { prepared: { system: 'Bounded source context.', user: '{}', quick: false, sourceUrl: null, reference: null, allowedLinks: [] },
    evidence: '{}', voiceSamples: [] };
  const researched = { step: 'research', research, original: null, draft: null, critique: null, stages: [] };
  await completeManualBlogStep(db, (await claim()).identity, researched, executor.acceptance);
  const candidate: BlogDraft = { postType: 'article', title: 'The original', excerpt: 'A controlled draft.', summary: 'A controlled draft for review.',
    content: '<p>Keep source evidence separate from decisions and record the reason for each decision.</p>',
    keyTakeaways: [], categories: [], tags: [], sourceUrl: null };
  const root = (await claim()).identity;
  await completeManualBlogStep(db, root, { ...researched, step: 'draft', original: candidate, draft: candidate }, executor.acceptance);
  await assert.rejects(commissionManualBlogRecheck(db, options.workerPool, root.jobId, 'someone-else', randomUUID(), { ...candidate, sourceUrl: undefined }), /not found/);
  await assert.rejects(commissionManualBlogRecheck(db, options.workerPool, root.jobId, context.ownerId, randomUUID(), { ...candidate, sourceUrl: undefined }), /Stop the team/);
  await beginManualBlogEdit(db, root.jobId, context.ownerId, reviewedDraftSignature(candidate), randomUUID());
  await assert.rejects(queueBlogRecheck(db, root.jobId, { ...candidate, sourceUrl: undefined }), /explicit, budgeted/);
  const edited = { ...candidate, title: 'The owner-edited title' };
  const post = { ...edited, sourceUrl: undefined };
  const actionId = randomUUID();
  const rechecked = await commissionManualBlogRecheck(db, options.workerPool, root.jobId, context.ownerId, actionId, post);
  const retry = await commissionManualBlogRecheck(db, options.workerPool, root.jobId, context.ownerId, actionId, post);
  assert.equal(rechecked.assignment.id, retry.assignment.id);
  assert.notEqual(rechecked.assignment.id, original.assignment.id);
  assert.equal((await getAssignment(db, original.assignment.id, context.ownerId)).status, 'superseded');
  const savedBeforeReview = await getAssignmentSummary(db, rechecked.assignment.id, context.ownerId);
  assert.ok(savedBeforeReview.resultUrl, 'the submitted draft must be accessible before any reviewer call');
  const pending = await pg.query<{ id: string }>('SELECT id FROM agent_jobs WHERE assignment_id=$1', [rechecked.assignment.id]);
  const pendingDraft = await getAgentJob(db, pending.rows[0]!.id, context.ownerId);
  assert.equal(pendingDraft.status, 'queued');
  assert.deepEqual(pendingDraft.result?.['draft'], edited);
  assert.deepEqual(pendingDraft.result?.['verification'], { verified: false, issues: ['Independent recheck is pending.'] });
  assert.equal((await pg.query('SELECT id FROM agent_artifacts WHERE assignment_id=$1', [rechecked.assignment.id])).rows.length, 0);
  const critic = await claim();
  assert.equal(critic.definition.key, 'recheck');
  assert.equal(critic.definition.role, 'momus');
  assert.equal(critic.input['workforceCanonicalBlog'], true);
  const review = { inputSignature: critiqueInputSignature(edited, research.evidence), complete: false,
    verification: { verified: false, issues: ['Independent review requires attention.'] }, findings: [], stages: [] };
  const output = { ...researched, step: 'recheck', original: candidate, draft: edited, critique: review };
  await assert.rejects(completeManualBlogStep(db, critic.identity, { ...output, draft: { ...edited, title: 'Momus rewrote it' } }, executor.acceptance), /critic cannot edit/);
  const accepted = await completeManualBlogStep(db, critic.identity, output, executor.acceptance);
  assert.equal(accepted.nextJobId, null);
  assert.equal(accepted.assignment.status, 'waiting');
  const projection = await getAgentJob(db, critic.identity.jobId, context.ownerId);
  assert.equal(projection.status, 'queued', 'an incomplete independent review stays resumable without hiding its saved candidate');
  const summary = await getAssignmentSummary(db, rechecked.assignment.id, context.ownerId);
  assert.equal(summary.resultUrl, `?blogJob=${critic.identity.jobId}`);
  const drafts = await pg.query<{ id: string; title: string }>("SELECT id,input->'blogCheckpoint'->'draft'->>'title' AS title FROM agent_jobs WHERE id=ANY($1::uuid[]) ORDER BY id", [[root.jobId, critic.identity.jobId]]);
  assert.equal(drafts.rows.find(row => row.id === root.jobId)?.title, candidate.title);
  assert.equal(drafts.rows.find(row => row.id === critic.identity.jobId)?.title, edited.title);
  await beginManualBlogEdit(db, critic.identity.jobId, context.ownerId, reviewedDraftSignature(edited), randomUUID());
  const second = await commissionManualBlogRecheck(db, options.workerPool, critic.identity.jobId, context.ownerId, randomUUID(), post);
  assert.notEqual(second.assignment.id, rechecked.assignment.id);
  const unreviewed = await pg.query<{ id: string }>('SELECT id FROM agent_jobs WHERE assignment_id=$1', [second.assignment.id]);
  await beginManualBlogEdit(db, unreviewed.rows[0]!.id, context.ownerId, reviewedDraftSignature(edited), randomUUID());
  const third = await commissionManualBlogRecheck(db, options.workerPool, unreviewed.rows[0]!.id, context.ownerId, randomUUID(), post);
  assert.notEqual(third.assignment.id, second.assignment.id);
  const secondCritic = await claim();
  assert.equal(secondCritic.definition.key, 'recheck', 'an explicit follow-up still cannot restart authoring or reset the automatic revision branch');
  assert.equal(secondCritic.assignment.id, third.assignment.id);
  await assert.rejects(completeManualBlogStep(db, secondCritic.identity, { ...output, draft: { ...edited, title: 'Unrequested change' } }, executor.acceptance), /critic cannot edit/,
    'a cancelled pre-review checkpoint must retain accepted provenance without inventing an accepted review');
  await pg.query("UPDATE agent_jobs SET input=jsonb_set(input,'{workforceRecheckPost,title}','\"A changed request\"'::jsonb) WHERE id=$1", [secondCritic.identity.jobId]);
  await assert.rejects(completeManualBlogStep(db, secondCritic.identity, output, executor.acceptance), /candidate changed after the owner commissioned/);
  await pg.query('UPDATE content_items SET body=$2 WHERE id=$1', [sourceId, 'New source content']);
  await pg.query('UPDATE agent_budget_profiles SET enabled=FALSE WHERE id=$1', [profileId]);
  const savedRecheck = await commissionManualBlogRecheck(db, options.workerPool, root.jobId, context.ownerId, actionId, post);
  assert.equal(savedRecheck.assignment.id, rechecked.assignment.id);
  await assert.rejects(commissionManualBlogRecheck(db, options.workerPool, critic.identity.jobId, context.ownerId, actionId, post), /different blog recheck/);
  await assert.rejects(commissionManualBlogRecheck(db, options.workerPool, root.jobId, context.ownerId, randomUUID(), post), /will not silently refresh/);
});

test('a chat commission snapshots live exclusions/project but ordinary chat progress does not invalidate its sources', async t => {
  const { db, pg, context, request, profileId, options, sourceId } = await sourceFixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const conversationId = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id,project_id) VALUES($1,$2)', [conversationId, context.projectId]);
  const chatContext = { ...context, origin: { kind: 'chat' as const, conversationId, requestId: randomUUID() } };
  const prepared = await prepareManualBlogCommission(db, request, chatContext);
  assert.equal(prepared.brief.scope.sources.some(source => source.type === 'chat-scope' && source.id === conversationId), true);
  const created = await commissionPreparedManualBlog(db, options.workerPool, prepared, chatContext);
  const capabilities = manualBlogSourceCapabilities();
  await pg.query('UPDATE ai_chat_sessions SET updated_at=clock_timestamp() WHERE id=$1', [conversationId]);
  await workforceTransaction(db, client => capabilities.checkCurrent(client, created.assignment));
  await pg.query('UPDATE ai_chat_sessions SET excluded_sources=$2::jsonb WHERE id=$1', [conversationId, JSON.stringify([{ id: sourceId, kind: 'item', title: 'Source title' }])]);
  await assert.rejects(workforceTransaction(db, client => capabilities.checkCurrent(client, created.assignment)), /conversation scope changed/);
  await assert.rejects(prepareManualBlogCommission(db, request, chatContext), /newer source exclusion/);
});

test('a workflow with no installed domain executor is never claimed by the shared worker', async t => {
  const { pg, db, options } = await queuedFixture(t);
  assert.equal(await claimConfiguredAssignment(db, options.workerPool, randomUUID(), new AbortController().signal), null);
  const jobs = await pg.query<{ status: string; attempts: number }>('SELECT status,attempts FROM agent_jobs');
  assert.deepEqual(jobs.rows, [{ status: 'queued', attempts: 0 }]);
});

test('assignment notification acknowledgement is owner-bound, durable and independent of retained artifacts', async t => {
  const { db, pg, created } = await queuedFixture(t);
  const cancelled = await cancelAssignment(db, created.id, 'fixture-owner', created.revision);
  await pg.query("UPDATE agent_assignment_events SET created_at=clock_timestamp()-INTERVAL '1 second' WHERE assignment_id=$1", [created.id]);
  await pg.query("INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'budget-overrun')", [randomUUID(), created.id, cancelled.revision]);
  assert.deepEqual(await listAssignmentNotices(db, 'someone-else'), []);
  const notices = await listAssignmentNotices(db, 'fixture-owner');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.assignment.status, 'cancelled');
  await assert.rejects(acknowledgeAssignmentNotice(db, notices[0]!.eventId, 'someone-else'), /not found/);
  assert.equal((await listAssignmentNotices(db, 'fixture-owner')).length, 1);
  await acknowledgeAssignmentNotice(db, notices[0]!.eventId, 'fixture-owner');
  await acknowledgeAssignmentNotice(db, notices[0]!.eventId, 'fixture-owner');
  assert.deepEqual(await listAssignmentNotices(db, 'fixture-owner'), []);
  await pg.query("INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'failed')", [randomUUID(), created.id, cancelled.revision]);
  assert.deepEqual(await listAssignmentNotices(db, 'fixture-owner'), [], 'a later event must not reannounce an already acknowledged outcome revision');
  assert.equal((await pg.query('SELECT id FROM agent_assignments')).rows.length, 1);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
});

test('chat completion notifications wait for the transactional conversation notice receipt', async t => {
  const { pg, db, options, profileId } = await fixture(t);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  const conversationId = randomUUID();
  await pg.query('INSERT INTO ai_chat_sessions(id) VALUES($1)', [conversationId]);
  const created = (await commissionAssignment(db, {
    ...brief(), origin: { kind: 'chat', conversationId, requestId: randomUUID() },
  }, options)).assignment;
  await cancelAssignment(db, created.id, 'fixture-owner', created.revision);
  assert.deepEqual(await listAssignmentNotices(db, 'fixture-owner'), []);
  await deliverAssignmentNotices(db, options.workerPool);
  const notices = await listAssignmentNotices(db, 'fixture-owner');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.conversationId, conversationId);
  assert.equal((await pg.query('SELECT id FROM ai_chat_messages')).rows.length, 1);
});

test('assignment status is owner-bound and exposes role/progress metadata without the private commission or evidence', async t => {
  const { db, created } = await queuedFixture(t);
  const summary = await getAssignmentSummary(db, created.id, 'fixture-owner');
  assert.equal(summary.currentStep?.role, 'iris');
  assert.equal(summary.currentStep?.name, 'Iris');
  assert.equal(summary.callsUsed, '0');
  assert.equal(summary.tokensUsed, '0');
  assert.equal(summary.resultUrl, null);
  assert.equal(summary.status, 'queued');
  const fields = Object.keys(summary);
  for (const privateField of ['brief', 'instruction', 'scope', 'evidence', 'input', 'ownerId']) {
    assert.equal(fields.includes(privateField), false);
  }
  await assert.rejects(getAssignmentSummary(db, created.id, 'someone-else'), /not found/);
  assert.deepEqual(await listAssignmentSummaries(db, 'someone-else'), []);
  assert.equal((await listAssignmentSummaries(db, 'fixture-owner')).length, 1);
});

test('assignment steps do not leak through legacy background lists or unauthorised draft reads', async t => {
  const { pg, db } = await queuedFixture(t);
  const job = await pg.query<{ id: string }>('SELECT id FROM agent_jobs');
  const id = job.rows[0]!.id;
  assert.deepEqual(await listLiveAgentJobs(db), []);
  assert.deepEqual(await listAgentJobs(db, {}), []);
  await assert.rejects(getAgentJob(db, id), /not found/);
  await assert.rejects(getAgentJob(db, id, 'someone-else'), /not found/);
  assert.equal((await getAgentJob(db, id, 'fixture-owner')).id, id);
});

test('an invalid worker identity is surfaced instead of inventing an assignment worker label', async t => {
  const { pg, db, created } = await queuedFixture(t);
  await pg.query("UPDATE agent_jobs SET role_id='invented-worker' WHERE assignment_id=$1", [created.id]);
  await assert.rejects(getAssignmentSummary(db, created.id, 'fixture-owner'), /invalid worker metadata/);
});

test('shared-slot dispatch carries immutable attempt and durable budget attribution into canonical acceptance', async t => {
  const { pg, db, claim, created } = await queuedFixture(t);
  const claimed = await claim();
  assert.ok(claimed);
  const proposal = { evidence: 'Reviewed scoped evidence' };
  let broadcast = 0;
  await runManualBlogStep(db, claimed, {
    execute: async context => {
      assert.equal(context.definition.role, 'iris');
      assert.equal(context.assignment.id, created.id);
      assert.equal(currentAgentAttempt()?.assignmentId, created.id);
      assert.equal(currentAgentAttempt()?.budgetDb, db);
      assert.ok(currentAgentAttempt()?.budgetSignal);
      return proposal;
    },
    acceptance: {
      checkCurrent: async () => {},
      accept: async () => ({
        reference: { id: 'fixture-evidence', type: 'blog-evidence', revision: '1', signature: contentSignature(proposal) },
        schemaVersion: 1, summary: 'Evidence saved.', disposition: { kind: 'continue' },
      }),
    },
  }, result => {
    broadcast++;
    assert.ok(result.nextJobId);
  });
  assert.equal(broadcast, 1);
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 1);
  const workflows = await pg.query<{ feature: string; status: string; job_id: string }>('SELECT feature,status,job_id FROM ai_workflow_runs');
  assert.deepEqual(workflows.rows, [{ feature: 'manual-blog-research', status: 'completed', job_id: claimed.identity.jobId }]);
  assert.equal(currentAgentAttempt(), undefined);
});

test('a shared-slot stale-source failure supersedes the assignment without accepting output or creating a successor', async t => {
  const { pg, db, claim, created } = await queuedFixture(t);
  const claimed = await claim();
  assert.ok(claimed);
  await runManualBlogStep(db, claimed, {
    execute: async () => { throw new ConflictError('The controlling source changed.', 'ASSIGNMENT_SOURCE_CHANGED'); },
    acceptance: {
      checkCurrent: async () => {},
      accept: async () => { throw new Error('Stale output must never reach acceptance.'); },
    },
  }, () => { throw new Error('A failed step cannot broadcast completion.'); });
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'superseded');
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 0);
  assert.equal((await pg.query('SELECT id FROM agent_jobs')).rows.length, 1);
});

test('the dispatcher enforces its original deadline before starting the executor', async t => {
  const { db, claim, created } = await queuedFixture(t);
  const claimed = await claim();
  assert.ok(claimed);
  await runManualBlogStep(db, {
    ...claimed, assignment: { ...claimed.assignment, deadline: new Date(Date.now() - 1) },
  }, {
    execute: async () => { throw new Error('Expired work must never dispatch.'); },
    acceptance: {
      checkCurrent: async () => {},
      accept: async () => { throw new Error('Expired output must never reach acceptance.'); },
    },
  }, () => { throw new Error('Expired work cannot broadcast completion.'); });
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'waiting');
});

test('a failed live completion broadcast cannot roll back or retry an already committed artifact', async t => {
  const { pg, db, claim, created } = await queuedFixture(t);
  const claimed = await claim();
  assert.ok(claimed);
  t.mock.method(console, 'error', () => {});
  await runManualBlogStep(db, claimed, {
    execute: async () => ({ evidence: 'Saved' }),
    acceptance: {
      checkCurrent: async () => {},
      accept: async () => ({
        reference: { id: 'fixture-evidence', type: 'blog-evidence', revision: '1', signature: contentSignature({ evidence: 'Saved' }) },
        schemaVersion: 1, summary: 'Evidence saved.', disposition: { kind: 'continue' },
      }),
    },
  }, () => { throw new Error('Fixture event listener failure'); });
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'running');
  assert.equal((await pg.query('SELECT id FROM agent_artifacts')).rows.length, 1);
  assert.equal((await pg.query("SELECT id FROM agent_jobs WHERE status='queued'")).rows.length, 1);
  assert.equal((await pg.query("SELECT id FROM agent_assignment_events WHERE kind='step-retry'")).rows.length, 0);
});

test('assignment claims preserve pool/protocol isolation, renew only the owner and refuse a second live claim', async t => {
  const { pg, db, created, claim } = await queuedFixture(t);
  assert.equal(await claim(randomUUID(), 'other-pool'), null);
  await pg.query('UPDATE agent_jobs SET protocol_version=99 WHERE assignment_id=$1', [created.id]);
  assert.equal(await claim(), null);
  await pg.query('UPDATE agent_jobs SET protocol_version=2 WHERE assignment_id=$1', [created.id]);
  const first = await claim();
  assert.ok(first);
  assert.equal(first.assignment.status, 'running');
  assert.equal(first.definition.role, 'iris');
  assert.equal(first.identity.attempt, 1);
  assert.equal(await claim(), null);
  assert.equal(await renewAssignmentLease(db, { ...first.identity, owner: randomUUID() }), false);
  assert.equal(await renewAssignmentLease(db, first.identity), true);
  assert.equal(await recoverAssignmentStep(db, first.identity.workerPool), null);
});

test('expired assignment work recovers only in its pool; the old owner cannot renew or accept late output', async t => {
  const { pg, db, claim, options } = await queuedFixture(t);
  const first = await claim();
  assert.ok(first);
  await pg.query("UPDATE agent_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [first.identity.jobId]);
  assert.equal(await recoverAssignmentStep(db, 'other-pool'), null);
  assert.ok(await recoverAssignmentStep(db, options.workerPool));
  const second = await claim();
  assert.ok(second);
  assert.equal(second.identity.jobId, first.identity.jobId);
  assert.equal(second.identity.attempt, 2);
  assert.equal(await renewAssignmentLease(db, first.identity), false);
  await assert.rejects(completeManualBlogStep(db, first.identity, {}, {
    checkCurrent: async () => {},
    accept: async () => { throw new Error('Old owner must not reach acceptance.'); },
  }), /changed before acceptance/);
  assert.equal(await renewAssignmentLease(db, second.identity), true);
});

test('cancellation and disabled numeric profiles fence live assignment heartbeats without erasing artifacts', async t => {
  const { pg, db, claim, profileId, created } = await queuedFixture(t);
  const active = await claim();
  assert.ok(active);
  await pg.query('UPDATE agent_budget_profiles SET enabled=FALSE WHERE id=$1', [profileId]);
  assert.equal(await renewAssignmentLease(db, active.identity), false);
  const stopped = await recoverAssignmentStep(db, active.identity.workerPool);
  assert.equal(stopped?.status, 'waiting');
  assert.equal(await claim(), null);
  await pg.query('UPDATE agent_budget_profiles SET enabled=TRUE WHERE id=$1', [profileId]);
  assert.equal(await claim(), null);
  const waiting = await getAssignment(db, created.id, 'fixture-owner');
  await cancelAssignment(db, created.id, 'fixture-owner', waiting.revision);
  assert.equal(await recoverAssignmentStep(db, active.identity.workerPool), null);
  assert.equal(await renewAssignmentLease(db, active.identity), false);
});

test('explicit resume rechecks owner, revision, authority and original allowance without refreshing any of them', async t => {
  const { pg, db, claim, created } = await queuedFixture(t);
  const active = await claim();
  assert.ok(active);
  const waited = await recordAssignmentFailure(db, active.identity, { kind: 'wait', reason: 'Missing required evidence.' });
  assert.ok(waited);
  const authority = {
    ownerId: 'fixture-owner', revision: waited.revision, requestId: randomUUID(), checkCurrent: async () => {},
  };
  await assert.rejects(resumeAssignment(db, created.id, { ...authority, ownerId: 'another-owner' }), /not found/);
  await assert.rejects(resumeAssignment(db, created.id, { ...authority, revision: waited.revision + 1 }), /changed/);
  await assert.rejects(resumeAssignment(db, created.id, {
    ...authority, checkCurrent: async () => { throw new Error('The source was edited.'); },
  }), /source was edited/);
  const resumed = await resumeAssignment(db, created.id, authority);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.deadline.getTime(), created.deadline.getTime());
  assert.equal(resumed.budgetProfileId, created.budgetProfileId);
  assert.deepEqual(resumed.brief, created.brief);
  const events = await pg.query<{ metadata: unknown }>("SELECT metadata FROM agent_assignment_events WHERE kind='resumed'");
  assert.deepEqual(events.rows[0]!.metadata, { requestId: authority.requestId, ownerId: 'fixture-owner' });
  await assert.rejects(resumeAssignment(db, created.id, authority), /changed/);
  const next = await claim();
  assert.ok(next);
  assert.equal(next.identity.attempt, 2);
});

test('expired budgets wait instead of dispatching and explicit resume cannot replenish them', async t => {
  const { pg, db, created, claim } = await queuedFixture(t);
  await pg.query("UPDATE agent_assignments SET deadline=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [created.id]);
  assert.equal(await claim(), null);
  const waiting = await getAssignment(db, created.id, 'fixture-owner');
  assert.equal(waiting.status, 'waiting');
  await assert.rejects(resumeAssignment(db, created.id, {
    ownerId: 'fixture-owner', revision: waiting.revision, requestId: randomUUID(), checkCurrent: async () => {},
  }), /cannot reset/);
  const jobs = await pg.query<{ attempts: number }>('SELECT attempts FROM agent_jobs WHERE assignment_id=$1', [created.id]);
  assert.equal(jobs.rows[0]!.attempts, 0);
});

test('classified transient failures use the original finite attempt limit; unknown failures never silently retry', async t => {
  const { db, claim, created } = await queuedFixture(t);
  for (const attempt of [1, 2, 3]) {
    const active = await claim();
    assert.ok(active);
    assert.equal(active.identity.attempt, attempt);
    const failed = await recordAssignmentFailure(db, active.identity, { kind: 'transient', reason: 'Classified temporary transport outage.' });
    assert.equal(failed?.status, attempt < 3 ? 'running' : 'failed');
  }
  assert.equal(await claim(), null);
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).readiness, 'blocked');
});

test('stale controlling sources supersede before any step is dispatched; invalid role metadata fails explicitly', async t => {
  const { pg, db, created, options } = await queuedFixture(t);
  assert.equal(await claimManualBlogStep(db, options.workerPool, randomUUID(), new AbortController().signal, async () => {
    throw new ConflictError('The controlling source was edited.', 'ASSIGNMENT_SOURCE_CHANGED');
  }), null);
  assert.equal((await getAssignment(db, created.id, 'fixture-owner')).status, 'superseded');
  const another = (await commissionAssignment(db, brief(), options)).assignment;
  await pg.query("UPDATE agent_jobs SET role_id='athena' WHERE assignment_id=$1", [another.id]);
  assert.equal(await claimManualBlogStep(db, options.workerPool, randomUUID(), new AbortController().signal, async () => {}), null);
  assert.equal((await getAssignment(db, another.id, 'fixture-owner')).status, 'failed');
});
