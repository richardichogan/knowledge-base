interface CanvasParent {
  id: string;
  title: string;
  parentCanvasId?: string | null;
}

export interface CanvasHierarchyRow<T> { canvas: T; depth: number; parentTitle: string | null }

/** Preserve sibling order, keep children next to their parent, and retain filtered/orphaned items. */
export function canvasHierarchy<T extends CanvasParent>(canvases: readonly T[]): CanvasHierarchyRow<T>[] {
  const byId = new Map(canvases.map(canvas => [canvas.id, canvas]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const canvas of canvases) {
    const parent = canvas.parentCanvasId;
    if (parent === undefined || parent === null || !byId.has(parent) || parent === canvas.id) roots.push(canvas);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(canvas);
      children.set(parent, siblings);
    }
  }
  const rows: CanvasHierarchyRow<T>[] = [];
  const visited = new Set<string>();
  const append = (canvas: T, depth: number, parentTitle: string | null): void => {
    if (visited.has(canvas.id)) return;
    visited.add(canvas.id);
    rows.push({ canvas, depth, parentTitle });
    for (const child of children.get(canvas.id) ?? []) append(child, depth + 1, canvas.title);
  };
  for (const canvas of roots) append(canvas, 0, null);
  // A legacy cycle must not hide a canvas or recurse forever.
  for (const canvas of canvases) if (!visited.has(canvas.id)) append(canvas, 0, null);
  return rows;
}
