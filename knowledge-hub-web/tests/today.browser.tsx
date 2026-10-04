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
import '../src/styles/global.scss';

// Explicit development fixture. No production entry point imports this module.
const now = new Date();
const since = new Date(now.getTime() - 60 * 60_000).toISOString();
const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const paginated = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: items.length, hasMore: false });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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
api.getTimeline = async () => success(paginated(Array.from({ length: 5 }, (_, i) => ({
  id: `activity-${i}`, source: (['github-commit', 'github-pr', 'gitlab-mr', 'graph-calendar', 'email'] as const)[i % 5] ?? 'github-commit', sourceId: String(i),
  title: 'A repository update', summary: '', publishedAt: now.toISOString(),
  projectContext: (['personal', 'structara-ai', 'ibm-thought-leadership'] as const)[i % 3] ?? 'personal',
}))));
api.getSources = async () => success([]);
api.getDiscoverFeed = async () => success(paginated([]));
api.listSparkClusters = async () => success([]);
api.listCanvases = async () => success([]);
api.listChatSessions = async () => success({ sessions: [] });
api.getMorningBriefing = async () => success(null);
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
  const { pageContext } = useAthenaContext();
  return <><div className="kh-content" style={{ height: '100%' }}><HomePage /><Probe /></div>
    <FloatingAIChat pageContext={pageContext ?? undefined} /></>;
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
  check(document.querySelector('.today-brief__greeting')!.textContent!.includes('5 things need'), 'Greeting count');
  check(document.querySelectorAll('h1').length === 1 && document.querySelectorAll('h2').length === 4, 'Heading hierarchy');
  check(document.querySelector('label[for="today-athena"]') !== null, 'Composer label');
  check(!document.querySelector<HTMLDetailsElement>('.today-brief__full-briefing')!.open, 'Narrative collapsed');
  results.push('Initial caps, greeting, heading hierarchy, input label, collapsed narrative');

  button('What should I focus on?').click();
  await waitFor(() => document.querySelector('#athena-probe')!.getAttribute('data-prompt') === 'What should I focus on?');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('.ai-float-panel textarea')?.value === 'What should I focus on?');
  check(document.activeElement === document.querySelector('.ai-float-panel textarea'), 'Athena composer receives focus');
  check(document.querySelector('#athena-probe')!.getAttribute('data-context')!.includes('attention'), 'Today context handoff');
  document.querySelector<HTMLButtonElement>('.today-brief__attention button[aria-label^="Ask Athena"]')!.click();
  await waitFor(() => document.querySelector('#athena-probe')!.getAttribute('data-project') === 'personal');
  check(document.querySelector('#athena-probe')!.getAttribute('data-context')!.includes('Today item'), 'Item-scoped context');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('.ai-float-panel textarea')?.value === 'Help me work out the next step for this item.');
  document.querySelector<HTMLButtonElement>('[aria-label="Close AI Chat"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel') === null);
  document.querySelector<HTMLButtonElement>('[aria-label="Open AI Chat"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel textarea') !== null);
  check(document.querySelector<HTMLTextAreaElement>('.ai-float-panel textarea')!.value === '', 'A consumed prompt must not replay on reopen');
  document.querySelector<HTMLButtonElement>('[aria-label="Close AI Chat"]')!.click();
  await waitFor(() => document.querySelector('.ai-float-panel') === null);
  results.push('Existing popout opens, focuses, accepts prompts and closes; item project/context handoff');

  check(document.querySelectorAll('.today-brief__change-list li').length === 3, 'Initial changes cap');
  button('Show 2 more summaries').click();
  await waitFor(() => document.querySelectorAll('.today-brief__change-list li').length === 5);
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
  tasks = [];
  api.getNoteSummaries = async () => success(paginated([]));
  api.getTimeline = async () => success(paginated([]));
  await queryClient.invalidateQueries({ queryKey: ['today'] });
  await waitFor(() => document.querySelector('.today-brief__attention')!.textContent!.includes('No deadlines'));
  check(document.querySelector('.today-brief__continue')!.textContent!.includes('No recent drafts'), 'Continuation empty state');
  check(document.querySelector('.today-brief__changes')!.textContent!.includes('No meaningful changes'), 'Changes empty state');
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

  const region = document.querySelector<HTMLElement>('.today-brief')!;
  check(region.scrollWidth <= region.clientWidth + 1, 'Today has horizontal overflow');
  const columns = getComputedStyle(document.querySelector('.today-brief__grid')!).gridTemplateColumns.split(' ').length;
  check(columns === (window.innerWidth <= 800 ? 1 : 2), 'Responsive column count');
  results.push(`Responsive layout and no horizontal overflow at ${window.innerWidth}px`);
  return results;
}

Object.assign(window, { runTodayChecks });
