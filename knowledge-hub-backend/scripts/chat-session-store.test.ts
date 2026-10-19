import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { readPastChat, searchPastChats, searchReferencedPastChats } from '../src/ai/chatSessionStore.js';

async function fixture(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE ai_chat_sessions (
      id uuid PRIMARY KEY,
      title text,
      updated_at timestamptz NOT NULL,
      from_think boolean NOT NULL DEFAULT false
    );
    CREATE TABLE ai_chat_messages (
      id serial PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES ai_chat_sessions(id),
      role text NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL
    );
    INSERT INTO ai_chat_sessions (id, title, updated_at, from_think) VALUES
      ('00000000-0000-0000-0000-000000000001', 'Topical but wrong chat', '2026-10-19T10:00:00Z', false),
      ('00000000-0000-0000-0000-000000000002', 'Earlier gate discussion', '2026-10-18T10:00:00Z', true),
      ('00000000-0000-0000-0000-000000000003', 'Current chat', '2026-10-19T11:00:00Z', false);
    INSERT INTO ai_chat_messages (session_id, role, content, created_at) VALUES
      ('00000000-0000-0000-0000-000000000001', 'user', 'Can you review this process?', '2026-10-19T09:59:00Z'),
      ('00000000-0000-0000-0000-000000000001', 'assistant', 'The decision gate controls delegation and acceptance.', '2026-10-19T10:00:00Z'),
      ('00000000-0000-0000-0000-000000000002', 'user', 'Would a decision gate with delegation and acceptance properties work?', '2026-10-18T09:59:00Z'),
      ('00000000-0000-0000-0000-000000000002', 'assistant', 'Use one gate with separate inbound acceptance and outbound delegation properties.', '2026-10-18T10:00:00Z'),
      ('00000000-0000-0000-0000-000000000003', 'user', 'Based on the conversation around decision gates in Think, are we describing the flow accurately?', '2026-10-19T11:00:00Z');
  `);
  return db;
}

test('past-chat search ranks the user-authored source above topical assistant repetition', async () => {
  const db = await fixture();
  try {
    const matches = await searchPastChats(
      db as unknown as Pool,
      'decision gates delegation acceptance',
      '00000000-0000-0000-0000-000000000003',
      5,
    );
    assert.equal(matches[0]?.sessionId, '00000000-0000-0000-0000-000000000002');
    assert.equal(matches[0]?.excerptRole, 'user');
  } finally {
    await db.close();
  }
});

test('decision-gate reference search expands to the delegation and acceptance exchange', async () => {
  const db = await fixture();
  try {
    const matches = await searchReferencedPastChats(
      db as unknown as Pool,
      'decision gates',
      '00000000-0000-0000-0000-000000000003',
    );
    assert.equal(matches[0]?.sessionId, '00000000-0000-0000-0000-000000000002');
  } finally {
    await db.close();
  }
});

test('query-focused chat read returns full relevant messages rather than a clipped recent preview', async () => {
  const db = await fixture();
  try {
    const chat = await readPastChat(
      db as unknown as Pool,
      '00000000-0000-0000-0000-000000000002',
      3,
      'decision gate delegation acceptance',
    );
    assert.ok(chat);
    assert.equal(chat.fromThink, true);
    assert.ok(chat.messages.some((message) => message.role === 'assistant'
      && message.content.includes('separate inbound acceptance and outbound delegation properties')));
  } finally {
    await db.close();
  }
});
