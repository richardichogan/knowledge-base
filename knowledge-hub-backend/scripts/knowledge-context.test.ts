import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleConversationTurn } from '../src/ai/conversationService.js';
import { emptyContextUsed } from '../src/ai/contextUsage.js';
import type { ConversationMessage } from '../src/types/aiContext.js';
import { SESSION } from './knowledge-fixtures.js';
import { harnessDb, recordingPool, requestText, scriptModel, toolResults } from './knowledge-harness.js';

const NOTE_TEXT = 'N1-MARKER: our retention period for audit logs is 30 days.';
const SPEC_ID = '20000000-0000-4000-8000-0000000000d1';
const WEB_TOOL = /tavily|fetch_web_page|web/i;

interface ReadResult { status: string; record: { content: string; nextCursor: string | null } }
interface SearchResult { results: Array<{ id: string; title: string }> }

async function seed(): Promise<Awaited<ReturnType<typeof harnessDb>>> {
  const db = await harnessDb();
  const filler = (label: string, n: number): string =>
    Array.from({ length: n }, (_, i) => `${label} paragraph ${i.toString()} covers rollout logistics and staffing for the quarter.`).join('\n\n');
  const body = `${filler('Background', 120)}\n\n## Data retention\n\nThe current spec requires 90 days of retention for audit logs.\n\n${filler('Appendix', 40)}`;
  await db.query(`INSERT INTO content_items (id, source, source_id, title, body, project_context) VALUES ($1,'document','spec-1','Platform spec (current)',$2,'platform')`,
    [SPEC_ID, body]);
  await db.query(`INSERT INTO content_items (source, source_id, title, body) SELECT 'document', 'u' || g, 'Unrelated record ' || g,
    'UNRELATED-BODY-MARKER ' || g FROM generate_series(1, 1000) g`);
  await db.query(`INSERT INTO tasks (id, title, body, status) VALUES
    ('t1', 'Update audit log retention', 'T1-BODY: change log retention from 30 to 90 days.', 'backlog'),
    ('t2', 'Book offsite venue', 'T2-BODY: unrelated logistics.', 'backlog')`);
  return db;
}

const noteContext = { type: 'note', title: 'N1', detail: NOTE_TEXT };
const first = (value: unknown[]): unknown => value[0];

test('CTX-03 comparing the open note with "the current spec" retrieves D1, pages to the pertinent section and keeps N1', async () => {
  const db = await seed();
  const { pool, writes } = recordingPool(db);
  const called: string[] = [];
  const reads: ReadResult[] = [];
  const model = scriptModel((round, index) => {
    if (index === 0) return [{ name: 'search_knowledge_base', args: { query: 'current spec' } }];
    if (index === 1) {
      const search = first(toolResults(round)) as SearchResult;
      const spec = search.results.find((r) => r.id === SPEC_ID);
      assert.ok(spec, 'D1 is retrieved');
      return [{ name: 'read_knowledge_record', args: { kind: 'content-item', id: spec.id } }];
    }
    const latest = toolResults(round).at(-1) as ReadResult;
    reads.push(latest);
    if (!latest.record.content.includes('90 days') && latest.record.nextCursor !== null) {
      return [{ name: 'read_knowledge_record', args: { kind: 'content-item', id: SPEC_ID, cursor: latest.record.nextCursor } }];
    }
    return 'The note says 30 days; the spec says 90 days.';
  });
  try {
    const reply = await handleConversationTurn(pool, [], 'Compare this note with the current spec', 'standard', 'general', SESSION,
      noteContext, (name) => { called.push(name); }, {}, { contextUsed: emptyContextUsed() });
    assert.equal(reply, 'The note says 30 days; the spec says 90 days.');
    assert.deepEqual(called.slice(0, 2), ['search_knowledge_base', 'read_knowledge_record']);
    assert.ok(called.filter((n) => n === 'read_knowledge_record').length >= 2, 'the section lies beyond the first page');
    assert.ok(reads.at(-1)?.record.content.includes('90 days'), 'the pertinent section was read');
    assert.equal(reads[0]?.record.content.includes('90 days'), false);
    for (const round of model.rounds) {
      assert.ok(requestText(round).includes(NOTE_TEXT), 'N1 stays in every model request');
      assert.ok(!requestText(round).includes('UNRELATED-BODY-MARKER'), 'unrelated records never reach the model');
    }
    assert.ok(!called.some((n) => WEB_TOOL.test(n)));
    assert.deepEqual(writes, []);
  } finally { model.restore(); await db.close(); }
});

test('CTX-04 the follow-up keeps internal read tools, forces no web search and resolves T1', async () => {
  const db = await seed();
  const { pool, writes } = recordingPool(db);
  const called: string[] = [];
  const history: ConversationMessage[] = [
    { role: 'user', content: 'Compare this note with the current spec' },
    { role: 'assistant', content: 'The note says 30 days of retention; the Platform spec requires 90 days.' },
  ];
  let t1Read: ReadResult | undefined;
  const model = scriptModel((round, index) => {
    if (index === 0) return [{ name: 'list_tasks', args: { includeBody: false } }];
    if (index === 1) {
      const listed = first(toolResults(round)) as { tasks: Array<{ id: string; title: string }> };
      const t1 = listed.tasks.find((t) => /retention/i.test(t.title));
      assert.ok(t1, 'the affected task is listed');
      return [{ name: 'read_knowledge_record', args: { kind: 'task', id: t1.id } }];
    }
    t1Read = toolResults(round).at(-1) as ReadResult;
    return 'Update audit log retention is affected.';
  });
  try {
    const reply = await handleConversationTurn(pool, history, 'and what tasks does that affect?', 'standard', 'general', SESSION,
      noteContext, (name) => { called.push(name); }, {}, { contextUsed: emptyContextUsed() });
    assert.equal(reply, 'Update audit log retention is affected.');
    const available = model.rounds[0]!.tools.map((t) => t.function.name);
    for (const kept of ['list_tasks', 'read_knowledge_record', 'search_knowledge_base']) assert.ok(available.includes(kept), kept);
    assert.equal(model.rounds[0]!.toolChoice, 'auto', 'no tool, and in particular no web search, is forced');
    assert.ok(requestText(model.rounds[0]!).includes('the Platform spec requires 90 days'), 'prior turn is retained');
    assert.ok(requestText(model.rounds[0]!).includes(NOTE_TEXT));
    assert.equal(t1Read?.status, 'ok');
    assert.ok(t1Read?.record.content.includes('T1-BODY'));
    assert.ok(!called.some((n) => WEB_TOOL.test(n)), called.join());
    assert.ok(!model.rounds.some((r) => requestText(r).includes('T2-BODY')), 'unrelated tasks are not read');
    assert.deepEqual(writes, []);
  } finally { model.restore(); await db.close(); }
});
