import type { VisualVideoState } from '../../knowledge-hub-backend/src/types/visualComposition';

export function createPresenterVideo(host: HTMLElement, options?: {
  capture?: boolean;
  report?: (state: VisualVideoState) => void;
}): {
  update(visible: boolean, requested?: VisualVideoState): void;
  disconnect(message: string): void;
  dispose(): void;
};
