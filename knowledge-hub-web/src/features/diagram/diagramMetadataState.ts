export interface DiagramMetadataDraft {
  title: string;
  description: string;
  project: string;
  usedIn: string[];
  tagIds: string[];
}

export function metadataDraft(canvas: { title: string; description?: string | null; project?: string | null; usedInProjectIds?: string[]; tagIds?: string[] }): DiagramMetadataDraft {
  return { title: canvas.title, description: canvas.description ?? '', project: canvas.project ?? '',
    usedIn: canvas.usedInProjectIds ?? [], tagIds: canvas.tagIds ?? [] };
}

function equal(left: string | string[], right: string | string[]): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()) : left === right;
}

/** Rebase untouched fields, keeping newer typing and reporting overlapping external changes. */
export function reconcileMetadata(local: DiagramMetadataDraft, base: DiagramMetadataDraft, saved: DiagramMetadataDraft): {
  draft: DiagramMetadataDraft; conflicts: string[];
} {
  let draft = { ...local };
  const conflicts: string[] = [];
  for (const key of ['title', 'description', 'project', 'usedIn', 'tagIds'] as const) {
    if (equal(local[key], base[key])) draft = { ...draft, [key]: saved[key] };
    else if (!equal(saved[key], base[key]) && !equal(local[key], saved[key])) conflicts.push(key);
  }
  return { draft, conflicts };
}

export function metadataPatch(draft: DiagramMetadataDraft, base: DiagramMetadataDraft): {
  title?: string; description?: string; project?: string | null; usedInProjectIds?: string[]; tagIds?: string[];
} {
  return {
    ...(draft.title.trim() !== base.title ? { title: draft.title.trim() } : {}),
    ...(draft.description !== base.description ? { description: draft.description } : {}),
    ...(draft.project !== base.project ? { project: draft.project || null } : {}),
    ...(!equal(draft.usedIn, base.usedIn) || draft.project !== base.project ? { usedInProjectIds: draft.usedIn.filter(id => id !== draft.project) } : {}),
    ...(!equal(draft.tagIds, base.tagIds) ? { tagIds: draft.tagIds } : {}),
  };
}
