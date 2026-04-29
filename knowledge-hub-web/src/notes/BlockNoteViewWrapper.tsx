/**
 * notes/BlockNoteViewWrapper.tsx
 *
 * Wraps BlockNoteView and adds a custom "Create Task" button to the
 * formatting toolbar that appears when the user selects text.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import {
  FormattingToolbar,
  FormattingToolbarController,
  useComponentsContext,
  BasicTextStyleButton,
  TextAlignButton,
  ColorStyleButton,
  NestBlockButton,
  UnnestBlockButton,
  BlockTypeSelect,
  CreateLinkButton,
} from '@blocknote/react';
import type { Theme } from '@blocknote/mantine';

interface Props {
  editor: any;
  theme: Theme;
  onCreateTask: (selectedText: string) => void;
}

function CreateTaskButton({ editor, onCreateTask }: { editor: any; onCreateTask: (text: string) => void }): React.ReactElement | null {
  const Components = useComponentsContext();
  if (!Components) return null;

  function handleClick(): void {
    const selection = editor.getSelectedText?.() as string | undefined;
    const text = (selection ?? '').trim();
    if (text) onCreateTask(text);
  }

  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Create Task in Plan"
      onClick={handleClick}
      label="Create Task"
    >
      ✦ Task
    </Components.FormattingToolbar.Button>
  );
}

export const BlockNoteViewWrapper: React.FC<Props> = ({ editor, theme, onCreateTask }) => (
  <BlockNoteView editor={editor} theme={theme} formattingToolbar={false}>
    <FormattingToolbarController
      formattingToolbar={() => (
        <FormattingToolbar>
          <BlockTypeSelect key="blockTypeSelect" />
          <BasicTextStyleButton basicTextStyle="bold" key="bold" />
          <BasicTextStyleButton basicTextStyle="italic" key="italic" />
          <BasicTextStyleButton basicTextStyle="underline" key="underline" />
          <BasicTextStyleButton basicTextStyle="strike" key="strike" />
          <BasicTextStyleButton basicTextStyle="code" key="code" />
          <TextAlignButton textAlignment="left" key="alignLeft" />
          <TextAlignButton textAlignment="center" key="alignCenter" />
          <TextAlignButton textAlignment="right" key="alignRight" />
          <ColorStyleButton key="colorStyleButton" />
          <NestBlockButton key="nestBlock" />
          <UnnestBlockButton key="unnestBlock" />
          <CreateLinkButton key="createLink" />
          <CreateTaskButton key="createTask" editor={editor} onCreateTask={onCreateTask} />
        </FormattingToolbar>
      )}
    />
  </BlockNoteView>
);
