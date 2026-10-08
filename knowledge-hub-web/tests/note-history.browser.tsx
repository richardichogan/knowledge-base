import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoteEditor } from '../src/notes/NoteEditor';
import { NoteEditCard } from '../src/components/athena/NoteEditCard';
import { api } from '../src/services/api';
import type { NoteVersion } from '../src/services/api';
import type { Note } from '../src/types/contentItem';
import type { NoteDocument } from '../src/notes/types';
import { getActiveBlockNoteEditor, runNoteAction } from '../src/utils/activeBlockNoteEditor';
import { fromApiNote } from '../src/notes/noteStorage';
import { AppDialogHost } from '../src/components/AppDialog';
import '../src/styles/global.scss';

const now = new Date().toISOString();
let persisted: Note = {
  id: 'history-note', content: JSON.stringify({ title: 'Original', contentType: 'use-case', githubPath: 'keep.md',
    contentJson: JSON.stringify([{ type: 'heading', props: { level: 1 }, content: 'Original' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Rich original body', styles: { bold: true } }] }]) }),
  createdAt: now, updatedAt: now, revision: 0, tags: ['keep'], linkedItems: [], status: 'active', projectId: 'keep-project',
};
let versions: NoteVersion[] = [];
let failCheckpoint = true;
let failHistory = true;
let failRestore = true;
let stale = false;
let saveCount = 0;
let checkpoints = 0;
let releaseCheckpoint: (() => void) | undefined;
let releaseRestore: (() => void) | undefined;
let holdCheckpoint = false;
let holdRestore = false;
function addVersion(reason: NoteVersion['reason']): void {
  const writing = JSON.parse(persisted.content) as NoteVersion['writing'];
  versions.unshift({ id: `v${versions.length + 1}`, writing, reason, revision: persisted.revision ?? 0,
    writing_updated_at: persisted.updatedAt, created_at: new Date().toISOString(), restored_from: null });
}
function persist(content: string, expected?: number): void {
  if (stale || expected !== persisted.revision) throw Object.assign(new Error('Changed elsewhere'), { isAxiosError: true, response: { status: 409 } });
  persisted = { ...persisted, content, revision: (persisted.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
}
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.patchNote = async (_id, content, _tags, _project, expected) => {
  saveCount++;
  if (versions.length === 0) addVersion('automatic');
  persist(content, expected);
  return { success: true, data: persisted };
};
api.checkpointNote = async (_id, content, expected) => {
  checkpoints++;
  if (failCheckpoint) throw new Error('Checkpoint unavailable. No edits applied.');
  if (holdCheckpoint) await new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  persist(content, expected);
  addVersion('before_athena');
  return { success: true, data: persisted };
};
api.getNoteHistory = async () => {
  if (failHistory) throw new Error('History unavailable');
  return { success: true, data: versions.map(({ writing: _writing, ...summary }) => summary) };
};
api.getNoteVersion = async (_id, id) => {
  const version = versions.find(item => item.id === id);
  if (!version) throw new Error('Not found');
  return { success: true, data: version };
};
api.restoreNoteVersion = async (_id, id, expected, draft) => {
  if (failRestore) throw new Error('Restore unavailable. Draft retained.');
  const selected = versions.find(item => item.id === id)!;
  if (holdRestore) await new Promise<void>(resolve => { releaseRestore = resolve; });
  if (draft !== undefined) persisted = { ...persisted, content: draft };
  addVersion('before_restore');
  persist(JSON.stringify({ ...JSON.parse(persisted.content), ...selected.writing }), expected);
  return { success: true, data: persisted };
};
function Fixture(): React.ReactElement {
  const [doc, setDoc] = useState<NoteDocument>(fromApiNote(persisted));
  const [showEdits, setShowEdits] = useState(false);
  useEffect(() => { setShowEdits(true); }, []);
  return <>
    <NoteEditor doc={doc} onSaved={setDoc} />
    {showEdits && <NoteEditCard noteId={doc.id} edits={[{ action: 'replace_all', summary: 'Rewrite test', markdown: '# Athena title\n\nAthena replacement.' }]} />}
    <AppDialogHost />
  </>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Fixture /></MemoryRouter>
  </QueryClientProvider>,
);
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 350; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('History fixture timed out');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
function button(selector: string): HTMLButtonElement { return document.querySelector<HTMLButtonElement>(selector)!; }
async function confirmRestore(): Promise<void> {
  button('.note-history__button--restore').click();
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === 'Restore writing')!;
  confirm.click();
}
async function runNoteHistoryChecks(): Promise<string[]> {
  const legacy = fromApiNote({ ...persisted, content: 'Legacy full writing' });
  check(legacy.contentJson.includes('Legacy full writing'), 'Legacy writing is not replaced with an empty body');
  let malformedRejected = false;
  try { fromApiNote({ ...persisted, content: '{"contentJson":"broken"}' }); } catch { malformedRejected = true; }
  check(malformedRejected, 'Malformed writing cannot silently become an empty note');
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  await waitFor(() => document.querySelector<HTMLButtonElement>('.note-edit-card__actions button')?.disabled === false);
  const editor = getActiveBlockNoteEditor()!;
  editor.insertBlocks([{ type: 'paragraph', content: 'Unsaved before Athena' }], editor.document.at(-1)!, 'after');
  const apply = button('.note-edit-card__actions button');
  apply.click();
  await waitFor(() => document.querySelector('.note-edit-card [role="alert"]')?.textContent?.includes('Checkpoint unavailable') === true);
  check(JSON.stringify(editor.document).includes('Unsaved before Athena'), 'Checkpoint failure preserves live writing');
  check(!JSON.stringify(editor.document).includes('Athena replacement'), 'Checkpoint failure blocks Athena replacement');
  failCheckpoint = false;
  holdCheckpoint = true;
  apply.click();
  await waitFor(() => releaseCheckpoint !== undefined);
  check(!editor.isEditable && apply.disabled, 'Typing and duplicate Apply blocked during checkpoint');
  releaseCheckpoint!();
  await waitFor(() => JSON.stringify(editor.document).includes('Athena replacement'));
  check(checkpoints === 2, 'One checkpoint request per batch, plus failed attempt');
  check(versions[0]!.writing.contentJson.includes('Unsaved before Athena'), 'Exact unsaved pre-Athena draft recoverable');
  check(versions[0]!.writing.contentJson.includes('"bold":true'), 'Rich formatting preserved');
  await waitFor(() => persisted.content.includes('Athena replacement'));
  button('#think-side-tab-history').click();
  await waitFor(() => document.querySelector('.note-history__error')?.textContent?.includes('History unavailable') === true);
  failHistory = false;
  button('.note-history__button').click();
  await waitFor(() => document.querySelector('.note-history__entry') !== null);
  button('.note-history__entry').click();
  await waitFor(() => document.querySelector('.note-history__preview')?.textContent?.includes('Unsaved before Athena') === true);
  check(getActiveBlockNoteEditor() === editor, 'Preview does not register as live editor');
  check(document.querySelector('.note-history__preview [contenteditable="true"]') === null, 'Historical preview read-only');
  editor.insertBlocks([{ type: 'paragraph', content: 'Unsaved immediately before restore' }], editor.document.at(-1)!, 'after');
  await confirmRestore();
  await waitFor(() => document.querySelector('.note-history__error')?.textContent?.includes('Restore unavailable') === true);
  check(JSON.stringify(editor.document).includes('Athena replacement'), 'Restore failure keeps current writing and preview');
  failRestore = false;
  holdRestore = true;
  await confirmRestore();
  await waitFor(() => releaseRestore !== undefined);
  check(!editor.isEditable, 'Editor locked during restore');
  releaseRestore!();
  await waitFor(() => JSON.stringify(editor.document).includes('Unsaved before Athena') && editor.isEditable);
  check(!JSON.stringify(editor.document).includes('Athena replacement'), 'Successful restore updates live editor');
  check(persisted.projectId === 'keep-project' && persisted.tags[0] === 'keep' && JSON.parse(persisted.content).githubPath === 'keep.md', 'Organisation preserved');
  check(versions[0]!.reason === 'before_restore' && versions[0]!.writing.contentJson.includes('Unsaved immediately before restore'), 'Restore atomically preserves unsaved writing');
  const savesAfterRestore = saveCount;
  await new Promise(resolve => setTimeout(resolve, 3200));
  check(saveCount === savesAfterRestore, 'Pre-restore debounce cannot overwrite restored writing');
  stale = true;
  editor.insertBlocks([{ type: 'paragraph', content: 'Conflicting local draft' }], editor.document.at(-1)!, 'after');
  await waitFor(() => document.querySelector('.notes-save-status[role="alert"]')?.textContent?.includes('Autosave paused') === true);
  const savesAfterConflict = saveCount;
  editor.insertBlocks([{ type: 'paragraph', content: 'More local writing' }], editor.document.at(-1)!, 'after');
  await new Promise(resolve => setTimeout(resolve, 3200));
  check(saveCount === savesAfterConflict, 'Stale saves are not blindly retried');
  let actionRan = false;
  try { await runNoteAction('history-note', true, () => { actionRan = true; }); } catch { /* Expected conflict prevents mutation. */ }
  check(!actionRan && JSON.stringify(editor.document).includes('Conflicting local draft'), 'Conflict retains draft and blocks destructive action');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'No page-level horizontal overflow');
  return ['unsaved rich pre-Athena recovery', 'failure blocks mutation', 'duplicate Apply blocked', 'read-only preview isolation',
    'history retry', 'restore failure and retry', 'organisation preserved', 'stale debounce suppressed', 'conflict retains draft and stops retry'];
}
Object.assign(window, { runNoteHistoryChecks });
