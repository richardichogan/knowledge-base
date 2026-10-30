import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/podcast-chat';
process.env.NODE_ENV = 'development';
const { executePodcastTool } = await import('../src/ai/podcastTools.js');
const owner = '00000000-0000-0000-0000-000000000001';

function fixture(t: TestContext) {
  const db = new Pool({ connectionString: 'postgresql://isolated.invalid/podcast-chat' });
  t.after(() => db.end());
  const script = {
    revision: 1, intro: 'Welcome to the podcast.', activeWorker: false, writes: 0,
    cards: [
      { id: 'github', title: 'GitHub story', synopsis: 'An agent can support a delivery team.', bullets: ['Check permissions.'] },
      { id: 'azure', title: 'Azure story', synopsis: 'A team can evaluate the deployment limits.', bullets: ['Check availability.'] },
      { id: 'copilot', title: 'Copilot story', synopsis: 'Explain what users can actually do.', bullets: [] },
    ],
  };
  const query = async (sql: string, values: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM podcast_episodes e JOIN notes')) return { rows: [{
      note_id: owner, content: JSON.stringify({ title: 'Episode 46', contentType: 'podcast-episode' }), project_id: null,
      episode_number: 46, recording_date: null, prep_session_id: null, script_intro: script.intro,
      script_cards: structuredClone(script.cards), script_note_id: null, transcript: null, transcript_filename: null,
      transcript_uploaded_at: null, show_notes_session_id: null, show_notes_note_id: null, revision: script.revision,
    }], rowCount: 1 };
    if (sql.includes('FROM agent_jobs') && !sql.startsWith('UPDATE podcast_episodes')) return { rows: script.activeWorker ? [{
      id: owner, specialist: 'podcast-script-writer', subject_type: 'podcast-episode', subject_id: owner,
      subject_title: 'Episode 46', subject_url: '/think', status: 'running', progress: ['Writing'],
      result: null, error: null, depends_on: null, is_step: false, conversation_id: null, requested_by: 'app',
      acknowledged_at: null, created_at: new Date(), started_at: new Date(), finished_at: null,
    }] : [], rowCount: script.activeWorker ? 1 : 0 };
    if (sql.startsWith('UPDATE podcast_episodes')) {
      if (values[1] !== script.revision) return { rows: [], rowCount: 0 };
      script.writes++;
      script.revision++;
      script.intro = String(values[2]);
      script.cards = JSON.parse(String(values[3]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id FROM notes')) return { rows: [], rowCount: 0 };
    assert.fail(`Unexpected SQL: ${sql}`);
  };
  t.mock.method(db, 'query', query);
  t.mock.method(db, 'connect', async () => ({ query, release() {} }));
  const state = { readCardIds: new Set<string>(), changed: false };
  const read = (args = {}) => executePodcastTool(db, 'read_podcast_script', owner, args, {}, state);
  const update = (args: Record<string, unknown>) => executePodcastTool(db, 'update_podcast_script', owner, args, {}, state);
  return { db, script, state, read, update };
}

test('Podcast read supplies actual card text and duration counts for all three stories, not the parent note', async t => {
  const f = fixture(t);
  const result = await f.read();
  assert.ok(result && typeof result === 'object' && 'cards' in result && 'totals' in result);
  assert.deepEqual(result.cards, f.script.cards);
  assert.deepEqual(result.totals, {
    synopsisWords: 20, supportingWords: 4, synopsisReadingTime: { minSeconds: 8, maxSeconds: 10 },
    allWrittenMaterialReadingTime: { minSeconds: 9, maxSeconds: 12 },
  });
  assert.equal(f.state.readCardIds.size, 3);
  assert.equal(f.script.writes, 0);
});

test('a targeted synopsis edit persists while retaining intro, other cards and bullet points', async t => {
  const f = fixture(t);
  await f.read();
  const before = structuredClone(f.script);
  await f.update({ expectedRevision: 1, cards: [{ id: 'github', synopsis: 'Here is the expanded enterprise explanation.' }] });
  assert.equal(f.script.cards[0]?.synopsis, 'Here is the expanded enterprise explanation.');
  assert.deepEqual(f.script.cards[0]?.bullets, before.cards[0]?.bullets);
  assert.deepEqual(f.script.cards.slice(1), before.cards.slice(1));
  assert.equal(f.script.intro, before.intro);
  assert.equal(f.script.writes, 1);
  assert.equal(f.state.changed, true);
});

test('intro edits preserve the complete card collection', async t => {
  const f = fixture(t);
  await f.read();
  const cards = structuredClone(f.script.cards);
  await f.update({ expectedRevision: 1, intro: 'Welcome. Here is our running order.' });
  assert.equal(f.script.intro, 'Welcome. Here is our running order.');
  assert.deepEqual(f.script.cards, cards);
});

test('unread, stale, unknown-card and worker-busy changes cannot overwrite the script', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.update({ expectedRevision: 1, intro: 'Wrong' }), /Read the current/);
  await f.read({ cardId: 'github' });
  await assert.rejects(() => f.update({ expectedRevision: 1, cards: [{ id: 'azure', synopsis: 'Unread' }] }), /Read each card/);
  await assert.rejects(() => f.update({ expectedRevision: 1, cards: [{ id: 'missing', synopsis: 'Unknown' }] }), /Read each card/);
  f.script.revision++;
  await assert.rejects(() => f.update({ expectedRevision: 1, intro: 'Stale' }), /Read the current/);
  await f.read();
  f.script.activeWorker = true;
  await assert.rejects(() => f.update({ expectedRevision: 2, intro: 'Busy' }), /worker is still running/);
  assert.equal(f.script.writes, 0);
});

