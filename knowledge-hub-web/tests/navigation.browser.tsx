import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Theme } from '@carbon/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../src/components/AppShell';
import { AUTH_ENABLED } from '../src/services/auth';
import { AthenaContextProvider, useAthenaContext } from '../src/context/AthenaContext';
import { TimelinePage } from '../src/pages/TimelinePage';
import { DocumentsPage } from '../src/pages/DocumentsPage';
import { MemoryPage } from '../src/pages/MemoryPage';
import { GraphPage } from '../src/pages/GraphPage';
import { RepoProjectMappingsPage } from '../src/pages/RepoProjectMappingsPage';
import { NotesPage } from '../src/notes/NotesPage';
import { BuildPage } from '../src/features/build/BuildPage';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { PlanPage } from '../src/pages/PlanPage';
import { AIChatPage } from '../src/pages/AIChatPage';
import { SignInGate } from '../src/components/SignInGate';
import { MetadataPanel } from '../src/notes/MetadataPanel';
import { api } from '../src/services/api';
import './note-draft-identity';
import type { ApiResponse } from '../src/types/apiResponse';
import type { ChatTurnEvent } from '../src/types';
import type { PlanTask } from '../src/types/task';
import { localDateKey } from '../src/utils/dateOnly';
import { runDataReliabilityChecks, SummaryFixture } from './data-reliability.browser';
import { AppDialogHost } from '../src/components/AppDialog';
import type { GraphResponse } from '../src/services/api';
import { PLAN_PREFERENCES_KEY } from '../src/utils/planPreferences';
import { deferredView, newerBuildEntry } from '../src/utils/deferredView';
import { projectPickerProjects } from './projectPickerFixtures';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const paginated = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 100, hasMore: false });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
let syncWrites = 0;
const graphFixture: GraphResponse = {
  nodes: Array.from({ length: 112 }, (_, i) => ({
    id: `graph-${i}`, refId: `note-${i}`, refType: 'note', title: i === 0 ? 'Long graph title '.repeat(50) : `Graph note ${i}`,
    tags: [], createdAt: '2026-10-12T08:00:00Z', conceptParent: null,
  })),
  edges: Array.from({ length: 101 }, (_, i) => ({
    id: `edge-${i}`, source: `graph-${i}`, target: `graph-${i + 1}`, edgeType: 'thematically_related',
    confidence: 0.8, metadata: null,
  })),
  stats: { totalNodes: 800, totalEdges: 1000, filteredNodes: 112, filteredEdges: 101, truncated: true },
};
api.getPendingTags = async () => success([]);
api.getNavAttention = async () => success({ think: 0, discover: 0, plan: 0, build: 0 });
api.getTaxonomy = async () => success([]);
api.getRepoMappings = async () => success([]);
api.getUnsurfacedClusterCount = async () => success({ count: 1 });
api.getPodcastPrep = async () => success({ nextRecording: null, scheduleWarning: 'No recording date set.', run: null, latestBrief: null });
api.getDayCheckin = async () => success({ day: '2026-10-15', hour: 8, status: null, items: [], completedToday: [] });
api.getProjects = async () => success([]);
api.getProjectGroups = async () => success([]);
api.getTags = async () => success([]);
api.listBuildSpecs = async () => success([]);
api.listUseCases = async () => success([]);
api.listChatSessions = async () => success({ sessions: [] });
api.listModelChoices = async () => success([]);
api.getMorningBriefing = async () => success(null);
api.getSessionIdForNote = async () => success({ sessionId: null });
api.getSessionHistory = async (sessionId) => success({ sessionId, messages: [], projectId: null });
api.getSessionTurn = async () => success(null);
api.listAlternates = async () => success([]);
api.listExclusions = async () => success([]);
api.getChatMentionTargets = async () => success([
  { type: 'note', id: '00000000-0000-4000-8000-000000000001', title: 'Feature specification', href: '/think?noteId=00000000-0000-4000-8000-000000000001', detail: 'spec' },
  { type: 'document', id: '00000000-0000-4000-8000-000000000002', title: 'Architecture source', href: '/library?contentItemId=00000000-0000-4000-8000-000000000002', detail: 'user-upload' },
  { type: 'person', id: '00000000-0000-4000-8000-000000000003', title: 'Richard Hogan', href: '/people?personId=00000000-0000-4000-8000-000000000003', detail: 'IBM' },
]);
api.listChatOutputs = async () => success([]);
api.listChatScreens = async () => success([]);
api.getChatDecisions = async () => success({ tracking: { enabled: false, explicit: null, personaDefault: false }, decisions: [] });
api.summarizeNote = async () => success({ summary: 'Fixture context' });
api.getNoteSummaries = async () => success(paginated([]));
api.listCanvases = async () => success([
  { id: 'detail-canvas', title: 'Observability - detail', canvasType: 'diagram' as const,
    description: null, project: null, createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z',
    linkedNotes: [], nodeCount: 1, parentCanvasId: 'parent-canvas', parentShapeLabel: 'Observability' },
  { id: 'parent-canvas', title: 'Imagine Agentic Build & Run Model', canvasType: 'diagram' as const,
    description: null, project: null, createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z',
    linkedNotes: [], nodeCount: 62 },
]);
api.listDeletedCanvases = async () => success([]);
api.listSparkClusters = async () => success([]);
api.listSparks = async () => success([]);
api.getTimeline = async () => success(paginated([]));
api.getTasks = async () => success(paginated([]));
api.getTaskNotes = async () => success([]);
api.getTaskLinks = async () => success([]);
api.getConnections = async () => success({});
api.getSources = async () => success([]);
api.getEmailAccountConnections = async () => success([
  { id: 'alliance', email: 'Richard.i.Hogan@ibmalliance.onmicrosoft.com', provider: 'Microsoft 365', status: 'not-connected', detail: 'OneDrive sign-in does not grant mail access.' },
  { id: 'hotmail', email: 'richard_hogan@hotmail.co.uk', provider: 'Outlook.com', status: 'not-connected', detail: 'Separate mailbox authorisation required.' },
  { id: 'gmail', email: 'richardichogan@gmail.com', provider: 'Gmail', status: 'not-connected', detail: 'Google authorisation required.' },
]);
api.triggerSync = async () => { syncWrites++; return success({ id: 'sync-fixture', status: 'running',
  startedAt: '', finishedAt: null, results: [] }); };
