import { wrapText } from './diagramGeometry';
import { descriptionRuns, type DescriptionRun } from './diagramMarkdown';

export { descriptionPlainText, descriptionRuns, formatDescription, type DescriptionRun } from './diagramMarkdown';

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
