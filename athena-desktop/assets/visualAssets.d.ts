import type { VisualAsset } from './visualComposition';

export interface VisualAssetPart {
  shape: 'rect' | 'circle' | 'line' | 'path' | 'g';
  attrs?: Record<string, number | string>;
  parts?: VisualAssetPart[];
  paint?: 'solid' | 'soft' | 'line' | 'ink' | 'inkline' | 'shade' | 'tint';
  tone?: 'teal' | 'blue' | 'purple' | 'neutral' | 'warning' | 'success' | 'light';
  w?: number;
  draw?: boolean;
  dash?: 'dashes';
  motion?: 'spin' | 'spin-reverse' | 'flow' | 'twinkle';
  /** The point a spinning or twinkling group turns about, in drawing units. */
  origin?: [number, number];
}
export interface VisualAssetSpec { width: number; height: number; parts: VisualAssetPart[] }
export const VISUAL_ASSETS: Record<VisualAsset, VisualAssetSpec>;
export function buildVisualAsset(document: Document, id: string): SVGSVGElement | null;
