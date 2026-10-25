export const DESIGN_ROLES = ['use_case', 'spec', 'architecture', 'diagram', 'reference'] as const;
export const DESIGN_STATUSES = ['draft', 'in_review', 'ready', 'archived'] as const;
export type DesignRole = typeof DESIGN_ROLES[number];
export const DESIGN_ROLE_LABELS: Record<DesignRole, string> = {
  use_case: 'Use case', spec: 'Specification', architecture: 'Architecture', diagram: 'Diagrams', reference: 'References',
};
export const DESIGN_STATUS_LABELS: Record<typeof DESIGN_STATUSES[number], string> = {
  draft: 'Draft', in_review: 'In review', ready: 'Ready', archived: 'Archived',
};
export interface Design {
  id: string; parentNoteId: string; title: string; summary: string; projectId: string | null; sourceUseCaseId: string | null; sourceNoteId: string | null;
  status: typeof DESIGN_STATUSES[number]; revision: number; mapped: boolean; updatedAt: string;
}
export interface DesignAsset {
  sourceType: 'note' | 'canvas' | 'usecase' | 'link'; sourceId: string; title: string; role: DesignRole;
  href: string; origin: 'explicit' | 'manual'; available: boolean;
}
export interface DesignDetail extends Design { assets: DesignAsset[]; selections: Partial<Record<DesignRole, string>> }
export interface DesignSource { id: string; role: string; revision: number; title: string; markdown: string; blocks: unknown[]; document?: unknown }
export interface DesignArtifact {
  id: string; revision: number; sources: DesignSource[]; html: string;
  blueprint: { title: string; explanation: string; openDecisions: string[]; elements: Array<{
    id: string; title: string; content: string; sourceIds: string[]; choices: string[];
    components: Array<{ kind: string; label: string; detail: string; targetId: string | null }>;
  }> };
}
export interface DesignFeedback {
  id: string; artifact_id: string; element_id: string; selection: string; instruction: string;
  status: 'queued' | 'proposed' | 'accepted' | 'discarded';
}
export interface DesignProposal {
  id: string; explanation: string; changes: Array<{ noteId: string; blockId: string | null; before: unknown; markdown: string }>;
  previewHtml?: string;
}
export interface DesignCollaboration { artifact: DesignArtifact | null; feedback: DesignFeedback[]; proposal: DesignProposal | null; stale: boolean; sourceError: string | null }
export interface DesignPackage {
  id: string;
  manifest: { ready: boolean; missingInputs: string[]; openDecisions: string[]; pendingFeedback: number;
    files: Array<{ path: string; sha256: string; role: string }> };
}
export interface DesignPublication { id: string; repo: string; branch: string; folder: string; base_sha: string }
