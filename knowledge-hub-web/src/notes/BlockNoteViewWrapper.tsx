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
import React, { useEffect, useRef } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import type { Theme } from '@blocknote/mantine';
import { clipboardHtmlText } from '../utils/clipboardText';

interface Props {
  // typed as any here only — NoteEditor passes the correctly-typed editor
  editor: any;
  theme: Theme;
  editable?: boolean;
  children?: React.ReactNode;
}

export const BlockNoteViewWrapper: React.FC<Props> = ({ editor, theme, editable = true, children }) => {
  const clipboardHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = clipboardHost.current;
    if (!host) return;
    let selectedText: string | null = null;
    const captureSelection = (): void => {
      selectedText = null;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return;
      const fragment = document.createElement('div');
      fragment.append(range.cloneContents());
      selectedText = clipboardHtmlText(fragment.innerHTML);
    };
    const copySelection = (event: ClipboardEvent): void => {
      if (selectedText === null || !event.clipboardData) return;
      // Keep BlockNote's rich/native payloads, but bypass its lossy Markdown conversion.
      event.clipboardData.setData('text/plain', selectedText);
      event.preventDefault();
      selectedText = null;
    };
    for (const type of ['copy', 'cut'] as const) {
      host.addEventListener(type, captureSelection, true);
      host.addEventListener(type, copySelection);
    }
    return () => {
      for (const type of ['copy', 'cut'] as const) {
        host.removeEventListener(type, captureSelection, true);
        host.removeEventListener(type, copySelection);
      }
    };
  }, []);
  useEffect(() => {
    const showYouTubeAsText = (): void => {
      let youtube = false;
      for (const block of editor.document) {
        if (block.type === 'heading') {
          const title = Array.isArray(block.content)
            ? block.content.map((part: { text?: string }) => part.text ?? '').join('').trim().toLowerCase() : '';
          youtube = title === 'youtube show notes';
        } else if (youtube && block.type === 'codeBlock') {
          editor.updateBlock(block, { type: 'paragraph', content: block.content });
        }
      }
    };
    showYouTubeAsText();
    return editor.onChange(showYouTubeAsText);
  }, [editor]);
  return <div ref={clipboardHost} className="notes-clipboard-host">
    <BlockNoteView editor={editor} theme={theme} editable={editable} formattingToolbar={false}>{children}</BlockNoteView>
  </div>;
};
