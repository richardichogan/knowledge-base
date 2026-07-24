/**
 * Task types — mirrors backend Task.
 */

export type TaskDestination = 'todo' | 'github-issue';

export type TaskStatus = 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';

export interface CreateTaskInput {
  title: string;
  body?: string;
  destination?: TaskDestination;
  projectContext?: string;
  projectId?: string;
  status?: TaskStatus;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  tags?: string[];
  taxonomyTagIds?: string[];
  dueDate?: string;
}
