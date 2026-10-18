import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocEntry } from '../src/services/api';
import {
  DOCUMENT_BATCH_SIZE, documentListWindow, documentLocation, findDocument, searchDocuments,
} from '../src/components/library/documentListModel';

function doc(index: number, patch: Partial<DocEntry> = {}): DocEntry {
  return {
    id: `owner/project::docs/${index}.md`, contentItemId: `graph-${index}`, title: `Document ${index}`,
    repo: 'owner/project', path: `docs/${index}.md`, sourceLabel: 'Project', projectId: 'project',
    htmlUrl: `https://github.com/owner/project/blob/main/docs/${index}.md`, type: 'doc',
    size: 1024, tags: [], taxonomyTagIds: [], ...patch,
  };
}
const library = Array.from({ length: 1467 }, (_, index) => doc(index));

test('a 1,467-document library initially mounts only one batch with accurate remaining counts', () => {
  const result = documentListWindow(library, DOCUMENT_BATCH_SIZE, null);
  assert.equal(result.docs.length, 50);
  assert.equal(result.displayedCount, 50);
  assert.equal(result.remainingCount, 1417);
  assert.equal(result.pinnedDoc, null);
  assert.equal(library.length, 1467);
});

test('successive batches make every document reachable without dropping or repeating rows', () => {
  for (let limit = DOCUMENT_BATCH_SIZE; limit < library.length + DOCUMENT_BATCH_SIZE; limit += DOCUMENT_BATCH_SIZE) {
    const result = documentListWindow(library, limit, null);
    assert.deepEqual(result.docs, library.slice(0, limit));
    assert.equal(result.displayedCount + result.remainingCount, library.length);
  }
  assert.equal(documentListWindow(library, 1500, null).remainingCount, 0);
});

test('search runs on the entire library before slicing, trims whitespace and supports existing source metadata', () => {
  const distant = doc(1466, { title: 'Last result', localPath: '/Users/me/Reference/strategy.pdf', deviceName: 'Work laptop' });
  const docs = [...library.slice(0, -1), distant];
  for (const query of ['  LAST RESULT  ', 'docs/1466.md', 'Reference/strategy.pdf', 'WORK LAPTOP']) {
    const result = documentListWindow(searchDocuments(docs, query), DOCUMENT_BATCH_SIZE, null);
    assert.deepEqual(result.docs, [distant], query);
    assert.equal(result.remainingCount, 0);
  }
  assert.equal(searchDocuments(docs, 'owner/project').length, 1467);
  assert.equal(searchDocuments(docs, 'Project').length, 1467);
  assert.equal(searchDocuments(docs, '   ').length, 1467);
  assert.equal(searchDocuments(docs, 'absent document').length, 0);
});

test('search matches the original URL for uploaded and OneDrive documents', () => {
  const upload = doc(1, { repo: 'kb-uploads', path: 'uuid', htmlUrl: 'https://storage.example/quarterly-review.pdf' });
  assert.deepEqual(searchDocuments([upload], 'quarterly-review'), [upload]);
});

test('project and taxonomy results stay scoped before a full-set search and batch', () => {
  const docs = library.map((entry, index) => ({ ...entry, projectId: index === 1466 ? 'other' : 'project',
    taxonomyTagIds: index === 1465 ? ['wanted'] : [] }));
  const tagged = docs.filter((entry) => entry.projectId === 'project' && entry.taxonomyTagIds.includes('wanted'));
  assert.deepEqual(documentListWindow(searchDocuments(tagged, 'Document'), 50, null).docs, [docs[1465]]);
});

test('a distant deep-linked selection is pinned, not expanded to 1,467 mounted rows', () => {
  const selected = library[1466]!;
  const result = documentListWindow(library, 50, selected);
  assert.equal(result.docs.length, 50);
  assert.equal(result.pinnedDoc, selected);
  assert.equal(result.selectedOutsideFilters, false);
  assert.equal(result.displayedCount, 51);
  assert.equal(result.remainingCount, 1416);
  assert.equal(result.docs.some((entry) => entry.id === selected.id), false);
});

test('selection remains accessible outside filters without polluting filtered-result counts', () => {
  const selected = library[1466]!;
  const matches = searchDocuments(library, 'Document 140');
  const result = documentListWindow(matches, 50, selected);
  assert.equal(result.pinnedDoc, selected);
  assert.equal(result.selectedOutsideFilters, true);
  assert.equal(result.displayedCount, 11);
  assert.equal(result.remainingCount, 0);
  const empty = documentListWindow([], 50, selected);
  assert.equal(empty.displayedCount, 0);
  assert.equal(empty.pinnedDoc, selected);
  assert.equal(empty.selectedOutsideFilters, true);
});

test('growing past the selection unpins it without duplicating it or changing counts', () => {
  const selected = library[60]!;
  assert.equal(documentListWindow(library, 50, selected).displayedCount, 51);
  const result = documentListWindow(library, 100, selected);
  assert.equal(result.pinnedDoc, null);
  assert.equal(result.displayedCount, 100);
  assert.equal(result.remainingCount, 1367);
  assert.equal(result.docs.filter((entry) => entry.id === selected.id).length, 1);
});

test('same-title documents retain distinct identities and show the actual repository or local path', () => {
  const first = doc(0, { title: '0001 Adopt Adrs', repo: 'owner/first', path: 'docs/adr/0001-adopt-adrs.md' });
  const second = doc(1, { title: first.title, repo: 'owner/second', path: first.path });
  const third = doc(2, { title: first.title, repo: first.repo, path: 'docs/archive/0001-adopt-adrs.md' });
  const local = doc(3, { title: first.title, localPath: '/Documents/0001-adopt-adrs.md', deviceName: 'Desktop' });
  const matches = searchDocuments([first, second, third, local], first.title);
  assert.equal(matches.length, 4);
  assert.equal(new Set(matches.map((entry) => entry.id)).size, 4);
  assert.equal(new Set(matches.map(documentLocation)).size, 4);
  assert.equal(documentLocation(first), 'owner/first/docs/adr/0001-adopt-adrs.md');
  assert.equal(documentLocation(local), 'Desktop · /Documents/0001-adopt-adrs.md');
});

test('OneDrive and uploaded entries show their source and URL or stable path, not sentinel repo names', () => {
  assert.equal(documentLocation(doc(0, { repo: 'onedrive', htmlUrl: 'https://onedrive.example/report.docx' })),
    'OneDrive · https://onedrive.example/report.docx');
  assert.equal(documentLocation(doc(0, { repo: 'kb-uploads', htmlUrl: '', path: 'upload-id' })), 'Upload · upload-id');
});

test('both stable library IDs and knowledge-graph IDs resolve a document without affecting selection order', () => {
  const last = library[1466]!;
  assert.equal(findDocument(library, last.id), last);
  assert.equal(findDocument(library, last.contentItemId!), last);
  assert.equal(findDocument(library, null), null);
  assert.equal(findDocument(library, 'missing'), null);
});
