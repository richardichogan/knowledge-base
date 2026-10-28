import { parseNoteContent } from './noteContent.js';

const LABELS = {
  important: 'Important',
  followUp: 'Follow-up',
  question: 'Question',
  risk: 'Risk',
  issue: 'Issue',
} as const;

export type PassageTagKind = keyof typeof LABELS;
export interface NotePassageTag {
  id: string;
  kind: PassageTagKind;
  label: string;
  text: string;
}

/** Read the inline marks, not the displayed quote: edits and repeated text keep their identity. */
export function notePassageTags(content: string): NotePassageTag[] {
  const found = new Map<string, NotePassageTag>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.text === 'string' && item.styles !== null && typeof item.styles === 'object' && !Array.isArray(item.styles)) {
      const styles = item.styles as Record<string, unknown>;
      for (const kind of Object.keys(LABELS) as PassageTagKind[]) {
        const id = styles[kind];
        if (typeof id !== 'string' || id === '') continue;
        const key = `${kind}:${id}`;
        const existing = found.get(key);
        if (existing) existing.text += item.text;
        else found.set(key, { id, kind, label: LABELS[kind], text: item.text });
      }
    }
    for (const [key, child] of Object.entries(item)) {
      if (key !== 'styles') visit(child);
    }
  };
  visit(parseNoteContent(content).blocks);
  return [...found.values()].filter(tag => tag.text.length > 0);
}
