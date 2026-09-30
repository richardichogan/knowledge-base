/**
 * features/canvas/mapVisuals.ts — labels and icons for canvas cards.
 */
import { Document, Calendar, Chat, Blog, Idea, Notebook, Earth, Light } from '@carbon/icons-react';
import type { CarbonIconType } from '@carbon/icons-react';
import type { CanvasNodeApi, MapSuggestionApi } from '../../services/api';

/** Drag-and-drop type for a suggestion dragged from the side panel onto the canvas. */
export const SUGGESTION_DRAG_TYPE = 'application/x-athena-map-suggestion';

export const KIND_LABEL: Record<MapSuggestionApi['kind'], string> = {
  note: 'Think note', document: 'Library document', meeting: 'Meeting', post: 'Blog / newsletter', article: 'Discover article', chat: 'Athena chat',
};

export function suggestionIcon(kind: MapSuggestionApi['kind']): CarbonIconType {
  switch (kind) {
    case 'note': return Notebook;
    case 'document': return Document;
    case 'meeting': return Calendar;
    case 'post': return Blog;
    case 'article': return Earth;
    case 'chat': return Chat;
  }
}

/** What a card is, as shown on it: its saved kind (e.g. "Meeting") or its type. */
export function cardKindLabel(node: Pick<CanvasNodeApi, 'refType' | 'tags'>): string {
  const saved = node.tags?.[0];
  if (saved !== undefined && saved !== '') return saved;
  switch (node.refType) {
    case 'note': return 'Think note';
    case 'content_item': return 'Library document';
    case 'spark': return 'Spark';
    case 'discover_item': return 'Discover article';
    case 'ai_session': return 'Athena chat';
    default: return 'Idea';
  }
}

export function cardIcon(node: Pick<CanvasNodeApi, 'refType' | 'tags'>): CarbonIconType {
  const kind = cardKindLabel(node);
  if (kind === 'Meeting') return Calendar;
  if (kind === 'Blog / newsletter') return Blog;
  switch (node.refType) {
    case 'note': return Notebook;
    case 'content_item': return Document;
    case 'spark': return Idea;
    case 'discover_item': return Earth;
    case 'ai_session': return Chat;
    default: return Light;
  }
}
