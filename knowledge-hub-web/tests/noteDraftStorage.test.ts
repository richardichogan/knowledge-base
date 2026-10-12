import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureNoteDraft, clearAllNoteDrafts, listNoteDrafts, noteDraftKey, parseNoteDraft, removeNoteDraftIfUnchanged, storeNoteDraft } from '../src/notes/noteDraftStorage';
import type { NoteDocument } from '../src/notes/types';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const doc: NoteDocument = {
  id: 'note-a', revision: 7, title: 'Exact local writing', contentType: 'spec',
  contentJson: JSON.stringify([{ id: 'block-a', type: 'paragraph', content: [{ type: 'text', text: 'Rich writing', styles: { bold: true } }],
    children: [{ type: 'paragraph', content: 'Nested writing' }] }]),
  projectId: 'retained-project', githubPath: 'retained-publication.md', createdAt: '', updatedAt: '',
};

test('drafts preserve exact rich writing, note/identity/revision and independent editors without backing up publication metadata', () => {
  const storage = new MemoryStorage();
  const first = captureNoteDraft('owner-a', id(1), doc);
  storeNoteDraft(storage, first);
  storeNoteDraft(storage, captureNoteDraft('owner-a', id(2), { ...doc, contentJson: '[{"type":"paragraph","content":"Other tab"}]' }));
  storeNoteDraft(storage, captureNoteDraft('owner-b', id(3), doc));
  storeNoteDraft(storage, captureNoteDraft('owner-a', id(4), { ...doc, id: 'note-b', revision: 12 }));
  const local = listNoteDrafts(storage, 'owner-a');
  assert.equal(local.drafts.length, 3);
  assert.equal(local.errors.length, 0);
  assert.deepEqual(local.drafts.find(draft => draft.id === id(1))?.writing, {
    title: doc.title, contentType: doc.contentType, contentJson: doc.contentJson,
  });
  assert.equal(local.drafts.find(draft => draft.id === id(1))?.baseRevision, 7);
  assert.ok(local.drafts.every(draft => draft.identity === 'owner-a'));
  assert.ok(!('projectId' in first.writing) && !('githubPath' in first.writing));
  assert.throws(() => parseNoteDraft(JSON.stringify(first), 'owner-b'));
  assert.throws(() => parseNoteDraft(JSON.stringify(first), 'owner-a', noteDraftKey('owner-a', 'note-b', first.id)));
});

test('late save acknowledgements and stale discard decisions cannot remove a newer draft', () => {
  const storage = new MemoryStorage();
  const draft = captureNoteDraft('owner-a', id(1), doc, new Date('2026-10-01'));
  const submitted = storeNoteDraft(storage, draft);
  const newer = captureNoteDraft('owner-a', id(1), { ...doc, contentJson: '[{"type":"paragraph","content":"New typing"}]' }, new Date('2026-10-02'));
  const next = storeNoteDraft(storage, newer);
  assert.equal(removeNoteDraftIfUnchanged(storage, draft, submitted), false);
  assert.equal(listNoteDrafts(storage, 'owner-a').drafts[0]?.writing.contentJson, newer.writing.contentJson);
  assert.equal(removeNoteDraftIfUnchanged(storage, newer, next), true);
  assert.equal(storage.length, 0);
});

test('malformed/versioned/oversized drafts and storage failures are explicit; sign-out cleanup removes only note-draft keys', () => {
  const storage = new MemoryStorage();
  const draft = captureNoteDraft('owner-a', id(1), doc);
  for (const invalid of [{ ...draft, version: 2 }, { ...draft, baseRevision: -1 }, { ...draft, baseRevision: 1.5 },
    { ...draft, updatedAt: 'invalid' }, { ...draft, writing: { ...draft.writing, contentJson: '{}' } },
    { ...draft, writing: { ...draft.writing, contentType: 'unknown' } }]) {
    assert.throws(() => parseNoteDraft(JSON.stringify(invalid), 'owner-a'));
  }
  assert.throws(() => captureNoteDraft('', id(1), doc));
  assert.throws(() => captureNoteDraft('owner-a', id(1), { ...doc, contentJson: 'x'.repeat(2_000_001) }));
  storage.setItem(noteDraftKey('owner-a', doc.id, id(1)), '{');
  storeNoteDraft(storage, captureNoteDraft('owner-a', id(2), doc));
  const read = listNoteDrafts(storage, 'owner-a');
  assert.equal(read.errors.length, 1);
  assert.equal(read.drafts.length, 1);
  storage.setItem('unrelated-preference', 'keep');
  storage.setItem('kh-athena-session-id-standalone', 'keep chat recovery');
  clearAllNoteDrafts(storage);
  assert.equal(storage.getItem('unrelated-preference'), 'keep');
  assert.equal(storage.getItem('kh-athena-session-id-standalone'), 'keep chat recovery');
  storage.setItem = () => { throw new Error('Device storage full'); };
  assert.throws(() => storeNoteDraft(storage, draft), /Device storage full/);
});
