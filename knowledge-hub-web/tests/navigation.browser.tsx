import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Theme } from '@carbon/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../src/components/AppShell';
import { AthenaContextProvider, useAthenaContext } from '../src/context/AthenaContext';
import { TimelinePage } from '../src/pages/TimelinePage';
import { DocumentsPage } from '../src/pages/DocumentsPage';
import { MemoryPage } from '../src/pages/MemoryPage';
import { GraphPage } from '../src/pages/GraphPage';
import { RepoProjectMappingsPage } from '../src/pages/RepoProjectMappingsPage';
import { NotesPage } from '../src/notes/NotesPage';
import { BuildPage } from '../src/features/build/BuildPage';
import { MetadataPanel } from '../src/notes/MetadataPanel';
import { api } from '../src/services/api';
import type { ApiResponse } from '../src/types/apiResponse';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const paginated = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 100, hasMore: false });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
let syncWrites = 0;
api.getPendingTags = async () => success([]);
api.getTaxonomy = async () => success([]);
api.getRepoMappings = async () => success([]);
api.getUnsurfacedClusterCount = async () => success({ count: 1 });
api.getProjects = async () => success([]);
api.listBuildSpecs = async () => success([]);
api.listChatSessions = async () => success({ sessions: [] });
api.listModelChoices = async () => success([]);
api.getMorningBriefing = async () => success(null);
api.getSessionIdForNote = async () => success({ sessionId: null });
api.summarizeNote = async () => success({ summary: 'Fixture context' });
api.getNoteSummaries = async () => success(paginated([]));
api.listCanvases = async () => success([]);
api.listSparkClusters = async () => success([]);
api.listSparks = async () => success([]);
api.getTimeline = async () => success(paginated([]));
api.getSources = async () => success([]);
api.triggerSync = async () => { syncWrites++; return success({}); };
api.listMemories = async () => success({ memories: [] });
api.getRepoProjectMappingConfig = async () => success({ repos: [], filingTags: [], mappings: [] });
api.getGraph = async () => success({ nodes: [], edges: [], stats: {
  totalNodes: 0, totalEdges: 0, filteredNodes: 0, filteredEdges: 0, truncated: false,
} });
api.getDocumentLibrary = async () => success([{
  id: 'fixture-doc', title: 'Navigation source fixture', type: 'doc', repo: 'fixture/repo',
  path: 'README.md', sourceLabel: 'Fixture', projectId: 'personal',
  htmlUrl: 'https://example.com/README.md', size: 40, tags: [], taxonomyTagIds: [],
}]);
api.getDocumentContent = async () => success({ path: 'README.md', content: '# Source\n\nFixture source text', sha: 'test' });
api.getAllianceStatus = async () => success({
  configured: false, connected: false, account: null, connectedAt: null, lastError: null,
  root: '', syncRunning: false, sync: { lastSyncAt: null, fileCount: 0, documentCount: 0, lastError: null },
});

