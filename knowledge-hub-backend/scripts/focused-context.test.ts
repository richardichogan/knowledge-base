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
import { focusTools, selectRequiredToolChoice, selectKnowledgeRetrievalChoice } from '../src/ai/toolRouting.js';
import type { NoteEditProposal } from '../src/ai/noteEdits.js';
import { allowsStructuralNoteEdits, checkEditsAgainstNote } from '../src/ai/noteEdits.js';
import { blocksToTextWithImages, blockContentSpans } from '../src/utils/noteContent.js';
import { readFile } from 'node:fs/promises';
import { emptyDiagram } from '../src/types/diagram.js';
import { READING_BATCH_TOKENS, REVIEW_CONTEXT_RESERVE, textTokens } from '../src/ai/knowledge/reviewContext.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';
const outputId = '33333333-3333-4333-8333-333333333333';

for (const orchestration of ['true', 'false']) {
  for (const size of [13_000, 200_000]) test(`the model interprets an ambiguous in-view review without a forced action (${orchestration}, ${size})`, async () => {
    const db = new Pool();
    const reads: string[] = [];
    const query = mock.method(db, 'query', async (sql: string) => { reads.push(sql); return { rows: [] }; });
    const original = process.env['KNOWLEDGE_ORCHESTRATION'];
    process.env['KNOWLEDGE_ORCHESTRATION'] = orchestration;
    let calls = 0;
    const bulk = mock.method(FoundryClient.prototype, 'chatBulk', async () => { throw new Error('No reading model may run before intent is known'); });
    const completion = mock.method(FoundryClient.prototype, 'chatWithToolsStream', async (_model, messages, tools, _tokens, choice, _timeout, onDelta, _signal, _route, options) => {
      calls++;
      assert.equal(choice, 'auto');
      assert.ok(tools.some(tool => tool.function.name === 'load_tools'));
      assert.ok(options?.builtInTools, 'actual attached files determine availability, not a phrase match');
      const prompt = JSON.stringify(messages);
      assert.match(prompt, /quick reaction or a detailed document review/);
      assert.match(prompt, /Walking briefing/);
      assert.match(prompt, /PRIVATE_IMAGE|PRIVATE_SCREEN/, 'supplied context remains available for interpreting the request');
      onDelta?.('Unpublished model draft');
      return { content: 'Do you want a quick reaction to the concept or a full review of the specification?', toolCalls: [], finishReason: 'stop' };
    });
    const deltas: string[] = [];
    try {
      const reply = await handleConversationTurn(db, [], 'what do you think?', 'standard', 'general', sessionId,
        { type: 'note', title: 'Walking briefing', detail: `PRIVATE_SOURCE_BODY${'x'.repeat(size)}`, images: 'PRIVATE_IMAGE' },
        undefined, {}, { onDelta: text => deltas.push(text), onAudit: () => {},
          screenImages: [{ label: 'PRIVATE_SCREEN', url: 'data:image/png;base64,AAAA' }],
          codeFiles: { ids: ['file-private'], names: [] } });
      assert.match(reply, /quick reaction to the concept or a full review/);
      assert.equal(calls, 1, 'the model chooses clarification; no keyword classifier or repair model call');
      assert.deepEqual(deltas, ['Unpublished model draft']);
      assert.ok(!reads.some(sql => /document_reading_|FROM notes|FROM library_documents/i.test(sql)));
    } finally {
      if (original === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = original;
      bulk.mock.restore(); completion.mock.restore(); query.mock.restore(); await db.end();
    }
  });

  for (const full of [false, true]) test(`a chosen ${full ? 'full review stays detailed' : 'concept reaction stays conversational'} (${orchestration})`, async () => {
    const db = new Pool();
    const query = mock.method(db, 'query', async () => ({ rows: [] }));
    const original = process.env['KNOWLEDGE_ORCHESTRATION'];
    process.env['KNOWLEDGE_ORCHESTRATION'] = orchestration;
    const history = [{ role: 'assistant' as const, content: 'Do you want a quick reaction to the concept or a full review of the specification?' }];
    const expected = full ? 'Detailed finding about interruption recovery. '.repeat(120)
      : 'The interruption-aware idea is useful. Is this mainly for capturing thoughts or hearing a curated briefing?';
    let calls = 0;
    const completion = mock.method(FoundryClient.prototype, 'chatWithToolsStream', async (_model, messages, tools, _tokens, choice) => {
      calls++;
      assert.equal(choice, 'auto');
      assert.ok(tools.some(tool => tool.function.name === 'read_knowledge_record'));
      assert.match(JSON.stringify(messages), /SOURCE_BODY_WITH_REQUIREMENTS/);
      assert.match(JSON.stringify(messages), /quick reaction to the concept or a full review/);
      assert.match(JSON.stringify(messages), full ? /The latter/ : /The former/);
      return { content: expected, toolCalls: [], finishReason: 'stop' };
    });
    try {
      const reply = await handleConversationTurn(db, history, full ? 'The latter.' : 'The former.',
        'standard', 'general', sessionId, { type: 'note', title: 'Walking briefing', detail: 'SOURCE_BODY_WITH_REQUIREMENTS' },
        undefined, {}, { onDelta: () => {}, onAudit: () => {} });
      assert.equal(reply, expected);
      assert.equal(calls, 1, 'do not re-ask depth or repair a full review into a short interview');
    } finally {
      if (original === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = original;
      completion.mock.restore(); query.mock.restore(); await db.end();
    }
  });
}

for (const orchestration of ['true', 'false']) {
  test(`an explicit ordinary-note review respects audience instead of asking a stock depth question (${orchestration})`, async () => {
    const db = new Pool();
    const query = mock.method(db, 'query', async () => ({ rows: [] }));
    const original = process.env['KNOWLEDGE_ORCHESTRATION'];
    process.env['KNOWLEDGE_ORCHESTRATION'] = orchestration;
    const completion = mock.method(FoundryClient.prototype, 'chatWithToolsStream', async (_model, messages, tools, _tokens, choice) => {
      assert.equal(choice, 'auto');
      assert.ok(tools.some(tool => tool.function.name === 'load_tools'));
      const prompt = JSON.stringify(messages);
      assert.match(prompt, /Interpret the requested review depth from the conversation/);
      assert.match(prompt, /limited English/);
      assert.match(prompt, /MANUAL_SOURCE/);
      return { content: 'Use short sentences and explain the unfamiliar controls.', toolCalls: [], finishReason: 'stop' };
    });
    try {
      const reply = await handleConversationTurn(db, [],
        'Please review this note and its language for Bulgarian and Spanish guests with limited English.',
        'standard', 'general', sessionId, { type: 'note', title: 'Guest guide', detail: 'MANUAL_SOURCE' },
        undefined, {}, { onDelta: () => {}, onAudit: () => {} });
      assert.equal(reply, 'Use short sentences and explain the unfamiliar controls.');
      assert.equal(completion.mock.callCount(), 1);
    } finally {
      if (original === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = original;
      completion.mock.restore(); query.mock.restore(); await db.end();
    }
  });

  test(`exploratory chat is model-led without a keyword-triggered second generation (${orchestration})`, async () => {
    const db = new Pool();
    const query = mock.method(db, 'query', async () => ({ rows: [] }));
    const original = process.env['KNOWLEDGE_ORCHESTRATION'];
    process.env['KNOWLEDGE_ORCHESTRATION'] = orchestration;
    let calls = 0;
    const drafts: string[] = [];
    const completion = mock.method(FoundryClient.prototype, 'chatWithToolsStream', async (_model, messages, tools, _tokens, choice, _timeout, onDelta) => {
      calls++;
      onDelta?.('Unpublished draft');
      assert.ok(tools.some(tool => tool.function.name === 'load_tools'));
      assert.equal(choice, 'auto');
      assert.equal(calls, 1);
      assert.match(JSON.stringify(messages), /Interpret intent from the whole exchange/);
      return { content: 'A readable spec and an executable contract are not quite the same job. Who needs to use it first?', toolCalls: [], finishReason: 'stop' };
    });
    try {
      const reply = await handleConversationTurn(db, [], 'Help me think through the specification design.',
        'standard', 'general', sessionId, undefined, undefined, {}, {
          onDelta: text => drafts.push(text), onAudit: () => {},
        });
      assert.equal(calls, 1);
      assert.deepEqual(drafts, ['Unpublished draft']);
      assert.match(reply, /Who needs to use it first\?/);
      assert.doesNotMatch(reply, /Detailed framework/);
    } finally {
      if (original === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION'];
      else process.env['KNOWLEDGE_ORCHESTRATION'] = original;
      completion.mock.restore(); query.mock.restore(); await db.end();
    }
  });
}

for (const inView of [false, true]) test(`the actual chat reads a ${inView ? 'chosen full specification in view' : 'newsletter'} beyond a single context through checkpoint memory, not repeated model tool rounds`, async () => {
  const pg = new PGlite();
  await pg.exec('CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY)');
  await pg.query('INSERT INTO ai_chat_sessions VALUES ($1)', [sessionId]);
  await pg.exec(await readFile(new URL('../src/db/migrations/097_document_reading_memory.sql', import.meta.url), 'utf8'));
  const db = new Pool();
  const id = '44444444-4444-4444-8444-444444444444';
  const body = `${'Newsletter item: exact facts and links.\n'.repeat(8_000)}FINAL NEWSLETTER ENTRY: ship the evaluation.`;
  const content = JSON.stringify({ title: 'Full newsletter', contentJson: JSON.stringify([
    { type: 'paragraph', content: [{ type: 'text', text: body }] },
  ]) });
  const query = mock.method(db, 'query', async (sql: string, values: unknown[] = []) => {
    if (sql.includes('document_reading_')) return pg.query(sql, values);
    if (sql.includes('SELECT id::text AS id FROM notes')) return { rows: [{ id }] };
    if (sql.includes('SELECT content, project_id')) return { rows: [{
      content, project_id: null, created_at: new Date('2026-10-23'), updated_at: new Date('2026-10-23'), status: 'active',
    }] };
    return { rows: [] };
  });
  const flag = process.env['KNOWLEDGE_ORCHESTRATION'];
  process.env['KNOWLEDGE_ORCHESTRATION'] = 'true';
  let calls = 0;
  let pageCalls = 0;
  let audit: unknown;
  let contextTokens = 0;
  const capacity = mock.method(FoundryClient.prototype, 'reviewContextTokens', () => contextTokens);
  const bulk = mock.method(FoundryClient.prototype, 'chatBulk', async messages => {
    const input = JSON.parse(messages[1]!.content);
    if (input.sourcePage !== undefined) {
      pageCalls++;
      assert.ok(textTokens(input.sourcePage) <= READING_BATCH_TOKENS);
      return JSON.stringify({ summary: input.sourcePage.slice(-200), memory: input.sourcePage.slice(-200),
        excerpts: [input.sourcePage.slice(-80)] });
    }
    assert.ok(input.summaries.join('').length <= 18_000);
    return input.summaries.join('\n').slice(-5_000);
  });
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools, tokens, choice) => {
    calls++;
    if (calls === 1) contextTokens = textTokens(JSON.stringify({ messages, tools })) + tokens + REVIEW_CONTEXT_RESERVE + 20_000;
    if (inView && calls === 1) {
      assert.equal(choice, 'auto');
      assert.match(JSON.stringify(messages), new RegExp(`Open record identity:.*${id}`));
    }
    if (calls === 1) return { content: null, toolCalls: [{ id: 'full', type: 'function' as const,
      function: { name: 'read_knowledge_record', arguments: JSON.stringify({ kind: 'note', id, fullDocument: true }) } }], finishReason: 'tool_calls' };
    const result = JSON.parse(String(messages.at(-1)?.content));
    assert.equal(result.review.complete, true);
    assert.ok(result.review.readChars > 240_000);
    assert.match(result.review.summary, /FINAL NEWSLETTER ENTRY/);
    return { content: `The final entry calls for the evaluation [[cite:note:${id}|ship the evaluation]].`, toolCalls: [], finishReason: 'stop' };
  });
  try {
    const reply = await handleConversationTurn(db, [], inView ? 'Full review of this specification.' : 'Read the full newsletter and summarise every section',
      'standard', 'general', sessionId, inView ? { type: 'note', title: 'Full newsletter', detail: body } : undefined,
      undefined, inView ? { noteId: id } : {}, { onAudit: row => { audit = row; } });
    assert.equal(calls, 2);
    assert.ok(pageCalls > 0 && pageCalls < 4, 'overflow pages are combined into token-sized source batches');
    assert.match(reply, /final entry calls for the evaluation/);
    assert.doesNotMatch(reply, /not everything|quote|incomplete|body did not/i);
    assert.match(JSON.stringify(audit), /"read":1/);
  } finally {
    if (flag === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = flag;
    completion.mock.restore(); bulk.mock.restore(); capacity.mock.restore(); query.mock.restore();
    await db.end(); await pg.close();
  }
});

for (const missing of [false, true]) test(`actual diagram chat ${missing ? 'reports a deleted diagram without a spurious source-limit warning' : 'reads every page beyond the ordinary source budget'}`, async () => {
  const pg = new PGlite();
  await pg.exec('CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY)');
  await pg.query('INSERT INTO ai_chat_sessions VALUES ($1)', [sessionId]);
  await pg.exec(await readFile(new URL('../src/db/migrations/097_document_reading_memory.sql', import.meta.url), 'utf8'));
  const db = new Pool();
  const id = '44444444-4444-4444-8444-444444444444';
  const source = { ...emptyDiagram(), nodes: [{
    id: 'step', kind: 'process', label: 'Release',
    description: `${'Exact diagram requirement. '.repeat(6000)}FINAL-DIAGRAM-ACCEPTANCE`,
    x: 0, y: 0, width: 100, height: 60, parentId: null, fill: '#fff', stroke: '#000',
    textColor: '#000', fontSize: 14, assetId: null,
  }] };
  const query = mock.method(db, 'query', async (sql: string, values: unknown[] = []) => {
    if (sql.includes('document_reading_')) return pg.query(sql, values);
    if (sql.includes('FROM canvases c JOIN canvas_diagrams')) return { rows: missing ? [] : [{
      id, title: 'Release flow', project: null, description: null, revision: 7,
      updated_at: '2026-10-24', document: source, linked_notes: [], element_notes: [], assets: [],
    }] };
    return { rows: [] };
  });
  const flag = process.env['KNOWLEDGE_ORCHESTRATION'];
  process.env['KNOWLEDGE_ORCHESTRATION'] = 'true';
  let calls = 0;
  let pageCalls = 0;
  const used = emptyContextUsed();
  let contextTokens = 0;
  const capacity = mock.method(FoundryClient.prototype, 'reviewContextTokens', () => contextTokens);
  const bulk = mock.method(FoundryClient.prototype, 'chatBulk', async messages => {
    assert.equal(missing, false, 'missing diagrams must not invoke a reading model');
    const input = JSON.parse(messages[1]!.content);
    if (input.sourcePage !== undefined) {
      pageCalls++;
      assert.ok(textTokens(input.sourcePage) <= READING_BATCH_TOKENS);
      return JSON.stringify({ summary: input.sourcePage.slice(-800), memory: input.sourcePage.slice(-800), excerpts: [] });
    }
    return input.summaries.join('\n').slice(-5000);
  });
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools, tokens) => {
    calls++;
    if (calls === 1) contextTokens = textTokens(JSON.stringify({ messages, tools })) + tokens + REVIEW_CONTEXT_RESERVE + 20_000;
    if (calls === 1) return { content: null, toolCalls: [{ id: 'diagram-read', type: 'function' as const,
      function: { name: 'read_diagram', arguments: JSON.stringify({ diagramId: id }) } }], finishReason: 'tool_calls' };
    const result = JSON.parse(String(messages.at(-1)?.content));
    if (missing) {
      assert.equal(result.status, 'not_found');
      return { content: 'The saved diagram is no longer available, so I could not compare it.', toolCalls: [], finishReason: 'stop' };
    }
    assert.equal(result.review.complete, true);
    assert.ok(result.review.readChars > 48_000);
    assert.match(result.review.summary, /FINAL-DIAGRAM-ACCEPTANCE/);
    return { content: 'The final step is FINAL-DIAGRAM-ACCEPTANCE.', toolCalls: [], finishReason: 'stop' };
  });
  try {
    const reply = await handleConversationTurn(db, [], 'Read the saved diagram and explain its final step.',
      'standard', 'general', sessionId, undefined, undefined, {}, { contextUsed: used, onAudit: () => {} });
    assert.equal(calls, 2);
    assert.doesNotMatch(reply, /not everything|source material.*reached/i);
    if (missing) {
      assert.equal(pageCalls, 0);
      assert.match(reply, /no longer available/);
      assert.equal(used.evidence?.counts.read, 0);
    } else {
      assert.ok(pageCalls > 0 && pageCalls < 4, 'diagram overflow uses token batches, not per-page model calls');
      assert.equal(used.evidence?.counts.read, 1);
      assert.equal(used.found[0]?.kind, 'diagram');
    }
  } finally {
    if (flag === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = flag;
    completion.mock.restore(); bulk.mock.restore(); capacity.mock.restore(); query.mock.restore(); await db.end(); await pg.close();
  }
});

test('a failed whole-document read cannot restart its model attempts in the same turn, including through an indexed alias', async () => {
  const pg = new PGlite();
  await pg.exec('CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY)');
  await pg.query('INSERT INTO ai_chat_sessions VALUES ($1)', [sessionId]);
  await pg.exec(await readFile(new URL('../src/db/migrations/097_document_reading_memory.sql', import.meta.url), 'utf8'));
  const db = new Pool();
  const noteId = '44444444-4444-4444-8444-444444444444';
  const mirrorId = '55555555-5555-4555-8555-555555555555';
  const content = JSON.stringify({ title: 'Interrupted review', contentJson: JSON.stringify([
    { type: 'paragraph', content: [{ type: 'text', text: 'Requirement: retain source identity.\n'.repeat(8_000) }] },
  ]) });
  const query = mock.method(db, 'query', async (sql: string, values: unknown[] = []) => {
    if (sql.includes('document_reading_')) return pg.query(sql, values);
    if (sql.includes('SELECT id::text AS id, source, source_id')) return { rows: [{ id: mirrorId, source: 'note', source_id: noteId }] };
    if (sql.includes('SELECT id::text AS id FROM notes')) return { rows: [{ id: noteId }] };
    if (sql.includes("FROM content_items WHERE source = 'note'")) return { rows: [{ id: mirrorId }] };
    if (sql.includes('SELECT content, project_id')) return { rows: [{
      content, project_id: null, created_at: new Date('2026-10-23'), updated_at: new Date('2026-10-23'), status: 'active',
    }] };
    return { rows: [] };
  });
  const original = process.env['KNOWLEDGE_ORCHESTRATION'];
  process.env['KNOWLEDGE_ORCHESTRATION'] = 'true';
  let readingCalls = 0;
  let contextTokens = 0;
  const capacity = mock.method(FoundryClient.prototype, 'reviewContextTokens', () => contextTokens);
  const bulk = mock.method(FoundryClient.prototype, 'chatBulk', async () => {
    readingCalls++;
    return JSON.stringify({ summary: 'A summary', memory: 'Working memory', excerpts: ['FABRICATED quotation not in source'] });
  });
  let calls = 0;
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools, tokens) => {
    calls++;
    if (calls === 1) contextTokens = textTokens(JSON.stringify({ messages, tools })) + tokens + REVIEW_CONTEXT_RESERVE + 20_000;
    if (calls > 1) {
      assert.match(String(messages.at(-1)?.content), /readingInterrupted|No further reading model call/);
    }
    if (calls <= 3) return { content: null, toolCalls: [{
      id: `retry-${calls}`, type: 'function' as const, function: { name: 'read_knowledge_record',
        arguments: JSON.stringify({ kind: calls === 3 ? 'content-item' : 'note', id: calls === 3 ? mirrorId : noteId,
          fullDocument: true, resumeReading: calls > 1, purpose: `changed purpose ${calls}` }) },
    }], finishReason: 'tool_calls' };
    return { content: 'The review did not finish. No page checkpoint was validated, so I cannot give a complete critique.', toolCalls: [], finishReason: 'stop' };
  });
  try {
    const reply = await handleConversationTurn(db, [], 'Read the full specification and review every requirement.',
      'standard', 'general', sessionId, undefined, undefined, {}, { onAudit: () => {} });
    assert.equal(calls, 4);
    assert.equal(readingCalls, 2, 'only the original page and its single bounded checkpoint retry reach the reading model');
    assert.match(reply, /review did not finish/);
    const { rows } = await pg.query<{ next_offset: number }>('SELECT next_offset FROM document_reading_sessions');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.next_offset, 0, 'rejected pages must never count as read');
  } finally {
    if (original === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = original;
    completion.mock.restore(); bulk.mock.restore(); capacity.mock.restore(); query.mock.restore(); await db.end(); await pg.close();
  }
});

