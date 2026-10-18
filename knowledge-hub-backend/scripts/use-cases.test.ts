import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { useCasesRouter } from '../src/routes/useCases.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { countStalled, defaultLinkTitle, parseCreate, slugify } from '../src/useCases/useCaseStore.js';

const NOTE = '00000000-0000-4000-8000-0000000000a1';
const NOTE_ARCHIVED = '00000000-0000-4000-8000-0000000000a2';
const ITEM = '00000000-0000-4000-8000-0000000000c1';
const SPARK = '00000000-0000-4000-8000-0000000000d1';
const CANVAS = '00000000-0000-4000-8000-0000000000e1';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

async function fixtureDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE notes (id UUID PRIMARY KEY, content TEXT, status TEXT DEFAULT 'active', project_id TEXT, revision INT DEFAULT 1, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE content_items (id UUID PRIMARY KEY, title TEXT, summary TEXT, url TEXT);
    CREATE TABLE sparks (id UUID PRIMARY KEY, body TEXT);
    CREATE TABLE canvases (id UUID PRIMARY KEY, name TEXT, canvas_type TEXT);
    INSERT INTO projects VALUES ('p1', 'Imagine');
    INSERT INTO notes (id, content, project_id) VALUES ('${NOTE}', '# Claims triage idea\nbody', 'p1');
    INSERT INTO notes (id, content, status) VALUES ('${NOTE_ARCHIVED}', 'old', 'archived');
    INSERT INTO content_items VALUES ('${ITEM}', 'Agents in insurance', 'sum', 'https://example.com/a');
    INSERT INTO sparks VALUES ('${SPARK}', 'What if claims were triaged by an agent?\nmore');
    INSERT INTO canvases VALUES ('${CANVAS}', 'Claims flow', 'diagram');
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/081_use_cases.sql', import.meta.url), 'utf8'));
  return db;
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

async function withApp<T>(db: PGlite, run: (call: Call) => Promise<T>): Promise<T> {
  const stub = mock.method(getDb(), 'query', ((sql: string, params?: unknown[]) => db.query(sql, params as never[])) as never);
  const app = express();
  app.use(express.json());
  app.use('/api/use-cases', useCasesRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    return await run(async (method, path, body) => {
      const r = await fetch(`http://127.0.0.1:${port.toString()}/api/use-cases${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, json: text === '' ? null : JSON.parse(text) };
    });
  } finally {
    server.close();
    stub.mock.restore();
  }
}

test('pure helpers', () => {
  assert.equal(slugify('Claims Triage: Agent-led!'), 'claims-triage-agent-led');
  assert.equal(slugify('!!!'), 'use-case');
  assert.equal(defaultLinkTitle('https://github.com/acme/imagine/pull/42'), 'acme/imagine#42');
  assert.equal(defaultLinkTitle('https://example.com/demo/'), 'example.com/demo');
  assert.throws(() => parseCreate({ title: 'x', productKind: 'product' }), /project or a repo/);
  assert.throws(() => parseCreate({ title: 'x', productKind: 'nope' }), /productKind/);
  assert.throws(() => parseCreate({ title: ' ', productKind: 'imagine_demo' }), /title is required/);
  assert.throws(() => parseCreate({ title: 'x', productKind: 'product', repo: 'not a repo' }), /owner\/name/);
  assert.deepEqual(parseCreate({ title: ' t ', productKind: 'product', repo: 'a/b' }).repo, 'a/b');
});

test('create with sources resolves titles from every source type', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const r = await call('POST', '', {
      title: 'Claims triage demo', productKind: 'imagine_demo', projectId: 'p1',
      sources: [
        { sourceType: 'discover', sourceId: ITEM }, { sourceType: 'spark', sourceId: SPARK },
        { sourceType: 'note', sourceId: NOTE }, { sourceType: 'canvas', sourceId: CANVAS },
      ],
    });
    assert.equal(r.status, 201);
    const uc = r.json.data;
    assert.equal(uc.stage, 'candidate');
    assert.equal(uc.projectName, 'Imagine');
    assert.equal(uc.sourceCount, 4);
    const titles = Object.fromEntries(uc.sources.map((s: any) => [s.sourceType, s.title]));
    assert.deepEqual(titles, {
      discover: 'Agents in insurance', spark: 'What if claims were triaged by an agent?', note: 'Claims triage idea', canvas: 'Claims flow',
    });
    assert.equal(uc.sources.find((s: any) => s.sourceType === 'discover').url, 'https://example.com/a');
  });
});

test('a missing or archived source rejects the create and writes nothing', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const missing = await call('POST', '', { title: 't', productKind: 'imagine_demo', sources: [{ sourceType: 'spark', sourceId: MISSING }] });
    assert.equal(missing.status, 404);
    const archived = await call('POST', '', { title: 't', productKind: 'imagine_demo', sources: [{ sourceType: 'note', sourceId: NOTE_ARCHIVED }] });
    assert.equal(archived.status, 404);
    const unknownProject = await call('POST', '', { title: 't', productKind: 'product', projectId: 'nope' });
    assert.equal(unknownProject.status, 422);
    const list = await call('GET', '');
    assert.equal(list.json.data.length, 0);
  });
});

test('validation errors are 422', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    assert.equal((await call('POST', '', { title: 't', productKind: 'product' })).status, 422);
    assert.equal((await call('GET', '?stage=bogus')).status, 422);
  });
});

test('list filters, patch stage, sources, links and delete', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const a = (await call('POST', '', { title: 'Demo A', productKind: 'imagine_demo' })).json.data;
    await call('POST', '', { title: 'Product B', productKind: 'product', repo: 'acme/tool' });

    assert.equal((await call('GET', '')).json.data.length, 2);
    const demos = (await call('GET', '?productKind=imagine_demo')).json.data;
    assert.deepEqual(demos.map((u: any) => u.title), ['Demo A']);

    const before = a.stageChangedAt;
    await new Promise((r) => setTimeout(r, 15));
    const titled = (await call('PATCH', `/${a.id}`, { title: 'Demo A2' })).json.data;
    assert.equal(titled.stageChangedAt, before, 'stage_changed_at only moves when the stage changes');
    const refined = (await call('PATCH', `/${a.id}`, { stage: 'refining' })).json.data;
    assert.equal(refined.stage, 'refining');
    assert.notEqual(refined.stageChangedAt, before);
    assert.equal((await call('GET', '?stage=refining')).json.data.length, 1);
    assert.equal((await call('PATCH', `/${a.id}`, { stage: 'nope' })).status, 422);
    assert.equal((await call('PATCH', `/${a.id}`, {})).status, 422);
    assert.equal((await call('PATCH', `/${a.id}`, { productKind: 'product' })).status, 422, 'product needs project or repo');

    const withSource = (await call('POST', `/${a.id}/sources`, { sources: [{ sourceType: 'spark', sourceId: SPARK }] })).json.data;
    assert.equal(withSource.sources.length, 1);
    const again = (await call('POST', `/${a.id}/sources`, { sources: [{ sourceType: 'spark', sourceId: SPARK }] })).json.data;
    assert.equal(again.sources.length, 1, 'adding the same source twice is idempotent');
    const noSource = (await call('DELETE', `/${a.id}/sources/spark/${SPARK}`)).json.data;
    assert.equal(noSource.sources.length, 0);

    const linked = (await call('POST', `/${a.id}/links`, { url: 'https://github.com/acme/imagine/pull/7' })).json.data;
    assert.equal(linked.links[0].title, 'acme/imagine#7');
    assert.equal((await call('POST', `/${a.id}/links`, { url: 'http://insecure.example' })).status, 422);
    const unlinked = (await call('DELETE', `/${a.id}/links/${linked.links[0].id}`)).json.data;
    assert.equal(unlinked.links.length, 0);

    assert.equal((await call('DELETE', `/${a.id}`)).status, 204);
    assert.equal((await call('GET', `/${a.id}`)).status, 404);
    assert.equal((await call('DELETE', `/${a.id}`)).status, 404);
    assert.equal((await call('GET', `/${MISSING}`)).status, 404);
  });
});

test('countStalled counts refining and spec-ready use cases with no update for N days', async () => {
  const db = await fixtureDb();
  await db.exec(`
    INSERT INTO use_cases (title, product_kind, stage, updated_at) VALUES
      ('old refining', 'imagine_demo', 'refining', NOW() - INTERVAL '20 days'),
      ('old ready', 'imagine_demo', 'spec_ready', NOW() - INTERVAL '15 days'),
      ('old candidate', 'imagine_demo', 'candidate', NOW() - INTERVAL '30 days'),
      ('fresh refining', 'imagine_demo', 'refining', NOW());
  `);
  const stub = mock.method(getDb(), 'query', ((sql: string, params?: unknown[]) => db.query(sql, params as never[])) as never);
  try {
    assert.equal(await countStalled(getDb(), 14), 2);
    assert.equal(await countStalled(getDb(), 18), 1);
  } finally {
    stub.mock.restore();
  }
});
