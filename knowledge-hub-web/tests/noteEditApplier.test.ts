import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNoteEdits } from '../src/utils/noteEditApplier';
import type { NoteEdit } from '../src/types';
import { groupScriptSections, ungroupScriptSections, splitScriptSectionTail } from '../../knowledge-hub-backend/src/utils/scriptSections';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { preserveScriptSelection } from '../src/notes/scriptSectionSelection';
import { scriptVisualSource } from '../../knowledge-hub-backend/src/utils/scriptVisuals';
import { parseScriptVisualJobResult, scriptVisualJobEdits, scriptVisualSnapshot } from '../../knowledge-hub-backend/src/utils/scriptVisualJobs';

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; props?: Record<string, unknown>; href?: string; content?: Inline[] };
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
      const index = this.document.findIndex(b => removed.some(r => r.id === b.id));
      assert.ok(index >= 0);
      this.document = [...this.document.slice(0, index), ...added,
        ...this.document.slice(index).filter(b => !removed.some(r => r.id === b.id))];
    },
    insertBlocks(added: Block[], anchor: Block, placement: 'before' | 'after'): void {
      const index = this.document.findIndex(b => b.id === anchor.id);
      assert.ok(index >= 0);
      this.document.splice(index + (placement === 'after' ? 1 : 0), 0, ...added);
    },
    removeBlocks(removed: Block[]): void {
      this.document = this.document.filter(b => !removed.some(r => r.id === b.id));
    },
    transact(action: () => void): void { action(); },
  };
  // This adapter intentionally implements only the editor operations exercised here.
  const apply = (edits: NoteEdit[], script = false) => applyNoteEdits(editor as unknown as Parameters<typeof applyNoteEdits>[0], edits, { script });
  return { editor, apply };
}

test('visual-only edits preserve the section, rich spoken blocks and unrelated metadata, and reject concurrent changes', () => {
  const section: Block = { id: 'section', type: 'heading', props: { level: 2, scriptSection: true, scriptVisuals: '', textColor: 'default' },
    content: [text('Opening')], children: [{ id: 'spoken', type: 'paragraph', content: [text('Explain this idea.', { bold: true })] }] };
  const original = structuredClone(section);
  const visuals = { version: 1 as const, source: scriptVisualSource(section), scenes: [{
    id: 'scene', template: 'title' as const, title: 'One clear idea', subtitle: '', imageUrl: '', imageAlt: '', presenterLayout: true,
    cue: { blockId: 'spoken', quote: '' }, items: [],
  }] };
  const { editor, apply } = fixture([section]);
  const edit: NoteEdit = { action: 'set_script_visuals', sectionId: section.id, expectedVisuals: '', visuals, summary: 'Explain the idea visually' };
  assert.deepEqual(apply([edit], true), { applied: 1, failed: [] });
  assert.deepEqual(editor.document[0]?.children, original.children);
  assert.deepEqual(editor.document[0]?.content, original.content);
  assert.equal(editor.document[0]?.props?.['textColor'], 'default');
  assert.equal(JSON.parse(String(editor.document[0]?.props?.['scriptVisuals'])).scenes[0].presenterLayout, true);
  assert.equal(apply([edit], true).applied, 0);
  const changed = fixture([{ ...section, children: [{ id: 'spoken', type: 'paragraph', content: [text('New wording.')] }] }]);
  assert.equal(changed.apply([edit], true).applied, 0);
  assert.equal(changed.editor.document[0]?.props?.['scriptVisuals'], '');
});

function visualDraft(section: Block) {
  return { section: structuredClone(section), expectedVisuals: String(section.props?.['scriptVisuals'] ?? ''),
    visuals: { version: 1 as const, source: scriptVisualSource(section), scenes: [{
      id: `scene-${section.id}`, template: 'title' as const, title: 'A clear concept', subtitle: '', imageUrl: '', imageAlt: '',
      cue: { blockId: section.children![0]!.id, quote: '' }, items: [],
    }] } };
}
const visualSection = (id: string): Block => ({ id, type: 'heading',
  props: { scriptSection: true, scriptVisuals: '', level: 2, textColor: 'default' }, content: [text(id)],
  children: [{ id: `${id}-body`, type: 'paragraph', content: [text(`Explain ${id}.`, { bold: true })] }] });

