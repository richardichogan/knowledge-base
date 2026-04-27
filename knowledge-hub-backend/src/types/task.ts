/**
 * Task — unified representation of a task from any source.
 * Primary: Microsoft To Do (Graph API). Secondary: GitHub Issues.
 */

export type TaskSource = 'microsoft-todo' | 'github-issue';
export type TaskStatus = 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';

export interface Task {
  /** Knowledge hub internal ID. */
  id: string;
  source: TaskSource;
  /** Source-specific task ID. */
  sourceId: string;
  title: string;
  body?: string;
  status: TaskStatus;
  /** ISO 8601 due date, if set. */
  dueDateTime?: string;
  /** ISO 8601. */
  createdDateTime: string;
  /** ISO 8601. */
  lastModifiedDateTime: string;
  /** List/project name from the source system. */
  listName?: string;
  /** URL to task in source app. */
  sourceUrl?: string;
  importance: 'low' | 'normal' | 'high';
}

/** Payload for creating a new task via the API or Raycast extension. */
export interface CreateTaskInput {
  title: string;
  body?: string;
  dueDateTime?: string;
  listName?: string;
  importance?: Task['importance'];
  /** Defaults to 'microsoft-todo'. */
  source?: TaskSource;
}
