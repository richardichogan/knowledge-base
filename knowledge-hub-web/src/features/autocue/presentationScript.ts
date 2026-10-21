import { extractNoteBlockText, type NoteContentBlock } from '../../notes/noteText';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function inline(value: unknown, depth = 0): string {
  if (depth > 50) throw new Error('This note is nested too deeply to present.');
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => inline(v, depth + 1)).join('');
  const item = record(value);
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  return inline(item.content, depth + 1);
}
export function presentationScript(contentJson: string): { text: string; warnings: string[] } {
  const raw: unknown = JSON.parse(contentJson);
  if (!Array.isArray(raw)) throw new Error('This note does not contain a supported block document.');
  let omitted = 0;
  const normalize = (blocks: unknown[], depth: number): NoteContentBlock[] => {
    if (depth > 50) throw new Error('This note is nested too deeply to present.');
    let number = 0;
    return blocks.map(value => {
      const block = record(value);
      if (!block) throw new Error('This note contains an invalid block.');
      const content = record(block.content);
      let text: string;
      if (block.type === 'table' && Array.isArray(content?.rows)) {
        text = content.rows.map(row => {
          const cells = record(row)?.cells;
          if (!Array.isArray(cells)) throw new Error('This note contains an unsupported table.');
          return cells.map(cell => inline(cell)).join(' | ');
        }).join('\n');
      } else {
        text = inline(block.content);
        if (block.type === 'numberedListItem') text = `${++number}. ${text}`;
        else {
          number = 0;
          if (block.type === 'bulletListItem') text = `- ${text}`;
          if (block.type === 'checkListItem') text = `[${record(block.props)?.checked === true ? 'x' : ' '}] ${text}`;
        }
      }
      if (!text.trim() && ['image', 'video', 'audio', 'file'].includes(String(block.type))) {
        omitted++;
        const caption = record(block.props)?.caption;
        if (typeof caption === 'string' && caption.trim()) text = caption;
      }
      return {
        content: [{ text: text ? `${'  '.repeat(depth)}${text}` : '' }],
        ...(Array.isArray(block.children) ? { children: normalize(block.children, depth + 1) } : {}),
      };
    });
  };
  const text = extractNoteBlockText(normalize(raw, 0));
  if (text.length > 500_000) throw new Error('This script exceeds the 500,000-character presentation limit.');
  return { text, warnings: omitted ? [`${omitted} media block(s) are represented by captions where available; media is not shown.`] : [] };
}
