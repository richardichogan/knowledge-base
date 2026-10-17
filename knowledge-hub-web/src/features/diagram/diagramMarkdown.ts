/** Bold and italic in titles and descriptions: a small, plain-text-compatible Markdown subset, never HTML. */
export interface DescriptionRun { text: string; bold: boolean; italic: boolean }

export function descriptionRuns(text: string): DescriptionRun[] {
  const tokens: Array<{ text: string; mark?: number; paired?: boolean }> = [];
  const stack: number[] = [];
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === '\\' && text[index + 1] === '*') {
      tokens.push({ text: '*' });
      index += 2;
    } else if (char === '*') {
      let count = 1;
      while (text[index + count] === '*') count++;
      const canClose = index > 0 && !/\s/.test(text[index - 1]!);
      const canOpen = index + count < text.length && !/\s/.test(text[index + count]!);
      let remaining = count;
      while (remaining > 0) {
        const open = stack[stack.length - 1];
        const width = open === undefined ? 0 : tokens[open]!.mark!;
        if (canClose && width > 0 && width <= remaining) {
          tokens[open!]!.paired = true;
          tokens.push({ text: '*'.repeat(width), mark: width, paired: true });
          stack.pop();
          remaining -= width;
        } else if (canOpen) {
          const mark = remaining >= 2 ? 2 : 1;
          stack.push(tokens.length);
          tokens.push({ text: '*'.repeat(mark), mark });
          remaining -= mark;
        } else {
          tokens.push({ text: '*'.repeat(remaining) });
          remaining = 0;
        }
      }
      index += count;
    } else {
      tokens.push({ text: char });
      if (char === '\n') stack.length = 0;
      index++;
    }
  }
  const runs: DescriptionRun[] = [];
  let bold = false;
  let italic = false;
  for (const token of tokens) {
    if (token.paired) {
      if (token.mark === 2) bold = !bold;
      else italic = !italic;
    } else {
      const previous = runs[runs.length - 1];
      if (previous?.bold === bold && previous.italic === italic) previous.text += token.text;
      else runs.push({ text: token.text, bold, italic });
    }
  }
  return runs;
}

export const descriptionPlainText = (text: string): string => descriptionRuns(text).map(run => run.text).join('');

export function formatDescription(text: string, start: number, end: number, style: 'bold' | 'italic'): {
  text: string; start: number; end: number;
} {
  const mark = style === 'bold' ? '**' : '*';
  const selected = text.slice(start, end);
  if (selected.includes('\n')) {
    const formatted = selected.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed === '') return line;
      const leading = line.length - line.trimStart().length;
      return line.slice(0, leading) + formatDescription(trimmed, 0, trimmed.length, style).text + line.slice(leading + trimmed.length);
    }).join('\n');
    return { text: text.slice(0, start) + formatted + text.slice(end), start, end: start + formatted.length };
  }
  if (selected.length > mark.length * 2 && selected.startsWith(mark) && selected.endsWith(mark)
    && descriptionRuns(selected).every(run => style === 'bold' ? run.bold : run.italic)) {
    const unwrapped = selected.slice(mark.length, -mark.length);
    return { text: text.slice(0, start) + unwrapped + text.slice(end), start, end: start + unwrapped.length };
  }
  const before = /\*+$/.exec(text.slice(0, start))?.[0].length ?? 0;
  const after = /^\*+/.exec(text.slice(end))?.[0].length ?? 0;
  const hasStyle = style === 'bold' ? before >= 2 && after >= 2 : before % 2 === 1 && after % 2 === 1;
  if (hasStyle) {
    return { text: text.slice(0, start - mark.length) + selected + text.slice(end + mark.length), start: start - mark.length, end: end - mark.length };
  }
  return { text: text.slice(0, start) + mark + selected + mark + text.slice(end), start: start + mark.length, end: end + mark.length };
}

/** Maps lines wrapped from the plain text back onto the bold and italic runs of their Markdown source. */
export function styledLines(source: string, lines: readonly string[]): DescriptionRun[][] {
  const chars = descriptionRuns(source).flatMap(run => run.text.split('').map(text => ({ ...run, text })));
  let at = 0;
  return lines.map(line => {
    const runs: DescriptionRun[] = [];
    for (const text of line) {
      while (at < chars.length && chars[at]!.text !== text && /\s/.test(chars[at]!.text)) at++;
      const style = chars[Math.min(at, chars.length - 1)] ?? { bold: false, italic: false };
      if (chars[at]?.text === text) at++;
      const previous = runs[runs.length - 1];
      if (previous?.bold === style.bold && previous.italic === style.italic) previous.text += text;
      else runs.push({ text, bold: style.bold, italic: style.italic });
    }
    return runs;
  });
}
