/** Specialist ids for each task-assistance kind. Kept dependency-free: the agent registry reads it while modules are still loading. */
export const TASK_ASSISTANCE_SPECIALISTS = {
  research: 'task-researcher', email: 'task-email-drafter', message: 'task-message-drafter', support: 'task-preparation-assistant',
} as const;
