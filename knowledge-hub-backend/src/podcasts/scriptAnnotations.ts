export const SCRIPT_COLOURS = ['teal', 'yellow', 'pink'] as const;
export type ScriptColour = typeof SCRIPT_COLOURS[number];
export type ScriptCue = 'pause' | 'beat';
export interface AnnotatedScriptRun { text: string; colour?: ScriptColour; cue?: ScriptCue }
const MAX_COLOUR_DEPTH = 50;
const CLOSING_TOKEN_GROUP = 2;
const CUE_TOKEN_GROUP = 3;

/** Plain-text annotations are shared by the editor, Athena and presentation. */
export function scriptAnnotationRuns(text: string): AnnotatedScriptRun[] {
  const runs: AnnotatedScriptRun[] = [];
  const colours: Array<ScriptColour | 'plain'> = [];
  const tokens = /\[(?:colour=(teal|yellow|pink|plain)|(\/colour)|(pause|beat))\]/gi;
  let offset = 0;
  const append = (value: string): void => {
    if (!value) return;
    const colour = colours.at(-1);
    runs.push({ text: value, ...(colour && colour !== 'plain' ? { colour } : {}) });
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
  if (colours.length) throw new Error('Close each script [colour=...] annotation with [/colour].');
  return runs;
}

export function spokenScriptText(text: string): string {
  return scriptAnnotationRuns(text).map(run => run.cue ? ' ' : run.text).join('');
}
