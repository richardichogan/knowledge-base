export interface NoteContentBlock { type?: string; props?: { level?: number }; content?: unknown; children?: NoteContentBlock[] }

/** Renders a link chip as text; returning '' drops it. */
export type MentionText = (type: string, id: string) => string;

function contentText(value: unknown, mention?: MentionText, scriptAnnotations = false): string {
  if (Array.isArray(value)) return value.map(item => contentText(item, mention, scriptAnnotations)).join('');
  if (value === null || typeof value !== 'object') return '';
  if ('type' in value && value.type === 'scriptCue' && 'props' in value
    && value.props !== null && typeof value.props === 'object' && 'cue' in value.props) {
    return `[${value.props.cue === 'beat' ? 'beat' : 'pause'}]`;
  }
  if (mention && 'type' in value && (value.type === 'noteMention' || value.type === 'entityMention')
    && 'props' in value && value.props !== null && typeof value.props === 'object') {
    const props = value.props as Record<string, unknown>;
    const type = value.type === 'noteMention' ? 'note' : props['entityType'];
    const id = value.type === 'noteMention' ? props['noteId'] : props['entityId'];
    return typeof type === 'string' && typeof id === 'string' ? mention(type, id) : '';
  }
  if ('text' in value && typeof value.text === 'string') {
    return scriptAnnotations ? annotateScriptText(value.text, 'styles' in value ? value.styles : undefined) : value.text;
  }
  if ('rows' in value && Array.isArray(value.rows)) {
    return value.rows.map(row => {
      if (row === null || typeof row !== 'object' || !('cells' in row) || !Array.isArray(row.cells)) return '';
      return row.cells.map((cell: unknown) => contentText(cell, mention, scriptAnnotations)).join(' | ');
    }).join('\n');
  }
  return 'content' in value ? contentText(value.content, mention, scriptAnnotations) : '';
}

/** Keeps table rows and cell boundaries as well as nested block text. */
export function extractNoteBlockText(blocks: NoteContentBlock[], mention?: MentionText, scriptAnnotations = false): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = contentText(block.content, mention, scriptAnnotations);
    const heading = scriptAnnotations && block.type === 'heading'
      ? scriptHeadingPrefix(block.props?.level) : '';
    if (text.trim() !== '') parts.push(heading + text.trim());
    if (Array.isArray(block.children)) {
      const childText = extractNoteBlockText(block.children, mention, scriptAnnotations);
      if (childText !== '') parts.push(childText);
    }
  }
  return parts.join('\n');
}
import { annotateScriptText, scriptHeadingPrefix } from '../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
