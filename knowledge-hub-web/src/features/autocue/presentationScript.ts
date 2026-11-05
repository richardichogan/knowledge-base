import type { PresentationRun, PresentationStyle, PresentationVisualScene } from '../../../../athena-desktop/src/elgatoProtocol';
import { parseScriptVisuals, scriptVisualSource, type VisualCue, type VisualScriptBlock } from '../../../../knowledge-hub-backend/src/utils/scriptVisuals';
import { scriptTextColour } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';

const PRESENTATION_STYLES = ['bold', 'italic', 'underline', 'strike', 'code'] satisfies PresentationStyle[];

interface PresentationOptions {
  script?: boolean;
  resolveMention?: (mention: unknown) => string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function inline(value: unknown, depth = 0, inherited: PresentationStyle[] = [], options: PresentationOptions = {}): PresentationRun[] {
  if (depth > 50) throw new Error('This note is nested too deeply to present.');
  if (typeof value === 'string') return [{ text: value, styles: inherited }];
  if (Array.isArray(value)) return value.flatMap(v => inline(v, depth + 1, inherited, options));
  const item = record(value);
  if (!item) return [];
  if (item.type === 'scriptCue') {
    const cue = record(item.props)?.cue;
    if (cue !== 'pause' && cue !== 'beat') throw new Error('This script contains an invalid delivery cue.');
    return [{ text: cue.toUpperCase(), styles: [`cue-${cue}`] }];
  }
  if (item.type === 'hardBreak') return [{ text: '\n', styles: [] }];
  const marks = record(item.styles);
  const styles: PresentationStyle[] = [...inherited, ...PRESENTATION_STYLES.filter(style => !inherited.includes(style) && marks?.[style] === true)];
  const colour = scriptTextColour(marks);
  if (colour && !styles.includes(`colour-${colour}`)) {
    const previous = styles.findIndex(style => style.startsWith('colour-'));
    if (previous >= 0) styles.splice(previous, 1);
    styles.push(`colour-${colour}`);
  }
  if (item.type === 'noteMention' || item.type === 'entityMention') {
    const text = options.resolveMention?.(item);
    if (!text?.trim()) throw new Error('Could not resolve a linked name in this script. Reload the saved script and retry.');
    return [{ text, styles }];
  }
  if (typeof item.text === 'string') return [{ text: item.text, styles }];
  return inline(item.content, depth + 1, styles, options);
}
export function presentationScript(contentJson: string, options: PresentationOptions = {}): { text: string; runs: PresentationRun[]; warnings: string[]; visuals: PresentationVisualScene[] } {
  const raw: unknown = JSON.parse(contentJson);
  if (!Array.isArray(raw)) throw new Error('This note does not contain a supported block document.');
  let omitted = 0;
  const anchors = new Map<string, { runs: PresentationRun[]; start: number }>();
  const plain = (text: string): PresentationRun => ({ text, styles: [] });
  const normalize = (blocks: unknown[], depth: number): PresentationRun[][] => {
    if (depth > 50) throw new Error('This note is nested too deeply to present.');
    let number = 0;
    return blocks.flatMap(value => {
      const block = record(value);
      if (!block) throw new Error('This note contains an invalid block.');
      if (options.script && block.type === 'heading') {
        return Array.isArray(block.children) ? normalize(block.children, depth) : [];
      }
      const content = record(block.content);
      let runs: PresentationRun[];
      if (block.type === 'table' && Array.isArray(content?.rows)) {
        runs = content.rows.flatMap((row, rowIndex) => {
          const cells = record(row)?.cells;
          if (!Array.isArray(cells)) throw new Error('This note contains an unsupported table.');
          return [...(rowIndex ? [plain('\n')] : []), ...cells.flatMap((cell, index) =>
            [...(index ? [plain(' | ')] : []), ...inline(cell, 0, [], options)])];
        });
      } else {
        runs = inline(block.content, 0, block.type === 'heading' ? ['bold'] : block.type === 'codeBlock' ? ['code'] : [], options);
        if (block.type === 'numberedListItem') runs.unshift(plain(`${++number}. `));
        else {
          number = 0;
          if (block.type === 'bulletListItem') runs.unshift(plain('- '));
          if (block.type === 'checkListItem') runs.unshift(plain(`[${record(block.props)?.checked === true ? 'x' : ' '}] `));
        }
      }
      if (!runs.some(run => run.text.trim()) && ['image', 'video', 'audio', 'file'].includes(String(block.type))) {
        omitted++;
        const caption = record(block.props)?.caption;
        if (typeof caption === 'string' && caption.trim()) runs = [plain(caption)];
      }
      if (depth && runs.some(run => run.text)) runs.unshift(plain('  '.repeat(depth)));
      if (typeof block.id === 'string') anchors.set(block.id, { runs, start: 0 });
      return [runs,
        ...(Array.isArray(block.children) ? normalize(block.children, depth + 1) : [])];
    });
  };
  const lines = normalize(raw, 0);
  const starts = new Map<PresentationRun[], number>();
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    if (index) offset++;
    starts.set(line, offset);
    offset += line.reduce((sum, run) => sum + run.text.replace(/\r\n?/g, '\n').length, 0);
  }
  const runs = lines.flatMap((line, index) => [...(index ? [plain('\n')] : []), ...line])
    .map(run => ({ ...run, text: run.text.replace(/\r\n?/g, '\n') }));
  const text = runs.map(run => run.text).join('');
  for (const anchor of anchors.values()) anchor.start = starts.get(anchor.runs) ?? 0;
  if (text.length > 500_000) throw new Error('This script exceeds the 500,000-character presentation limit.');
  const visuals: PresentationVisualScene[] = [];
  if (options.script) for (const block of raw as VisualScriptBlock[]) {
    const value = block.props?.scriptVisuals;
    if (!block.props?.scriptSection || !value) continue;
    const plan = parseScriptVisuals(value, block);
    if (plan.source !== scriptVisualSource(block)) throw new Error('Some visuals are out of date. Ask Athena to update them for the current script before presenting.');
    const at = (cue: VisualCue): number => {
      const anchor = anchors.get(cue.blockId);
      if (!anchor) throw new Error('A visual cue no longer has a spoken block. Update the section visuals.');
      const content = anchor.runs.map(run => run.text.replace(/\r\n?/g, '\n')).join('');
      if (cue.quote && content.split(cue.quote).length !== 2) throw new Error('A visual cue quotation cannot be resolved uniquely in the presented text.');
      return anchor.start + (cue.quote ? content.indexOf(cue.quote) : 0);
    };
    for (const scene of plan.scenes) visuals.push({ ...scene, at: at(scene.cue), items: scene.items.map(item => ({ ...item, at: at(item.cue) })) });
  }
  return { text, runs, visuals, warnings: omitted ? [`${omitted} media block(s) are represented by captions where available; media is not shown.`] : [] };
}
