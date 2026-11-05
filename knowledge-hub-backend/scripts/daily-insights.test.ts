import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { captureDailyInsights as captureReport } from '../src/services/dailyInsights.js';
import { londonTime, parseDailyInsights, type ExistingDailyTask } from '../src/services/dailyInsightsParser.js';
import { extractDailyInsights, validateDailyExtraction } from '../src/services/dailyInsightsExtraction.js';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { AiError, AiOutputLimitError, AiTimeoutError } from '../src/types/errors.js';
import { dailyInsightsStage, reviewDailyTaskDuplicates, type DailyInsightsStageStore } from '../src/services/dailyInsightsStages.js';
import { dailyInsightsStageStore } from '../src/services/dailyInsightsImport.js';

const filename = 'Daily-Briefing-2026-10-20.md';
const captureDailyInsights = (pool: Pool, name: string, text: string, path: string, modified?: string) =>
  captureReport(pool, name, text, path, modified, async (file, content) => parseDailyInsights(file, content));
const report = `# Morning briefing: Tuesday, 20 October 2026
## Part 1: Today, what to worry about
### Today's meetings
| Time | Meeting | Flag |
|---|---|---|
| 09:45–10:15 | Copilot daily | Tentative |
| 13:30–14:30 | *Free: lunch* | |
| 16:00–17:00 | IMAGINE MSFT \\| IBM | Overlap |
## Part 2: Yesterday, what I learned (Monday, 19 October)
### Decisions made
- The name is with legal, not confirmed.
### Commitments and follow-ups (for Athena)
**Task: Review the draft**
- Project: IMAGINE
- Owner: Richard Hogan
- Due: 20 Oct 2026
- Source: Email from Joel

**Task: Review the deck**
- Project: IBM / MSFT Practice
- Owner: Richard Hogan
- Due: This week (before it goes to Mohamad)
- Source: Chat with Miha
`;

test('parses explicit tasks, escaped meeting tables, dates and vague deadlines without guessing', () => {
  const parsed = parseDailyInsights(filename, report);
  assert.equal(parsed.date, '2026-10-20');
  assert.equal(parsed.knowledgeDate, '2026-10-19');
  assert.equal(parsed.meetings.length, 2);
  assert.equal(parsed.meetings[1]?.title, 'IMAGINE MSFT | IBM');
  assert.deepEqual(parsed.tasks.map(t => t.due), ['2026-10-20', null]);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(londonTime('2026-10-20', '09:45'), '2026-10-20T08:45:00.000Z');
  assert.equal(londonTime('2026-12-20', '09:45'), '2026-12-20T09:45:00.000Z');
  assert.throws(() => parseDailyInsights(filename, report.replace('19 October', '18 October')), /previous calendar day/);
  assert.throws(() => parseDailyInsights(filename, report.replace('20 October 2026', '21 October 2026')), /match its filename/);
  assert.throws(() => parseDailyInsights(filename, report.replace('09:45–10:15', '29:45–30:15')), /meeting row/);
  const others = parseDailyInsights(filename, report.replaceAll('Richard Hogan', 'Joel'));
  assert.equal(others.tasks.length, 0);
});

test('accepts generated dash headings, lettered sections and quoted shared-owner cards without weakening dates', () => {
  const revised = `# Morning briefing – Wednesday, 21 October 2026
## PART 1 – Today: what to worry about
### (b) Today's meetings
| Time (UK) | Meeting | Organiser | Flags |
|---|---|---|---|
| All day | Away in another time zone | Colleague | FYI only |
| 09:45–10:15 | Project review | Organiser | Overlap |
## PART 2 – Yesterday (Tuesday, 20 October): what I learned
### (e) Commitments and follow-ups
> **Title:** Review the project deck
> **Project:** IMAGINE · **Owner:** Richard (with Colleague) · **Due:** not stated
> **Source:** Team follow-up email

> **Title:** Prepare the demo
> **Project:** IMAGINE · **Owner:** Colleague, Richard · **Due:** This week
> **Source:** Meeting transcript

> **Title:** Someone else's commitment
> **Project:** IMAGINE · **Owner:** Colleague (you attend) · **Due:** not stated
> **Source:** Meeting transcript
`;
  const parsed = parseDailyInsights('Daily-Briefing-2026-10-21.md', revised);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0]?.project, 'IMAGINE');
  assert.equal(parsed.tasks[0]?.source, 'Team follow-up email');
  assert.equal(parsed.tasks[1]?.owner, 'Colleague, Richard');
  assert.deepEqual(parsed.meetings, [{ start: '09:45', end: '10:15', title: 'Project review', flag: 'Organiser · Overlap' }]);
  assert.ok(parsed.warnings.some(warning => warning.includes('All-day')));
  assert.ok(parsed.warnings.some(warning => warning.includes('Not assigned')));
  assert.throws(() => parseDailyInsights('Daily-Briefing-2026-10-21.md', revised.replace('Wednesday, 21 October', 'Wednesday, 22 October')), /match its filename/);
  assert.throws(() => parseDailyInsights('Daily-Briefing-2026-10-21.md', revised.replace('Tuesday, 20 October', 'Monday, 19 October')), /previous calendar day/);
  assert.throws(() => parseDailyInsights('Daily-Briefing-2026-10-21.md', revised.replace('**Owner:** Richard (with Colleague) · ', '')), /Incomplete task/);
});

