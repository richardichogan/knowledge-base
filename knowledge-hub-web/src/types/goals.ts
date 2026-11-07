/** Mirrors knowledge-hub-backend/src/goals (GET /api/today/goals). */
export type GoalId = 'imagine' | 'practice' | 'voice' | 'attention';
export type GoalHealth = 'on-track' | 'at-risk' | 'slipping';
export interface ProgressEntry { id: string; measureId: string; at: string; count?: number; done?: boolean; note: string; actor: 'richard' | 'athena' }
export interface MeasureStatus {
  id: string; label: string; kind: 'count' | 'milestone' | 'auto'; health: GoalHealth; summary: string;
  value: number | null; target: number | null; unit: string | null; period: string | null;
  deadline: string | null; done: boolean | null; manual: boolean; recent: ProgressEntry[];
}
export interface GoalStatus {
  id: GoalId; name: string; why: string; health: GoalHealth; projects: Array<{ id: string; name: string }>;
  openTasks: number; overdueTasks: number; measures: MeasureStatus[];
}
export interface GoalMove {
  id: string; goalId: GoalId; goalName: string; title: string; reason: string;
  taskId: string | null; taskTitle: string | null; prep: 'message' | 'research' | 'none';
  prepStatus: 'draft-ready' | 'research-queued' | 'none' | 'failed' | 'on-accept'; prepDetail: string | null; draftId: string | null;
  status: 'proposed' | 'accepted' | 'dismissed'; decidedAt: string | null; acceptedTaskId: string | null;
}
export interface GoalBrief {
  week: string; generatedAt: string; trigger: 'job' | 'manual' | 'athena'; current: boolean;
  health: Array<{ goalId: GoalId; health: GoalHealth }>; moves: GoalMove[];
}
export interface DateProposal { id: string; taskId: string; taskTitle: string; currentDue: string; proposedDue: string; reason: string; status: 'proposed' | 'accepted' | 'dismissed' }
export interface GoalScore {
  goalId: GoalId; goalName: string; health: GoalHealth; healthAtBrief: GoalHealth | null; summary: string;
  completed: Array<{ taskId: string; title: string }>; completedCount: number; overdueCount: number;
  move: { title: string; status: string; done: boolean } | null; dateProposals: DateProposal[];
}
export type TidyKind = 'archive-task' | 'drop-decision' | 'file-note' | 'file-chat';
export interface TidyItem { id: string; kind: TidyKind; entityId: string; title: string; detail: string; projectId: string | null; projectName: string | null }
export interface Scorecard {
  week: string; generatedAt: string; trigger: 'job' | 'manual' | 'athena'; current: boolean; undoUntil: string | null; goals: GoalScore[];
  athena: { proposed: number; accepted: number; done: number; dismissed: number; ignored: number; drafts: number; research: number; summary: string };
  tidy: { items: TidyItem[]; note: string | null; batchId: string | null; appliedAt: string | null; applied: number; excluded: string[]; undoneAt: string | null };
}
export interface GoalsOverview {
  goals: GoalStatus[]; brief: GoalBrief | null; scorecard: Scorecard | null;
  briefRunning: boolean; scorecardRunning: boolean; briefError: string | null; scorecardError: string | null;
}
