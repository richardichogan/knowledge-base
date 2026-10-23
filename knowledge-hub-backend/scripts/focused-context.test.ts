import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { buildAiContext, assembleMessages } from '../src/ai/contextBuilder.js';
import { buildOutputsBlock, readOutputForChat } from '../src/ai/chatOutputs.js';
import { executeToolCall, getToolDefinitions } from '../src/ai/chatTools.js';
import { handleConversationTurn } from '../src/ai/conversationService.js';
import { FoundryClient, type LlmMessage, type LlmToolDefinition } from '../src/ai/foundryClient.js';
import { emptyContextUsed } from '../src/ai/contextUsage.js';
import { focusTools, selectRequiredToolChoice } from '../src/ai/toolRouting.js';
import type { NoteEditProposal } from '../src/ai/noteEdits.js';
import { blocksToTextWithImages, blockContentSpans } from '../src/utils/noteContent.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';
const outputId = '33333333-3333-4333-8333-333333333333';

test('RTR-style saved tables are readable through the backend note renderer too', () => {
  const table = { type: 'table', content: { rows: [
    { cells: [{ content: [{ text: 'Case' }] }, { content: [{ text: 'Support' }] }] },
    { cells: [{ content: [{ text: 'CL-101' }] }, { content: [{ text: '1311000' }] }] },
    { cells: [[{ text: 'Legacy' }], [{ text: '800' }]] },
  ] } };
  assert.equal(blockContentSpans(table).map(span => span.text).join(','), 'Case,Support,CL-101,1311000,Legacy,800');
  assert.equal(blocksToTextWithImages([table], new Map()), 'Case | Support\nCL-101 | 1311000\nLegacy | 800');
});

test('a mixed valid and invalid note-edit batch is rejected without leaving a partial preview', async () => {
  const db = new Pool();
  const noteEdits: NoteEditProposal[] = [];
  try {
    const result = await executeToolCall(db, 'propose_note_edit', JSON.stringify({ edits: [
      { action: 'append', markdown: 'Concrete fixture', summary: 'Add fixture' },
      { action: 'replace_section', summary: 'Invalid missing heading and body' },
    ] }), undefined, { noteId: outputId, noteEdits });
    assert.match(JSON.stringify(result), /No edits proposed/);
    assert.deepEqual(noteEdits, []);
  } finally { await db.end(); }
});

test('time limit after RTR-style edit production preserves the preview without claiming completion or requesting a retry', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => ({ rows: [] }));
  let now = 1_000;
  const clock = mock.method(Date, 'now', () => now);
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async () => {
    now += 60_000;
    return { content: null, toolCalls: [{ id: 'edit-one', type: 'function' as const, function: { name: 'propose_note_edit',
      arguments: JSON.stringify({ edits: [{ action: 'replace_all', markdown: '# Fixtures\nComplete synthetic dataset.', summary: 'Replace fixtures' }] }) } }],
    finishReason: 'tool_calls' };
  });
  const noteEdits: NoteEditProposal[] = [];
  try {
    const reply = await handleConversationTurn(db, [], 'Rewrite this note with the agreed synthetic data',
      'standard', 'demo_designer', sessionId, { type: 'note', title: 'RTR', detail: 'Existing requirements' },
      undefined, { noteId: outputId, noteEdits }, { budgetMs: 30_000 });
    assert.equal(noteEdits.length, 1);
    assert.match(reply, /1 proposed edit/);
    assert.match(reply, /before I could finish checking/);
    assert.match(reply, /not saved changes/);
    assert.doesNotMatch(reply, /try again|ask a more specific question/);
    assert.equal(completion.mock.callCount(), 1);
  } finally {
    clock.mock.restore(); completion.mock.restore(); query.mock.restore(); await db.end();
  }
});