test('equivalent Copilot Markdown variants retain task identities and support reordered task tables', () => {
  const expected = parseDailyInsights(filename, report);
  const variants = [
    report.replaceAll('**Task:', '**Title:**').replace(/draft\*\*|deck\*\*/g, value => value.replace('**', ''))
      .replaceAll('- Project:', '* **Project:**').replaceAll('- Owner:', '+ __Owner:__')
      .replaceAll('- Due:', 'Due:').replaceAll('- Source:', '**Source:**'),
    report.replace('### Today\'s meetings', '#### Today’s meetings')
      .replace('## Part 2', '### Part 2').replaceAll('**Task:', '1. Task:').replaceAll('**', ''),
    report.slice(0, report.indexOf('**Task:')) + `| Owner | Title | Source | Due | Project |
|---|---|---|---|---|
| Richard Hogan | Review the draft | Email from Joel | 20 Oct 2026 | IMAGINE |
| Richard Hogan | Review the deck | Chat with Miha | This week (before it goes to Mohamad) | IBM / MSFT Practice |`,
  ];
  for (const variant of variants) {
    const parsed = parseDailyInsights(filename, variant);
    assert.deepEqual(parsed.tasks, expected.tasks);
    assert.deepEqual(parsed.meetings, expected.meetings);
  }
});

