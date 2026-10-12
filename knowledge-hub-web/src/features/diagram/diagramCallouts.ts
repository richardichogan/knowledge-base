import type { DiagramCalloutType, DiagramNode } from './diagramTypes';

/** Original 20-unit outline glyphs shared by the canvas and image exports. */
export const DIAGRAM_CALLOUTS: Record<DiagramCalloutType, { label: string; path: string }> = {
  question: { label: 'Question', path: 'M10 2a8 8 0 1 0 0 16a8 8 0 1 0 0-16 M7.5 7a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4 M10 14v.1' },
  risk: { label: 'Risk', path: 'M10 2L19 18H1Z M10 7v5 M10 15v.1' },
  issue: { label: 'Issue', path: 'M6 2h8l4 4v8l-4 4H6l-4-4V6Z M7 7l6 6 M13 7l-6 6' },
  assumption: { label: 'Assumption', path: 'M6 17h8 M7 14h6 M7 14v-2a5 5 0 1 1 6 0v2 M9 19h2' },
  decision: { label: 'Decision', path: 'M10 1l9 9-9 9-9-9Z M6 10l3 3 5-6' },
  action: { label: 'Action', path: 'M3 10h14 M11 4l6 6-6 6' },
};

export function calloutLayout(node: DiagramNode): {
  type: DiagramCalloutType; label: string; path: string; height: number;
  icon: { x: number; y: number; size: number }; text: { x: number; y: number; fontSize: number };
} | null {
  if (node.kind !== 'text' || node.calloutType === undefined) return null;
  const definition = DIAGRAM_CALLOUTS[node.calloutType];
  const height = Math.min(32, node.height / 2);
  const size = Math.max(0, Math.min(16, height - 8, node.width - 8));
  return { type: node.calloutType, ...definition, height,
    icon: { x: node.x + 4, y: node.y + (height - size) / 2, size },
    text: { x: node.x + 4 + size + 6, y: node.y + height / 2, fontSize: Math.min(12, height / 2, Math.max(0, (node.width - size - 14) / (definition.label.length * 0.56))) },
  };
}
