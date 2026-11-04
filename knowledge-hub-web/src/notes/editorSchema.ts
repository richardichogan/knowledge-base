import { BlockNoteSchema, createBlockSpec, createCodeBlockSpec, createStyleSpecFromTipTapMark, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs, type BlockSpec } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { entityMentionSpec, noteMentionSpec } from './EntityMention';
import { passageTagStyles } from './passageTags';
import { scriptCueSpec } from './ScriptCue';

// BlockNote 0.47 declares this optional key as possibly undefined; the runtime
// spec is concrete. Preserve the optional runtime flag without erasing schema types.
type HeadingProps = Omit<typeof defaultBlockSpecs.heading.config.propSchema, 'isToggleable'> & {
  isToggleable: NonNullable<typeof defaultBlockSpecs.heading.config.propSchema.isToggleable>;
};
const headingSpec = defaultBlockSpecs.heading as BlockSpec<'heading', HeadingProps, 'inline'>;
const codeBlockSpec = createCodeBlockSpec(codeBlockOptions);
// Set this before mounting: mutating code marks afterwards feeds ProseMirror's DOM observer.
const codeStyleSpec = createStyleSpecFromTipTapMark(
  defaultStyleSpecs.code.implementation.mark.configure({ HTMLAttributes: { spellcheck: 'false' } }), 'boolean',
);
const codeBlockWithSpelling = createBlockSpec(codeBlockSpec.config, {
  ...codeBlockSpec.implementation,
  render(...args) {
    const rendered = codeBlockSpec.implementation.render.call(this, ...args);
    rendered.contentDOM?.setAttribute('spellcheck', 'false');
    return rendered;
  },
}, codeBlockSpec.extensions)();
// Default BlockNote schema with the codeBlock spec swapped for one with shiki
// syntax highlighting and the full supported-language list from
// @blocknote/code-block.
export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    heading: headingSpec,
    codeBlock: codeBlockWithSpelling,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    noteMention: noteMentionSpec,
    entityMention: entityMentionSpec,
    scriptCue: scriptCueSpec,
  },
  styleSpecs: { ...defaultStyleSpecs, code: codeStyleSpec, ...passageTagStyles },
});
