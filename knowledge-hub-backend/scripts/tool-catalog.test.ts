import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { ToolCatalog } from '../src/ai/toolCatalog.js';
import { FoundryClient, type LlmToolDefinition } from '../src/ai/foundryClient.js';
import { declaredRetrievalScope, isOutsideCollectionTool, resolveSearchFilter } from '../src/ai/knowledge/retrievalScope.js';
import { TurnBudget } from '../src/ai/knowledge/budgets.js';
import { handleConversationTurn } from '../src/ai/conversationService.js';
import { executeToolCall } from '../src/ai/chatTools.js';

const definitions: LlmToolDefinition[] = [
  { type: 'function', function: { name: 'search_knowledge_base', description: 'Find saved material.', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'create_diagram', description: 'Create an editable diagram.', parameters: { type: 'object' } } },
];

test('capabilities stay discoverable without keywords; loading does not execute or invent tools', () => {
  const catalog = new ToolCatalog(definitions);
  assert.match(catalog.describe(), /create_diagram: Create an editable diagram/);
  assert.deepEqual(catalog.schemas().map(tool => tool.function.name), ['load_tools', 'search_knowledge_base']);
  assert.throws(() => catalog.load(['create_diagram', 'invented_tool']), /permitted capability/);
  assert.deepEqual(catalog.schemas().map(tool => tool.function.name), ['load_tools', 'search_knowledge_base'], 'failed loads are atomic');
  assert.deepEqual(catalog.load(['create_diagram']).loaded, ['create_diagram']);
  assert.ok(catalog.schemas().includes(definitions[1]!));
  const anotherTurn = new ToolCatalog(definitions);
  assert.equal(anotherTurn.schemas().length, 2, 'loaded state is not persisted across user turns');
});

test('structured scope validates and enforces explicit filters without reading user words', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const { scope } = declaredRetrievalScope({
    sources: ['discovered-article', 'note'], states: ['to-review', 'saved'], dateField: 'discovered',
    within: { period: 'yesterday' },
  }, now);
  assert.deepEqual(scope.families, ['discover-article', 'note']);
  assert.equal(scope.filter.within?.startUtc, '2026-10-24T23:00:00.000Z');
  assert.equal(scope.filter.within?.endUtc, '2026-10-26T00:00:00.000Z');
  assert.deepEqual(resolveSearchFilter({}, scope, now), scope.filter);
  assert.deepEqual(resolveSearchFilter({ sources: ['email'] }, scope, now).sources, [], 'a query cannot widen the declared collections');
  assert.equal(isOutsideCollectionTool('search_library', scope), true);
  assert.equal(isOutsideCollectionTool('search_knowledge_base', scope), false);
  assert.throws(() => declaredRetrievalScope({ sources: ['invented-tag'] }), /recognised values/);
  assert.throws(() => declaredRetrievalScope({ tags: ['manually-approve-me'] }), /Unknown retrievalScope/);
  assert.throws(() => declaredRetrievalScope({ within: { period: 'not a period' } }), /supported period/);
  assert.throws(() => declaredRetrievalScope({ parkedOnly: 'yes' }), /boolean/);
  assert.throws(() => declaredRetrievalScope({ dateField: ['published'] }), /Unknown dateField/);
  assert.throws(() => declaredRetrievalScope({ within: { period: 'today', start: '2026-01-01' } }), /either/);
  assert.equal(resolveSearchFilter({ parkedOnly: false }, declaredRetrievalScope({ parkedOnly: true }).scope).parkedOnly, true);
});

for (const boundary of [
  { sources: ['discovered-article'] },
  { states: ['saved'] },
  { parkedOnly: true },
  { within: { period: 'yesterday' } },
  { projectId: 'platform' },
]) test(`declared boundaries reject same-round bypasses and later widening: ${JSON.stringify(boundary)}`, async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string) => ({
    rows: sql === 'SELECT id FROM projects WHERE id=$1' ? [{ id: 'platform' }] : [],
  }));
  let calls = 0;
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools) => {
    calls++;
    if (calls === 1) return { content: null, toolCalls: [
      { id: 'scope', type: 'function' as const, function: { name: 'load_tools', arguments: JSON.stringify({ names: ['search_knowledge_base'], retrievalScope: boundary }) } },
      { id: 'bypass', type: 'function' as const, function: { name: 'read_past_chat', arguments: '{"sessionId":"outside"}' } },
    ], finishReason: 'tool_calls' };
    assert.ok(!tools.some(tool => tool.function.name === 'read_past_chat'));
    if (calls === 2) {
      assert.match(String(messages.at(-1)?.content), /not loaded or is unavailable/);
      return { content: null, toolCalls: [{ id: 'widen', type: 'function' as const,
        function: { name: 'load_tools', arguments: '{"names":["search_knowledge_base"],"retrievalScope":{}}' } }], finishReason: 'tool_calls' };
    }
    assert.match(String(messages.at(-1)?.content), /cannot be changed within this turn/);
    return { content: 'The retrieval boundary remains in place.', toolCalls: [], finishReason: 'stop' };
  });
  try {
    await handleConversationTurn(db, [], 'Keep to the agreed source boundary.', 'standard', 'general',
      undefined, undefined, undefined, {}, { onAudit: () => {} });
    assert.equal(calls, 3);
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});