for (const scenario of [
  { name: 'an explicitly paged specification review follows every database page even when the model tries to answer early', lines: 1_500, complete: true },
  { name: 'an explicitly paged review reports unread continuation when bounded; full reads use checkpoint memory instead', lines: 7_000, complete: false },
]) test(scenario.name, async () => {
  const db = new Pool();
  const noteId = '44444444-4444-4444-8444-444444444444';
  const body = `${'Requirement: preserve structured fixtures.\n'.repeat(scenario.lines)}FINAL ACCEPTANCE: every fixture must balance.`;
  const content = JSON.stringify({ title: 'RTR product specification', contentJson: JSON.stringify([
    { type: 'heading', content: [{ type: 'entityMention', props: { entityType: 'project', entityId: 'imagine' } }] },
    { type: 'paragraph', content: [{ type: 'text', text: body }] },
  ]) });
  const query = mock.method(db, 'query', async (sql: string) => {
    if (sql.includes('SELECT id::text AS id FROM notes')) return { rows: [{ id: noteId }] };
    if (sql.includes('SELECT content, project_id')) return { rows: [{
      content, project_id: null, created_at: new Date('2026-10-23'), updated_at: new Date('2026-10-23'), status: 'active',
    }] };
    if (sql.includes('WITH targets AS')) return { rows: [{ type: 'project', id: 'imagine', title: 'IMAGINE', url: null }] };
    return { rows: [] };
  });
  const flag = process.env['KNOWLEDGE_ORCHESTRATION'];
  process.env['KNOWLEDGE_ORCHESTRATION'] = 'true';
  let calls = 0;
  let pages = 0;
  let lastEnd = 0;
  let audit: unknown;
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, _tools, _tokens, choice) => {
    calls++;
    const toolMessage = [...messages].reverse().find(message => message.role === 'tool');
    const page = toolMessage && typeof toolMessage.content === 'string' ? JSON.parse(toolMessage.content) : undefined;
    if (page?.record !== undefined && page.record.endOffset > lastEnd) {
      pages++;
      if (pages === 1) assert.match(page.record.content, /IMAGINE/);
      assert.equal(page.record.startOffset, lastEnd);
      lastEnd = page.record.endOffset;
    }
    if (calls === 1 || (typeof choice === 'object' && choice.function.name === 'read_knowledge_record')) {
      if (calls > 1) assert.match(String(messages.at(-1)?.content), /unread continuation pages/);
      return { content: null, toolCalls: [{
        id: `page-${calls}`, type: 'function' as const, function: { name: 'read_knowledge_record',
          arguments: JSON.stringify({ kind: 'note', id: noteId, fullDocument: true, maxChars: 12_000,
            ...(page?.record?.nextCursor ? {} : { offset: 0 }),
            ...(page?.record?.nextCursor ? { cursor: page.record.nextCursor } : {}) }) },
      }], finishReason: 'tool_calls' };
    }
    if (page?.record?.nextCursor) return { content: 'I found the specification, but have not finished reading it.', toolCalls: [], finishReason: 'stop' };
    assert.match(page.record.content, /FINAL ACCEPTANCE/);
    return { content: `The final acceptance requires balanced fixtures [[cite:note:${noteId}|every fixture must balance]].`, toolCalls: [], finishReason: 'stop' };
  });
  try {
    const reply = await handleConversationTurn(db, [], 'Look at the RTR product specification and review it in full',
      'standard', 'general', sessionId, undefined, undefined, {}, { onAudit: row => { audit = row; } });
    assert.ok(pages > 4);
    assert.ok(lastEnd > 48_000);
    if (scenario.complete) {
      assert.match(reply, /final acceptance requires balanced fixtures/);
      assert.doesNotMatch(reply, /did not|not finished|not everything|could not be matched|Document review incomplete/i);
      assert.match(JSON.stringify(audit), /"budgetExhausted":\[\]/);
    } else {
      assert.match(reply, /Document review incomplete: RTR product specification: read through character \d+ of \d+; continuation remains unread/);
      assert.match(JSON.stringify(audit), /model_rounds/);
      assert.match(JSON.stringify(audit), /"partial":true/);
    }
  } finally {
    if (flag === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION']; else process.env['KNOWLEDGE_ORCHESTRATION'] = flag;
    completion.mock.restore(); query.mock.restore(); await db.end();
  }
});