test('ordinary and source-bound requests do not perform automatic knowledge, graph or past-chat searches', async () => {
  const db = new Pool();
  const reads: string[] = [];
  const query = mock.method(db, 'query', async (sql: string) => {
    reads.push(sql);
    if (sql.includes("kind = 'profile'")) return { rows: [{
      content: 'Essential preferences: produce output first', status: 'active',
    }] };
    if (sql.includes('FROM projects ORDER BY name')) {
      return { rows: [{ id: 'imagine', name: 'IMAGINE', goal: 'UNRELATED_GOAL', importance: 'critical', lifecycle_state: 'active' }] };
    }
    return { rows: [] };
  });
  try {
    for (const persona of ['general', 'brainstorming', 'podcast_show_notes']) {
      const context = await buildAiContext(db, 'Summarise this document', [
        { role: 'user', content: 'Previous unrelated topic' },
      ], sessionId, persona);
      assert.deepEqual(context.ragItems, []);
      assert.deepEqual(context.memoryItems, []);
      assert.equal(context.ragQuery, 'Summarise this document');
      assert.ok(!context.projectContext.includes('UNRELATED_GOAL'));
      const messages = await assembleMessages(context, [], 'Summarise this document', persona,
        { type: 'document', title: 'Selected source', detail: 'Exact source material' });
      assert.ok(messages.at(-1)?.content.includes('Exact source material'));
      assert.ok(messages[0]?.content.includes('Essential preferences'));
      const systemPrompt = messages[0]?.content ?? '';
      assert.ok(systemPrompt.includes('asking questions and challenging the thinking are part of the work, not a last resort'));
      assert.ok(systemPrompt.includes('Start an exploratory exchange with a brief observation or specific challenge and one focused question'));
      assert.ok(systemPrompt.includes('one question at a time is not a limit of one question per conversation'));
      assert.ok(systemPrompt.includes('Answer clear factual questions directly'));
      assert.ok(systemPrompt.includes('Push back when his premise is unsupported'));
      assert.ok(systemPrompt.includes('pause and wait for his answer rather than answering your own question'));
      assert.ok(systemPrompt.indexOf('## Conversation and constructive challenge') > systemPrompt.indexOf('Essential preferences'));
      assert.ok(systemPrompt.includes('override any older profile instruction to draft before asking questions'));
      assert.ok(systemPrompt.includes('Do not lead with a refusal, frame questioning as an annoyance'));
      assert.ok(systemPrompt.includes('Choose the working mode from his current intent and the conversation'));
      assert.ok(systemPrompt.includes('A clear action request does not need prior discussion or a follow-up question'));
      assert.ok(systemPrompt.includes('do not keep interviewing after he has decided'));
      assert.ok(systemPrompt.includes('When he is being playful, reciprocate with a brief dry or wry reply'));
      assert.ok(systemPrompt.includes('never confuse sarcasm with consent to an action'));
      assert.ok(systemPrompt.includes('without a defensive joke, forced cheerfulness or a lecture'));
      if (persona === 'brainstorming') {
        assert.ok(messages[0]?.content.includes('Let him answer before developing a detailed critique or alternative'));
        assert.ok(!messages[0]?.content.includes('Ask for clarification only when'));
      }
      assert.ok(!messages.at(-1)?.content.includes('Previous unrelated topic'));
    }
    assert.ok(reads.every(sql => !/content_items|ai_chat_messages|graph_|plan_tasks/.test(sql)), reads.join('\n'));
  } finally { query.mock.restore(); await db.end(); }
});

test('the actual conversation sends an Outputs index, not bodies or the diary, while keeping read tools', async () => {
  const db = new Pool();
  const reads: string[] = [];
  const query = mock.method(db, 'query', async (sql: string) => {
    reads.push(sql);
    if (sql.includes("kind = 'profile'")) return { rows: [{ content: 'Essential preferences', status: 'active' }] };
    if (sql.includes('FROM chat_outputs o')) {
      return { rows: [{ id: outputId, session_id: sessionId, title: 'Saved draft', kind: 'document',
        format: 'markdown', updated_at: new Date(), version: 2 }] };
    }
    return { rows: [] };
  });
  let captured: LlmMessage[] = [];
  let available: LlmToolDefinition[] = [];
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools) => {
    captured = messages;
    available = tools;
    return { content: 'The source says this.', toolCalls: [], finishReason: 'stop' };
  });
  const usage = emptyContextUsed();
  try {
    const reply = await handleConversationTurn(db, [], 'Summarise this document', 'standard', 'general', sessionId,
      { type: 'document', title: 'Selected source', detail: 'The supplied source is primary.' }, undefined, {}, { contextUsed: usage });
    assert.equal(reply, 'The source says this.');
    assert.ok(captured.some(message => typeof message.content === 'string' && message.content.includes('The supplied source is primary.')));
    assert.ok(typeof captured[0]?.content === 'string' && captured[0].content.includes('index only; contents not loaded'));
    assert.ok(available.some(tool => tool.function.name === 'read_output'));
    assert.ok(available.some(tool => tool.function.name === 'get_today_schedule'));
    assert.ok(available.some(tool => tool.function.name === 'search_knowledge_base'));
    assert.ok(!available.some(tool => tool.function.name === 'create_diagram' || tool.function.name === 'update_diagram'));
    assert.ok(!available.some(tool => tool.function.name === 'add_discover_source'));
    assert.equal(usage.outputs, 1);
    assert.deepEqual(usage.auto, []);
    assert.ok(usage.initialSize);
    assert.equal(usage.initialSize.historyChars, 0);
    assert.ok(usage.initialSize.outputsIndexChars < 1000);
    assert.equal(usage.initialSize.toolSchemaChars, JSON.stringify(available).length);
    assert.ok(!reads.some(sql => sql.includes('SELECT content, author FROM chat_output_versions')));
    assert.ok(!reads.some(sql => sql.includes("source = 'graph-calendar'")));
    assert.ok(!reads.some(sql => sql.includes('FROM ai_chat_messages')));
  } finally {
    completion.mock.restore();
    query.mock.restore();
    await db.end();
  }
});

