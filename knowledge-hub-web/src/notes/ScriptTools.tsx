import React, { useEffect, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { editorSchema } from './editorSchema';
import { SCRIPT_COLOURS } from '../features/podcasts/scriptAnnotations';
import { SCRIPT_BLOCK_STYLES, SCRIPT_COLOUR_VALUES } from '../features/podcasts/scriptRichText';
import { groupScriptSections, splitScriptSectionTail } from '../../../knowledge-hub-backend/src/utils/scriptSections';
import { preserveScriptSelection } from './scriptSectionSelection';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

export function ScriptTools({ editor, disabled }: { editor: Editor; disabled: boolean }): React.ReactElement {
  const [selected, setSelected] = useState(false);
  const [colour, setColour] = useState('');
  const [blockStyle, setBlockStyle] = useState('0');
  const [canStyle, setCanStyle] = useState(true);
  const [sectionError, setSectionError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let queued = false;
    const normalize = (): void => {
      if (!active || disabled) return;
      try {
        const current = editor.document;
        const { body, tail } = splitScriptSectionTail(current);
        if (body.length && body.every(block => block.type === 'heading' && block.props.scriptSection && block.children.length > 0)) return;
        const sections = groupScriptSections(body, (): Editor['document'][number] => ({
          id: crypto.randomUUID(), type: 'heading', props: {
            level: 2, isToggleable: false, scriptSection: true, scriptDirection: '',
            textColor: 'default', backgroundColor: 'default', textAlignment: 'left',
          }, content: [], children: [],
        })).map(section => section.children.length ? section : { ...section, children: [{
          id: crypto.randomUUID(), type: 'paragraph' as const,
          props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' as const },
          content: [], children: [],
        }] });
        const next = [...sections, ...tail];
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          editor.transact(transaction => { preserveScriptSelection(transaction, () => { editor.replaceBlocks(current, next); }); });
        }
        setSectionError(null);
      } catch (err) {
        setSectionError(err instanceof Error ? err.message : 'Could not organise the script into sections.');
      }
    };
    const off = editor.onChange(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; normalize(); });
    });
    queueMicrotask(normalize);
    return () => { active = false; off(); };
  }, [editor, disabled]);
  useEffect(() => {
    const refresh = (): void => {
      setSelected(editor.getSelectedText().length > 0);
      setColour(editor.getActiveStyles().textColor ?? '');
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      setCanStyle(blocks.every(block => Array.isArray(block.content) && !(block.type === 'heading' && block.props.scriptSection)));
      const styles = blocks.map(block => block.type === 'heading' ? String(block.props.level) : block.type === 'paragraph' ? '0' : '');
      setBlockStyle(styles.every(style => style === styles[0]) ? styles[0] ?? '' : '');
    };
    refresh();
    const offSelection = editor.onSelectionChange(refresh);
    const offChange = editor.onChange(refresh);
    return () => { offSelection(); offChange(); };
  }, [editor]);
  return <>
  <div className="kh-script-tools kh-script-tools--sticky" role="group" aria-label="Script block styles, emphasis and delivery cues">
    <button type="button" className="kh-btn-ghost" disabled={disabled}
      onMouseDown={event => { event.preventDefault(); }}
      onClick={() => {
        try {
          const last = splitScriptSectionTail(editor.document).body.at(-1);
          if (!last) throw new Error('The script is not ready. Wait for its current section to load.');
          const [section] = editor.insertBlocks([{ type: 'heading',
            props: { level: 2, scriptSection: true, scriptDirection: '' }, content: '',
            children: [{ type: 'paragraph', content: '' }] }], last, 'after');
          if (!section) throw new Error('The new section could not be created.');
          editor.setTextCursorPosition(section, 'start'); editor.focus();
          setSectionError(null);
        } catch (error) {
          setSectionError(error instanceof Error ? error.message : 'Could not add a script section.');
        }
      }}>Add section</button>
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
  <p className="kh-script-tools__hint">Each card is a section. Titles and delivery directions are editor-only; the text inside each card is read on the autocue.</p>
  {sectionError && <p className="kh-script-section__error" role="alert">{sectionError}</p>}
  </>;
}