test('self-identity is runtime context, not a forced knowledge search or open-note edit', async () => {
  const tools = await getToolDefinitions();
  for (const message of ['What do you think?', 'Help me think through a demo specification.',
    'Should we create a diagram?', 'What if we generate a complete plan?']) {
    assert.equal(selectKnowledgeRetrievalChoice(message, tools), undefined);
    assert.equal(selectRequiredToolChoice(message, tools, [], null, true), undefined);
  }
  for (const message of [
    'what do you know about yourself and what your capabilities are?',
    'Who are you?',
    'What can you do?',
    'What tools do you have?',
  ]) {
    assert.equal(selectKnowledgeRetrievalChoice(message, tools), undefined);
    assert.equal(selectRequiredToolChoice(message, tools, [{ label: 'Project docs', url: 'https://example.com' }],
      'Athena', true), undefined);
  }
  assert.equal(selectRequiredToolChoice('we need to fix this i think, what do you think?', tools, [], null, true), undefined);
  assert.deepEqual(selectRequiredToolChoice('fix this note', tools, [], null, true),
    { type: 'function', function: { name: 'propose_note_edit' } });
  assert.deepEqual(selectRequiredToolChoice('rewrite it', tools, [], null, true),
    { type: 'function', function: { name: 'propose_note_edit' } });
  assert.deepEqual(selectKnowledgeRetrievalChoice('What decisions did we record about RTR?', tools),
    { type: 'function', function: { name: 'review_decisions' } });
});

