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
export type TidyKind = 'archive-task' | 'drop-decision' | 'file-note' | 'file-chat' | 'cull-draft';
export interface TidyItem { id: string; kind: TidyKind; entityId: string; title: string; detail: string; projectId: string | null; projectName: string | null }
export interface Scorecard {
  week: string; generatedAt: string; trigger: 'job' | 'manual' | 'athena'; current: boolean; undoUntil: string | null; goals: GoalScore[];
  athena: { proposed: number; accepted: number; done: number; dismissed: number; ignored: number; drafts: number; research: number; summary: string };
  tidy: { items: TidyItem[]; note: string | null; batchId: string | null; appliedAt: string | null; applied: number; excluded: string[]; undoneAt: string | null };
}
export interface GoalsOverview {
  goals: GoalStatus[]; brief: GoalBrief | null; scorecard: Scorecard | null;
  briefRunning: boolean; scorecardRunning: boolean; briefError: string | null; scorecardError: string | null;
  settings: GoalSettings; reviewRunning: boolean; reviewError: string | null;
}
export type ProjectGoal = GoalId | 'none';
export interface GoalAdjustment {
  id: string; kind: 'target' | 'deadline' | 'link'; measureId?: string; projectId?: string; goalId?: ProjectGoal;
  from: string; to: string; reason: string; at: string; status: 'proposed' | 'accepted' | 'dismissed'; decidedAt: string | null;
}
export interface GoalSettings {
  adjustments: GoalAdjustment[];
  measures: Array<{ goalId: GoalId; id: string; label: string; kind: 'count' | 'milestone' | 'auto' }>;
  overrides: Record<string, { target?: number; deadline?: string }>;
  lastReview: string | null;
  links: {
    projects: Array<{ id: string; name: string; goalId: ProjectGoal | null; openTasks: number }>;
    unlinkedTasks: Array<{ id: string; title: string; projectId: string | null; projectName: string | null }>;
  };
}

/** Mirrors knowledge-hub-backend/src/goals/proactive.ts (GET /api/today/proactive). */
export interface DealChange { section: string; before: string; after: string }
export interface DealUpdate {
  id: string; projectId: string; noteId: string; trigger: string; summary: string; changes: DealChange[];
  draftId: string | null; createdAt: string; undoneAt: string | null; canUndo: boolean;
}
export interface DealDeskRow { projectId: string; name: string; noteId: string | null; latest: DealUpdate | null }
export interface DraftText { channel: 'email' | 'slack' | 'teams'; to: string; subject: string; body: string }
export interface PrepCard {
  id: string; time: string; meeting: string; attendees: string[]; lastExchange: string;
  ourPromises: string[]; theirPromises: string[]; talkingPoints: string[]; projectId: string | null; dealNoteId: string | null;
}
export interface PromiseProposal {
  held?: boolean;
  id: string; owner: 'richard' | 'other'; who: string; text: string; due: string | null; projectId: string | null; reportDate: string;
  draft: DraftText | null; status: 'proposed' | 'accepted' | 'dismissed'; taskId: string | null; draftId: string | null; decidedAt: string | null;
}
export interface ChaseProposal { held?: boolean; id: string; taskId: string; taskTitle: string; waitingOn: string; workingDays: number; draftId: string; at: string; status: 'proposed' | 'dismissed' }
export interface CadenceNudge {
  held?: boolean;
  id: string; person: string; workingDays: number; lastSeen: string | null; reason: string; draft: DraftText;
  status: 'proposed' | 'accepted' | 'dismissed'; taskId: string | null; draftId: string | null; at: string; decidedAt: string | null;
}
export interface MeetingPrepState {
  reportDate: string | null; generatedAt: string | null; trigger: string | null; cards: PrepCard[];
  promises: PromiseProposal[]; chases: ChaseProposal[]; cadence: CadenceNudge[]; chasedAt: Record<string, string>; running: boolean;
}
export interface ContentPackage {
  id: string; topicId: string; noteId: string | null; itemId: string; title: string; url: string;
  trigger: 'competitor' | 'discover' | 'podcast' | 'win'; why: string; angle: string; createdAt: string; error?: string;
  noteOnly?: boolean; decision?: 'accepted' | 'dismissed'; held?: boolean;
  status: 'drafting' | 'in-review' | 'ready-to-approve' | 'ready' | 'approved' | 'published' | 'rejected' | 'expired' | 'failed';
  blog: { id: string; review: string; approval: string; held: boolean; title: string } | null;
  linkedin: { id: string; review: string; approval: string; held: boolean } | null;
}
export interface CfpCard {
  id: string; conference: string; fit: string; score: number; deadline: string; eventStart: string | null;
  location: string | null; isVirtual: boolean; cfpUrl: string; held?: boolean;
}
export interface CfpSchedule { cfpId: string; conference: string; deadline: string; dueAt: string; confirmedAt: string; noteId: string | null; taskId: string | null; error?: string }
export type ProposalType = 'goal-move' | 'date-proposal' | 'deal-followup' | 'promise' | 'chase' | 'cadence' | 'content-package' | 'cfp' | 'chat-next-step' | 'goal-adjustment';
export interface ProposalReport {
  since: string; proposed: number; accepted: number; open: number; ignored: number; dismissed: number;
  byType: Array<{ type: ProposalType; label: string; proposed: number; accepted: number; open: number; ignored: number; dismissed: number }>;
  stopped: Array<{ type: ProposalType; label: string; at: string; reason: string; by: 'athena' | 'richard' }>;
}
export interface LoopPause {
  key: string; kind: 'agent' | 'job'; specialist?: string; specialistName?: string; subjectType?: string; subjectId?: string;
  jobId?: string; subjectTitle: string; failures: number; lastError: string; question: string; at: string;
  status: 'open' | 'resumed' | 'stopped'; resolvedAt: string | null;
}
export interface ProactiveOverview {
  paused: LoopPause[];
  timing: { peak: boolean; held: number; nextWindow: string };
  deals: { rows: DealDeskRow[]; running: boolean };
  meetingPrep: MeetingPrepState;
  packages: ContentPackage[];
  cfps: { shortlist: CfpCard[]; scheduled: CfpSchedule[] };
  ledger: ProposalReport;
}
export type ProactiveAction = 'run-deal-desk' | 'update-deal-from-notes' | 'deal-history' | 'undo-deal-update' | 'refresh-meeting-prep'
  | 'accept-promise' | 'dismiss-promise' | 'accept-cadence' | 'dismiss-cadence' | 'dismiss-chase' | 'run-content-package' | 'run-story-package' | 'use-package' | 'dismiss-package' | 'resume-paused' | 'stop-paused'
  | 'confirm-cfp' | 'dismiss-cfp' | 'enable-proposal-type' | 'disable-proposal-type';
