import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { amendResearchFormatting, assistanceId, isPublicSearchEvidence, isReadEvidence, parseAssistanceProposal, researchAmendmentPreservesContent, researchNoteBlocks, validateAssistanceSearch } from '../src/work/taskAssistance.js';
import { AiError } from '../src/types/errors.js';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { assignTaskAgent, recordTaskAgentActivity, taskAssistanceSignature } from '../src/work/taskAgentActivity.js';
import { rowToTask } from '../src/routes/tasks.js';
import { parseTaskAssistanceReview, requireCurrentTaskDirection, requireTaskAssistanceReady, taskAssistanceContext } from '../src/work/taskAssistanceContract.js';
import { parseTaskDraftCheckpoint } from '../src/work/taskAssistanceDraft.js';

const proposal = {
  kind: 'research', summary: 'Compare First Mate with Athena', approach: 'Verify the repository and read architecture evidence.',
  output: 'Linked research note with fit and gaps', questions: [], humanDecisions: ['Review recommendations'],
  publicQueries: ['First Mate GitHub repository AI agent'],
};
test('research saves native H1/H2 headings, nested bullets, numbered steps and literal code', () => {
  const blocks = researchNoteBlocks('# IKEA research\n\n## Findings\n\n- **Finding** with [source](https://example.test)\n  - Supporting evidence\n\n## Proposed steps\n\n1. Review the evidence\n2. Decide next steps\n\n```json\n{\n  "example": true\n}\n```\n\n## Limitations\n\nThis is an illustrative fixture.');
  assert.deepEqual(blocks.filter(block => block.type === 'heading').map(block => block.props?.level), [1, 2, 2, 2]);
  const bullet = blocks.find(block => block.type === 'bulletListItem');
  assert.ok(bullet?.type === 'bulletListItem' && bullet.children?.[0]?.type === 'bulletListItem');
  assert.ok(bullet?.type === 'bulletListItem' && bullet.content.some(part => part.type === 'link'));
  assert.equal(blocks.filter(block => block.type === 'numberedListItem').length, 2);
  const code = blocks.find(block => block.type === 'codeBlock');
  assert.ok(code?.type === 'codeBlock');
  assert.equal(code.props?.language, 'json');
  assert.equal(code.content[0]?.type === 'text' && code.content[0].text, '{\n  "example": true\n}');
});
test('research formatting checks request amendment of flattened prose and whole-document fences', () => {
  assert.throws(() => researchNoteBlocks('**IKEA research**\n\n**Findings**\n\nPlain paragraphs.'), /Amend the formatting/);
  assert.throws(() => researchNoteBlocks('```markdown\n# IKEA research\n\n## Findings\n\n- Evidence\n```'), /Amend the formatting/);
  assert.doesNotThrow(() => researchNoteBlocks('# Research\n\n## Findings\n\nPlain-language findings without invented code.'));
});
test('Iris amends formatting without discarding the research or changing source evidence', async () => {
  const original = '**Research**\n\n**Findings**\n\nEvidence from [the source](https://example.test).';
  const valid = '# Research\n\n## Findings\n\n- Evidence from [the source](https://example.test).';
  const checkpoint = { proposalId: 'proposal', taskSignature: 'task', original, markdown: original, feedback: '', publicEvidence: true };
  let calls = 0;
  const saved: string[] = [];
  const blocks = await amendResearchFormatting(checkpoint, new AbortController().signal, async (draft, feedback, baseline) => {
    assert.equal(baseline, original);
    assert.ok(draft);
    assert.match(feedback, /Amend the formatting/);
    calls++;
    return calls < 4 ? original : valid;
  }, async current => { saved.push(current.markdown); }, () => {});
  assert.equal(calls, 4, 'formatting is not rejected after a fixed amendment count');
  assert.equal(checkpoint.original, original);
  assert.equal(saved.at(-1), valid);
  assert.equal(blocks?.[0]?.type, 'heading');
});
test('Iris retains unfinished formatting for resumption when the budget signal stops', async () => {
  const original = '**Research**\n\nEvidence from [the source](https://example.test).';
  const checkpoint = { proposalId: 'proposal', taskSignature: 'task', original, markdown: original, feedback: '', publicEvidence: true };
  const stop = new AbortController();
  let saves = 0;
  const pending = await amendResearchFormatting(checkpoint, stop.signal, async () => {
    stop.abort();
    throw stop.signal.reason;
  }, async () => { saves++; }, () => {});
  assert.equal(pending, undefined);
  assert.equal(saves, 1, 'the draft is saved before asking Iris to amend it');
  assert.equal(checkpoint.original, original);
  assert.match(checkpoint.feedback, /H1/);
  let resumedCalls = 0;
  const resumed = await amendResearchFormatting(checkpoint, new AbortController().signal, async () => {
    resumedCalls++;
    return '# Research\n\n## Findings\n\nEvidence from [the source](https://example.test).';
  }, async () => {}, () => {});
  assert.equal(resumedCalls, 1);
  assert.ok(resumed);
});
test('model amendment problems retain pending work rather than rejecting the research', async () => {
  const original = 'Evidence.';
  const checkpoint = { proposalId: 'proposal', taskSignature: 'task', original, markdown: original, feedback: '', publicEvidence: true };
  const progress: string[] = [];
  assert.equal(await amendResearchFormatting(checkpoint, new AbortController().signal,
    async () => { throw new AiError('The endpoint is temporarily unavailable.'); }, async () => {},
    message => { progress.push(message); }), undefined);
  assert.match(progress.at(-1)!, /retained.*resume/);
  assert.equal(checkpoint.original, original);
});
test('formatting amendments preserve wording, source URLs and literal code', () => {
  const original = '```markdown\n# Research\n\n## Findings\n\n[Evidence](https://example.test).\n\n```json\n{"value":1}\n```\n```';
  const amended = '# Research\n\n## Findings\n\n- [Evidence](https://example.test).\n\n```json\n{"value":1}\n```';
  assert.equal(researchAmendmentPreservesContent(original, amended), true);
  assert.equal(researchAmendmentPreservesContent(original, amended.replace('value', 'changed')), false);
  assert.equal(researchAmendmentPreservesContent(original, amended.replace('example.test', 'invented.test')), false);
  assert.equal(researchAmendmentPreservesContent(original, amended.replace('Evidence', 'Invented finding')), false);
});
test('research continuations remain queued with retained content and no completion notice', async () => {
  const service = await readFile(new URL('../src/work/taskAssistance.ts', import.meta.url), 'utf8');
  const engine = await readFile(new URL('../src/agents/engine.ts', import.meta.url), 'utf8');
  assert.match(service, /getFoundryClient\('task-researcher'\)\.chat/);
  assert.match(service, /retainedResearch: \{ original: checkpoint.original, markdown: checkpoint.markdown, feedback: checkpoint.feedback \}/);
  assert.match(engine, /resumeAt \? 'queued' : 'done'/);
  assert.match(engine, /if \(done\?\.status === 'queued'\) emit\(done\)/);
  assert.match(engine, /AND NOT \(specialist='task-researcher' AND input \? 'researchFormattingCheckpoint'\)/);
});
test('TASK-ASSIST-05: research and email questions are retained without approval or execution gates', async () => {
  const research = parseAssistanceProposal({ ...proposal, questions: ['Should recommendations also suggest document wording?'] });
  const email = parseAssistanceProposal({ ...research, kind: 'email', questions: ['Who is the recipient?'] });
  assert.deepEqual(email.questions, ['Who is the recipient?']);
  const service = await readFile(new URL('../src/work/taskAssistance.ts', import.meta.url), 'utf8');
  const view = await readFile(new URL('../../knowledge-hub-web/src/features/plan/TaskDetail.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(service, /assistanceQuestionsBlock/);
  assert.doesNotMatch(view, /disabled=\{[^}]*questions/);
  assert.match(service, /Questions never block supported assistance/);
  assert.match(service, /Use explicit placeholders for unknown recipients/);
  assert.doesNotMatch(service, /task\.status === 'completed'/);
  assert.doesNotMatch(view, /disabled=\{[^}]*task\.status === 'completed'/);
  assert.doesNotMatch(view, /latest\.proposal\.kind !== 'unsupported'/);
});
test('TASK-ASSIST-06: unavailable direct execution offers support, including legacy proposals', () => {
  assert.equal(parseAssistanceProposal({ ...proposal, kind: 'support' }).kind, 'support');
  assert.equal(parseAssistanceProposal({ ...proposal, kind: 'unsupported' }).kind, 'support');
});
test('TASK-ASSIST-01: proposals require bounded explicit capability and approval identities', () => {
  assert.deepEqual(parseAssistanceProposal(proposal), proposal);
  assert.throws(() => parseAssistanceProposal({ ...proposal, kind: 'send-email' }));
  assert.throws(() => parseAssistanceProposal({ ...proposal, questions: 'guess' }));
  assert.throws(() => parseAssistanceProposal({ ...proposal, publicQueries: Array(7).fill('query') }));
  assert.throws(() => assistanceId('task title'));
  assert.equal(assistanceId('55a65361-f56e-47b5-995b-62f0dae18b0f'), '55a65361-f56e-47b5-995b-62f0dae18b0f');
});
test('TASK-ASSIST-02: public search can use only approved queries; internal search is separate', () => {
  const parsed = parseAssistanceProposal(proposal);
  assert.doesNotThrow(() => validateAssistanceSearch(parsed, 'tavily-search', { query: proposal.publicQueries[0] }));
  assert.doesNotThrow(() => validateAssistanceSearch(parsed, 'tavily_search', { query: proposal.publicQueries[0] }));
  assert.throws(() => validateAssistanceSearch(parsed, 'tavily_search', { query: 'private project architecture' }));
  assert.throws(() => validateAssistanceSearch(parsed, 'tavily-search', { query: 'private project architecture' }));
  assert.throws(() => validateAssistanceSearch(parsed, 'microsoft_docs_search', { query: 'unapproved query' }));
  assert.throws(() => validateAssistanceSearch(parsed, 'tavily-extract', { query: 'private excerpt' }));
  assert.doesNotThrow(() => validateAssistanceSearch(parsed, 'search_knowledge_base', { query: 'project architecture' }));
});
test('TASK-ASSIST-03: search previews and failed/unavailable reads are not research evidence', () => {
  const content = 'Actual read source text. '.repeat(20);
  assert.equal(isReadEvidence('fetch_web_page', { success: true, url: 'https://github.com/example/repo', content }), true);
  assert.equal(isReadEvidence('search_knowledge_base', { content }), false);
  assert.equal(isReadEvidence('read_knowledge_record', { status: 'unavailable', content }), false);
  assert.equal(isReadEvidence('fetch_web_page', { error: 'denied', content }), false);
  assert.equal(isReadEvidence('tavily-extract', { isError: true, content }), false);
  assert.equal(isReadEvidence('read_diagram', { code: 'budget_exhausted', content }), false);
  assert.equal(isReadEvidence('fetch_web_page', { success: false, content }), false);
  assert.equal(isReadEvidence('read_knowledge_record', { status: 'ok', title: content, metadata: content }), false);
  assert.equal(isReadEvidence('read_knowledge_record', { status: 'ok', record: { content } }), true);
  assert.equal(isReadEvidence('read_knowledge_record', { status: 'ok', review: { summary: content, readChars: 0 } }), false);
  assert.equal(isReadEvidence('tavily-extract', { result: JSON.stringify({ results: [{ url: 'https://example.com', raw_content: content }] }) }), true);
  assert.equal(isReadEvidence('tavily-extract', { result: JSON.stringify({ error: 'denied', raw_content: content }) }), false);
});
test('TASK-ASSIST-04: internal reads and failed searches cannot satisfy approved public discovery', () => {
  const source = { results: [{ url: 'https://github.com/example/repo', content: 'Search preview' }] };
  assert.equal(isPublicSearchEvidence('tavily-search', { result: JSON.stringify(source) }), true);
  assert.equal(isPublicSearchEvidence('tavily_search', { result: JSON.stringify(source) }), true);
  assert.equal(isPublicSearchEvidence('tavily-search', { error: 'unavailable', ...source }), false);
  assert.equal(isPublicSearchEvidence('tavily-search', { result: JSON.stringify({ results: [] }) }), false);
  assert.equal(isPublicSearchEvidence('search_knowledge_base', source), false);
  assert.equal(isReadEvidence('tavily-search', source), false, 'a search preview is not a public-source read');
  assert.equal(isReadEvidence('read_task_activity', { notes: [{ body: 'A source pointer, not original content.' }] }), false);
});

async function activityFixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,body TEXT,status TEXT,waiting_on TEXT,
      project_id TEXT,external_url TEXT,archived BOOLEAN DEFAULT false,tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO tasks(id,title,body,status,waiting_on,project_id)
      VALUES('task','Preserve the title','Preserve the writing','waiting','A response','project');
    CREATE TABLE task_tags(task_id TEXT,tag_id TEXT);
    INSERT INTO task_tags VALUES('task','topic');
    CREATE TABLE task_assistance(id TEXT PRIMARY KEY,task_id TEXT,task_signature TEXT,
      task_snapshot JSONB,approved_at TIMESTAMPTZ,owner_id TEXT,direction TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,subject_id TEXT,attempts INTEGER,status TEXT);
    INSERT INTO agent_jobs VALUES('job','task',1,'queued');
    CREATE TABLE task_notes(id UUID PRIMARY KEY,task_id TEXT REFERENCES tasks(id),body TEXT,
      activity JSONB,created_at TIMESTAMPTZ DEFAULT now());
  `);
  const client = {
    async query(sql: string, params?: unknown[]) {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  } as unknown as PoolClient;
  const task = rowToTask((await db.query<Record<string, unknown>>(`SELECT *,ARRAY['topic'] AS taxonomy_tag_ids FROM tasks`)).rows[0]!);
  await db.query(`INSERT INTO task_assistance(id,task_id,task_signature,task_snapshot,approved_at) VALUES('proposal','task',$1,$2,now())`,
    [taskAssistanceSignature(task), JSON.stringify(task)]);
  const job = { id: 'job', specialist: 'task-researcher', subject_type: 'task', subject_id: 'task', attempts: 1, status: 'queued' };
  return { db, client, task, job };
}

test('TASK-ASSIST-07: assigning work moves the task atomically and rebases only the approved snapshot', async () => {
  const { db, client, task, job } = await activityFixture();
  try {
    await client.query('BEGIN');
    const assigned = await assignTaskAgent(client, job, 'Iris', 'proposal');
    await client.query('COMMIT');
    assert.ok(assigned);
    assert.equal(assigned.status, 'in-progress');
    assert.equal(assigned.waitingOn, null);
    assert.equal(assigned.title, task.title);
    assert.equal(assigned.body, task.body);
    const saved = (await db.query<{ task_signature: string; task_snapshot: unknown }>('SELECT * FROM task_assistance')).rows[0]!;
    assert.equal(saved.task_signature, taskAssistanceSignature(assigned));
    assert.deepEqual(saved.task_snapshot, JSON.parse(JSON.stringify(assigned)));
    assert.deepEqual(assigned.taxonomyTagIds, ['topic']);
    await assignTaskAgent(client, job, 'Iris', 'proposal');
    assert.equal((await db.query('SELECT * FROM task_notes')).rows.length, 1, 'assignment receipts are idempotent');
    await db.exec(`UPDATE tasks SET body='User editing must remain protected'`);
    await assert.rejects(assignTaskAgent(client, job, 'Iris', 'proposal'), /changed before assignment/);
    assert.equal((await db.query<{ body: string }>('SELECT body FROM tasks')).rows[0]?.body, 'User editing must remain protected');
  } finally { await db.close(); }
});

test('TASK-ASSIST-08: assessment does not move tasks, and a failed queue transaction retains the original task', async () => {
  const { db, client, task, job } = await activityFixture();
  try {
    await assignTaskAgent(client, { ...job, specialist: 'task-assistance-assessor' }, 'Athena', undefined);
    assert.equal((await db.query<{ status: string }>('SELECT status FROM tasks')).rows[0]?.status, 'waiting');
    assert.equal((await db.query('SELECT * FROM task_notes')).rows.length, 0);
    await client.query('BEGIN');
    await assignTaskAgent(client, job, 'Iris', 'proposal');
    await client.query('ROLLBACK');
    assert.equal((await db.query<{ status: string }>('SELECT status FROM tasks')).rows[0]?.status, 'waiting');
    assert.equal((await db.query<{ task_signature: string }>('SELECT task_signature FROM task_assistance')).rows[0]?.task_signature,
      taskAssistanceSignature(task));
    assert.equal((await db.query('SELECT * FROM task_notes')).rows.length, 0);
  } finally { await db.close(); }
});

test('TASK-ASSIST-09: activity retains progress, retries, blockers and results without completing the task', async () => {
  const { db, client, job } = await activityFixture();
  try {
    await assignTaskAgent(client, job, 'Iris', 'proposal');
    await db.exec(`UPDATE agent_jobs SET status='running'`);
    const running = { ...job, status: 'running' };
    await recordTaskAgentActivity(client, { ...running, specialist: 'task-assistance-assessor' }, 'Athena', 'agent-progress', 'Assessment');
    for (let i = 0; i < 35; i++) await recordTaskAgentActivity(client, running, 'Iris', 'agent-progress', `Reading source ${i}`);
    await recordTaskAgentActivity(client, running, 'Iris', 'agent-progress', 'Reading source 34');
    assert.equal((await db.query('SELECT * FROM task_notes')).rows.length, 36, 'full activity outlives the bounded job-progress array');
    await db.exec(`UPDATE agent_jobs SET status='failed'`);
    await recordTaskAgentActivity(client, { ...job, status: 'failed' }, 'Iris', 'agent-blocked', 'Source access failed');
    await db.exec(`UPDATE agent_jobs SET attempts=2,status='running'`);
    await recordTaskAgentActivity(client, running, 'Iris', 'agent-progress', 'Stale worker');
    await recordTaskAgentActivity(client, { ...running, attempts: 2 }, 'Iris', 'agent-progress', 'Reading source 34');
    await db.exec(`UPDATE agent_jobs SET status='done'`);
    const done = { ...job, attempts: 2, status: 'done' };
    await recordTaskAgentActivity(client, done, 'Iris', 'agent-finished', 'Findings saved for review');
    await recordTaskAgentActivity(client, done, 'Iris', 'agent-finished', 'Findings saved for review');
    const notes = await db.query<{ body: string; activity: { actor: string; action: string; specialistName: string } }>('SELECT * FROM task_notes');
    assert.equal(notes.rows.length, 39);
    assert.ok(notes.rows.every(note => note.activity.actor === 'athena' && note.activity.specialistName === 'Iris'));
    assert.ok(notes.rows.some(note => note.activity.action === 'agent-blocked'));
    assert.ok(notes.rows.some(note => note.activity.action === 'agent-finished'));
    assert.ok(notes.rows.every(note => !note.body.includes('Stale worker')));
    assert.equal((await db.query<{ status: string }>('SELECT status FROM tasks')).rows[0]?.status, 'in-progress');
  } finally { await db.close(); }
});

test('TASK-ASSIST-10: queue, recovery and live task activity share the same integration', async () => {
  const engine = await readFile(new URL('../src/agents/engine.ts', import.meta.url), 'utf8');
  const store = await readFile(new URL('../../knowledge-hub-web/src/services/agentJobStore.ts', import.meta.url), 'utf8');
  assert.match(engine, /assignedTask = await assignTaskAgent[\s\S]*?await client\.query\('COMMIT'\)/);
  assert.match(engine, /for \(const row of recovered\.rows\) \{\s*await saveTaskJobOutcome/);
  assert.match(engine, /for \(const row of failed\.rows\) \{\s*await saveTaskJobOutcome/);
  assert.match(engine, /await saveTaskJobOutcome\(db, outcome\);\s*await finish\(db, outcome\)/);
  assert.match(store, /athena-task-job-updated/);
  assert.match(store, /'task-assistance', 'task-notes'/);
});

test('TASK-ASSIST-11: blank reassessments retain owner direction beyond the visible proposal history', async () => {
  const { db, client } = await activityFixture();
  try {
    await db.exec(`UPDATE task_assistance SET owner_id='owner',direction='Read the original training note and tighten it into a Word document.',
        created_at='2026-11-03T13:01:00Z';
      INSERT INTO task_assistance(id,task_id,owner_id,direction,created_at)
        SELECT 'blank-'||i,'task','owner','',TIMESTAMPTZ '2026-11-03T13:06:00Z'+i*INTERVAL '1 minute'
        FROM generate_series(1,8) i;
      INSERT INTO task_assistance(id,task_id,owner_id,direction,created_at)
        VALUES('another-owner','task','someone-else','Write an email instead.','2026-11-03T15:00:00Z')`);
    const retained = await taskAssistanceContext(client, 'task', 'owner', '   ');
    assert.equal(retained.direction, 'Read the original training note and tighten it into a Word document.');
    assert.deepEqual(retained.directionHistory, [retained.direction]);
    assert.equal((await taskAssistanceContext(client, 'task', 'owner')).direction, retained.direction);
    assert.equal((await taskAssistanceContext(client, 'task', 'owner', '  Compare the two source documents.  ')).direction,
      'Compare the two source documents.');
    assert.equal((await taskAssistanceContext(client, 'task', 'new-owner')).direction, '');
    assert.equal((await taskAssistanceContext(client, 'other-task', 'owner')).direction, '');
    await assert.doesNotReject(requireCurrentTaskDirection(client, 'task', 'owner', retained.direction));
    await assert.rejects(requireCurrentTaskDirection(client, 'task', 'owner', ''), /omitted from this proposal/,
      'the blank email proposal must be reassessed, not silently granted the earlier document instruction');
    await db.query(`INSERT INTO task_assistance(id,task_id,owner_id,direction,created_at)
      VALUES('new-direction','task','owner','Compare both source documents.','2026-11-03T16:00:00Z')`);
    const updated = await taskAssistanceContext(client, 'task', 'owner', 'Just draft the email.');
    assert.equal(updated.direction, 'Just draft the email.');
    assert.deepEqual(updated.directionHistory, [retained.direction, 'Compare both source documents.']);
    assert.equal(updated.directionHistoryMayBePartial, false);
    await assert.rejects(requireCurrentTaskDirection(client, 'task', 'owner', retained.direction), /direction changed/);
  } finally { await db.close(); }
});

test('retained task drafts preserve evidence and rejection feedback without claiming readiness', () => {
  const checkpoint = {
    proposalId: 'approved', taskSignature: 'snapshot', direction: 'Draft the email using these sources.',
    body: 'An unfinished source-backed draft.', sourcesRead: 1, publicSearches: 1, publicSourcesRead: 1,
    sourceEvidence: [{ tool: 'fetch_web_page', excerpt: '{"content":"Actual source read"}', truncated: false }],
    capturedAt: '2026-11-06T12:05:00Z', reviewFeedback: 'Include the actual email, not messaging points.',
  };
  assert.deepEqual(parseTaskDraftCheckpoint(checkpoint), checkpoint);
  assert.throws(() => parseTaskDraftCheckpoint({ ...checkpoint, sourceEvidence: [] }), /missing/);
  assert.throws(() => parseTaskDraftCheckpoint({ ...checkpoint, sourcesRead: -1 }), /sourcesRead/);
  assert.throws(() => parseTaskDraftCheckpoint({ ...checkpoint, capturedAt: 'unknown' }), /capture date/);
  assert.throws(() => parseTaskDraftCheckpoint({ ...checkpoint, body: '' }), /empty/);
  assert.throws(() => parseTaskDraftCheckpoint({ ...checkpoint,
    sourceEvidence: [{ tool: 'fetch_web_page', excerpt: 'x'.repeat(12_001), truncated: false }] }), /source evidence/);
});

test('task drafting retains work before review and email research uses the same approval boundaries', async () => {
  const service = await readFile(new URL('../src/work/taskAssistance.ts', import.meta.url), 'utf8');
  const drafts = await readFile(new URL('../src/work/taskAssistanceDraft.ts', import.meta.url), 'utf8');
  assert.match(service, /const publicResearch = row\.proposal\.publicQueries\.length > 0/);
  assert.match(service, /directionHistory: intent\.directionHistory/);
  assert.match(service, /await saveTaskDraft\(context, draft\);[\s\S]*?task-deliverable-review/);
  assert.match(service, /beforeReply:[\s\S]*?sourcesRead === 0/);
  assert.match(service, /draft\.reviewFeedback = review\.reason/);
  const review = service.slice(service.indexOf("setAiWorkflowStage('task-deliverable-review')"),
    service.indexOf('const noteId = row.id'));
  assert.doesNotMatch(review, /task: row\.task_snapshot|taskActivity: intent\.activity/);
  assert.match(drafts, /a\.owner_id=\$2 AND a\.task_signature=\$3 AND a\.approved_at IS NOT NULL/);
  assert.match(drafts, /lease_until>clock_timestamp/);
});

test('TASK-ASSIST-12: task context includes attributed activity, declaring bounded or clipped history', async () => {
  const { db, client } = await activityFixture();
  try {
    for (let i = 0; i < 32; i++) {
      await db.query(`INSERT INTO task_notes(id,task_id,body,activity,created_at) VALUES($1,'task',$2,$3,to_timestamp($4))`,
        [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          i === 31 ? 'Read the linked training source. '.repeat(200) : `Status update ${i}`,
          JSON.stringify({ actor: i === 31 ? 'user' : 'athena', action: 'note' }), i + 100]);
    }
    const context = await taskAssistanceContext(client, 'task', 'owner', 'Keep this instruction.');
    assert.equal(context.activity.length, 30);
    assert.equal(context.activityMayBePartial, true);
    assert.equal(context.activity[0]?.body, 'Status update 2');
    assert.equal(context.activity.at(-1)?.body.length, 3000);
    assert.equal(context.activity.at(-1)?.truncated, true);
    assert.deepEqual(context.activity.at(-1)?.activity, { actor: 'user', action: 'note' });
    assert.equal(context.direction, 'Keep this instruction.');
  } finally { await db.close(); }
});

test('TASK-ASSIST-13: Word deliverables and source obligations survive typed proposal parsing', () => {
  const document = { ...proposal, kind: 'support', outputFormat: 'docx', sourceRequired: true };
  assert.deepEqual(parseAssistanceProposal(document), document);
  assert.throws(() => parseAssistanceProposal({ ...document, kind: 'email' }), /Word document/);
  assert.throws(() => parseAssistanceProposal({ ...document, outputFormat: 'executable' }), /output format/);
  assert.throws(() => parseAssistanceProposal({ ...document, sourceRequired: 'true' }), /source requirement/);
});

test('TASK-ASSIST-14: source-dependent work cannot be ready with no reads, unrelated evidence or only placeholders', () => {
  const ready = parseTaskAssistanceReview({ fulfilsRequest: true, sourceRequired: true,
    sourceSupportsResult: true, substantiveContent: true, reason: 'The revised modules and outcomes match the original training scope.' });
  assert.doesNotThrow(() => requireTaskAssistanceReady(ready, 1, true));
  assert.throws(() => requireTaskAssistanceReady(ready, 0, true), /No completed result was saved/);
  assert.throws(() => requireTaskAssistanceReady({ ...ready, sourceRequired: false }, 0, true),
    /No completed result was saved/, 'the approved source obligation overrides a mistaken reviewer verdict');
  assert.throws(() => requireTaskAssistanceReady({ ...ready, sourceSupportsResult: false,
    reason: 'Only a Daily Insights summary was read, not the original training scope.' }, 3, true), /original training scope/);
  assert.throws(() => requireTaskAssistanceReady({ ...ready, fulfilsRequest: false,
    reason: 'A placeholder email was returned instead of the requested tightened document.' }, 1, true), /placeholder email/);
  assert.throws(() => requireTaskAssistanceReady({ ...ready, substantiveContent: false,
    reason: 'The core training modules were left as placeholders.' }, 1, true), /core training modules/);
  assert.doesNotThrow(() => requireTaskAssistanceReady({ ...ready, sourceRequired: false, sourceSupportsResult: false,
    reason: 'This new draft uses facts supplied in the task and only leaves the unknown recipient labelled.' }, 0, false));
  assert.throws(() => parseTaskAssistanceReview({ ...ready, fulfilsRequest: 'true' }), /fulfilsRequest/);
  assert.throws(() => parseTaskAssistanceReview({ ...ready, reason: '' }), /explain its decision/);
});

test('TASK-ASSIST-15: every new result is reviewed before persistence, and legacy checkpoints cannot bypass review', async () => {
  const service = await readFile(new URL('../src/work/taskAssistance.ts', import.meta.url), 'utf8');
  const view = await readFile(new URL('../../knowledge-hub-web/src/features/plan/TaskDetail.tsx', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../../knowledge-hub-web/src/notes/NoteEditor.tsx', import.meta.url), 'utf8');
  assert.match(service, /JSON\.stringify\(proposal\), intent\.direction/);
  assert.match(service, /taskActivity: intent\.activity/);
  assert.match(service, /initialTools: \[[\s\S]*?'search_knowledge_base', 'read_knowledge_record'/);
  assert.match(service, /requireTaskAssistanceReady\(review, sourcesRead,[\s\S]*?const noteId = row\.id/);
  assert.match(service, /if \(saved\['readinessReviewed'\] !== true\) return undefined/);
  assert.match(service, /readinessReviewed: true/);
  assert.match(service, /requireCurrentTaskDirection\(client, subjectId, row\.owner_id, row\.direction\)/);
  assert.match(service, /name === 'read_task_activity' && args\['taskId'\] !== subjectId/);
  assert.match(service, /No sending, task completion, deadline changes/);
  assert.match(view, /Your direction/);
  assert.match(view, /Export as Word \(\.docx\)/);
  assert.match(editor, /async function handleExportWord/);
  assert.match(editor, /downloadBlob\(blob, `\$\{slugifyTitle\(title\)\}\.docx`\)/);
});
