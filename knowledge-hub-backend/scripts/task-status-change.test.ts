import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { STATUS_NOTE_LIMIT } from '../src/work/taskStatusChange.js';

test('STATUS-NOTE-01: normal task patches and email waiting changes use the same transaction-bound note guard', async () => {
  const tasks = await readFile(new URL('../src/routes/tasks.ts', import.meta.url), 'utf8');
  const work = await readFile(new URL('../src/work/workContent.ts', import.meta.url), 'utf8');
  const guard = await readFile(new URL('../src/work/taskStatusChange.ts', import.meta.url), 'utf8');
  assert.match(tasks, /await recordTaskStatusChange\(db, String\(id\), previousStatus, status, input\)/);
  assert.match(work, /await recordTaskStatusChange\(client, email\.task_id, previous\.status, 'waiting', input\)/);
  assert.match(guard, /input\.expectedStatus !== previousStatus/);
  assert.match(guard, /!input\.statusChangeNote\.trim\(\)/);
  assert.match(guard, /INSERT INTO task_notes/);
  assert.equal(STATUS_NOTE_LIMIT, 3000);
});

test('STATUS-NOTE-02: Athena proposes status changes without executing them before user review', async () => {
  const tools = await readFile(new URL('../src/ai/chatTools.ts', import.meta.url), 'utf8');
  const view = await readFile(new URL('../../knowledge-hub-web/src/pages/TasksPage.tsx', import.meta.url), 'utf8');
  assert.match(tools, /statusChanged: false/);
  assert.match(tools, /statusChanges\.push/);
  assert.doesNotMatch(view, /\{ \.\.\.task, status, updatedAt: new Date/);
});