test('live chat explains first-party identity and filtered runtime capabilities without requiring retrieval', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => ({ rows: [] }));
  const flag = process.env['KNOWLEDGE_ORCHESTRATION'];
  process.env['KNOWLEDGE_ORCHESTRATION'] = 'true';
  let calls = 0;
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools, _tokens, choice) => {
    calls++;
    assert.equal(choice, 'auto');
    const prompt = messages.find(message => message.role === 'system')?.content;
    assert.equal(typeof prompt, 'string');
    const text = typeof prompt === 'string' ? prompt : '';
    assert.ok(text.includes('personal thinking partner and working assistant'));
    assert.ok(text.includes('useful outcomes over impressive prose'));
    assert.ok(text.includes('first-party runtime context'));
    assert.ok(text.includes('not automatically the target of every request'));
    assert.ok(text.includes('Read-only turn: mutation tools are withheld.'));
    assert.ok(text.includes('Editable note preview: unavailable'));
    assert.ok(text.includes('none supplied; no local filesystem access'));
    assert.ok(text.includes('Outputs panel: not visible here'));
    assert.ok(tools.every(tool => !['propose_note_edit', 'update_note', 'create_task', 'save_output'].includes(tool.function.name)));
    return { content: 'I am Athena, your thinking partner and working assistant.', toolCalls: [], finishReason: 'stop' };
  });

  try {
    const reply = await handleConversationTurn(db, [], 'what do you know about yourself and what your capabilities are?',
      'standard', 'general', sessionId, { type: 'note', title: 'YouTube transcript', detail: 'Source material, not Athena documentation.' },
      undefined, {}, { readOnlyTools: true, noOutputsPanel: true });
    assert.match(reply, /I am Athena/);
    assert.equal(calls, 1);
  } finally {
    if (flag === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION'];
    else process.env['KNOWLEDGE_ORCHESTRATION'] = flag;
    completion.mock.restore(); query.mock.restore(); await db.end();
  }
});

