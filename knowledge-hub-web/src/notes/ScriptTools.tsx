import React, { useEffect, useState } from 'react';
import { Tooltip } from '@carbon/react';
import { Add, ApplicationWeb, Erase, Launch, MagicWand, Pause, PlayFilled, PresentationFile, Renew, StopFilled, TextColor, Time, UserAvatar, View } from '@carbon/icons-react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { editorSchema } from './editorSchema';
import { SCRIPT_COLOURS } from '../features/podcasts/scriptAnnotations';
import { SCRIPT_COLOUR_VALUES } from '../features/podcasts/scriptRichText';
import { groupScriptSections, splitScriptSectionTail, splitScriptTitle } from '../../../knowledge-hub-backend/src/utils/scriptSections';
import { preserveScriptSelection } from './scriptSectionSelection';
import { applyNoteEdits } from '../utils/noteEditApplier';
import { getDesktop } from '../types/desktop';
import { scriptBackspace } from './scriptBackspace';
import { parseScriptVisuals, readSectionVisuals, visualSourceCurrent } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';
import { useScriptVisualJobs } from './ScriptVisualJobs';
import { setScriptVideoMode, useScriptVideoState } from '../features/autocue/scriptVideoState';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

function ScriptToolButton({ title, disabled, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }): React.ReactElement {
  return <Tooltip className="kh-script-tools__action" description={title} align="bottom" autoAlign>
    <span tabIndex={disabled ? 0 : undefined} aria-label={disabled ? title : undefined} aria-disabled={disabled || undefined}>
      <button {...props} disabled={disabled} />
    </span>
  </Tooltip>;
}

