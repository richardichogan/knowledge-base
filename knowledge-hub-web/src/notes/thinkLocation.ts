export type ThinkLocation = { view: 'canvas'; id: string; footnote?: number }
  | { view: 'notes'; id: string } | { view: 'sparks' } | null;

export function readThinkLocation(params: URLSearchParams): ThinkLocation {
  const mapId = params.get('mapId');
  if (mapId) {
    const footnote = Number(params.get('footnote'));
    return { view: 'canvas', id: mapId, ...(Number.isInteger(footnote) && footnote > 0 ? { footnote } : {}) };
  }
  if (params.get('view') === 'sparks') return { view: 'sparks' };
  const noteId = params.get('noteId');
  return noteId ? { view: 'notes', id: noteId } : null;
}

export function diagramLocation(params: URLSearchParams, id: string): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('mapId', id);
  for (const key of ['noteId', 'footnote', 'view']) next.delete(key);
  return next;
}