test('pending visual results survive serialization without editing the script and apply through normal protected edits', () => {
  const section = visualSection('opening');
  const draft = visualDraft(section);
  const before = structuredClone(section);
  const result = parseScriptVisualJobResult(JSON.parse(JSON.stringify({ noteId: 'note', sections: [draft] })), 'note');
  assert.deepEqual(section, before);
  const other = visualSection('unrelated');
  other.children![0]!.content = [text('Work completed while Ariadne was running.')];
  const { editor, apply } = fixture([section, other]);
  editor.document[0]!.children![0]!.content[0]!.styles = { bold: true, italic: true };
  const retainedBody = structuredClone(editor.document[0]!.children);
  const edits = scriptVisualJobEdits(result, editor.document);
  assert.deepEqual(apply(edits, true), { applied: 1, failed: [] });
  assert.deepEqual(editor.document[0]!.children, retainedBody);
  assert.deepEqual(editor.document[1], other);
  assert.deepEqual(scriptVisualJobEdits(result, editor.document), []);
});

test('all sections are preflighted before applying a pending result, including late live-editor conflicts', () => {
  const first = visualSection('first'), second = visualSection('second');
  const result = parseScriptVisualJobResult({ noteId: 'note', sections: [visualDraft(first), visualDraft(second)] }, 'note');
  const { editor, apply } = fixture([first, second]);
  const edits = scriptVisualJobEdits(result, editor.document);
  editor.document[1]!.children![0]!.content = [text('Changed after the result was read.')];
  assert.throws(() => scriptVisualJobEdits(result, editor.document), /changed|removed/);
  const applied = apply(edits, true);
  assert.equal(applied.applied, 0);
  assert.equal(applied.failed.length, 1);
  assert.equal(editor.document[0]!.props!['scriptVisuals'], '');
  assert.equal(editor.document[1]!.props!['scriptVisuals'], '');
  assert.throws(() => scriptVisualJobEdits(result, [first]), /changed|removed/);
});

test('pending results reject foreign notes, duplicate sections, invalid cues and independently changed visuals', () => {
  const section = visualSection('section');
  const draft = visualDraft(section);
  const raw = { noteId: 'note', sections: [draft] };
  assert.throws(() => parseScriptVisualJobResult(raw, 'another-note'), /belong/);
  assert.throws(() => parseScriptVisualJobResult({ ...raw, sections: [draft, draft] }, 'note'), /repeats/);
  assert.throws(() => parseScriptVisualJobResult({ ...raw, sections: [{ ...draft, expectedVisuals: 'invented' }] }, 'note'), /snapshot/);
  const invalid = structuredClone(raw);
  invalid.sections[0]!.visuals.scenes[0]!.cue.blockId = 'removed';
  assert.throws(() => parseScriptVisualJobResult(invalid, 'note'), /cue/);
  const result = parseScriptVisualJobResult(raw, 'note');
  const changed = structuredClone(section);
  changed.props!['scriptVisuals'] = JSON.stringify({ ...draft.visuals, scenes: [{ ...draft.visuals.scenes[0], title: 'Independently revised' }] });
  assert.throws(() => scriptVisualJobEdits(result, [changed]), /visuals changed/);
  const renamed = structuredClone(section);
  renamed.content = [text('New chapter')];
  assert.throws(() => scriptVisualJobEdits(result, [renamed]), /changed/);
  assert.throws(() => scriptVisualSnapshot({ ...section, type: 'paragraph' }), /populated/);
  assert.throws(() => parseScriptVisualJobResult({ ...raw, sections: [] }, 'note'), /belong/);
});

test('heading-to-card conversion is lossless, immutable and idempotent across levels and preamble', () => {
  const original: Block[] = [
    { id: 'preamble-body', type: 'paragraph', content: [text('Before the title.')] },
    title(),
    { id: 'body', type: 'paragraph', props: { textAlignment: 'right' }, content: [
      text('Yellow', { textColor: '#f1c21b' }), { type: 'scriptCue', props: { cue: 'pause' } },
      { type: 'entityMention', props: { entityId: 'project', label: 'Imagine' } },
    ], children: [{ id: 'nested', type: 'bulletListItem', content: [text('Keep nested content.')] }] },
    { id: 'chapter', type: 'heading', props: { level: 3 }, content: [text('Chapter', { italic: true })] },
    { id: 'closing', type: 'paragraph', content: [text('Finish.')] },
  ];
  const before = structuredClone(original);
  const create = (): Block => ({ id: 'preamble', type: 'heading', props: { level: 2, scriptSection: true }, content: [], children: [] });
  const cards = groupScriptSections(original, create);
  assert.deepEqual(original, before);
  assert.deepEqual(cards.map(block => block.id), ['preamble', 'title', 'chapter']);
  assert.deepEqual(cards[0]?.children, [original[0]]);
  assert.deepEqual(cards[1]?.children, [original[2]]);
  assert.deepEqual(cards[2]?.children, [original[4]]);
  assert.deepEqual(cards[2]?.content, original[3]?.content);
  assert.deepEqual(groupScriptSections(cards, create), cards);
  assert.deepEqual(groupScriptSections([], create), [create()]);
});

