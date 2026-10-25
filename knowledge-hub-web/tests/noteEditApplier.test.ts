import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNoteEdits } from '../src/utils/noteEditApplier';
import type { NoteEdit } from '../src/types';

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; href?: string; content?: Inline[] };
interface Block { id: string; type: string; props?: Record<string, unknown>; content: Inline[]; children?: Block[] }
const text = (value: string, styles = {}): Inline => ({ type: 'text', text: value, styles });
const title = (): Block => ({ id: 'title', type: 'heading', props: { level: 1 }, content: [text('Guest guide')] });

function fixture(document: Block[]) {
  const editor = {
    document: structuredClone(document),
    updateBlock(block: Block, update: Partial<Block>): Block {
      const target = this.document.flatMap(b => [b, ...(b.children ?? [])]).find(b => b.id === block.id);
      assert.ok(target);
      Object.assign(target, update);
      return target;
    },
    tryParseMarkdownToBlocks(markdown: string): Block[] {
      return markdown.split('\n').filter(Boolean).map((line, i) => ({
        id: `parsed-${i}`, type: line.startsWith('# ') ? 'heading' : 'paragraph',
        content: [text(line.replace(/^# /, ''))],
      }));
    },
    replaceBlocks(removed: Block[], added: Block[]): void {
      this.document = this.document.filter(b => !removed.some(r => r.id === b.id));
      this.document.push(...added);
    },
    transact(action: () => void): void { action(); },
  };
  // This adapter intentionally implements only the editor operations exercised here.
  const apply = (edits: NoteEdit[]) => applyNoteEdits(editor as unknown as Parameters<typeof applyNoteEdits>[0], edits);
  return { editor, apply };
}

test('wording corrections preserve rich inline styles, links, block identity, list props and children', () => {
  const paragraph: Block = { id: 'instructions', type: 'numberedListItem', props: { start: 3 }, content: [
    text('Tunr', { bold: true }), text(' the '),
    { type: 'link', href: 'https://example.com/help', content: [text('ligts', { italic: true })] },
    text(' on.'),
  ], children: [{ id: 'nested', type: 'bulletListItem', content: [text('Unchanged detail')] }] };
  const { editor, apply } = fixture([title(), paragraph]);
  const result = apply([
    { action: 'replace_text', find: 'Tunr', markdown: 'Turn', summary: 'Correct typo' },
    { action: 'replace_text', find: 'ligts', markdown: 'lights', summary: 'Correct linked wording' },
  ]);
  assert.deepEqual(result, { applied: 2, failed: [] });
  assert.deepEqual(editor.document[1], { ...paragraph, content: [
    text('Turn', { bold: true }), text(' the '),
    { type: 'link', href: 'https://example.com/help', content: [text('lights', { italic: true })] },
    text(' on.'),
  ] });
  assert.deepEqual(editor.document[0], title());
});

test('an authorised whole-body redraft preserves the original title heading', () => {
  const { editor, apply } = fixture([title(), { id: 'body', type: 'paragraph', content: [text('Old body')] }]);
  assert.equal(apply([{ action: 'replace_all', markdown: '# Wi-Fi\nNew instructions', summary: 'Redraft body' }]).applied, 1);
  assert.deepEqual(editor.document[0], title());
  assert.equal(editor.document[1]?.content[0]?.text, 'Wi-Fi', 'a section must not replace the title');
});

test('title edits, ambiguous matches, stale passages and multiline replacements fail without changing blocks', () => {
  for (const edit of [
    { action: 'replace_text', find: 'Guest guide', markdown: 'Wi-Fi', summary: 'Rename title' },
    { action: 'replace_text', find: 'same', markdown: 'changed', summary: 'Ambiguous' },
    { action: 'replace_text', find: 'missing', markdown: 'changed', summary: 'Stale' },
    { action: 'replace_text', find: 'First', markdown: 'First\nSecond', summary: 'Restructure' },
    { action: 'delete_section', heading: 'Guest guide', summary: 'Delete title' },
  ] satisfies NoteEdit[]) {
    const original = [title(), { id: 'a', type: 'paragraph', content: [text('First same same')] }];
    const { editor, apply } = fixture(original);
    assert.equal(apply([edit]).applied, 0);
    assert.deepEqual(editor.document, original);
  }
});
