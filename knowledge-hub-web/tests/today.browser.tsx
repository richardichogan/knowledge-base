import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiResponse } from '../src/types/apiResponse';
import type { TodayTask } from '../src/services/todayViewModel';
import { workDate } from '../src/services/todayViewModel';
import { api } from '../src/services/api';
import { AthenaContextProvider, useAthenaContext } from '../src/context/AthenaContext';
import { HomePage } from '../src/pages/HomePage';
import { FloatingAIChat } from '../src/components/FloatingAIChat';
import { DiscoverPage } from '../src/pages/DiscoverPage';
import { NotesPage } from '../src/notes/NotesPage';
import '../src/styles/global.scss';

// Explicit development fixture. No production entry point imports this module.
const now = new Date();
const since = new Date(now.getTime() - 60 * 60_000).toISOString();
const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const paginated = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: items.length, hasMore: false });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const comparisonPage = new URLSearchParams(window.location.search).get('compare');
let taskReads = 0;
let tasks: TodayTask[] = Array.from({ length: 8 }, (_, i) => ({
  id: `task-${i}`, title: i === 0 ? 'Review the architecture proposal' : `Review test commitment ${i}`,
  body: '', status: 'todo', priority: 'high', projectId: 'personal',
  dueDate: workDate(new Date(now.getTime() - (i + 1) * 86_400_000)), updatedAt: since, archived: false,
}));

api.getTasks = async () => { taskReads++; return success(paginated(tasks)); };
api.updateTask = async (id, patch) => {
  tasks = tasks.map((task) => task.id === id ? { ...task, ...patch } : task);
  return success(tasks.find((task) => task.id === id));
};
api.getProjects = async () => success([]);
api.getTimeline = async (query) => {
  if (!comparisonPage) check(typeof query?.since === 'string', 'Today requests source-update activity within its change window');
  return success(paginated(Array.from({ length: 5 }, (_, i) => ({
  id: `activity-${i}`, source: (['github-commit', 'github-pr', 'gitlab-mr', 'graph-calendar', 'email'] as const)[i % 5] ?? 'github-commit', sourceId: String(i),
  title: 'A repository update', summary: '', publishedAt: now.toISOString(),
  projectContext: (['personal', 'structara-ai', 'ibm-thought-leadership'] as const)[i % 3] ?? 'personal',
}))));
};
api.getSources = async () => success([]);
api.getDiscoverFeed = async () => success(paginated([]));
api.listSparkClusters = async () => success([]);
api.listCanvases = async () => success([]);
api.listChatSessions = async () => success({ sessions: [] });
api.getMorningBriefing = async () => { throw new Error('Today must not request the full briefing'); };
api.listModelChoices = async () => success([]);
api.getNoteSummaries = async () => success(paginated(Array.from({ length: 6 }, (_, i) => ({
  id: `note-${i}`, title: i === 0 ? 'APAC seller presentation' : `A recent writing project ${i}`,
  contentType: 'note', preview: 'Opening structure and talking points are saved for the next writing session.',
  createdAt: since, updatedAt: now.toISOString(), taxonomyTagIds: [], projectId: 'personal',
}))));

function Probe(): React.ReactElement {
  const { request, pageContext } = useAthenaContext();
  return <output id="athena-probe" hidden data-prompt={request?.prompt ?? ''}
    data-sequence={request?.sequence ?? 0} data-project={pageContext?.projectId ?? ''}
    data-context={pageContext?.detail ?? ''} />;
}
function Fixture(): React.ReactElement {
  const { pageContext, launchAthena } = useAthenaContext();
  return <><div className="kh-content" style={{ height: '100%' }}>
    {comparisonPage === 'discover' ? <DiscoverPage /> : comparisonPage === 'think' ? <NotesPage /> : <HomePage />}
    <Probe /></div>
    {!comparisonPage && <><button type="button" aria-label="Open Athena" onClick={launchAthena}>Athena</button>
      <FloatingAIChat pageContext={pageContext ?? undefined} /></>}</>;
}
if (comparisonPage === 'discover') api.getDiscoverFeed = async () => success(paginated([{
  id: 'style-reference', sourceId: 'test-feed', title: 'Reference article for style comparison',
  url: 'https://example.com', description: 'A test-only article body to compare the existing Discover typography.',
  publishedAt: since, indexedAt: since, sourceTitle: 'Test feed', workflowState: 'to-review',
  relevanceScore: null, relevanceExplanation: 'A test-only relevance explanation for the existing Discover typography.', publishedUrl: null, taxonomyTagIds: [],
  articleType: null, platform: null, sourceType: null, spark: false, sparkReason: null, compositeScore: null,
}]));
if (comparisonPage === 'think') {
  api.getNote = async () => ({ success: false, error: { code: 'NOT_FOUND', message: 'Style fixture has no note body' } });
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>
      <AthenaContextProvider><Fixture /></AthenaContextProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for fixture state');
};
function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string) => {
  const found = buttons().find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};

