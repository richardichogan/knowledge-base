import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoteEditor } from '../src/notes/NoteEditor';
import { api } from '../src/services/api';
import type { Note } from '../src/types/contentItem';
import type { GitHubPublication, GitHubPushPayload } from '../src/notes/types';
import { fromApiNote } from '../src/notes/noteStorage';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import '../src/styles/global.scss';

let persisted: Note = {
  id: '11111111-1111-4111-8111-111111111111', revision: 0,
  content: JSON.stringify({ title: 'Publishing test', contentType: 'note',
    contentJson: JSON.stringify([{ type: 'heading', props: { level: 1 }, content: 'Publishing test' },
      { type: 'paragraph', content: 'Original writing' }]) }),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  tags: [], linkedItems: [], status: 'active',
};
let publication: GitHubPublication | null = null;
let publishError = true;
let conflict = false;
let lastPayload: GitHubPushPayload | null = null;
let previousWriting = '';
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async (_id, check) => {
  if (publication && check) publication = { ...publication,
    status: conflict ? 'conflict' : 'synced',
    error: conflict ? 'GitHub changed. Choose which version to keep.' : null };
  return { success: true, data: publication };
};
api.getNoteGitHubRepositories = async () => ({ success: true, data: {
  items: [{ name: 'owner/demo', defaultBranch: 'develop', private: true },
    { name: 'owner/public', defaultBranch: 'main', private: false }], hasMore: false,
} });
api.getNoteGitHubFolders = async (_repo, folder) => ({ success: true, data: {
  folders: folder === '' ? ['docs'] : folder === 'docs' ? ['docs/use-cases'] : [], branch: 'develop',
} });
api.patchNote = async (_id, content, _tags, _project, expected) => {
  if (expected !== persisted.revision) throw new Error('Wrong saved note revision');
  persisted = { ...persisted, content, revision: (persisted.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
  if (publication && publication.status !== 'conflict') publication = { ...publication, status: 'pending' };
  return { success: true, data: persisted };
};
api.publishNoteToGitHub = async payload => {
  if (publishError) return { success: false, error: { code: 'INTEGRATION_ERROR', message: 'GitHub rejected this publish' } };
  if (payload.expectedRevision !== persisted.revision || !persisted.content.includes('Unsaved latest writing')) throw new Error('Publish did not save the live writing first');
  lastPayload = payload;
  publication = { noteId: persisted.id, repo: payload.repo, branch: 'develop', path: payload.filePath,
    url: `https://github.com/${payload.repo}/blob/develop/${payload.filePath}`, commitUrl: 'https://github.com/owner/demo/commit/test',
    status: 'synced', error: null };
  return { success: true, data: publication };
};
api.getNoteGitHubRemote = async () => ({ success: true, data: { sha: 'reviewed-sha', markdown: '# From GitHub\n\nExternal version writing' } });
api.resolveNoteGitHub = async (_id, choice, remoteSha, revision) => {
  if (choice !== 'github' || remoteSha !== 'reviewed-sha' || revision !== persisted.revision) throw new Error('Wrong conflict resolution');
  previousWriting = persisted.content;
  persisted = { ...persisted, revision: (persisted.revision ?? 0) + 1,
    content: JSON.stringify({ title: 'From GitHub', contentType: 'note', contentJson: JSON.stringify([
      { type: 'heading', props: { level: 1 }, content: 'From GitHub' }, { type: 'paragraph', content: 'External version writing' },
    ]) }) };
  conflict = false;
  publication = { ...publication!, status: 'synced', error: null };
  return { success: true, data: publication };
};
api.getNote = async () => ({ success: true, data: persisted });
function Fixture(): React.ReactElement {
  const [doc, setDoc] = useState(fromApiNote(persisted));
  return <NoteEditor doc={doc} onSaved={setDoc} />;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Fixture /></MemoryRouter>
  </QueryClientProvider>,
);
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('GitHub publishing fixture timed out');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function select(selector: string, value: string): void {
  const element = document.querySelector<HTMLSelectElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
function input(selector: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
async function chooseDestination(): Promise<void> {
  button('Push to GitHub').click();
  await waitFor(() => document.querySelector('#github-repo option[value="owner/demo"]') !== null);
  select('#github-repo', 'owner/demo');
  await waitFor(() => document.querySelector('option[value="docs"]') !== null);
  select('[aria-label="Browse repository folders"]', 'docs');
  await waitFor(() => document.querySelector('option[value="docs/use-cases"]') !== null);
  select('[aria-label="Browse repository folders"]', 'docs/use-cases');
  await waitFor(() => document.querySelector<HTMLInputElement>('#github-file-path')?.value.startsWith('docs/use-cases/') === true);
  input('#github-file-path', 'docs/use-cases/My note.md');
  input('#github-commit-msg', 'Publish my note');
}
Object.assign(window, { runNoteGitHubChecks: async () => {
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  button('Metadata').click();
  await waitFor(() => document.querySelector('.notes-meta-gh-heading') !== null);
  const editor = getActiveBlockNoteEditor()!;
  editor.insertBlocks([{ type: 'paragraph', content: 'Unsaved latest writing' }], editor.document.at(-1)!, 'after');
  await chooseDestination();
  check(document.querySelector('.notes-github-help')?.textContent !== '', 'Publishing guidance is present');
  button('Push').click();
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('GitHub rejected') === true);
  check(publication === null && !document.body.textContent?.includes('Published to GitHub'), 'A rejected push cannot show fake success');
  check(JSON.stringify(editor.document).includes('Unsaved latest writing'), 'Publishing failure retains writing');
  publishError = false;
  await chooseDestination();
  button('Push').click();
  await waitFor(() => document.querySelector('.notes-meta-gh-heading')?.textContent === 'Published to GitHub');
  check(lastPayload?.repo === 'owner/demo' && lastPayload?.filePath === 'docs/use-cases/My note.md', 'Selected repo, nested folder and custom filename sent to backend');
  check(document.querySelector('.notes-meta-gh-text a')?.getAttribute('href')?.includes('/owner/demo/blob/develop/docs/use-cases/My note.md') === true, 'Published copy has a GitHub link');
  button('Push to GitHub').click();
  await waitFor(() => document.querySelector<HTMLSelectElement>('#github-repo')?.disabled === true);
  check(document.querySelector<HTMLInputElement>('#github-file-path')?.readOnly === true, 'Destination pinned after publishing');
  button('Cancel').click();
  editor.insertBlocks([{ type: 'paragraph', content: 'Saved later edit' }], editor.document.at(-1)!, 'after');
  await waitFor(() => document.querySelector('.notes-meta-gh-heading')?.textContent === 'Update pending');
  button('Check GitHub').click();
  await waitFor(() => document.querySelector('.notes-meta-gh-heading')?.textContent === 'Published to GitHub');
  conflict = true;
  button('Check GitHub').click();
  await waitFor(() => document.querySelector('.notes-meta-gh-heading')?.textContent === 'GitHub changed');
  button('Review versions').click();
  await waitFor(() => document.querySelector('.notes-github-versions') !== null);
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="Think version"]')?.value.includes('Saved later edit') === true, 'Review shows current Think writing');
  check(document.querySelector<HTMLTextAreaElement>('[aria-label="GitHub version"]')?.value.includes('External version writing') === true, 'Review shows exact fetched GitHub writing');
  document.querySelectorAll<HTMLInputElement>('input[name="github-version"]')[1]!.click();
  button('Accept GitHub version').click();
  await waitFor(() => JSON.stringify(editor.document).includes('External version writing') && !document.querySelector('.notes-github-versions'));
  check(previousWriting.includes('Saved later edit'), 'Previous writing retained before accepting GitHub');
  check(editor.isEditable, 'GitHub conflict does not lock the note as a stale note-save conflict');
  return ['repository picker', 'nested folder browser', 'custom file path', 'default branch', 'save latest writing before publish',
    'failed push is explicit', 'pinned destination and GitHub link', 'autosave marks update pending', 'external conflict review',
    'GitHub version adoption updates the live editor'];
} });
