import type { VisualLink, VisualPort } from './visualComposition';
export interface VisualBounds { x: number; y: number; width: number; height: number }
export interface VisualConnectionNode { id: string; bounds: VisualBounds; anchor?: VisualBounds; obstacles?: VisualBounds[] }
export interface VisualRing { cx: number; cy: number; rx: number; ry: number; clockwise: boolean; path: string; angles: Map<string, number> }
export function connectionRing(links: VisualLink[], nodes: VisualConnectionNode[]): VisualRing | null;
export function connectionGeometry(from: VisualConnectionNode, to: VisualConnectionNode, link: VisualLink, nodes: VisualConnectionNode[], ring?: VisualRing | null,
  /** The endpoint shared with sibling connections (fan-out source or fan-in target); straight members align to its centre. */
  shared?: 'from' | 'to' | null,
  /** The far ends of every connection in the fan, so all branches turn on one trunk. */
  siblings?: VisualConnectionNode[]): {
  path: string;
  start: number[];
  end: number[];
  /** Original endpoint before the arrowhead pull-back; the arrow tip sits here. */
  tip: number[];
  samples: number[][];
  route: 'straight' | 'elbow' | 'ring';
  fromPort: VisualPort;
  toPort: VisualPort;
  label: { x: number; y: number; anchor: string };
};
