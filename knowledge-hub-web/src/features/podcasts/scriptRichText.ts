import { scriptAnnotationRuns, scriptHeadingPrefix } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
import type { JSONContent } from '@tiptap/core';
import { parseScriptBullets, SCRIPT_BULLET } from './scriptFormatting';

export { SCRIPT_COLOUR_VALUES } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
export type ScriptRichNode = JSONContent;
export const SCRIPT_BLOCK_STYLES = [
  { value: '0', label: 'Spoken text' },
  { value: '1', label: 'Script title' },
  { value: '2', label: 'Chapter' },
  { value: '3', label: 'Section heading' },
] as const;

export function scriptRichDocument(text: string, bullets = false): ScriptRichNode {
  if (bullets) {
    const items = parseScriptBullets(text, text.length).bullets;
    return { type: 'doc', content: [{ type: 'bulletList', content: (items.length ? items : ['']).map(item => ({
      type: 'listItem', content: scriptRichDocument(item).content ?? [],
    })) }] };
  }
  const paragraphs: ScriptRichNode[] = [{ type: 'paragraph', content: [] }];
  for (const run of scriptAnnotationRuns(text.replace(/\r\n?/g, '\n'))) {
    if (run.cue) {
      paragraphs.at(-1)!.content!.push({ type: 'scriptCue', attrs: { cue: run.cue } });
      continue;
    }
    for (const part of run.text.split(/(\n\n|\n)/)) {
      if (part === '\n\n') paragraphs.push({ type: 'paragraph', content: [] });
      else if (part === '\n') paragraphs.at(-1)!.content!.push({ type: 'hardBreak' });
      else if (part) paragraphs.at(-1)!.content!.push({ type: 'text', text: part,
        ...(run.colour ? { marks: [{ type: 'scriptColour', attrs: { colour: run.colour } }] } : {}) });
    }
  }
  const blocks = paragraphs.flatMap(paragraph => {
    const lines: ScriptRichNode[][] = [[]];
    for (const node of paragraph.content ?? []) {
      if (node.type === 'hardBreak') lines.push([]);
      else lines.at(-1)!.push(node);
    }
    const result: ScriptRichNode[] = [];
    for (const line of lines) {
      const marker = /^(#{1,6})[ \t]+/.exec(line.map(node => node.text ?? '\uFFFC').join(''));
      if (marker) {
        let remaining = marker[0].length;
        const content = line.flatMap(node => {
          if (node.type !== 'text') return [node];
          const remove = Math.min(remaining, node.text?.length ?? 0);
          remaining -= remove;
          const text = node.text?.slice(remove);
          return text ? [{ ...node, text }] : [];
        });
        result.push({ type: 'heading', attrs: { level: marker[1]!.length }, content });
      } else if (result.at(-1)?.type === 'paragraph') {
        result.at(-1)!.content!.push({ type: 'hardBreak' }, ...line);
      } else result.push({ type: 'paragraph', content: line });
    }
    return result;
  });
  return { type: 'doc', content: blocks };
}

/** Serialise the editor, including a bounded selection, to the existing Athena/podcast contract. */
export function scriptRichText(doc: ScriptRichNode, from = 0, to = Infinity, colours = true): string {
  let position = -1;
  const render = (node: ScriptRichNode): string => {
    if (node.type === 'text') {
      const start = position;
      position += node.text?.length ?? 0;
      const text = (node.text ?? '').slice(Math.max(0, from - start), Math.max(0, to - start));
      const colour = node.marks?.find(mark => mark.type === 'scriptColour')?.attrs?.['colour'];
      return colours && text && (colour === 'teal' || colour === 'yellow' || colour === 'pink')
        ? `[colour=${colour}]${text}[/colour]` : text;
    }
    if (node.type === 'scriptCue' || node.type === 'hardBreak') {
      const included = position >= from && position < to;
      position++;
      return included ? node.type === 'hardBreak' ? '\n' : `[${node.attrs?.['cue'] === 'beat' ? 'beat' : 'pause'}]` : '';
    }
    const start = position;
    position++;
    const children = node.content ?? [];
    const text = children.map((child, index) => {
      const included = position >= from && position < to;
      const separator = index > 0 && ['doc', 'listItem', 'bulletList'].includes(node.type ?? '') && included ? '\n\n' : '';
      const marker = node.type === 'listItem' && index === 0 && included ? SCRIPT_BULLET : '';
      return separator + marker + render(child);
    }).join('');
    position++;
    const heading = colours && node.type === 'heading' && from <= start && to > start
      ? scriptHeadingPrefix(node.attrs?.['level']) : '';
    return heading + text;
  };
  return render(doc);
}
