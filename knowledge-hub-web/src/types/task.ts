/**
 * Task types — mirrors backend Task.
 */

export type TaskDestination = 'todo' | 'github-issue';

export interface CreateTaskInput {
  title: string;
  body?: string;
  destination: TaskDestination;
  projectContext?: string;
}
