import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { captureDailyInsights } from '../src/services/dailyInsights.js';
import { londonTime, parseDailyInsights } from '../src/services/dailyInsightsParser.js';

const filename = 'Daily-Briefing-2026-10-20.md';
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
