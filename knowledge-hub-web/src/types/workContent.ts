export interface WorkSource { type: 'note' | 'document'; id: string }
export type DraftChannel = 'email' | 'slack' | 'teams';
export const DRAFT_CHANNEL_LABELS: Record<DraftChannel, string> = { email: 'Email', slack: 'Slack', teams: 'Teams' };
export interface WorkContent {
  noteId: string; type: 'deliverable-brief' | 'email-draft'; revision: number; noteRevision: number;
  taskId: string | null; taskTitle: string | null; taskUpdatedAt: string | null;
  targetFolder: string; fileName: string; sources: WorkSource[];
  producedFile: { id: string; url: string; modifiedAt: string | null; title: string } | null;
  briefId: string | null; to: string; cc: string; subject: string; status: 'draft' | 'sent'; sentAt: string | null;
  /** Email drafts are copied into IBM mail; Slack and Teams drafts are short chat messages. */
  channel: DraftChannel;
}
export type WorkContentPatch = Partial<Pick<WorkContent, 'taskId' | 'targetFolder' | 'fileName' | 'sources' | 'briefId' | 'to' | 'cc' | 'subject' | 'channel'>>;
export interface DraftSummary {
  noteId: string; title: string; channel: DraftChannel; status: 'draft' | 'sent'; to: string; subject: string;
  sentAt: string | null; updatedAt: string; taskId: string | null; taskTitle: string | null;
}
export interface TaskReviewSummary { considered: number; queued: number; skipped: number; reviewedAt: string }
