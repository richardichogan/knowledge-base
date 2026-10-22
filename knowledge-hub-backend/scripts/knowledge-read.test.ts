import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { handleConversationTurn } from '../src/ai/conversationService.js';
import { FoundryClient, type LlmToolDefinition } from '../src/ai/foundryClient.js';
import { emptyContextUsed } from '../src/ai/contextUsage.js';
import { readKnowledgeRecord, type ReadArgs, type ReadContext } from '../src/services/knowledge/reader.js';
import { KNOWLEDGE_FAMILIES } from '../src/ai/knowledge/manifest.js';
import { getToolDefinitions } from '../src/ai/chatTools.js';
import { KnowledgeValidationError, type KnowledgeAccess, type KnowledgeRecord } from '../src/types/knowledge.js';
import {
  ITEM_DOC, MIRROR_A, NODE_A, NODE_DOC, NOTE_A, NOTE_B, OTHER_SESSION, SESSION, addNote, asPool, knowledgeFixture, noteContent,
} from './knowledge-fixtures.js';

const ctx = (over: Partial<ReadContext> = {}): ReadContext => ({ sessionId: SESSION, loadExcluded: async () => new Set(), ...over });

function record(access: KnowledgeAccess): KnowledgeRecord {
  assert.ok(access.status === 'ok' || access.status === 'partial', `expected readable, got ${access.status}`);
  return access.record;
}

async function pageAll(db: ReturnType<typeof asPool>, args: ReadArgs, context: ReadContext, maxChars: number): Promise<string> {
  let text = '';
  let cursor: string | undefined;
  for (let i = 0; i < 200; i += 1) {
    const rec = record(await readKnowledgeRecord(db, { ...args, maxChars, ...(cursor ? { cursor } : {}) }, context));
    text += rec.content;
    if (rec.nextCursor === null) return text;
    cursor = rec.nextCursor;
  }
  throw new Error('paging did not terminate');
}

const insertItem = (db: Awaited<ReturnType<typeof knowledgeFixture>>, id: string, body: string, metadata: object = {}, extra: { source?: string; project?: string; url?: string } = {}) =>
  db.query(`INSERT INTO content_items (id, source, title, body, metadata, project_context, url) VALUES ($1,$2,'Spec doc',$3,$4,$5,$6)`,
    [id, extra.source ?? 'document', body, JSON.stringify(metadata), extra.project ?? 'personal', extra.url ?? null]);

test('COV-02 supported kinds read with origin, version and internal locator', async () => {
  const db = await knowledgeFixture();
  await db.query(`INSERT INTO projects (id, name, goal) VALUES ('p1','Alpha','Ship it')`);
  await db.query(`INSERT INTO tasks (id, title, body, project_id) VALUES ('t1','Do it','task body','p1')`);
  await addNote(db, NOTE_A, 'Note A', ['hello world']);
  await insertItem(db, ITEM_DOC, 'document body');
  await db.query(`INSERT INTO nodes (id, ref_id, ref_type) VALUES ($1,$2,'note')`, [NODE_A, NOTE_A]);
  const pool = asPool(db);
  for (const [kind, id, path] of [['note', NOTE_A, '/think?noteId='], ['content-item', ITEM_DOC, '/library?contentItemId='],
    ['graph-node', NODE_A, '/think?noteId='], ['project', 'p1', '/projects?projectId='], ['task', 't1', '/plan?taskId=']] as const) {
    const rec = record(await readKnowledgeRecord(pool, { kind, id }, ctx()));
    assert.ok(rec.locator.internalPath.startsWith(path), kind);
    assert.ok(rec.version.length > 8);
    assert.ok(rec.origin);
    assert.ok(rec.content.length > 0, kind);
  }
});

test('COV-03 metadata-only and extraction-failed records are not reported as fully readable', async () => {
  const db = await knowledgeFixture();
  await insertItem(db, ITEM_DOC, '', {});
  await insertItem(db, MIRROR_A, 'x', { extractionState: 'failed' });
  const pool = asPool(db);
  const metaOnly = await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC }, ctx());
  assert.equal(metaOnly.status, 'partial');
  assert.equal(record(metaOnly).extractionState, 'metadata-only');
  assert.ok(metaOnly.status === 'partial' && metaOnly.issues.some(i => i.code === 'metadata_only'));
  const failed = await readKnowledgeRecord(pool, { kind: 'content-item', id: MIRROR_A }, ctx());
  assert.equal(failed.status, 'partial');
  assert.ok(failed.status === 'partial' && failed.issues.some(i => i.code === 'extraction_failed' && i.retryable));
});

