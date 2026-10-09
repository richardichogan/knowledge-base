import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { loadCurrentProjectContext, formatCurrentProjectContext, type CurrentProjectContext } from '../src/ai/projectContext.js';
import { buildAiContext, assembleMessages } from '../src/ai/contextBuilder.js';
import { executeToolCall } from '../src/ai/chatTools.js';
import { describeToolActivity } from '../src/ai/turnActivity.js';
import { retrieveRagItems } from '../src/ai/ragRetriever.js';

const output = 'A full output description with acceptance criteria. '.repeat(70);
const project: CurrentProjectContext = {
  id: 'imagine', name: 'IMAGINE', description: 'Updated description',
  goal: 'Updated goal', role: 'Chief architect', ownership: 'Joint IBM/Microsoft',
  lifecycleState: 'active', startDate: '2026-10-01', targetEndDate: '2026-12-31',
  importance: 'critical', priority: 'high', category: 'work', projectType: 'formal-client',
  expectedOutputs: [output, 'Second output'], links: [{ label: 'Reference', url: 'https://example.com' }],
  gitlabPaths: ['team/imagine'], githubRepos: ['team/imagine'], tags: ['Insurance'],
  hasIcaDocumentCollection: true, icaDocumentCollectionName: 'IMAGINE documents', icaDocumentCollectionId: 'collection-1',
};

test('actual per-turn context contains all saved project metadata and reflects edits in the same session', async () => {
  const db = new Pool();
  let saved = project;
  const sqls: string[] = [];
  mock.method(db, 'query', async (sql: string, values?: unknown[]) => {
    sqls.push(sql);
    if (sql.includes('SELECT project_id FROM ai_chat_sessions')) return { rows: [{ project_id: project.id }] };
    if (sql.includes('FROM projects WHERE id')) {
      assert.deepEqual(values, [project.id]);
      return { rows: [saved] };
    }
    if (sql.includes("kind = 'profile'")) return { rows: [{ content: 'User profile', status: 'active' }] };
    return { rows: [] };
  });
  const first = await buildAiContext(db, 'hello', [], 'same-session', 'general');
  for (const value of [project.goal, project.role, project.ownership, project.startDate!, project.targetEndDate!, output,
    project.lifecycleState, project.importance, project.icaDocumentCollectionName, project.githubRepos[0]!]) {
    assert.ok(first.projectContext.includes(value), value);
  }
  assert.deepEqual(first.projectReferences, project.links);
  assert.match(first.projectContext, /focus, not a knowledge boundary/);
  assert.match(first.projectContext, /ANY project without asking permission/);
  assert.ok(!first.projectContext.includes('hard restriction'));
  const prompt = await assembleMessages(first, [], 'What are the expected outputs?', 'general');
  assert.equal(prompt[0]?.role, 'system');
  assert.ok(prompt[0]?.content.includes(output));
  assert.ok(prompt[0]?.content.includes(project.goal));
  saved = { ...project, goal: 'Changed again after first turn', expectedOutputs: ['New output after project save'] };
  const next = await buildAiContext(db, 'hello', [], 'same-session', 'general');
  assert.ok(next.projectContext.includes(saved.goal));
  assert.ok(next.projectContext.includes(saved.expectedOutputs[0]!));
  assert.ok(!next.projectContext.includes(output));
  assert.equal(sqls.filter((sql) => sql.includes('FROM projects WHERE id')).length, 2);
  assert.ok(sqls.some((sql) => sql.includes("to_char(start_date, 'YYYY-MM-DD')")));
});

test('unassigned chat can discover saved project IDs and look up full current metadata', async () => {
  const db = new Pool();
  mock.method(db, 'query', async (sql: string) => {
    if (sql.includes('FROM projects ORDER BY name')) return { rows: [{ id: project.id, name: project.name }] };
    if (sql.includes('FROM projects WHERE id')) return { rows: [project] };
    if (sql.includes("kind = 'profile'")) return { rows: [{ content: 'User profile', status: 'active' }] };
    return { rows: [] };
  });
  const context = await buildAiContext(db, 'hello', [], 'unassigned', 'general');
  assert.ok(context.projectContext.includes('IMAGINE (id: imagine)'));
  assert.ok(context.projectContext.includes('get_project_details'));
  const result = await executeToolCall(db, 'get_project_details', '{"projectId":"imagine"}');
  assert.deepEqual(result, {
    project, note: 'Current saved Projects record, read now. Takes precedence over older chat history and memories.',
  });
});