let navigateFixture: (path: string) => void = () => { throw new Error('Router not ready'); };
function Probe(): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { pageContext, request } = useAthenaContext();
  navigateFixture = (path) => { navigate(path); };
  return <output id="navigation-probe" hidden data-path={`${location.pathname}${location.search}`}
    data-context={pageContext?.detail ?? ''} data-request={request?.prompt ?? ''} />;
}
function Overview({ title }: { title: string }): React.ReactElement {
  const { setAthenaContext } = useAthenaContext();
  useEffect(() => {
    setAthenaContext({ type: 'today', title, detail: 'Keep the visible fixture context' });
    return () => { setAthenaContext(null); };
  }, [title, setAthenaContext]);
  return <main className="page-root"><h1>{title}</h1></main>;
}
function MetadataFixture(): React.ReactElement {
  const { setAthenaContext } = useAthenaContext();
  useEffect(() => {
    setAthenaContext({ type: 'note', id: 'fixture-note', title: 'Fixture note', detail: 'Note context preserved' });
    return () => { setAthenaContext(null); };
  }, [setAthenaContext]);
  return <div className="notes-page"><h1>Think note fixture</h1><div className="notes-root">
    <MetadataPanel doc={{ id: 'fixture-note', title: 'Fixture note', contentType: 'note',
      contentJson: '[]', createdAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-04T10:00:00Z' }}
      contentType="note" onContentTypeChange={() => undefined} projectId="" projects={[]} onProjectChange={() => undefined}
      taxonomyTagIds={[]} appliedTags={[]} autoTagIds={[]} noteId="fixture-note" onTagIdsChange={() => undefined}
      wordCount={0} readingTime={0} blockCount={0} ghStatus="not-pushed" ghDotColor="grey"
      githubPath={undefined} onPushToGitHub={() => undefined} />
  </div></div>;
}
createRoot(document.getElementById('root')!).render(
  <Theme theme="g100"><QueryClientProvider client={queryClient}><AthenaContextProvider>
    <MemoryRouter><Probe /><Routes><Route path="/" element={<AppShell />}>
      <Route index element={<Overview title="Today" />} />
      <Route path="discover" element={<Overview title="Discover" />} />
      <Route path="plan" element={<Overview title="Plan" />} />
      <Route path="projects" element={<Overview title="Projects" />} />
      <Route path="build" element={<BuildPage />} />
      <Route path="think" element={<NotesPage />} />
      <Route path="think/fixture-note" element={<MetadataFixture />} />
      <Route path="my-work" element={<TimelinePage excludeSources={['discovered-article', 'email']} />} />
      <Route path="library" element={<DocumentsPage />} />
      <Route path="memory" element={<MemoryPage />} />
      <Route path="graph" element={<GraphPage />} />
      <Route path="settings/repo-mappings" element={<RepoProjectMappingsPage />} />
    </Route></Routes></MemoryRouter>
  </AthenaContextProvider></QueryClientProvider></Theme>,
);

function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for navigation fixture; focus: ${document.activeElement?.outerHTML}`);
}
function key(element: EventTarget, value: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
}
const selector = <T extends HTMLElement,>(query: string): T => {
  const element = document.querySelector<T>(query);
  if (!element) throw new Error(`Missing fixture element: ${query}`);
  return element;
};
function menuTrigger(): HTMLButtonElement {
  return selector('.kh-header__utilities button[aria-haspopup="menu"]');
}
async function openMenu(): Promise<void> {
  menuTrigger().click();
  await waitFor(() => document.querySelector('.kh-nav-menu [role="menuitem"]') === document.activeElement);
}
function menuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('.kh-nav-menu [role="menuitem"]')]
    .find((element) => element.querySelector('.kh-nav-menu__text > span')?.textContent === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  return item;
}
async function go(path: string): Promise<void> {
  navigateFixture(path);
  await waitFor(() => selector('#navigation-probe').dataset.path === path);
}
function assertFrame(): void {
  const header = selector('.kh-header').getBoundingClientRect();
  check(header.height <= 48, 'Header must occupy one row');
  check(selector('.kh-shell').getBoundingClientRect().top >= header.bottom, 'Content must start below header');
  check(selector('.kh-header').scrollWidth <= window.innerWidth + 1, 'Header must not overflow');
  check(document.querySelector('.ai-float-button') === null, 'Floating Athena control removed on every screen');
  for (const element of document.querySelectorAll<HTMLElement>('.kh-header__destination, .kh-header__utility')) {
    const rect = element.getBoundingClientRect();
    check(rect.top >= header.top && rect.bottom <= header.bottom + 1,
      `Navigation controls share one row: ${element.textContent || element.getAttribute('aria-label')}; header ${header.top}..${header.bottom}, control ${rect.top}..${rect.bottom}`);
    check(rect.height >= 44 && rect.width >= 44, 'Header controls need touch targets');
  }
}

export async function runNavigationChecks(): Promise<string[]> {
  const results: string[] = [];
  const mobile = window.innerWidth <= 1100;
  await waitFor(() => document.querySelector('main h1')?.textContent === 'Today');
  check(selector<HTMLAnchorElement>('.kh-header__brand').getAttribute('href') === '/', 'Brand returns to Today');
  const primaryLabels = [...document.querySelectorAll('.kh-header__primary a')].map((item) => item.textContent?.trim());
  check(JSON.stringify(primaryLabels) === JSON.stringify(mobile ? ['Today'] : ['Today', 'Discover', 'Plan', 'Think', 'Build', 'Projects']), 'Primary labels and order');
  check(selector('.kh-header__primary [aria-current="page"]').textContent === 'Today', 'Today active');
  check(getComputedStyle(selector('.kh-header__primary [aria-current="page"]')).borderBottomStyle !== 'none', 'Active navigation underline');
  assertFrame();
  results.push('One-row header, correct primary workspaces, brand/default route, selected underline and touch targets');

  menuTrigger().focus();
  key(menuTrigger(), 'ArrowDown');
  await waitFor(() => document.querySelector('.kh-nav-menu [role="menuitem"]') === document.activeElement);
  const first = document.activeElement;
  key(first!, 'ArrowDown');
  check(document.activeElement !== first, 'Arrow navigation moves focus');
  key(document.activeElement!, 'Home');
  check(document.activeElement === first, 'Home restores first item');
  key(document.activeElement!, 'End');
  check(document.activeElement === [...document.querySelectorAll('.kh-nav-menu [role="menuitem"]')].at(-1), 'End moves to last item');
  key(document.activeElement!, 'Escape');
  await waitFor(() => document.querySelector('.kh-nav-menu') === null);
  check(document.activeElement === menuTrigger(), 'Escape restores trigger focus');
  await openMenu();
  menuTrigger().focus();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  menuTrigger().click();
  await waitFor(() => document.querySelector('.kh-nav-menu') === null);
  check(document.activeElement === menuTrigger(), 'Trigger closes the menu after receiving pointer focus');
  key(menuTrigger(), 'ArrowUp');
  await waitFor(() => document.activeElement === [...document.querySelectorAll('.kh-nav-menu [role="menuitem"]')].at(-1));
  menuTrigger().focus();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  selector<HTMLButtonElement>('[aria-label="Search"]').focus();
  await waitFor(() => document.querySelector('.kh-nav-menu') === null);
  await openMenu();
  check(document.querySelector('.kh-nav-menu')!.getBoundingClientRect().right <= window.innerWidth, 'Menu remains within viewport');
  check(document.querySelector('.kh-nav-menu')!.getBoundingClientRect().bottom <= window.innerHeight, 'Menu is scrollable within viewport');
  const groups = [...document.querySelectorAll('.kh-nav-menu__heading')].map((item) => item.textContent);
  check(groups.includes(mobile ? 'Tools / Context and records' : 'Context and records'), 'Tools records grouping');
  check(mobile === groups.includes('Main'), 'Mobile separates Main from Tools');
  for (const label of ['Activity', 'Sources', 'Memory', 'Knowledge graph', 'Connections and sync', 'Tag Manager', 'Repo to Tag Mappings']) {
    check(menuItem(label).querySelector('small') !== null, `${label} subtitle`);
  }
  document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await waitFor(() => document.querySelector('.kh-nav-menu') === null);
  await openMenu();
  menuItem('Activity').click();
  await waitFor(() => selector('#navigation-probe').dataset.path === '/my-work' && document.querySelector('.kh-nav-menu') === null);
  check(document.querySelector('.page-title')?.textContent === 'Activity', 'Existing Activity screen heading');
  await openMenu();
  check(menuItem('Activity').getAttribute('aria-current') === 'page', 'Supporting current route selected');
  menuItem('Connections and sync').click();
  await waitFor(() => document.querySelector('.tl-sync-panel') !== null);
  check(syncWrites === 0, 'Opening sync status must not trigger a sync');
  check(selector('.kh-tools-location').textContent === 'Tools / Connections and sync', 'Supporting location label');
  results.push('Menu keyboard/focus, grouped subtitles, outside-click/selection closure and existing sync controls');

  await openMenu();
  menuItem('Tag Manager').click();
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="Tag Manager"]') !== null);
  key(document, 'Escape');
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="Tag Manager"]') === null);
  await openMenu();
  menuItem('Repo to Tag Mappings').click();
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="Repo Mappings"]') !== null);
  key(document, 'Escape');
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="Repo Mappings"]') === null);
  await go('/settings/repo-mappings');
  await waitFor(() => document.querySelector('.page-title')?.textContent === 'Manage repo mapping');
  await go('/memory');
  await waitFor(() => document.querySelector('.page-title')?.textContent === 'Memory');
  await go('/graph');
  await waitFor(() => document.querySelector('.graph-page') !== null);
  assertFrame();
  await go('/library');
  await waitFor(() => document.querySelector('.page-title')?.textContent === 'Sources');
  check(selector('.kh-tools-location').textContent === 'Tools / Sources', 'Sources secondary label');
  results.push('Existing tag/mapping panels and direct Sources/Memory/Graph/settings routes preserved');

  selector<HTMLButtonElement>('[aria-label="Search"]').click();
  await waitFor(() => document.querySelector('[aria-label="Command palette"]') !== null);
  const palette = selector('[aria-label="Command palette"]');
  check(palette.textContent?.includes('Tools / Context and records') === true && palette.textContent?.includes('Projects') === true, 'Palette mirrors groups');
  check(palette.textContent?.includes('Sources') === true && palette.textContent?.includes('Activity') === true, 'Palette supporting labels updated');
  key(selector('[aria-label="Command palette search"]'), 'Escape');
  await waitFor(() => document.querySelector('[aria-label="Command palette"]') === null);
  await go('/');
  selector<HTMLButtonElement>('[aria-label="Open Athena"]').click();
  await waitFor(() => document.activeElement === document.querySelector('.ai-float-panel textarea'));
  const composer = selector<HTMLTextAreaElement>('.ai-float-panel textarea');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setValue.call(composer, 'Unsent navigation draft');
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  check(selector('#navigation-probe').dataset.context === 'Keep the visible fixture context', 'Launching does not alter context');
  check(selector('#navigation-probe').dataset.request === '', 'Launching does not inject a prompt');
  selector<HTMLButtonElement>('[aria-label="Open Athena"]').click();
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  check(document.querySelectorAll('.ai-float-panel').length === 1, 'Only one popout');
  check(selector<HTMLTextAreaElement>('.ai-float-panel textarea').value === 'Unsent navigation draft', 'Header launch preserves the current unsent draft');
  selector<HTMLButtonElement>('.ai-float-panel__close').click();
  await waitFor(() => document.querySelector('.ai-float-panel') === null);
  results.push('Existing search/command palette and single contextual Athena popout remain accessible');

  await go('/build');
  await waitFor(() => document.querySelector('.build-page') !== null);
  check(document.body.textContent?.includes('Build'), 'GitHub coding agent Build workspace preserved');
  if (mobile) {
    await openMenu();
    check(menuItem('Build').getAttribute('aria-current') === 'page', 'Build selected in mobile navigation');
    key(document.activeElement!, 'Escape');
  } else check(selector('.kh-header__primary [aria-current="page"]').textContent?.trim() === 'Build', 'Build selected in desktop navigation');
  results.push('GitHub Copilot Build workspace remains reachable from desktop and mobile navigation');

  await go('/think');
  await waitFor(() => document.querySelector('.notes-page') !== null);
  for (const mode of ['Sparks', 'Canvas', 'Notes']) {
    const modeButton = [...document.querySelectorAll<HTMLButtonElement>('.plan-view-btn')].find((item) => item.textContent?.trim() === mode);
    check(modeButton !== undefined, `Existing Think ${mode} switch`);
    modeButton!.click();
    await waitFor(() => modeButton!.getAttribute('aria-selected') === 'true');
    if (mobile) {
      await openMenu();
      check(menuItem('Think').getAttribute('aria-current') === 'page', `Think selected in ${mode}`);
      key(document.activeElement!, 'Escape');
    } else check(selector('.kh-header__primary [aria-current="page"]').textContent?.trim() === 'Think', `Think selected in ${mode}`);
    check(selector<HTMLButtonElement>('[aria-label="Open Athena"]').disabled, 'Toolbar Athena disabled in every Think mode');
    selector<HTMLButtonElement>('[aria-label="Open Athena"]').click();
    check(document.querySelector('.ai-float-panel') === null, 'Disabled Think launcher cannot open a popout');
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }));
  await waitFor(() => document.querySelector('[aria-label="New Spark"]') !== null);
  key(document, 'Escape');
  await waitFor(() => document.querySelector('[aria-label="New Spark"]') === null);
  results.push('Think selected in all modes, toolbar Athena disabled and quick Spark shortcut preserved');

  if (window.innerWidth >= 1200) {
    await go('/think/fixture-note');
    await waitFor(() => document.querySelector('#think-side-tab-athena') !== null && document.querySelector('.ai-float-button') === null);
    selector<HTMLButtonElement>('#think-side-tab-metadata').click();
    selector<HTMLButtonElement>('[aria-label="Collapse side panel"]').click();
    await waitFor(() => selector('.notes-meta-panel').hidden);
    selector<HTMLButtonElement>('[aria-label="Open Athena"]').click();
    check(selector('.notes-meta-panel').hidden, 'Disabled Think toolbar does not change embedded panel');
    selector<HTMLButtonElement>('[aria-label="Open side panel"]').click();
    selector<HTMLButtonElement>('#think-side-tab-athena').click();
    await waitFor(() => !selector('.notes-meta-panel').hidden && selector('#think-side-tab-athena').getAttribute('aria-selected') === 'true');
    check(selector('#navigation-probe').dataset.context === 'Note context preserved', 'Metadata rail retains note context');
    check(document.querySelector('.ai-float-panel') === null, 'Header must not duplicate embedded conversation');
    await go('/library');
    await waitFor(() => document.querySelector('.docs-list-item') !== null);
    selector<HTMLButtonElement>('.docs-list-item').click();
    await waitFor(() => document.querySelector('#library-side-tab-athena') !== null && document.querySelector('.ai-float-button') === null);
    selector<HTMLButtonElement>('#library-side-tab-details').click();
    selector<HTMLButtonElement>('[aria-label="Collapse side panel"]').click();
    selector<HTMLButtonElement>('[aria-label="Open Athena"]').click();
    await waitFor(() => selector('#library-side-tab-athena').getAttribute('aria-selected') === 'true' && !selector('.side-tabs-panel').hidden);
    await waitFor(() => document.activeElement === document.querySelector('.think-athena-panel textarea'));
    check(document.querySelector('.ai-float-panel') === null, 'Source rail must not duplicate Athena');
    results.push('Think uses its built-in panel; toolbar reveals Sources rail without duplicating chat');
  }

  api.getSources = async () => ({ success: false, error: { code: 'FIXTURE_FAILURE', message: 'Fixture sync unavailable' } });
  api.getUnsurfacedClusterCount = async () => ({ success: false, error: { code: 'FIXTURE_FAILURE', message: 'Fixture Sparks unavailable' } });
  await queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] });
  await go('/my-work?sync=1');
  await waitFor(() => document.querySelector('.tl-sync-panel') !== null);
  await openMenu();
  check(menuItem('Sources') !== null && menuItem('Memory') !== null, 'Service errors do not hide tools');
  if (mobile) menuItem('Today').click();
  else {
    key(document.activeElement!, 'Escape');
    selector<HTMLAnchorElement>('.kh-header__primary a[href="/"]').click();
  }
  await waitFor(() => selector('#navigation-probe').dataset.path === '/');
  assertFrame();
  results.push('Supporting service failures do not affect primary navigation or Tools membership');
  return results;
}

Object.assign(window, { runNavigationChecks });
