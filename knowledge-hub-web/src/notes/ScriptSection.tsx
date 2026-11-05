import React from 'react';
import { defaultBlockSpecs, type BlockSpec } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { confirmDialog } from '../services/appDialogs';
import { preserveScriptSelection } from './scriptSectionSelection';
import { ScriptVisualPreview } from '../features/autocue/ScriptVisualPreview';
import { useAthenaContext } from '../context/AthenaContext';
import { getActiveNoteId } from '../utils/activeBlockNoteEditor';
import { readSectionVisuals } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';

type HeadingProps = Omit<typeof defaultBlockSpecs.heading.config.propSchema, 'isToggleable'> & {
  isToggleable: NonNullable<typeof defaultBlockSpecs.heading.config.propSchema.isToggleable>;
};
const nativeHeading = defaultBlockSpecs.heading as BlockSpec<'heading', HeadingProps, 'inline'>;
const config = { ...nativeHeading.config, propSchema: { ...nativeHeading.config.propSchema,
  scriptSection: { default: false }, scriptDirection: { default: '' }, scriptVisuals: { default: '' } } } as const;

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
      <ScriptVisualPreview section={block} presentationTitle={pageContext?.title ?? ''} pageOffset={pageOffset} totalScenes={totalScenes} ask={sceneId => {
        const noteId = getActiveNoteId();
        if (!noteId || !pageContext || pageContext.id !== noteId) { setError('Reopen the script before asking Athena to change its visuals.'); return; }
        openAthena(`Please ${block.props.scriptVisuals ? 'update' : 'create'} the visuals for script section ${block.id}${sceneId ? `, scene ${sceneId}` : ''}. Read its current scenes first. Keep the spoken script unchanged. Use concepts and meaningful animation, not narration repeated as bullet points. ${block.props.scriptVisuals ? 'The change I want is: ' : ''}`, pageContext);
      }} />
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