export function ScriptTools({ editor, disabled, noteId, save, onPresent, onPlayback, onOpenDemo, onOpenVisuals, onStopPresenting }: {
  editor: Editor; disabled: boolean; noteId: string; save: () => Promise<boolean>;
  onPresent?: (() => void) | undefined; onStopPresenting?: (() => void) | undefined;
  onOpenDemo?: (() => Promise<void>) | undefined;
  onPlayback?: ((command: 'play' | 'pause') => Promise<void>) | undefined;
  onOpenVisuals?: (() => Promise<void>) | undefined;
}): React.ReactElement {
  const visualJobs = useScriptVisualJobs({ editor, noteId, save, disabled });
  const designing = visualJobs.submitting || !!visualJobs.active;
  const [selected, setSelected] = useState(false);
  const [colour, setColour] = useState('');
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [openingVisuals, setOpeningVisuals] = useState(false);
  const [presenterLayout, setPresenterLayout] = useState(false);
  const [keynoteTheme, setKeynoteTheme] = useState(false);
  const [hasVisuals, setHasVisuals] = useState(false);
  const [hasDemo, setHasDemo] = useState(false);
  const [openingDemo, setOpeningDemo] = useState(false);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const video = useScriptVideoState();
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  useEffect(() => {
    const presentation = getDesktop()?.presentation;
    if (!presentation) return;
    let active = true;
    const receive = (state: import('../types/desktop').DesktopCommandState): void => {
      if (!active) return;
      setPlaying(state.presentation.noteId === noteId && state.presentation.status === 'playing');
      if (state.presentation.noteId === noteId && (state.error || state.presentation.error)) {
        setSectionError(state.error ?? state.presentation.error);
      }
    };
    const off = presentation.onState(receive);
    void presentation.state().then(receive).catch(error => {
      if (active) setSectionError(error instanceof Error ? error.message : 'Could not read playback state.');
    });
    return () => { active = false; off(); };
  }, [noteId]);
  const changeVideo = (mode: 'guide' | 'camera' | 'off'): void => {
    if (videoBusy) return;
    setVideoBusy(true); setVideoError(null);
    void setScriptVideoMode(noteId, mode).catch(error => {
      setVideoError(error instanceof Error ? error.message : 'Could not change presenter video mode.');
    }).finally(() => { setVideoBusy(false); });
  };
  useEffect(() => {
    const refresh = (): void => {
      setHasDemo(editor.document.some(block => block.type === 'heading' && block.props.scriptSection && !!block.props.scriptDemo));
      try {
        const scenes = editor.document.filter(block => block.type === 'heading' && block.props.scriptSection)
          .flatMap(block => readSectionVisuals(block)?.scenes ?? []);
        setHasVisuals(scenes.length > 0);
        setPresenterLayout(scenes.length > 0 && scenes.every(scene => scene.presenterLayout));
        setKeynoteTheme(scenes.length > 0 && scenes.every(scene => scene.theme === 'keynote'));
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
        const { body: sectionBody } = splitScriptTitle(body);
        if (sectionBody.length && sectionBody.every(block => block.type === 'heading' && block.props.scriptSection && block.children.length > 0)) return;
        const sections = groupScriptSections(body, (): Editor['document'][number] => ({
          id: crypto.randomUUID(), type: 'heading', props: {
            level: 2, isToggleable: false, scriptSection: true, scriptDirection: '', scriptVisuals: '', scriptDemo: '',
            textColor: 'default', backgroundColor: 'default', textAlignment: 'left',
          }, content: [], children: [],
        })).map(section => section.type !== 'heading' || !section.props.scriptSection || section.children.length ? section : { ...section, children: [{
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
    };
    refresh();
    const offSelection = editor.onSelectionChange(refresh);
    const offChange = editor.onChange(refresh);
    return () => { offSelection(); offChange(); };
  }, [editor]);
  return <>
  <div className="kh-script-tools kh-script-tools--sticky kh-script-tools--icons" role="group" aria-label="Script presentation, emphasis and delivery cues">
    <ScriptToolButton type="button" className="kh-btn-ghost" title="Presenter layout: reserve space for your video"
      aria-label="Presenter layout" aria-pressed={presenterLayout} disabled={disabled || !hasVisuals}
      onClick={() => {
        try {
          const edits = editor.document.flatMap(block => {
            if (block.type !== 'heading' || !block.props.scriptSection) return [];
            const visuals = readSectionVisuals(block);
            if (visuals?.scenes.length) {
              parseScriptVisuals(visuals, block);
              if (!visualSourceCurrent(visuals.source, block)) throw new Error('Update the stale section visuals before changing the presenter layout.');
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
    <label className="kh-script-tools__style kh-script-tools__theme">Theme
      <select aria-label="Visual theme" value={keynoteTheme ? 'keynote' : 'carbon'} disabled={disabled || !hasVisuals}
        onChange={event => {
          const theme = event.target.value === 'keynote' ? ('keynote' as const) : undefined;
          try {
            const edits = editor.document.flatMap(block => {
              if (block.type !== 'heading' || !block.props.scriptSection) return [];
              const visuals = readSectionVisuals(block);
              if (visuals?.scenes.length) {
                parseScriptVisuals(visuals, block);
                if (!visualSourceCurrent(visuals.source, block)) throw new Error('Update the stale section visuals before changing the visual theme.');
              }
              return visuals?.scenes.length ? [{
                action: 'set_script_visuals' as const, sectionId: block.id,
                expectedVisuals: block.props.scriptVisuals,
                visuals: { ...visuals, scenes: visuals.scenes.map(scene => {
                  const { theme: _previous, ...rest } = scene;
                  return theme ? { ...rest, theme } : rest;
                }) },
                summary: theme ? 'Use the Keynote visual theme' : 'Use the Carbon visual theme',
              }] : [];
            });
            const result = applyNoteEdits(editor, edits, { script: true });
            if (result.failed.length) throw new Error(result.failed.join('; '));
            setSectionError(null);
          } catch (error) {
            setSectionError(error instanceof Error ? error.message : 'Could not change the visual theme.');
          }
        }}>
        <option value="carbon">Carbon</option>
        <option value="keynote">Keynote</option>
      </select>
    </label>
    <label className="kh-script-tools__style kh-script-tools__video">Video
      <select aria-label="Presenter video mode" value={video.mode}
        disabled={videoBusy || video.loading || (!presenterLayout && video.mode !== 'camera')}
        onChange={event => {
          const mode = event.target.value;
          if (mode === 'guide' || mode === 'camera' || mode === 'off') changeVideo(mode);
          else setVideoError('Choose Guide, Camera or Off.');
        }}>
        <option value="guide">Guide</option>
        <option value="camera" disabled={!getDesktop()?.presentation?.scriptVisualVideo || !video.available || video.noteId !== noteId}>Camera</option>
        <option value="off">Off</option>
      </select>
    </label>
    {video.mode === 'camera' && video.status === 'error' && <ScriptToolButton type="button" className="kh-btn-ghost"
      title="Retry camera" aria-label="Retry camera" disabled={videoBusy || !video.available || video.noteId !== noteId}
      onClick={() => { changeVideo('camera'); }}><Renew size={18} aria-hidden="true" /></ScriptToolButton>}
    {onPresent && <ScriptToolButton type="button" className="kh-btn-ghost" title="Present" aria-label="Present"
      disabled={disabled} onClick={onPresent}><PresentationFile size={18} aria-hidden="true" /></ScriptToolButton>}
    {onPlayback && <ScriptToolButton type="button" className="kh-btn-ghost"
      title={playing ? 'Pause presentation' : 'Play presentation'} aria-label={playing ? 'Pause presentation' : 'Play presentation'}
      disabled={disabled || playbackBusy} onClick={() => {
        setPlaybackBusy(true); setSectionError(null);
        void onPlayback(playing ? 'pause' : 'play').catch(error => {
          setSectionError(error instanceof Error ? error.message : 'Could not control playback.');
        }).finally(() => { setPlaybackBusy(false); });
      }}>{playing ? <Pause size={18} aria-hidden="true" /> : <PlayFilled size={18} aria-hidden="true" />}</ScriptToolButton>}
    {onOpenDemo && <ScriptToolButton type="button" className="kh-btn-ghost" title={hasDemo ? 'Open Turnaround demo' : 'Set up demo cues in a script section first'}
      aria-label="Open Turnaround demo" disabled={disabled || openingDemo || !hasDemo} onClick={() => {
        setOpeningDemo(true); setSectionError(null);
        void onOpenDemo().catch(error => { setSectionError(error instanceof Error ? error.message : 'Could not open the demo.'); })
          .finally(() => { setOpeningDemo(false); });
      }}><ApplicationWeb size={18} aria-hidden="true" /></ScriptToolButton>}
    {onStopPresenting && <ScriptToolButton type="button" className="kh-btn-ghost" title="Stop presenting" aria-label="Stop presenting"
      onClick={onStopPresenting}><StopFilled size={18} aria-hidden="true" /></ScriptToolButton>}
    <ScriptToolButton type="button" className="kh-btn-ghost" title={designing ? 'Ariadne is designing visuals…' : 'Generate visuals'}
      aria-label={designing ? 'Ariadne is designing visuals' : 'Generate visuals'} aria-busy={designing}
      disabled={disabled || designing} onClick={visualJobs.generate}>{designing ? <Renew size={18} aria-hidden="true" /> : <MagicWand size={18} aria-hidden="true" />}</ScriptToolButton>
    <ScriptToolButton type="button" className="kh-btn-ghost" title={visualJobs.loading ? 'Loading visual results…' : 'Review visuals'}
      aria-label="Review visuals" disabled={!visualJobs.hasResult} onClick={visualJobs.review}><View size={18} aria-hidden="true" /></ScriptToolButton>
    <ScriptToolButton type="button" className="kh-btn-ghost" title={openingVisuals ? 'Opening browser visuals…' : 'Open browser visuals'} aria-label="Open browser visuals"
      aria-busy={openingVisuals} disabled={disabled || openingVisuals} onClick={() => {
      if (!onOpenVisuals) { setSectionError('Use an updated Athena Desktop to open the synchronised local browser output.'); return; }
      setOpeningVisuals(true);
      setSectionError(null);
      void onOpenVisuals().catch(error => { setSectionError(error instanceof Error ? error.message : 'Could not open browser visuals.'); })
        .finally(() => { setOpeningVisuals(false); });
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
  <p className="kh-script-tools__hint" role="status">{visualJobs.status ?? 'Each card is a section. Titles are editor-only; the text inside each card is read on the autocue.'}</p>
  {presenterLayout && <p className="kh-script-tools__hint" role="status">{video.loading ? 'Reading video mode…'
    : video.mode === 'camera' ? video.status === 'active' ? 'Camera live in the audience output. No microphone audio is captured.'
      : video.status === 'requesting' ? 'Allow camera access in the audience browser.'
        : video.status === 'error' ? 'Camera unavailable. Retry or select Off.'
          : 'Waiting for the audience output and a Presenter-layout scene.'
      : video.mode === 'guide' ? 'Guide: align your video here in Premiere. For live sharing, select Camera or Off.'
        : 'Video off: the presenter area stays clear.'}
    {!getDesktop()?.presentation?.scriptVisualVideo && ' Live camera/output controls require an updated Athena Desktop.'}
    {getDesktop()?.presentation?.scriptVisualVideo && !video.available && ' Present the saved script with Presenter layout to enable Camera.'}
  </p>}
  {(videoError || video.error) && <p className="kh-script-section__error" role="alert">{videoError || video.error}</p>}
  {(visualJobs.error || visualJobs.loadError) && <p className="kh-script-section__error" role="alert">{visualJobs.error || visualJobs.loadError}</p>}
  {visualJobs.dialog}
  {sectionError && <p className="kh-script-section__error" role="alert">{sectionError}</p>}
  </>;
}
