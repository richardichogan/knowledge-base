import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramDraftKey, listDiagramDrafts, parseDiagramDraft, removeDiagramDraftIfUnchanged, storeDiagramDraft, type DiagramDraft } from '../src/features/diagram/diagramDraftStorage';
import { emptyDiagram } from '../src/features/diagram/diagramTypes';
import { clearAllNoteDrafts } from '../src/notes/noteDraftStorage';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
const draft: DiagramDraft = {
  version: 1, identity: 'tenant:owner', canvasId: 'diagram-a', draftId: 'tab-a',
  baseRevision: 31, updatedAt: '2026-11-02T12:00:00.000Z',
  document: { ...emptyDiagram(), footnotes: [], legend: { visible: true, position: 'bottom-right', entries: [{ colour: '#f00', label: 'Keep exact content' }] } },
};

test('diagram drafts survive reopening with exact contents, original revision and account/canvas/tab separation', () => {
  const storage = new MemoryStorage();
  storeDiagramDraft(storage, draft);
  storeDiagramDraft(storage, { ...draft, draftId: 'tab-b' });
  storeDiagramDraft(storage, { ...draft, identity: 'other-owner' });
  storeDiagramDraft(storage, { ...draft, canvasId: 'other-diagram' });
  const reopened = listDiagramDrafts(storage, draft.identity, draft.canvasId);
  assert.equal(reopened.length, 2);
  assert.deepEqual(reopened.find(item => item.draftId === draft.draftId), draft);
  assert.throws(() => parseDiagramDraft(JSON.stringify(draft), 'other-owner', draft.canvasId));
  assert.throws(() => parseDiagramDraft(JSON.stringify(draft), draft.identity, 'other-diagram'));
});

test('late server acknowledgements cannot erase newer changes or another recovery editor', () => {
  const storage = new MemoryStorage();
  const key = diagramDraftKey(draft.identity, draft.canvasId, draft.draftId);
  const submitted = storeDiagramDraft(storage, draft);
  const newer = storeDiagramDraft(storage, { ...draft, baseRevision: 32, document: { ...draft.document, grid: false } });
  storeDiagramDraft(storage, { ...draft, draftId: 'recovery-tab' });
  assert.equal(removeDiagramDraftIfUnchanged(storage, key, submitted), false);
  assert.equal(storage.getItem(key), newer);
  assert.equal(removeDiagramDraftIfUnchanged(storage, key, newer), true);
  assert.equal(listDiagramDrafts(storage, draft.identity, draft.canvasId)[0]?.draftId, 'recovery-tab');
});

test('invalid drafts and unavailable local storage fail explicitly without deleting recoverable writing', () => {
  const storage = new MemoryStorage();
  const raw = storeDiagramDraft(storage, draft);
  for (const invalid of [{ ...draft, version: 2 }, { ...draft, baseRevision: -1 }, { ...draft, updatedAt: 'invalid' },
    { ...draft, document: { ...draft.document, nodes: [null] } },
    { ...draft, document: { ...draft.document, viewport: { x: 0, y: 0, zoom: 0 } } }]) {
    assert.throws(() => parseDiagramDraft(JSON.stringify(invalid), draft.identity, draft.canvasId));
  }
  storage.setItem = () => { throw new Error('Device storage full'); };
  assert.throws(() => storeDiagramDraft(storage, draft), /Device storage full/);
  assert.equal(storage.getItem(diagramDraftKey(draft.identity, draft.canvasId, draft.draftId)), raw);
});

test('sign-out removes diagram drafts as well as note/work drafts, not unrelated settings', () => {
  const storage = new MemoryStorage();
  storeDiagramDraft(storage, draft);
  storage.setItem('appearance', 'keep');
  clearAllNoteDrafts(storage);
  assert.equal(listDiagramDrafts(storage, draft.identity, draft.canvasId).length, 0);
  assert.equal(storage.getItem('appearance'), 'keep');
});