test('Discover retries keep the actual user collection through prompt assembly, tool selection, dispatch and audit', async () => {
    const db = new Pool();
    const reads: string[] = [];
    const query = mock.method(db, 'query', async (sql: string) => { reads.push(sql); return { rows: [] }; });
    const flag = process.env['KNOWLEDGE_ORCHESTRATION'];
    process.env['KNOWLEDGE_ORCHESTRATION'] = 'true';
    let calls = 0;
    let audit: unknown;
    const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async (_model, messages, tools, _tokens, choice) => {
      calls++;
      if (calls === 1) {
        assert.equal(choice, 'auto');
        assert.ok(tools.some(tool => tool.function.name === 'search_library'));
        const prompt = messages.find(message => message.role === 'system')?.content;
        assert.match(String(prompt), /explicit user-imposed collection/);
        return { content: null, toolCalls: [{ id: 'scope', type: 'function' as const,
          function: { name: 'load_tools', arguments: '{"names":["search_knowledge_base"],"retrievalScope":{"sources":["discovered-article"]}}' } }], finishReason: 'tool_calls' };
      }
      if (calls === 2) {
        assert.ok(!tools.some(tool => tool.function.name === 'search_library'));
        // Even an out-of-schema tool call must be refused server-side.
        return { content: null, toolCalls: [{ id: 'wrong', type: 'function' as const,
          function: { name: 'search_library', arguments: '{"query":"log"}' } }], finishReason: 'tool_calls' };
      }
      if (calls === 3) {
        assert.match(JSON.stringify(messages.at(-1)), /not loaded or is unavailable/);
        return { content: null, toolCalls: [{ id: 'correct', type: 'function' as const,
          function: { name: 'search_knowledge_base', arguments: '{"query":""}' } }], finishReason: 'tool_calls' };
      }
      assert.match(JSON.stringify(messages.at(-1)), /appliedScope/);
      return { content: 'No items were returned within the Discover review scope.', toolCalls: [], finishReason: 'stop' };
    });
    try {
      await handleConversationTurn(db, [
        { role: 'user', content: 'any interesting items in the discovery log?' },
        { role: 'assistant', content: 'I read unrelated logging documents and meeting notes.' },
      ], 'shall we try that again', 'standard', 'general', sessionId, undefined, undefined, {}, { onAudit: row => { audit = row; } });
      assert.equal(calls, 4);
      assert.match(JSON.stringify(audit), /"blockedCalls":1/);
      assert.match(JSON.stringify(audit), /"families":\["discover-article"\]/);
      assert.ok(!reads.some(sql => sql.includes('FROM notes') && sql.includes('search_vector')));
    } finally {
      if (flag === undefined) delete process.env['KNOWLEDGE_ORCHESTRATION'];
      else process.env['KNOWLEDGE_ORCHESTRATION'] = flag;
      completion.mock.restore(); query.mock.restore(); await db.end();
    }
});

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

