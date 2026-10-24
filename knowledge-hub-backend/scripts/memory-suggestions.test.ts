import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { runWeeklyMemoryReview } from '../src/ai/memorySuggestions.js';
import { buildStandingInstructionsBlock } from '../src/ai/athenaMemory.js';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

test('saved preferences govern relevant work, while liked long replies are optional rather than a conversational template', async () => {
  const db = new Pool();
  const queries: string[] = [];
  const query = mock.method(db, 'query', async (sql: string) => {
    queries.push(sql);
    return { rows: sql.includes("kind = 'instruction'")
      ? [{ id: 'instruction', content: 'Use a fenced block for a requested coding prompt.', scope_type: 'output', scope_value: 'GHCP prompt' }]
      : sql.includes("kind = 'example'") ? [{ id: 'example', content: 'An old lengthy deliverable.', scope_type: 'persona', scope_value: 'general' }] : [] };
  });
  try {
    const conversation = await buildStandingInstructionsBlock(db, { persona: 'general', includeExamples: false });
    assert.match(conversation, /current request and chosen review depth govern this turn/);
    assert.match(conversation, /when producing: GHCP prompt/);
    assert.doesNotMatch(conversation, /old lengthy|always follow|match their structure/);
    assert.ok(!queries.some(sql => sql.includes("kind = 'example'")));
    const output = await buildStandingInstructionsBlock(db, { persona: 'general', includeExamples: true });
    assert.match(output, /An old lengthy deliverable/);
    assert.match(output, /do not set review depth, reply length, current facts, or permission to act/);
  } finally { query.mock.restore(); await db.end(); }
});

test('the profile migration replaces only the exact active legacy delivery preference and is idempotent', async () => {
  const db = new PGlite();
  const legacy = "On open-ended or creative asks, produce output first with assumptions briefly stated, then iterate — don't withhold output just to ask a clarifying question unless the task genuinely cannot proceed without one.";
  try {
    await db.exec('CREATE TABLE athena_memories(id text, kind text, status text, content text, updated_at timestamptz)');
    for (const row of [
      ['profile', 'profile', 'active', `Preserve personal facts.\n${legacy}\nPreserve output formatting.`],
      ['paused', 'profile', 'paused', legacy],
      ['instruction', 'instruction', 'active', legacy],
      ['custom', 'profile', 'active', 'My independently edited profile must stay unchanged.'],
    ]) await db.query('INSERT INTO athena_memories(id, kind, status, content) VALUES ($1,$2,$3,$4)', row);
    const migration = await readFile(new URL('../src/db/migrations/098_conversational_profile.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    const { rows } = await db.query<{ id: string; content: string }>('SELECT id, content FROM athena_memories ORDER BY id');
    const profile = rows.find(row => row.id === 'profile')!.content;
    assert.match(profile, /Preserve personal facts\.\nOn open-ended/);
    assert.match(profile, /conversational thinking partner/);
    assert.match(profile, /not ask repetitive or token questions/);
    assert.match(profile, /Preserve output formatting\.$/);
    assert.equal(rows.find(row => row.id === 'paused')!.content, legacy);
    assert.equal(rows.find(row => row.id === 'instruction')!.content, legacy);
    assert.equal(rows.find(row => row.id === 'custom')!.content, 'My independently edited profile must stay unchanged.');
    const again = await db.exec(migration);
    assert.equal(again[0]?.affectedRows, 0);
  } finally { await db.close(); }
});

test('correction learning pairs user evidence with the preceding reply and only saves traceable suggestions for approval', async () => {
  const db = new Pool();
  const user = 'Ask about my intended outcome before designing the specification.';
  const writes: unknown[][] = [];
  let exchangesQuery = '';
  const query = mock.method(db, 'query', async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM ai_chat_messages m')) {
      exchangesQuery = sql;
      return { rows: Array.from({ length: 5 }, () => ({
        content: user, prior_reply: 'No questions needed. I completed everything.',
        persona: 'demo_designer', session_id: '11111111-1111-4111-8111-111111111111',
      })) };
    }
    if (sql.includes('INSERT INTO athena_memories')) {
      writes.push(values ?? []);
      return { rows: [{ id: 'memory-one' }] };
    }
    return { rows: [] };
  });
  const completion = mock.method(FoundryClient.prototype, 'chat', async (_model, messages) => {
    const prompt = JSON.stringify(messages);
    assert.ok(prompt.includes('No questions needed. I completed everything.'));
    assert.ok(prompt.includes(user));
    assert.ok(prompt.includes('software defects'));
    assert.ok(prompt.includes('one-off permission'));
    return JSON.stringify([
      { instruction: 'Explore the intended outcome before spec design.', scope: 'persona', evidence: user, messageIndex: 0 },
      { instruction: 'Trust completion claims.', scope: 'global', evidence: 'I completed everything.', messageIndex: 0 },
    ]);
  });
  try {
    assert.equal(await runWeeklyMemoryReview(db), 1);
    assert.match(exchangesQuery, /a\.session_id = m\.session_id/);
    assert.match(exchangesQuery, /a\.id < m\.id/);
    assert.ok(writes[0]?.includes('suggested'));
    assert.ok(writes[0]?.includes('demo_designer'));
    assert.ok(writes[0]?.includes('11111111-1111-4111-8111-111111111111'));
    assert.ok(writes[0]?.includes(user));
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});

test('invalid learning responses fail explicitly rather than looking like a successful empty review', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string) => ({
    rows: sql.includes('FROM ai_chat_messages m')
      ? Array.from({ length: 5 }, () => ({ content: 'Correction', prior_reply: null, persona: 'general', session_id: 'session' }))
      : [],
  }));
  const completion = mock.method(FoundryClient.prototype, 'chat', async () => 'not valid JSON');
  try {
    await assert.rejects(runWeeklyMemoryReview(db), /invalid suggestion list/);
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});
