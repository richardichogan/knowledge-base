const sentences = new Intl.Segmenter('en-GB', { granularity: 'sentence' });
export const SCRIPT_BULLET = '• ';

/** Give each spoken sentence a clear paragraph-sized gap. */
export function scriptSentenceLines(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').flatMap(line =>
    [...sentences.segment(line)].map(item => item.segment.trim()).filter(Boolean)).join('\n\n');
}

/** Unmarked continuation lines belong to the preceding bullet, not a new bullet. */
export function parseScriptBullets(raw: string, caret: number): { bullets: string[]; caret: number } {
  if (!raw.trim()) return { bullets: [], caret: 0 };
  const markers = [...raw.matchAll(/^[ \t]*(?:•|[-*](?=[ \t]))[ \t]?/gm)]
    .map(match => ({ start: match.index, prefix: match[0].length }));
  if (markers[0]?.start !== 0) markers.unshift({ start: 0, prefix: 0 });
  const bullets: string[] = [];
  let output = 0;
  let next: number | null = null;
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const end = markers[index + 1]?.start ?? raw.length;
    const contentStart = marker.start + marker.prefix;
    const chunk = raw.slice(contentStart, end);
    const content = index < markers.length - 1 ? chunk.replace(/\n+$/, '') : chunk;
    if (next === null && (caret < end || index === markers.length - 1)) {
      next = output + SCRIPT_BULLET.length + Math.max(0, Math.min(content.length, caret - contentStart));
    }
    bullets.push(content);
    output += SCRIPT_BULLET.length + content.length + 2;
  }
  return { bullets, caret: next ?? output - 2 };
}
