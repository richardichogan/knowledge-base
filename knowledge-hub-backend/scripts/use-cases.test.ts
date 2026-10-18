import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { useCasesRouter } from '../src/routes/useCases.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { countStalled, defaultLinkTitle, parseCreate, slugify } from '../src/useCases/useCaseStore.js';
import { copilotPrompt, defaultHandoffPath, handoffUseCase, type HandoffDeps } from '../src/useCases/handoff.js';
import { buildSpecPrompt, cleanDraft, draftUseCaseSpec, PER_SOURCE_CHARS, TOTAL_SOURCE_CHARS, type DraftDeps } from '../src/useCases/specDraft.js';

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
    CREATE TABLE canvases (id UUID PRIMARY KEY, title TEXT, canvas_type TEXT, deleted_at TIMESTAMPTZ);
    INSERT INTO projects VALUES ('p1', 'Imagine');
    INSERT INTO notes (id, content, project_id) VALUES ('${NOTE}', '# Claims triage idea\nbody', 'p1');
    INSERT INTO notes (id, content, status) VALUES ('${NOTE_ARCHIVED}', 'old', 'archived');
    INSERT INTO content_items VALUES ('${ITEM}', 'Agents in insurance', 'sum', 'https://example.com/a');
    INSERT INTO sparks VALUES ('${SPARK}', 'What if claims were triaged by an agent?\nmore');
    CREATE TABLE canvas_diagrams (canvas_id UUID PRIMARY KEY, document JSONB);
    CREATE TABLE canvas_nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), canvas_id UUID, label TEXT, body TEXT, x NUMERIC DEFAULT 0, y NUMERIC DEFAULT 0);
    ALTER TABLE projects ADD COLUMN description TEXT DEFAULT '', ADD COLUMN goal TEXT DEFAULT '';
    UPDATE projects SET description = 'Demo platform for insurers', goal = 'Win the pilot';
    INSERT INTO canvases VALUES ('${CANVAS}', 'Claims flow', 'diagram');
    INSERT INTO canvas_diagrams VALUES ('${CANVAS}', '{"version":1,"nodes":[{"id":"n1","kind":"process","label":"Intake step","x":0,"y":0,"width":100,"height":40,"parentId":null,"fill":"#fff","stroke":"#000"}],"edges":[],"grid":false,"viewport":{"x":0,"y":0,"zoom":1}}');
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

const SRC = (sourceType: any, title: string, text: string) => ({ sourceType, title, url: null, text });

test('buildSpecPrompt includes every source type, clips each source and the total, and picks the right template', () => {
  const product = { projectName: 'Imagine', projectDescription: 'Demo platform', projectGoal: '', repo: 'acme/imagine' };
  const long = 'x'.repeat(PER_SOURCE_CHARS + 500);
  const p = buildSpecPrompt({ title: 'Claims', summary: 'Agentic triage', productKind: 'product' }, product, [
    SRC('discover', 'Article', 'summary text'), SRC('spark', 'Idea', long), SRC('note', 'Note', 'note body'), SRC('canvas', 'Flow', 'Diagram: …'),
  ]);
  for (const label of ['Discover item: Article', 'Spark: Idea', 'Think note: Note', 'Canvas: Flow']) assert.ok(p.user.includes(label), label);
  assert.ok(p.user.includes('[… truncated …]'));
  assert.ok(p.user.includes('Repository: acme/imagine') && p.user.includes('Project description: Demo platform'));
  assert.ok(p.system.includes('## Why it fits') && !p.system.includes('IMAGINE demo brief'));
  assert.ok(p.system.includes('_Not discussed yet._'));

  const many = Array.from({ length: 20 }, (_, i) => SRC('spark', `S${i.toString()}`, 'y'.repeat(PER_SOURCE_CHARS)));
  const big = buildSpecPrompt({ title: 'Claims', summary: '', productKind: 'imagine_demo' }, product, many);
  assert.ok(big.user.length < TOTAL_SOURCE_CHARS + 2_000, 'total source text stays within budget');
  assert.match(big.user, /more sources omitted for length/);
  assert.ok(big.system.includes('## 1. Business problem and demonstrable outcome'), 'Imagine uses the demo brief template');
  assert.ok(big.system.includes('a new demo'));
  const platform = buildSpecPrompt({ title: 'C', summary: '', productKind: 'imagine_platform' }, product, []);
  assert.ok(platform.system.includes('a platform update'));
  assert.ok(platform.user.includes('(none yet'));
  assert.equal(cleanDraft('```markdown\n# Title: spec\n\n## Summary\nText\n```'), '## Summary\nText');
});

