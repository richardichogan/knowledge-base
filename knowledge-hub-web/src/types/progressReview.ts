import type { ProjectType } from '../services/api';

export interface ProgressEvidence {
  id: string; kind: string; title: string; href: string; updatedAt: string;
  content: string; truncated: boolean; role: 'current-context' | 'changed-record';
}
export interface ProgressFinding { text: string; evidenceIds: string[] }
export interface ProgressAssessment {
  summary: string;
  progress: ProgressFinding[];
  activity: ProgressFinding[];
  blockers: ProgressFinding[];
  nextMove: { text: string; why: string; evidenceIds: string[] };
}
export interface ProgressReviewSummary {
  id: string; projectId: string; projectType: ProjectType; createdAt: string;
  since: string; until: string; summary: string;
}
export interface ProgressReview extends ProgressReviewSummary {
  assessment: ProgressAssessment;
  evidence: ProgressEvidence[];
  limitations: string[];
  projectSnapshot: { name: string; description: string; goal: string; deliverables: string[]; updatedAt: string };
}
export interface ProgressReviewPage { items: ProgressReviewSummary[]; total: number; offset: number; limit: number }
