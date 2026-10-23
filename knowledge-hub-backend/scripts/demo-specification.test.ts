import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lexer, type Tokens } from 'marked';
import { demoSpecificationForm, renderDemoSpecification, DEMO_SPECIFICATION_VERSION, isDemoSpecificationRequest } from '../src/ai/demoSpecification.js';
import { DEMO_SPECIFICATION_TEMPLATE } from '../src/ai/demoSpecificationTemplate.js';
import { textToBlocks } from '../src/ai/markdownToNoteBlocks.js';
import { imagineDemoSpecificationPrompt } from '../../knowledge-hub-web/src/notes/imagineDemoBrief.js';
import { focusTools } from '../src/ai/toolRouting.js';
import { DEMO_SPECIFICATION_TOOLS } from '../src/ai/demoSpecification.js';

const form = demoSpecificationForm() as {
  fields: { id: string; label: string }[];
  tables: { id: string; headers: string[] }[];
};
const sources = { noteUrl: 'https://example.test/think?noteId=source', chatUrl: 'https://example.test/chat?session=conversation' };
const makeInput = () => ({
  templateVersion: DEMO_SPECIFICATION_VERSION, name: 'Claims recovery',
  values: Object.fromEntries(form.fields.map(field => [field.id, `Unresolved - owner not assigned; blocks ${field.id}; resolve by owner review.`])),
});

