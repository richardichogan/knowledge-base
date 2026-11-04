import React from 'react';
import { defaultBlockSpecs, type BlockSpec } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { confirmDialog } from '../services/appDialogs';
import { SCRIPT_DIRECTION_LIMIT } from '../../../knowledge-hub-backend/src/utils/scriptSections';
import { preserveScriptSelection } from './scriptSectionSelection';

type HeadingProps = Omit<typeof defaultBlockSpecs.heading.config.propSchema, 'isToggleable'> & {
  isToggleable: NonNullable<typeof defaultBlockSpecs.heading.config.propSchema.isToggleable>;
};
const nativeHeading = defaultBlockSpecs.heading as BlockSpec<'heading', HeadingProps, 'inline'>;
const config = { ...nativeHeading.config, propSchema: { ...nativeHeading.config.propSchema,
  scriptSection: { default: false }, scriptDirection: { default: '' } } } as const;

const sectionHeading = createReactBlockSpec(config, {
  render: function ScriptSectionHeading({ block, editor, contentRef }) {
    const [, refreshOrder] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => editor.onChange(() => { refreshOrder(); }), [editor]);
    const siblings = editor.document.filter(item => item.type === 'heading' && item.props.scriptSection);
    const index = siblings.findIndex(item => item.id === block.id);
    const [error, setError] = React.useState<string | null>(null);
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
      <label className="kh-script-section__direction" contentEditable={false}>Delivery direction (not spoken)
        <textarea value={block.props.scriptDirection} maxLength={SCRIPT_DIRECTION_LIMIT} rows={2}
          disabled={!editor.isEditable} placeholder="Tone, pace, emphasis or other delivery nuance"
          onChange={event => perform(() => { editor.updateBlock(block, { props: { scriptDirection: event.target.value } }); })} />
      </label>
      {error && <p className="kh-script-section__error" role="alert" contentEditable={false}>{error}</p>}
    </div>;
  },
})();

// BlockNote's editor generic is invariant. This adapter retains the native
// renderer/toggle behaviour for the same heading schema plus inert metadata.
const renderNativeHeading = nativeHeading.implementation.render as unknown as typeof sectionHeading.implementation.render;
const exportNativeHeading = nativeHeading.implementation.toExternalHTML as typeof sectionHeading.implementation.toExternalHTML;

export const scriptHeadingSpec: BlockSpec<'heading', typeof config.propSchema, 'inline'> = {
  config,
  implementation: {
    ...nativeHeading.implementation,
    render(block, editor) {
      return block.props.scriptSection
        ? sectionHeading.implementation.render.call(this, block, editor)
        : renderNativeHeading.call(this, block, editor);
    },
    toExternalHTML(block, editor, context) {
      const output = exportNativeHeading!.call(this, block, editor, context);
      if (!output) throw new Error('Could not export this script section heading.');
      if (!block.props.scriptDirection) return output;
      const wrapper = document.createElement('div');
      wrapper.appendChild(output.dom);
      const direction = document.createElement('p');
      direction.textContent = `Delivery direction (not spoken): ${block.props.scriptDirection}`;
      wrapper.appendChild(direction);
      return { ...output, dom: wrapper };
    },
  },
  ...(nativeHeading.extensions && { extensions: nativeHeading.extensions }),
};
