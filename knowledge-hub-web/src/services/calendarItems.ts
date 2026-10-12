import type { ContentItemSummary } from '../types';
import type { ApiResponse } from '../types/apiResponse';
import { localDateKey, dateOnlyToLocal } from '../utils/dateOnly';
import type { api } from './api';

export async function loadCalendarItems(
  client: Pick<typeof api, 'getTimeline'> & {
    getTasks(params?: { projectId?: string }): Promise<ApiResponse<unknown>>;
  },
  options: { rangeStart: string; rangeEnd: string; project: string; tag: string },
): Promise<ContentItemSummary[]> {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  const loadTimeline = async (): Promise<ContentItemSummary[]> => {
    const items: ContentItemSummary[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      if (page > MAX_PAGES) throw new Error('Calendar range is too large. Narrow the project filter.');
      const response = await client.getTimeline({
        rangeStart: options.rangeStart, rangeEnd: options.rangeEnd, page, pageSize: PAGE_SIZE,
        ...(options.project !== '' && { projectContext: options.project }),
      });
      if (!response.success) throw new Error(response.error.message);
      items.push(...response.data.items.filter((item) => item.source !== 'task'));
      hasMore = response.data.hasMore;
      page++;
    }
    return items;
  };
  const [timeline, nativeTasks] = await Promise.all([
    loadTimeline(),
    client.getTasks(options.project ? { projectId: options.project } : undefined).then(calendarTaskItems),
  ]);
  return [...timeline, ...nativeTasks].filter((item) => options.tag === '' || item.taxonomyTagIds?.includes(options.tag));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function calendarTaskItems(response: ApiResponse<unknown>): ContentItemSummary[] {
  if (!response.success) throw new Error(response.error.message);
  if (!isRecord(response.data) || !Array.isArray(response.data['items'])) throw new Error('Invalid task list response');
  return response.data['items'].flatMap((row: unknown): ContentItemSummary[] => {
    if (!isRecord(row) || typeof row['id'] !== 'string' || typeof row['title'] !== 'string'
      || typeof row['status'] !== 'string') throw new Error('Invalid calendar task');
    if (row['status'] === 'completed' || row['archived'] === true) return [];
    const date = row['dueDate'] ?? (row['recurringCadence'] ? row['startDate'] : null);
    if (date === null || date === undefined) return [];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid task schedule date');
    dateOnlyToLocal(date);
    const tags = row['taxonomyTagIds'];
    return [{
      id: `native-task-${row['id']}`, source: 'task', sourceId: row['id'],
      title: row['title'], summary: typeof row['body'] === 'string' ? row['body'] : '',
      publishedAt: date, url: `/plan?taskId=${encodeURIComponent(row['id'])}`,
      taxonomyTagIds: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
      metadata: { status: row['status'], projectId: row['projectId'] },
    }];
  });
}

export function calendarDateKey(item: ContentItemSummary): string | null {
  if (item.source === 'task') return item.publishedAt;
  if (item.source === 'graph-todo') {
    if (item.metadata?.['status'] === 'completed') return null;
    const due = item.metadata?.['dueDateTime'];
    return typeof due === 'string' ? due.slice(0, 10) : null;
  }
  const date = new Date(item.publishedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid calendar event date');
  return localDateKey(date);
}
