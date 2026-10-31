export interface WorkSource { type: 'note' | 'document'; id: string }
export interface WorkContent {
  noteId: string; type: 'deliverable-brief' | 'email-draft'; revision: number; noteRevision: number;
  taskId: string | null; taskTitle: string | null; taskUpdatedAt: string | null;
  targetFolder: string; fileName: string; sources: WorkSource[];
  producedFile: { id: string; url: string; modifiedAt: string | null; title: string } | null;
  briefId: string | null; to: string; cc: string; subject: string; status: 'draft' | 'sent'; sentAt: string | null;
}
export type WorkContentPatch = Partial<Pick<WorkContent, 'taskId' | 'targetFolder' | 'fileName' | 'sources' | 'briefId' | 'to' | 'cc' | 'subject'>>;
