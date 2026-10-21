import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { createContext, runInContext } from 'node:vm';

test('right-click spelling targets collapsed or selected whole words, not multiword selections or passwords', async () => {
  const source = await readFile(new URL('../src/context/GlobalContextMenu.tsx', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'tsx', format: 'cjs' });
  class Field {
    type = 'text'; readOnly = false; disabled = false;
    value = 'Please recieve this'; selectionStart = 7; selectionEnd = 7;
    closest(selector: string): Field | null { return selector === 'input, textarea' ? this : null; }
  }
  const node = { nodeType: 3, data: 'recieve' };
  const root = { contains: () => true };
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
    HTMLInputElement: Field, HTMLTextAreaElement: class {}, Node: { TEXT_NODE: 3 },
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
  field.selectionEnd = 7; field.type = 'password';
  assert.equal(module.exports.wordAtPoint(field, 1, 1), null);
  const rich = { closest: (selector: string) => selector.includes('contenteditable') ? root : null };
  assert.equal(module.exports.wordAtPoint(rich, 5, 5)?.word, 'recieve');
  assert.equal(module.exports.wordAtPoint(rich, 500, 500), null, 'Do not correct a nearby word when right-clicking blank space');
});
