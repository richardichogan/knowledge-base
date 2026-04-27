/**
 * notes/BlockNoteViewWrapper.tsx
 *
 * Thin wrapper around BlockNoteView that accepts the editor as `unknown`
 * to work around a TypeScript generic variance issue in BlockNote 0.47
 * when used with exactOptionalPropertyTypes.
 *
 * The cast is safe: BlockNoteView only reads the editor at runtime via
 * the BlockNote internal context.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import type { Theme } from '@blocknote/mantine';

interface Props {
  // typed as any here only — NoteEditor passes the correctly-typed editor
  editor: any;
  theme: Theme;
}

export const BlockNoteViewWrapper: React.FC<Props> = ({ editor, theme }) => (
  <BlockNoteView editor={editor} theme={theme} />
);
