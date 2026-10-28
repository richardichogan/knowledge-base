export const DESIGN_ROLES = ['use_case', 'spec', 'architecture', 'diagram', 'reference'] as const;
export const DESIGN_STATUSES = ['draft', 'in_review', 'ready', 'archived'] as const;
export type DesignRole = typeof DESIGN_ROLES[number];
export type SpecificationType = 'standard' | 'imagine';
export const DESIGN_ROLE_LABELS: Record<DesignRole, string> = {
  use_case: 'Use case', spec: 'Specification', architecture: 'Architecture', diagram: 'Diagrams', reference: 'References',
};
export const DESIGN_STATUS_LABELS: Record<typeof DESIGN_STATUSES[number], string> = {
  draft: 'Draft', in_review: 'In review', ready: 'Ready', archived: 'Archived',
};
export interface Design {
  id: string; parentNoteId: string; title: string; summary: string; projectId: string | null; sourceUseCaseId: string | null; sourceNoteId: string | null;
  status: typeof DESIGN_STATUSES[number]; revision: number; mapped: boolean; updatedAt: string; specificationType: SpecificationType | null;
}
export interface DesignAsset {
  sourceType: 'note' | 'canvas' | 'usecase' | 'link'; sourceId: string; title: string; role: DesignRole;
  href: string; origin: 'explicit' | 'manual'; available: boolean;
}
export interface DesignDetail extends Design { assets: DesignAsset[]; selections: Partial<Record<DesignRole, string>> }
export interface DesignConsistencyReport {
  requestedChange: string | null;
  checkedAt: string; designRevision: number; complete: boolean;
  coverage: Array<{ role: string; status: 'supplied' | 'missing' | 'ambiguous' | 'unavailable' }>;
  sources: Array<{ id: string; title: string; role: string; revision: number; href: string }>;
  findings: Array<{ kind: 'contradiction' | 'open-decision' | 'impact'; explanation: string;
    evidence: Array<{ sourceId: string; quote: string; elementId: string | null }> }>;
}
export interface DesignSource { id: string; role: string; revision: number; title: string; markdown: string; blocks: unknown[]; document?: unknown }
export interface LegacyDesignVisual {
  format?: undefined; title: string; explanation: string; openDecisions: string[]; elements: Array<{
    id: string; title: string; content: string; sourceIds: string[]; choices: string[];
    components: Array<{ kind: string; label: string; detail: string; targetId: string | null }>;
  }>;
}
export interface DesignDecision {
  id: string; question: string; context: string; options: Array<{ label: string; consequence: string }>; recommended: string | null; sourceIds: string[];
}
export interface AuthoredDesignVisual {
  format: 'authored-v1'; title: string; purpose: string; ask: string; body: string; explanation: string; openDecisions: string[];
  elements: Array<{ id: string; title: string; role: 'overview' | 'decisions' | 'architecture' | 'flow' | 'data' | 'screens' | 'exceptions' | 'delivery' | 'example' | 'detail'; sourceIds: string[]; text: string }>;
  decisions: DesignDecision[];
}
export interface DesignArtifact {
  id: string; revision: number; sources: DesignSource[]; html: string;
  blueprint: LegacyDesignVisual | AuthoredDesignVisual;
}
export interface DesignFeedback {
  id: string; artifact_id: string; element_id: string; selection: string; instruction: string;
  status: 'queued' | 'proposed' | 'accepted' | 'discarded';
}
export interface DesignProposal {
  id: string; explanation: string; changes: Array<{ noteId: string; blockId: string | null; before: unknown; markdown: string }>;
  previewHtml?: string;
}
export interface DesignThreadEntry {
  id: string; status: 'accepted' | 'discarded' | 'pending'; explanation: string; created_at: string;
  changes: { noteId: string; title: string; markdown: string }[];
  feedback: { id: string; element_id: string; selection: string; instruction: string }[];
}
export interface DesignCollaboration { artifact: DesignArtifact | null; feedback: DesignFeedback[]; proposal: DesignProposal | null; thread?: DesignThreadEntry[]; stale: boolean; sourceError: string | null }
export interface DesignPackage {
  id: string;
  manifest: { ready: boolean; missingInputs: string[]; openDecisions: string[]; pendingFeedback: number;
    files: Array<{ path: string; sha256: string; role: string }> };
}
export interface DesignPublication { id: string; repo: string; branch: string; folder: string; base_sha: string }
