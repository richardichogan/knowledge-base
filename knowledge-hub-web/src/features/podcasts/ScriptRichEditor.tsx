import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Extension, Mark, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { history, undo, redo } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';
import { baseKeymap } from '@tiptap/pm/commands';
import { keymap } from '@tiptap/pm/keymap';
import { Slice } from '@tiptap/pm/model';
import { SCRIPT_COLOURS } from './scriptAnnotations';
import { SCRIPT_BLOCK_STYLES, scriptRichDocument, scriptRichText } from './scriptRichText';
import { parseScriptBullets } from './scriptFormatting';

export interface ScriptPassage { text: string; start: number; end: number; original: string }

const DocumentNode = Node.create({ name: 'doc', topNode: true, content: 'block+' });
const Paragraph = Node.create({
  name: 'paragraph', group: 'block', content: 'inline*',
  parseHTML: () => [{ tag: 'p' }, { tag: 'div' }],
  renderHTML: () => ['p', 0],
});
const TextNode = Node.create({ name: 'text', group: 'inline' });
const Heading = Node.create({
  name: 'heading', group: 'block', content: 'inline*', defining: true,
  addAttributes: () => ({ level: { default: 1 } }),
  parseHTML: () => [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node }) => [`h${String(node.attrs['level'])}`, { 'data-script-heading': 'true' }, 0],
});
const BulletList = Node.create({
  name: 'bulletList', group: 'block', content: 'listItem+',
  parseHTML: () => [{ tag: 'ul' }, { tag: 'ol' }], renderHTML: () => ['ul', 0],
});
const ListItem = Node.create({
  name: 'listItem', content: '(paragraph|heading)+',
  parseHTML: () => [{ tag: 'li' }], renderHTML: () => ['li', 0],
});
const HardBreak = Node.create({
  name: 'hardBreak', inline: true, group: 'inline', selectable: false,
  parseHTML: () => [{ tag: 'br' }], renderHTML: () => ['br'],
  addKeyboardShortcuts() { return { 'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak' }) }; },
});
const Colour = Mark.create({
  name: 'scriptColour',
  addAttributes: () => ({ colour: { default: 'teal',
    parseHTML: (element: HTMLElement) => element.dataset['scriptColour'] } }),
  parseHTML: () => SCRIPT_COLOURS.map(colour => ({ tag: `span[data-script-colour="${colour}"]` })),
  renderHTML({ HTMLAttributes }) {
    const colour = SCRIPT_COLOURS.find(value => value === HTMLAttributes['colour']) ?? 'teal';
    return ['span', { 'data-script-colour': colour, class: `kh-script-text--${colour}` }, 0];
  },
});
const Cue = Node.create({
  name: 'scriptCue', inline: true, group: 'inline', atom: true,
  addAttributes: () => ({ cue: { default: 'pause',
    parseHTML: (element: HTMLElement) => element.dataset['scriptCue'] } }),
  parseHTML: () => [{ tag: 'span[data-script-cue="pause"]' }, { tag: 'span[data-script-cue="beat"]' }],
  renderHTML({ HTMLAttributes }) {
    const cue = HTMLAttributes['cue'] === 'beat' ? 'beat' : 'pause';
    return ['span', mergeAttributes({ 'data-script-cue': cue, class: 'kh-script-cue', contenteditable: 'false' }), cue.toUpperCase()];
  },
  renderText: ({ node }) => `[${node.attrs['cue'] === 'beat' ? 'beat' : 'pause'}]`,
});

