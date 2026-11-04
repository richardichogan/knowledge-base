import type { PresentationRun, PresentationStyle } from '../../../../athena-desktop/src/elgatoProtocol';
import { scriptTextColour } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';

const PRESENTATION_STYLES = ['bold', 'italic', 'underline', 'strike', 'code'] satisfies PresentationStyle[];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function inline(value: unknown, depth = 0, inherited: PresentationStyle[] = []): PresentationRun[] {
  if (depth > 50) throw new Error('This note is nested too deeply to present.');
  if (typeof value === 'string') return [{ text: value, styles: inherited }];
  if (Array.isArray(value)) return value.flatMap(v => inline(v, depth + 1, inherited));
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
  if (typeof item.text === 'string') return [{ text: item.text, styles }];
  return inline(item.content, depth + 1, styles);
}
export function presentationScript(contentJson: string, options: { script?: boolean } = {}): { text: string; runs: PresentationRun[]; warnings: string[] } {
  const raw: unknown = JSON.parse(contentJson);
  if (!Array.isArray(raw)) throw new Error('This note does not contain a supported block document.');
  let omitted = 0;
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
            [...(index ? [plain(' | ')] : []), ...inline(cell)])];
        });
      } else {
        runs = inline(block.content, 0, block.type === 'heading' ? ['bold'] : block.type === 'codeBlock' ? ['code'] : []);
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
      return [runs,
        ...(Array.isArray(block.children) ? normalize(block.children, depth + 1) : [])];
    });
  };
  const runs = normalize(raw, 0).flatMap((line, index) => [...(index ? [plain('\n')] : []), ...line])
    .map(run => ({ ...run, text: run.text.replace(/\r\n?/g, '\n') }));
  const text = runs.map(run => run.text).join('');
  if (text.length > 500_000) throw new Error('This script exceeds the 500,000-character presentation limit.');
  return { text, runs, warnings: omitted ? [`${omitted} media block(s) are represented by captions where available; media is not shown.`] : [] };
}
