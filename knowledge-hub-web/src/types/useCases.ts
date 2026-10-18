/**
 * types/useCases.ts — mirrors knowledge-hub-backend/src/useCases/useCaseStore.ts.
 * A use case gathers evidence (Discover items, Sparks, notes, canvases) into a spec that
 * is handed to GitHub Copilot or Athena Build.
 */

export const USE_CASE_STAGES = ['candidate', 'refining', 'spec_ready', 'handed_off', 'shipped', 'dropped'] as const;
export type UseCaseStage = typeof USE_CASE_STAGES[number];
export const PRODUCT_KINDS = ['imagine_demo', 'imagine_platform', 'product'] as const;
export type ProductKind = typeof PRODUCT_KINDS[number];
export type UseCaseSourceType = 'discover' | 'spark' | 'note' | 'canvas';

export const STAGE_LABELS: Record<UseCaseStage, string> = {
  candidate: 'Candidate', refining: 'Refining', spec_ready: 'Spec ready',
  handed_off: 'Handed off', shipped: 'Shipped', dropped: 'Dropped',
};
export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  imagine_demo: 'IMAGINE demo', imagine_platform: 'IMAGINE platform', product: 'Product',
};
export const SOURCE_TYPE_LABELS: Record<UseCaseSourceType, string> = {
  discover: 'Discover', spark: 'Spark', note: 'Note', canvas: 'Canvas',
};

export interface UseCaseSourceRef { sourceType: UseCaseSourceType; sourceId: string }
export interface UseCaseSource extends UseCaseSourceRef { title: string; url: string | null; addedAt: string }
export interface UseCaseLink { id: string; url: string; title: string; addedAt: string }

export interface UseCase {
  id: string;
  title: string;
  summary: string;
  productKind: ProductKind;
  projectId: string | null;
  projectName: string | null;
  repo: string | null;
  stage: UseCaseStage;
  specNoteId: string | null;
  buildSpecId: string | null;
  handoffRepo: string | null;
  handoffPath: string | null;
  handoffUrl: string | null;
  sourceCount: number;
  linkCount: number;
  createdAt: string;
  updatedAt: string;
  stageChangedAt: string;
}
export interface UseCaseDetail extends UseCase { sources: UseCaseSource[]; links: UseCaseLink[] }

export interface CreateUseCaseInput {
  title: string;
  summary?: string;
  productKind?: ProductKind;
  projectId?: string | null;
  repo?: string | null;
  sources?: UseCaseSourceRef[];
}
export type UseCasePatch = Partial<Pick<UseCase, 'title' | 'summary' | 'productKind' | 'projectId' | 'repo' | 'stage'>>;

export interface DraftSpecResult { useCase: UseCaseDetail; noteId: string; replaced: boolean }
export interface HandoffInput { mode: 'github' | 'build'; repo?: string; path?: string }
export interface HandoffResult {
  useCase: UseCaseDetail;
  mode: 'github' | 'build';
  url: string | null;
  path: string | null;
  buildSpecId: string | null;
  prompt: string | null;
}