test('ungrouping card-owned bodies does not promote ordinary nested headings when regrouping', () => {
  const cards: Block[] = [{ id: 'section', type: 'heading',
    props: { level: 2, scriptSection: true, scriptDirection: 'Slowly' }, content: [text('Opening')], children: [
      { id: 'subheading', type: 'heading', props: { level: 3 }, content: [text('An existing nested label')] },
      { id: 'body', type: 'paragraph', content: [text('Speak this.')] },
    ] }];
  assert.deepEqual(groupScriptSections(ungroupScriptSections(cards), () => title(), { markedOnly: true }), cards);
});

test('normalisation and Athena appends retain the required empty root paragraph instead of repeatedly absorbing it into a card', () => {
  const cards: Block[] = [{ ...title(), props: { level: 1, scriptSection: true }, children: [
    { id: 'spoken', type: 'paragraph', content: [text('Welcome.')] },
  ] }, { id: 'trailing', type: 'paragraph', content: [], children: [] }];
  const { body, tail } = splitScriptSectionTail(cards);
  assert.deepEqual(body, [cards[0]]);
  assert.deepEqual(tail, [cards[1]]);
  assert.deepEqual([...groupScriptSections(body, title), ...tail], cards);
  const { editor, apply } = fixture(cards);
  assert.equal(apply([{ action: 'append', markdown: 'More words.', summary: 'Continue the script' }], true).applied, 1);
  assert.deepEqual(editor.document.at(-1), cards[1]);
  assert.deepEqual(editor.document[0]?.children?.map(block => block.content[0]?.text), ['Welcome.', 'More words.']);
});

test('Athena exact-body edits preserve the card IDs, stored metadata, cues and rich content', () => {
  const original: Block[] = [{ ...title(), props: { level: 1, scriptSection: true, scriptDirection: 'Warmly' }, children: [
    { id: 'body', type: 'paragraph', content: [text('Helo', { bold: true, textColor: '#f1c21b' }), { type: 'scriptCue', props: { cue: 'beat' } }] },
  ] }];
  const { editor, apply } = fixture(original);
  assert.equal(apply([{ action: 'replace_text', find: 'Helo', markdown: 'Hello', summary: 'Correct the opening' }], true).applied, 1);
  assert.deepEqual(editor.document[0]?.children?.[0]?.content, [
    text('Hello', { bold: true, textColor: '#f1c21b' }), { type: 'scriptCue', props: { cue: 'beat' } },
  ]);
  assert.equal(editor.document[0]?.props?.['scriptDirection'], 'Warmly');
});

test('card conversion and reordering retain a backwards text selection by stable body IDs in the active transaction', () => {
  const schema = new Schema({ nodes: {
    doc: { content: 'blockGroup' },
    blockGroup: { content: 'blockContainer+' },
    blockContainer: { attrs: { id: { default: null } }, content: '(heading|paragraph) blockGroup?' },
    heading: { content: 'text*' }, paragraph: { content: 'text*' }, text: { group: 'inline' },
  } });
  const block = (id: string, type: 'heading' | 'paragraph', text: string) =>
    schema.node('blockContainer', { id }, [schema.node(type, null, schema.text(text))]);
  const firstTitle = block('first', 'heading', 'First');
  const firstBody = block('first-body', 'paragraph', 'First words');
  const secondTitle = block('second', 'heading', 'Second');
  const secondBody = block('second-body', 'paragraph', 'Second words');
  const doc = schema.node('doc', null, schema.node('blockGroup', null, [firstTitle, firstBody, secondTitle, secondBody]));
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => { if (node.type.name === 'blockContainer') positions.set(String(node.attrs['id']), pos + 2); });
  const transaction = EditorState.create({ schema, doc }).tr;
  transaction.setSelection(TextSelection.create(doc, positions.get('second-body')! + 6, positions.get('first-body')! + 2));
  const firstCard = schema.node('blockContainer', { id: 'first' }, [firstTitle.firstChild!, schema.node('blockGroup', null, [firstBody])]);
  const secondCard = schema.node('blockContainer', { id: 'second' }, [secondTitle.firstChild!, schema.node('blockGroup', null, [secondBody])]);
  for (const cards of [[firstCard, secondCard], [secondCard, firstCard]]) {
    preserveScriptSelection(transaction, () => {
      transaction.replaceWith(0, transaction.doc.content.size, schema.node('blockGroup', null, cards));
    });
    assert.equal(transaction.selection.$anchor.parent.textContent, 'Second words');
    assert.equal(transaction.selection.$anchor.parentOffset, 6);
    assert.equal(transaction.selection.$head.parent.textContent, 'First words');
    assert.equal(transaction.selection.$head.parentOffset, 2);
  }
});

