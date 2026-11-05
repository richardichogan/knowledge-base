export interface NoteContentBlock { id?: string; type?: string; props?: { level?: number; scriptSection?: boolean; scriptDirection?: string; scriptVisuals?: string }; content?: unknown; children?: NoteContentBlock[] }

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
    if (scriptAnnotations && block.props?.scriptSection) {
      parts.push(`[Script section id: ${block.id ?? 'not assigned'}]`);
      if (block.props.scriptVisuals) parts.push('[Linked presentation visuals: use read_script_visuals for full saved scenes and cues.]');
    }

    if (Array.isArray(block.children)) {
      const childText = extractNoteBlockText(block.children, mention, scriptAnnotations);
      if (childText !== '') parts.push(childText);
    }
  }
  return parts.join('\n');
}

export function scriptSectionContext(blocks: NoteContentBlock[], activeBlockId: string, selectedText: string): string {
  const contains = (block: NoteContentBlock): boolean => block.id === activeBlockId || (block.children ?? []).some(contains);
  const section = blocks.find(block => block.props?.scriptSection && contains(block));
  if (!section) return '';
  return `\n[Active script section id: ${section.id ?? 'not assigned'}]\n[Active block id: ${activeBlockId}]`
    + visualContext(section)
    + (selectedText ? `\n[Selected script text${selectedText.length > 4000 ? ' (truncated)' : ''}: ${selectedText.slice(0, 4000)}]` : '');
}
function visualContext(section: NoteContentBlock): string {
  if (!section.props?.scriptVisuals) return '\n[No presentation visuals for this section.]';
  try {
    const visuals = parseScriptVisuals(section.props.scriptVisuals);
    const content = JSON.stringify(visuals.scenes);
    return `\n[Visuals ${visualSourceCurrent(visuals.source, section) ? 'current' : 'stale'}: ${content.length <= 12000 ? content : 'scene data exceeds page context; call read_script_visuals with the section id before answering'}]`;
  } catch (error) { return `\n[Visual access failed: ${error instanceof Error ? error.message : 'invalid visual metadata'}. Do not claim to have read these scenes.]`; }
}
import { annotateScriptText, scriptHeadingPrefix } from '../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
import { parseScriptVisuals, visualSourceCurrent } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';
