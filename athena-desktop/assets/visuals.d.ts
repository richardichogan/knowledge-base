import type { PresentationArtwork, PresentationVisualScene } from '../src/elgatoProtocol';
import type { VisualComposition, VisualLink, VisualNode, VisualVideoState } from './visualComposition';

export interface VisualPacket {
  scene: Pick<PresentationVisualScene, 'id' | 'template' | 'title' | 'subtitle' | 'imageUrl' | 'imageAlt'> & {
    items: Array<{ label: string; detail: string; at?: number; cue?: { blockId: string; quote: string } }>;
    artwork?: PresentationArtwork;
    layout?: PresentationVisualScene['layout'];
    composition?: VisualComposition;
    presenterLayout?: boolean;
    brandMark?: PresentationVisualScene['brandMark'];
    theme?: PresentationVisualScene['theme'];
    section?: number;
  } | null;
  revealed: number;
  error: string | null;
  page: number;
  total: number;
  presentationTitle: string;
  animate?: boolean;
  video?: VisualVideoState;
  videoClientId?: string;
}
export interface VisualRenderer {
  (packet: VisualPacket): void;
  disconnectVideo(message: string): void;
  dispose(): void;
}
export const VISUAL_BUILD_INTERVAL_MS: number;
export function visualBuildSteps(items: ReadonlyArray<{ at?: number; cue?: { blockId: string; quote: string } }>): number[];
/** Snaps comparable nodes to shared centre lines, equal sizes and even gaps without breaking separations or containment. */
export function alignVisualNodes(nodes: VisualNode[], links?: VisualLink[]): VisualNode[];
/** A node's position, scale, opacity and focus once every state up to this build step has applied. */
export function visualNodeState(node: Pick<VisualNode, 'x' | 'y' | 'states'>, revealed: number): { x: number; y: number; scale: number; opacity: number; focus: boolean };
export function createVisualRenderer(stage: HTMLElement, status: HTMLElement, footerHost: HTMLElement, options?: {
  captureVideo?: boolean;
  onVideoState?: (state: VisualVideoState) => void;
}): VisualRenderer;
