export const SCRIPT_COLOURS = ['teal', 'yellow', 'pink'] as const;
export type ScriptColour = typeof SCRIPT_COLOURS[number];
export type ScriptCue = 'pause' | 'beat';
export const SCRIPT_COLOUR_VALUES: Record<ScriptColour, string> = {
  teal: '#3ddbd9', yellow: '#f1c21b', pink: '#ff7eb6',
};
export interface AnnotatedScriptRun { text: string; colour?: ScriptColour; cue?: ScriptCue; plain?: boolean }
export interface ScriptLine { runs: AnnotatedScriptRun[]; heading: number }
const MAX_COLOUR_DEPTH = 50;
const CLOSING_TOKEN_GROUP = 2;
const CUE_TOKEN_GROUP = 3;
const MAX_HEADING_LEVEL = 6;

export function scriptHeadingPrefix(level: unknown): string {
  return '#'.repeat(typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= MAX_HEADING_LEVEL ? level : 1) + ' ';
}

/** Plain-text annotations are shared by the editor, Athena and presentation. */
export function scriptAnnotationRuns(text: string): AnnotatedScriptRun[] {
  return scriptAnnotationParts([text])[0]!;
}

/** Colours may span paragraph or rich-text boundaries, but every marker must balance. */
export function scriptAnnotationParts(parts: readonly string[]): AnnotatedScriptRun[][] {
  const colours: Array<ScriptColour | 'plain'> = [];
  const tokens = /\[(?:colour=(teal|yellow|pink|plain)|(\/colour)|(pause|beat))\]/gi;
  const result = parts.map(text => {
    const runs: AnnotatedScriptRun[] = [];
    let offset = 0;
    const append = (value: string): void => {
      if (!value) return;
      const colour = colours.at(-1);
      runs.push({ text: value, ...(colour && colour !== 'plain' ? { colour } : {}),
        ...(colour === 'plain' ? { plain: true } : {}) });
    };
    for (const token of text.matchAll(tokens)) {
      append(text.slice(offset, token.index));
      if (token[1]) {
        const name = token[1].toLowerCase();
        const colour = name === 'plain' ? 'plain' : SCRIPT_COLOURS.find(allowed => allowed === name);
        if (colour) colours.push(colour);
        if (colours.length > MAX_COLOUR_DEPTH) throw new Error('Script colour annotations are nested too deeply.');
      } else if (token[CLOSING_TOKEN_GROUP]) {
        if (!colours.length) throw new Error('A script [/colour] marker has no opening [colour=...] marker.');
        colours.pop();
      } else {
        const cue = token[CUE_TOKEN_GROUP]?.toLowerCase();
        if (cue === 'pause' || cue === 'beat') runs.push({ text: cue.toUpperCase(), cue });
      }
      offset = token.index + token[0].length;
    }
    append(text.slice(offset));
    return runs;
  });
  if (colours.length) throw new Error('Close each script [colour=...] annotation with [/colour].');
  return result;
}

/** Preserve emphasis across line boundaries while identifying non-spoken headings. */
export function scriptLines(text: string): ScriptLine[] {
  const lines: ScriptLine[] = [{ runs: [], heading: 0 }];
  for (const run of scriptAnnotationRuns(text.replace(/\r\n?/g, '\n'))) {
    if (run.cue) { lines.at(-1)!.runs.push(run); continue; }
    run.text.split('\n').forEach((part, index) => {
      if (index) lines.push({ runs: [], heading: 0 });
      if (part) lines.at(-1)!.runs.push({ ...run, text: part });
    });
  }
  for (const line of lines) {
    const marker = /^(#{1,6})[ \t]+/.exec(line.runs.map(run => run.text).join(''));
    if (!marker) continue;
    line.heading = marker[1]!.length;
    let remaining = marker[0].length;
    line.runs = line.runs.flatMap(run => {
      const remove = Math.min(remaining, run.text.length);
      remaining -= remove;
      return remove < run.text.length ? [{ ...run, text: run.text.slice(remove) }] : [];
    });
  }
  return lines;
}

/** Reading text excludes heading labels, not the content beneath them. */
export function scriptReadingRuns(text: string): AnnotatedScriptRun[] {
  return scriptLines(text).filter(line => !line.heading).flatMap((line, index) =>
    [...(index ? [{ text: '\n' }] : []), ...line.runs]);
}

export function scriptReadingText(text: string): string {
  return scriptReadingRuns(text).map(run => run.cue ? `[${run.cue}]`
    : run.colour ? `[colour=${run.colour}]${run.text}[/colour]` : run.text).join('');
}

export function spokenScriptText(text: string): string {
  return scriptReadingRuns(text).map(run => run.cue ? ' ' : run.text).join('');
}

export function scriptTextColour(styles: unknown): ScriptColour | undefined {
  if (!styles || typeof styles !== 'object' || !('textColor' in styles)) return undefined;
  const value = typeof styles.textColor === 'string' ? styles.textColor.toLowerCase() : '';
  return SCRIPT_COLOURS.find(colour => value === colour || SCRIPT_COLOUR_VALUES[colour] === value);
}

export function annotateScriptText(text: string, styles: unknown): string {
  const colour = scriptTextColour(styles);
  return colour && text ? `[colour=${colour}]${text}[/colour]` : text;
}

export type ScriptInlineContent =
  | { type: 'text'; text: string; styles: Record<string, string | boolean> }
  | { type: 'scriptCue'; props: { cue: ScriptCue } };

/** The same annotated text Athena reads becomes native, editable script content. */
export function scriptInlineContent(text: string, inherited: Record<string, string | boolean> = {}): ScriptInlineContent[] {
  return scriptInlineParts([{ text, styles: inherited }])[0]!;
}

export function scriptInlineParts(parts: { text: string; styles: Record<string, string | boolean> }[]): ScriptInlineContent[][] {
  return scriptAnnotationParts(parts.map(part => part.text)).map((runs, index) => runs.map(run => {
    if (run.cue) return { type: 'scriptCue', props: { cue: run.cue } };
    const styles = { ...parts[index]!.styles };
    if (run.colour) styles['textColor'] = SCRIPT_COLOUR_VALUES[run.colour];
    else if (run.plain) delete styles['textColor'];
    return { type: 'text', text: run.text, styles };
  }));
}
