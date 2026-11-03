interface CanvasListItem {
  project: string | null;
  parentCanvasId?: string | null;
}

export interface CanvasProjectGroup<T> {
  key: string;
  label: string;
  canvases: T[];
}

/** Group root canvases by project, preserving canvas order within each group. */
export function canvasGroupsByProject<T extends CanvasListItem>(
  canvases: readonly T[],
  projectNames: ReadonlyMap<string, string>,
): CanvasProjectGroup<T>[] {
  const groups = new Map<string, CanvasProjectGroup<T>>();
  for (const canvas of canvases) {
    if (canvas.parentCanvasId !== undefined && canvas.parentCanvasId !== null) continue;

    const projectId = canvas.project?.trim() || null;
    const projectName = projectId === null ? undefined : projectNames.get(projectId)?.trim() || undefined;
    const key = projectName === undefined ? '__none__' : projectId ?? '__none__';
    const label = projectName ?? 'General';
    const group = groups.get(key) ?? { key, label, canvases: [] };
    group.canvases.push(canvas);
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return a.label.localeCompare(b.label);
  });
}
