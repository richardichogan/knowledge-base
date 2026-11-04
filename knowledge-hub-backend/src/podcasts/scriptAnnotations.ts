export const SCRIPT_COLOURS = ['teal', 'yellow', 'pink'] as const;
export type ScriptColour = typeof SCRIPT_COLOURS[number];
export type ScriptCue = 'pause' | 'beat';
export const SCRIPT_COLOUR_VALUES: Record<ScriptColour, string> = {
  teal: '#3ddbd9', yellow: '#f1c21b', pink: '#ff7eb6',
};
export interface AnnotatedScriptRun { text: string; colour?: ScriptColour; cue?: ScriptCue; plain?: boolean }
const MAX_COLOUR_DEPTH = 50;
const CLOSING_TOKEN_GROUP = 2;
const CUE_TOKEN_GROUP = 3;

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

export function spokenScriptText(text: string): string {
  return scriptAnnotationRuns(text).map(run => run.cue ? ' ' : run.text).join('');
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
