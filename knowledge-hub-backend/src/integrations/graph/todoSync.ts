import type { Pool } from 'pg';
import { getGraphClient } from './graphClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import type { ContentItem } from '../../types/contentItem.js';
import type { Task, CreateTaskInput } from '../../types/task.js';

interface GraphTask {
  id: string;
  title: string;
  body?: { content: string };
  status: string;
  importance: string;
  dueDateTime?: { dateTime: string };
  createdDateTime: string;
  lastModifiedDateTime: string;
}

interface GraphTaskList {
  id: string;
  displayName: string;
}

/**
 * Syncs Microsoft To Do tasks into the content index.
 * Tasks.ReadWrite scope.
 */
export async function syncTodoTasks(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = getGraphClient();
  let indexed = 0;
  let errors = 0;

  try {
    const lists = await client.get<{ value: GraphTaskList[] }>('/me/todo/lists');

    for (const list of lists.value) {
      for await (const tasks of client.paginate<GraphTask>(
        `/me/todo/lists/${list.id}/tasks`,
        { $top: '100' },
      )) {
        for (const task of tasks) {
          const item = taskToContentItem(task, list.displayName);
          await upsertContentItem(db, item);
          indexed++;
        }
      }
    }
  } catch (err) {
    errors++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Graph ToDo] Sync failed: ${message}`);
  }

  await upsertSyncState(db, 'graph-todo', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `ToDo sync error` : null,
  });

  return { indexed, errors };
}

/** Creates a new task in Microsoft To Do. Returns the created task ID. */
export async function createTodoTask(input: CreateTaskInput): Promise<string> {
  const client = getGraphClient();

  // Find or use "Tasks" list as default
  const lists = await client.get<{ value: GraphTaskList[] }>('/me/todo/lists');
  const targetListName = input.listName ?? 'Tasks';
  const list = lists.value.find(
    (l) => l.displayName.toLowerCase() === targetListName.toLowerCase(),
  );

  const listId = list?.id ?? lists.value[0]?.id;
  if (!listId) {
    throw new Error('No Microsoft To Do lists found');
  }

  const body: Record<string, unknown> = {
    title: input.title,
    importance: input.importance ?? 'normal',
  };
  if (input.body) body['body'] = { content: input.body, contentType: 'text' };
  if (input.dueDateTime) body['dueDateTime'] = { dateTime: input.dueDateTime, timeZone: 'UTC' };

  const created = await client.post<{ id: string }>(`/me/todo/lists/${listId}/tasks`, body);
  return created.id;
}

function graphStatusToTaskStatus(status: string): Task['status'] {
  const map: Record<string, Task['status']> = {
    notStarted: 'notStarted',
    inProgress: 'inProgress',
    completed: 'completed',
    waitingOnOthers: 'waitingOnOthers',
    deferred: 'deferred',
  };
  return map[status] ?? 'notStarted';
}

function taskToContentItem(task: GraphTask, listName: string): Omit<ContentItem, 'id' | 'indexedAt'> {
  return {
    source: 'graph-todo',
    sourceId: task.id,
    title: task.title,
    summary: `Task (${listName}): ${task.title} — ${task.status}`,
    body: task.body?.content ?? '',
    publishedAt: new Date(task.createdDateTime).toISOString(),
    projectContext: 'personal',
    metadata: {
      listName,
      status: graphStatusToTaskStatus(task.status),
      importance: task.importance,
      dueDateTime: task.dueDateTime?.dateTime,
      lastModifiedDateTime: task.lastModifiedDateTime,
    },
    tags: [task.status],
  };
}