export async function runTodayChecks(): Promise<string[]> {
  const results: string[] = [];
  await waitFor(() => document.querySelectorAll('.today-brief__attention article').length === 5);
  check(document.querySelectorAll('.today-brief__continue article').length === 4, 'Continuation cap');
  check(document.querySelector('.today-brief .page-subtitle')!.textContent!.includes('5 things need'), 'Greeting count');
  check(document.querySelectorAll('h1').length === 1 && document.querySelectorAll('h2').length === 4, 'Heading hierarchy');
  check(document.querySelector('.today-brief__prompt') === null && document.querySelector('.today-brief__suggestions') === null, 'Redundant Today launcher and prompts removed');
  check(document.querySelector('.ai-float-button') === null, 'No floating Athena control');
  check(document.querySelector('.today-brief__capture') === null && document.querySelector('#today-capture') === null, 'Redundant Spark capture removed');
  check(document.querySelector('.today-brief__full-briefing') === null, 'Full briefing removed');
  check(!buttons().some((b) => /(?:Generate|Regenerate) briefing|Open briefing chat/.test(b.textContent ?? '')), 'Briefing controls removed');
  results.push('Initial caps, greeting, heading hierarchy, no redundant Athena launcher or briefing');

  const attention = document.querySelector<HTMLElement>('.today-brief__attention')!;
  const continuing = document.querySelector<HTMLElement>('.today-brief__continue')!;
  const changes = document.querySelector<HTMLElement>('.today-brief__changes')!;
  const exploring = document.querySelector<HTMLElement>('.today-brief__explore')!;
  if (window.innerWidth > 800) {
    const gap = parseFloat(getComputedStyle(continuing.parentElement!).gap);
    check(Math.abs(exploring.getBoundingClientRect().top - continuing.getBoundingClientRect().bottom - gap) <= 1, 'Right sections must stack without shared-row whitespace');
    check(Math.abs(changes.getBoundingClientRect().top - attention.getBoundingClientRect().bottom - gap) <= 1, 'Left sections must stack independently');
    check(exploring.getBoundingClientRect().top < attention.getBoundingClientRect().bottom, 'Exploration must not wait for the taller attention section');
  } else {
    check(attention.getBoundingClientRect().bottom <= continuing.getBoundingClientRect().top, 'Mobile attention before continuation');
    check(continuing.getBoundingClientRect().bottom <= changes.getBoundingClientRect().top, 'Mobile continuation before changes');
    check(changes.getBoundingClientRect().bottom <= exploring.getBoundingClientRect().top, 'Mobile changes before exploration');
  }
  results.push('No redundant capture; independent desktop stacks and preserved mobile section order');

  document.querySelector<HTMLButtonElement>('[aria-label="Open Athena"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel textarea') !== null);
  await waitFor(() => document.activeElement === document.querySelector('.ai-float-panel textarea'));
  check(document.activeElement === document.querySelector('.ai-float-panel textarea'), 'Athena composer receives focus');
  check(document.querySelector('#athena-probe')!.getAttribute('data-context')!.includes('attention'), 'Today context handoff');
  document.querySelector<HTMLButtonElement>('.today-brief__attention button[aria-label^="Ask Athena"]')!.click();
  await waitFor(() => document.querySelector('#athena-probe')!.getAttribute('data-project') === 'personal');
  check(document.querySelector('#athena-probe')!.getAttribute('data-context')!.includes('Today item'), 'Item-scoped context');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('.ai-float-panel textarea')?.value === 'Help me work out the next step for this item.');
  document.querySelector<HTMLButtonElement>('[aria-label="Close AI Chat"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel') === null);
  document.querySelector<HTMLButtonElement>('[aria-label="Open Athena"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel textarea') !== null);
  check(document.querySelector<HTMLTextAreaElement>('.ai-float-panel textarea')!.value === '', 'A consumed prompt must not replay on reopen');
  document.querySelector<HTMLButtonElement>('[aria-label="Close AI Chat"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel') === null);
  results.push('Existing popout opens, focuses, accepts prompts and closes; item project/context handoff');

  check(document.querySelectorAll('.today-brief__change-list li').length === 3, 'Initial changes cap');
  const expandChanges = buttons().find((b) => /^Show \d+ more summaries$/.test(b.textContent?.trim() ?? ''));
  check(expandChanges !== undefined, 'Changes expansion is available');
  expandChanges!.click();
  await waitFor(() => document.querySelectorAll('.today-brief__change-list li').length === 19);
  check(document.querySelector('.today-brief__changes')!.textContent!.includes('Updated note: APAC seller presentation'), 'Think edits appear in changes');
  button('Show less').click();
  await waitFor(() => document.querySelectorAll('.today-brief__change-list li').length === 3);
  results.push('Change summaries expand and collapse');

  const completedTitle = document.querySelector('.today-brief__attention h3')!.textContent;
  const more = document.querySelector<HTMLElement>('.today-brief__attention summary')!;
  more.click();
  check(more.parentElement!.hasAttribute('open'), 'Keyboard-native disclosure opens');
  button('Mark done').click();
  await waitFor(() => tasks.filter((task) => task.status === 'completed').length === 1);
  await waitFor(() => document.querySelectorAll('.today-brief__attention article').length === 5);
  await waitFor(() => ![...document.querySelectorAll('.today-brief__attention h3')].some((h) => h.textContent === completedTitle));
  results.push('Native secondary-action disclosure and task completion with query invalidation');

  const reads = taskReads;
  button('Refresh').click();
  await waitFor(() => taskReads > reads && !button('Refresh').disabled);
  results.push('Refresh refetches the underlying source');

  await waitFor(() => queryClient.isFetching() === 0 && queryClient.isMutating() === 0);
  const recoveredTasks = tasks;
  const recoveredNotes = api.getNoteSummaries;
  tasks = [];
  api.getNoteSummaries = async () => success(paginated([]));
  api.getTimeline = async () => success(paginated([]));
  await queryClient.invalidateQueries({ queryKey: ['today'] });
  await waitFor(() => document.querySelector('.today-brief__attention')!.textContent!.includes('No deadlines'));
  check(document.querySelector('.today-brief__continue')!.textContent!.includes('No recent drafts'), 'Continuation empty state');
  check(document.querySelector('.today-brief__changes')!.textContent!.includes('No changes found'), 'Changes empty state');
  results.push('Attention, continuation, activity and exploration empty states');

  api.getTasks = async () => { throw new Error('Fixture Plan unavailable'); };
  await queryClient.invalidateQueries({ queryKey: ['today', 'tasks'] });
  await waitFor(() => document.querySelector('.today-brief__attention [role="alert"]') !== null);
  check(document.querySelector('.today-brief__attention')!.textContent!.includes('available sources'), 'Partial-data wording');
  check(document.querySelectorAll('section').length === 4, 'Other sections survive');
  results.push('Local failure, retry control and honest partial-data state');

  let finish: ((data: ApiResponse<unknown>) => void) | undefined;
  api.getTasks = () => new Promise((resolve) => { finish = resolve; });
  void queryClient.resetQueries({ queryKey: ['today', 'tasks'] });
  await waitFor(() => document.querySelector('.today-brief__attention [role="status"]') !== null);
  check(document.querySelector('.today-brief__attention [aria-label="Loading section"]') !== null, 'Stable loading skeleton');
  finish?.(success(paginated(recoveredTasks)));
  await waitFor(() => document.querySelectorAll('.today-brief__attention article').length === 5);
  results.push('Accessible loading state and recovery');

  api.getNoteSummaries = recoveredNotes;
  await queryClient.invalidateQueries({ queryKey: ['today', 'notes'] });
  await waitFor(() => document.querySelector('.today-brief__changes')!.textContent!.includes('Updated note'));
  window.localStorage.setItem('kh-today-last-visit', new Date().toISOString());
  results.push('Recently edited notes remain visible independently of synced timeline activity');

  const region = document.querySelector<HTMLElement>('.today-brief')!;
  check(region.scrollWidth <= region.clientWidth + 1, 'Today has horizontal overflow');
  const columns = getComputedStyle(document.querySelector('.today-brief__grid')!).gridTemplateColumns.split(' ').length;
  check(columns === (window.innerWidth <= 800 ? 1 : 2), 'Responsive column count');
  results.push(`Responsive layout and no horizontal overflow at ${window.innerWidth}px`);
  return results;
}

