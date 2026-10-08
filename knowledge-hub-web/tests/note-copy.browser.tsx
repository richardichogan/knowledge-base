import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoteEditor } from '../src/notes/NoteEditor';
import { api } from '../src/services/api';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import '../src/styles/global.scss';

api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
let copied = '';
let fail = false;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text: string) => { if (fail) throw new Error('Permission denied'); copied = text; },
} });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><NoteEditor doc={{
      id: 'copy-note', title: 'Original title', contentType: 'note',
      contentJson: JSON.stringify([
        { type: 'heading', props: { level: 1 }, content: 'Live title' },
        { type: 'paragraph', content: 'First paragraph.' },
        { type: 'paragraph', content: 'Second paragraph.' },
        { type: 'bulletListItem', content: 'List item' },
      ]), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }} onSaved={() => {}} /></MemoryRouter>
  </QueryClientProvider>,
);
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Note copy fixture timed out');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function runNoteCopyChecks(): Promise<string[]> {
  await waitFor(() => document.querySelector('.notes-copy-btn') !== null && getActiveBlockNoteEditor() !== null);
  const button = document.querySelector<HTMLButtonElement>('.notes-copy-btn')!;
  const editor = getActiveBlockNoteEditor()!;
  editor.insertBlocks([{ type: 'paragraph', content: 'Unsaved addition.' }], editor.document.at(-1)!, 'after');
  button.click();
  await waitFor(() => copied.includes('Unsaved addition.'));
  check(copied.startsWith('# Live title'), 'Copies the current title');
  check(copied.match(/# Live title/g)?.length === 1, 'Does not duplicate title');
  check(copied.includes('First paragraph.') && copied.includes('Second paragraph.') && copied.includes('List item'), 'Copies the whole note');
  check(/First paragraph\.\s*\n\s*\nSecond paragraph\./.test(copied), 'Keeps paragraph breaks');
  await waitFor(() => document.querySelector('[role="status"]')?.textContent === 'Copied whole note');
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'Body without a heading.' }]);
  button.click();
  await waitFor(() => copied.includes('Body without a heading.'));
  check(copied.startsWith('# Original title\n'), 'Includes stored title when body has no title heading');
  fail = true;
  button.click();
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('Could not copy') === true);
  await waitFor(() => !button.disabled);
  check(copied.includes('Body without a heading.'), 'Failure does not erase prior clipboard content');
  return ['whole note', 'current unsaved content', 'title without duplication', 'paragraphs and lists', 'success feedback', 'clipboard error and retry'];
}
Object.assign(window, { runNoteCopyChecks });
