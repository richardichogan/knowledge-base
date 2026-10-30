import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/podcast-script';
process.env.NODE_ENV = 'development';
const { getSpecialist } = await import('../src/agents/index.js');
const { getFoundryClient } = await import('../src/ai/foundryClient.js');
const specialist = getSpecialist('podcast-script-writer')!;
const noteId = '00000000-0000-0000-0000-000000000001';
const jobId = '00000000-0000-0000-0000-000000000002';
const synopsis = 'Azure introduces a new deployment option. We can examine the documented limits before trying it with a workload.';
const candidate = { intro: 'Welcome to the episode.', cards: [{ title: 'Azure deployment', synopsis, bullets: ['Check region availability.'] }] };

test('podcast specialist requires a numeric revision and is registered for episodes', () => {
  assert.equal(specialist.subjectType, 'podcast-episode');
  for (const revision of [undefined, '1', -1, 1.5, NaN]) {
    assert.throws(() => specialist.parseInput!({ revision }), /revision/);
  }
  assert.deepEqual(specialist.parseInput!({ revision: 1 }), { revision: 1 });
});

for (const mode of ['save', 'changed-before-run', 'changed-during-run', 'stale-attempt', 'abort'] as const) {
  test(`podcast worker: ${mode}`, async t => {
    const db = new Pool({ connectionString: 'postgresql://isolated.invalid/podcast-script' });
    t.after(() => db.end());
    const controller = new AbortController();
    const progress: string[] = [];
    let revision = mode === 'changed-before-run' ? 2 : 1;
    let saves = 0;
    let intro = 'Original intro';
    const savedCards: Array<{ title: string; synopsis: string; bullets: string[] }> = [];
    t.mock.method(db, 'connect', async () => ({ query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} }));
    t.mock.method(db, 'query', async (sql: string, values: unknown[] = []) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM podcast_episodes e JOIN notes')) return { rows: [{
        note_id: noteId, content: JSON.stringify({ title: 'Episode', contentType: 'podcast-episode' }), project_id: null,
        episode_number: 1, recording_date: null, prep_session_id: jobId, script_intro: intro, script_cards: savedCards,
        script_note_id: null, transcript: null, transcript_filename: null, transcript_uploaded_at: null,
        show_notes_session_id: null, show_notes_note_id: null, revision,
      }], rowCount: 1 };
      if (sql.includes('FROM ai_chat_messages')) return { rows: [{
        id: '1', role: 'user', content: 'Discuss Azure deployment.', created_at: '2026-10-30T00:00:00Z',
        persona: null, sources: null, context_used: null, next_steps: null,
      }], rowCount: 1 };
      if (sql.startsWith('UPDATE podcast_episodes')) {
        assert.match(sql, /revision=\$2/);
        assert.match(sql, /agent_jobs WHERE id=\$5 AND status='running' AND attempts=\$6/);
        assert.match(sql, /lease_until>clock_timestamp\(\)/);
        assert.deepEqual(values.slice(4), [jobId, 1]);
        if (mode === 'stale-attempt') return { rows: [], rowCount: 0 };
        saves++;
        intro = String(values[2]);
        revision++;
        return { rows: [], rowCount: 1 };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    });
    const model = t.mock.method(getFoundryClient('podcast-script'), 'chatBulk', async (
      _messages: unknown, _tokens: unknown, _timeout: unknown, _effort: unknown, _schema: unknown, signal: AbortSignal,
    ) => {
      assert.equal(signal, controller.signal);
      if (mode === 'changed-during-run') revision++;
      if (mode === 'abort') controller.abort();
      return JSON.stringify(candidate);
    });
    const run = () => specialist.run({ db, jobId, attempt: 1, subjectId: noteId, input: { revision: 1 },
      signal: controller.signal, progress: message => { progress.push(message); } });
    if (mode === 'save') {
      const result = await run();
      assert.equal(result.data['noteId'], noteId);
      assert.equal(result.data['url'], `/think?episode=${noteId}&tab=script`);
      assert.equal(intro, candidate.intro);
      assert.equal(saves, 1);
      assert.ok(progress.includes('Script saved to the episode'));
    } else {
      await assert.rejects(run, mode === 'abort' ? { name: 'AbortError' } : /changed elsewhere/);
      assert.equal(saves, 0);
      assert.equal(intro, 'Original intro');
    }
    assert.equal(model.mock.callCount(), mode === 'changed-before-run' ? 0 : 1);
  });
}