test('meeting imports reject invented input and note edits default to preserving formatting', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => { throw new Error('Invalid input must not reach storage'); });
  try {
    const imported = await executeToolCall(db, 'import_meeting_list', '{"text":"Invented meeting"}',
      undefined, { userMessage: 'Discuss the meeting import format.' });
    assert.match(JSON.stringify(imported), /No meetings imported/);
    const edited = await executeToolCall(db, 'propose_note_edit',
      JSON.stringify({ edits: [{ action: 'replace_all', markdown: 'Unrequested replacement', summary: 'Rewrite' }] }),
      undefined, { noteId: '11111111-1111-4111-8111-111111111111', noteEdits: [] }, { onAudit: () => {} });
    assert.match(JSON.stringify(edited), /not permission to rewrite or reformat/);
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); await db.end(); }
});

test('a full-document read expands capacity without resetting consumed work', () => {
  const budget = new TurnBudget();
  budget.admitSource('Already read');
  budget.retrievalExecutions = 2;
  budget.useDocumentReviewLimits();
  assert.equal(budget.sourceChars, 12);
  assert.equal(budget.retrievalExecutions, 2);
  assert.equal(budget.remainingSourceChars(), 240_000 - 12);
});

for (const request of [
  'Do not create a diagram. Explain why the current design is confusing.',
  'Can you fix this? I mean your last answer, not the note.',
  'We are discussing whether to save it; do not save or remember anything.',
  'No, the other one. Just tell me the difference.',
  'plese explain, dont chnage the doc',
]) test(`active chat leaves interpretation to the model: ${request}`, async () => {
  const db = new Pool();
  const statements: string[] = [];
  const query = mock.method(db, 'query', async (sql: string) => { statements.push(sql); return { rows: [] }; });
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools, _tokens, choice) => {
    assert.equal(choice, 'auto');
    assert.match(JSON.stringify(messages), /Interpret intent from the whole exchange/);
    assert.ok(messages.some(message => typeof message.content === 'string' && message.content.includes(request)));
    assert.ok(tools.some(tool => tool.function.name === 'load_tools'));
    return { content: 'I will explain the difference without changing either document.', toolCalls: [], finishReason: 'stop' };
  });
  try {
    const reply = await handleConversationTurn(db, [
      { role: 'user', content: 'Compare the two ideas.' },
      { role: 'assistant', content: 'We can discuss either one without changing your note.' },
    ], request, 'standard', 'general', undefined, { type: 'note', title: 'Reference only', detail: 'Existing content.' },
    undefined, { noteId: '11111111-1111-4111-8111-111111111111', noteEdits: [] });
    assert.match(reply, /without changing/);
    assert.equal(completion.mock.callCount(), 1, 'no phrase-driven repair or forced action');
    assert.ok(!statements.some(sql => /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:notes|tasks|content_items|tags|tag_candidates)\b/i.test(sql)));
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});

test('read-only turns cannot load a write capability even if the model requests it', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => ({ rows: [] }));
  let calls = 0;
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools) => {
    calls++;
    assert.ok(!tools.some(tool => tool.function.name === 'create_task'));
    if (calls === 1) return { content: null, toolCalls: [{ id: 'denied', type: 'function' as const,
      function: { name: 'load_tools', arguments: '{"names":["create_task"]}' } }], finishReason: 'tool_calls' };
    assert.match(String(messages.at(-1)?.content), /permitted capability/);
    return { content: 'This turn is read-only; no task was created.', toolCalls: [], finishReason: 'stop' };
  });
  try {
    const reply = await handleConversationTurn(db, [], 'Explain the next step.', 'standard', 'general',
      undefined, undefined, undefined, {}, { readOnlyTools: true, onAudit: () => {} });
    assert.match(reply, /no task was created/);
    assert.equal(calls, 2);
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});
