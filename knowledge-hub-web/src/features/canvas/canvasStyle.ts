import type { CanvasCardStyle, CanvasNodeApi } from '../../services/api';

export function canvasCardTier(depth: number): { width: number; fontSize: number } {
  if (depth === 0) return { width: 300, fontSize: 18 };
  if (depth === 1) return { width: 240, fontSize: 16 };
  if (depth === 2) return { width: 190, fontSize: 13.5 };
  if (depth === 3) return { width: 170, fontSize: 12 };
  return { width: 150, fontSize: 11 };
}

/** Tree depth sets the default title size; authored size overrides always win. */
export function canvasCardStyle(node: CanvasNodeApi, isRoot: boolean, pinned = false, depth = isRoot ? 0 : 1): Required<CanvasCardStyle> {
  return {
    fill: node.style?.fill ?? (isRoot ? '#f2fcfc' : '#ffffff'),
    stroke: node.style?.stroke ?? (isRoot || pinned ? '#007d79' : '#c6c6c6'),
    strokeStyle: node.style?.strokeStyle ?? 'solid',
    strokeWidth: node.style?.strokeWidth ?? (isRoot || pinned ? 2 : 1),
    textColor: node.style?.textColor ?? '#161616',
    fontSize: node.style?.fontSize ?? canvasCardTier(depth).fontSize,
  };
}

export function canvasBorderDash(style: Required<CanvasCardStyle>): string | undefined {
  if (style.strokeStyle === 'dashed') return `${style.strokeWidth * 4} ${style.strokeWidth * 4}`;
  if (style.strokeStyle === 'dotted') return `0 ${style.strokeWidth * 2}`;
  return undefined;
}