test('ordinary review and repair requests cannot be widened into whole-note rewrites', async () => {
  for (const request of ['Review and update where appropriate.', 'do it properly!!!!!', 'Fix the wording without changing formatting.', 'Rewrite this but preserve the existing formatting.']) {
    assert.equal(allowsStructuralNoteEdits(request), false, request);
  }
  assert.equal(allowsStructuralNoteEdits('Rewrite this note from scratch.'), true);
  const db = new Pool();
  const edits: NoteEditProposal[] = [];
  try {
    const result = await executeToolCall(db, 'propose_note_edit', JSON.stringify({ edits: [
      { action: 'replace_all', markdown: '# Wi-Fi\nA whole new body', summary: 'Clean up' },
    ] }), undefined, { noteId: outputId, noteEdits: edits, allowStructuralNoteEdits: false });
    assert.match(JSON.stringify(result), /not permission to rewrite or reformat/);
    assert.deepEqual(edits, []);
  } finally { await db.end(); }
  assert.ok(checkEditsAgainstNote([{ action: 'replace_text', find: 'same', markdown: 'new', summary: 'Ambiguous' }],
    [{ type: 'paragraph', content: [{ text: 'same same' }] }]).length > 0);
});

test('a repair after a formatting complaint uses exact edits instead of conversational mode or another rewrite', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string) => ({ rows: sql.includes('SELECT content FROM notes')
    ? [{ content: { contentJson: JSON.stringify([
      { type: 'heading', content: [{ text: 'Guest guide' }] },
      { type: 'paragraph', content: [{ text: 'Tunr the lights on.' }] },
    ]) } }] : [] }));
  let calls = 0;
  const completion = mock.method(FoundryClient.prototype, 'chatWithToolsStream', async (_model, _messages, _tools, _tokens, choice) => {
    calls++;
    if (calls === 1) {
      assert.equal(choice, 'auto');
      return { content: null, toolCalls: [{ id: 'load-edit', type: 'function' as const,
        function: { name: 'load_tools', arguments: '{"names":["propose_note_edit"]}' } }], finishReason: 'tool_calls' };
    }
    if (calls === 2) {
      assert.equal(choice, 'auto');
      return { content: null, toolCalls: [{ id: 'wording', type: 'function' as const, function: { name: 'propose_note_edit',
        arguments: JSON.stringify({ edits: [{ action: 'replace_text', find: 'Tunr', markdown: 'Turn', summary: 'Correct typo without changing formatting' }] }) } }],
      finishReason: 'tool_calls' };
    }
    return { content: 'Proposed the wording correction. Review and Apply it.', toolCalls: [], finishReason: 'stop' };
  });
  const noteEdits: NoteEditProposal[] = [];
  try {
    await handleConversationTurn(db, [
      { role: 'user', content: 'You changed all the formatting!' },
      { role: 'assistant', content: 'I should keep the note formatting and title. Shall I fix it?' },
    ], 'do it properly!!!!!', 'standard', 'general', sessionId,
    { type: 'note', title: 'Guest guide', detail: 'Tunr the lights on.' }, undefined,
    { noteId: outputId, noteEdits }, { onDelta: () => {}, onAudit: () => {} });
    assert.equal(noteEdits.length, 1);
    assert.equal(noteEdits[0]?.action, 'replace_text');
  } finally { completion.mock.restore(); query.mock.restore(); await db.end(); }
});

test('time limit after RTR-style edit production preserves the preview without claiming completion or requesting a retry', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async () => ({ rows: [] }));
  let now = 1_000;
  const clock = mock.method(Date, 'now', () => now);
  let calls = 0;
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools', async () => {
    if (++calls === 1) return { content: null, toolCalls: [{ id: 'load-edit', type: 'function' as const,
      function: { name: 'load_tools', arguments: '{"names":["propose_note_edit"]}' } }], finishReason: 'tool_calls' };
    now += 60_000;
    return { content: null, toolCalls: [{ id: 'edit-one', type: 'function' as const, function: { name: 'propose_note_edit',
      arguments: JSON.stringify({ editMode: 'structural', edits: [{ action: 'replace_all', markdown: '# Fixtures\nComplete synthetic dataset.', summary: 'Replace fixtures' }] }) } }],
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
    assert.equal(completion.mock.callCount(), 2);
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
  assert.deepEqual(selectKnowledgeRetrievalChoice('any thoughts on the notes from the Dhalia call?', tools),
    { type: 'function', function: { name: 'search_knowledge_base' } });
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
