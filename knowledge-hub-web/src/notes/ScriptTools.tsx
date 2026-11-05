import React, { useEffect, useState } from 'react';
import { Tooltip } from '@carbon/react';
import { Add, Erase, Launch, MagicWand, Pause, PresentationFile, Renew, StopFilled, TextColor, Time, UserAvatar } from '@carbon/icons-react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { editorSchema } from './editorSchema';
import { SCRIPT_COLOURS } from '../features/podcasts/scriptAnnotations';
import { SCRIPT_BLOCK_STYLES, SCRIPT_COLOUR_VALUES } from '../features/podcasts/scriptRichText';
import { groupScriptSections, splitScriptSectionTail } from '../../../knowledge-hub-backend/src/utils/scriptSections';
import { preserveScriptSelection } from './scriptSectionSelection';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import { applyNoteEdits } from '../utils/noteEditApplier';
import { runNoteAction } from '../utils/activeBlockNoteEditor';
import { getDesktop } from '../types/desktop';
import { scriptBackspace } from './scriptBackspace';
import { parseScriptVisuals, readSectionVisuals, scriptVisualSource } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

function ScriptToolButton({ title, disabled, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }): React.ReactElement {
  return <Tooltip className="kh-script-tools__action" description={title} align="bottom" autoAlign>
    <span tabIndex={disabled ? 0 : undefined} aria-label={disabled ? title : undefined} aria-disabled={disabled || undefined}>
      <button {...props} disabled={disabled} />
    </span>
  </Tooltip>;
}

