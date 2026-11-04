import { scriptAnnotationRuns } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
import type { JSONContent } from '@tiptap/core';
import { parseScriptBullets, SCRIPT_BULLET } from './scriptFormatting';

export { SCRIPT_COLOUR_VALUES } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
export type ScriptRichNode = JSONContent;

export function scriptRichDocument(text: string, bullets = false): ScriptRichNode {
  if (bullets) {
    const items = parseScriptBullets(text, text.length).bullets;
    return { type: 'doc', content: [{ type: 'bulletList', content: (items.length ? items : ['']).map(item => ({
      type: 'listItem', content: scriptRichDocument(item).content ?? [],
    })) }] };
  }
  const paragraphs: ScriptRichNode[] = [{ type: 'paragraph', content: [] }];
  for (const run of scriptAnnotationRuns(text)) {
    if (run.cue) {
      paragraphs.at(-1)!.content!.push({ type: 'scriptCue', attrs: { cue: run.cue } });
      continue;
    }
    const parts = run.text.split(/(\n\n|\n)/);
    for (const part of parts) {
      if (part === '\n\n') paragraphs.push({ type: 'paragraph', content: [] });
      else if (part === '\n') paragraphs.at(-1)!.content!.push({ type: 'hardBreak' });
      else if (part) paragraphs.at(-1)!.content!.push({ type: 'text', text: part,
        ...(run.colour ? { marks: [{ type: 'scriptColour', attrs: { colour: run.colour } }] } : {}) });
    }
  }
  return { type: 'doc', content: paragraphs };
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
    position++;
    const children = node.content ?? [];
    const text = children.map((child, index) => {
      const included = position >= from && position < to;
      const separator = index > 0 && ['doc', 'listItem', 'bulletList'].includes(node.type ?? '') && included ? '\n\n' : '';
      const marker = node.type === 'listItem' && index === 0 && included ? SCRIPT_BULLET : '';
      return separator + marker + render(child);
    }).join('');
    position++;
    return text;
  };
  return render(doc);
}