test('COV-04 unsupported manifest families are explicit; unknown kinds are validation errors', async () => {
  const pool = asPool(await knowledgeFixture());
  const unsupported = KNOWLEDGE_FAMILIES.map(f => f.kind).find(k => !['note', 'content-item', 'graph-node', 'project', 'task', 'output'].includes(k));
  assert.ok(unsupported);
  const result = await readKnowledgeRecord(pool, { kind: unsupported, id: 'x1' }, ctx());
  assert.equal(result.status, 'unavailable');
  assert.ok(result.status === 'unavailable' && result.code === 'unsupported_family' && !result.retryable);
  await assert.rejects(readKnowledgeRecord(pool, { kind: 'totally-made-up', id: 'x1' }, ctx()), KnowledgeValidationError);
});

test('READ-01/02 long document pages concatenate exactly and the tail is reachable', async () => {
  const db = await knowledgeFixture();
  const body = `${'Intro paragraph about nothing.\n'.repeat(950)}The approval threshold is GBP 50,000.\n${'Trailer.\n'.repeat(50)}`;
  assert.ok(body.indexOf('GBP 50,000') > 28_000);
  await insertItem(db, ITEM_DOC, body);
  const pool = asPool(db);
  const first = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC }, ctx()));
  assert.ok(first.content.length <= 6_000 && first.nextCursor !== null);
  assert.equal(first.totalChars, body.length);
  assert.ok(!first.content.includes('GBP 50,000'));
  assert.equal(await pageAll(pool, { kind: 'content-item', id: ITEM_DOC }, ctx(), 6_000), body);
  assert.equal(await pageAll(pool, { kind: 'content-item', id: ITEM_DOC }, ctx(), 1_234), body);
  const max = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, maxChars: 12_000 }, ctx()));
  assert.ok(max.content.length <= 12_000);
  await assert.rejects(readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, maxChars: 12_001 }, ctx()), KnowledgeValidationError);
  const tail = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, offset: body.indexOf('GBP') - 10 }, ctx()));
  assert.ok(tail.content.includes('GBP 50,000'));
});

test('READ-03 a changed record never yields a mixed-version document', async () => {
  const db = await knowledgeFixture();
  await insertItem(db, ITEM_DOC, 'alpha '.repeat(4_000));
  const pool = asPool(db);
  const page1 = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC }, ctx()));
  await db.query(`UPDATE content_items SET body = $2 WHERE id = $1`, [ITEM_DOC, 'bravo '.repeat(4_000)]);
  const next = await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, cursor: page1.nextCursor! }, ctx());
  assert.equal(next.status, 'partial');
  assert.ok(next.status === 'partial' && next.issues.some(i => i.code === 'version_changed'));
  assert.equal(record(next).content, '');
  assert.notEqual(record(next).version, page1.version);
  assert.equal(record(next).startOffset, 0);
  const restarted = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, cursor: record(next).nextCursor! }, ctx()));
  assert.ok(restarted.content.startsWith('bravo') && !restarted.content.includes('alpha'));
});

test('READ-04 invalid offsets, cursors, kinds and ids are typed validation errors before any SQL', async () => {
  let queries = 0;
  const db = { query: async () => { queries += 1; return { rows: [] }; } } as never;
  const bad: ReadArgs[] = [
    { kind: 'note', id: NOTE_A, offset: -1 }, { kind: 'note', id: NOTE_A, offset: 1e12 }, { kind: 'note', id: NOTE_A, offset: 1.5 },
    { kind: 'note', id: NOTE_A, maxChars: 0 }, { kind: 'note', id: NOTE_A, cursor: 'not-a-cursor', offset: 3 },
    { kind: '', id: NOTE_A }, { kind: 'note', id: '' }, { kind: 'note', id: "x'; DROP TABLE notes;--" },
  ];
  for (const args of bad) {
    await assert.rejects(readKnowledgeRecord(db, args, ctx()), KnowledgeValidationError, JSON.stringify(args));
  }
  assert.equal(queries, 0);
  const real = asPool(await knowledgeFixture());
  const fixture = await knowledgeFixture();
  await addNote(fixture, NOTE_A, 'N', ['text']);
  await assert.rejects(readKnowledgeRecord(asPool(fixture), { kind: 'note', id: NOTE_A, cursor: 'garbage.sig' }, ctx()), /Cursor is invalid/);
  await assert.rejects(readKnowledgeRecord(asPool(fixture), { kind: 'note', id: NOTE_A, offset: 99_999 }, ctx()), KnowledgeValidationError);
  assert.ok(real);
});

