import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { createContext, runInContext } from 'node:vm';

test('right-click spelling supports prose fields and honours technical, disabled and rich-code exclusions', async () => {
  const source = await readFile(new URL('../src/context/GlobalContextMenu.tsx', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'tsx', format: 'cjs' });
  class Field {
    type = 'text'; readOnly = false; disabled = false;
    spelling: string | null = null;
    value = 'Please recieve this'; selectionStart = 7; selectionEnd = 7;
    closest(selector: string): Field | null {
      if (selector === 'input, textarea') return this;
      if (selector === '[spellcheck]' && this.spelling !== null) return this;
      return null;
    }
    getAttribute(): string | null { return this.spelling; }
  }
  const root = { contains: () => true };
  let code = false;
  const rich = { closest: (selector: string) => {
    if (selector === '[contenteditable="true"]') return root;
    if (selector.startsWith('pre, code') && code) return root;
    return null;
  } };
  const node = { nodeType: 3, data: 'recieve', parentElement: rich };
  class TextArea extends Field { type = 'textarea'; }
  let start = 0, end = 0;
  const document = {
    // Firefox-style caret API; no caretRangeFromPoint.
    caretPositionFromPoint: () => ({ offsetNode: node, offset: 3 }),
    createRange: () => ({
      startContainer: node, startOffset: 3,
      setStart: (_node: unknown, value: number) => { start = value; },
      setEnd: (_node: unknown, value: number) => { end = value; },
      collapse: () => {},
      getClientRects: () => [{ left: 0, right: 90, top: 0, bottom: 20 }],
      toString: () => node.data.slice(start, end),
    }),
  };
  const module = { exports: {} as { wordAtPoint(target: unknown, x: number, y: number): { word: string } | null } };
  const context = createContext({ module, exports: module.exports, document,
    window: { getSelection: () => null }, navigator: { platform: 'Windows' },
    HTMLInputElement: Field, HTMLTextAreaElement: TextArea, Node: { TEXT_NODE: 3 },
    require: (name: string) => name === 'react' ? { createContext: () => ({}) }
      : name.endsWith('/spelling') ? { isSpellableWord: (word: string) => /^[a-z]{2,60}$/i.test(word) } : {},
  });
  runInContext(compiled.code, context);
  const field = new Field();
  assert.equal(module.exports.wordAtPoint(field, 1, 1)?.word, 'recieve');
  field.selectionEnd = 14;
  assert.equal(module.exports.wordAtPoint(field, 1, 1)?.word, 'recieve');
  field.selectionEnd = 19;
  assert.equal(module.exports.wordAtPoint(field, 1, 1), null);
  field.selectionEnd = 7;
  for (const type of ['password', 'email', 'url', 'tel']) {
    field.type = type;
    assert.equal(module.exports.wordAtPoint(field, 1, 1), null, `Exclude ${type} fields`);
  }
  field.type = 'search';
  assert.equal(module.exports.wordAtPoint(field, 1, 1)?.word, 'recieve');
  field.spelling = 'false';
  assert.equal(module.exports.wordAtPoint(field, 1, 1), null, 'Explicit opt-outs apply to the custom menu too');
  field.spelling = 'true';
  assert.equal(module.exports.wordAtPoint(field, 1, 1)?.word, 'recieve');
  field.disabled = true;
  assert.equal(module.exports.wordAtPoint(field, 1, 1), null);
  field.disabled = false; field.readOnly = true;
  assert.equal(module.exports.wordAtPoint(field, 1, 1), null);
  const textarea = new TextArea();
  assert.equal(module.exports.wordAtPoint(textarea, 1, 1)?.word, 'recieve');
  textarea.spelling = 'false';
  assert.equal(module.exports.wordAtPoint(textarea, 1, 1), null, 'Raw HTML and other opted-out textareas are excluded');
  assert.equal(module.exports.wordAtPoint(rich, 5, 5)?.word, 'recieve');
  assert.equal(module.exports.wordAtPoint(rich, 500, 500), null, 'Do not correct a nearby word when right-clicking blank space');
  code = true;
  assert.equal(module.exports.wordAtPoint(rich, 5, 5), null, 'Code inside a rich editor is not prose');
  const editor = { closest: (selector: string) => selector === '[contenteditable="true"]' ? root : null };
  assert.equal(module.exports.wordAtPoint(editor, 5, 5), null, 'A caret inside code is excluded even when the event targets the editor');
});
