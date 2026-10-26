/** Specialist agent jobs: work Athena hands to a specialist that runs in the background. */
export type AgentJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AgentJob {
  id: string;
  specialist: string;
  specialistName: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string;
  subjectUrl: string;
  status: AgentJobStatus;
  progress: string[];
  summary: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  dependsOn: string | null;
  /** A prerequisite step in a handoff, e.g. the spec written before a Blueprint. */
  isStep: boolean;
  conversationId: string | null;
  requestedBy: 'app' | 'chat';
  acknowledged: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentPlanStep { specialist: string; specialistName: string; reason: string; overwrites: boolean }

export type AgentHandOffResult =
  | { status: 'queued'; job: AgentJob; steps: AgentJob[] }
  | { status: 'already_running'; job: AgentJob }
  | { status: 'needs_confirmation'; plan: AgentPlanStep[]; message: string };

export const isActiveAgentJob = (job: AgentJob): boolean => job.status === 'queued' || job.status === 'running';
