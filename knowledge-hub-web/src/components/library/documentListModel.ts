import type { DocEntry } from '../../services/api';

export const DOCUMENT_BATCH_SIZE = 50;

export function searchDocuments(docs: readonly DocEntry[], query: string): DocEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return docs.filter((doc) => needle === '' || [
    doc.title, doc.sourceLabel, doc.repo, doc.path, doc.localPath, doc.deviceName, doc.htmlUrl,
  ].some((value) => value?.toLocaleLowerCase().includes(needle)));
}

export function documentLocation(doc: DocEntry): string {
  if (doc.localPath !== undefined) return `${doc.deviceName ?? 'This PC'} · ${doc.localPath}`;
  if (doc.repo === 'onedrive') return `OneDrive · ${doc.htmlUrl || doc.path}`;
  if (doc.repo === 'kb-uploads') return `Upload · ${doc.htmlUrl || doc.path}`;
  return `${doc.repo}/${doc.path}`;
}

export function findDocument(docs: readonly DocEntry[], id: string | null): DocEntry | null {
  return docs.find((doc) => doc.id === id || doc.contentItemId === id) ?? null;
}

export function documentListWindow(
  matches: readonly DocEntry[],
  limit: number,
  selectedDoc: DocEntry | null,
) {
  const docs = matches.slice(0, Math.max(DOCUMENT_BATCH_SIZE, limit));
  // Pin a distant selection instead of mounting every row leading up to it.
  const pinnedDoc = selectedDoc !== null && !docs.some((doc) => doc.id === selectedDoc.id)
    ? selectedDoc : null;
  const selectedMatches = pinnedDoc !== null && matches.some((doc) => doc.id === pinnedDoc.id);
  const displayedCount = docs.length + (selectedMatches ? 1 : 0);
  return {
    docs,
    pinnedDoc,
    selectedOutsideFilters: pinnedDoc !== null && !selectedMatches,
    displayedCount,
    remainingCount: matches.length - displayedCount,
  };
}
