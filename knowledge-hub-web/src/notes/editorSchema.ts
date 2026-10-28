import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs, type BlockSpec } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { entityMentionSpec, noteMentionSpec } from './EntityMention';
import { passageTagStyles } from './passageTags';

// BlockNote 0.47 declares this optional key as possibly undefined; the runtime
// spec is concrete. Preserve the optional runtime flag without erasing schema types.
type HeadingProps = Omit<typeof defaultBlockSpecs.heading.config.propSchema, 'isToggleable'> & {
  isToggleable: NonNullable<typeof defaultBlockSpecs.heading.config.propSchema.isToggleable>;
};
const headingSpec = defaultBlockSpecs.heading as BlockSpec<'heading', HeadingProps, 'inline'>;
// Default BlockNote schema with the codeBlock spec swapped for one with shiki
// syntax highlighting and the full supported-language list from
// @blocknote/code-block.
export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    heading: headingSpec,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    noteMention: noteMentionSpec,
    entityMention: entityMentionSpec,
  },
  styleSpecs: { ...defaultStyleSpecs, ...passageTagStyles },
});
