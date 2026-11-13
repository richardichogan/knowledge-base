import React from 'react';
import { defaultBlockSpecs, type BlockSpec } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { confirmDialog } from '../services/appDialogs';
import { preserveScriptSelection } from './scriptSectionSelection';
import { ScriptVisualPreview } from '../features/autocue/ScriptVisualPreview';
import { useAthenaContext } from '../context/AthenaContext';
import { getActiveNoteId } from '../utils/activeBlockNoteEditor';
import { readSectionVisuals, type VisualScriptBlock } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';
import { readScriptDemo, scriptDemoFromPhrases, scriptNavigationFromPhrase, TURNAROUND_ROUTES, type ScriptDemo, type TurnaroundRoute } from '../../../knowledge-hub-backend/src/utils/scriptDemo';
import { parseScriptDirection, SCRIPT_DIRECTION_LIMIT } from '../../../knowledge-hub-backend/src/utils/scriptDirections';

type HeadingProps = Omit<typeof defaultBlockSpecs.heading.config.propSchema, 'isToggleable'> & {
  isToggleable: NonNullable<typeof defaultBlockSpecs.heading.config.propSchema.isToggleable>;
};
const nativeHeading = defaultBlockSpecs.heading as BlockSpec<'heading', HeadingProps, 'inline'>;
const config = { ...nativeHeading.config, propSchema: { ...nativeHeading.config.propSchema,
  scriptSection: { default: false }, scriptDirection: { default: '' }, scriptVisuals: { default: '' }, scriptDemo: { default: '' } } } as const;

const DEMO_LABELS = ['Open Scope list', 'Select Jobs', 'Open first job'];
const PILOT_PHRASES = ['Scope list', 'Jobs tab', 'Open one job'];

function DemoCues({ plan, disabled, save, ask }: {
  plan: Extract<ScriptDemo, { version: 1 }>; disabled: boolean; save: (phrases: string[]) => void; ask: () => void;
}): React.JSX.Element {
  const [phrases, setPhrases] = React.useState(() => plan.actions.map(action => action.cue.quote));
  return <section className="kh-script-demo" contentEditable={false} aria-label="Turnaround demo cues">
    <div className="kh-script-demo__header"><strong>Turnaround demo</strong>
      <button type="button" onClick={ask}>Ask Athena to adjust</button></div>
    <p>Each action follows its phrase in the spoken script.</p>
    {phrases.map((phrase, index) => <label key={DEMO_LABELS[index]}>{DEMO_LABELS[index]}
      <input value={phrase} disabled={disabled} onChange={event => {
        const next = [...phrases]; next[index] = event.target.value; setPhrases(next);
      }} />
    </label>)}
    <button type="button" disabled={disabled} onClick={() => save(phrases)}>Save demo phrases</button>
  </section>;
}

