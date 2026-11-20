import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatResearchInput, parseResearchBrief, parseResearchCheckpoint, researchSearchUrls, runChatResearch, selectPageSections } from '../src/work/chatResearch.js';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { modelReadingSteps } from '../src/ai/knowledge/documentReading.js';
import { articleDocument } from '../src/utils/articleReading.js';
import { listAgentJobs } from '../src/agents/engine.js';
import { Pool } from 'pg';
import { mock } from 'node:test';

test('research reading produces cited synthesis without optional quotation extraction', async () => {
  const steps = modelReadingSteps({ chatBulk: async (_messages, _tokens, _timeout, _reasoning, schema) => {
    assert.match(JSON.stringify(schema), /"maxItems":0/);
    return JSON.stringify({ summary: 'A supported finding.', memory: 'A supported finding.', excerpts: [] });
  } }, undefined, false);
  const result = await steps.summarise('A supported finding.', '', 'Research the feature');
  assert.deepEqual(result.excerpts, []);
});

const brief = {
  title: 'Productivity research', objective: 'Compare Obsidian and Notion with the existing app.',
  compareInternally: true,
  topics: [
    { title: 'Obsidian', query: 'site:obsidian.md official Bases features' },
    { title: 'Notion', query: 'site:notion.com official database features' },
  ],
};
const input = parseChatResearchInput({ ...brief, ownerId: 'owner', requestId: 'request',
  request: 'Research Obsidian and Notion and assess what is worth adding to Athena.' });
const source = {
  url: 'https://obsidian.md/help/bases', title: 'Bases', readAt: '2026-11-05T20:00:00Z',
  reviewId: '11111111-1111-4111-8111-111111111111', chars: 20_000,
  summary: 'Bases provides property-based views.', excerpts: ['Bases'],
};

test('research checks only outgoing topics, never private instructions or the internal comparison', async t => {
  const db = new Pool();
  t.mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }));
  let checkpointReached = false;
  t.mock.method(db, 'connect', async () => { checkpointReached = true; throw new Error('Public query accepted; checkpoint reached'); });
  let allow = true;
  const topics = [{ title: 'Work IQ', query: 'Microsoft Work IQ Copilot outage dependencies Ignite' }];
  const chat = t.mock.method(FoundryClient.prototype, 'chat', async (_model, messages) => {
    assert.deepEqual(JSON.parse(String(messages[1]?.content)), { topics });
    return JSON.stringify({ allowed: allow, reason: allow ? 'Public product research' : 'Outgoing fixture disclosure' });
  });
  const context = {
    db, jobId: '11111111-1111-4111-8111-111111111111', subjectId: '22222222-2222-4222-8222-222222222222',
    attempt: 1, signal: new AbortController().signal, progress: () => {},
    input: { ...input, topics, objective: 'Compare against the confidential internal architecture', request: 'Private internal instructions' },
  };
  try {
    await assert.rejects(runChatResearch(context), /Public query accepted; checkpoint reached/);
    assert.equal(checkpointReached, true);
    allow = false;
    checkpointReached = false;
    await assert.rejects(runChatResearch(context), /No public query was sent: Outgoing fixture disclosure/);
    assert.equal(checkpointReached, false);
    assert.equal(chat.mock.callCount(), 2);
  } finally { await db.end(); }
});

test('research jobs display the current brief rather than the older chat title', async () => {
  const db = new Pool();
  const now = new Date();
  const query = mock.method(db, 'query', async () => ({ rows: [
    { id: 'one', specialist: 'chat-researcher', subject_type: 'chat', subject_id: 'chat',
      subject_title: 'Old design conversation', subject_url: '/chat', input: { title: 'Public outage research' },
      status: 'failed', progress: [], result: null, error: 'Failed', depends_on: null, is_step: false,
      conversation_id: 'chat', requested_by: 'chat', acknowledged_at: null, created_at: now, started_at: null, finished_at: now },
    { id: 'two', specialist: 'another-specialist', subject_type: 'design', subject_id: 'design',
      subject_title: 'Existing subject', subject_url: '/think', input: { title: 'Different title' },
      status: 'queued', progress: [], result: null, error: null, depends_on: null, is_step: false,
      conversation_id: null, requested_by: 'app', acknowledged_at: null, created_at: now, started_at: null, finished_at: null },
  ] }));
  try {
    const jobs = await listAgentJobs(db, {});
    assert.equal(jobs[0]?.subjectTitle, 'Public outage research');
    assert.equal(jobs[0]?.subjectUrl, '/chat');
    assert.equal(jobs[1]?.subjectTitle, 'Existing subject');
  } finally { query.mock.restore(); await db.end(); }
});

