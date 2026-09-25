import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';

// Default BlockNote schema with the codeBlock spec swapped for one with shiki
// syntax highlighting and the full supported-language list from
// @blocknote/code-block.
export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any) as ReturnType<typeof BlockNoteSchema.create>;