test('READ-05 a cursor cannot be reused for another record, session or scope', async () => {
  const db = await knowledgeFixture();
  await insertItem(db, ITEM_DOC, 'xray '.repeat(4_000), {}, { project: 'p1' });
  await insertItem(db, MIRROR_A, 'yank '.repeat(4_000), {}, { project: 'p1' });
  const pool = asPool(db);
  const cursor = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC }, ctx())).nextCursor!;
  await assert.rejects(readKnowledgeRecord(pool, { kind: 'content-item', id: MIRROR_A, cursor }, ctx()), /Cursor is invalid/);
  await assert.rejects(readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, cursor }, ctx({ sessionId: OTHER_SESSION })), /Cursor is invalid/);
  await assert.rejects(readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, cursor }, ctx({ strictProjectId: 'p1' })), /Cursor is invalid/);
  const tampered = `${cursor.slice(0, -2)}xx`;
  await assert.rejects(readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, cursor: tampered }, ctx()), /Cursor is invalid/);
  const ok = await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, cursor }, ctx());
  assert.ok(ok.status === 'ok' || ok.status === 'partial');
});

test('READ-06 Unicode across page boundaries round-trips without broken surrogate pairs', async () => {
  const db = await knowledgeFixture();
  const body = `${'😀'.repeat(3_001)}é世界${'🧪a'.repeat(2_000)}`;
  await insertItem(db, ITEM_DOC, body);
  const pool = asPool(db);
  for (const size of [1_001, 6_000, 7, 12_000]) {
    let cursor: string | undefined;
    let joined = '';
    for (let i = 0; i < 5_000; i += 1) {
      const rec = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, maxChars: size, ...(cursor ? { cursor } : {}) }, ctx()));
      assert.equal(rec.content, rec.content.toWellFormed(), `page ${i} at size ${size}`);
      joined += rec.content;
      if (!rec.nextCursor) break;
      cursor = rec.nextCursor;
    }
    assert.equal(joined, body, `size ${size}`);
  }
  const mid = record(await readKnowledgeRecord(pool, { kind: 'content-item', id: ITEM_DOC, offset: 1 }, ctx()));
  assert.equal(mid.startOffset, 0);
});

test('READ-07 note rendering keeps structure and labels image analysis separately from authored text', async () => {
  const db = await knowledgeFixture();
  const blobId = '40000000-0000-4000-8000-000000000001';
  await db.query(`INSERT INTO kb_images (id, vision_analysis) VALUES ($1,'a bar chart of revenue')`, [blobId]);
  const blocks = [
    { type: 'paragraph', content: [{ type: 'text', text: 'Authored intro', styles: {} }], children: [] },
    { type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'ship it', styles: {} }], children: [] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;', styles: {} }], children: [] },
    { type: 'image', props: { url: `https://example.test/blobs/${blobId}` }, children: [] },
  ];
  await db.query(`INSERT INTO notes (id, content) VALUES ($1,$2)`, [NOTE_A, JSON.stringify({ title: 'Rich', contentType: 'note', contentJson: JSON.stringify(blocks) })]);
  const rec = record(await readKnowledgeRecord(asPool(db), { kind: 'note', id: NOTE_A }, ctx()));
  assert.ok(rec.content.includes('Authored intro') && rec.content.includes('ship it') && rec.content.includes('const x = 1;'));
  assert.ok(rec.content.includes('[Image: a bar chart of revenue]'));
  assert.ok(!rec.content.includes('Authored intro [Image'));
  assert.equal(rec.title, 'Rich');
});

