import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { amendResearchFormatting, assistanceId, isPublicSearchEvidence, isReadEvidence, parseAssistanceProposal, researchAmendmentPreservesContent, researchNoteBlocks, validateAssistanceSearch } from '../src/work/taskAssistance.js';
import { AiError } from '../src/types/errors.js';

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
});
