import React, { useEffect, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { editorSchema } from './editorSchema';
import { SCRIPT_COLOURS } from '../features/podcasts/scriptAnnotations';
import { SCRIPT_COLOUR_VALUES } from '../features/podcasts/scriptRichText';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

export function ScriptTools({ editor, disabled }: { editor: Editor; disabled: boolean }): React.ReactElement {
  const [selected, setSelected] = useState(false);
  const [colour, setColour] = useState('');
  useEffect(() => editor.onSelectionChange(() => {
    setSelected(editor.getSelectedText().length > 0);
    setColour(editor.getActiveStyles().textColor ?? '');
  }), [editor]);
  return <div className="kh-script-tools" role="group" aria-label="Script emphasis and delivery cues">
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
  </div>;
}