test('READ-08 description-only video states the transcript is unavailable', async () => {
  const db = await knowledgeFixture();
  await insertItem(db, ITEM_DOC, 'Channel description only.', { hasTranscript: false }, { source: 'youtube' });
  const access = await readKnowledgeRecord(asPool(db), { kind: 'content-item', id: ITEM_DOC }, ctx());
  assert.equal(access.status, 'partial');
  assert.ok(access.status === 'partial' && access.issues.some(i => i.code === 'no_transcript' && /transcript/i.test(i.message)));
});

test('READ-09 truncated extraction never presents stored length as the original length', async () => {
  const db = await knowledgeFixture();
  await insertItem(db, ITEM_DOC, 'zulu '.repeat(100), { truncated: true });
  const access = await readKnowledgeRecord(asPool(db), { kind: 'content-item', id: ITEM_DOC }, ctx());
  assert.equal(access.status, 'partial');
  const rec = record(access);
  assert.equal(rec.extractionState, 'partial');
  assert.equal(rec.totalChars, 500);
  assert.ok(access.status === 'partial' && access.issues.some(i => i.code === 'extraction_partial' && /not the original/.test(i.message)));
  assert.equal(access.status === 'partial' && access.coverage.complete, true);
});

test('READ-10 outputs return the latest version by default and history only when asked, within the owning session', async () => {
  const db = await knowledgeFixture();
  const out = '50000000-0000-4000-8000-000000000001';
  await db.query(`INSERT INTO chat_outputs (id, session_id, title) VALUES ($1,$2,'Brief')`, [out, SESSION]);
  await db.query(`INSERT INTO chat_output_versions (output_id, version, content, author) VALUES ($1,1,'v1 text','athena'),($1,2,'v2 user edit','user')`, [out]);
  const pool = asPool(db);
  assert.equal(record(await readKnowledgeRecord(pool, { kind: 'output', id: out }, ctx())).content, 'v2 user edit');
  assert.equal(record(await readKnowledgeRecord(pool, { kind: 'output', id: out, outputVersion: 1 }, ctx())).content, 'v1 text');
  assert.equal((await readKnowledgeRecord(pool, { kind: 'output', id: out, outputVersion: 9 }, ctx())).status, 'not_found');
});

test('CTX-05 read-only mode withholds write tools but keeps read_knowledge_record', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => ({ rows: [] }));
  let available: LlmToolDefinition[] = [];
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, _messages, tools) => {
    available = tools;
    return { content: 'ok', toolCalls: [], finishReason: 'stop' };
  });
  try {
    const names = (await getToolDefinitions()).map(t => t.function.name);
    assert.ok(names.includes('read_knowledge_record'));
    await handleConversationTurn(db, [], 'Re-answer that', 'standard', 'general', SESSION, undefined, undefined, {}, { readOnlyTools: true, contextUsed: emptyContextUsed() });
    const exposed = available.map(t => t.function.name);
    assert.ok(exposed.includes('read_knowledge_record'));
    assert.ok(exposed.includes('search_knowledge_base'));
    for (const write of ['create_task', 'update_task', 'create_note_draft', 'remember', 'propose_note_edit']) assert.ok(!exposed.includes(write), write);
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});

test('alias ids resolve to one canonical record', async () => {
  const db = await knowledgeFixture();
  await addNote(db, NOTE_B, 'Aliased', ['same text']);
  await db.query(`INSERT INTO content_items (id, source, source_id, title, body) VALUES ($1,'note',$2,'Aliased','mirror text')`, [MIRROR_A, NOTE_B]);
  await db.query(`INSERT INTO nodes (id, ref_id, ref_type) VALUES ($1,$2,'note'),($3,$4,'document')`, [NODE_A, NOTE_B, NODE_DOC, ITEM_DOC]);
  await insertItem(db, ITEM_DOC, 'doc');
  const pool = asPool(db);
  const refs = await Promise.all([['note', NOTE_B], ['content-item', MIRROR_A], ['graph-node', NODE_A]].map(async ([kind, id]) =>
    record(await readKnowledgeRecord(pool, { kind: kind!, id: id! }, ctx())).ref));
  for (const ref of refs) assert.deepEqual(ref, { kind: 'note', id: NOTE_B });
  assert.equal(record(await readKnowledgeRecord(pool, { kind: 'graph-node', id: NODE_DOC }, ctx())).ref.id, ITEM_DOC);
  void noteContent;
});