test('Athena section rewrites preserve card identity/directions and respect card boundaries regardless of heading level', () => {
  const cards: Block[] = [
    { ...title(), props: { level: 1, scriptSection: true }, children: [{ id: 'intro', type: 'paragraph', content: [text('Welcome.')] }] },
    { id: 'second', type: 'heading', props: { level: 2, scriptSection: true, scriptDirection: 'Firmly' }, content: [text('Details')],
      children: [{ id: 'details', type: 'paragraph', content: [text('Old details.')] }] },
    { id: 'third', type: 'heading', props: { level: 3, scriptSection: true, scriptDirection: 'Quietly' }, content: [text('Closing')],
      children: [{ id: 'close', type: 'paragraph', content: [text('Untouched closing.')] }] },
  ];
  const { editor, apply } = fixture(cards);
  assert.equal(apply([{ action: 'replace_section', heading: 'Details', markdown: '# New details\nNew body.', summary: 'Rewrite details' }], true).applied, 1);
  assert.equal(editor.document[1]?.id, 'second');
  assert.equal(editor.document[1]?.props?.['scriptDirection'], 'Firmly');
  assert.equal(editor.document[1]?.children?.[0]?.content[0]?.text, 'New body.');
  assert.deepEqual(editor.document[0], cards[0]);
  assert.deepEqual(editor.document[2], cards[2]);
});

test('Athena can edit script wording, colour and cues without disturbing the rest of the paragraph', () => {
  const cue: Inline = { type: 'scriptCue', props: { cue: 'pause' } };
  const opening = text('Opening ', { textColor: '#3ddbd9', bold: true });
  const { editor, apply } = fixture([title(), { id: 'script', type: 'paragraph', content: [opening, cue, text(' Next point.')] }]);
  assert.equal(apply([{ action: 'replace_text', find: 'Next', markdown: '[colour=pink]New[/colour]', summary: 'Emphasise wording' }], true).applied, 1);
  assert.deepEqual(editor.document[1]?.content, [opening, cue, text(' '), text('New', { textColor: '#ff7eb6' }), text(' point.')]);
  assert.equal(apply([{ action: 'replace_text', find: '[pause]', markdown: '[beat]', summary: 'Shorten the cue' }], true).applied, 1);
  assert.deepEqual(editor.document[1]?.content[1], { type: 'scriptCue', props: { cue: 'beat' } });
  const before = structuredClone(editor.document);
  const malformed = apply([{ action: 'replace_text', find: 'point', markdown: '[colour=teal]open', summary: 'Invalid colour' }], true);
  assert.equal(malformed.applied, 0);
  assert.match(malformed.failed[0]!, /Close each/);
  assert.deepEqual(editor.document, before);
});

test('normal note edits do not interpret script annotation syntax', () => {
  const { editor, apply } = fixture([title(), { id: 'body', type: 'paragraph', content: [text('Example')] }]);
  assert.equal(apply([{ action: 'replace_text', find: 'Example', markdown: '[pause]', summary: 'Literal token' }]).applied, 1);
  assert.deepEqual(editor.document[1]?.content, [text('[pause]')]);
});

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

test('Athena text edits preserve passage tags and structural redrafts refuse to erase them', () => {
  const tag = '11111111-1111-4111-8111-111111111111';
  const original: Block[] = [title(), { id: 'section', type: 'heading', props: { level: 2 }, content: [text('Details')] },
    { id: 'body', type: 'paragraph', content: [text('Review this', { followUp: tag })] }];
  const { editor, apply } = fixture(original);
  const corrected = apply([{ action: 'replace_text', find: 'Review', markdown: 'Check', summary: 'Improve wording' }]);
  assert.equal(corrected.applied, 1);
  assert.deepEqual(editor.document[2]?.content, [text('Check this', { followUp: tag })]);
  const before = structuredClone(editor.document);
  const deleted = apply([{ action: 'delete_section', heading: 'Details', summary: 'Delete section' }]);
  assert.equal(deleted.applied, 0);
  assert.match(deleted.failed[0]!, /tagged passages/);
  assert.deepEqual(editor.document, before);
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
