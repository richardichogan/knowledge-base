import { scriptAnnotationRuns } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
import type { PresentationRun } from '../../../../athena-desktop/src/elgatoProtocol';
export { SCRIPT_COLOURS } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
export type { ScriptColour, ScriptCue } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';

export function annotatedPresentation(text: string): { text: string; runs: PresentationRun[] } {
  const runs = scriptAnnotationRuns(text).map((run): PresentationRun => ({
    text: run.text,
    styles: run.cue ? [`cue-${run.cue}`] : run.colour ? [`colour-${run.colour}`] : [],
  }));
  return { text: runs.map(run => run.text).join(''), runs };
}
