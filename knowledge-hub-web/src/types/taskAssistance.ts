import type { PlanTask } from './task';
import type { AgentJob, AgentHandOffResult } from './agentJobs';

export interface TaskAssistanceProposal {
  id: string;
  proposal: {
    kind: 'research' | 'email' | 'unsupported';
    summary: string; approach: string; output: string;
    questions: string[]; humanDecisions: string[]; publicQueries: string[];
  };
  approved: boolean;
  resultNoteId: string | null;
  stale: boolean;
}
export interface TaskAssistanceDetail {
  task: PlanTask;
  proposals: TaskAssistanceProposal[];
  jobs: AgentJob[];
}
export type TaskAssistanceStarted = AgentHandOffResult | { resultNoteId: string };
