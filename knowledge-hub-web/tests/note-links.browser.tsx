import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoteEditor } from '../src/notes/NoteEditor';
import { AthenaContextProvider } from '../src/context/AthenaContext';
import { api } from '../src/services/api';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import { entityLinkHref, type EntityLinkTarget } from '../src/notes/entityLinks';
import { fromApiNote } from '../src/notes/noteStorage';
import type { Note } from '../src/types/contentItem';
import './note-draft-identity';
import '../src/styles/global.scss';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const targets: EntityLinkTarget[] = (['note', 'spark', 'diagram', 'project'] as const).map((type, i) => ({
  type, id: id(i + 1), title: `Roadmap ${type}`, href: entityLinkHref(type, id(i + 1)),
}));
let created = 0;
let failSearch = false;
let failCreate = false;
let persisted: Note = {
  id: id(99), content: JSON.stringify({ title: 'Link fixture', contentType: 'note',
    contentJson: JSON.stringify([{ type: 'heading', content: 'Link fixture' }, { type: 'paragraph', content: '' }]) }),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], linkedItems: [],
  status: 'active', projectId: 'source-project', revision: 0,
};
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
api.getNoteBacklinks = async () => ({ success: true, data: { items: [targets[0]!], hasMore: false } });
api.getLinkTargets = async (q = '', type, targetId) => {
  if (failSearch) throw new Error('Fixture lookup unavailable');
  return { success: true, data: targets.filter(target => (!type || target.type === type) &&
    (!targetId || target.id === targetId) && target.title.toLowerCase().includes(q.toLowerCase())).map(target => ({ ...target })) };
};
api.createNote = async input => {
  if (failCreate) throw new Error('Fixture creation unavailable');
  if (input.projectId !== 'source-project') throw new Error('Wrong linked-note project');
  created++;
  const title = (JSON.parse(input.content) as { title: string }).title;
  const target: EntityLinkTarget = { type: 'note', id: id(created + 10), title, href: entityLinkHref('note', id(created + 10)) };
  targets.push(target);
  return { success: true, data: { ...persisted, id: target.id, content: input.content } };
};
api.patchNote = async (_id, content, _tags, _project, expected) => {
  if (expected !== persisted.revision) throw new Error('Fixture revision conflict');
  persisted = { ...persisted, content, revision: (persisted.revision ?? 0) + 1 };
  return { success: true, data: persisted };
};
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture(): React.ReactElement {
  const [doc, setDoc] = useState(fromApiNote(persisted));
  return <NoteEditor doc={doc} onSaved={setDoc} />;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}>
  <MemoryRouter><AthenaContextProvider><Fixture /></AthenaContextProvider></MemoryRouter>
