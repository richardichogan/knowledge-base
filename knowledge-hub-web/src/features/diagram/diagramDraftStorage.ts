import type { DiagramDocument } from './diagramTypes';

export const DIAGRAM_DRAFT_PREFIX = 'kh-diagram-draft-v1:';
const MAX_DRAFT_SIZE = 8_000_000;
export interface DiagramDraft {
  version: 1;
  identity: string;
  canvasId: string;
  draftId: string;
  baseRevision: number;
  updatedAt: string;
  document: DiagramDocument;
}

export function diagramDraftKey(identity: string, canvasId: string, draftId: string): string {
  return `${DIAGRAM_DRAFT_PREFIX}${encodeURIComponent(identity)}:${encodeURIComponent(canvasId)}:${encodeURIComponent(draftId)}`;
}

export function parseDiagramDraft(raw: string, identity: string, canvasId: string): DiagramDraft {
  if (raw.length > MAX_DRAFT_SIZE) throw new Error('The local diagram draft is too large to recover safely.');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('identity' in value) || value.identity !== identity || !('canvasId' in value) || value.canvasId !== canvasId
    || !('draftId' in value) || typeof value.draftId !== 'string' || !value.draftId
    || !('baseRevision' in value) || !Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0
    || !('updatedAt' in value) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !('document' in value) || !value.document || typeof value.document !== 'object') {
    throw new Error('Invalid local diagram draft. Its stored contents have not been changed.');
  }
  const document = value.document;
  if (!('version' in document) || document.version !== 1 || !('nodes' in document) || !Array.isArray(document.nodes)
    || !('edges' in document) || !Array.isArray(document.edges) || !('viewport' in document)
    || !document.viewport || typeof document.viewport !== 'object') {
    throw new Error('Unsupported local diagram draft. Its stored contents have not been changed.');
  }
  const record = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  const point = (item: unknown): boolean => record(item) && typeof item['x'] === 'number' && Number.isFinite(item['x'])
    && typeof item['y'] === 'number' && Number.isFinite(item['y']);
  if (!point(document.viewport) || !('zoom' in document.viewport) || typeof document.viewport.zoom !== 'number'
    || !Number.isFinite(document.viewport.zoom) || document.viewport.zoom <= 0
    || document.nodes.some((node: unknown) => !record(node) || typeof node['id'] !== 'string'
      || typeof node['label'] !== 'string' || typeof node['kind'] !== 'string'
      || !point(node) || typeof node['width'] !== 'number' || typeof node['height'] !== 'number'
      || typeof node['fill'] !== 'string' || typeof node['stroke'] !== 'string'
      || typeof node['textColor'] !== 'string' || typeof node['fontSize'] !== 'number')
    || document.edges.some((edge: unknown) => !record(edge) || typeof edge['id'] !== 'string'
      || typeof edge['sourceId'] !== 'string' || typeof edge['targetId'] !== 'string'
      || typeof edge['label'] !== 'string' || typeof edge['stroke'] !== 'string'
      || !Array.isArray(edge['waypoints']) || edge['waypoints'].some(item => !point(item)))) {
    throw new Error('Damaged local diagram draft. Its stored contents have not been changed.');
  }
  return value as DiagramDraft;
}

export function storeDiagramDraft(storage: Storage, draft: DiagramDraft): string {
  const raw = JSON.stringify(draft);
  parseDiagramDraft(raw, draft.identity, draft.canvasId);
  storage.setItem(diagramDraftKey(draft.identity, draft.canvasId, draft.draftId), raw);
  return raw;
}

export function listDiagramDrafts(storage: Storage, identity: string, canvasId: string): DiagramDraft[] {
  const prefix = diagramDraftKey(identity, canvasId, '');
  const drafts: DiagramDraft[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const draft = parseDiagramDraft(raw, identity, canvasId);
    if (diagramDraftKey(identity, canvasId, draft.draftId) !== key) throw new Error('Local diagram draft identity mismatch.');
    drafts.push(draft);
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function removeDiagramDraftIfUnchanged(storage: Storage, key: string, raw: string): boolean {
  if (storage.getItem(key) !== raw) return false;
  storage.removeItem(key);
  return true;
}
