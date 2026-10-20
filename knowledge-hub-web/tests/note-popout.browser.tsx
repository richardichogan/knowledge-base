import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotePopout } from '../src/notes/NotePopout';
import { DocumentTitleSync } from '../src/navigation/PageTitle';
import { NoteEditor } from '../src/notes/NoteEditor';
import { fromApiNote } from '../src/notes/noteStorage';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import { api } from '../src/services/api';
import type { Note } from '../src/types/contentItem';
import './note-draft-identity';
import '../src/styles/global.scss';

const KEY = 'athena.fixture.popout';
const FAIL = `${KEY}.fail`;
const reader = new URLSearchParams(location.search).has('reader');
const now = new Date().toISOString();
const initial: Note = {
  id: 'popout-note', content: JSON.stringify({ title: 'Demo steps', contentType: 'script',
    contentJson: JSON.stringify([
      { type: 'heading', content: 'Demo steps' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Start with the workforce.', styles: { bold: true } }] },
      { type: 'numberedListItem', content: 'Select a workforce.',
        children: [{ type: 'bulletListItem', content: 'Check each handoff.' }] },
      ...Array.from({ length: 70 }, (_, i) => ({ type: 'paragraph', content: `Step ${i + 1}: demonstrate this part of the flow.` })),
    ]) }),
  createdAt: now, updatedAt: now, tags: [], linkedItems: [], status: 'active', revision: 0,
};
if (!reader || localStorage.getItem(KEY) === null) { localStorage.setItem(KEY, JSON.stringify(initial)); localStorage.removeItem(FAIL); }
function persisted(): Note { return JSON.parse(localStorage.getItem(KEY)!) as Note; }
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
api.getNote = async id => {
  check(id === initial.id, 'Reader fetches the requested note');
  if (localStorage.getItem(FAIL)) throw new Error('Fixture note temporarily unavailable');
  return { success: true, data: persisted() };
};
api.patchNote = async (_id, content) => {
  const note = { ...persisted(), content, revision: (persisted().revision ?? 0) + 1 };
  localStorage.setItem(KEY, JSON.stringify(note));
  return { success: true, data: note };
};
let hideEditor: () => void = () => {};
function Fixture(): React.ReactElement {
  const [show, setShow] = useState(true);
  hideEditor = () => { setShow(false); };
  return show ? <NoteEditor doc={fromApiNote(initial)} onSaved={() => {}} /> : <p>Another Think note is now selected.</p>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={reader ? ['/think/notes/popout-note/popout'] : ['/think']}>
      <DocumentTitleSync />
      <Routes>
        <Route path="/think" element={<Fixture />} />
        <Route path="/think/notes/:noteId/popout" element={<NotePopout />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Note pop-out fixture timed out');
}
async function runNotePopoutChecks(): Promise<string[]> {
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  const editor = getActiveBlockNoteEditor()!;
  const trigger = document.querySelector<HTMLButtonElement>('.notes-popout-btn')!;
  const open = window.open;
  let popup: Window | null = null;
  function openedWindow(): Window {
    if (!popup) throw new Error('The note window did not open');
    return popup;
  }
  try {
    window.open = () => null;
    trigger.click();
    await waitFor(() => document.body.textContent?.includes('Pop-up blocked') === true);
    window.open = (url, name, features) => {
      check(url === '/think/notes/popout-note/popout', 'Launch uses the standalone note route');
      check(name === 'athena-note-popout-note' && features?.includes('popup') === true, 'Launch has a per-note window target');
      popup = open.call(window, '/tests/note-popout.html?reader=1', name, features);
      return popup;
    };
    editor.insertBlocks([{ type: 'paragraph', content: 'Unsaved before pop-out' }], editor.document.at(-1)!, 'after');
    localStorage.setItem(FAIL, '1');
    trigger.click();
    await waitFor(() => popup?.document.querySelector('.kh-data-notice') !== null && popup?.document.querySelector('.kh-data-notice') !== undefined);
    const child = openedWindow();
    check(child.document.querySelector('.bn-editor') === null, 'Initial load failure never becomes empty writing');
    localStorage.removeItem(FAIL);
    child.document.querySelector<HTMLButtonElement>('.kh-data-notice button')!.click();
    await waitFor(() => popup?.document.querySelector('.note-popout .bn-editor') !== null && popup?.document.querySelector('.note-popout .bn-editor') !== undefined);
    await waitFor(() => child.document.body.textContent?.includes('Unsaved before pop-out') === true);
    check(child.opener === null, 'Reader is detached from its opener');
    check(child.document.querySelector('[contenteditable="true"]') === null, 'Pop-out is read-only');
    check(child.document.querySelector('.notes-top-bar, .notes-side-panel, .kh-header') === null, 'Only note content is shown');
    check(child.document.querySelector('strong')?.textContent === 'Start with the workforce.', 'Rich writing is preserved');
    check(child.document.querySelector('[data-content-type="numberedListItem"]')?.textContent?.includes('Select a workforce.') === true
      && child.document.querySelector('[data-content-type="bulletListItem"]')?.textContent?.includes('Check each handoff.') === true,
    'Numbered demo steps and nested lists are preserved');
    check(getActiveBlockNoteEditor() === editor, 'Pop-out does not replace the editable note registry');
    const scroll = child.document.querySelector<HTMLElement>('.note-popout')!;
    scroll.scrollTop = 450;
    editor.insertBlocks([{ type: 'paragraph', content: 'Updated while viewing demo' }], editor.document.at(-1)!, 'after');
    await waitFor(() => child.document.body.textContent?.includes('Updated while viewing demo') === true);
    check(scroll.scrollTop === 450, 'Saved updates preserve reading position');
    check(child.document.title === 'Demo steps · Think · Athena', `Window title identifies the note (got "${child.document.title}")`);
    localStorage.setItem(FAIL, '1');
    await waitFor(() => child.document.querySelector('.kh-data-notice') !== null);
    check(child.document.body.textContent?.includes('Updated while viewing demo') === true, 'Refresh failure retains the last loaded writing');
    localStorage.removeItem(FAIL);
    child.document.querySelector<HTMLButtonElement>('.kh-data-notice button')!.click();
    await waitFor(() => child.document.querySelector('.kh-data-notice') === null);
    hideEditor();
    await waitFor(() => document.querySelector('.notes-editor-panel') === null);
    check(!child.closed && child.document.body.textContent?.includes('Demo steps') === true, 'Reader remains open when Think changes notes');
    child.resizeTo(390, 800);
    await new Promise(resolve => setTimeout(resolve, 200));
    check(scroll.scrollWidth <= scroll.clientWidth, 'Content fits a narrow window');
    return ['Pop-up blocking and initial-load failure/retry', 'Independent content-only read-only window with rich writing',
      'Unsaved writing saved on launch; saved updates retain scroll position', 'Refresh failure and retry retain writing',
      'Think navigation leaves the reader open; narrow window fits'];
  } finally {
    window.open = open;
    (popup as Window | null)?.close();
    localStorage.removeItem(KEY); localStorage.removeItem(FAIL);
  }
}
Object.assign(window, { runNotePopoutChecks });