</QueryClientProvider>);
async function waitFor(check: () => boolean): Promise<void> {
  for (let n = 0; n < 400; n++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Entity link fixture timed out: ${document.body.innerText}`);
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.note-link-menu__item')].find(item => item.textContent?.startsWith(text));
}
async function type(text: string): Promise<void> {
  const editor = getActiveBlockNoteEditor()!;
  editor.focus();
  for (const char of text) {
    const view = editor._tiptapEditor.view;
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', handler => handler(view, from, to, char));
    if (!handled) editor._tiptapEditor.commands.insertContent(char);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function newParagraph(code = false): void {
  const editor = getActiveBlockNoteEditor()!;
  const [block] = editor.insertBlocks([{ type: code ? 'codeBlock' : 'paragraph', content: '' }], editor.document.at(-1)!, 'after');
  editor.setTextCursorPosition(block!, 'end');
  editor.focus();
}
async function escapeMenu(): Promise<void> {
  getActiveBlockNoteEditor()!._tiptapEditor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }));
  await waitFor(() => document.querySelector('.note-link-menu') === null);
}
async function runNoteLinkChecks(): Promise<string[]> {
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  const editor = getActiveBlockNoteEditor()!;
  for (const typeName of ['note', 'spark', 'diagram', 'project']) {
    newParagraph();
    await type('@Roadmap');
    await waitFor(() => button(`Roadmap ${typeName}`) !== undefined);
    button(`Roadmap ${typeName}`)!.click();
    await waitFor(() => document.querySelector('.note-link-menu') === null);
  }
  check(JSON.stringify(editor.document).includes('noteMention'), '@ inserts a stable note reference');
  check(JSON.stringify(editor.document).includes('entityMention'), '@ inserts typed references for other entities');
  await waitFor(() => [...document.querySelectorAll('.note-mention')].some(link => link.textContent?.includes('Roadmap project')));
  newParagraph();
  await type('See [[Roadmap note]]');
  await waitFor(() => editor.document.filter(block => JSON.stringify(block).includes('"noteMention"')).length === 2);
  check(!JSON.stringify(editor.document.at(-1)).includes('[['), 'closed wiki links resolve even in the middle of prose');
  newParagraph();
  await type('[[Fresh linked idea');
  await waitFor(() => button('Create note "Fresh linked idea"') !== undefined);
  check(created === 0, 'typing never creates notes without a deliberate selection');
  button('Create note "Fresh linked idea"')!.click();
  await waitFor(() => created === 1 && document.querySelector('.note-link-menu') === null && editor.isEditable);
  check(document.querySelector('.notes-editor-scroll')?.getAttribute('data-ctx-ref-id') === id(99), 'creation stays in the current note');
  check(JSON.stringify(editor.document).includes(id(11)), 'new-note link inserted in source');
  newParagraph();
  await type('[[Another fresh idea]]');
  await waitFor(() => button('Create note "Another fresh idea"') !== undefined);
  check(created === 1, 'closing brackets cannot silently create a note');
  await escapeMenu();
  newParagraph();
  editor.insertInlineContent(['Pasted [[Roadmap note]]']);
  await new Promise(resolve => setTimeout(resolve, 200));
  check(JSON.stringify(editor.document).includes('Pasted [[Roadmap note]]'), `pasted wiki syntax remains plain text: ${JSON.stringify(editor.document)}`);
  check(document.querySelector('.note-link-menu') === null, 'paste does not activate the typed-link controller');
  failSearch = true;
  newParagraph();
  await type('@Unavailable lookup');
  await waitFor(() => button('Could not find links') !== undefined);
  check(button('Could not find links')!.disabled, 'failed search must not offer to create a duplicate note');
  check(created === 1, 'search failure does not create a note');
  await escapeMenu();
  failSearch = false;
  failCreate = true;
  newParagraph();
  await type('[[Creation failure');
  await waitFor(() => button('Create note "Creation failure"') !== undefined);
  button('Create note "Creation failure"')!.click();
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('Fixture creation unavailable') === true);
  check(JSON.stringify(editor.document).includes('[[Creation failure]]'), `failed creation retains the typed link text: ${JSON.stringify(editor.document)}`);
  await waitFor(() => document.querySelector('.note-link-menu') === null);
  failCreate = false;
  newParagraph();
  await type('user@example.com');
  check(document.querySelector('.note-link-menu') === null, 'email addresses do not open suggestions');
  newParagraph(true);
  await type('@Roadmap [[Roadmap');
  check(document.querySelector('.note-link-menu') === null, 'code blocks do not open suggestions');
  await waitFor(() => persisted.content.includes('entityMention') && persisted.content.includes('Creation failure'));
  const markdown = await editor.blocksToMarkdownLossy(editor.document);
  check(markdown.includes('Roadmap note') && markdown.includes('think?noteId='), 'frontend markdown export retains links and readable titles');
  targets[0]!.title = 'Renamed roadmap';
  await qc.invalidateQueries({ queryKey: ['entity-link', 'note', id(1)] });
  await waitFor(() => [...document.querySelectorAll('.note-mention')].some(link => link.textContent?.includes('Renamed roadmap')));
  const sourceSnapshot = JSON.stringify(editor.document);
  check(!sourceSnapshot.includes('Renamed roadmap'), 'renames do not rewrite ID-based references');
  const savedBlocks = JSON.parse((JSON.parse(persisted.content) as { contentJson: string }).contentJson);
  editor.replaceBlocks(editor.document, savedBlocks);
  check(JSON.stringify(editor.document).includes('entityMention'), 'save and reload preserve typed links');
  document.querySelector<HTMLButtonElement>('#think-side-tab-connections')!.click();
  await waitFor(() => document.querySelector('.note-backlinks__link') !== null);
  check(document.querySelector('.note-backlinks__link')?.getAttribute('href') === entityLinkHref('note', id(1)), 'backlinks navigate to source notes');
  return ['@ resolves notes/sparks/diagrams/projects', '[[ closed exact link resolves inline', 'explicit new-note creation in source project',
    'no creation while typing or pasting', 'search and create failures visible, text retained', 'emails/code unaffected',
    'readable exports', 'rename-safe references', 'save/reload', 'backlinks'];
}
Object.assign(window, { runNoteLinkChecks });
