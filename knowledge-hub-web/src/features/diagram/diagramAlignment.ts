import type { DiagramNode, DiagramPoint } from './diagramTypes';

export interface AlignmentGuide { axis: 'x' | 'y'; value: number }

export function alignMovingBounds(
  bounds: { x: number; y: number; width: number; height: number },
  others: readonly DiagramNode[], delta: DiagramPoint, tolerance: number,
): { delta: DiagramPoint; guides: AlignmentGuide[] } {
  const result = { ...delta };
  const guides: AlignmentGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const dimension = axis === 'x' ? 'width' : 'height';
    const moving = [0, bounds[dimension] / 2, bounds[dimension]].map(offset => bounds[axis] + delta[axis] + offset);
    let best = tolerance + Number.EPSILON;
    let correction = 0;
    let target: number | undefined;
    for (const node of others) {
      for (const value of [node[axis], node[axis] + node[dimension] / 2, node[axis] + node[dimension]]) {
        for (const valueMoving of moving) {
          const difference = value - valueMoving;
          if (Math.abs(difference) < best) {
            best = Math.abs(difference); correction = difference; target = value;
          }
        }
      }
    }
    if (target !== undefined) { result[axis] += correction; guides.push({ axis, value: target }); }
  }
  return { delta: result, guides };
}

export function diagramGridSize(value: unknown): number {
  return value === 5 || value === 10 || value === 20 || value === 40 ? value : 10;
}