test('excluded sources and enforced project scope apply to script reading and writing', async t => {
  const f = fixture(t);
  for (const access of [{ excludedIds: new Set([owner]) }, { exclusionsFailed: true }, { strictProjectId: 'another-project' }]) {
    await assert.rejects(() => executePodcastTool(f.db, 'read_podcast_script', owner, {}, access, f.state), /unavailable|outside/);
    await assert.rejects(() => executePodcastTool(f.db, 'update_podcast_script', owner, { expectedRevision: 1, intro: 'Blocked' }, access, f.state), /unavailable|outside/);
  }
  assert.equal(f.script.writes, 0);
});

test('large scripts page complete cards without losing unread text', async t => {
  const f = fixture(t);
  for (const card of f.script.cards) {
    card.synopsis = 'A'.repeat(6000);
    card.bullets = Array.from({ length: 40 }, () => 'B'.repeat(500));
  }
  const first = await f.read();
  assert.ok(first && typeof first === 'object' && 'cards' in first && 'nextOffset' in first);
  assert.deepEqual(first.cards, f.script.cards.slice(0, 1));
  assert.equal(first.nextOffset, 1);
  const second = await f.read({ offset: 1 });
  assert.ok(second && typeof second === 'object' && 'cards' in second && 'nextOffset' in second);
  assert.deepEqual(second.cards, f.script.cards.slice(1, 2));
  assert.equal(second.nextOffset, 2);
  const third = await f.read({ offset: 2 });
  assert.ok(third && typeof third === 'object' && 'cards' in third && 'nextOffset' in third);
  assert.deepEqual(third.cards, f.script.cards.slice(2));
  assert.equal(third.nextOffset, null);
});

test('normal editor field limits and invalid patches cannot alter saved content', async t => {
  const f = fixture(t);
  await f.read();
  for (const patch of [
    { synopsis: 'A'.repeat(6001) }, { title: 42 }, { bullets: [false] }, { ignored: 'unexpected' },
  ]) {
    await assert.rejects(() => f.update({ expectedRevision: 1, cards: [{ id: 'github', ...patch }] }));
  }
  assert.equal(f.script.writes, 0);
});
