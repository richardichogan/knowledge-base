import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { runWeeklyMemoryReview } from '../src/ai/memorySuggestions.js';

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