async function fixture(): Promise<{ db: PGlite; pool: Pool; failKnowledge: (value: boolean) => void }> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES ('imagine','IMAGINE'),('ibm-msft-practice','IBM / MSFT Practice');
    CREATE TABLE tasks(id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,title TEXT,body TEXT,status TEXT,
      project_id TEXT REFERENCES projects(id),due_date DATE,tags TEXT[],priority TEXT,archived BOOLEAN DEFAULT false,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE content_items(id UUID DEFAULT gen_random_uuid(),source TEXT,source_id TEXT,title TEXT,
      summary TEXT,body TEXT,published_at TIMESTAMPTZ,project_context TEXT,metadata JSONB,tags TEXT[],
      foundry_indexed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now(),UNIQUE(source,source_id));
  `);
  await db.exec(readFileSync(new URL('../src/db/migrations/088_daily_insights.sql', import.meta.url), 'utf8'));
  let fail = false;
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('SELECT pg_advisory')) return { rows: [], rowCount: 1 };
      if (fail && sql.startsWith('INSERT INTO content_items') && params?.[0] === 'user-upload') throw new Error('fixture knowledge failure');
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
    release() {},
  };
  return { db, pool: { connect: async () => client } as unknown as Pool, failKnowledge: value => { fail = value; } };
}

const semanticTask = 'Richard Hogan (as reviewer) will Review the draft for IMAGINE; deadline: 20 Oct 2026; evidence: Email from Joel.';
const semanticOther = 'Colleague (Richard Hogan is informed) will Prepare the demo for IMAGINE; deadline: This week; evidence: Team email.';
const semanticKnowledge = `Yesterday, 19 October 2026: legal review continues.\n${semanticTask}\n${semanticOther}`;
const semanticReport = `Brief for 20 October 2026\nAt 09:45-10:15: Project review\n${semanticKnowledge}`;
function extraction() {
  return {
    date: '2026-10-20', knowledgeDate: '2026-10-19', dateEvidenceLines: [1], knowledgeStartLine: 3, knowledgeEndLine: 5,
    taskCount: 2, meetingCount: 1,
    tasksComplete: true, meetingsComplete: true, knowledgeComplete: true, warnings: [],
    tasks: [
      { title: 'Review the draft', project: 'IMAGINE', owner: 'Richard Hogan (as reviewer)', richardAssignee: 'Richard Hogan', confidence: 'high',
        dueText: '20 Oct 2026', source: 'Email from Joel', evidenceLines: [4], existingTaskId: null, duplicateReason: null },
      { title: 'Prepare the demo', project: 'IMAGINE', owner: 'Colleague (Richard Hogan is informed)', richardAssignee: null, confidence: 'high',
        dueText: 'This week', source: 'Team email', evidenceLines: [5], existingTaskId: null, duplicateReason: null },
    ],
    meetings: [{ title: 'Project review', start: '09:45', end: '10:15', flag: '', evidenceLines: [2] }],
  };
}

function stageResponse(messages: { content: string }[], value = extraction()): string {
  const stage = /^Stage: (\w+)/.exec(messages[0]?.content ?? '')?.[1];
  if (!stage) {
    const content = messages[1]?.content ?? '';
    const candidates = JSON.parse(content.split('Candidates:\n')[1]!.split('\nSaved task history batch:')[0]!) as Array<{ key: string }>;
    const match = value.tasks[0];
    return JSON.stringify({ decisions: candidates.map(candidate => ({ key: candidate.key, confidence: 'high',
      existingTaskId: match?.existingTaskId ?? null, duplicateReason: match?.duplicateReason ?? null })) });
  }
  return JSON.stringify({ ...value,
    tasks: stage === 'actions' ? value.tasks.map(task => ({ ...task, existingTaskId: null, duplicateReason: null })) : [],
    meetings: stage === 'diary' ? value.meetings : [],
    knowledgeStartLine: stage === 'knowledge' ? value.knowledgeStartLine : null,
    knowledgeEndLine: stage === 'knowledge' ? value.knowledgeEndLine : null });
}

test('AI extraction handles semantic prose without Markdown contracts and retains grounded identities', async context => {
  context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => {
    assert.match(messages[0]?.content ?? '', /untrusted data/);
    assert.ok(messages[1]?.content.includes(`4: ${semanticTask}`));
    return stageResponse(messages);
  });
  const parsed = await extractDailyInsights(filename, semanticReport);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0]?.key, parseDailyInsights(filename, report).tasks[0]?.key);
  assert.equal(parsed.tasks[0]?.due, '2026-10-20');
  assert.equal(parsed.meetings.length, 1);
  assert.equal(parsed.knowledge, semanticKnowledge);
  assert.match(parsed.warnings.join(), /Not assigned to Richard/);
});

test('Metis passes the complete saved task history into its cancellation-aware extraction', () => {
  const specialist = readFileSync(new URL('../src/agents/specialists/metis.ts', import.meta.url), 'utf8');
  assert.match(specialist, /async \(filename, report, _signal, existingTasks\)/);
  assert.match(specialist, /extractDailyInsights\(filename, report, context\.signal, existingTasks,/);
});

test('a timed-out stage gets one full five-minute retry with unchanged input', async context => {
  let now = 0;
  let calls = 0;
  let retries = 0;
  let original = '';
  context.mock.method(Date, 'now', () => now);
  context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: unknown, _tokens: number, timeout: number) => {
    calls++;
    assert.equal(timeout, 300_000);
    const payload = JSON.stringify(messages);
    if (calls === 1) {
      original = payload;
      now = 300_000;
      throw new AiTimeoutError('Bulk request timed out after 300000ms');
    }
    assert.equal(payload, original);
    return '{}';
  });
  await dailyInsightsStage('Briefing actions', [{ role: 'user', content: semanticReport }],
    { name: 'test', schema: { type: 'object' } }, 1000, value => value, undefined,
    message => { if (message.includes('timed out')) retries++; });
  assert.equal(calls, 2);
  assert.equal(retries, 1);
});

test('two AI timeouts fail explicitly without any partial Daily Insights writes', async context => {
  const { db, pool } = await fixture();
  let calls = 0;
  context.mock.method(FoundryClient.prototype, 'chatBulk', async () => {
    calls++;
    throw new AiTimeoutError('Bulk request timed out after 300000ms');
  });
  try {
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture'), AiTimeoutError);
    assert.equal(calls, 2);
    for (const table of ['tasks', 'content_items', 'daily_insights_reports']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0);
    }
  } finally { await db.close(); }
});

test('cancellation and non-timeout provider errors never trigger an automatic retry', async context => {
  const stopped = new Error('Specialist cancelled');
  const controller = new AbortController();
  let calls = 0;
  let retries = 0;
  const mock = context.mock.method(FoundryClient.prototype, 'chatBulk', async () => {
    calls++;
    controller.abort(stopped);
    throw new AiTimeoutError('Bulk request timed out after 300000ms');
  });
  await assert.rejects(extractDailyInsights(filename, semanticReport, controller.signal, [],
    message => { if (message.includes('timed out')) retries++; }), error => error === stopped);
  assert.equal(calls, 1);
  assert.equal(retries, 0);
  mock.mock.mockImplementation(async () => {
    calls++;
    throw new AiError('403 Forbidden');
  });
  await assert.rejects(extractDailyInsights(filename, semanticReport), /403 Forbidden/);
  assert.equal(calls, 2);
});

test('bulk transport timeouts are typed so extraction can retry without matching error text', async context => {
  context.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('Deadline reached', 'TimeoutError');
  });
  await assert.rejects(new FoundryClient('daily-insights-test').chatBulk([
    { role: 'user', content: 'fixture' },
  ], 1000, 1000), AiTimeoutError);
});

test('a failed stage preserves completed checkpoints and an explicit retry resumes without partial domain writes', async context => {
  const { db, pool } = await fixture();
  const saved = new Map<string, unknown>();
  const store: DailyInsightsStageStore = {
    read: async key => saved.get(key),
    write: async (key, value) => { saved.set(key, value); },
  };
  const calls: string[] = [];
  let failDiary = true;
  context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => {
    const stage = /^Stage: (\w+)/.exec(messages[0]?.content ?? '')?.[1] ?? 'duplicates';
    calls.push(stage);
    if (stage === 'diary' && failDiary) throw new AiTimeoutError('Bulk request timed out after 300000ms');
    return stageResponse(messages);
  });
  const extract = (file: string, text: string, signal?: AbortSignal, history: readonly ExistingDailyTask[] = []) =>
    extractDailyInsights(file, text, signal, history, undefined, store);
  try {
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture', undefined, extract), AiTimeoutError);
    assert.equal(saved.size, 1);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM content_items')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM daily_insights_reports')).rows.length, 0);
    failDiary = false;
    const result = await captureReport(pool, filename, semanticReport, 'fixture', undefined, extract);
    assert.equal(result.tasksCreated, 1);
    assert.deepEqual(calls, ['actions', 'diary', 'diary', 'diary', 'knowledge']);
    assert.equal(saved.size, 3);
    const changed = `${semanticReport}\nUpdated context.`;
    await extractDailyInsights(filename, changed, undefined, [], undefined, store);
    assert.equal(calls.filter(stage => stage === 'actions').length, 2);
  } finally { await db.close(); }
});

test('bounded duplicate stages review every character of long saved bodies and retain completed comparisons on retry', async context => {
  const tasks = validateDailyExtraction(filename, semanticReport, extraction()).tasks;
  const body = 'Saved task context. '.repeat(1800);
  const history = [{ id: 'older', title: 'Other work', body, status: 'completed',
    archived: true, project_id: null, due_date: null }];
  const saved = new Map<string, unknown>();
  const store: DailyInsightsStageStore = { read: async key => saved.get(key),
    write: async (key, value) => { saved.set(key, value); } };
  let failSecond = true;
  const seenBodies: string[] = [];
  context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => {
    const batch = JSON.parse(messages[1]!.content.split('\nSaved task history batch:\n')[1]!) as typeof history;
    assert.ok(JSON.stringify(batch).length <= 16_000);
    assert.equal(batch[0]?.archived, true);
    assert.equal(batch[0]?.status, 'completed');
    if (messages[0] && seenBodies.length === 1 && failSecond) {
      throw new AiTimeoutError('Bulk request timed out after 300000ms');
    }
    seenBodies.push(batch.map(task => task.body).join(''));
    return stageResponse(messages);
  });
  await assert.rejects(reviewDailyTaskDuplicates(tasks, history, undefined, undefined, store), AiTimeoutError);
  assert.equal(saved.size, 1);
  failSecond = false;
  const result = await reviewDailyTaskDuplicates(tasks, history, undefined, undefined, store);
  assert.equal(result.tasks.length, 1);
  assert.equal(seenBodies.join(''), body);
});

test('stage checkpoints persist in the retained import and disappear only when that import is removed', async () => {
  const db = new PGlite();
  try {
    await db.exec(readFileSync(new URL('../src/db/migrations/139_daily_insights_import_staging.sql', import.meta.url), 'utf8'));
    const migration = readFileSync(new URL('../src/db/migrations/144_daily_insights_stage_checkpoints.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const row = (await db.query<{ id: string }>(`INSERT INTO daily_insights_import_staging
      (report_date,content_hash,filename,source_path,report_text,source_modified_at)
      VALUES ('2026-10-20','fixture','Daily-Briefing-2026-10-20.md','fixture','source',NOW()) RETURNING id`)).rows[0]!;
    const pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as Pool;
    const store = dailyInsightsStageStore(pool, row.id);
    assert.equal(await store.read('first'), undefined);
    await store.write('first', { tasks: ['completed'] });
    await store.write('second', { meetings: ['completed'] });
    assert.deepEqual(await dailyInsightsStageStore(pool, row.id).read('first'), { tasks: ['completed'] });
    assert.deepEqual(await store.read('second'), { meetings: ['completed'] });
    await db.query('DELETE FROM daily_insights_import_staging WHERE id=$1', [row.id]);
    await assert.rejects(store.read('first'), /not found/);
  } finally { await db.close(); }
});

test('invalid source references request one AI correction before saving', async context => {
  const { db, pool } = await fixture();
  let extractions = 0;
  context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => {
    extractions++;
    if (extractions === 1) return stageResponse(messages, { ...extraction(), tasks: [{ ...extraction().tasks[0]!, evidenceLines: [999] }] });
    if (extractions === 2) assert.match(messages.at(-1)?.content ?? '', /invalid source line/);
    return stageResponse(messages);
  });
  try {
    const result = await captureReport(pool, filename, semanticReport, 'fixture');
    assert.equal(result.tasksCreated, 1);
    assert.equal(extractions, 4);
  } finally { await db.close(); }
});

test('unresolved invalid output never reconciles calendar or writes a receipt', async context => {
  const { db, pool } = await fixture();
  context.mock.method(FoundryClient.prototype, 'chatBulk', async () => JSON.stringify({ ...extraction(), meetings: 'invalid' }));
  try {
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture'), /invalid list/);
    assert.equal((await db.query('SELECT * FROM content_items')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM daily_insights_reports')).rows.length, 0);
  } finally { await db.close(); }
});

test('rejects malformed, invalid-date and invalid-clock output before any writes', () => {
  for (const change of [
    { date: '2026-10-21' }, { knowledgeDate: '2026-10-18' },
    { knowledgeEndLine: 999 }, { knowledgeStartLine: 0 }, { tasks: 'not an array' },
    { tasks: [{ ...extraction().tasks[0], title: '' }] },
    { taskCount: 1, tasks: [{ ...extraction().tasks[0], richardAssignee: 'Joel' }] },
    { taskCount: 1, tasks: [{ ...extraction().tasks[0], confidence: 'low' }] },
    { taskCount: 1, tasks: [{ ...extraction().tasks[0], evidenceLines: [999] }] },
    { meetings: [{ ...extraction().meetings[0], start: '29:45' }] },
    { meetings: [{ ...extraction().meetings[0], start: '10:15', end: '09:45' }] },
  ]) assert.throws(() => validateDailyExtraction(filename, semanticReport, { ...extraction(), ...change }));
  assert.throws(() => validateDailyExtraction('Daily-Briefing-2026-02-30.md', semanticReport, extraction()), /valid date/);
  const vague = semanticReport.replaceAll('20 Oct 2026', 'This week');
  const output = extraction();
  output.tasks[0]!.dueText = 'This week';
  const parsed = validateDailyExtraction(filename, vague, output);
  assert.equal(parsed.tasks[0]?.due, null);
  assert.match(parsed.warnings.join(), /Deadline needs review/);
});

test('imports only high-confidence Richard actions, collapses exact duplicates, and warns about ambiguous candidates', () => {
  const task = extraction().tasks[0]!;
  const parsed = validateDailyExtraction(filename, semanticReport, {
    ...extraction(),
    tasks: [
      task,
      { ...task },
      { ...task, title: 'Maybe confirm the project review', confidence: 'ambiguous', evidenceLines: [2] },
    ],
  });
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0]?.title, 'Review the draft');
  assert.ok(parsed.warnings.some(warning => warning.includes('ambiguous: Maybe confirm the project review')));
});

test('shared-time children cite parent and child source lines without manufacturing evidence', () => {
  const grouped = `Brief for 20 October 2026
At 16:00-16:30, clash:
  - First meeting
  - Second meeting
${semanticKnowledge}`;
  const output = extraction();
  output.knowledgeStartLine = 5;
  output.knowledgeEndLine = 7;
  output.tasks[0]!.evidenceLines = [6];
  output.tasks[1]!.evidenceLines = [7];
  output.meetingCount = 2;
  output.meetings = [
    { title: 'First meeting', start: '16:00', end: '16:30', flag: 'Clash', evidenceLines: [2, 3] },
    { title: 'Second meeting', start: '16:00', end: '16:30', flag: 'Clash', evidenceLines: [2, 4] },
  ];
  assert.deepEqual(validateDailyExtraction(filename, grouped, output).meetings.map(meeting => meeting.title), ['First meeting', 'Second meeting']);
  output.meetings.push({ ...output.meetings[0]! });
  assert.equal(validateDailyExtraction(filename, grouped, output).meetings.length, 3);
});

test('missing metadata, learning sections and legacy summary counts do not gate understanding', () => {
  const parsed = validateDailyExtraction(filename, semanticReport, {
    ...extraction(), taskCount: 999, meetingCount: 0,
    tasksComplete: false, meetingsComplete: false, knowledgeComplete: false,
    knowledgeStartLine: null, knowledgeEndLine: null, dateEvidenceLines: [],
    tasks: [{ ...extraction().tasks[0], title: 'Review the draft for the project',
      project: null, dueText: null, source: null }],
    meetings: [{ ...extraction().meetings[0], flag: null },
      { title: 'All-day commitment', start: null, end: null, flag: null, evidenceLines: [2] }],
  });
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0]?.project, '');
  assert.equal(parsed.tasks[0]?.due, null);
  assert.equal(parsed.meetings.length, 1);
  assert.equal(parsed.knowledge, semanticReport);
  assert.ok(parsed.warnings.some(warning => warning.includes('All-day commitment')));
});

test('separate identical diary occurrences remain separate in storage and on reread', async () => {
  const { db, pool } = await fixture();
  const understand = async () => {
    const result = validateDailyExtraction(filename, semanticReport, extraction());
    result.meetings.push({ ...result.meetings[0]! });
    return result;
  };
  try {
    const result = await captureReport(pool, filename, semanticReport, 'fixture', undefined, understand);
    assert.equal(result.meetings, 2);
    assert.equal((await db.query("SELECT * FROM content_items WHERE source='graph-calendar'")).rows.length, 2);
    const reread = await captureReport(pool, filename, semanticReport, 'fixture', undefined, understand);
    assert.equal(reread.unchanged, true);
    assert.equal((await db.query("SELECT * FROM content_items WHERE source='graph-calendar'")).rows.length, 2);
  } finally { await db.close(); }
});

test('bulk client requests strict JSON and rejects truncated responses even if their JSON parses', async context => {
  let truncated = false;
  const schema = { name: 'fixture', schema: { type: 'object', properties: {}, additionalProperties: false } };
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { ...schema, strict: true } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: truncated ? 'length' : 'stop' }] }));
  });
  const client = new FoundryClient('daily-insights-test');
  const messages = [{ role: 'user' as const, content: 'fixture' }];
  assert.equal(await client.chatBulk(messages, 1000, 1000, 'low', schema), '{}');
  truncated = true;
  await assert.rejects(client.chatBulk(messages, 1000, 1000, 'low', schema), AiOutputLimitError);
});

test('provider and malformed-output failures leave no receipt or partial tasks', async context => {
  const { db, pool } = await fixture();
  try {
    const mock = context.mock.method(FoundryClient.prototype, 'chatBulk', async () => '{truncated');
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture'), /invalid or truncated JSON/);
    mock.mock.mockImplementation(async () => { throw new Error('provider unavailable'); });
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture'), /provider unavailable/);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM daily_insights_reports')).rows.length, 0);
  } finally { await db.close(); }
});

test('simultaneous and unchanged desktop captures share one extraction; stale reports skip AI', async () => {
  const { db, pool } = await fixture();
  let calls = 0;
  const extract = async (file: string, text: string) => { calls++; return validateDailyExtraction(file, text, extraction()); };
  try {
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      captureReport(pool, filename, semanticReport, 'fixture', '2026-10-20T09:00:00Z', extract)));
    assert.equal(calls, 1);
    assert.equal(results[0]?.tasksCreated, 1);
    await captureReport(pool, filename, semanticReport, 'fixture', '2026-10-20T10:00:00Z', extract);
    await captureReport(pool, filename, `${semanticReport}\nold content`, 'fixture', '2026-10-20T09:30:00Z', extract);
    assert.equal(calls, 1);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 1);
  } finally { await db.close(); }
});

test('atomic capture retries, corrections, next-day dedupe, completed/edited/deleted task preservation', async () => {
  const { db, pool, failKnowledge } = await fixture();
  try {
    failKnowledge(true);
    await assert.rejects(captureDailyInsights(pool, filename, report, 'fixture'), /knowledge failure/);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM daily_insights_reports')).rows.length, 0);
    failKnowledge(false);
    const first = await captureDailyInsights(pool, filename, report, 'fixture');
    assert.equal(first.tasksCreated, 2);
    assert.equal((await captureDailyInsights(pool, filename, report, 'fixture')).unchanged, true);
    const corrected = report.replace('20 Oct 2026', '22 Oct 2026').replace('09:45–10:15', '10:00–10:30');
    assert.equal((await captureDailyInsights(pool, filename, corrected, 'fixture')).tasksUpdated, 2);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 2);
    assert.equal((await db.query("SELECT * FROM content_items WHERE source='graph-calendar'")).rows.length, 2);
    const knowledge = await db.query<{ day: string; body: string }>("SELECT to_char(published_at,'YYYY-MM-DD') AS day,body FROM content_items WHERE source='user-upload'");
    assert.equal(knowledge.rows[0]?.day, '2026-10-19');
    assert.match(knowledge.rows[0]?.body ?? '', /name is with legal/);
    await db.exec("UPDATE tasks SET status='completed' WHERE title='Review the draft'; UPDATE tasks SET title='My edited deck task',priority='urgent' WHERE title='Review the deck'");
    const next = report.replace('Tuesday, 20 October 2026', 'Wednesday, 21 October 2026').replace('Monday, 19 October', 'Tuesday, 20 October');
    const second = await captureDailyInsights(pool, 'Daily-Briefing-2026-10-21.md', next, 'fixture');
    assert.equal(second.tasksCreated, 0);
    assert.equal(second.tasksPreserved, 2);
    assert.equal((await db.query("SELECT * FROM tasks WHERE title='My edited deck task' AND priority='urgent'")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM tasks WHERE status='completed'")).rows.length, 1);
    await db.exec("DELETE FROM tasks WHERE title='My edited deck task'");
    await captureDailyInsights(pool, 'Daily-Briefing-2026-10-21.md', `${next}\nCorrection`, 'fixture');
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 1);
  } finally { await db.close(); }
});

test('matches existing manual task regardless of punctuation and does not overwrite it', async () => {
  const { db, pool } = await fixture();
  try {
    await db.exec("INSERT INTO tasks(title,body,status,priority) VALUES ('Review the draft!','Manual content','completed','high')");
    const result = await captureDailyInsights(pool, filename, report, 'fixture');
    assert.equal(result.tasksCreated, 1);
    assert.equal(result.tasksPreserved, 1);
    assert.equal((await db.query("SELECT * FROM tasks WHERE body='Manual content' AND status='completed'")).rows.length, 1);
  } finally { await db.close(); }
});

test('semantic duplicate review includes every column, completed work and rejected or archived tasks without changing originals', async context => {
  const states = ['inbox', 'backlog', 'in-progress', 'waiting', 'completed'];
  for (const status of states) {
    for (const archived of [false, true]) {
      const { db, pool } = await fixture();
      const id = 'existing-action';
      try {
        await db.query(`INSERT INTO tasks(id,title,body,status,archived,project_id,priority)
          VALUES ($1,'Read Joel proposal and return review comments','Email from Joel: draft review',$2,$3,'ibm-msft-practice','high')`,
        [id, status, archived]);
        const before = (await db.query('SELECT * FROM tasks')).rows;
        const mock = context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => {
          const prompt = messages.map(message => message.content).join('\n');
          if (prompt.startsWith('Stage:')) return stageResponse(messages);
          assert.ok(prompt.includes(JSON.stringify(status)));
          assert.ok(prompt.includes(`"archived":${archived}`));
          assert.match(prompt, /Email from Joel: draft review/);
          assert.match(prompt, /ALL columns\/statuses/);
          assert.match(prompt, /genuinely different follow-up/);
          return stageResponse(messages, { ...extraction(), tasks: [{
            ...extraction().tasks[0]!, existingTaskId: id,
            duplicateReason: 'Same review of the draft requested by Joel; only the title and project label changed.',
          }] });
        });
        const result = await captureReport(pool, filename, semanticReport, 'fixture');
        assert.equal(result.tasksCreated, 0, `${status}, archived=${archived}`);
        assert.equal(result.tasksPreserved, 1);
        assert.deepEqual((await db.query('SELECT * FROM tasks')).rows, before);
        const tracked = await db.query<{ task_id: string; snapshot: unknown; source_detail: { duplicateReason: string } }>(
          'SELECT task_id,snapshot,source_detail FROM daily_insights_tasks');
        assert.equal(tracked.rows[0]?.task_id, id);
        assert.equal(tracked.rows[0]?.snapshot, null);
        assert.match(tracked.rows[0]?.source_detail.duplicateReason ?? '', /Same review/);
        mock.mock.restore();
      } finally { await db.close(); }
    }
  }
});

test('duplicate review retains genuinely different follow-up actions on the same topic', async context => {
  const { db, pool } = await fixture();
  try {
    await db.exec(`INSERT INTO tasks(id,title,body,status,archived)
      VALUES ('prior','Send Joel the draft','Email from Joel','completed',true)`);
    context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => stageResponse(messages));
    const result = await captureReport(pool, filename, semanticReport, 'fixture');
    assert.equal(result.tasksCreated, 1);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 2);
    assert.equal((await db.query("SELECT status FROM tasks WHERE id='prior'")).rows[0]?.['status'], 'completed');
  } finally { await db.close(); }
});

test('unknown semantic matches fail explicitly and never suppress or create work', async context => {
  const { db, pool } = await fixture();
  context.mock.method(FoundryClient.prototype, 'chatBulk', async (messages: { content: string }[]) => stageResponse(messages, {
    ...extraction(), tasks: [{ ...extraction().tasks[0]!, existingTaskId: 'invented-id', duplicateReason: 'Unverified match' }],
  }));
  try {
    await db.exec("INSERT INTO tasks(id,title,status) VALUES ('prior','A saved action','completed')");
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture'), /unknown saved task/);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM daily_insights_reports')).rows.length, 0);
  } finally { await db.close(); }
});

test('task changes while AI reads history abort capture rather than using a stale duplicate review', async () => {
  const { db, pool } = await fixture();
  try {
    const extract = async (file: string, text: string) => {
      await db.exec("INSERT INTO tasks(title,status) VALUES ('Review the draft','waiting')");
      return validateDailyExtraction(file, text, extraction());
    };
    await assert.rejects(captureReport(pool, filename, semanticReport, 'fixture', undefined, extract), /Task history changed/);
    assert.equal((await db.query('SELECT * FROM tasks')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM daily_insights_reports')).rows.length, 0);
  } finally { await db.close(); }
});

test('duplicate history is never silently truncated when the combined context exceeds its budget', async () => {
  await assert.rejects(extractDailyInsights(filename, semanticReport, undefined, [{
    id: 'large-task', title: 'Existing task', body: 'x'.repeat(400_000), status: 'completed',
    archived: true, project_id: null, due_date: null,
  }]), /complete task history exceed/);
});

test('keeps manual calendar imports and only reconciles its own day on correction', async () => {
  const { db, pool } = await fixture();
  try {
    await db.exec(`INSERT INTO content_items(source,source_id,title,published_at)
      VALUES ('graph-calendar','ibm-paste-2026-10-20-0945-copilot-daily','Copilot daily','2026-10-20T08:45:00Z')`);
    await captureDailyInsights(pool, filename, report, 'fixture');
    assert.equal((await db.query("SELECT * FROM content_items WHERE source='graph-calendar'")).rows.length, 2);
    const correction = report.replace('| 16:00–17:00 | IMAGINE MSFT \\| IBM | Overlap |\n', '');
    await captureDailyInsights(pool, filename, correction, 'fixture');
    const calendar = await db.query<{ source_id: string }>("SELECT source_id FROM content_items WHERE source='graph-calendar'");
    assert.deepEqual(calendar.rows.map(r => r.source_id), ['ibm-paste-2026-10-20-0945-copilot-daily']);
  } finally { await db.close(); }
});

test('a delayed old desktop request cannot replace a newer correction', async () => {
  const { db, pool } = await fixture();
  try {
    await captureDailyInsights(pool, filename, report, 'fixture', '2026-10-20T08:00:00Z');
    const correction = report.replace('20 Oct 2026', '22 Oct 2026');
    await captureDailyInsights(pool, filename, correction, 'fixture', '2026-10-20T09:00:00Z');
    const delayed = await captureDailyInsights(pool, filename, report, 'fixture', '2026-10-20T08:00:00Z');
    assert.equal(delayed.unchanged, true);
    const task = await db.query<{ due: string }>("SELECT to_char(due_date,'YYYY-MM-DD') AS due FROM tasks WHERE title='Review the draft'");
    assert.equal(task.rows[0]?.due, '2026-10-22');
  } finally { await db.close(); }
});
