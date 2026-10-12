/**
 * Task types — mirrors backend Task.
 */

export type TaskDestination = 'todo' | 'github-issue';

export type TaskStatus = 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskType = 'standard' | 'cert_session' | 'cert_review';
export type RecurringCadence = 'daily' | 'weekly' | 'fortnightly' | 'monthly';

export interface PlanTask {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
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
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  destination?: TaskDestination;
  projectContext?: string;
  projectId?: string;
  status?: TaskStatus;
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