test('project lookup honours another requested project and defaults only when omitted', async () => {
  const db = new Pool();
  const requested: unknown[] = [];
  mock.method(db, 'query', async (_sql: string, values: unknown[]) => {
    requested.push(values[0]);
    return { rows: [] };
  });
  assert.deepEqual(await executeToolCall(db, 'get_project_details', '{"projectId":"other"}', project.id), {
    error: 'Project "other" was not found.',
  });
  assert.deepEqual(await executeToolCall(db, 'get_project_details', '{}', project.id), {
    error: 'Project "imagine" was not found.',
  });
  assert.deepEqual(requested, ['other', 'imagine']);
  assert.deepEqual(await executeToolCall(db, 'get_project_details', '{}'), {
    error: 'Provide a saved project ID from the projects catalog.',
  });
  assert.equal(describeToolActivity('get_project_details', '{}'), 'Reading current project details');
});

test('assigned client can discover the saved catalog and search knowledge, Library and auto-RAG across projects', async () => {
  const db = new Pool();
  const reads: Array<{ sql: string; values: unknown[] }> = [];
  mock.method(db, 'query', async (sql: string, values: unknown[] = []) => {
    reads.push({ sql, values });
    if (sql.includes('SELECT project_id FROM ai_chat_sessions')) return { rows: [{ project_id: project.id }] };
    if (sql.includes('FROM projects WHERE id')) return { rows: [project] };
    if (sql.includes('FROM projects ORDER BY name')) return { rows: [{ id: 'azure', name: 'Azure' }] };
    if (sql.includes("kind = 'profile'")) return { rows: [{ content: 'User profile', status: 'active' }] };
    return { rows: [], rowCount: 1 };
  });
  const context = await buildAiContext(db, 'hello', [], 'client-session', 'general');
  assert.match(context.projectContext, /Azure \(id: azure\)/);
  for (const tool of ['search_knowledge_base', 'search_library']) {
    reads.length = 0;
    await executeToolCall(db, tool, '{"query":"Azure Copilot architecture"}', 'ikea');
    const contentReads = reads.filter(r => r.sql.includes('FROM content_items'));
    assert.ok(contentReads.length > 0);
    assert.ok(contentReads.every(r => !r.values.includes('ikea')));
    reads.length = 0;
    await executeToolCall(db, tool, '{"query":"architecture","projectId":"imagine"}', 'ikea');
    assert.ok(reads.some(r => r.values.includes('imagine')));
    assert.ok(reads.every(r => !r.values.includes('ikea')));
  }
  reads.length = 0;
  await retrieveRagItems(db, 'Azure Copilot architecture', 'ikea');
  assert.ok(reads.some(r => r.sql.includes('FROM content_items')));
  assert.ok(reads.every(r => !r.values.includes('ikea')));
  reads.length = 0;
  await executeToolCall(db, 'list_tasks', '{}', 'ikea');
  assert.ok(reads.some(r => r.values.includes('ikea')));
  reads.length = 0;
  await executeToolCall(db, 'list_tasks', '{"projectId":""}', 'ikea');
  assert.ok(reads.every(r => !r.values.includes('ikea')));
});

test('legacy JSON arrays normalize without hiding database failures or truncating outputs', async () => {
  const db = new Pool();
  mock.method(db, 'query', async () => ({ rows: [{ ...project, links: {}, expectedOutputs: {} }] }));
  const result = await loadCurrentProjectContext(db, project.id);
  assert.ok(result);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.expectedOutputs, []);
  assert.ok(formatCurrentProjectContext(project).includes(output));
  mock.method(db, 'query', async () => { throw new Error('database unavailable'); });
  await assert.rejects(loadCurrentProjectContext(db, project.id), /database unavailable/);
});
