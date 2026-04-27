/**
 * Task types — mirrors the backend Task interface.
 */

export type TaskDestination = 'todo' | 'github-issue';

export interface Task {
  id: string;
  title: string;
  body?: string;
  destination: TaskDestination;
  projectContext?: string;
  createdAt: string;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  destination: TaskDestination;
  projectContext?: string;
}
