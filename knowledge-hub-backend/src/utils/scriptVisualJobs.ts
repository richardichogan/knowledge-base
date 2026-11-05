import { parseScriptVisuals, scriptVisualSource, visualSourceCurrent, visualSpokenText, SCRIPT_VISUAL_SOURCE_BUDGET, type ScriptVisuals, type VisualScriptBlock } from './scriptVisuals.js';

export const SCRIPT_VISUAL_SPECIALIST = 'script-visual-designer';
export const SCRIPT_VISUAL_MAX_SECTIONS = 20;
const MAX_SNAPSHOT_CHARS = 2_000_000;
const MAX_ID = 100;

export interface ScriptVisualDraft {
  section: VisualScriptBlock & { id: string };
  visuals: ScriptVisuals;
  expectedVisuals: string;
}
export interface ScriptVisualJobResult { noteId: string; sections: ScriptVisualDraft[] }
export interface ScriptVisualJobEdit {
  action: 'set_script_visuals';
  sectionId: string;
  visuals: ScriptVisuals;
  expectedVisuals: string;
  summary: string;
}

export function scriptVisualSnapshot(value: unknown): VisualScriptBlock & { id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid script section snapshot.');
  const section = value as VisualScriptBlock;
  if (typeof section.id !== 'string' || !section.id || section.id.length > MAX_ID
    || section.type !== 'heading' || section.props?.scriptSection !== true || !Array.isArray(section.children)
    || !section.children.length || JSON.stringify(section).length > MAX_SNAPSHOT_CHARS
    || scriptVisualSource(section).length > SCRIPT_VISUAL_SOURCE_BUDGET
    || JSON.stringify(section.children).length > SCRIPT_VISUAL_SOURCE_BUDGET) {
    throw new Error('Choose a populated script section within the visual-design budget.');
  }
  if (section.props.scriptVisuals !== undefined && typeof section.props.scriptVisuals !== 'string') throw new Error('Invalid saved section visuals.');
  if (section.props.scriptVisuals) parseScriptVisuals(section.props.scriptVisuals);
  return { ...section, id: section.id };
}

export function parseScriptVisualJobResult(value: unknown, noteId: string): ScriptVisualJobResult {
  if (!value || typeof value !== 'object' || !('noteId' in value) || value.noteId !== noteId
    || !('sections' in value) || !Array.isArray(value.sections) || !value.sections.length
    || value.sections.length > SCRIPT_VISUAL_MAX_SECTIONS) throw new Error('This visual result does not belong to the current script.');
  const ids = new Set<string>();
  const sections = value.sections.map((raw: unknown): ScriptVisualDraft => {
    if (!raw || typeof raw !== 'object' || !('section' in raw) || !('visuals' in raw)
      || !('expectedVisuals' in raw) || typeof raw.expectedVisuals !== 'string') throw new Error('Invalid pending visual result.');
    const section = scriptVisualSnapshot(raw.section);
    if (ids.has(section.id)) throw new Error('The pending result repeats a script section.');
    ids.add(section.id);
    const visuals = parseScriptVisuals(raw.visuals, section);
    if (visuals.source !== scriptVisualSource(section) || !visuals.scenes.length
      || raw.expectedVisuals !== (section.props?.scriptVisuals ?? '')) throw new Error('The pending visuals do not match their source snapshot.');
    return { section, visuals, expectedVisuals: raw.expectedVisuals };
  });
  return { noteId, sections };
}

/** Validate the entire batch before the editor applies any section. */
export function scriptVisualJobEdits(result: ScriptVisualJobResult, blocks: VisualScriptBlock[]): ScriptVisualJobEdit[] {
  return result.sections.flatMap(draft => {
    const section = blocks.find(block => block.id === draft.section.id && block.props?.scriptSection);
    if (!section || !visualSourceCurrent(draft.visuals.source, section)
      || visualSpokenText(section.content) !== visualSpokenText(draft.section.content)) {
      throw new Error('A source section changed or was removed. The pending result is retained; generate a new result for the changed script.');
    }
    const current = section.props?.scriptVisuals ?? '';
    const visuals = parseScriptVisuals(draft.visuals, section);
    if (current === JSON.stringify(visuals)) return [];
    if (current !== draft.expectedVisuals) throw new Error('Section visuals changed after this request. Nothing was overwritten; the pending result is retained.');
    return [{ action: 'set_script_visuals' as const, sectionId: draft.section.id,
      visuals, expectedVisuals: draft.expectedVisuals, summary: 'Apply reviewed Ariadne visuals' }];
  });
}
