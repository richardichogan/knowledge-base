import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistanceId, assistanceQuestionsBlock, isPublicSearchEvidence, isReadEvidence, parseAssistanceProposal, validateAssistanceSearch } from '../src/work/taskAssistance.js';

const proposal = {
  kind: 'research', summary: 'Compare First Mate with Athena', approach: 'Verify the repository and read architecture evidence.',
  output: 'Linked research note with fit and gaps', questions: [], humanDecisions: ['Review recommendations'],
  publicQueries: ['First Mate GitHub repository AI agent'],
};
test('TASK-ASSIST-05: research questions do not block approval or execution; email prerequisites still do', () => {
  const research = parseAssistanceProposal({ ...proposal, questions: ['Should recommendations also suggest document wording?'] });
  assert.equal(assistanceQuestionsBlock(research), false);
  assert.equal(assistanceQuestionsBlock({ ...research, kind: 'email' }), true);
  assert.equal(assistanceQuestionsBlock({ ...research, kind: 'email', questions: [] }), false);
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
