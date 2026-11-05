import type { PresentationArtwork, PresentationVisualScene } from '../src/elgatoProtocol';
import type { VisualComposition } from './visualComposition';

export interface VisualPacket {
  scene: Pick<PresentationVisualScene, 'id' | 'template' | 'title' | 'subtitle' | 'imageUrl' | 'imageAlt'> & {
    items: Array<{ label: string; detail: string }>;
    artwork?: PresentationArtwork;
    layout?: PresentationVisualScene['layout'];
    composition?: VisualComposition;
    presenterLayout?: boolean;
  } | null;
  revealed: number;
  error: string | null;
  page: number;
  total: number;
  presentationTitle: string;
}
export function createVisualRenderer(stage: HTMLElement, status: HTMLElement, footerHost: HTMLElement): (packet: VisualPacket) => void;