test('research briefs require explicit scope and small distinct public topics', () => {
  assert.deepEqual(parseResearchBrief(brief), brief);
  assert.throws(() => parseResearchBrief({ ...brief, compareInternally: undefined }), /internal comparison/);
  assert.throws(() => parseResearchBrief({ ...brief, topics: [] }), /one to eight/);
  assert.throws(() => parseResearchBrief({ ...brief, topics: [brief.topics[0], brief.topics[0]] }), /distinct/);
  assert.throws(() => parseResearchBrief({ ...brief, topics: Array(9).fill(brief.topics[0]) }), /batch/);
  assert.throws(() => parseResearchBrief({ ...brief, topics: [{ title: 'Large query', query: 'x'.repeat(501) }] }), /500/);
  assert.throws(() => parseResearchBrief({ ...brief, topics: [{ ...brief.topics[0], allowedDomains: ['https://obsidian.md/path'] }] }), /hostnames/);
  assert.throws(() => parseResearchBrief({ ...brief, topics: [{ ...brief.topics[0], allowedDomains: [] }] }), /at least one/);
});

test('saved research is bound to the exact brief and preserves completed topics', () => {
  const checkpoint = parseResearchCheckpoint(undefined, input);
  assert.equal(checkpoint.publicQueriesChecked, false);
  checkpoint.publicQueriesChecked = true;
  checkpoint.findings.push({ title: 'Obsidian', summary: source.summary, sources: [source], failures: [] });
  assert.deepEqual(parseResearchCheckpoint(checkpoint, input), checkpoint);
  assert.throws(() => parseResearchCheckpoint(checkpoint, { ...input, objective: 'A different request' }), /brief changed/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, publicQueriesChecked: false }, input), /boundary/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, draft: 'Premature finished report' }, input), /unfinished/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, findings: [{ ...checkpoint.findings[0], sources: [] }] }, input), /successfully read/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, findings: [{ ...checkpoint.findings[0], title: 'Wrong topic' }] }, input), /commissioned topics/);
});

test('a resumed source batch cannot count missing or unrelated pages as completed', () => {
  const checkpoint = { ...parseResearchCheckpoint(undefined, input), publicQueriesChecked: true,
    current: { urls: [source.url], next: 1, sources: [source], failures: [] } };
  assert.deepEqual(parseResearchCheckpoint(checkpoint, input).current, checkpoint.current);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, current: { ...checkpoint.current, next: 0 } }, input), /coverage/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, current: { ...checkpoint.current, urls: ['https://notion.com/'] } }, input), /coverage/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, current: { ...checkpoint.current, next: 2 } }, input), /continuation/);
});

test('research checkpoints retain screened candidates and selected-section coverage', () => {
  const checkpoint = { ...parseResearchCheckpoint(undefined, input), publicQueriesChecked: true,
    searchCandidates: [{ url: source.url, title: 'Bases', excerpt: 'A search lead, not evidence.' }],
    timeoutContinuations: 2 };
  assert.deepEqual(parseResearchCheckpoint(checkpoint, input), checkpoint);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, timeoutContinuations: 4 }, input), /timeout continuation/);
  assert.throws(() => parseResearchCheckpoint({ ...checkpoint, current: { urls: [source.url], next: 0, sources: [], failures: [] } }, input), /candidates/);
  const selected = { ...source, coverage: 'selected', totalChars: 50_000, sections: ['Bases'] };
  const current = { ...checkpoint, searchCandidates: undefined, current: {
    urls: [source.url], next: 1, sources: [selected], failures: [],
  } };
  assert.deepEqual(parseResearchCheckpoint(current, input).current, current.current);
  assert.throws(() => parseResearchCheckpoint({ ...current, current: { ...current.current,
    sources: [{ ...selected, sections: [] }] } }, input), /section details/);
});

test('section offsets follow actual headings, not an earlier matching phrase', () => {
  const document = articleDocument(`<main><p>${'Opening mentions Copilot. '.repeat(40)}</p>
    <h2>Copilot</h2><p>Relevant announcement.</p><h2>Other</h2><p>Different topic.</p></main>`);
  assert.equal(document.sections.length, 2);
  assert.match(document.text.slice(document.sections[0]!.start, document.sections[0]!.end), /^Copilot\s+Relevant announcement/);
  assert.match(document.text.slice(document.sections[1]!.start, document.sections[1]!.end), /^Other\s+Different topic/);
  assert.deepEqual(articleDocument('<p>No structured headings.</p>').sections, []);
});

