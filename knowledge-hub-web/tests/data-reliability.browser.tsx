import type { QueryClient } from '@tanstack/react-query';
import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { AIChatPage } from '../src/pages/AIChatPage';
import { useAthenaContext } from '../src/context/AthenaContext';
import { api } from '../src/services/api';
import type { ApiResponse } from '../src/types/apiResponse';
import type { NoteSummary, AthenaMemory } from '../src/types';
import type { PlanTask } from '../src/types/task';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const failure = <T,>(): ApiResponse<T> => ({ success: false, error: { code: 'FIXTURE', message: 'Fixture service unavailable' } });
export function SummaryFixture(): React.ReactElement {
  const { noteId } = useParams();
  const { pageContext, setAthenaContext } = useAthenaContext();
  useEffect(() => {
    setAthenaContext({ type: 'note', id: noteId ?? 'A', title: `Race note ${noteId ?? 'A'}`, detail: 'Fixture writing' });
    return () => { setAthenaContext(null); };
  }, [noteId, setAthenaContext]);
  return <div className="think-athena-panel"><AIChatPage compact compactVariant="narrow" pageContext={pageContext ?? undefined} /></div>;
}
const check = (value: boolean, message: string): void => { if (!value) throw new Error(message); };
async function waitFor(condition: () => boolean, step = 'render'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Data reliability fixture timed out (${step}): ${document.querySelector('#navigation-probe')?.getAttribute('data-path')}; context: ${document.querySelector('#navigation-probe')?.getAttribute('data-context')}; summary: ${document.querySelector('.ai-note-summary-card')?.textContent ?? 'none'}; notice: ${document.querySelector('[role="alert"]')?.textContent ?? 'none'}; text: ${document.body.textContent?.slice(-300)}`);
}
function element<T extends HTMLElement>(query: string): T {
  const match = document.querySelector<T>(query);
  if (!match) throw new Error(`Missing data fixture element: ${query}`);
  return match;
}
function input(query: string, value: string): void {
  const field = element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(query);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')];
  const label = (item: HTMLButtonElement): string => {
    const copy = item.cloneNode(true) as HTMLButtonElement;
    copy.querySelectorAll('svg, .cds--visually-hidden, .cds--assistive-text, [aria-hidden="true"]').forEach(icon => icon.remove());
    return copy.textContent?.trim() ?? '';
  };
  const match = buttons.find(item => label(item) === text);
  if (!match) throw new Error(`Missing data fixture button: ${text}; available: ${buttons.map(label).join(', ')}`);
  return match;
}

export async function runDataReliabilityChecks(queryClient: QueryClient, go: (path: string) => Promise<void>): Promise<string[]> {
  const results: string[] = [];
  const projectResponse = await api.getProjects();
  if (!projectResponse.success) throw new Error('Project fixtures are unavailable');
  let projects = projectResponse.data;
  let projectFailure = true;
  api.getProjects = async () => projectFailure ? failure() : success(projects);
  await queryClient.invalidateQueries({ queryKey: ['projects'] });
  await go('/projects');
  await waitFor(() => document.querySelector('.kh-data-notice') !== null);
  check(document.querySelectorAll('.proj-card').length === projects.length, 'Project read failure retains real cached records');
  check(document.querySelector('.proj-empty') === null, 'Unavailable projects must not claim to be empty');
  projectFailure = false;
  button('Retry', element('.kh-data-notice')).click();
  await waitFor(() => document.querySelector('.kh-data-notice') === null);
  let projectSaves = 0;
  let projectSaveFailure = true;
  api.updateProject = async (id, request) => {
    projectSaves++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (projectSaveFailure) return failure();
    const current = projects.find(project => project.id === id)!;
    const updated = { ...current, ...request };
    projects = projects.map(project => project.id === id ? updated : project);
    return success(updated);
  };
  element<HTMLButtonElement>('.proj-icon-btn[title="Edit"]').click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible #pm-name') !== null);
  input('#pm-name', 'Retained project edit');
  await waitFor(() => element<HTMLInputElement>('#pm-name').value === 'Retained project edit');
  const projectModal = element('.cds--modal.is-visible');
  const projectSaveButton = button('Save', projectModal);
  projectSaveButton.click();
  projectSaveButton.click();
  await waitFor(() => element<HTMLInputElement>('#pm-name').matches(':disabled'));
  await waitFor(() => projectModal.textContent?.includes('Fixture service unavailable') === true);
  check(projectSaves === 1 && element<HTMLInputElement>('#pm-name').value === 'Retained project edit',
    'Failed project save retains exact input and rejects duplicate submissions');
  projectSaveFailure = false;
  button('Save', projectModal).click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible') === null);
  let deleteCalls = 0;
  let deleteFailure = true;
  api.deleteProject = async (id) => {
    deleteCalls++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (deleteFailure) return failure();
    projects = projects.filter(project => project.id !== id);
    return success({ deleted: true });
  };
  element<HTMLButtonElement>('.proj-icon-btn--danger').click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible') !== null);
  const modal = element('.cds--modal.is-visible');
  const deleteButton = button('Delete', modal);
  deleteButton.click();
  deleteButton.click();
  await waitFor(() => modal.textContent?.includes('Project was not deleted') === true);
  check(deleteCalls === 1, 'Duplicate project confirmation cannot submit twice');
  check(document.querySelector('.cds--modal.is-visible') === modal, 'Failed delete retains the confirmation');
  deleteFailure = false;
  button('Delete', modal).click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible') === null && document.querySelectorAll('.proj-card').length === projects.length);
  check(deleteCalls === 2, 'Retry performs exactly one new delete');
  results.push('Projects retain cached records on read failure, retry visibly and prevent duplicate deletes');

  let memoryFailure = true;
  const memory: AthenaMemory = { id: 'legacy-memory', kind: 'instruction', content: 'Retained legacy instruction',
    scopeType: 'project', scopeValue: 'deleted-project', status: 'active', origin: 'manual',
    sourceExcerpt: null, lastAppliedAt: null, createdAt: '', updatedAt: '' };
  api.listMemories = async () => memoryFailure ? failure() : success({ memories: [memory] });
  await queryClient.invalidateQueries({ queryKey: ['memories'] });
  await go('/memory');
  await waitFor(() => document.body.textContent?.includes('Memory is unavailable') === true);
  check(document.querySelector('.memory-empty') === null, 'Unavailable memory must not claim to be empty');
  memoryFailure = false;
  button('Retry', element('.memory-notice')).click();
  await waitFor(() => document.querySelector('.memory-item') !== null);
  button('Edit', element('.memory-item')).click();
  await waitFor(() => document.querySelector('.memory-project-picker input') !== null);
  check(element<HTMLInputElement>('.memory-project-picker input').value.includes('deleted-project'), 'Legacy project scope stays readable and selected');
  check(queryClient.getQueryData<unknown[]>(['projects'])?.length === projects.length, 'Both project hook interfaces share the successful delete');
  button('Cancel', element('.memory-item')).click();
  button('Add instruction').click();
  await waitFor(() => document.querySelector('textarea[aria-label="New instruction"]') !== null);
  input('textarea[aria-label="New instruction"]', 'Keep this failed instruction draft');
  input('select[aria-label="Applies to"]', 'project');
  await waitFor(() => document.querySelector('.memory-add .memory-project-picker input') !== null);
  const picker = element<HTMLInputElement>('.memory-add .memory-project-picker input');
  input('.memory-add .memory-project-picker input', projects[0]!.name);
  picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await waitFor(() => document.querySelector('.memory-add [role="option"]') !== null);
  element<HTMLElement>('.memory-add [role="option"]').click();
  await waitFor(() => !button('Save', element('.memory-add')).disabled);
  let creates = 0;
  let createFailure = true;
  api.createMemory = async (request) => {
    creates++;
    check(request.scopeValue === projects[0]?.id, 'Picker sends project identity, not label');
    await new Promise(resolve => setTimeout(resolve, 100));
    return createFailure ? failure() : success({ ...memory, id: 'new-memory', content: request.content });
  };
  button('Save', element('.memory-add')).click();
  await waitFor(() => element<HTMLTextAreaElement>('textarea[aria-label="New instruction"]').disabled);
  check(element<HTMLInputElement>('.memory-add .memory-project-picker input').disabled, 'Pending memory scope cannot change');
  await waitFor(() => document.body.textContent?.includes('Change was not saved') === true);
  check(element<HTMLTextAreaElement>('textarea[aria-label="New instruction"]').value === 'Keep this failed instruction draft', 'Failed memory create retains exact input');
  createFailure = false;
  button('Save', element('.memory-add')).click();
  await waitFor(() => document.querySelector('.memory-add') === null);
  check(creates === 2, 'Memory retry submits once');
  check(element('.memory-page').scrollWidth <= window.innerWidth + 1, 'Memory picker fits the responsive page');
  let memories: AthenaMemory[] = [memory,
    { ...memory, id: 'approve-memory', content: 'Approve fixture', status: 'suggested' },
    { ...memory, id: 'dismiss-memory', content: 'Dismiss fixture', status: 'suggested' },
    { ...memory, id: 'example-memory', content: 'Example fixture', kind: 'example' },
    { ...memory, id: 'profile-memory', content: 'Profile fixture', kind: 'profile', scopeType: 'global', scopeValue: null },
  ];
  api.listMemories = async () => success({ memories });
  await queryClient.invalidateQueries({ queryKey: ['memories'] });
  await waitFor(() => document.querySelector('textarea[aria-label="Profile"]') !== null);
  let memoryChanges = 0;
  let memoryChangeFailure = true;
  api.updateMemory = async (id, patch) => {
    memoryChanges++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (memoryChangeFailure) return failure();
    const updated = { ...memories.find(item => item.id === id)!, ...patch };
    memories = memories.map(item => item.id === id ? updated : item);
    return success(updated);
  };
  for (const [label, content, status] of [
    ['Approve', 'Approve fixture', 'active'],
    ['Dismiss', 'Dismiss fixture', 'dismissed'],
    ['Pause', memory.content, 'paused'],
    ['Resume', memory.content, 'active'],
  ] as const) {
    const row = [...document.querySelectorAll('.memory-item')].find(item => item.textContent?.includes(content))!;
    const before = memoryChanges;
    memoryChangeFailure = true;
    const action = button(label, row);
    action.click();
    action.click();
    await waitFor(() => action.disabled);
    await waitFor(() => !action.disabled && document.body.textContent?.includes('Change was not saved') === true);
    check(memoryChanges === before + 1 && row.isConnected, `${label} failure retains the record and rejects duplicates`);
    memoryChangeFailure = false;
    action.click();
    await waitFor(() => document.body.textContent?.includes('Change was not saved') !== true
      && queryClient.getQueryData<AthenaMemory[]>(['memories'])?.some(item => item.content === content && item.status === status) === true);
  }
  input('textarea[aria-label="Profile"]', 'Exact failed profile draft');
  await new Promise(resolve => setTimeout(resolve, 50));
  memoryChangeFailure = true;
  button('Save profile').click();
  await waitFor(() => element<HTMLTextAreaElement>('textarea[aria-label="Profile"]').disabled);
  await waitFor(() => !element<HTMLTextAreaElement>('textarea[aria-label="Profile"]').disabled);
  check(element<HTMLTextAreaElement>('textarea[aria-label="Profile"]').value === 'Exact failed profile draft',
    'Failed profile save retains the exact draft');
  memoryChangeFailure = false;
  button('Save profile').click();
  await waitFor(() => queryClient.getQueryData<AthenaMemory[]>(['memories'])?.some(item => item.content === 'Exact failed profile draft') === true);
  const instruction = [...document.querySelectorAll('.memory-item')].find(item => item.textContent?.includes(memory.content))!;
  button('Edit', instruction).click();
  await waitFor(() => document.querySelector('textarea[aria-label="Instruction"]') !== null);
  input('textarea[aria-label="Instruction"]', 'Exact failed instruction edit');
  await new Promise(resolve => setTimeout(resolve, 50));
  memoryChangeFailure = true;
  button('Save', instruction).click();
  await waitFor(() => element<HTMLTextAreaElement>('textarea[aria-label="Instruction"]').disabled);
  await waitFor(() => !element<HTMLTextAreaElement>('textarea[aria-label="Instruction"]').disabled);
  check(element<HTMLTextAreaElement>('textarea[aria-label="Instruction"]').value === 'Exact failed instruction edit',
    'Failed instruction edit retains its text');
  memoryChangeFailure = false;
  button('Save', instruction).click();
  await waitFor(() => document.querySelector('textarea[aria-label="Instruction"]') === null);
  api.deleteMemory = async (id) => {
    memoryChanges++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (memoryChangeFailure) return failure();
    memories = memories.filter(item => item.id !== id);
    return success({ deleted: true });
  };
  memoryChangeFailure = true;
  const remove = button('Remove');
  remove.click();
  remove.click();
  await waitFor(() => remove.disabled);
  await waitFor(() => !remove.disabled && document.body.textContent?.includes('Change was not saved') === true);
  memoryChangeFailure = false;
  remove.click();
  await waitFor(() => !remove.isConnected && document.body.textContent?.includes('Change was not saved') !== true);
  results.push('Memory errors distinguish unavailable data, preserve drafts and legacy scopes, and share the live project picker/cache');

  const libraryRead = api.getDocumentLibrary;
  api.getDocumentLibrary = async () => failure();
  await queryClient.invalidateQueries({ queryKey: ['documents-library'] });
  await go('/library');
  await waitFor(() => document.body.textContent?.includes('Sources are unavailable') === true);
  check(document.body.textContent?.includes('No documents found') !== true, 'Unavailable library does not claim to be empty');
  api.getDocumentLibrary = libraryRead;
  button('Retry', element('.kh-data-notice')).click();
  await waitFor(() => document.querySelector('.kh-data-notice') === null && document.querySelector('.docs-list-item') !== null);
  const contentRead = api.getDocumentContent;
  queryClient.removeQueries({ queryKey: ['document-content'] });
  api.getDocumentContent = async () => failure();
  element<HTMLButtonElement>('.docs-list-item').click();
  await waitFor(() => document.body.textContent?.includes('Document content is unavailable') === true);
  check(element('#navigation-probe').getAttribute('data-context') === '', 'Unavailable document text cannot ground Athena using metadata alone');
  api.getDocumentContent = contentRead;
  button('Retry', element('.kh-data-notice')).click();
  await waitFor(() => element('#navigation-probe').getAttribute('data-context')?.includes('Fixture source text') === true);
  const libraryTag = { id: '00000000-0000-4000-8000-000000000001', name: 'Reliability fixture tag', slug: 'fixture-tag',
    parentId: null, colour: null, role: 'filing' as const, usageCount: 0 };
  api.getTaxonomy = async () => success([libraryTag]);
  await queryClient.invalidateQueries({ queryKey: ['taxonomy'] });
  button('Details').click();
  await waitFor(() => document.querySelector('.docs-info-panel .notes-tag-picker-trigger') !== null);
  element<HTMLButtonElement>('.docs-info-panel .notes-tag-picker-trigger').click();
  await waitFor(() => document.querySelector('.tag-picker-item') !== null);
  let tagWrites = 0;
  let tagFailure = true;
  api.setDocumentTags = async (_id, ids) => {
    tagWrites++;
    await new Promise(resolve => setTimeout(resolve, 100));
    return tagFailure ? failure() : success(ids);
  };
  const tagButton = element<HTMLButtonElement>('.tag-picker-item');
  tagButton.click();
  tagButton.click();
  await waitFor(() => tagButton.disabled);
  await waitFor(() => document.body.textContent?.includes('were not saved') === true && !tagButton.disabled);
  check(tagWrites === 1 && !tagButton.classList.contains('tag-picker-item--selected'),
    'Library tag failure rolls back the selection and prevents repeated writes');
  tagFailure = false;
  tagButton.click();
  await waitFor(() => tagButton.classList.contains('tag-picker-item--selected') && !tagButton.disabled);
  check(tagWrites === 2, 'Library tag retry writes once');
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await waitFor(() => document.querySelector('.tag-picker-dropdown') === null);
  results.push('Library read/content failures are visible and retryable; unavailable writing cannot fabricate Athena context');

  const task: PlanTask = {
    id: 'reliable-task', title: 'Reliable task', body: 'Original body', status: 'backlog', projectId: projects[0]!.id,
    tags: [], priority: 'normal', task_type: 'standard', dueDate: null, startDate: null, endDate: null,
    externalUrl: null, linkedTagId: null, taxonomyTagIds: [], recurringCadence: null,
    archived: false, createdAt: '', updatedAt: '',
  };
  let tasks = [task];
  let taskFailure = false;
  api.getTasks = async (params) => taskFailure ? failure() : success({
    items: tasks.filter(item => !params?.projectId || item.projectId === params.projectId),
    total: tasks.length, page: 1, pageSize: 100, hasMore: false,
  });
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
  await go('/plan');
  await waitFor(() => document.querySelector('.kb-card') !== null);
  taskFailure = true;
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
  await waitFor(() => document.body.textContent?.includes('Tasks are unavailable') === true);
  check(document.querySelector('.kb-card') !== null, 'Tasks retain cached work through read failures');
  taskFailure = false;
  button('Retry', element('.kh-data-notice')).click();
  await waitFor(() => document.querySelector('.kh-data-notice') === null);
  let taskSaves = 0;
  let taskSaveFailure = true;
  api.updateTask = async (id, request) => {
    taskSaves++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (taskSaveFailure) return failure();
    const updated = { ...tasks.find(item => item.id === id)!, ...request };
    tasks = tasks.map(item => item.id === id ? updated : item);
    return success(updated);
  };
  element<HTMLElement>('.kb-card').click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible #t-title') !== null, 'task edit opened');
  await new Promise(resolve => setTimeout(resolve, 50));
  input('#t-title', 'Retained task edit');
  input('#t-body', 'Exact unsaved task writing');
  await new Promise(resolve => setTimeout(resolve, 50));
  const taskModal = element('.cds--modal.is-visible');
  button('Save', taskModal).click();
  button('Save', taskModal).click();
  await waitFor(() => element<HTMLInputElement>('#t-title').matches(':disabled'), 'task fields locked');
  await waitFor(() => taskModal.textContent?.includes('Save failed') === true, 'task save failed visibly');
  check(taskSaves === 1 && element<HTMLTextAreaElement>('#t-body').value === 'Exact unsaved task writing',
    'Task failure retains its form and blocks repeated submissions');
  taskSaveFailure = false;
  button('Save', taskModal).click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible') === null
    && document.querySelector('.kb-card__title')?.textContent === 'Retained task edit', 'task retry saved retained title');
  taskSaveFailure = true;
  let releaseMove = (): void => undefined;
  const delayedMove = new Promise<void>(resolve => { releaseMove = resolve; });
  api.updateTask = async () => { taskSaves++; await delayedMove; return failure(); };
  element<HTMLButtonElement>('.kb-menu-trigger').click();
  await waitFor(() => document.querySelector('.kb-menu') !== null);
  button('Completed', element('.kb-menu')).click();
  await waitFor(() => document.querySelector('.kb-card[aria-busy="true"]') !== null, 'completion locked');
  check(element<HTMLButtonElement>('.kb-menu-trigger').disabled, 'Pending completion cannot be moved or deleted again');
  input('#plan-filter-project', projects[1]!.id);
  await waitFor(() => document.querySelectorAll('.kb-card').length === 0, 'changed project scope');
  releaseMove();
  await waitFor(() => document.body.textContent?.includes('Task change was not saved') === true, 'completion failure');
  check(document.querySelectorAll('.kb-card').length === 0, 'Failed old-scope completion cannot overwrite the new filter cache');
  input('#plan-filter-project', '');
  await waitFor(() => document.querySelector('.kb-col .kb-card') !== null
    && !element<HTMLButtonElement>('.kb-menu-trigger').disabled, 'returned original task');
  check(queryClient.getQueryData<{ data: { items: PlanTask[] } }>(['tasks', ''])?.data.items[0]?.status === 'backlog',
    'Failed completion rolls back only the original task and scope');
  let taskDeletes = 0;
  let taskDeleteFailure = true;
  api.deleteTask = async (id) => {
    taskDeletes++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (taskDeleteFailure) return failure();
    tasks = tasks.filter(item => item.id !== id);
    return success(undefined);
  };
  element<HTMLButtonElement>('.kb-menu-trigger').click();
  await waitFor(() => document.querySelector('.kb-menu') !== null);
  button('Delete', element('.kb-menu')).click();
  await waitFor(() => document.querySelector('.kb-card[aria-busy="true"]') !== null);
  check(element<HTMLButtonElement>('.kb-menu-trigger').disabled, 'Pending delete locks the task actions');
  await waitFor(() => document.body.textContent?.includes('Task change was not saved') === true
    && !element<HTMLButtonElement>('.kb-menu-trigger').disabled, 'delete failure settled');
  check(document.querySelector('.kb-card') !== null && taskDeletes === 1, 'Failed delete retains the task');
  taskDeleteFailure = false;
  element<HTMLButtonElement>('.kb-menu-trigger').click();
  await waitFor(() => document.querySelector('.kb-menu') !== null);
  button('Delete', element('.kb-menu')).click();
  await waitFor(() => document.querySelector('.kb-card') === null && document.querySelector('.kh-data-notice') === null);
  results.push('Task read/save/delete failures retain work; pending actions lock, and failed completion rolls back its original scope only');

  const now = '2026-10-05T10:00:00Z';
  const notes: NoteSummary[] = Array.from({ length: 105 }, (_, i) => ({
    id: `data-note-${i}`, title: `Data note ${String(i).padStart(3, '0')}`, contentType: i === 104 ? 'blog' : 'note',
    preview: i === 104 ? 'Hidden searchable writing' : 'Body', createdAt: now, updatedAt: now,
    projectId: projects[0]!.id, taxonomyTagIds: i === 104 ? [libraryTag.id] : [],
  }));
  let noteFailure = false;
  let bodies = 0;
  api.getNoteSummaries = async (page = 1, pageSize = 100, filters = {}) => {
    if (noteFailure) return failure();
    const filtered = notes.filter(note => (filters.q === undefined || `${note.title} ${note.preview}`.toLowerCase().includes(filters.q.toLowerCase()))
      && (filters.contentType === undefined || note.contentType === filters.contentType)
      && (filters.projectId === undefined || note.projectId === filters.projectId)
      && (filters.tagIds === undefined || note.taxonomyTagIds?.some(id => filters.tagIds!.split(',').includes(id))));
    return success({ items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length,
      page, pageSize, hasMore: page * pageSize < filtered.length });
  };
  api.getNote = async (id) => {
    bodies++;
    const note = notes.find(item => item.id === id);
    if (!note) return failure();
    return success({ id, content: JSON.stringify({ title: note.title, contentType: note.contentType,
      contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: `Writing for ${id}`, styles: {} }] }]) }),
      createdAt: now, updatedAt: now, tags: [], linkedItems: [], status: 'active', revision: 1, projectId: note.projectId });
  };
  api.getNoteTags = async () => success([]);
  api.getNoteGitHub = async () => success(null);
  api.getNoteHistory = async () => success([]);
  await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
  {
    await go('/think');
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 100 && getActiveBlockNoteEditor() !== null);
    check(bodies === 1, 'Summary loading must not eagerly fetch 100 full bodies');
    element<HTMLButtonElement>('.notes-list-more').click();
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 105);
    check(document.querySelector('.notes-list-more') === null, 'Last page has no misleading load-more action');
    const editor = getActiveBlockNoteEditor();
    const search = element<HTMLInputElement>('#notes-search');
    input('#notes-search', 'Hidden searchable');
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 1);
    check(element('.notes-list-item-title').textContent === notes[104]?.title, 'Search finds writing beyond the first 100 summaries');
    check(element('#notes-search') === search && search.value === 'Hidden searchable', 'Server search retains the mounted search field');
    check(getActiveBlockNoteEditor() === editor, 'Filtering cannot unmount or replace the open editor');
    noteFailure = true;
    input('#notes-search', 'unavailable search');
    await waitFor(() => document.body.textContent?.includes('Note list is unavailable') === true);
    check(document.querySelector('.notes-list-empty') === null, 'A failed query cannot claim no documents');
    check(getActiveBlockNoteEditor() === editor && search.value === 'unavailable search', 'Failure retains editor identity and filter input');
    noteFailure = false;
    button('Retry', element('.kh-data-notice')).click();
    await waitFor(() => document.querySelector('.kh-data-notice') === null);
    input('#notes-search', '');
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 105);
    check(getActiveBlockNoteEditor() === editor, 'Retry preserves the open editor');
    element<HTMLButtonElement>('.notes-list-filters__toggle').click();
    await waitFor(() => !element('.notes-list-filters__fields').hidden);
    input('.notes-list-filters__fields .notes-list-filter:nth-child(2) select', 'blog');
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 1
      && document.querySelector('.notes-list-item-title')?.textContent === notes[104]?.title, 'later-page type filter');
    input('.notes-list-filters__fields .notes-list-filter:first-child select', projects[1]!.id);
    await waitFor(() => document.querySelector('.notes-list-empty') !== null, 'project filter sent to server');
    button('Clear', element('.notes-list-filters')).click();
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 105);
    input('.notes-list-filters__fields .notes-list-filter:nth-child(3) select', libraryTag.id);
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 1
      && document.querySelector('.notes-list-item-title')?.textContent === notes[104]?.title, 'later-page taxonomy filter');
    button('Clear', element('.notes-list-filters')).click();
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 105);
    let noteCreates = 0;
    let noteCreateFailure = true;
    api.createNote = async (request) => {
      noteCreates++;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (noteCreateFailure) return failure();
      notes.push({ ...notes[0]!, id: 'created-note', title: 'Untitled' });
      return success({ id: 'created-note', content: request.content, createdAt: now, updatedAt: now,
        tags: [], linkedItems: [], status: 'active', revision: 1 });
    };
    const newNoteButton = element<HTMLButtonElement>('[aria-label="New note"]');
    newNoteButton.click();
    newNoteButton.click();
    await waitFor(() => document.querySelector('dialog[open]')?.textContent?.includes('Could not create note') === true,
      'failed note create shown');
    check(noteCreates === 1 && getActiveBlockNoteEditor() === editor, 'Failed duplicate create preserves the open writing');
    button('OK', element('dialog[open]')).click();
    await waitFor(() => document.querySelector('dialog[open]') === null && !newNoteButton.disabled);
    noteCreateFailure = false;
    newNoteButton.click();
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 106 && getActiveBlockNoteEditor() !== editor,
      'create retry selected new note');
    const createdEditor = getActiveBlockNoteEditor();
    let noteDeletes = 0;
    let noteDeleteFailure = true;
    api.deleteNote = async (id) => {
      noteDeletes++;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (noteDeleteFailure) return failure();
      notes.splice(notes.findIndex(note => note.id === id), 1);
      return success(undefined);
    };
    const createdRow = [...document.querySelectorAll('.notes-list-item')].find(row => row.textContent?.includes('Untitled'))!;
    createdRow.querySelector<HTMLButtonElement>('.notes-list-item__delete')!.click();
    await waitFor(() => document.querySelector('dialog[open]') !== null);
    button('Delete', element('dialog[open]')).click();
    await waitFor(() => document.querySelector('dialog[open]')?.textContent?.includes('Could not delete note') === true,
      'failed note archive shown');
    check(noteDeletes === 1 && getActiveBlockNoteEditor() === createdEditor, 'Failed archive retains the exact open editor');
    button('OK', element('dialog[open]')).click();
    await waitFor(() => document.querySelector('dialog[open]') === null
      && !createdRow.querySelector<HTMLButtonElement>('.notes-list-item__delete')!.disabled);
    noteDeleteFailure = false;
    createdRow.querySelector<HTMLButtonElement>('.notes-list-item__delete')!.click();
    await waitFor(() => document.querySelector('dialog[open]') !== null);
    button('Delete', element('dialog[open]')).click();
    await waitFor(() => document.querySelectorAll('.notes-list-item').length === 105 && getActiveBlockNoteEditor() !== createdEditor);
    await go('/think?noteId=data-note-104');
    await waitFor(() => document.querySelector('.notes-list-item--active')?.textContent?.includes(notes[104]!.title) === true,
      'legacy direct note link');
  }
  await go('/');
  results.push('Think loads 105 summaries, finds later-page writing/types, preserves failed create/archive work, and opens legacy direct links');
  let releaseA = (): void => undefined;
  let delayedA = new Promise<void>(resolve => { releaseA = resolve; });
  let aStarted = false;
  let failC = true;
  api.summarizeNote = async (title) => {
    if (title === 'Race note A') { aStarted = true; await delayedA; return success({ summary: 'Obsolete summary A' }); }
    if (title === 'Race note C' && failC) return failure();
    return success({ summary: `Current summary ${title}` });
  };
  await go('/summary-fixture/A');
  await waitFor(() => aStarted, 'initial A summary');
  await go('/summary-fixture/B');
  await waitFor(() => document.querySelector('.ai-note-summary-card__text')?.textContent === 'Current summary Race note B');
  releaseA();
  await new Promise(resolve => setTimeout(resolve, 100));
  check(element('.ai-note-summary-card__text').textContent === 'Current summary Race note B', 'Obsolete summary A cannot replace B');
  await go('/summary-fixture/C');
  await waitFor(() => document.body.textContent?.includes('Could not summarise this note') === true);
  check(document.querySelector('.ai-note-summary-card__text') === null, 'Failed summary cannot retain another note summary');
  failC = false;
  button('Retry summary').click();
  await waitFor(() => document.querySelector('.ai-note-summary-card__text')?.textContent === 'Current summary Race note C');
  delayedA = new Promise<void>(resolve => { releaseA = resolve; });
  aStarted = false;
  await go('/summary-fixture/A');
  await waitFor(() => aStarted, 'second A summary');
  await go('/');
  await go('/summary-fixture/C');
  await waitFor(() => document.querySelector('.ai-note-summary-card__text')?.textContent === 'Current summary Race note C', 'remounted C summary');
  releaseA();
  await new Promise(resolve => setTimeout(resolve, 100));
  check(element('.ai-note-summary-card__text').textContent === 'Current summary Race note C', 'Old mounted request cannot affect a remounted panel');
  await go('/');
  api.summarizeNote = async () => success({ summary: 'Fixture context' });
  results.push('Delayed summaries cannot cross note identities; failed summaries settle and retry; remount invalidates old requests');
  return results;
}
