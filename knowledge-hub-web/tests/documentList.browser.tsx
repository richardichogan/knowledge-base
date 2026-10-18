import type { QueryClient } from '@tanstack/react-query';
import { api, type DocEntry } from '../src/services/api';
import '../src/styles/workspaces.scss';

function check(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Document list fixture timed out');
}

function element<T extends HTMLElement>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing document list fixture element: ${selector}`);
  return match;
}

function search(value: string): void {
  const input = element<HTMLInputElement>('.docs-search__input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Runs inside the existing navigation fixture, at either desktop or phone width. */
export async function runDocumentListChecks(queryClient: QueryClient, go: (path: string) => Promise<void>): Promise<string[]> {
  const originalLibrary = api.getDocumentLibrary;
  const originalContent = api.getDocumentContent;
  const docs: DocEntry[] = Array.from({ length: 1467 }, (_, index) => ({
    id: `fixture/repo::docs/${index}/0001-adopt-adrs.md`,
    title: index < 2 ? '0001 Adopt Adrs' : `Fixture source ${index}`,
    type: 'doc', repo: 'fixture/repo', path: `docs/${index}/0001-adopt-adrs.md`,
    sourceLabel: 'Fixture', projectId: 'personal',
    htmlUrl: `https://example.com/docs/${index}.md`, size: 40, tags: [], taxonomyTagIds: [],
  }));
  const last = docs[1466]!;
  let readPath = '';
  api.getDocumentLibrary = async () => ({ success: true, data: docs });
  api.getDocumentContent = async (_repo, path) => {
    readPath = path;
    return { success: true, data: { path, content: `# Source content\n\n${path}`, sha: 'fixture' } };
  };
  const rows = (): NodeListOf<HTMLButtonElement> => document.querySelectorAll('.docs-list-item');
  try {
    await go('/chat');
    queryClient.removeQueries({ queryKey: ['documents-library'] });
    await go('/library');
    await waitFor(() => rows().length === 50);
    check(element('.docs-list-summary').textContent?.includes('50 of 1,467') === true, 'Initial rendered and total counts are accurate');
    const duplicateNames = [...rows()].filter((row) => row.querySelector('.docs-list-item__title')?.textContent === '0001 Adopt Adrs');
    check(duplicateNames.length === 2, 'Different source documents with the same title are both retained');
    check(duplicateNames[0]!.querySelector('.docs-list-item__location')?.textContent !==
      duplicateNames[1]!.querySelector('.docs-list-item__location')?.textContent, 'Same-title sources show distinct paths');
    element<HTMLButtonElement>('.docs-list-more').click();
    await waitFor(() => rows().length === 100);

    search(' Fixture source 1466 ');
    await waitFor(() => rows().length === 1);
    check(element('.docs-list-summary').textContent?.includes('1 of 1') === true, 'Search reaches the last result before batching');
    rows()[0]!.click();
    await waitFor(() => readPath === last.path && document.querySelector('.docs-viewer__content')?.textContent?.includes(last.path) === true);
    check(element('.docs-page').dataset.activePane === 'editor', 'Selecting a result retains the document viewer and phone detail pane');
    check(element<HTMLAnchorElement>('.docs-viewer__gh-link').href === last.htmlUrl, 'Original source action is retained');
    element<HTMLButtonElement>('.docs-page .kh-workspace-back').click();
    await waitFor(() => element('.docs-page').dataset.activePane === 'list');
    check(element<HTMLInputElement>('.docs-search__input').value === ' Fixture source 1466 ', 'Phone Back preserves the search');
    check(rows().length === 1, 'Phone Back returns to the filtered list');

    search('');
    await waitFor(() => rows().length === 50);
    await go(`/library?docId=${encodeURIComponent(last.id)}`);
    await waitFor(() => document.querySelector('.docs-group--selected .docs-list-item--active') !== null);
    check(rows().length === 51, 'A deep link pins only the selected row, not all preceding rows');
    check(element('.docs-list-summary').textContent?.includes('51 of 1,467') === true, 'Pinned matching rows are included in displayed counts');
    search('no matching source');
    await waitFor(() => element('.docs-list-summary').textContent?.includes('0 of 0') === true);
    check(rows().length === 1 && document.querySelector('.docs-list-item--active') !== null, 'Filtered-out selection stays accessible and does not falsify result counts');
    if (window.innerWidth <= 640) {
      check(getComputedStyle(element('.docs-list-panel')).display === 'none', 'Phone detail hides the list');
      check(getComputedStyle(element('.docs-document-area')).display !== 'none', 'Phone detail shows the document');
    }
    element<HTMLButtonElement>('.docs-page .kh-workspace-back').click();
    await waitFor(() => element('.docs-page').dataset.activePane === 'list');
    if (window.innerWidth <= 640) {
      check(getComputedStyle(element('.docs-list-panel')).display !== 'none', 'Phone Back restores the list');
      check(getComputedStyle(element('.docs-document-area')).display === 'none', 'Phone Back hides the document');
    }
    return ['Sources batch 1,467 rows, search the full set, preserve same-title paths, pin deep links and retain source viewers/phone Back'];
  } finally {
    await go('/chat');
    api.getDocumentLibrary = originalLibrary;
    api.getDocumentContent = originalContent;
    queryClient.removeQueries({ queryKey: ['documents-library'] });
    queryClient.removeQueries({ queryKey: ['document-content'] });
  }
}
