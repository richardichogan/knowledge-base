import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema, type Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { scriptBackspace } from '../src/notes/scriptBackspace';

const schema = new Schema({ nodes: {
  doc: { content: 'blockGroup' },
  blockGroup: { content: 'blockContainer+' },
  blockContainer: { attrs: { id: { default: null } }, content: '(heading|paragraph|bulletListItem) blockGroup?' },
  heading: { attrs: { scriptSection: { default: false } }, content: 'inline*' },
  paragraph: { content: 'inline*' }, bulletListItem: { content: 'inline*' },
  mention: { group: 'inline', inline: true, atom: true, attrs: { id: {} } },
  text: { group: 'inline' },
}, marks: { bold: {} } });
const block = (id: string, type: string, text = '', children: Node[] = []): Node =>
  schema.node('blockContainer', { id }, [
    schema.node(type, type === 'heading' ? { scriptSection: true } : null, text ? schema.text(text) : null),
    ...(children.length ? [schema.node('blockGroup', null, children)] : []),
  ]);
function fixture(children: Node[], id: string) {
  const doc = schema.node('doc', null, schema.node('blockGroup', null, [
    block('section', 'heading', 'Section', children), block('other', 'heading', 'Other', [block('untouched', 'paragraph', 'Keep')]),
  ]));
  let position = -1;
  doc.descendants((node, pos) => { if (node.attrs['id'] === id) position = pos + 2; });
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, position) });
  return {
    get state() { return state; },
    backspace() { return scriptBackspace(state, transaction => { state = state.apply(transaction); }); },
  };
}
test('repeated Backspace joins inside the card without lifting following blocks', () => {
  const f = fixture([block('first', 'paragraph'), block('second', 'paragraph'),
    block('third', 'paragraph', 'Keep this')], 'second');
  assert.equal(f.backspace(), true);
  assert.equal(f.backspace(), true);
  const sections = f.state.doc.firstChild!;
  const body = sections.firstChild!.lastChild!;
  assert.deepEqual(Array.from({ length: body.childCount }, (_, i) => body.child(i).attrs['id']), ['first', 'third']);
  assert.equal(body.child(1).textContent, 'Keep this');
  assert.equal(sections.child(1).textContent, 'OtherKeep');
});
test('bullet conversion and genuine nested unindent remain native', () => {
  assert.equal(fixture([block('bullet', 'bulletListItem', 'Item')], 'bullet').backspace(), false);
  assert.equal(fixture([block('parent', 'bulletListItem', 'Parent', [block('nested', 'paragraph', 'Child')])], 'nested').backspace(), false);
});
test('merges preserve marks, mentions and children of the removed paragraph', () => {
  const rich = schema.node('blockContainer', { id: 'rich' }, schema.node('paragraph', null, [
    schema.text('Bold', [schema.mark('bold')]), schema.node('mention', { id: 'project' }),
  ]));
  const f = fixture([rich, block('remove', 'paragraph', 'More', [block('child', 'bulletListItem', 'Child')]),
    block('following', 'paragraph', 'Following')], 'remove');
  assert.equal(f.backspace(), true);
  const body = f.state.doc.firstChild!.firstChild!.lastChild!;
  assert.equal(body.firstChild!.firstChild!.firstChild!.marks[0]?.type.name, 'bold');
  assert.equal(body.firstChild!.firstChild!.child(1).attrs['id'], 'project');
  assert.equal(body.child(1).attrs['id'], 'child');
  assert.equal(body.child(2).attrs['id'], 'following');
  assert.equal(f.state.selection.$from.parentOffset, 5);
});
