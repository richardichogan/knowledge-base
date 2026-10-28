import type { DiagramPoint } from './diagramTypes';

type Axis = 'x' | 'y';
interface Bounds { x: number; y: number; width: number; height: number }
export interface AlignmentGuide { axis: Axis; value: number; kind: 'edge' | 'centre' }
export interface SpacingIndicator {
  axis: Axis; start: number; end: number; position: number; gap: number; equal: boolean;
  startCross?: number; endCross?: number;
}

export const gridSnapEnabled = (doc: { grid: boolean; snapToGrid?: boolean }): boolean => doc.snapToGrid ?? doc.grid;
export const shapeSnapEnabled = (doc: { snapToShapes?: boolean }): boolean => doc.snapToShapes ?? true;

export function alignMovingBounds(
  bounds: Bounds, others: readonly Bounds[], delta: DiagramPoint, tolerance: number, snapping = true,
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
  bounds: Bounds, others: readonly Bounds[], delta: DiagramPoint, tolerance: number,
  snapping = true, lockedAxes: readonly Axis[] = [], guideOffset = 0, crossTolerance = 0,
): { delta: DiagramPoint; indicators: SpacingIndicator[] } {
  const result = { ...delta };
  const indicators: SpacingIndicator[] = [];
  for (const axis of ['x', 'y'] as const) {
    const dimension = axis === 'x' ? 'width' : 'height';
    const cross = axis === 'x' ? 'y' : 'x';
    const crossDimension = axis === 'x' ? 'height' : 'width';
    const moving = { ...bounds, x: bounds.x + result.x, y: bounds.y + result.y };
    const nearby = others.filter(node => node[cross] < moving[cross] + moving[crossDimension] + crossTolerance
      && node[cross] + node[crossDimension] > moving[cross] - crossTolerance);
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
    const position = guideOffset === 0 ? moving[cross] + moving[crossDimension] / 2
      : Math.min(moving[cross], ...[a, b, previous, following].filter((node): node is Bounds => node !== undefined).map(node => node[cross])) - guideOffset;
    const add = (from: Bounds, to: Bounds, gap: number, equal: boolean): void => {
      indicators.push({ axis, start: from[axis] + from[dimension], end: to[axis], position, gap, equal,
        ...(guideOffset > 0 ? { startCross: from[cross], endCross: to[cross] } : {}) });
    };
    if (a && leftGap !== undefined) {
      const equal = same(leftGap, rightGap) || same(leftGap, referenceBefore);
      add(a, moving, leftGap, equal);
      if (previous && referenceBefore !== undefined && same(leftGap, referenceBefore)) add(previous, a, referenceBefore, true);
    }
    if (b && rightGap !== undefined) {
      const equal = same(rightGap, leftGap) || same(rightGap, referenceAfter);
      add(moving, b, rightGap, equal);
      if (following && referenceAfter !== undefined && same(rightGap, referenceAfter)) add(b, following, referenceAfter, true);
    }
  }
  return { delta: result, indicators };
}

/** Measure shape and equal-gap targets before grid rounding, independently on each axis. */
export function snapMovingBounds(
  bounds: Bounds, others: readonly Bounds[], raw: DiagramPoint,
  options: { zoom: number; gridSize: number | null; shapeSnapping: boolean; spacing?: boolean },
): { delta: DiagramPoint; guides: AlignmentGuide[]; indicators: SpacingIndicator[] } {
  const { zoom, gridSize, shapeSnapping } = options;
  const tolerance = 8 / zoom;
  const alignment = alignMovingBounds(bounds, others, raw, tolerance);
  const spacing = options.spacing === false ? undefined : spaceMovingBounds(bounds, others, raw, tolerance, true, [], 16 / zoom, 12 / zoom);
  const delta = { ...raw };
  for (const axis of ['x', 'y'] as const) {
    const candidates: number[] = [];
    if (shapeSnapping) {
      if (alignment.guides.some(guide => guide.axis === axis)) candidates.push(alignment.delta[axis]);
      if (spacing?.indicators.some(indicator => indicator.axis === axis && indicator.equal)) candidates.push(spacing.delta[axis]);
    }
    const nearest = candidates.sort((a, b) => Math.abs(a - raw[axis]) - Math.abs(b - raw[axis]))[0];
    delta[axis] = nearest ?? (gridSize === null ? raw[axis] : Math.round((bounds[axis] + raw[axis]) / gridSize) * gridSize - bounds[axis]);
  }
  return {
    delta,
    guides: alignMovingBounds(bounds, others, delta, 0.5 / zoom, false).guides,
    indicators: options.spacing === false ? [] : spaceMovingBounds(bounds, others, delta, 0.5 / zoom, false, [], 16 / zoom, 12 / zoom).indicators,
  };
}

export function diagramGridSize(value: unknown): number {
  return value === 5 || value === 10 || value === 20 || value === 40 ? value : 10;
}
