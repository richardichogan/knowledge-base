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

export type AssignmentState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'superseded';
export type WorkforceRole = 'athena' | 'iris' | 'calliope' | 'momus' | 'echo' | 'daedalus' | 'ariadne'
  | 'themis' | 'hephaestus' | 'argus' | 'metis' | 'socrates';

export interface AssignmentSummary {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  status: AssignmentState;
  readiness: 'pending' | 'ready' | 'blocked';
  revision: number;
  reason: string | null;
  currentStep: { key: string; role: WorkforceRole; name: string; title: string; profile: string } | null;
  resultUrl: string | null;
  callsUsed: string;
  tokensUsed: string;
  deadline: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface AssignmentNotice {
  eventId: string;
  conversationId: string | null;
  assignment: AssignmentSummary;
}

export const isActiveAssignment = (assignment: AssignmentSummary): boolean =>
  assignment.status === 'queued' || assignment.status === 'running';

export function assignmentStatusLabel(assignment: AssignmentSummary): string {
  if (assignment.status === 'completed') return assignment.readiness === 'ready' ? 'Ready for review' : 'Review needs attention';
  const labels: Record<Exclude<AssignmentState, 'completed'>, string> = {
    queued: 'Queued', running: 'Working', waiting: 'Paused for attention',
    failed: 'Could not finish', cancelled: 'Cancelled', superseded: 'Sources changed',
  };
  return labels[assignment.status];
}
