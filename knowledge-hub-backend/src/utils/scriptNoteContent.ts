import { scriptInlineParts, type ScriptInlineContent } from '../podcasts/scriptAnnotations.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Interpret delivery annotations without flattening Markdown formatting, links or block structure. */
export function scriptNoteBlocks(blocks: unknown[]): unknown[] {
  const parts: { text: string; styles: Record<string, string | boolean> }[] = [];
  const nodes: Record<string, unknown>[] = [];
  const keys = ['content', 'children', 'rows', 'cells'] as const;
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const item = record(value);
    if (!item || item['type'] === 'codeBlock') return;
    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      const styles: Record<string, string | boolean> = {};
      for (const [key, style] of Object.entries(record(item['styles']) ?? {})) {
        if (typeof style !== 'string' && typeof style !== 'boolean') throw new Error('Script text contains an unsupported style.');
        styles[key] = style;
      }
      parts.push({ text: item['text'], styles });
      nodes.push(item);
    } else keys.forEach(key => { collect(item[key]); });
  };
  collect(blocks);
  const converted = scriptInlineParts(parts);
  const replacements = new Map<Record<string, unknown>, ScriptInlineContent[]>(nodes.map((node, index) => [node, converted[index]!]));
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.flatMap(item => {
      const node = record(item);
      return node && replacements.has(node) ? replacements.get(node)! : [replace(item)];
    });
    const item = record(value);
    if (!item || item['type'] === 'codeBlock') return value;
    const next = { ...item };
    keys.forEach(key => { if (key in item) next[key] = replace(item[key]); });
    return next;
  };
  return blocks.map(replace);
}
