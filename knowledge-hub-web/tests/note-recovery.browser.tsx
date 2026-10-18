import React, { useState } from 'react';
import { PublicClientApplication } from '@azure/msal-browser';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoteEditor } from '../src/notes/NoteEditor';
import { NoteRecoveryCentre } from '../src/notes/NoteRecoveryCentre';
import { AppDialogHost } from '../src/components/AppDialog';
import { api } from '../src/services/api';
import { noteDraftIdentity, signOut } from '../src/services/auth';
import { fromApiNote } from '../src/notes/noteStorage';
import { captureNoteDraft, clearAllNoteDrafts, listNoteDrafts, storeNoteDraft } from '../src/notes/noteDraftStorage';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import type { Note } from '../src/types/contentItem';
import type { NoteVersion } from '../src/services/api';
import type { CanvasSummaryApi } from '../src/services/api';
import '../src/styles/global.scss';

const owner = 'fixture-recovery-owner';
PublicClientApplication.prototype.logoutRedirect = async () => undefined;
let currentOwner: string | null = owner;
noteDraftIdentity.get = () => currentOwner;
const noteId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const now = new Date().toISOString();
const localWriting = {
  title: 'Recovered rich writing', contentType: 'note' as const, contentJson: JSON.stringify([
    { type: 'heading', props: { level: 1 }, content: 'Recovered rich writing' },
    { type: 'paragraph', content: [{ type: 'text', text: 'Exact rich local body', styles: { bold: true, italic: true } },
      { type: 'link', href: 'https://example.invalid/local-source', content: [{ type: 'text', text: ' Source link', styles: {} }] }] },
    { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['Left', 'Right'] }, { cells: ['One', 'Two'] }] } },
  ]),
};
api.listDeletedCanvases = async () => ({ success: true, data: structuredClone(recycled) });
api.restoreCanvas = async id => {
  restoreCanvasCount++;
  const index = recycled.findIndex(canvas => canvas.id === id);
  if (index < 0) {
    const existing = restoredCanvases.get(id);
    if (!existing) throw new Error('Recycled canvas not found');
    return { success: true, data: { canvas: structuredClone(existing), restored: false } };
  }
  const [canvas] = recycled.splice(index, 1);
  const active = { ...canvas!, deletedAt: null };
  restoredCanvases.set(id, active);
  if (loseCanvasRestoreResponse) throw new Error('Canvas response lost after restore committed');
  return { success: true, data: { canvas: structuredClone(active), restored: true } };
};
api.permanentlyDeleteCanvas = async id => {
  const index = recycled.findIndex(canvas => canvas.id === id);
  if (index < 0) throw new Error('Recycled canvas not found');
  recycled.splice(index, 1);
};
const phase = sessionStorage.getItem('recovery-fixture-phase');
const reloading = phase === 'reload-pending';
let persisted: Note = reloading ? JSON.parse(sessionStorage.getItem('recovery-fixture-server')!) as Note : {
  id: noteId, content: JSON.stringify({ title: 'Newer saved writing', contentType: 'note', githubPath: 'keep.md',
    contentJson: JSON.stringify([{ type: 'heading', props: { level: 1 }, content: 'Newer saved writing' },
      { type: 'paragraph', content: 'Server-only writing to preserve' }]) }),
  createdAt: now, updatedAt: now, revision: 2, tags: ['keep-tag'], linkedItems: ['keep-link'], status: 'active', projectId: 'keep-project',
};
if (!reloading) {
  clearAllNoteDrafts(localStorage);
  storeNoteDraft(localStorage, captureNoteDraft(owner, draftId, { ...fromApiNote(persisted), ...localWriting, revision: 0 }));
  storeNoteDraft(localStorage, captureNoteDraft(owner, otherId, { ...fromApiNote(persisted), id: otherId, title: 'Other note must not enter this editor' }));
  storeNoteDraft(localStorage, captureNoteDraft('other-owner', otherId, { ...fromApiNote(persisted), title: 'Other owner private writing' }));
}
const versions: NoteVersion[] = [];
let failRecovery = true;
let loseRecoveryResponse = false;
let failPatch = reloading;
let holdPatch = false;
let releasePatch: (() => void) | null = null;
let patchCount = 0;
let recoveryCount = 0;
let failArchivePreview = true;
let loseArchiveResponse = true;
let archiveCount = 0;
const recycled: CanvasSummaryApi[] = [
  { id: '55555555-5555-4555-8555-555555555555', title: 'Agentic SDLC', description: null, canvasType: 'diagram',
    project: null, createdAt: now, updatedAt: now, deletedAt: now, linkedNotes: [], nodeCount: 15 },
  { id: '66666666-6666-4666-8666-666666666666', title: 'Old brainstorm', description: null, canvasType: 'brainstorm',
    project: null, createdAt: now, updatedAt: now, deletedAt: now, linkedNotes: [], nodeCount: 4 },
];
const restoredCanvases = new Map<string, CanvasSummaryApi>();
let loseCanvasRestoreResponse = true;
let restoreCanvasCount = 0;
const archived = Array.from({ length: 27 }, (_, index): Note => ({
  ...persisted, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: 'archived',
  content: JSON.stringify({ ...localWriting, title: `Archived ${index}`, githubPath: 'archived.md' }), revision: 7,
}));
function conflict(): Error { return Object.assign(new Error('Changed elsewhere; refresh the saved comparison'), { isAxiosError: true, response: { status: 409 } }); }
function save(content: string, expected: number | undefined): void {
  if (expected !== persisted.revision) throw conflict();
  if (persisted.content !== content) {
    persisted = { ...persisted, content, revision: (persisted.revision ?? 0) + 1, updatedAt: now };
    sessionStorage.setItem('recovery-fixture-server', JSON.stringify(persisted));
  }
}
api.getProjects = async () => ({ success: true, data: [] });
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
api.getNoteHistory = async () => ({ success: true, data: versions.map(({ writing: _writing, ...summary }) => summary) });
api.getNote = async (id, status = 'active') => {
  if (status === 'archived') {
    if (failArchivePreview) throw new Error('Archived preview unavailable');
    const found = archived.find(note => note.id === id && note.status === 'archived');
    if (!found) throw new Error('Archived note not found');
    return { success: true, data: found };
  }
  if (id !== noteId) throw new Error('Wrong note requested');
  return { success: true, data: persisted };
};
api.patchNote = async (id, content, _tags, _project, expected) => {
  if (id !== noteId) throw new Error('Wrong note save');
  patchCount++;
  if (holdPatch) await new Promise<void>(resolve => { releasePatch = resolve; });
  if (failPatch) throw new Error('Fixture offline; local writing retained');
  save(content, expected);
  return { success: true, data: persisted };
};
api.recoverNoteDraft = async (id, writing, expected) => {
  recoveryCount++;
  if (id !== noteId) throw new Error('Wrong recovery note');
  if (failRecovery) throw new Error('Recovery offline; local copy retained');
  if (expected !== persisted.revision) throw conflict();
  const previous = JSON.parse(persisted.content) as NoteVersion['writing'];
  const content = JSON.stringify({ ...previous, ...writing });
  if (content !== persisted.content) versions.push({ id: 'before-local', reason: 'before_restore', writing: previous,
    revision: persisted.revision ?? 0, writing_updated_at: now, created_at: now, restored_from: null });
  save(content, expected);
  if (loseRecoveryResponse) throw new Error('Response lost after recovery committed');
  return { success: true, data: persisted };
};
api.getNoteSummaries = async (page = 1, pageSize = 25, filters) => {
  if (filters?.status !== 'archived') throw new Error('Archive browsing must stay archive-scoped');
  const available = archived.filter(note => note.status === 'archived' && JSON.parse(note.content).title.includes(filters.q ?? ''));
  return { success: true, data: { items: available.slice((page - 1) * pageSize, page * pageSize).map(note => ({
    id: note.id, title: JSON.parse(note.content).title as string, contentType: 'note', preview: '', revision: note.revision ?? 0,
    createdAt: now, updatedAt: now, tags: note.tags, linkedItems: note.linkedItems, taxonomyTagIds: [],
  })), total: available.length, page, pageSize, hasMore: page * pageSize < available.length } };
};
api.restoreArchivedNote = async (id, expected) => {
  archiveCount++;
  const note = archived.find(item => item.id === id);
  if (!note) throw new Error('Wrong archive note');
  if (note.status === 'active') return { success: true, data: { note, restored: false } };
  if (note.revision !== expected) throw conflict();
  note.status = 'active'; note.revision++;
  if (loseArchiveResponse) throw new Error('Archive response lost after commit');
  return { success: true, data: { note, restored: true } };
};
let openCentre: () => void;
function Fixture(): React.ReactElement {
  const [doc, setDoc] = useState(fromApiNote(persisted));
  const [centre, setCentre] = useState(false);
  openCentre = () => setCentre(true);
  return <>
    <div className="page-header notes-header"><h1 className="page-title">Think</h1>
      <button className="kb-import-btn notes-recovery-launch" type="button" onClick={openCentre}>Recovery</button></div>
    <NoteEditor doc={doc} onSaved={setDoc} />
    {centre && <NoteRecoveryCentre onClose={() => setCentre(false)} onOpenNote={id => { if (id !== noteId) throw new Error('Source belongs to another note'); }} />}
    <AppDialogHost />
  </>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({
  defaultOptions: { queries: { retry: false } },
})}><MemoryRouter><Fixture /></MemoryRouter></QueryClientProvider>);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor(predicate: () => boolean, step = 'step'): Promise<void> {
  for (let index = 0; index < 350; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Recovery fixture timed out (${step}): ${document.body.innerText}`);
}
function click(text: string, scope: ParentNode = document): void {
  const control = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text);
  check(control && !control.disabled, `Enabled control required: ${text}`); control.click();
}
async function confirm(text: string): Promise<void> {
  await waitFor(() => [...document.querySelectorAll('dialog.kh-dialog[open]')].some(dialog => dialog.textContent?.includes(text)));
  const dialogs = document.querySelectorAll('dialog.kh-dialog[open]');
  click(text, dialogs[dialogs.length - 1]!);
}
function draftRegion(): HTMLElement { return document.querySelector<HTMLElement>('.note-recovery--comparison')!; }
function insert(text: string): void {
  const editor = getActiveBlockNoteEditor()!;
  editor.insertBlocks([{ type: 'paragraph', content: text }], editor.document.at(-1)!, 'after');
}
async function selectOriginalDraft(): Promise<void> {
  if (!draftRegion()) document.querySelector<HTMLButtonElement>('.note-recovery__draft-launch')!.click();
  await waitFor(() => draftRegion() !== null);
  const region = draftRegion();
  const entry = [...region.querySelectorAll<HTMLButtonElement>('.note-recovery__entries button')].find(item => item.textContent?.includes(localWriting.title));
  check(entry, 'Earlier rich local writing available'); entry.click();
  await waitFor(() => region.textContent?.includes('Current saved writing') === true);
}
async function restoreSelected(): Promise<void> {
  click('Restore local writing', draftRegion());
  await confirm('Restore reviewed writing');
}
async function runNoteRecoveryChecks(): Promise<string[]> {
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  if (!draftRegion()) document.querySelector<HTMLButtonElement>('.note-recovery__draft-launch')!.click();
  await waitFor(() => draftRegion() !== null);
  check(!draftRegion().textContent?.includes('Other note') && !draftRegion().textContent?.includes('Other owner'), 'Draft list is note/account isolated');
  const editor = getActiveBlockNoteEditor()!;
  insert('Live unsaved writing must survive replacement');
  await selectOriginalDraft();
  check(draftRegion().textContent?.includes('Conflict:') && document.querySelectorAll('.note-recovery__preview [contenteditable="true"]').length === 0, 'Saved-vs-local conflict shown with read-only previews');
  await restoreSelected();
  await waitFor(() => draftRegion().textContent?.includes('Recovery offline') === true);
  check(JSON.stringify(editor.document).includes('Live unsaved writing'), 'Failed restore leaves live editor intact');
  failRecovery = false; loseRecoveryResponse = true;
  await restoreSelected();
  await waitFor(() => draftRegion().textContent?.includes('Response lost') === true);
  check(listNoteDrafts(localStorage, owner).drafts.some(draft => draft.id === draftId), 'Lost acknowledgement retains reviewed local copy');
  loseRecoveryResponse = false;
  await restoreSelected();
  await waitFor(() => draftRegion().textContent?.includes('Changed elsewhere') === true);
  check(recoveryCount === 3 && JSON.stringify(editor.document).includes('Live unsaved writing'), 'Stale retry cannot overwrite server or live writing');
  click('Refresh saved comparison', draftRegion());
  await waitFor(() => draftRegion().textContent?.includes(`Current saved writing · revision ${persisted.revision}`) === true);
  await restoreSelected();
  await waitFor(() => JSON.stringify(editor.document).includes('Exact rich local body') && editor.isEditable);
  check(JSON.parse(persisted.content).contentJson === localWriting.contentJson, 'Recovered JSON is exact, including rich text, link and table');
  check(persisted.projectId === 'keep-project' && persisted.tags[0] === 'keep-tag' && persisted.linkedItems[0] === 'keep-link'
    && JSON.parse(persisted.content).githubPath === 'keep.md', 'Writing recovery preserves metadata');
  check(versions[0]?.writing.contentJson.includes('Server-only writing'), 'Previous saved writing retained before restore');
  check(listNoteDrafts(localStorage, owner).drafts.some(draft => draft.writing.contentJson.includes('Live unsaved writing')), 'Replaced unsaved writing retained under a separate local writer ID');
  click('Close local recovery');
  const priorSaves = patchCount;
  await new Promise(resolve => setTimeout(resolve, 3200));
  check(patchCount === priorSaves, 'Old autosave cannot replace accepted recovery');
  holdPatch = true;
  insert('First save request');
  await waitFor(() => releasePatch !== null);
  insert('Newer typing during request');
  holdPatch = false; releasePatch!(); releasePatch = null;
  await waitFor(() => listNoteDrafts(localStorage, owner).drafts.some(draft => draft.baseRevision === persisted.revision && draft.writing.contentJson.includes('Newer typing during request')));
  check(listNoteDrafts(localStorage, owner).drafts.some(draft => draft.writing.contentJson.includes('Newer typing during request')), 'Late save acknowledgement cannot remove newer typing');
  failPatch = true;
  insert('Reload this exact rich unsaved writing');
  await waitFor(() => document.querySelector('.notes-notification')?.textContent?.includes('Fixture offline') === true
    || document.body.textContent?.includes('Save failed - draft retained: Fixture offline') === true);
  sessionStorage.setItem('recovery-fixture-server', JSON.stringify(persisted));
  sessionStorage.setItem('recovery-fixture-phase', 'reload-pending');
  return ['identity/note isolation', 'read-only rich comparison', 'explicit server conflict', 'failed/lost restore response retains writing',
    'stale retry refused', 'live editor replacement', 'exact rich JSON', 'metadata and history preserved', 'unsaved replacement retained separately',
    'stale autosave blocked', 'newer typing survives late acknowledgement', 'canvas recycle restore and permanent-delete safeguards',
    'failed save prepared for real page reload'];
}
async function runNoteRecoveryReloadChecks(): Promise<string[]> {
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  const editor = getActiveBlockNoteEditor()!;
  check(!JSON.stringify(editor.document).includes('Reload this exact'), 'Reload starts from saved server writing; never auto-restores');
  const copies = listNoteDrafts(localStorage, owner).drafts;
  const restoredCopy = copies.find(draft => draft.writing.contentJson.includes('Reload this exact'));
  check(restoredCopy, 'Real page reload retains exact rich failed-save copy');
  document.querySelector<HTMLButtonElement>('.note-recovery__draft-launch')!.click();
  await waitFor(() => draftRegion() !== null);
  const region = draftRegion();
  const entry = [...region.querySelectorAll<HTMLButtonElement>('.note-recovery__entries button')]
    .find(button => button.textContent?.includes(new Date(restoredCopy.updatedAt).toLocaleString('en-GB')));
  check(entry, 'Reloaded local copy can be reviewed');
  entry.click();
  await waitFor(() => region.querySelector('.note-recovery__preview') !== null);
  check(region.querySelector('textarea')?.value.includes('Reload this exact'), 'Exact JSON is manually copyable without clipboard permission');
  click('Close local recovery');
  const quota = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value): void {
    if (key.startsWith('kh-note-draft-v1:')) throw new DOMException('Fixture quota', 'QuotaExceededError');
    quota.call(this, key, value);
  };
  insert('Quota failure cannot erase open writing');
  await waitFor(() => document.body.textContent?.includes('Local recovery copy unavailable') === true, 'quota notice');
  Storage.prototype.setItem = quota;
  check(JSON.stringify(editor.document).includes('Quota failure'), 'Quota error leaves live writing in place');
  const launcher = document.querySelector<HTMLButtonElement>('.notes-recovery-launch')!;
  launcher.focus(); launcher.click();
  await waitFor(() => document.querySelector('dialog.kh-dialog[open]')?.textContent?.includes('25 of 27') === true, 'recovery centre 25 of 27');
  const centre = document.querySelector<HTMLDialogElement>('dialog.kh-dialog[open]')!;
  check(getActiveBlockNoteEditor() === editor && centre.contains(document.activeElement), 'Recovery opens modally without unmounting editor');
  await waitFor(() => centre.textContent?.includes('Agentic SDLC') === true);
  const agentic = [...centre.querySelectorAll<HTMLElement>('.note-recovery__canvas-entry')]
    .find(entry => entry.textContent?.includes('Agentic SDLC'))!;
  check(agentic.textContent?.includes('Diagram · 15 items') === true, 'Recycle bin shows canvas type, item count and deletion time');
  click('Restore', agentic); await confirm('Restore canvas');
  await waitFor(() => centre.textContent?.includes('Canvas response lost after restore committed') === true);
  loseCanvasRestoreResponse = false;
  click('Restore', agentic); await confirm('Restore canvas');
  await waitFor(() => centre.textContent?.includes('already restored') === true);
  check(restoreCanvasCount === 2 && restoredCanvases.has('55555555-5555-4555-8555-555555555555'),
    'Lost restore acknowledgement retries as a truthful no-op');
  const old = [...centre.querySelectorAll<HTMLElement>('.note-recovery__canvas-entry')]
    .find(entry => entry.textContent?.includes('Old brainstorm'))!;
  click('Delete permanently', old); await confirm('Delete permanently');
  await waitFor(() => centre.textContent?.includes('permanently deleted') === true);
  check(recycled.length === 0 && ![...centre.querySelectorAll('.note-recovery__canvas-entry')]
    .some(entry => entry.textContent?.includes('Old brainstorm')), 'Permanent deletion requires confirmation and removes only recycled data');
  click('Load more archived notes', centre);
  await waitFor(() => centre.textContent?.includes('27 of 27') === true);
  const first = centre.querySelector<HTMLButtonElement>('.note-recovery__entries button')!;
  first.click();
  await waitFor(() => centre.textContent?.includes('Archived preview unavailable') === true);
  failArchivePreview = false;
  const retry = [...centre.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Retry'));
  check(retry, 'Archive preview has retry'); retry.click();
  await waitFor(() => centre.querySelector('.note-recovery__preview') !== null);
  click('Restore archived note', centre); await confirm('Restore note');
  await waitFor(() => centre.textContent?.includes('Archive response lost') === true);
  loseArchiveResponse = false;
  click('Restore archived note', centre); await confirm('Restore note');
  await waitFor(() => centre.textContent?.includes('already active') === true);
  check(archiveCount === 2 && archived[0]!.revision === 8 && archived[0]!.projectId === 'keep-project'
    && JSON.parse(archived[0]!.content).githubPath === 'archived.md', 'Archive response-loss retry is a truthful no-op preserving metadata');
  check(getActiveBlockNoteEditor() === editor, 'Archive mutation never replaces open writing');
  click('Close recovery', centre);
  await waitFor(() => document.querySelector('dialog.kh-dialog[open]') === null);
  check(document.activeElement === launcher, 'Recovery close returns focus');
  const unsupportedId = '44444444-4444-4444-8444-444444444444';
  const unsupported = captureNoteDraft(owner, unsupportedId, { ...fromApiNote(persisted), title: 'Unsupported local blocks',
    contentJson: JSON.stringify([{ type: 'future-recovery-fixture', content: 'Must not be converted away' }]) });
  storeNoteDraft(localStorage, unsupported);
  document.querySelector<HTMLButtonElement>('.note-recovery__draft-launch')!.click();
  await waitFor(() => draftRegion() !== null);
  click('Refresh local copies', draftRegion());
  await waitFor(() => draftRegion().textContent?.includes('Unsupported local blocks') === true);
  const unsupportedEntry = [...draftRegion().querySelectorAll<HTMLButtonElement>('.note-recovery__entries button')]
    .find(button => button.textContent?.includes('Unsupported local blocks'))!;
  unsupportedEntry.click();
  await waitFor(() => draftRegion().textContent?.includes('unsupported block type') === true);
  const restoreControl = [...draftRegion().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Restore local writing')!;
  check(restoreControl.disabled && draftRegion().querySelector('textarea')?.value.includes('future-recovery-fixture'), 'Unsupported blocks disable restore without erasing exact JSON');
  unsupportedEntry.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  check(restoreControl.disabled, 'Reselecting a failed preview cannot enable an unsafe restore');
  click('Discard local copy', draftRegion());
  await waitFor(() => document.querySelectorAll('dialog.kh-dialog[open]').length === 2);
  storeNoteDraft(localStorage, { ...unsupported, updatedAt: new Date().toISOString(), writing: { ...unsupported.writing, title: 'Newer local copy must survive discard' } });
  await confirm('Discard copy');
  await waitFor(() => draftRegion().textContent?.includes('Local copy changed while you reviewed') === true);
  check(listNoteDrafts(localStorage, owner).drafts.some(draft => draft.id === unsupportedId), 'Stale discard cannot remove changed writing');
  click('Close local recovery');
  currentOwner = 'different-owner';
  window.dispatchEvent(new Event('kh-note-draft-identity'));
  await waitFor(() => document.body.textContent?.includes('Local recovery is paused until the original account returns') === true);
  check(document.querySelector('.note-recovery--comparison textarea') === null, 'Different account cannot receive prior local preview');
  currentOwner = owner;
  window.dispatchEvent(new Event('kh-note-draft-identity'));
  await waitFor(() => document.querySelector('.note-recovery__draft-launch') !== null);
  failPatch = false; holdPatch = true;
  insert('Sign-out must prevent a pending save from recreating drafts');
  await waitFor(() => releasePatch !== null);
  const capturedEpoch = noteDraftIdentity.epoch();
  localStorage.setItem('keep-preference', 'unchanged');
  await signOut();
  check(noteDraftIdentity.epoch() !== capturedEpoch && listNoteDrafts(localStorage, owner).drafts.length === 0
    && listNoteDrafts(localStorage, 'other-owner').drafts.length === 0, 'Sign-out invalidates all mounted recovery sessions and removes sensitive copies');
  holdPatch = false; releasePatch!();
  await new Promise(resolve => setTimeout(resolve, 50));
  insert('Typing after sign-out');
  window.dispatchEvent(new Event('pagehide'));
  check(listNoteDrafts(localStorage, owner).drafts.length === 0 && localStorage.getItem('keep-preference') === 'unchanged', 'Late acknowledgement, change and pagehide cannot recreate cleared copies or erase preferences');
  sessionStorage.setItem('recovery-fixture-phase', 'finished');
  check(document.documentElement.scrollWidth <= innerWidth, 'No horizontal overflow');
  return ['real page reload recovers rich draft', 'manual exact JSON fallback', 'visible quota failure', 'mounted-editor modal recovery',
    '27 archived notes paginated', 'preview retry', 'archive restore lost-response retry is idempotent', 'archive metadata preserved',
    'focus restored', 'unsupported rich blocks disable restore and retain exact JSON', 'reselect cannot bypass failed preview', 'stale discard preserves newer writing',
    'account switch hides prior draft', 'sign-out clears only draft records', 'late acknowledgements cannot recreate signed-out writing'];
}
async function prepareNoteRecoveryComparison(): Promise<void> {
  await waitFor(() => getActiveBlockNoteEditor() !== null);
  await selectOriginalDraft();
}
async function prepareNoteRecoveryCentre(): Promise<void> {
  failArchivePreview = false;
  openCentre();
  await waitFor(() => document.querySelector('dialog.kh-dialog[open] .note-recovery__entries button') !== null);
  document.querySelector<HTMLButtonElement>('dialog.kh-dialog[open] .note-recovery__entries button')!.click();
  await waitFor(() => document.querySelector('dialog.kh-dialog[open] .note-recovery__preview') !== null);
  document.querySelector('dialog.kh-dialog[open] .note-recovery__preview')!.scrollIntoView({ block: 'nearest' });
}
Object.assign(window, { runNoteRecoveryChecks, runNoteRecoveryReloadChecks, prepareNoteRecoveryComparison, prepareNoteRecoveryCentre });
