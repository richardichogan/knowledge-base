import React, { useEffect, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { editorSchema } from './editorSchema';
import { SCRIPT_COLOURS } from '../features/podcasts/scriptAnnotations';
import { SCRIPT_BLOCK_STYLES, SCRIPT_COLOUR_VALUES } from '../features/podcasts/scriptRichText';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

export function ScriptTools({ editor, disabled }: { editor: Editor; disabled: boolean }): React.ReactElement {
  const [selected, setSelected] = useState(false);
  const [colour, setColour] = useState('');
  const [blockStyle, setBlockStyle] = useState('0');
  const [canStyle, setCanStyle] = useState(true);
  useEffect(() => {
    const refresh = (): void => {
      setSelected(editor.getSelectedText().length > 0);
      setColour(editor.getActiveStyles().textColor ?? '');
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      setCanStyle(blocks.every(block => Array.isArray(block.content)));
      const styles = blocks.map(block => block.type === 'heading' ? String(block.props.level) : block.type === 'paragraph' ? '0' : '');
      setBlockStyle(styles.every(style => style === styles[0]) ? styles[0] ?? '' : '');
    };
    refresh();
    const offSelection = editor.onSelectionChange(refresh);
    const offChange = editor.onChange(refresh);
    return () => { offSelection(); offChange(); };
  }, [editor]);
  return <>
  <div className="kh-script-tools" role="group" aria-label="Script block styles, emphasis and delivery cues">
    <label className="kh-script-tools__style">Block style
      <select value={blockStyle} disabled={disabled || !canStyle}
        onChange={event => {
          const level = Number(event.target.value);
          const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
          editor.transact(() => {
            for (const block of blocks) {
              if (level === 1 || level === 2 || level === 3) editor.updateBlock(block, { type: 'heading', props: { level } });
              else editor.updateBlock(block, { type: 'paragraph' });
            }
          });
          editor.focus();
        }}>
        <option value="" disabled>Other / mixed blocks</option>
        {SCRIPT_BLOCK_STYLES.map(style => <option key={style.value} value={style.value}>{style.label}</option>)}
        {Number(blockStyle) > 3 && <option value={blockStyle}>Heading {blockStyle}</option>}
      </select>
    </label>
    {SCRIPT_COLOURS.map(item => <button key={item} type="button" className={`kh-btn-ghost kh-script-text--${item}`}
      disabled={disabled || !selected} aria-label={`Colour selected text ${item}`} aria-pressed={colour === SCRIPT_COLOUR_VALUES[item]}
      onMouseDown={event => { event.preventDefault(); }}
      onClick={() => { editor.focus(); editor.addStyles({ textColor: SCRIPT_COLOUR_VALUES[item] }); setColour(SCRIPT_COLOUR_VALUES[item]); }}>{item}</button>)}
    <button type="button" className="kh-btn-ghost" disabled={disabled || !selected}
      onMouseDown={event => { event.preventDefault(); }}
      onClick={() => { editor.focus(); editor.removeStyles({ textColor: '' }); setColour(''); }}>Clear colour</button>
    {(['pause', 'beat'] as const).map(cue => <button key={cue} type="button" className="kh-btn-ghost" disabled={disabled}
      title="Visual reminder only; scrolling continues." onMouseDown={event => { event.preventDefault(); }}
      onClick={() => {
        editor._tiptapEditor.commands.setTextSelection(editor._tiptapEditor.state.selection.to);
        editor.focus();
        editor.insertInlineContent([{ type: 'scriptCue', props: { cue } }]);
      }}>{cue === 'pause' ? 'Pause' : 'Beat'}</button>)}
  </div>
  <p className="kh-script-tools__hint">Titles, chapters and section headings stay here but are not read on the autocue. Text beneath them is still included.</p>
  </>;
}
