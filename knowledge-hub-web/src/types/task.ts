/**
 * Task types — mirrors backend Task.
 */

export type TaskDestination = 'todo' | 'github-issue';

/** `inbox` holds Athena-created tasks awaiting review; `waiting` replaced blocked / awaiting-feedback. */
export type TaskStatus = 'inbox' | 'backlog' | 'in-progress' | 'waiting' | 'completed';

const LEGACY_STATUS: Record<string, TaskStatus> = { blocked: 'waiting', 'awaiting-feedback': 'waiting' };

/** Maps statuses from before the triage migration onto the current set. */
export function normaliseTask<T extends { status: string; waitingOn?: string | null }>(task: T): T & { status: TaskStatus } {
  const legacy = LEGACY_STATUS[task.status];
  if (legacy === undefined) return task as T & { status: TaskStatus };
  return { ...task, status: legacy, waitingOn: task.waitingOn ?? (task.status === 'blocked' ? 'Blocked' : 'Feedback') };
}
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskType = 'standard' | 'cert_session' | 'cert_review';
export type RecurringCadence = 'daily' | 'weekly' | 'fortnightly' | 'monthly';

export interface PlanTask {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  /** Who/what a Waiting task is waiting on. */
  waitingOn?: string | null;
  projectId: string;
  tags: string[];
  priority: TaskPriority;
  task_type: TaskType;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  externalUrl: string | null;
  linkedTagId: string | null;
  taxonomyTagIds: string[];
  recurringCadence: RecurringCadence | null;
  /** How many times the due date has been pushed later. */
  rescheduleCount?: number;
  archived: boolean;
  /** First linked chat/note — where the task came from (list endpoint only). */
  origin?: TaskOrigin | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskOrigin { type: string; id: string; title: string; url: string }

/** A slim task used by the end-of-day check-in and Athena's at-risk nudge. */
export interface NudgeTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  dueDate: string | null;
  rescheduleCount: number;
}

export interface AtRiskTask extends NudgeTask { score: number; reason: string }

export interface DayCheckin {
  day: string;
  /** Current UK hour, so the banner timing doesn't depend on the browser clock. */
  hour: number;
  status: 'completed' | 'skipped' | null;
  items: NudgeTask[];
  completedToday: Array<{ id: string; title: string }>;
}

export type CheckinAction = 'done' | 'tomorrow' | 'date' | 'drop';

export interface CreateTaskInput {
  title: string;
  body?: string;
  destination?: TaskDestination;
  projectContext?: string;
  projectId?: string;
  status?: TaskStatus;
  waitingOn?: string | null;
  priority?: TaskPriority;
  tags?: string[];
  taxonomyTagIds?: string[];
  dueDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  recurringCadence?: RecurringCadence | null;
  task_type?: TaskType;
  pushToTodo?: boolean;
  pushToGithub?: boolean;
  githubRepo?: string;
}