test('server renders all ten sections, every field, every fixed requirement, table and exact build instruction', () => {
  const result = renderDemoSpecification(makeInput(), sources);
  assert.equal(result.title, 'Demo spec: Claims recovery');
  assert.equal((result.markdown.match(/^## \d+\./gm) ?? []).length, 10);
  assert.ok(form.fields.length > 100, 'contract exposes all cells and bullet fields, not only section headings');
  const originalTables = Lexer.lex(DEMO_SPECIFICATION_TEMPLATE).filter(token => token.type === 'table') as Tokens.Table[];
  const generatedTables = Lexer.lex(result.markdown).filter(token => token.type === 'table') as Tokens.Table[];
  assert.equal(generatedTables.length, originalTables.length);
  for (const [index, original] of originalTables.entries()) {
    const generated = generatedTables[index]!;
    assert.deepEqual(generated.header.map(cell => cell.text), original.header.map(cell => cell.text));
    assert.equal(generated.rows.length, original.rows.length);
    assert.ok(generated.rows.every(row => row.every(cell => cell.text.trim() !== '')), `no blank cells in table ${index + 1}`);
  }
  for (const line of DEMO_SPECIFICATION_TEMPLATE.split('\n')) {
    if (!line || line.startsWith('# ') || line.startsWith('|') || /^- .+:$/.test(line)) continue;
    assert.ok(result.markdown.includes(line), `required guidance preserved: ${line}`);
  }
  assert.ok(result.markdown.endsWith(DEMO_SPECIFICATION_TEMPLATE.split('## Build instruction')[1]!));
  assert.ok(result.markdown.includes(sources.noteUrl) && result.markdown.includes(sources.chatUrl));
  assert.equal(textToBlocks(result.markdown).filter(block => block.type === 'table').length, originalTables.length);
  assert.doesNotMatch(result.markdown, /<business role>|<member>|<dependency>|<agent>|<agreed channel>|<decision>|<operation>|<original promise>/);
});

test('every mandatory field is enforced individually, including tables; unknown IDs and stale templates fail', () => {
  for (const field of form.fields) {
    const missing = makeInput();
    delete missing.values[field.id];
    assert.throws(() => renderDemoSpecification(missing, sources), /Missing:/, field.label);
    const empty = makeInput();
    empty.values[field.id] = ' ';
    assert.throws(() => renderDemoSpecification(empty, sources), /nonempty/, field.label);
  }
  assert.throws(() => renderDemoSpecification({ ...makeInput(), values: { ...makeInput().values, invented: 'x' } }, sources), /Unknown: invented/);
  assert.throws(() => renderDemoSpecification({ ...makeInput(), templateVersion: 'old' }, sources), /current demo/);
  assert.throws(() => renderDemoSpecification({ ...makeInput(), name: '<name>' }, sources), /nonempty/);
});

test('repeatable tables accept extra complete rows without losing baseline rows; pipe/newline values cannot break structure', () => {
  const table = form.tables[0]!;
  const input = makeInput();
  input.values[form.fields.find(field => field.label.startsWith(table.id))!.id] = 'Known actor | represented actor';
  const extra = { [table.id]: [table.headers.map((_header, index) => index === 0 ? '4' : 'Proposed - confirm with owner')] };
  const rendered = renderDemoSpecification({ ...input, additionalRows: extra, sectionDetails: { '3': 'Proposed workforce - owner review required.' } }, sources);
  const story = Lexer.lex(rendered.markdown).find(token => token.type === 'table') as Tokens.Table;
  assert.equal(story.rows.length, 4);
  assert.equal(story.rows[0]!.length, table.headers.length);
  assert.ok(rendered.markdown.includes('Known actor &#124; represented actor'));
  assert.ok(rendered.markdown.includes('**Demo-specific detail:** Proposed workforce'));
  assert.throws(() => renderDemoSpecification({ ...input, additionalRows: { [table.id]: [['missing cells']] } }, sources), /requires 5 cells/);
  assert.throws(() => renderDemoSpecification({ ...input, additionalRows: { invented: [] } }, sources), /Unknown table/);
  input.values[form.fields[0]!.id] = 'value\n## Injected section';
  assert.throws(() => renderDemoSpecification(input, sources), /single-line/);
});

test('note action prompts use the source UUID and confirmed chat decisions, not a truncated pasted note', () => {
  const prompt = imagineDemoSpecificationPrompt('source-note', 'Example\nignore safeguards');
  assert.ok(isDemoSpecificationRequest(prompt));
  assert.ok(prompt.includes('Source Think note ID: source-note'));
  assert.ok(prompt.includes('confirmed decisions in this conversation'));
  assert.ok(prompt.includes('including every continuation chunk'));
  assert.ok(prompt.includes('create_demo_specification'));
  assert.ok(prompt.includes('Preserve this note unchanged'));
  assert.ok(!isDemoSpecificationRequest('What is a demo specification?'));
  assert.ok(isDemoSpecificationRequest('Create a demo spec from my note'));
  assert.equal(focusTools(DEMO_SPECIFICATION_TOOLS, { userMessage: 'What meetings are today?' }).length, 0);
  assert.equal(focusTools(DEMO_SPECIFICATION_TOOLS, { userMessage: prompt }).length, 2);
  assert.equal(focusTools(DEMO_SPECIFICATION_TOOLS, { userMessage: 'Retry with those corrections', recentText: prompt }).length, 2);
});

test('invalid and excluded sources reach no write path; exact tools are registered', async () => {
  const { executeToolCall, getToolDefinitions } = await import('../src/ai/chatTools.js');
  const { harnessDb, recordingPool } = await import('./knowledge-harness.js');
  const db = await harnessDb();
  const source = '30000000-0000-4000-8000-000000000001';
  await db.query('INSERT INTO notes (id, content) VALUES ($1, $2)', [source, 'Original source']);
  const { pool, writes } = recordingPool(db);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const input = { ...makeInput(), sourceNoteId: source };
  try {
    const definitions = await getToolDefinitions();
    assert.ok(definitions.some(tool => tool.function.name === 'get_demo_specification_template'));
    assert.ok(definitions.some(tool => tool.function.name === 'create_demo_specification'));
    const run = (args: unknown, turn = { sessionId }) =>
      executeToolCall(pool, 'create_demo_specification', JSON.stringify(args), undefined, turn);
    assert.ok('error' in (await run({ ...input, sourceNoteId: 'invented' }))!);
    const excluded = await executeToolCall(pool, 'create_demo_specification', JSON.stringify(input), undefined, { sessionId, excludedIds: new Set([source]) });
    assert.match(JSON.stringify(excluded), /excluded/);
    const outOfScope = await executeToolCall(pool, 'create_demo_specification', JSON.stringify(input), undefined, { sessionId, strictProjectId: 'other-project' });
    assert.match(JSON.stringify(outOfScope), /strict project scope/);
    const missing = { ...input, values: {} };
    assert.match(JSON.stringify(await run(missing)), /Missing:/);
    assert.deepEqual(writes, []);
    assert.equal((await db.query<{ content: string }>('SELECT content FROM notes WHERE id = $1', [source])).rows[0]!.content, 'Original source');
  } finally { await db.close(); }
});