Object.assign(window, { runTodayChecks });
Object.assign(window, { runThinkSearchChecks: async () => {
  await waitFor(() => document.querySelectorAll('.notes-list-item').length === 6);
  const input = document.querySelector<HTMLInputElement>('#notes-search')!;
  check(document.querySelector('.notes-list-search__clear') === null, 'Empty search has no clear button');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, 'APAC');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelectorAll('.notes-list-item').length === 1);
  const clear = document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!;
  const inputBounds = input.getBoundingClientRect();
  const clearBounds = clear.getBoundingClientRect();
  check(clearBounds.right <= inputBounds.right + 1 && clearBounds.left >= inputBounds.left, 'Clear icon sits inside search box');
  clear.focus();
  clear.click();
  await waitFor(() => document.querySelectorAll('.notes-list-item').length === 6);
  check(input.value === '', 'Clear empties the query');
  check(document.activeElement === input, 'Clear returns focus to search');
  check(document.querySelector('.notes-list-search__clear') === null, 'Clear icon disappears for empty query');
  const previousRead = api.getNoteSummaries;
  const refresh = () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh notes"]')!;
  setter.call(input, 'APAC');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelectorAll('.notes-list-item').length === 1);
  let reads = 0;
  let release: (() => void) | undefined;
  api.getNoteSummaries = async () => {
    reads++;
    await new Promise<void>(resolve => { release = resolve; });
    const result = await previousRead();
    if (!result.success) return result;
    return success({ ...result.data, items: [...result.data.items, {
      ...result.data.items[0]!, id: 'new-note', title: 'APAC newly transferred note',
    }] });
  };
  const selected = document.querySelector('.notes-list-item--active')?.getAttribute('class');
  refresh().click();
  await waitFor(() => release !== undefined && refresh().disabled);
  refresh().click();
  check(reads === 1, 'Repeated refresh is blocked while loading');
  release!();
  await waitFor(() => document.querySelectorAll('.notes-list-item').length === 2 && !refresh().disabled);
  check(input.value === 'APAC', 'Refresh preserves search');
  check(document.querySelector('.notes-list-item--active')?.getAttribute('class') === selected, 'Refresh preserves selected note');
  check(document.querySelector('.notes-refresh-message') === null, 'Successful refresh has no label or banner');
  api.getNoteSummaries = async () => ({ success: false, error: { code: 'TEST', message: 'Refresh unavailable' } });
  refresh().click();
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('Could not refresh notes') === true && !refresh().disabled);
  check(document.querySelectorAll('.notes-list-item').length === 2, 'Failed refresh retains existing list');
  document.querySelector<HTMLButtonElement>('[aria-label="Collapse list"]')!.click();
  await waitFor(() => document.querySelector('.notes-list-rail') !== null);
  check(refresh() !== null, 'Refresh remains available in collapsed rail');
  api.getNoteSummaries = previousRead;
  refresh().click();
  await waitFor(() => !refresh().disabled && document.querySelector('.notes-refresh-message') === null);
  document.querySelector<HTMLButtonElement>('[aria-label="Expand note list"]')!.click();
  await waitFor(() => document.querySelector('#notes-search') !== null);
  return ['Search/clear, newly transferred notes, retained search/selection, duplicate refresh blocking, visible failure/retry and collapsed refresh'];
} });
Object.assign(window, { readPageStyle: () => {
  const title = document.querySelector<HTMLElement>('.page-title');
  const header = document.querySelector<HTMLElement>('.page-header');
  if (!title || !header) return null;
  const style = getComputedStyle(title);
  const headerStyle = getComputedStyle(header);
  return {
    left: title.getBoundingClientRect().left, top: title.getBoundingClientRect().top,
    rightGutter: document.querySelector('.kh-content')!.clientWidth - header.getBoundingClientRect().right,
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color,
    headerPadding: headerStyle.paddingBottom,
    headerBorder: headerStyle.borderBottom,
  };
} });
Object.assign(window, { readTypography: (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const style = getComputedStyle(element);
  return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
} });