test('draft spec creates a note, moves the stage to refining, refuses a second draft and replaces on request', async () => {
  const db = await fixtureDb();
  const prompts: string[] = [];
  const replaced: Array<{ noteId: string; revision: number; title: string }> = [];
  const deps: DraftDeps = {
    generate: async (_system, user) => { prompts.push(user); return '# X: spec\n\n## Summary\nDrafted.'; },
    createNote: async (pg, content, projectId) => {
      const { rows } = await pg.query('INSERT INTO notes (id, content, project_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id::text AS id', [content, projectId]);
      return String((rows[0] as any).id);
    },
    replaceNote: async (_pg, noteId, writing, revision) => { replaced.push({ noteId, revision, title: writing.title }); },
  };
  await withApp(db, async (call) => {
    const uc = (await call('POST', '', {
      title: 'Claims triage', productKind: 'imagine_demo', projectId: 'p1',
      sources: [{ sourceType: 'canvas', sourceId: CANVAS }, { sourceType: 'note', sourceId: NOTE }],
    })).json.data;
    const first = await draftUseCaseSpec(getDb(), uc.id, { replace: false }, deps);
    assert.equal(first.useCase.stage, 'refining');
    assert.equal(first.useCase.specNoteId, first.noteId);
    assert.ok(prompts[0]!.includes('Intake step'), 'diagram labels reach the prompt');
    assert.ok(prompts[0]!.includes('Claims triage idea'), 'note title reaches the prompt');
    const note = (await db.query('SELECT content, project_id FROM notes WHERE id::text = $1', [first.noteId])).rows[0] as any;
    assert.equal(note.project_id, 'p1');
    assert.equal(JSON.parse(note.content).title, 'Claims triage: spec');

    const again = await call('POST', `/${uc.id as string}/draft-spec`, {});
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'SPEC_EXISTS');

    const second = await draftUseCaseSpec(getDb(), uc.id, { replace: true }, deps);
    assert.equal(second.replaced, true);
    assert.deepEqual(replaced, [{ noteId: first.noteId, revision: 1, title: 'Claims triage: spec' }]);
  });
});

test('handoff defaults, copilot prompt, stage changes and the no-spec 400', async () => {
  assert.equal(defaultHandoffPath('Claims Triage!', 'product'), 'docs/specs/claims-triage.md');
  assert.equal(defaultHandoffPath('Claims Triage', 'imagine_demo'), 'docs/prds/claims-triage.md');
  const product = copilotPrompt({ title: 'Inbox zero', productKind: 'product' }, 'me/app', 'docs/specs/inbox-zero.md');
  assert.ok(product.includes('`docs/specs/inbox-zero.md` in me/app'));
  assert.ok(!product.includes('evidence-led-demo'));
  const demo = copilotPrompt({ title: 'Claims', productKind: 'imagine_demo' }, 'ibm/imagine', 'docs/prds/claims.md');
  assert.ok(demo.includes('new IMAGINE demo') && demo.includes('evidence-led-demo'));
  assert.ok(copilotPrompt({ title: 'X', productKind: 'imagine_platform' }, 'a/b', 'p.md').includes('IMAGINE demo platform'));

  const db = await fixtureDb();
  const published: unknown[] = [];
  const deps: HandoffDeps = {
    publish: async (_db, noteId, repo, path, message, revision) => { published.push({ noteId, repo, path, message, revision }); return { url: `https://github.com/${repo}/blob/main/${path}` }; },
    createBuildSpec: async (_db, _noteId, opts) => ({ id: opts.repo === 'me/other' ? MISSING : NOTE }),
  };
  await withApp(db, async (call) => {
    const uc = (await call('POST', '', { title: 'Claims triage', productKind: 'imagine_demo', repo: 'ibm/imagine' })).json.data;
    const noSpec = await call('POST', `/${uc.id as string}/handoff`, {});
    assert.equal(noSpec.status, 400);
    assert.equal(noSpec.json.error.code, 'NO_SPEC_NOTE');

    await db.query('UPDATE use_cases SET spec_note_id = $1 WHERE id::text = $2', [NOTE, uc.id]);
    await assert.rejects(handoffUseCase(getDb(), uc.id, { mode: 'email' }, deps), /mode must be/);
    await assert.rejects(handoffUseCase(getDb(), uc.id, { repo: 'not a repo' }, deps), /owner\/name/);

    const gh = await handoffUseCase(getDb(), uc.id, {}, deps);
    assert.deepEqual(published, [{ noteId: NOTE, repo: 'ibm/imagine', path: 'docs/prds/claims-triage.md', message: 'Add spec: Claims triage', revision: 1 }]);
    assert.equal(gh.useCase.stage, 'handed_off');
    assert.equal(gh.useCase.handoffPath, 'docs/prds/claims-triage.md');
    assert.equal(gh.url, 'https://github.com/ibm/imagine/blob/main/docs/prds/claims-triage.md');
    assert.ok(gh.prompt?.includes('evidence-led-demo'));

    const build = await handoffUseCase(getDb(), uc.id, { mode: 'build', repo: 'me/other' }, deps);
    assert.equal(build.buildSpecId, MISSING);
    assert.equal(build.useCase.buildSpecId, MISSING);
    assert.equal(build.prompt, null);
  });
});
