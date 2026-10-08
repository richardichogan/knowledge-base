import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textToBlocks } from '../src/ai/markdownToNoteBlocks.js';
import { IMAGINE_DEMO_BRIEF_TEMPLATE } from '../src/ai/imagineDemoBriefSkill.js';

test('screenshot regression: consecutive headings and lists become real editor blocks', () => {
  const result = textToBlocks('# IMAGINE: Client Report Assurance\n## High fidelity prototype specification\nVersion: 0.1\n\n## 1. Purpose and outcome\nBuild a prototype.\n\nProvisional assumptions:\n- First assumption\n- Second assumption');
  assert.deepEqual(result.map(block => block.type), ['heading', 'heading', 'paragraph', 'heading', 'paragraph', 'paragraph', 'bulletListItem', 'bulletListItem']);
  assert.equal(result[0]?.type === 'heading' && result[0].props?.level, 1);
  assert.equal(result[1]?.type === 'heading' && result[1].props?.level, 2);
  assert.ok(!JSON.stringify(result).includes('## '));
});

test('complete IMAGINE brief retains nine sections and both native tables', () => {
  const result = textToBlocks(IMAGINE_DEMO_BRIEF_TEMPLATE);
  assert.equal(result.filter(block => block.type === 'heading').length, 11);
  const tables = result.filter(block => block.type === 'table');
  assert.equal(tables.length, 2);
  assert.equal(tables[0]?.content.rows.length, 4);
  assert.equal(tables[1]?.content.rows.length, 5);
  assert.equal(tables[0]?.content.headerRows, 1);
  assert.ok(result.some(block => block.type === 'quote'));
});

test('nested lists, checkboxes, ordered starts, links and combined styles survive', () => {
  const result = textToBlocks('- **Strong and _emphasis_**\n  - Child\n- [x] Completed\n- [ ] Waiting\n\n3. Third\n4. Fourth\n\n[Policy](https://example.test/policy) and ~~obsolete~~ and `a*b`.');
  assert.equal(result[0]?.type, 'bulletListItem');
  const first = result[0];
  assert.ok(first?.type === 'bulletListItem' && first.children?.[0]?.type === 'bulletListItem');
  assert.ok(first?.type === 'bulletListItem' && first.content.some(part => part.type === 'text' && part.styles.bold && part.styles.italic));
  assert.ok(result.some(block => block.type === 'checkListItem' && block.props?.checked === true));
  assert.ok(result.some(block => block.type === 'checkListItem' && block.props?.checked === false));
  assert.ok(result.some(block => block.type === 'numberedListItem' && block.props?.start === 3));
  const paragraph = result.at(-1);
  assert.ok(paragraph?.type === 'paragraph' && paragraph.content.some(part => part.type === 'link' && part.href === 'https://example.test/policy'));
  assert.ok(paragraph?.type === 'paragraph' && paragraph.content.some(part => part.type === 'text' && part.styles.strike));
});

test('code and plain text are preserved; HTML and unsafe URLs do not execute', () => {
  const source = 'Literal **not bold**\n## not heading\n\n```inner\nnested\n```';
  const result = textToBlocks(`~~~~text\n${source}\n~~~~\n\n<script>alert("no")</script>\n\n[bad](javascript:alert%281%29)\n\nPlain paragraph.\nStill here.`);
  const code = result[0];
  assert.equal(code?.type === 'codeBlock' && code.content[0]?.type === 'text' && code.content[0].text, source);
  assert.ok(!JSON.stringify(result).includes('"href":"javascript:'));
  assert.ok(JSON.stringify(result).includes('<script>'));
  assert.deepEqual(textToBlocks(''), []);
  assert.equal(textToBlocks('Plain text')[0]?.type, 'paragraph');
});

test('Markdown entities decode once while code retains literal entity text', () => {
  const result = textToBlocks('A &amp; B &lt; C &amp;amp; `&amp;` [query](https://example.test/?a=1&amp;b=2)');
  const paragraph = result[0];
  assert.ok(paragraph?.type === 'paragraph');
  assert.ok(paragraph.content.some(part => part.type === 'text' && part.text.includes('A & B < C &amp;')));
  assert.ok(paragraph.content.some(part => part.type === 'text' && part.styles.code && part.text === '&amp;'));
  assert.ok(paragraph.content.some(part => part.type === 'link' && part.href === 'https://example.test/?a=1&b=2'));
});
