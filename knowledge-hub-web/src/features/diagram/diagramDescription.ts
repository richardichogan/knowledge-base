import { wrapText } from './diagramGeometry';
import { descriptionRuns, type DescriptionRun } from './diagramMarkdown';

export { descriptionPlainText, descriptionRuns, formatDescription, type DescriptionRun } from './diagramMarkdown';

export function toggleDescriptionBullets(text: string, start: number, end: number): { text: string; start: number; end: number } {
  const first = text.slice(0, start).lastIndexOf('\n') + 1;
  const last = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
  const stop = last === -1 ? text.length : last;
  const lines = text.slice(first, stop).split('\n');
  const remove = lines.every(line => /^\s*[-+*] /.test(line));
  const result = lines.map(line => remove ? line.replace(/^(\s*)[-+*] /, '$1') : line.replace(/^(\s*)(?:[-+*] )?/, '$1- ')).join('\n');
  return { text: text.slice(0, first) + result + text.slice(stop), start: first, end: first + result.length };
}

export function continueDescriptionBullet(text: string, start: number, end: number): { text: string; start: number; end: number } | null {
  if (start !== end) return null;
  const first = text.slice(0, start).lastIndexOf('\n') + 1;
  const line = text.slice(first, start);
  const bullet = /^(\s*)[-+*] (.*)$/.exec(line);
  if (!bullet) return null;
  if (!bullet[2]?.trim()) {
    return { text: text.slice(0, first) + text.slice(start), start: first, end: first };
  }
  const insert = `\n${bullet[1]}- `;
  return { text: text.slice(0, start) + insert + text.slice(end), start: start + insert.length, end: start + insert.length };
}

export function wrapDescription(text: string, width: number, font: number): Array<{ text: string; runs: DescriptionRun[] }> {
  return text.split('\n').filter(para => para.trim() !== '').flatMap(para => {
    const chars = descriptionRuns(para).flatMap(run => run.text.split('').map(char => ({ ...run, text: char })));
    const normalized: DescriptionRun[] = [];
    for (const char of chars) {
      if (/\s/.test(char.text)) {
        if (normalized.length === 0 || normalized[normalized.length - 1]?.text === ' ') continue;
        normalized.push({ ...char, text: ' ' });
      } else normalized.push(char);
    }
    if (normalized[normalized.length - 1]?.text === ' ') normalized.pop();
    let offset = 0;
    return wrapText(normalized.map(char => char.text).join(''), width, font, 40).map(line => {
      if (normalized[offset]?.text === ' ') offset++;
      const runs: DescriptionRun[] = [];
      for (const [index, text] of line.split('').entries()) {
        const char = { ...(normalized[offset + index] ?? { bold: false, italic: false }), text };
        const previous = runs[runs.length - 1];
        if (previous?.bold === char.bold && previous.italic === char.italic) previous.text += char.text;
        else runs.push({ ...char });
      }
      offset += line.length;
      return { text: line, runs };
    });
  });
}
