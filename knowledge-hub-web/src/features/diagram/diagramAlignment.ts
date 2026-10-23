import type { DiagramNode, DiagramPoint } from './diagramTypes';

type Axis = 'x' | 'y';
interface Bounds { x: number; y: number; width: number; height: number }
export interface AlignmentGuide { axis: Axis; value: number; kind: 'edge' | 'centre' }
export interface SpacingIndicator { axis: Axis; start: number; end: number; position: number; gap: number; equal: boolean }

export const gridSnapEnabled = (doc: { grid: boolean; snapToGrid?: boolean }): boolean => doc.snapToGrid ?? doc.grid;
export const shapeSnapEnabled = (doc: { snapToShapes?: boolean }): boolean => doc.snapToShapes ?? true;

export function alignMovingBounds(
  bounds: Bounds, others: readonly DiagramNode[], delta: DiagramPoint, tolerance: number, snapping = true,
): { delta: DiagramPoint; guides: AlignmentGuide[] } {
  const result = { ...delta };
  const guides: AlignmentGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const dimension = axis === 'x' ? 'width' : 'height';
    const moving = [0, bounds[dimension] / 2, bounds[dimension]].map(offset => bounds[axis] + delta[axis] + offset);
    let best = tolerance + Number.EPSILON;
    let correction = 0;
    let found = false;
    for (const node of others) {
      for (const value of [node[axis], node[axis] + node[dimension] / 2, node[axis] + node[dimension]]) {
        for (const valueMoving of moving) {
          const difference = value - valueMoving;
          if (Math.abs(difference) < best) {
            best = Math.abs(difference); correction = difference; found = true;
          }
        }
      }
    }
    if (found && snapping) result[axis] += correction;
    const aligned = [0, bounds[dimension] / 2, bounds[dimension]].map(offset => bounds[axis] + result[axis] + offset);
    const values = new Map<number, AlignmentGuide>();
    for (const node of others) {
      [node[axis], node[axis] + node[dimension] / 2, node[axis] + node[dimension]].forEach((value, index) => {
        if (aligned.some(position => Math.abs(position - value) <= (snapping ? 0.01 : tolerance))) {
          values.set(value, { axis, value, kind: index === 1 ? 'centre' : 'edge' });
        }
      });
    }
    guides.push(...values.values());
  }
  return { delta: result, guides };
}

/** Nearest visible gaps, plus equal-spacing targets between or alongside adjacent shapes. */
export function spaceMovingBounds(
  bounds: Bounds, others: readonly DiagramNode[], delta: DiagramPoint, tolerance: number,
  snapping = true, lockedAxes: readonly Axis[] = [],
): { delta: DiagramPoint; indicators: SpacingIndicator[] } {
  const result = { ...delta };
  const indicators: SpacingIndicator[] = [];
  for (const axis of ['x', 'y'] as const) {
    const dimension = axis === 'x' ? 'width' : 'height';
    const cross = axis === 'x' ? 'y' : 'x';
    const crossDimension = axis === 'x' ? 'height' : 'width';
    const moving = { ...bounds, x: bounds.x + result.x, y: bounds.y + result.y };
    const nearby = others.filter(node => node[cross] < moving[cross] + moving[crossDimension]
      && node[cross] + node[crossDimension] > moving[cross]);
    const before = nearby.filter(node => node[axis] + node[dimension] <= moving[axis])
      .sort((a, b) => b[axis] + b[dimension] - a[axis] - a[dimension]);
    const after = nearby.filter(node => node[axis] >= moving[axis] + moving[dimension])
      .sort((a, b) => a[axis] - b[axis]);
    const a = before[0];
    const b = after[0];
    const gapBefore = a ? moving[axis] - a[axis] - a[dimension] : undefined;
    const gapAfter = b ? b[axis] - moving[axis] - moving[dimension] : undefined;
    const previous = before[1];
    const following = after[1];
    const referenceBefore = a && previous ? a[axis] - previous[axis] - previous[dimension] : undefined;
    const referenceAfter = b && following ? following[axis] - b[axis] - b[dimension] : undefined;
    const candidates: number[] = [];
    if (gapBefore !== undefined && gapAfter !== undefined) candidates.push((gapAfter - gapBefore) / 2);
    if (gapBefore !== undefined && referenceBefore !== undefined && referenceBefore >= 0) candidates.push(referenceBefore - gapBefore);
    if (gapAfter !== undefined && referenceAfter !== undefined && referenceAfter >= 0) candidates.push(gapAfter - referenceAfter);
    const correction = candidates.filter(value => Math.abs(value) <= tolerance).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    if (snapping && !lockedAxes.includes(axis) && correction !== undefined) {
      moving[axis] += correction; result[axis] += correction;
    }
    const leftGap = a ? moving[axis] - a[axis] - a[dimension] : undefined;
    const rightGap = b ? b[axis] - moving[axis] - moving[dimension] : undefined;
    const same = (left: number | undefined, right: number | undefined): boolean =>
      left !== undefined && right !== undefined && Math.abs(left - right) < 0.5;
    const position = moving[cross] + moving[crossDimension] / 2;
    if (a && leftGap !== undefined) {
      const equal = same(leftGap, rightGap) || same(leftGap, referenceBefore);
      indicators.push({ axis, start: a[axis] + a[dimension], end: moving[axis], position, gap: leftGap, equal });
      if (previous && same(leftGap, referenceBefore)) indicators.push({ axis, start: previous[axis] + previous[dimension],
        end: a[axis], position, gap: referenceBefore!, equal: true });
    }
    if (b && rightGap !== undefined) {
      const equal = same(rightGap, leftGap) || same(rightGap, referenceAfter);
      indicators.push({ axis, start: moving[axis] + moving[dimension], end: b[axis], position, gap: rightGap, equal });
      if (following && same(rightGap, referenceAfter)) indicators.push({ axis, start: b[axis] + b[dimension],
        end: following[axis], position, gap: referenceAfter!, equal: true });
    }
  }
  return { delta: result, indicators };
}

export function diagramGridSize(value: unknown): number {
  return value === 5 || value === 10 || value === 20 || value === 40 ? value : 10;
}
