export type ThinkLocation = { view: 'canvas'; id: string; footnote?: number }
  | { view: 'notes'; id: string } | { view: 'sparks' } | { view: 'designs'; id?: string } | null;

export function readThinkLocation(params: URLSearchParams): ThinkLocation {
  const mapId = params.get('mapId');
  if (mapId) {
    const footnote = Number(params.get('footnote'));
    return { view: 'canvas', id: mapId, ...(Number.isInteger(footnote) && footnote > 0 ? { footnote } : {}) };
  }
  if (params.get('view') === 'sparks') return { view: 'sparks' };
  const designId = params.get('design');
  if (designId || params.get('view') === 'designs') return { view: 'designs', ...(designId ? { id: designId } : {}) };
  const noteId = params.get('noteId');
  return noteId ? { view: 'notes', id: noteId } : null;
}

export function diagramLocation(params: URLSearchParams, id: string): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('mapId', id);
  for (const key of ['noteId', 'footnote', 'view', 'design', 'episode', 'tab', 'asset']) next.delete(key);
  return next;
}