export function ScriptTools({ editor, disabled, noteId, save, onPresent, onStopPresenting }: {
  editor: Editor; disabled: boolean; noteId: string; save: () => Promise<boolean>;
  onPresent?: (() => void) | undefined; onStopPresenting?: (() => void) | undefined;
}): React.ReactElement {
  const [designing, setDesigning] = useState(false);
  const designingRef = React.useRef(false);
  const [selected, setSelected] = useState(false);
  const [colour, setColour] = useState('');
  const [blockStyle, setBlockStyle] = useState('0');
  const [canStyle, setCanStyle] = useState(true);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [presenterLayout, setPresenterLayout] = useState(false);
  const [hasVisuals, setHasVisuals] = useState(false);
  useEffect(() => {
    const refresh = (): void => {
      try {
        const scenes = editor.document.filter(block => block.type === 'heading' && block.props.scriptSection)
          .flatMap(block => readSectionVisuals(block)?.scenes ?? []);
        setHasVisuals(scenes.length > 0);
        setPresenterLayout(scenes.length > 0 && scenes.every(scene => scene.presenterLayout));
      } catch (error) {
        setHasVisuals(false);
        setSectionError(error instanceof Error ? error.message : 'Could not read the visual layout.');
      }
    };
    refresh();
    return editor.onChange(refresh);
  }, [editor]);
  useEffect(() => {
    const element = editor._tiptapEditor.view.dom;
    const backspace = (event: KeyboardEvent): void => {
      if (disabled || !editor.isEditable || event.key !== 'Backspace' || event.isComposing
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const view = editor._tiptapEditor.view;
      if (scriptBackspace(view.state, transaction => { view.dispatch(transaction); })) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    element.addEventListener('keydown', backspace, true);
    return () => { element.removeEventListener('keydown', backspace, true); };
  }, [editor, disabled]);
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
            level: 2, isToggleable: false, scriptSection: true, scriptDirection: '', scriptVisuals: '',
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
  <div className="kh-script-tools kh-script-tools--sticky kh-script-tools--icons" role="group" aria-label="Script block styles, emphasis and delivery cues">
    <ScriptToolButton type="button" className="kh-btn-ghost" title="Presenter layout: reserve space for your video"
      aria-label="Presenter layout" aria-pressed={presenterLayout} disabled={disabled || designing || !hasVisuals}
      onClick={() => {
        try {
          const edits = editor.document.flatMap(block => {
            if (block.type !== 'heading' || !block.props.scriptSection) return [];
            const visuals = readSectionVisuals(block);
            if (visuals?.scenes.length) {
              parseScriptVisuals(visuals, block);
              if (visuals.source !== scriptVisualSource(block)) throw new Error('Update the stale section visuals before changing the presenter layout.');
            }
            return visuals?.scenes.length ? [{
              action: 'set_script_visuals' as const, sectionId: block.id,
              expectedVisuals: block.props.scriptVisuals,
              visuals: { ...visuals, scenes: visuals.scenes.map(scene => ({ ...scene, presenterLayout: !presenterLayout })) },
              summary: presenterLayout ? 'Use full-frame visuals' : 'Reserve presenter video space',
            }] : [];
          });
          const result = applyNoteEdits(editor, edits, { script: true });
          if (result.failed.length) throw new Error(result.failed.join('; '));
          setSectionError(null);
        } catch (error) {
          setSectionError(error instanceof Error ? error.message : 'Could not change the visual layout.');
        }
      }}><UserAvatar size={18} aria-hidden="true" /></ScriptToolButton>
    {onPresent && <ScriptToolButton type="button" className="kh-btn-ghost" title="Present" aria-label="Present"
      disabled={disabled} onClick={onPresent}><PresentationFile size={18} aria-hidden="true" /></ScriptToolButton>}
    {onStopPresenting && <ScriptToolButton type="button" className="kh-btn-ghost" title="Stop presenting" aria-label="Stop presenting"
      onClick={onStopPresenting}><StopFilled size={18} aria-hidden="true" /></ScriptToolButton>}
    <ScriptToolButton type="button" className="kh-btn-ghost" title={designing ? 'Ariadne is designing visuals…' : 'Generate visuals'}
      aria-label={designing ? 'Ariadne is designing visuals' : 'Generate visuals'} aria-busy={designing}
      disabled={disabled || designing} onClick={() => {
      if (designingRef.current) return;
      designingRef.current = true; setDesigning(true); setSectionError(null);
      void (async () => {
        if (!await save()) throw new Error('Save the current script successfully before generating visuals.');
        const sections = editor.document.filter(block => block.type === 'heading' && block.props.scriptSection);
        if (!sections.length || sections.length > 20) throw new Error('Generate visuals for 1–20 script sections at a time.');
        const snapshot = JSON.stringify(editor.document);
        const edits: import('../types').NoteEdit[] = [];
        for (const section of sections) {
          const draft = requireApiData(await api.draftScriptVisuals(noteId, section.id,
            `Redesign this section as composed Carbon scenes using Astra and Sunburst imagery. Use conceptual visuals and meaningful animation, not the talk track: far less text, large readable labels, no paragraphs. ${section.id === sections[0]?.id ? 'Include a distinct illustrated opening title scene before the explanation.' : 'Continue the presentation without another opening title.'} Preserve the spoken script.`));
          edits.push({ action: 'set_script_visuals', sectionId: section.id, ...draft, summary: 'Generate section visuals' });
        }
        await runNoteAction(noteId, true, () => {
          if (JSON.stringify(editor.document) !== snapshot) throw new Error('The script changed during generation. No visuals were applied.');
          const result = applyNoteEdits(editor, edits, { script: true });
          if (result.failed.length) throw new Error(result.failed.join('; '));
        });
      })().catch(error => { setSectionError(describeApiError(error)); })
        .finally(() => { designingRef.current = false; setDesigning(false); });
    }}>{designing ? <Renew size={18} aria-hidden="true" /> : <MagicWand size={18} aria-hidden="true" />}</ScriptToolButton>
    <ScriptToolButton type="button" className="kh-btn-ghost" title="Open browser visuals" aria-label="Open browser visuals" disabled={disabled || designing} onClick={() => {
      const desktop = getDesktop()?.presentation;
      if (!desktop?.openVisuals) { setSectionError('Use an updated Athena Desktop to open the synchronised local browser output.'); return; }
      void desktop.openVisuals().catch(error => { setSectionError(error instanceof Error ? error.message : 'Could not open browser visuals.'); });
    }}><Launch size={18} aria-hidden="true" /></ScriptToolButton>
    <ScriptToolButton type="button" className="kh-btn-ghost" title="Add section" aria-label="Add section" disabled={disabled}
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
      }}><Add size={18} aria-hidden="true" /></ScriptToolButton>
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
    {SCRIPT_COLOURS.map(item => <ScriptToolButton key={item} type="button" className={`kh-btn-ghost kh-script-text--${item}`}
      title={`Colour selected text ${item}`}
      disabled={disabled || !selected} aria-label={`Colour selected text ${item}`} aria-pressed={colour === SCRIPT_COLOUR_VALUES[item]}
      onMouseDown={event => { event.preventDefault(); }}
      onClick={() => { editor.focus(); editor.addStyles({ textColor: SCRIPT_COLOUR_VALUES[item] }); setColour(SCRIPT_COLOUR_VALUES[item]); }}><TextColor size={18} aria-hidden="true" /></ScriptToolButton>)}
    <ScriptToolButton type="button" className="kh-btn-ghost" title="Clear colour" aria-label="Clear colour" disabled={disabled || !selected}
      onMouseDown={event => { event.preventDefault(); }}
      onClick={() => { editor.focus(); editor.removeStyles({ textColor: '' }); setColour(''); }}><Erase size={18} aria-hidden="true" /></ScriptToolButton>
    {(['pause', 'beat'] as const).map(cue => <ScriptToolButton key={cue} type="button" className="kh-btn-ghost" disabled={disabled}
      aria-label={cue === 'pause' ? 'Insert pause cue' : 'Insert beat cue'}
      title={`${cue === 'pause' ? 'Pause' : 'Beat'}: visual reminder only; scrolling continues.`} onMouseDown={event => { event.preventDefault(); }}
      onClick={() => {
        editor._tiptapEditor.commands.setTextSelection(editor._tiptapEditor.state.selection.to);
        editor.focus();
        editor.insertInlineContent([{ type: 'scriptCue', props: { cue } }]);
      }}>{cue === 'pause' ? <Pause size={18} aria-hidden="true" /> : <Time size={18} aria-hidden="true" />}</ScriptToolButton>)}
  </div>
  <p className="kh-script-tools__hint" role="status">{designing ? 'Ariadne is designing visuals…' : 'Each card is a section. Titles are editor-only; the text inside each card is read on the autocue.'}</p>
  {sectionError && <p className="kh-script-section__error" role="alert">{sectionError}</p>}
  </>;
}
