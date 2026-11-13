import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lexer, type Tokens } from 'marked';
import { demoSpecificationForm, demoSpecificationResponseSchema, renderDemoSpecification, validateDemoSpecificationPart, DEMO_SPECIFICATION_VERSION } from '../src/ai/demoSpecification.js';
import { DEMO_SPECIFICATION_TEMPLATE } from '../src/ai/demoSpecificationTemplate.js';
import { textToBlocks } from '../src/ai/markdownToNoteBlocks.js';

const form = demoSpecificationForm() as {
  fields: { id: string; label: string }[];
  tables: { id: string; headers: string[] }[];
};
const sources = { noteUrl: 'https://example.test/think?noteId=source', chatUrl: 'https://example.test/chat?session=conversation' };
const makeInput = () => ({
  templateVersion: DEMO_SPECIFICATION_VERSION, name: 'Claims recovery',
  values: Object.fromEntries(form.fields.map(field => [field.id, `Unresolved - owner not assigned; blocks ${field.id}; resolve by owner review.`])),
});
test('Design IMAGINE response contract includes every mandatory field and repeatable table', () => {
  const schema = demoSpecificationResponseSchema().schema as {
    properties: { values: { required: string[] }; additionalRows: { required: string[] }; sectionDetails: { required: string[] } };
  };
  assert.deepEqual(schema.properties.values.required, form.fields.map(field => field.id));
  assert.deepEqual(schema.properties.additionalRows.required, form.tables.map(table => table.id));
  assert.equal(schema.properties.sectionDetails.required.length, 10);
});
test('section groups partition the full form without losing fields or accepting incomplete groups', () => {
  const fieldIds: string[] = [];
  const tableIds: string[] = [];
  for (const sections of [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]) {
    const group = demoSpecificationForm(sections) as typeof form;
    fieldIds.push(...group.fields.map(field => field.id));
    tableIds.push(...group.tables.map(table => table.id));
    const input = {
      name: 'Claims',
      values: Object.fromEntries(group.fields.map(field => [field.id, 'Unresolved - owner decision required.'])),
      additionalRows: Object.fromEntries(group.tables.map(table => [table.id, []])),
      sectionDetails: Object.fromEntries(sections.map(section => [String(section), 'Proposed - confirm with the business owner.'])),
    };
    assert.equal(validateDemoSpecificationPart(input, sections).name, 'Claims');
    assert.throws(() => validateDemoSpecificationPart({ ...input, sectionDetails: {} }, sections), /exactly/);
    assert.throws(() => validateDemoSpecificationPart({ ...input, values: { ...input.values, invented: 'value' } }, sections), /exactly/);
  }
  assert.deepEqual(fieldIds, form.fields.map(field => field.id));
  assert.deepEqual(tableIds, form.tables.map(table => table.id));
  assert.equal(new Set(fieldIds).size, fieldIds.length);
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