function NavigationCue({ section, plan, disabled, save, ask }: {
  section: VisualScriptBlock; plan: Extract<ScriptDemo, { version: 2 }> | null;
  disabled: boolean; save: (route: TurnaroundRoute, phrase: string) => void; ask: () => void;
}): React.JSX.Element {
  const [route, setRoute] = React.useState<string>(plan?.actions[0]?.route ?? '');
  const [phrase, setPhrase] = React.useState(plan?.actions[0]?.cue.quote ?? '');
  React.useEffect(() => {
    setRoute(plan?.actions[0]?.route ?? '');
    setPhrase(plan?.actions[0]?.cue.quote ?? '');
  }, [section.id, plan?.source]);
  const id = React.useId();
  return <section className="kh-script-demo" contentEditable={false} aria-label="Screen navigation cue">
    <div className="kh-script-demo__header"><strong>Screen navigation</strong>
      <button type="button" disabled={disabled} onClick={ask}>Ask Athena to adjust</button></div>
    <p>Opens an allowlisted Turnaround screen after the exact spoken phrase. Sections without a saved cue remain manual.</p>
    <label htmlFor={`${id}-route`}>Screen</label>
    <select id={`${id}-route`} value={route} disabled={disabled} onChange={event => { setRoute(event.target.value); }}>
      <option value="">Choose a screen</option>
      {Object.entries(TURNAROUND_ROUTES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
    </select>
    <label htmlFor={`${id}-phrase`}>Exact spoken phrase</label>
    <input id={`${id}-phrase`} value={phrase} maxLength={300} disabled={disabled} onChange={event => { setPhrase(event.target.value); }} />
    <button type="button" disabled={disabled || !route || !phrase.trim()} onClick={() => save(route as TurnaroundRoute, phrase)}>Save navigation cue</button>
  </section>;
}

const sectionHeading = createReactBlockSpec(config, {
  render: function ScriptSectionHeading({ block, editor, contentRef }) {
    const [, refreshOrder] = React.useReducer((value: number) => value + 1, 0);
    const { openAthena, pageContext } = useAthenaContext();
    React.useEffect(() => editor.onChange(() => { refreshOrder(); window.dispatchEvent(new Event('athena:script-visual-context')); }), [editor]);
    const siblings = editor.document.filter(item => item.type === 'heading' && item.props.scriptSection);
    const index = siblings.findIndex(item => item.id === block.id);
    const [error, setError] = React.useState<string | null>(null);
    let pageOffset = 0;
    let totalScenes = 0;
    let visualError: string | null = null;
    let demo: ScriptDemo | null = null;
    let demoError: string | null = null;
    try { demo = readScriptDemo(block); }
    catch (err) { demoError = err instanceof Error ? err.message : 'Demo cues could not be read.'; }
    try {
      for (const [position, section] of siblings.entries()) {
        const count = readSectionVisuals(section)?.scenes.length ?? 0;
        if (position < index) pageOffset += count;
        totalScenes += count;
      }
    } catch (err) { visualError = err instanceof Error ? err.message : 'Presentation numbering could not be read.'; }
    const perform = (operation: () => void): void => {
      try {
        if (!editor.isEditable) throw new Error('Wait for the current note operation to finish before changing this section.');
        operation(); setError(null);
      }
      catch (err) { setError(err instanceof Error ? err.message : 'Could not change this section.'); }
    };
    const move = (offset: number): void => perform(() => {
      const current = editor.document.filter(item => item.type === 'heading' && item.props.scriptSection);
      const from = current.findIndex(item => item.id === block.id);
      const section = current[from];
      const target = current[from + offset];
      if (!section || !target) throw new Error('The section order changed. Try again.');
      editor.transact(transaction => {
        preserveScriptSelection(transaction, () => {
          editor.removeBlocks([block.id]);
          editor.insertBlocks([section], target.id, offset < 0 ? 'before' : 'after');
        });
      });
    });
    return <div className="kh-script-section">
      <div className="kh-script-section__actions" contentEditable={false}>
        <span>Section {index + 1}</span>
        <button type="button" disabled={!editor.isEditable || index <= 0} onClick={() => move(-1)} aria-label="Move section up">Move up</button>
        <button type="button" disabled={!editor.isEditable || index < 0 || index === siblings.length - 1} onClick={() => move(1)} aria-label="Move section down">Move down</button>
        <button type="button" disabled={!editor.isEditable} onClick={() => {
          void confirmDialog('Remove this section and its spoken text? You can undo this change.', {
            title: 'Remove script section', confirmLabel: 'Remove', tone: 'danger',
          }).then(confirmed => {
            if (confirmed) perform(() => {
              const current = editor.getBlock(block.id);
              if (!current) throw new Error('This section is no longer available.');
              if (JSON.stringify(current) !== JSON.stringify(block)) throw new Error('This section changed while confirming. Review it before removing.');
              editor.removeBlocks([block.id]);
            });
          }).catch(err => { setError(err instanceof Error ? err.message : 'Could not confirm removal.'); });
        }}>Remove</button>
      </div>
      <div className="kh-script-section__title" ref={contentRef} role="textbox" aria-label="Section title (not spoken)" />
      <section className="kh-script-directions" contentEditable={false} aria-label="Presenter directions">
        <label htmlFor={`script-directions-${block.id}`}>Presenter directions (not spoken)
          <textarea id={`script-directions-${block.id}`} value={block.props.scriptDirection} maxLength={SCRIPT_DIRECTION_LIMIT}
            disabled={!editor.isEditable} onChange={event => {
              const direction = event.target.value;
              perform(() => {
                const current = editor.getBlock(block.id);
                if (!current || current.props.scriptDirection !== block.props.scriptDirection) {
                  throw new Error('Presenter directions changed. Review the current text before editing.');
                }
                editor.updateBlock(current, { props: { ...current.props, scriptDirection: parseScriptDirection(direction) } });
              });
            }} />
        </label>
        <div className="kh-script-directions__footer">
          <span>{block.props.scriptDirection.length.toLocaleString('en-GB')} / {SCRIPT_DIRECTION_LIMIT.toLocaleString('en-GB')} characters · autosaved with the note · excluded from the teleprompter</span>
        </div>
      </section>
      <ScriptVisualPreview section={block} presentationTitle={pageContext?.title ?? ''} pageOffset={pageOffset} totalScenes={totalScenes} ask={sceneId => {
        const noteId = getActiveNoteId();
        if (!noteId || !pageContext || pageContext.id !== noteId) { setError('Reopen the script before asking Athena to change its visuals.'); return; }
        openAthena(`Please ${block.props.scriptVisuals ? 'update' : 'create'} the visuals for script section ${block.id}${sceneId ? `, scene ${sceneId}` : ''}. Read its current scenes first. Keep the spoken script unchanged. Use concepts and meaningful animation, not narration repeated as bullet points. ${block.props.scriptVisuals ? 'The change I want is: ' : ''}`, pageContext);
      }} />
      {demo?.version === 1 ? <DemoCues key={block.props.scriptDemo} plan={demo} disabled={!editor.isEditable} save={phrases => perform(() => {
        const current = editor.getBlock(block.id);
        if (!current || current.props.scriptDemo !== block.props.scriptDemo) throw new Error('Demo cues changed. Review them before saving again.');
        editor.updateBlock(current, { props: { ...current.props, scriptDemo: JSON.stringify(scriptDemoFromPhrases(current, phrases)) } });
      })} ask={() => {
        const noteId = getActiveNoteId();
        if (!noteId || !pageContext || pageContext.id !== noteId) { setError('Reopen the script before asking Athena to adjust its demo.'); return; }
        openAthena(`Please read the Turnaround demo cues for section ${block.id} and adjust them as follows: `, pageContext);
      }} /> : <NavigationCue key={block.props.scriptDemo ?? block.id} section={block} plan={demo?.version === 2 ? demo : null}
        disabled={!editor.isEditable || !!demoError} save={(route, phrase) => perform(() => {
          const current = editor.getBlock(block.id);
          if (!current || current.props.scriptDemo !== block.props.scriptDemo) throw new Error('Screen navigation changed. Review the current cue before saving.');
          editor.updateBlock(current, { props: { ...current.props, scriptDemo: JSON.stringify(scriptNavigationFromPhrase(current, route, phrase)) } });
        })} ask={() => {
          const noteId = getActiveNoteId();
          if (!noteId || !pageContext || pageContext.id !== noteId) { setError('Reopen the script before asking Athena to adjust its navigation.'); return; }
          openAthena(`Please read the screen-navigation cue for script section ${block.id} and adjust it as follows: `, pageContext);
        }} />}
      {!demo && <section className="kh-script-demo" contentEditable={false} aria-label="Turnaround pilot cues">
        <div className="kh-script-demo__header"><strong>Turnaround demo</strong>
          <button type="button" disabled={!editor.isEditable || !!demoError} onClick={() => perform(() => {
            const current = editor.getBlock(block.id);
            if (!current || current.props.scriptDemo) throw new Error('Demo cues changed. Review them before setting up.');
            editor.updateBlock(current, { props: { ...current.props, scriptDemo: JSON.stringify(scriptDemoFromPhrases(current, PILOT_PHRASES)) } });
          })}>Set up pilot demo cues</button></div>
        <p>Link the pilot’s three read-only actions to this section’s spoken phrases.</p>
      </section>}
      {demoError && <p className="kh-script-section__error" role="alert" contentEditable={false}>{demoError}</p>}
      {visualError && <p className="kh-script-section__error" role="alert" contentEditable={false}>{visualError}</p>}
      {error && <p className="kh-script-section__error" role="alert" contentEditable={false}>{error}</p>}
    </div>;
  },
})();

// BlockNote's editor generic is invariant. This adapter retains the native
// renderer/toggle behaviour for the same heading schema plus inert metadata.
const renderNativeHeading = nativeHeading.implementation.render as unknown as typeof sectionHeading.implementation.render;
const exportNativeHeading = nativeHeading.implementation.toExternalHTML as typeof sectionHeading.implementation.toExternalHTML;

// The native wrapper validates every prop against the native heading schema,
// so it must never receive the script-only metadata.
type ScriptHeadingBlock = Parameters<typeof sectionHeading.implementation.render>[0];
const nativeBlock = (block: ScriptHeadingBlock): ScriptHeadingBlock => {
  const props: Record<string, unknown> = { ...block.props };
  delete props['scriptSection'];
  delete props['scriptDirection'];
  delete props['scriptVisuals'];
  delete props['scriptDemo'];
  return { ...block, props: props as ScriptHeadingBlock['props'] };
};

export const scriptHeadingSpec: BlockSpec<'heading', typeof config.propSchema, 'inline'> = {
  config,
  implementation: {
    ...nativeHeading.implementation,
    render(block, editor) {
      return block.props.scriptSection
        ? sectionHeading.implementation.render.call(this, block, editor)
        : renderNativeHeading.call(this, nativeBlock(block), editor);
    },
    toExternalHTML(block, editor, context) {
      const output = exportNativeHeading!.call(this, nativeBlock(block), editor, context);
      if (!output) throw new Error('Could not export this script section heading.');
      return output;
    },
  },
  ...(nativeHeading.extensions && { extensions: nativeHeading.extensions }),
};