export function ScriptRichEditor({ id, value, disabled, maxLength, bullets = false, onChange, onSelection, onError }: {
  id: string; value: string; disabled: boolean; maxLength?: number | undefined; bullets?: boolean;
  onChange: (value: string) => void; onSelection: (passage: ScriptPassage | null) => void; onError: (message: string) => void;
}): React.ReactElement {
  const callbacks = useRef({ onChange, onSelection, onError, maxLength });
  callbacks.current = { onChange, onSelection, onError, maxLength };
  const [selected, setSelected] = useState(false);
  const [colour, setColour] = useState<string | null>(null);
  const [blockStyle, setBlockStyle] = useState('0');
  const initialContent = useMemo(() => scriptRichDocument(value, bullets), [value, bullets]);
  const updateSelection = useCallback((current: Editor): void => {
    const { from, to, empty } = current.state.selection;
    const doc = current.getJSON();
    const text = empty ? '' : scriptRichText(doc, from, to, false);
    setSelected(!empty);
    setBlockStyle(current.isActive('heading') ? String(current.getAttributes('heading')['level']) : '0');
    setColour(current.isActive('scriptColour') ? String(current.getAttributes('scriptColour')['colour']) : null);
    callbacks.current.onSelection(text.trim() ? { text, start: from, end: to, original: scriptRichText(doc) } : null);
  }, []);
  const editor = useEditor({
    extensions: [DocumentNode.extend({ content: bullets ? 'bulletList' : '(paragraph|heading)+' }),
      Paragraph, Heading, TextNode, HardBreak, Colour, Cue, BulletList, ListItem, Extension.create({
      name: 'scriptEditing',
      addProseMirrorPlugins() {
        return [history(), keymap({ ...baseKeymap, 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
          Enter: () => {
            if (bullets) return this.editor.commands.splitListItem('listItem');
            const selection = this.editor.state.selection;
            const afterHeading = this.editor.isActive('heading') && selection.empty
              && selection.$to.parentOffset === selection.$to.parent.content.size;
            const split = this.editor.commands.splitBlock();
            if (split && afterHeading) this.editor.commands.setNode('paragraph');
            return split;
          },
          'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak' }),
        }),
          new Plugin({ filterTransaction(transaction) {
            if (!transaction.docChanged || transaction.getMeta('preventUpdate')) return true;
            const limit = callbacks.current.maxLength;
            const next = scriptRichText(transaction.doc.toJSON());
            const previous = scriptRichText(transaction.before.toJSON());
            if (limit !== undefined && next.length > limit && next.length >= previous.length) {
              queueMicrotask(() => { callbacks.current.onError(`This script field cannot exceed ${limit} stored characters. The edit was not applied.`); });
              return false;
            }
            if (bullets) {
              const nextBullets = parseScriptBullets(next, next.length).bullets;
              if (nextBullets.length > 40 || nextBullets.some(item => item.length > 500 && next.length >= previous.length)) {
                queueMicrotask(() => { callbacks.current.onError('Use up to 40 bullet points, each with at most 500 stored characters. The edit was not applied.'); });
                return false;
              }
            }
            return true;
          } })];
      },
    })],
    content: initialContent,
    editable: !disabled,
    editorProps: {
      attributes: { id, role: 'textbox', 'aria-labelledby': `${id}-label`, 'aria-multiline': 'true', class: 'kh-script-rich__writing' },
      clipboardTextSerializer: slice => scriptRichText({ type: 'doc', content: slice.content.toJSON() }, 0, Infinity, false),
      handlePaste: (view, event) => {
        const plain = event.clipboardData?.getData('text/plain') ?? '';
        if (event.clipboardData?.getData('text/html') || !/\[(?:colour=|\/colour|pause\]|beat\])|^#{1,6}[ \t]+/im.test(plain)) return false;
        try {
          const pasted = view.state.schema.nodeFromJSON(scriptRichDocument(plain, bullets));
          view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(pasted.content)).scrollIntoView());
        } catch (error) {
          callbacks.current.onError(`The script was not pasted: ${error instanceof Error ? error.message : 'Invalid annotations.'}`);
        }
        return true;
      },
    },
    onCreate: ({ editor: current }) => { updateSelection(current); },
    onUpdate: ({ editor: current }) => {
      callbacks.current.onChange(scriptRichText(current.getJSON()));
      updateSelection(current);
    },
    onSelectionUpdate: ({ editor: current }) => { updateSelection(current); },
  });
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (!editor || scriptRichText(editor.getJSON()) === scriptRichText(initialContent)) return;
    editor.commands.setContent(initialContent, { emitUpdate: false });
    updateSelection(editor);
    callbacks.current.onSelection(null);
    setSelected(false); setColour(null);
  }, [editor, initialContent, updateSelection]);
  return <div className="kh-script-rich">
    <div className="kh-script-tools" role="group" aria-label="Script block styles, emphasis and delivery cues">
      <label className="kh-script-tools__style">Block style
        <select value={blockStyle} disabled={disabled || !editor}
          aria-describedby={`${id}-style-hint`}
          onChange={event => {
            const level = Number(event.target.value);
            editor?.chain().focus().setNode(level ? 'heading' : 'paragraph', level ? { level } : {}).run();
          }}>
          {SCRIPT_BLOCK_STYLES.map(style => <option key={style.value} value={style.value}>{style.label}</option>)}
          {Number(blockStyle) > 3 && <option value={blockStyle}>Heading {blockStyle}</option>}
        </select>
      </label>
      {SCRIPT_COLOURS.map(item => <button key={item} type="button" className={`kh-btn-ghost kh-script-text--${item}`}
        disabled={disabled || !editor || !selected} aria-label={`Colour selected text ${item}`} aria-pressed={colour === item}
        onMouseDown={event => { event.preventDefault(); }}
        onClick={() => { editor?.chain().focus().setMark('scriptColour', { colour: item }).run(); setColour(item); }}>{item}</button>)}
      <button type="button" className="kh-btn-ghost" disabled={disabled || !editor || !selected}
        onMouseDown={event => { event.preventDefault(); }}
        onClick={() => { editor?.chain().focus().unsetMark('scriptColour').run(); setColour(null); }}>Clear colour</button>
      {(['pause', 'beat'] as const).map(cue => <button key={cue} type="button" className="kh-btn-ghost" disabled={disabled || !editor}
        title="Visual reminder only; scrolling continues." onMouseDown={event => { event.preventDefault(); }}
        onClick={() => {
          if (editor) editor.chain().focus().setTextSelection(editor.state.selection.to).insertContent({ type: 'scriptCue', attrs: { cue } }).run();
        }}>{cue === 'pause' ? 'Pause' : 'Beat'}</button>)}
    </div>
    <p id={`${id}-style-hint`} className="kh-script-tools__hint">Titles, chapters and section headings stay here but are not read on the autocue. Text beneath them is still included.</p>
    <EditorContent editor={editor} />
  </div>;
}
