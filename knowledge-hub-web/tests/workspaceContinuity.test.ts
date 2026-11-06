import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resumeWorkspacePath } from '../src/navigation/workspaceContinuity';
import { listShortcut } from '../src/hooks/listKeyboard';

test('selected Plan tasks retain the normal Board/Focus content and compact formatted previews', async () => {
  const page = await readFile(new URL('../src/pages/TasksPage.tsx', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../src/components/TaskDescription.tsx', import.meta.url), 'utf8');
  assert.match(page, /const taskViews = <>/);
  assert.match(page, /\{taskViews\}[\s\S]*: taskViews/);
  assert.doesNotMatch(page, /scopedTasks\.map\(task => <ReviewItem/);
  assert.match(page, /TaskDescription className="kb-card__body" text=\{task\.body\}/);
  assert.match(preview, /renderMarkdownPreview\(text\)/);
  assert.match(page, /const laneTasks = column\.id === 'completed' \? visibleCompletedTasks\(allLaneTasks\) : allLaneTasks/);
  assert.match(page, /const COMPLETED_PREVIEW_COUNT = 5;/);
});
test('task previews clamp one inline flow without fixed-height paragraph cropping', async () => {
  const renderer = await readFile(new URL('../src/utils/markdown.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles/workspaces.scss', import.meta.url), 'utf8');
  assert.match(renderer, /export function renderMarkdownPreview/);
  assert.match(renderer, /source\.cloneNode\(false\)/);
  assert.match(renderer, /doc\.createElement\(\/\^H\[1-6\]\$\/\.test\(source\.tagName\) \? 'strong' : 'span'\)/);
  assert.doesNotMatch(styles, /max-height: 3em/);
  assert.match(styles, /\.kb-card__body\.kh-task-prose, \.kb-inbox-card__body\.kh-task-prose \{\s*flex: 0 0 auto/);
});

test('area navigation resumes only an exact internal root and never replaces an explicit link', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map([['kh-resume:/think', '/think?noteId=one'], ['kh-resume:/plan', '//elsewhere.example/plan']]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null } } });
  try {
    assert.equal(resumeWorkspacePath('/think'), '/think?noteId=one');
    assert.equal(resumeWorkspacePath('/think?noteId=two'), '/think?noteId=two');
    assert.equal(resumeWorkspacePath('/plan'), '/plan');
    assert.equal(resumeWorkspacePath('/health'), '/health');
  } finally { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('list shortcuts ignore controls, editors, modal overlays and modifier keys', () => {
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class Element extends EventTarget {
    constructor(private blocked = false) { super(); }
    closest(): object | null { return this.blocked ? {} : null; }
  }
  let modal = false;
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Element });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => modal ? {} : null } });
  const event = { target: new Element(), key: 'j', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  try {
    assert.equal(listShortcut(event), 'j');
    assert.equal(listShortcut({ ...event, ctrlKey: true }), null);
    assert.equal(listShortcut({ ...event, target: new Element(true) }), null);
    assert.equal(listShortcut({ ...event, key: 'Delete' }), null);
    modal = true;
    assert.equal(listShortcut(event), null);
  } finally {
    if (originalElement) Object.defineProperty(globalThis, 'HTMLElement', originalElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
