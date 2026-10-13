import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { reviewPacketsRouter } from '../src/routes/reviewPackets.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';
const NOTE_1 = '00000000-0000-4000-8000-0000000000a1';
const NOTE_2 = '00000000-0000-4000-8000-0000000000a2';
const NOTE_OTHER = '00000000-0000-4000-8000-0000000000b1';
const OUTPUT = '00000000-0000-4000-8000-0000000000e1';
const DECISION = '00000000-0000-4000-8000-0000000000d1';
const DECISION_OTHER = '00000000-0000-4000-8000-0000000000d2';
const LONG_BODY = `# Long spec\n\n${'Every sentence must survive export untouched. '.repeat(400)}`;

async function fixtureDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE notes (id UUID PRIMARY KEY, content TEXT, status TEXT DEFAULT 'active', project_id TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE ai_chat_sessions (id UUID PRIMARY KEY, project_id TEXT);
    CREATE TABLE chat_decisions (id UUID PRIMARY KEY, session_id UUID REFERENCES ai_chat_sessions(id), status TEXT, text TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE chat_outputs (id UUID PRIMARY KEY, session_id UUID REFERENCES ai_chat_sessions(id), title TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE chat_output_versions (output_id UUID, version INT, content TEXT);
    INSERT INTO projects VALUES ('p1', 'One'), ('p2', 'Two');
    INSERT INTO ai_chat_sessions VALUES ('${SESSION_A}', 'p1'), ('${SESSION_B}', 'p2');
    INSERT INTO notes (id, content, project_id) VALUES ('${NOTE_1}', '# First note\nbody one', 'p1'), ('${NOTE_2}', 'second note', 'p1'), ('${NOTE_OTHER}', 'other project note', 'p2');
    INSERT INTO chat_decisions VALUES ('${DECISION}', '${SESSION_A}', 'decided', 'Use vendor X'), ('${DECISION_OTHER}', '${SESSION_B}', 'open', 'Elsewhere');
    INSERT INTO chat_outputs (id, session_id, title) VALUES ('${OUTPUT}', '${SESSION_A}', 'Spec');
    INSERT INTO chat_output_versions VALUES ('${OUTPUT}', 1, 'old spec'), ('${OUTPUT}', 2, $body$${LONG_BODY}$body$);
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/069_review_packets.sql', import.meta.url), 'utf8'));
  return db;
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

const EXTERNAL_CALLS: string[] = [];

async function withApp<T>(db: PGlite, run: (call: Call) => Promise<T>): Promise<T> {
  const stub = mock.method(getDb(), 'query', ((sql: string, params?: unknown[]) => db.query(sql, params as never[])) as never);
  const realFetch = globalThis.fetch;
  const app = express();
  app.use(express.json());
  app.use('/api/projects', reviewPacketsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (!url.startsWith('http://127.0.0.1:')) EXTERNAL_CALLS.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    return await run(async (method, path, body) => {
      const r = await realFetch(`http://127.0.0.1:${port}/api/projects${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, json: text === '' ? null : JSON.parse(text) };
    });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    stub.mock.restore();
  }
}

const SELECTION = [
  { sourceType: 'output', sourceId: OUTPUT },
  { sourceType: 'note', sourceId: NOTE_1 },
  { sourceType: 'decision', sourceId: DECISION },
];

test('candidates are limited to the project', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const { status, json } = await call('GET', '/p1/packet-candidates');
    assert.equal(status, 200);
    const ids = json.data.items.map((i: { sourceId: string }) => i.sourceId).sort();
    assert.deepEqual(ids, [NOTE_1, NOTE_2, OUTPUT, DECISION].sort());
  });
});

test('packet keeps selection order, exact content and version identity; export is deterministic and untruncated', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const created = await call('POST', '/p1/packets', { title: 'Weekly review', items: SELECTION });
    assert.equal(created.status, 201);
    const packet = created.json.data;
    assert.deepEqual(packet.items.map((i: { sourceId: string }) => i.sourceId), [OUTPUT, NOTE_1, DECISION]);
    assert.equal(packet.items[0].capturedIdentity, 'v2');
    assert.equal(packet.items[0].capturedContent, LONG_BODY);
    assert.equal(packet.items[0].href, `/chat?session=${SESSION_A}`);
    assert.equal(packet.staleCount, 0);

    const first = (await call('GET', `/p1/packets/${packet.id}/export`)).json.data;
    const second = (await call('GET', `/p1/packets/${packet.id}/export`)).json.data;
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.filename, 'weekly-review.md');
    assert.ok(first.markdown.includes(LONG_BODY), 'full content is present');
    assert.ok(first.markdown.indexOf('Spec') < first.markdown.indexOf('First note'), 'selection order preserved');
    assert.ok(first.markdown.includes('Captured version: v2'));
  });
});

test('a source changed or removed after capture is flagged, and the packet keeps its captured copy', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const packet = (await call('POST', '/p1/packets', { title: 'P', items: SELECTION })).json.data;
    await db.query(`UPDATE notes SET content = 'edited' WHERE id = '${NOTE_1}'`);
    await db.query(`DELETE FROM chat_decisions WHERE id = '${DECISION}'`);
    const after = (await call('GET', `/p1/packets/${packet.id}`)).json.data;
    assert.deepEqual(after.items.map((i: { state: string }) => i.state), ['current', 'changed', 'missing']);
    assert.equal(after.staleCount, 2);
    assert.equal(after.items[1].capturedContent, '# First note\nbody one');
  });
});

test('invalid selections are rejected without creating a packet', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const bad: unknown[] = [
      { title: 'x', items: [] },
      { title: '', items: SELECTION },
      { title: 'x', items: [{ sourceType: 'note', sourceId: NOTE_OTHER }] },
      { title: 'x', items: [{ sourceType: 'decision', sourceId: DECISION_OTHER }] },
      { title: 'x', items: [{ sourceType: 'note', sourceId: NOTE_1 }, { sourceType: 'note', sourceId: NOTE_1 }] },
      { title: 'x', items: [{ sourceType: 'file', sourceId: 'a' }] },
    ];
    for (const body of bad) assert.equal((await call('POST', '/p1/packets', body)).status, 422, JSON.stringify(body));
    assert.equal((await call('GET', '/p1/packets')).json.data.length, 0);
    assert.equal((await call('GET', '/p2/packets/missing')).status, 404);
  });
});

test('checklist state persists and approval is recorded without side effects', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const packet = (await call('POST', '/p1/packets', { title: 'P', items: SELECTION })).json.data;
    assert.equal((await call('PATCH', `/p1/packets/${packet.id}/items/1`, { checked: 'yes' })).status, 422);
    const checked = (await call('PATCH', `/p1/packets/${packet.id}/items/1`, { checked: true })).json.data;
    assert.deepEqual(checked.items.map((i: { checked: boolean }) => i.checked), [false, true, false]);

    const before = JSON.stringify((await db.query('SELECT * FROM notes ORDER BY id')).rows);
    const approved = (await call('POST', `/p1/packets/${packet.id}/approve`, {})).json.data;
    assert.equal(approved.status, 'approved');
    assert.ok(approved.approvedAt);
    assert.equal(JSON.stringify((await db.query('SELECT * FROM notes ORDER BY id')).rows), before, 'sources untouched');
    assert.equal((await call('PATCH', `/p1/packets/${packet.id}/items/0`, { checked: true })).status, 409);
  });
});

test('approving a packet with stale sources needs explicit acknowledgement', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const packet = (await call('POST', '/p1/packets', { title: 'P', items: SELECTION })).json.data;
    await db.query(`UPDATE notes SET content = 'edited' WHERE id = '${NOTE_1}'`);
    assert.equal((await call('POST', `/p1/packets/${packet.id}/approve`, {})).status, 422);
    assert.equal((await call('GET', `/p1/packets/${packet.id}`)).json.data.status, 'draft');
    assert.equal((await call('POST', `/p1/packets/${packet.id}/approve`, { acknowledgeStale: true })).json.data.status, 'approved');
  });
});

// Curated offline evaluation set: grounding/provenance, project scope, missing/stale evidence and action
// confirmation. It uses a local database only; any non-loopback fetch fails the run.
const EVALUATION_CASES: Array<{ name: string; run: (call: Call) => Promise<void> }> = [
  {
    name: 'grounding: every exported item names its source link and captured version',
    run: async (call) => {
      const packet = (await call('POST', '/p1/packets', { title: 'Eval', items: SELECTION })).json.data;
      const { markdown } = (await call('GET', `/p1/packets/${packet.id}/export`)).json.data;
      for (const item of packet.items) {
        assert.ok(markdown.includes(`Source: ${item.href}`));
        assert.ok(markdown.includes(`Captured version: ${item.capturedIdentity}`));
      }
    },
  },
  {
    name: 'project scope: another project\'s evidence can never be packaged or read',
    run: async (call) => {
      assert.equal((await call('POST', '/p1/packets', { title: 'x', items: [{ sourceType: 'note', sourceId: NOTE_OTHER }] })).status, 422);
      const own = (await call('POST', '/p1/packets', { title: 'Mine', items: SELECTION })).json.data;
      assert.equal((await call('GET', `/p2/packets/${own.id}`)).status, 404);
    },
  },
  {
    name: 'missing evidence is reported as unavailable, never silently dropped',
    run: async (call) => {
      const packet = (await call('POST', '/p1/packets', { title: 'x', items: SELECTION })).json.data;
      await getDb().query(`DELETE FROM chat_decisions WHERE id = '${DECISION}'`);
      const after = (await call('GET', `/p1/packets/${packet.id}`)).json.data;
      assert.equal(after.items.length, SELECTION.length);
      assert.equal(after.items[2].state, 'missing');
      assert.ok((await call('GET', `/p1/packets/${packet.id}/export`)).json.data.markdown.includes('no longer available'));
    },
  },
  {
    name: 'stale evidence is reported as changed',
    run: async (call) => {
      const packet = (await call('POST', '/p1/packets', { title: 'x', items: SELECTION })).json.data;
      await getDb().query(`UPDATE notes SET content = 'changed' WHERE id = '${NOTE_1}'`);
      assert.equal((await call('GET', `/p1/packets/${packet.id}`)).json.data.items[1].state, 'changed');
    },
  },
  {
    name: 'action confirmation: approval writes only to the packet record',
    run: async (call) => {
      const packet = (await call('POST', '/p1/packets', { title: 'x', items: SELECTION })).json.data;
      const tables = ['notes', 'chat_decisions', 'chat_outputs', 'chat_output_versions'];
      const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all(tables.map((t) => getDb().query(`SELECT * FROM ${t}`).then((r) => r.rows))));
      const before = await snapshot();
      await call('POST', `/p1/packets/${packet.id}/approve`, {});
      assert.equal(await snapshot(), before);
    },
  },
];

for (const evaluation of EVALUATION_CASES) {
  test(`offline evaluation - ${evaluation.name}`, async () => {
    const db = await fixtureDb();
    await withApp(db, async (call) => { await evaluation.run(call); });
    assert.deepEqual(EXTERNAL_CALLS, [], 'offline evaluation made an external call');
  });
}
