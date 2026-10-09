import type { DiagramNode } from './diagramTypes';

export function diagramBorderDash(node: DiagramNode): string | undefined {
  const width = node.strokeWidth ?? 1.5;
  if (node.strokeStyle === 'dashed') return `${width * 4} ${width * 3}`;
  if (node.strokeStyle === 'dotted') return `0 ${width * 3}`;
  return undefined;
}