api.getLatestSyncRun = async () => success(null);
api.getSyncRun = async () => success({ id: 'sync-fixture', status: 'succeeded', startedAt: '', finishedAt: '', results: [] });
api.listMemories = async () => success({ memories: [] });
api.getRepoProjectMappingConfig = async () => success({ repos: [], filingTags: [], mappings: [] });
api.getGraph = async () => success({ nodes: [], edges: [], stats: {
  totalNodes: 0, totalEdges: 0, filteredNodes: 0, filteredEdges: 0, truncated: false,
} });
api.getDocumentLibrary = async () => success([{
  id: 'fixture-doc', title: 'Navigation source fixture', type: 'doc', repo: 'fixture/repo',
  contentItemId: '00000000-0000-4000-8000-000000000002',
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
      githubPath={undefined} onPushToGitHub={() => undefined}
      githubError="" githubBusy={false} onCheckGitHub={() => undefined}
      onRestoreVersion={async () => {}} historyRefresh={0} prepareDemoBrief={async () => 'Fixture brief'} />
  </div></div>;
}
let deferredLoads = 0;
const DeferredFixture = deferredView('Fixture heavy view', async () => {
  deferredLoads++;
  if (deferredLoads === 1) throw new Error('Fixture deferred view unavailable');
  return { default: ({ label }: { label: string }) => <p className="graph-empty__hint" id="deferred-loaded">{label}</p> };
});
function RecoveryFixture(): React.ReactElement {
  const [label, setLabel] = useState('Loaded fixture');
  return <main className="page-root">
    <input id="deferred-draft" className="cmd-input" aria-label="Draft outside deferred view" defaultValue="Exact unsaved fixture draft" />
    <button className="kb-import-btn" onClick={() => { setLabel('Updated fixture'); }}>Change fixture props</button>
    <DeferredFixture label={label} />
  </main>;
}
createRoot(document.getElementById('root')!).render(
  <SignInGate><Theme theme="g100"><QueryClientProvider client={queryClient}><AthenaContextProvider>
    <AppDialogHost /><MemoryRouter initialEntries={[new URLSearchParams(window.location.search).has('chat-only') ? '/_chat-remount' : '/']}>
      <Probe /><Routes><Route path="/chat" element={<AIChatPage standalone />} />
      <Route path="/_chat-remount" element={null} />
      <Route path="/summary-fixture/:noteId" element={<SummaryFixture />} /><Route path="/" element={<AppShell />}>
      <Route index element={<Overview title="Today" />} />
      <Route path="discover" element={<Overview title="Discover" />} />
      <Route path="plan" element={<PlanPage />} />
      <Route path="projects" element={<ProjectsPage />} />
      <Route path="build" element={<BuildPage />} />
      <Route path="think" element={<NotesPage />} />
      <Route path="think/fixture-note" element={<MetadataFixture />} />
      <Route path="my-work" element={<TimelinePage excludeSources={['discovered-article', 'email']} />} />
      <Route path="library" element={<DocumentsPage />} />
      <Route path="memory" element={<MemoryPage />} />
      <Route path="graph" element={<GraphPage />} />
      <Route path="settings/repo-mappings" element={<RepoProjectMappingsPage />} />
      <Route path="_deferred-fixture" element={<RecoveryFixture />} />
    </Route></Routes></MemoryRouter>
  </AthenaContextProvider></QueryClientProvider></Theme></SignInGate>,
);

function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for navigation fixture at ${document.querySelector<HTMLElement>('#navigation-probe')?.dataset.path}; focus: ${document.activeElement?.outerHTML}; page: ${document.body.innerText}`);
}
function key(element: EventTarget, value: string, options: Pick<KeyboardEventInit, 'shiftKey'> = {}): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
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
  await waitFor(() => {
    const actual = selector('#navigation-probe').dataset.path;
    return actual === path || (path.includes('?') && actual === path.split('?')[0]);
  });
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

export async function runProjectPickerChecks(): Promise<string[]> {
  const originalProjects = api.getProjects;
  const cachedProjects = queryClient.getQueryData(['projects']);
  const planPreferences = localStorage.getItem(PLAN_PREFERENCES_KEY);
  const setValue = (field: HTMLInputElement | HTMLSelectElement, value: string): void => {
    const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const checkGroups = (field: HTMLSelectElement): void => {
    check(JSON.stringify([...field.querySelectorAll('optgroup')].map(group => group.label))
      === JSON.stringify(['IBM', 'Nelfin', 'Personal', 'Other']), `${field.id || field.getAttribute('aria-label')} uses project parent groups`);
    check(![...field.options].some(option => option.value === 'atom' || option.value === 'acre'),
      'Unselected archived and completed projects stay hidden');
  };
  try {
    await go('/');
    api.getProjects = async () => success(projectPickerProjects);
    queryClient.setQueryData(['projects'], projectPickerProjects);
    localStorage.setItem(PLAN_PREFERENCES_KEY, JSON.stringify({ version: 1, view: 'board', project: '', tag: '' }));
    await go('/plan');
    await waitFor(() => document.querySelector('#plan-filter-project optgroup') !== null);
    checkGroups(selector<HTMLSelectElement>('#plan-filter-project'));
    selector<HTMLButtonElement>('.kb-col__add').click();
    await waitFor(() => document.querySelector('.cds--modal.is-visible #t-project') !== null);
    const taskProject = selector<HTMLSelectElement>('.cds--modal.is-visible #t-project');
    checkGroups(taskProject);
    check(taskProject.value === 'personal', 'Task default keeps the original General project ID');
    setValue(taskProject, 'imagine');
    await waitFor(() => taskProject.value === 'imagine');
    selector<HTMLButtonElement>('.cds--modal.is-visible .cds--btn--secondary').click();

    await go('/chat');
    await waitFor(() => document.querySelector('select[aria-label="Conversation project"] optgroup') !== null);
    const conversation = selector<HTMLSelectElement>('select[aria-label="Conversation project"]');
    checkGroups(conversation);
    setValue(conversation, 'imagine');
    await waitFor(() => conversation.value === 'imagine');
    setValue(conversation, '');
    const files = new DataTransfer();
    files.items.add(new File(['Project picker fixture'], 'picker.txt', { type: 'text/plain' }));
    const fileInput = selector<HTMLInputElement>('.ai-file-input-hidden');
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('select[aria-label="Project for attached file"]') !== null);
    const attachment = selector<HTMLSelectElement>('select[aria-label="Project for attached file"]');
    checkGroups(attachment);
    setValue(attachment, 'blog-site');
    await waitFor(() => attachment.value === 'blog-site');
    selector<HTMLButtonElement>('.ai-pending-file__remove').click();

    await go('/library');
    await waitFor(() => document.querySelector('.docs-project-filter__select optgroup') !== null);
    checkGroups(selector<HTMLSelectElement>('.docs-project-filter__select'));
    await go('/memory');
    await waitFor(() => document.querySelector('.memory-page') !== null);
    [...document.querySelectorAll<HTMLButtonElement>('.memory-page button')]
      .find(button => button.textContent?.trim() === 'Add instruction')!.click();
    await waitFor(() => document.querySelector('.memory-add select[aria-label="Applies to"]') !== null);
    setValue(selector<HTMLSelectElement>('.memory-add select[aria-label="Applies to"]'), 'project');
    await waitFor(() => document.querySelector('.memory-add .memory-project-picker input') !== null);
    const memoryProject = selector<HTMLInputElement>('.memory-add .memory-project-picker input');
    setValue(memoryProject, 'IBM');
    memoryProject.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await waitFor(() => document.querySelector('.memory-add [role="option"]') !== null);
    const choices = [...document.querySelectorAll<HTMLElement>('.memory-add [role="option"]')];
    check(choices.some(choice => choice.textContent === 'IBM / IMAGINE'), 'Memory can search by parent and shows parent/project paths');
    check(!choices.some(choice => /ATOM|ACRE/.test(choice.textContent ?? '')), 'Memory hides unselected retired projects');
    choices.find(choice => choice.textContent === 'IBM / IMAGINE')!.click();
    await waitFor(() => memoryProject.value === 'IBM / IMAGINE');
    return ['Plan filters, task editor, Athena conversations/attachments and Sources share the project hierarchy',
      'Memory retains searchable parent/project paths and excludes unselected retired projects'];
  } finally {
    await go('/');
    api.getProjects = originalProjects;
    if (cachedProjects === undefined) queryClient.removeQueries({ queryKey: ['projects'] });
    else queryClient.setQueryData(['projects'], cachedProjects);
    if (planPreferences === null) localStorage.removeItem(PLAN_PREFERENCES_KEY);
    else localStorage.setItem(PLAN_PREFERENCES_KEY, planPreferences);
  }
}

export async function runNavigationChecks(): Promise<string[]> {
  const results: string[] = [];
  check(!AUTH_ENABLED, 'Navigation fixture must not enable production sign-in');
  const mobile = window.innerWidth <= 1100;
  await waitFor(() => document.querySelector('main h1')?.textContent === 'Today');
  check(selector<HTMLAnchorElement>('.kh-header__brand').getAttribute('href') === '/', 'Brand returns to Today');
  const primaryLabels = [...document.querySelectorAll('.kh-header__primary a')].map((item) =>
    [...item.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent?.trim()).join(''));
  check(JSON.stringify(primaryLabels) === JSON.stringify(mobile
    ? ['Today']
    : ['Today', 'Discover', 'Plan', 'Think', 'Build']), `Primary labels and order: ${JSON.stringify(primaryLabels)}`);
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
  await waitFor(() => document.querySelectorAll('.email-connections__account').length === 3);
  check(document.querySelector('.email-connections')?.textContent?.includes('Richard.i.Hogan@ibmalliance.onmicrosoft.com'), 'Verified Alliance address is listed');
  check(document.querySelectorAll('.email-connections__status').length === 3
    && [...document.querySelectorAll('.email-connections__status')].every((e) => e.textContent === 'Not connected'), 'Listed accounts do not falsely claim authorisation');
  const emailConnections = document.querySelector<HTMLElement>('.email-connections')!;
  check(emailConnections.scrollWidth <= emailConnections.clientWidth + 1, 'Email account cards fit narrow screens');
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
  api.getGraph = async () => ({ success: false, error: { code: 'FIXTURE_GRAPH', message: 'Fixture graph unavailable' } });
  await queryClient.invalidateQueries({ queryKey: ['graph'] });
  await waitFor(() => document.body.textContent?.includes('Graph data is unavailable') === true);
  check(document.body.textContent?.includes('NO CONNECTIONS YET') !== true, 'Failed graph envelope is not an empty graph');
  const graph = graphFixture;
  let graphDays = 0;
  api.getGraph = async (params) => { graphDays = params.days ?? 0; return success(graph); };
  selector<HTMLButtonElement>('.kh-data-notice button').click();
  await waitFor(() => document.querySelector('.graph-controls') !== null);
  [...document.querySelectorAll<HTMLButtonElement>('.graph-controls__chip')].find(control => control.textContent === 'Relationships')!.click();
  await waitFor(() => document.querySelector('.graph-relationships') !== null);
  check(document.querySelectorAll('.graph-relationships__row').length === 50, 'Graph relationship DOM is paginated');
  check(document.querySelector('.graph-relationships__coverage')?.textContent?.includes('truncated') === true,
    'Relationship list honestly reports indexing and truncated coverage');
  check(selector('.graph-relationships').scrollWidth <= selector('.graph-relationships').clientWidth,
    'Long relationship titles fit desktop and mobile without overflow');
  const graphNode = selector<HTMLButtonElement>('.graph-relationships__node');
  graphNode.focus();
  graphNode.click();
  await waitFor(() => document.activeElement === document.querySelector('.graph-detail-panel'));
  selector<HTMLButtonElement>('[aria-label="Close detail panel"]').click();
  await waitFor(() => document.activeElement === graphNode);
  selector<HTMLButtonElement>('.graph-relationships__pagination button:last-child').click();
  await waitFor(() => document.querySelector('.graph-relationships__pagination')?.textContent?.includes('Page 2') === true);
  check(selector('.graph-relationships__node').textContent !== graph.nodes[0]!.title, 'Next relationship page changes rows');
  if (document.querySelector('#graph-days-slider') === null) selector<HTMLButtonElement>('.graph-controls__chevron').click();
  await waitFor(() => document.querySelector('#graph-days-slider') !== null);
  const slider = selector<HTMLInputElement>('#graph-days-slider');
  slider.value = '31';
  slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  await waitFor(() => graphDays === 31);
  results.push('Graph failures offer Retry; bounded keyboard-accessible relationships show inference/truncation and preserve selection focus');
  await go('/library');
  await waitFor(() => document.querySelector('.page-title')?.textContent === 'Sources');
  check(selector('.kh-tools-location').textContent === 'Tools / Sources', 'Sources secondary label');
  await go('/library?contentItemId=00000000-0000-4000-8000-000000000002');
  await waitFor(() => document.querySelector('.docs-viewer__filename')?.textContent === 'README.md');
  await go('/library?contentItemId=00000000-0000-4000-8000-000000000099');
  await waitFor(() => document.querySelector('.docs-viewer__empty')?.textContent?.includes('no longer available') === true);
  await go('/library');
  results.push('Existing tag/mapping panels and direct Sources/Memory/Graph/settings routes preserved');

  const scheduledDate = localDateKey(new Date());
  const plannedTask: PlanTask = {
    id: 'fixture-native', title: 'Native task scheduled today', body: '', status: 'backlog', projectId: 'personal',
    tags: [], priority: 'normal', task_type: 'cert_review', dueDate: scheduledDate, startDate: null, endDate: null,
    externalUrl: null, linkedTagId: null, taxonomyTagIds: [], recurringCadence: null,
    archived: false, createdAt: '', updatedAt: '2020-01-01T00:00:00Z',
  };
  api.getTasks = async (params) => success(paginated(
    params?.projectId && params.projectId !== 'personal' ? [] : [
      plannedTask, { ...plannedTask, id: 'completed-native', title: 'Completed fixture must be hidden', status: 'completed' },
    ],
  ));
  await go('/plan');
  await waitFor(() => document.querySelector('.plan-view-toggle') !== null
    && document.body.textContent?.includes('Native task scheduled today') === true);
  check(![...document.querySelectorAll('.plan-view-toggle button')].some((button) => button.textContent?.trim() === 'Calendar'),
    'Plan no longer offers a Calendar view');
  check(selector('#plan-filter-project').getAttribute('aria-label') === 'Filter by project'
    || document.querySelector('label[for="plan-filter-project"]')?.textContent === 'Filter by project', 'Project filter is named');
  check(selector('.plan-root .kh-page-header__actions').scrollWidth <= selector('.plan-root .kh-page-header__actions').clientWidth + 1,
    `Plan controls fit narrow widths: ${JSON.stringify([...document.querySelectorAll<HTMLElement>('.plan-root .kh-page-header, .plan-root .kh-page-header__actions, .plan-root .kh-page-header__actions > *')].map((element) => ({
      class: element.className, width: element.clientWidth, scroll: element.scrollWidth,
      min: getComputedStyle(element).minWidth, flex: getComputedStyle(element).flex,
    })))}`);
  const focusButton = [...document.querySelectorAll<HTMLButtonElement>('.plan-view-toggle button')]
    .find((button) => button.textContent?.trim() === 'Focus')!;
  focusButton.click();
  await waitFor(() => focusButton.getAttribute('aria-pressed') === 'true');
  await waitFor(() => document.querySelector('.kb-focus__group--week')?.textContent?.includes('Native task scheduled today') === true);
  check(!selector('.kb-focus').textContent?.includes('Completed fixture must be hidden'), 'Completed native tasks are hidden');
  check(document.querySelector('#plan-filter-project') !== null && document.querySelector('#plan-filter-tag') !== null,
    'Project and tag scope stays available across Plan modes');
  results.push('Plan without Calendar, date-only native tasks, completed exclusion and responsive shared Plan scope');

  const sharedPlan = { version: 1, kind: 'plan', view: 'focus', project: 'unavailable-project', tag: 'unavailable-tag' };
  await go(`/plan?view=${encodeURIComponent(JSON.stringify(sharedPlan))}`);
  await waitFor(() => selector<HTMLSelectElement>('#plan-filter-project').value === 'unavailable-project'
    && selector<HTMLSelectElement>('#plan-filter-tag').value === 'unavailable-tag');
  check(selector('.plan-view-btn--active').textContent?.trim() === 'Focus',
    'Shared Plan view preserves exact mode and unavailable scopes');
  const savedViews = selector<HTMLDetailsElement>('.kh-saved-views');
  savedViews.open = true;
  const savedName = savedViews.querySelector<HTMLInputElement>('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(savedName, 'Project list scope');
  savedName.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  savedViews.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await waitFor(() => savedViews.textContent?.includes('View saved on this device.') === true);
  [...document.querySelectorAll<HTMLButtonElement>('.plan-view-toggle button')].find(button => button.textContent?.trim() === 'Board')!.click();
  await waitFor(() => document.querySelector('.plan-view-btn--active')?.textContent?.trim() === 'Board');
  const savedPicker = savedViews.querySelector<HTMLSelectElement>('select')!;
  savedPicker.value = ''; savedPicker.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  savedPicker.selectedIndex = savedPicker.options.length - 1;
  savedPicker.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => document.querySelector('.plan-view-btn--active')?.textContent?.trim() === 'Focus');
  check(selector<HTMLSelectElement>('#plan-filter-project').value === 'unavailable-project'
    && selector<HTMLSelectElement>('#plan-filter-tag').value === 'unavailable-tag', 'Named Plan view cannot widen scope across modes');
  await go('/plan?view=%7B');
  await waitFor(() => document.body.textContent?.includes('Shared view link is invalid; current filters were retained') === true);
  check(selector<HTMLSelectElement>('#plan-filter-project').value === 'unavailable-project', 'Malformed link retains current scope visibly');
  await go(`/plan?view=${encodeURIComponent(JSON.stringify({ ...sharedPlan, view: 'board', project: '', tag: '' }))}`);
  await waitFor(() => document.querySelector('.plan-view-btn--active')?.textContent?.trim() === 'Board'
    && selector<HTMLSelectElement>('#plan-filter-project').value === '');
  check(document.body.textContent?.includes('Shared view link is invalid') !== true, 'Valid shared link clears its previous error');
  results.push('Named and shared Plan views retain unavailable project/tag scopes, switch modes and reject malformed links visibly');

  const searchTrigger = selector<HTMLButtonElement>('[aria-label="Search"]');
  searchTrigger.focus();
  searchTrigger.click();
  await waitFor(() => document.querySelector('[aria-label="Command palette"]') !== null);
  const palette = selector('[aria-label="Command palette"]');
  check(palette.textContent?.includes('Tools / Context and records') === true && palette.textContent?.includes('Projects') === true, 'Palette mirrors groups');
  check(palette.textContent?.includes('Sources') === true && palette.textContent?.includes('Activity') === true, 'Palette supporting labels updated');
  check(palette instanceof HTMLDialogElement && palette.open, 'Palette uses the existing native dialog convention');
  if (window.matchMedia('(max-width: 600px)').matches) check(getComputedStyle(selector('.cmd-item')).display === 'grid',
    'Phone palette gives complete labels and subtitles their own rows');
  [...document.querySelectorAll<HTMLButtonElement>('.cmd-item')].at(-1)!.focus();
  key(document.activeElement!, 'Tab');
  check(document.activeElement === document.querySelector('.cmd-input'), 'Palette traps forward Tab');
  key(document.activeElement!, 'Tab', { shiftKey: true });
  check(document.activeElement === [...document.querySelectorAll('.cmd-item')].at(-1), 'Palette traps reverse Tab');
  key(selector('[aria-label="Command palette search"]'), 'Escape');
  await waitFor(() => document.querySelector('[aria-label="Command palette"]') === null);
  check(document.activeElement === searchTrigger, 'Palette restores the launching control focus');
  await go('/library');
  await go('/plan');
  await waitFor(() => document.querySelector('.plan-view-btn--active')?.textContent?.trim() === 'Board');
  check(JSON.parse(localStorage.getItem(PLAN_PREFERENCES_KEY)!).view === 'board', 'Plan preference survives a workspace round trip');
  await go('/_deferred-fixture');
  await waitFor(() => document.body.textContent?.includes('Fixture heavy view could not open') === true);
  check(document.querySelector('.kh-data-notice')?.textContent?.includes('Fixture deferred view unavailable') === true,
    'Deferred view failure displays the underlying error instead of replacing it with generic retry advice');
  const staleDoc = new DOMParser().parseFromString('<script type="module" src="/assets/index-OLD.js"></script>', 'text/html');
  check(newerBuildEntry(staleDoc, '<script type="module" src="/assets/index-NEW.js"></script>') === '/assets/index-NEW.js'
    && newerBuildEntry(staleDoc, '<script type="module" src="/assets/index-OLD.js"></script>') === null,
    'A failed view import detects when a newer frontend build has replaced the running one');
  const draftOutsideView = selector<HTMLInputElement>('#deferred-draft');
  const shellBeforeRetry = document.querySelector('.kh-header');
  selector<HTMLButtonElement>('.kh-data-notice button').click();
  await waitFor(() => document.querySelector('#deferred-loaded')?.textContent === 'Loaded fixture');
  check(deferredLoads === 2 && draftOutsideView.isConnected && draftOutsideView.value === 'Exact unsaved fixture draft'
    && document.querySelector('.kh-header') === shellBeforeRetry, 'Explicit view Retry reloads its failed loader without remounting the shell or other writing');
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(control => control.textContent === 'Change fixture props')!.click();
  await waitFor(() => document.querySelector('#deferred-loaded')?.textContent === 'Updated fixture');
  check(deferredLoads === 2, 'Normal prop updates never recreate the deferred loader');
  results.push('Deferred view Retry preserves the shell and outside drafts; Plan preferences and native palette focus survive workspace changes');
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

  const output = 'Deliver a complete architecture and operating model with detailed acceptance criteria. '.repeat(40).trim();
  api.getProjects = async () => success(Array.from({ length: 4 }, (_, i) => ({
    id: `layout-${i}`, name: i === 0 ? 'A long project name that must wrap without colliding with actions' : `Project ${i}`,
    description: 'Project description. '.repeat(40), goal: 'Deliver a sustainable project outcome. '.repeat(30),
    role: 'Architecture lead', ownership: 'Work team', lifecycleState: 'active' as const,
    startDate: '2026-10-01', targetEndDate: '2026-12-01', importance: 'normal' as const,
    expectedOutputs: [output, 'A second output'], colour: 'teal' as const, category: 'work' as const,
    priority: 'medium' as const, projectType: 'standard' as const, gitlabPaths: [],
    githubRepos: [], hasIcaDocumentCollection: false, icaDocumentCollectionName: '',
    icaDocumentCollectionId: '', links: [], tags: ['Architecture'], createdAt: '', updatedAt: '',
  })));
  await queryClient.invalidateQueries({ queryKey: ['projects'] });
  await go('/projects');
  await waitFor(() => document.querySelectorAll('.proj-card').length === 4);
  check(selector('.proj-page').classList.contains('page-root'), 'Projects uses shared primary page frame');
  const frameStyle = getComputedStyle(selector('.proj-page'));
  const sharedFrame = document.createElement('div');
  sharedFrame.className = 'page-root';
  document.body.append(sharedFrame);
  const sharedFrameStyle = getComputedStyle(sharedFrame);
  check(frameStyle.paddingLeft === sharedFrameStyle.paddingLeft && frameStyle.paddingRight === sharedFrameStyle.paddingRight
    && frameStyle.paddingTop === '16px', 'Projects keeps shared horizontal gutters and compact tool top spacing');
  sharedFrame.remove();
  check(document.querySelectorAll('h1').length === 1 && document.querySelectorAll('.proj-card h2').length === 4, 'Project heading hierarchy');
  check(selector('.dc-toolbar').getBoundingClientRect().top >= selector('.page-header').getBoundingClientRect().bottom, 'Filters are below shared header');
  check(selector('.proj-card-outputs li').textContent === output, 'Outputs preserve full text');
  check(selector('.proj-page').scrollWidth <= selector('.proj-page').clientWidth + 1, 'Long project content has no horizontal overflow ' + [...document.querySelectorAll('.proj-page *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 4).map((e) => `${e.tagName}.${String(e.className)}:${Math.round(e.getBoundingClientRect().right)}`)  .join(' | '));
    check(selector('.proj-feed') !== null, 'Project feed lays out');
  selector<HTMLButtonElement>('.proj-cockpit-btn').click();
  await waitFor(() => document.querySelector('.cds--modal.is-visible') !== null);
  key(document, 'Escape');
  await waitFor(() => document.querySelector('.cds--modal.is-visible') === null);
  selector<HTMLButtonElement>('.proj-icon-btn[title="Edit project"]').click();
  await waitFor(() => document.querySelector<HTMLInputElement>('#pm-name')?.value.includes('long project') === true);
  check(selector<HTMLTextAreaElement>('#pm-expected-outputs').value.includes(output), 'Edit retains complete output text');
  const modal = selector('#pm-name').closest('.cds--modal-content')!;
  check(modal.scrollWidth <= modal.clientWidth + 1,
    `Project editor has no horizontal overflow: ${modal.scrollWidth}px content in ${modal.clientWidth}px modal; ${[...modal.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => `${element.tagName}.${String(element.className)} ${element.scrollWidth}/${element.clientWidth}`)
      .join(', ')}`);
  key(document, 'Escape');
  await waitFor(() => document.querySelector('.cds--modal.is-visible') === null);
  const searchInput = selector<HTMLInputElement>('.dc-search__input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, 'no matching project');
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('.proj-empty') !== null);
  check(selector('.page-subtitle').textContent === '0 of 4 projects', 'Search count and empty state stay consistent');
  results.push('Projects shared frame, separate filters, readable long details, responsive cards and complete edit data');

  await go('/think');
  await waitFor(() => document.querySelector('.notes-page') !== null);
  for (const mode of ['Sparks', 'Canvas', 'Notes']) {
    const modeButton = [...document.querySelectorAll<HTMLButtonElement>('.plan-view-btn')].find((item) => item.textContent?.trim() === mode);
    check(modeButton !== undefined, `Existing Think ${mode} switch`);
    modeButton!.click();
    await waitFor(() => modeButton!.getAttribute('aria-selected') === 'true');
    if (mode === 'Canvas') {
      await waitFor(() => document.querySelectorAll('.notes-list-item').length === 2);
      const rows = [...document.querySelectorAll<HTMLElement>('.notes-list-item')];
      check(rows[0]!.textContent!.includes('Imagine Agentic Build & Run Model')
        && rows[1]!.textContent!.includes('Observability - detail'), 'Parent precedes recently edited detail diagram');
      check(rows[1]!.classList.contains('notes-list-item--nested')
        && parseFloat(getComputedStyle(rows[1]!).paddingLeft) > parseFloat(getComputedStyle(rows[0]!).paddingLeft),
      'Detail diagram is visually indented beneath its parent');
      check(rows[1]!.querySelector('.mm-list-parent')!.textContent!.includes('Observability'),
        'Detail row identifies its owning shape');
      check(rows[1]!.getAttribute('aria-label')!.includes('under Imagine Agentic Build & Run Model'),
        'Parent relationship is accessible');
      check(rows[1]!.scrollWidth <= rows[1]!.clientWidth, 'Nested row fits the narrow canvas list');
      const recycle = document.querySelector<HTMLButtonElement>('.notes-recycle-launch')!;
      check(recycle !== null && (mobile ? recycle.textContent?.trim() === 'Recycle bin' : true), 'Canvas recycle bin launcher is available');
    }
    if (mobile) {
      await openMenu();
      check(menuItem('Think').getAttribute('aria-current') === 'page', `Think selected in ${mode}`);
      key(document.activeElement!, 'Escape');
    } else check(selector('.kh-header__primary [aria-current="page"]').textContent?.trim() === 'Think', `Think selected in ${mode}`);
    const athenaLauncher = selector<HTMLButtonElement>('[aria-label="Open Athena"]');
    check(athenaLauncher.disabled === (mode !== 'Sparks'), `Toolbar Athena availability in ${mode}`);
    athenaLauncher.click();
    if (mode === 'Sparks') {
      await waitFor(() => document.querySelector('.think-athena-panel') !== null);
      check(document.querySelector('.ai-float-panel') === null, 'Think launcher opens embedded Athena without a popout');
    } else {
      check(document.querySelector('.ai-float-panel') === null, 'Disabled Think launcher cannot open a popout');
    }
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }));
  await waitFor(() => document.querySelector('[aria-label="New Spark"]') !== null);
  key(document, 'Escape');
  await waitFor(() => document.querySelector('[aria-label="New Spark"]') === null);
  results.push('Think selected in all modes, Athena opens only where embedded, and quick Spark shortcut preserved');

  if (window.innerWidth >= 1200) {
    await go('/think/fixture-note');
    await waitFor(() => document.querySelector('#think-side-tab-athena') !== null && document.querySelector('.ai-float-button') === null);
    selector<HTMLButtonElement>('#think-side-tab-metadata').click();
    selector<HTMLButtonElement>('[aria-label="Collapse side panel"], [aria-label="Close side panel"]').click();
    await waitFor(() => !selector<HTMLDialogElement>('.notes-meta-panel').open);
    const thinkAthenaLauncher = selector<HTMLButtonElement>('[aria-label="Open Athena"]');
    check(!thinkAthenaLauncher.disabled, 'Think toolbar can open embedded Athena for the selected note');
    thinkAthenaLauncher.click();
    await waitFor(() => selector<HTMLDialogElement>('.notes-meta-panel').open
      && selector('#think-side-tab-athena').getAttribute('aria-selected') === 'true');
    check(selector('#navigation-probe').dataset.context === 'Note context preserved', 'Metadata rail retains note context');
    check(document.querySelector('.ai-float-panel') === null, 'Header must not duplicate embedded conversation');
    await go('/library');
    await waitFor(() => document.querySelector('.docs-list-item') !== null);
    selector<HTMLButtonElement>('.docs-list-item').click();
    await waitFor(() => document.querySelector('#library-side-tab-athena') !== null && document.querySelector('.ai-float-button') === null);
    selector<HTMLButtonElement>('#library-side-tab-details').click();
    selector<HTMLButtonElement>('[aria-label="Collapse side panel"], [aria-label="Close side panel"]').click();
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
  results.push(...await runProjectPickerChecks());
  results.push(...await runDataReliabilityChecks(queryClient, go));
  results.push(...await runEmbeddedChatChecks());
  results.push(...await runChatChecks());
  return results;
}

async function runEmbeddedChatChecks(): Promise<string[]> {
  const previousLookup = api.getSessionIdForNote;
  const previousHistory = api.getSessionHistory;
  api.getSessionIdForNote = async () => success({ sessionId: 'embedded-thread-fixture' });
  api.getSessionHistory = async sessionId => sessionId === 'embedded-thread-fixture' ? success({
    sessionId, projectId: null, messages: [
      { role: 'user', content: 'Compare this saved specification with the existing implementation. '.repeat(5), timestamp: new Date().toISOString() },
      { role: 'assistant', content: '## Delivery scope\n\nUse verified sources and preserve existing behaviour.\n\n- Bounded implementation\n- Observable acceptance criteria', timestamp: new Date().toISOString() },
    ],
  }) : previousHistory(sessionId);
  await go('/think/fixture-note');
  await waitFor(() => document.querySelector('#think-side-tab-athena') !== null);
  selector<HTMLButtonElement>('[aria-label="Open Athena"]').click();
  await waitFor(() => document.querySelector('.think-athena-panel textarea') !== null);
  const narrow = selector<HTMLTextAreaElement>('.think-athena-panel textarea');
  narrow.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(narrow, '@spec');
  narrow.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('.people-mentions__item') !== null);
  const menu = selector('.people-mentions');
  const optionBounds = selector('.people-mentions__item').getBoundingClientRect();
  check(menu.contains(document.elementFromPoint(optionBounds.left + 20, optionBounds.top + 10)),
    'Mentions are visible above the Think drawer rather than clipped behind it');
  selector<HTMLButtonElement>('.people-mentions__item').click();
  await waitFor(() => narrow.value.includes('@[Feature specification](/think?noteId='));
  const surface = selector('.think-athena-panel .ai-conversation');
  await waitFor(() => document.querySelector('.think-athena-panel .ai-bubble--ai') !== null);
  check(getComputedStyle(selector('.think-athena-panel .ai-bubble-text--md')).fontSize === '15px',
    'Narrow replies use the shared standalone typography');
  check(getComputedStyle(selector('.think-athena-panel .ai-bubble--ai')).borderLeftWidth === '0px',
    'Narrow replies retain plain prose rather than a separate striped card design');
  const composerBounds = selector('.think-athena-panel .ai-composer').getBoundingClientRect();
  check(composerBounds.bottom <= surface.getBoundingClientRect().bottom + 1, 'Long restored history keeps the composer visible');
  check(surface.scrollWidth <= surface.clientWidth + 1, `Shared narrow conversation has no horizontal overflow: ${JSON.stringify(
    [surface, ...surface.querySelectorAll<HTMLElement>('*')].filter(element => element.scrollWidth > surface.clientWidth + 1)
      .map(element => ({ class: element.className, width: element.clientWidth, scroll: element.scrollWidth, minWidth: getComputedStyle(element).minWidth, gutter: getComputedStyle(element).getPropertyValue('--ai-gutter') })),
  )}`);
  check(document.querySelector('.think-athena-panel [aria-label="Action for this message"] option[value="spec"]') !== null,
    'Spec is available in the Think panel as well as standalone');
  const toolbar = selector('.think-athena-panel .ai-new-chat-row--compact');
  const actions = selector('.think-athena-panel .ai-new-chat-row__actions');
  const previousWidth = toolbar.style.width;
  for (const width of [280, 400]) {
    toolbar.style.width = `${width}px`;
    const style = getComputedStyle(toolbar);
    const edge = toolbar.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    check(Math.abs(actions.getBoundingClientRect().right - edge) < 1,
      `Embedded chat actions align to the right at ${width}px`);
    check(toolbar.scrollWidth <= toolbar.clientWidth + 1, 'Embedded chat actions remain inside the toolbar');
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>('button')];
    check(buttons.length >= 3, 'Populated conversation exercises Save to Think, restart and sound controls');
    for (let index = 1; index < buttons.length; index++) {
      check(buttons[index]!.getBoundingClientRect().left >= buttons[index - 1]!.getBoundingClientRect().left,
        'Visual button order follows DOM and keyboard order');
    }
  }
  toolbar.style.width = previousWidth;
  api.getSessionIdForNote = previousLookup;
  api.getSessionHistory = previousHistory;
  return ['Think uses the shared composer and Spec action; saved-note mentions remain visible above its drawer',
    'Embedded Save to Think, restart and sound controls align right at narrow and wide panel widths without reordering'];
}

async function runChatChecks(): Promise<string[]> {
  const results: string[] = [];
  let releaseBriefing = (): void => undefined;
  const delayedBriefing = new Promise<void>((resolve) => { releaseBriefing = resolve; });
  api.getMorningBriefing = async () => {
    await delayedBriefing;
    return success({ date: '2099-01-01', sessionId: 'late-briefing', markdown: 'A late briefing', generatedAt: '' });
  };
  await go('/chat');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('#ai-chat-input')?.disabled === false);
  const recoveryText = 'Do not lose this draft during login: full project question.\nSecond line.';
  const editDraft = (text: string): void => {
    const input = selector<HTMLTextAreaElement>('#ai-chat-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const input = selector<HTMLTextAreaElement>('#ai-chat-input');
  input.focus();
  editDraft('@spec');
  await waitFor(() => document.querySelector('.people-mentions__item')?.textContent?.includes('Feature specification') === true);
  const menu = selector('.people-mentions');
  const bounds = menu.getBoundingClientRect();
  check(bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight,
    'Mention picker stays within viewport');
  const firstOption = selector('.people-mentions__item').getBoundingClientRect();
  check(menu.contains(document.elementFromPoint(firstOption.left + 20, firstOption.top + 10)), 'Mention picker is not clipped or covered');
  key(input, 'ArrowDown');
  await waitFor(() => document.querySelector('.people-mentions__item[aria-selected="true"]')?.textContent?.includes('Architecture source') === true);
  key(input, 'Enter');
  await waitFor(() => input.value.includes('@[Architecture source](/library?contentItemId='));
  check(document.querySelector('.people-mentions') === null, 'Keyboard choice closes the document picker without sending');
  editDraft('/spec Implement this feature');
  await waitFor(() => selector<HTMLSelectElement>('[aria-label="Action for this message"]').value === 'spec');
  check(selector('.ai-conversation') !== null, 'Standalone uses the shared conversation surface');
  editDraft('@rich');
  await waitFor(() => document.querySelector('.people-mentions__item') !== null);
  key(input, 'Escape');
  await waitFor(() => document.querySelector('.people-mentions') === null);
  results.push('Document, note and person mentions share a visible keyboard picker; /spec selects the agent-ready action');
  editDraft(recoveryText);
  await waitFor(() => selector<HTMLTextAreaElement>('#ai-chat-input').value === recoveryText);
  releaseBriefing();
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  check(window.localStorage.getItem('kh-athena-session-id-standalone') !== 'late-briefing', 'Late morning briefing cannot replace a draft or restored conversation');
  api.getMorningBriefing = async () => success(null);
  await go('/_chat-remount');
  await go('/chat');
  await waitFor(() => selector<HTMLTextAreaElement>('#ai-chat-input').value === recoveryText);
  let attemptedSession = '';
  api.startChatTurn = async (request) => {
    attemptedSession = request.sessionId ?? '';
    check(attemptedSession !== '', 'New conversation ID exists before authentication/network');
    check(window.localStorage.getItem('kh-athena-session-id-standalone') === attemptedSession, 'Conversation ID persisted before send');
    throw new Error('Simulated failed send');
  };
  selector<HTMLFormElement>('.ai-input-row').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => attemptedSession !== '' && !selector<HTMLTextAreaElement>('#ai-chat-input').disabled);
  check(selector<HTMLTextAreaElement>('#ai-chat-input').value === recoveryText, 'Rejected pre-auth send retains full draft');
  check(window.sessionStorage.getItem(`kh-athena-session-id-standalone-draft-${attemptedSession}`) === recoveryText, 'Draft follows the new conversation ID durably');
  await go('/_chat-remount');
  await go('/chat');
  await waitFor(() => selector<HTMLTextAreaElement>('#ai-chat-input').value === recoveryText && !selector<HTMLTextAreaElement>('#ai-chat-input').disabled);
  check(window.localStorage.getItem('kh-athena-session-id-standalone') === attemptedSession, 'Remount restores same conversation');
  results.push('Failed send keeps chat mounted; draft and new session survive rejected send and remount without auto-resending');
  return results;
}

async function runChatResetChecks(): Promise<string[]> {
  check(!AUTH_ENABLED, 'Reset regression requires fixture-only authentication settings');
  const originalFetch = window.fetch;
  const originalStart = api.startChatTurn;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sessionId = '';
  let unfoldCount = 0;
  const encoder = new TextEncoder();
  const tick = (): Promise<void> => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => { resolve(); })));
  const send = async (event: ChatTurnEvent): Promise<void> => {
    if (stream === undefined) throw new Error('Fixture stream not connected');
    stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    await tick();
  };
  const onAnimation = (event: AnimationEvent): void => {
    if (event.animationName === 'ai-answer-width') unfoldCount++;
  };
  document.addEventListener('animationstart', onAnimation);
  window.fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/api/ai/chat/turns/reset-fixture/events')) throw new Error(`Unexpected fixture fetch: ${url}`);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  api.startChatTurn = async request => {
    sessionId = request.sessionId!;
    return success({ turnId: 'reset-fixture', sessionId });
  };
  try {
    await go('/_chat-remount');
    await go('/chat');
    await waitFor(() => document.querySelector<HTMLTextAreaElement>('#ai-chat-input')?.disabled === false);
    const submit = async (): Promise<void> => {
      stream = undefined;
      const input = selector<HTMLTextAreaElement>('#ai-chat-input');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Fixture question about references');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      selector<HTMLFormElement>('.ai-input-row').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => stream !== undefined && document.querySelector('.ai-presence-think-anchor') !== null);
    };
    await submit();
    await send({ type: 'snapshot', message: 'Fixture question', activity: 'Reading sources', text: 'Provisional reconnected draft' });
    const thinker = selector('.ai-presence-think-anchor');
    for (let round = 1; round <= 3; round++) {
      await send({ type: 'delta', text: `Provisional answer ${round}` });
      check(!selector('.ai-messages').textContent?.includes('Provisional'), 'Provisional output must never mount as an answer');
      await send({ type: 'reset' });
      await send({ type: 'activity', text: `Checking references ${round}` });
      check(selector('.ai-presence-think-anchor') === thinker, 'Reset must not replace the pending reply');
      check(selector('.ai-live-activity').textContent?.includes(`Checking references ${round}`) === true, 'Progress remains visible');
      check(document.querySelector('.ai-answer-arrival') === null, 'Reset must not start answer choreography');
    }
    await send({ type: 'done', data: {
      sessionId, reply: 'Accepted final fixture answer.', assistantMessageId: 'accepted-fixture-answer', pendingActions: [],
    } });
    stream!.close();
    stream = undefined;
    await waitFor(() => document.querySelector('.ai-answer-arrival')?.textContent?.includes('Accepted final fixture answer.') === true);
    await new Promise(resolve => window.setTimeout(resolve, 2400));
    check(unfoldCount === 1, 'Exactly one answer unfold is allowed per successful turn');
    check(document.querySelector('.ai-presence-think-anchor') === null, 'Accepted answer cannot return to thinking');
    check(document.querySelectorAll('.ai-answer-arrival').length === 1, 'Only one final answer is rendered');
    for (const stopped of [true, false]) {
      await submit();
      await send({ type: 'delta', text: 'Provisional failed draft' });
      await send({ type: 'error', message: 'Fixture failure', stopped });
      stream!.close();
      stream = undefined;
      await waitFor(() => !selector<HTMLTextAreaElement>('#ai-chat-input').disabled);
      check(document.querySelector('.ai-answer-arrival') === null, 'Stopped or failed turns must not animate an answer');
      check(!selector('.ai-messages').textContent?.includes('Provisional'), 'Failed draft must not leak into history');
    }
    return ['Three draft/reset/tool rounds and a populated reconnect snapshot keep one stable working view',
      'Only the successful final result reveals once; stopped/failed drafts never appear'];
  } finally {
    stream?.close();
    document.removeEventListener('animationstart', onAnimation);
    window.fetch = originalFetch;
    api.startChatTurn = originalStart;
    await go('/_chat-remount');
  }
}

async function verifyChatReload(expected: { sessionId: string; draft: string }): Promise<string> {
  let starts = 0;
  api.startChatTurn = async () => {
    starts++;
    throw new Error('Reload must not automatically resend a draft.');
  };
  await go('/chat');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('#ai-chat-input')?.disabled === false);
  check(window.localStorage.getItem('kh-athena-session-id-standalone') === expected.sessionId, 'Actual reload restores the same session ID');
  check(selector<HTMLTextAreaElement>('#ai-chat-input').value === expected.draft, 'Actual reload restores the complete draft');
  check(starts === 0, 'Actual reload does not resend or duplicate the prompt');
  await go('/_chat-remount');
  api.getSessionHistory = async () => ({ success: false, error: { code: 'FIXTURE_AUTH', message: 'Sign-in required' } });
  await go('/chat');
  await waitFor(() => document.querySelector('.ai-history-error') !== null);
  check(selector<HTMLTextAreaElement>('#ai-chat-input').value === expected.draft, 'History failure cannot discard the draft');
  check(document.querySelector('.ai-starters') === null, 'Failed restoration is not presented as a new empty chat');
  api.getSessionHistory = async (sessionId) => success({
    sessionId, projectId: null,
    messages: [{ role: 'user', content: 'Previously saved conversation with @[Architecture source](/library?contentItemId=00000000-0000-4000-8000-000000000002)', timestamp: new Date().toISOString() }],
  });
  selector<HTMLButtonElement>('.ai-history-error button').click();
  await waitFor(() => document.querySelector('.ai-history-error') === null && document.body.textContent?.includes('Previously saved conversation') === true);
  check(document.querySelector('.ai-bubble a[href="/library?contentItemId=00000000-0000-4000-8000-000000000002"]') !== null,
    'Restored document mentions remain readable internal links');
  check(selector<HTMLTextAreaElement>('#ai-chat-input').value === expected.draft, 'Retry restores server conversation without changing the draft');
  // Acceptance, not clicking Send, is the point at which a draft can be cleared.
  api.startChatTurn = async (request) => success({ turnId: 'accepted-fixture-turn', sessionId: request.sessionId! });
  api.cancelChatTurn = async () => undefined;
  selector<HTMLFormElement>('.ai-input-row').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => selector<HTMLTextAreaElement>('#ai-chat-input').value === '');
  check(window.sessionStorage.getItem(`kh-athena-session-id-standalone-draft-${expected.sessionId}`) === null, 'Accepted turn clears the stored draft');
  return 'Actual reload preserves draft/session; failed history load is visible and retry restores messages; only server acceptance clears draft';
}

async function showGraphReview(): Promise<void> {
  api.getGraph = async () => success(graphFixture);
  await queryClient.invalidateQueries({ queryKey: ['graph'] });
  await go('/graph');
  await waitFor(() => document.querySelector('.graph-controls') !== null);
  [...document.querySelectorAll<HTMLButtonElement>('.graph-controls__chip')].find(control => control.textContent === 'Relationships')!.click();
  await waitFor(() => document.querySelector('.graph-relationships') !== null);
}
Object.assign(window, { runNavigationChecks, runChatChecks, runChatResetChecks, runProjectPickerChecks, verifyChatReload, showGraphReview });