test('long structured sources select relevant sections or explicitly fall back to a full read', async t => {
  const first = 'Copilot\n' + 'Relevant detail. '.repeat(2_000);
  const second = 'Other\n' + 'Other detail. '.repeat(1_000);
  const page = { title: 'Announcements', text: first + second, sections: [
    { heading: 'Copilot', start: 0, end: first.length },
    { heading: 'Other', start: first.length, end: first.length + second.length },
  ] };
  let response = { fullRead: false, indexes: [0] };
  const chat = t.mock.method(FoundryClient.prototype, 'chat', async () => JSON.stringify(response));
  assert.deepEqual(await selectPageSections(page, input, input.topics[0]!, new AbortController().signal), [0]);
  response = { fullRead: true, indexes: [] };
  assert.equal(await selectPageSections(page, input, input.topics[0]!, new AbortController().signal), undefined);
  response = { fullRead: false, indexes: [4] };
  await assert.rejects(selectPageSections(page, input, input.topics[0]!, new AbortController().signal), /invalid section/);
  assert.equal(chat.mock.callCount(), 3);
});

test('research timeouts continue saved candidates, then stop after bounded retries', async t => {
  const db = new Pool();
  t.mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }));
  const saved: unknown[] = [];
  t.mock.method(db, 'connect', async () => ({
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('UPDATE agent_jobs')) saved.push(JSON.parse(String(values?.[2])));
      return { rows: [{ id: 'job' }], rowCount: 1 };
    },
    release: () => {},
  }));
  const timeout = new AbortController();
  timeout.abort(new DOMException('Time limit reached', 'TimeoutError'));
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  const checkpoint = { ...parseResearchCheckpoint(undefined, input), publicQueriesChecked: true,
    searchCandidates: [{ url: source.url, title: 'Bases', excerpt: 'A search lead.' }] };
  const context = { db, jobId: '11111111-1111-4111-8111-111111111111', subjectId: '22222222-2222-4222-8222-222222222222',
    attempt: 1, signal: new AbortController().signal, progress: () => {}, input: { ...input, researchCheckpoint: checkpoint } };
  try {
    const outcome = await runChatResearch(context);
    assert.equal(outcome.continueAfterMs, 1_000);
    assert.deepEqual(saved[0], { ...checkpoint, timeoutContinuations: 1 });
    const exhausted = { ...context, input: { ...input, researchCheckpoint: { ...checkpoint, timeoutContinuations: 3 } } };
    await assert.rejects(runChatResearch(exhausted), /time limit repeatedly.*checkpoints are retained/);
    assert.equal(saved.length, 1);
    const cancelled = new AbortController();
    cancelled.abort(new Error('Cancelled by user'));
    await assert.rejects(runChatResearch({ ...context, signal: cancelled.signal }), /Cancelled by user/);
  } finally { await db.end(); }
});

test('public search candidates are explicit URLs, not search snippets masquerading as evidence', () => {
  const response = { result: JSON.stringify({ results: [
    { url: 'https://obsidian.md/help/bases', content: 'Search preview only' },
    { url: 'https://notion.com/help', content: 'Another preview' },
  ] }) };
  assert.deepEqual(researchSearchUrls(response), ['https://obsidian.md/help/bases', 'https://notion.com/help']);
  assert.deepEqual(researchSearchUrls(response, ['obsidian.md']), ['https://obsidian.md/help/bases']);
  assert.throws(() => researchSearchUrls({ result: JSON.stringify({ results: [{ url: 'https://obsidian.md.example.com/' }] }) }, ['obsidian.md']), /No public sources/);
  assert.deepEqual(researchSearchUrls({ result: JSON.stringify({ results: [{ url: 'https://help.obsidian.md/' }] }) }, ['obsidian.md']), ['https://help.obsidian.md/']);
  assert.throws(() => researchSearchUrls({ error: 'Search unavailable' }), /Search unavailable/);
  assert.throws(() => researchSearchUrls({ result: JSON.stringify({ error: 'Search quota reached' }) }), /Search quota reached/);
  assert.throws(() => researchSearchUrls({ result: JSON.stringify({
    error: 'Search failed', status: 429, detail: { error: 'Your request has been blocked due to excessive requests.' },
  }) }), /rate-limited \(HTTP 429\).*excessive requests.*Saved batches are retained/);
  assert.throws(() => researchSearchUrls({ result: JSON.stringify({ results: [] }) }), /No public sources/);
  assert.throws(() => researchSearchUrls({ result: JSON.stringify({ results: [{ url: 'file:///private/file' }] }) }), /HTTP/);
  assert.throws(() => researchSearchUrls({ result: JSON.stringify({ results: [{ url: 'https://user:pass@example.com/' }] }) }), /credentials/);
});