test('output bodies are read on demand in bounded pages, using the current version and chat ownership', async () => {
  const pg = new PGlite();
  const db = new Pool();
  const query = mock.method(db, 'query', (sql: string, values?: unknown[]) => pg.query(sql, values));
  try {
    await pg.exec(`CREATE TABLE chat_outputs (
      id uuid PRIMARY KEY, session_id uuid, title text, kind text, format text, updated_at timestamptz
    );
    CREATE TABLE chat_output_versions (output_id uuid, version integer, content text, author text);`);
    const content = 'Current user-edited content. '.repeat(1200);
    await pg.query(`INSERT INTO chat_outputs VALUES ($1,$2,'Saved draft','document','markdown',now())`, [outputId, sessionId]);
    await pg.query(`INSERT INTO chat_output_versions VALUES ($1,1,'OLD VERSION','athena'),($1,2,$2,'user')`, [outputId, content]);
    const index = await buildOutputsBlock(db, sessionId);
    assert.ok(index.length < 1000, 'A 30,000+ character output contributes fewer than 1,000 index characters');
    assert.ok(!index.includes('Current user-edited content'));
    assert.ok(index.includes(outputId) && index.includes('v2'));
    let offset: number | null = 0;
    let reconstructed = '';
    while (offset !== null) {
      const page = await readOutputForChat(db, sessionId, outputId, offset, 2);
      assert.ok(page);
      assert.equal(page.version, 2);
      assert.ok(page.content.length <= 12_000);
      assert.equal(page.totalChars, content.length);
      reconstructed += page.content;
      offset = page.nextOffset;
    }
    assert.equal(reconstructed, content, 'All pages reconstruct the exact latest version without losing user edits');
    const firstPage = await executeToolCall(db, 'read_output', JSON.stringify({ output_id: outputId }), undefined, { sessionId });
    assert.ok(typeof firstPage === 'object' && firstPage !== null && 'content' in firstPage);
    assert.equal(firstPage.content, content.slice(0, 12_000));
    assert.deepEqual(await executeToolCall(db, 'read_output', JSON.stringify({ output_id: outputId, offset: 12_000 }), undefined, { sessionId }), {
      error: 'Provide expected_version from the first page before continuing.',
    });
    await pg.query(`INSERT INTO chat_output_versions VALUES ($1,3,'New user edit','user')`, [outputId]);
    await assert.rejects(readOutputForChat(db, sessionId, outputId, 12_000, 2), /output changed/);
    assert.equal(await readOutputForChat(db, otherSession, outputId), null);
    assert.deepEqual(await executeToolCall(db, 'read_output', JSON.stringify({ output_id: outputId }), undefined, { sessionId: otherSession }), {
      error: 'That output was not found in this chat.',
    });
    assert.deepEqual(await executeToolCall(db, 'read_output', JSON.stringify({ output_id: outputId, offset: -1 }), undefined, { sessionId }), {
      error: 'offset must be a non-negative safe integer.',
    });
    await assert.rejects(readOutputForChat(db, sessionId, outputId, Number.MAX_SAFE_INTEGER), /offset must/);
    assert.deepEqual(await executeToolCall(db, 'read_output', JSON.stringify({ output_id: outputId })), {
      error: 'No chat to read an output from.',
    });
  } finally { query.mock.restore(); await db.end(); await pg.close(); }
});

test('calendar access remains available on demand and read failures propagate', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => ({
    rows: [{ title: 'Design review', summary: 'Review the claims workflow', source_id: 'ibm-paste-fixture', published_at: new Date() }],
  }));
  try {
    const result = await executeToolCall(db, 'get_today_schedule', '{}');
    assert.ok(typeof result === 'object' && result !== null && 'schedule' in result);
    assert.match(String(result.schedule), /Design review/);
    query.mock.restore();
    const failed = mock.method(db, 'query', async () => { throw new Error('Diary unavailable'); });
    try { await assert.rejects(executeToolCall(db, 'get_today_schedule', '{}'), /Diary unavailable/); }
    finally { failed.mock.restore(); }
  } finally { query.mock.restore(); await db.end(); }
});

test('personal diary requests read the schedule rather than forcing a web search for the word today', () => {
  const tools: LlmToolDefinition[] = ['get_today_schedule', 'tavily-search'].map(name => ({
    type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } },
  }));
  for (const message of ['What am I doing today?', "What's on today?", 'What are my meetings today?', 'Am I free this afternoon?']) {
    assert.deepEqual(selectRequiredToolChoice(message, tools), { type: 'function', function: { name: 'get_today_schedule' } });
  }
  for (const message of ['What are my meetings tomorrow?', 'My diary for 30 October', 'What is Microsoft announcing today?', 'What is new in Google Calendar today?']) {
    assert.notDeepEqual(selectRequiredToolChoice(message, tools), { type: 'function', function: { name: 'get_today_schedule' } });
  }
});

