import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatResearchInput, parseResearchBrief, parseResearchCheckpoint, researchSearchUrls } from '../src/work/chatResearch.js';
import { modelReadingSteps } from '../src/ai/knowledge/documentReading.js';

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
