import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { changesSince, getProjectChanges, prepareMeeting } from '../src/projects/workContext.js';
import { queryTimeline } from '../src/db/queries.js';

const NOW = new Date('2026-10-28T20:00:00Z');
const EVENT = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const pool = (db: PGlite): Pool => db as unknown as Pool;
async function fixture(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, goal TEXT, lifecycle_state TEXT, expected_outputs TEXT[], target_end_date DATE);
    INSERT INTO projects VALUES('p1','Project One','Ship safely','active','{}',NULL),('p2','Other project','Private','active','{}',NULL);
    CREATE TABLE notes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content TEXT, project_id TEXT, status TEXT, updated_at TIMESTAMPTZ);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, project_id TEXT, status TEXT, due_date DATE, updated_at TIMESTAMPTZ);
    CREATE TABLE ai_chat_sessions(id UUID PRIMARY KEY, project_id TEXT);
    CREATE TABLE chat_decisions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), text TEXT, status TEXT, session_id UUID, updated_at TIMESTAMPTZ);
    CREATE TABLE chat_outputs(id UUID, title TEXT, kind TEXT, session_id UUID, updated_at TIMESTAMPTZ);
    CREATE TABLE chat_output_versions(output_id UUID, version INT);
    CREATE TABLE project_register_items(id UUID DEFAULT gen_random_uuid(), project_id TEXT, kind TEXT, title TEXT, detail TEXT DEFAULT '',
      status TEXT, resolution TEXT DEFAULT '', owner TEXT DEFAULT '', due_date DATE, task_id TEXT, source_type TEXT DEFAULT 'manual',
      source_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ);
    CREATE TABLE content_items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source TEXT, source_id TEXT, title TEXT, summary TEXT DEFAULT '',
      body TEXT DEFAULT '', published_at TIMESTAMPTZ, indexed_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      project_context TEXT, metadata JSONB DEFAULT '{}', tags TEXT[] DEFAULT '{}', url TEXT);
    CREATE TABLE content_item_tags(content_item_id UUID, tag_id TEXT);
    CREATE TABLE note_github_publications(repo TEXT, path TEXT);
    INSERT INTO tasks VALUES('t1','Current task','p1','in-progress',NULL,'2026-10-28T18:00Z'),
      ('t2','Another project','p2','in-progress',NULL,'2026-10-28T19:00Z'),
      ('t3','Old task','p1','completed',NULL,'2026-10-01T10:00Z');
    INSERT INTO ai_chat_sessions VALUES('${SESSION}','p1');
    INSERT INTO chat_decisions(text,status,session_id,updated_at) VALUES('Use manual approval','open','${SESSION}','2026-10-28T17:00Z');
    INSERT INTO project_register_items(project_id,kind,title,status,updated_at) VALUES('p1','risk','Approval needs an owner','open','2026-10-28T16:00Z');
    INSERT INTO content_items(id,source,source_id,title,body,published_at,project_context,metadata) VALUES
      ('${EVENT}','graph-calendar','event-one','Design review','Discuss the proposal','2026-10-29T10:00Z','personal','{"attendees":["Richard"],"isCancelled":false}'),
      (gen_random_uuid(),'github-pr','pr-1','Updated PR','','2026-10-01T10:00Z','p1','{"updatedAt":"2026-10-28T15:00:00Z"}'),
      (gen_random_uuid(),'github-pr','pr-2','Reindex only','','2026-10-01T10:00Z','p1','{}'),
      (gen_random_uuid(),'github-pr','pr-3','Other project PR','','2026-10-28T15:00Z','p2','{}');
  `);
  const content = JSON.stringify({ title: 'Current spec', contentType: 'spec',
    contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'Every payment needs approval.' }], children: [] }]) });
  await db.query(`INSERT INTO notes(content,project_id,status,updated_at) VALUES($1,'p1','active','2026-10-28T14:00Z'),($1,'p2','active','2026-10-28T19:00Z')`, [content]);
  return db;
}

test('project changes use linked scope and source activity, never indexing time', async () => {
  const db = await fixture();
  try {
    const report = await getProjectChanges(pool(db), 'p1', '2026-10-28T00:00:00Z', NOW);
    assert.deepEqual(report.items.map(item => item.title), ['Current task', 'Use manual approval', 'Approval needs an owner', 'Updated PR', 'Current spec']);
    assert.equal(report.truncated, false);
    assert.ok(report.items.every(item => !item.title.includes('Other') && !item.title.includes('Reindex')));
    assert.ok(report.items.find(item => item.kind === 'note')?.href.startsWith('/think?noteId='));
    await assert.rejects(getProjectChanges(pool(db), 'missing', report.since, NOW), /not found/);
    await db.exec(`INSERT INTO tasks SELECT 'bulk-'||n,'Bulk task','p1','backlog',NULL,'2026-10-28T19:00Z' FROM generate_series(1,35) n`);
    const bounded = await getProjectChanges(pool(db), 'p1', report.since, NOW);
    assert.equal(bounded.items.length, 30);
    assert.equal(bounded.truncated, true);
  } finally { await db.close(); }
});

test('meeting preparation is manual, explicit-project and read-only with evidence', async () => {
  const db = await fixture();
  try {
    const invitation = await prepareMeeting(pool(db), EVENT, undefined, NOW);
    assert.equal(invitation.projectId, null);
    assert.equal(invitation.cockpit, null);
    assert.equal(invitation.notes.length, 0);
    assert.ok(invitation.limitations.some(item => item.includes('No project selected')));
    const brief = await prepareMeeting(pool(db), EVENT, 'p1', NOW);
    assert.equal(brief.notes.length, 1);
    assert.equal(brief.notes[0]?.text, 'Every payment needs approval.');
    assert.equal(brief.register[0]?.title, 'Approval needs an owner');
    assert.equal(brief.cockpit?.commitments.available, true);
    assert.ok(!JSON.stringify(brief).includes('Another project'));
    assert.equal((await db.query<{ n: number }>('SELECT COUNT(*)::int n FROM notes')).rows[0]?.n, 2);
    await assert.rejects(prepareMeeting(pool(db), 'invalid'), /valid calendar/);
    await assert.rejects(prepareMeeting(pool(db), EVENT, 'missing'), /not found/);
  } finally { await db.close(); }
});

test('upcoming calendar selects nearest first without changing the default timeline order', async () => {
  const db = await fixture();
  try {
    await db.exec(`INSERT INTO content_items(source,source_id,title,published_at,project_context) VALUES
      ('graph-calendar','near','Near','2026-10-29T09:00Z','personal'),
      ('graph-calendar','far','Far','2026-10-30T09:00Z','personal')`);
    const options = { source: 'graph-calendar', pageSize: 1, rangeStart: '2026-10-28T00:00Z', rangeEnd: '2026-11-01T00:00Z' };
    assert.equal((await queryTimeline(pool(db), { ...options, ascending: true })).items[0]?.title, 'Near');
    assert.equal((await queryTimeline(pool(db), options)).items[0]?.title, 'Far');
    assert.throws(() => changesSince('not a date', NOW), /valid timestamp/);
    assert.throws(() => changesSince('2027-01-01T00:00Z', NOW), /valid timestamp/);
  } finally { await db.close(); }
});
