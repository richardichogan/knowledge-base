/**
 * features/canvas/mapVisuals.ts — labels and icons for canvas cards.
 */
import { Document, Calendar, Chat, Blog, Idea, Notebook, Earth, Light, Category, Help, Choices, ThumbsUp, ThumbsDown, WarningAlt, Task, DecisionTree, Bookmark } from '@carbon/icons-react';
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

/** Brainstorm card types for idea cards, each with its own icon and colours (tile tint, icon, label ink). */
export const CARD_TYPES = [
  { id: 'topic', label: 'Topic', icon: Category, tint: '#d9fbfb', colour: '#007d79', ink: '#005d5d' },
  { id: 'subject', label: 'Subject', icon: Bookmark, tint: '#f4f4f4', colour: '#525252', ink: '#393939' },
  { id: 'idea', label: 'Idea', icon: Light, tint: '#fcf4d6', colour: '#b28600', ink: '#8e6a00' },
  { id: 'question', label: 'Question', icon: Help, tint: '#f6f2ff', colour: '#8a3ffc', ink: '#6929c4' },
  { id: 'option', label: 'Option', icon: Choices, tint: '#edf5ff', colour: '#0f62fe', ink: '#0043ce' },
  { id: 'pro', label: 'Pro', icon: ThumbsUp, tint: '#defbe6', colour: '#24a148', ink: '#0e6027' },
  { id: 'con', label: 'Con', icon: ThumbsDown, tint: '#fff1f1', colour: '#da1e28', ink: '#a2191f' },
  { id: 'risk', label: 'Risk', icon: WarningAlt, tint: '#fff2e8', colour: '#eb6200', ink: '#8a3800' },
  { id: 'action', label: 'Action', icon: Task, tint: '#e5f6ff', colour: '#0072c3', ink: '#00539a' },
  { id: 'decision', label: 'Decision', icon: DecisionTree, tint: '#fff0f7', colour: '#d02670', ink: '#9f1853' },
] as const;
export type CardTypeDef = typeof CARD_TYPES[number];

/** An idea card's type: its saved type, or Topic for the centre card and Idea otherwise. Null for linked cards. */
/** True only when the card has real footnote text (older servers send no footnote field). */
export function hasFootnote(node: Partial<Pick<CanvasNodeApi, 'footnote'>>): boolean {
  return typeof node.footnote === 'string' && node.footnote.trim() !== '';
}

export function ideaCardType(node: Pick<CanvasNodeApi, 'refType' | 'cardType'>, isRoot: boolean): CardTypeDef | null {
  if (node.refType !== null) return null;
  const id = node.cardType ?? (isRoot ? 'topic' : 'idea');
  return CARD_TYPES.find((t) => t.id === id) ?? CARD_TYPES.find((t) => t.id === 'idea') ?? CARD_TYPES[0];
}

/** What a card is, as shown on it: its saved kind (e.g. "Meeting") or its type. */
export function cardKindLabel(node: Pick<CanvasNodeApi, 'refType' | 'tags'> & Partial<Pick<CanvasNodeApi, 'cardType'>>, isRoot = false): string {
  if (node.refType === null) return ideaCardType({ refType: null, cardType: node.cardType ?? null }, isRoot)?.label ?? 'Idea';
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

export function cardIcon(node: Pick<CanvasNodeApi, 'refType' | 'tags'> & Partial<Pick<CanvasNodeApi, 'cardType'>>, isRoot = false): CarbonIconType {
  if (node.refType === null) return ideaCardType({ refType: null, cardType: node.cardType ?? null }, isRoot)?.icon ?? Light;
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