test('specialised tool groups are sent only when the turn, recent history or an open diagram needs them', async () => {
  const all = await getToolDefinitions();
  const names = (tools: LlmToolDefinition[]) => new Set(tools.map(tool => tool.function.name));
  const plain = focusTools(all, { userMessage: 'What are the risks in the Imagine rollout?' });
  const plainNames = names(plain);
  for (const withheld of ['create_diagram', 'update_diagram', 'add_discover_source', 'update_discover_source',
    'set_discover_item_state', 'inspect_discover_feed', 'create_weekly_microsoft_digest']) {
    assert.ok(!plainNames.has(withheld), withheld);
  }
  for (const kept of ['search_knowledge_base', 'search_library', 'fetch_web_page', 'read_output', 'save_output',
    'get_today_schedule', 'remember', 'create_task', 'update_task', 'search_diagrams', 'read_diagram',
    'propose_note_edit', 'propose_map_changes', 'get_discover_sources', 'get_discover_watchlist_records']) {
    assert.ok(plainNames.has(kept), kept);
  }
  const before = JSON.stringify(all).length;
  const after = JSON.stringify(plain).length;
  assert.ok(after < before * 0.65, `tool schemas ${before} -> ${after}`);

  assert.ok(names(focusTools(all, { userMessage: 'Draw an AI flow for claims triage' })).has('create_diagram'));
  assert.ok(names(focusTools(all, { userMessage: 'add a box for the reviewer', hasOpenDiagram: true })).has('update_diagram'));
  assert.ok(names(focusTools(all, { userMessage: 'add a box for the reviewer', recentText: 'I drew the diagram d-1.' })).has('update_diagram'));
  assert.ok(names(focusTools(all, { userMessage: 'Subscribe to this RSS feed' })).has('add_discover_source'));
  assert.ok(names(focusTools(all, { userMessage: 'Draft the weekly Microsoft digest' })).has('create_weekly_microsoft_digest'));
  const forced = selectRequiredToolChoice('Draw an architecture diagram', focusTools(all, { userMessage: 'Draw an architecture diagram' }));
  assert.deepEqual(forced, { type: 'function', function: { name: 'create_diagram' } });
});

test('a reference to material held elsewhere forces a knowledge search before answering', () => {
  const tools = ['search_knowledge_base', 'propose_note_edit', 'tavily-search'].map((name) => ({
    type: 'function' as const,
    function: { name, description: '', parameters: { type: 'object', properties: {} } },
  }));
  for (const message of [
    'now i have provided Roberts feedback from Dhalias call any additional thoughts?',
    "what did Robert's feedback say?",
    'never assume go find the note!!!!!',
    'any thoughts on the notes from the Dhalia call?',
    "I've added the write-up from Tuesday's meeting",
  ]) {
    const choice = selectRequiredToolChoice(message, tools, [], null, true);
    assert.deepEqual(choice, { type: 'function', function: { name: 'search_knowledge_base' } }, message);
  }
  for (const message of ['what do you think?', 'any additional thoughts?', 'what are your thoughts on this?']) {
    assert.equal(selectRequiredToolChoice(message, tools, [], null, true), undefined, message);
  }
});

test('a project-scoped knowledge search still returns real matches from other projects', async () => {
  const db = new Pool();
  const note = (id: string, project: string, title: string) => ({
    id, source: 'note', source_id: id, title, summary: '', body: '', published_at: new Date('2026-10-19'),
    indexed_at: new Date('2026-10-19'), url: null, project_context: project, metadata: {}, tags: [],
  });
  const query = mock.method(db, 'query', async (sql: string) => {
    if (!sql.includes('FROM content_items')) return { rows: [] };
    if (sql.includes('plainto_tsquery')) {
      return { rows: [note('dhalia-2', 'imagine', 'IMAGINE: Meeting with Dhalia Part 2'), note('ikea-1', 'ikea', 'IKEA: Microsoft Deep Dive')] };
    }
    return { rows: [] };
  });
  try {
    const result = await executeToolCall(db, 'search_knowledge_base', JSON.stringify({ query: 'Robert feedback Dhalia call', projectId: 'ikea' })) as {
      results: Array<{ title: string; projectId: string }>;
    };
    assert.deepEqual(result.results.map((r) => r.projectId).sort(), ['ikea', 'imagine']);
    assert.equal(result.results[0]?.title, 'IMAGINE: Meeting with Dhalia Part 2');
  } finally {
    query.mock.restore();
    await db.end();
  }
});
