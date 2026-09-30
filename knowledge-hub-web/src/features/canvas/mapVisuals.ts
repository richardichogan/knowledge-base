/**
 * features/canvas/mapVisuals.ts — labels and icons for linked items on a map.
 */
import { Document, Calendar, Chat, Blog, Idea, Notebook, Earth } from '@carbon/icons-react';
import type { CarbonIconType } from '@carbon/icons-react';
import type { MapRefType, MapSuggestionApi } from '../../services/api';

/** Drag-and-drop type for a suggestion dragged from the side panel onto the map. */
export const SUGGESTION_DRAG_TYPE = 'application/x-athena-map-suggestion';

export const KIND_LABEL: Record<MapSuggestionApi['kind'], string> = {
  note: 'Think note', document: 'Library document', meeting: 'Meeting', post: 'Blog / newsletter', article: 'Discover article', chat: 'Athena chat',
};

export const REF_LABEL: Record<MapRefType, string> = {
  note: 'Think note', content_item: 'Linked item', spark: 'Spark', discover_item: 'Discover article', ai_session: 'Athena chat',
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

export function refIcon(refType: MapRefType): CarbonIconType {
  switch (refType) {
    case 'note': return Notebook;
    case 'content_item': return Document;
    case 'spark': return Idea;
    case 'discover_item': return Earth;
    case 'ai_session': return Chat;
  }
}
