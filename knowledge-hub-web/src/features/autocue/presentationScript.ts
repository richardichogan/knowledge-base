import { parsePresentationVisuals, type PresentationRun, type PresentationStyle, type PresentationVisualScene } from '../../../../athena-desktop/src/elgatoProtocol';
import { parseScriptVisuals, visualCueResolver, visualSourceCurrent, visualSpokenText, type VisualCue, type VisualScriptBlock } from '../../../../knowledge-hub-backend/src/utils/scriptVisuals';
import { scriptTextColour } from '../../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';

const PRESENTATION_STYLES = ['bold', 'italic', 'underline', 'strike', 'code'] satisfies PresentationStyle[];

interface PresentationOptions {
  script?: boolean;
  resolveMention?: (mention: unknown) => string;
}

export function requiresVisualMotion(scenes: PresentationVisualScene[]): boolean {
  return scenes.some(scene => scene.presenterLayout
    || scene.composition?.nodes.some(node => node.entrance || node.emphasis)
    || scene.composition?.links.some(link => link.motion || link.route));
}
export function requiresVisualCraft(scenes: PresentationVisualScene[]): boolean {
  return scenes.some(scene => scene.template === 'close' || scene.presenterLayout || scene.composition?.imageTreatment
    || scene.composition?.nodes.length === 0
    || scene.composition?.links.some(link => link.fromPort || link.toPort));
}

const ASSET_GRAMMAR_ICONS: ReadonlySet<string> = new Set(['clock', 'quality', 'coin', 'gauge']);
/** True when a scene uses drawn graphics, node roles, build states, the presenter frame or an icon older Desktop builds cannot parse. */
export function requiresVisualAssets(scenes: PresentationVisualScene[]): boolean {
  return scenes.some(scene => scene.composition?.frame
    || scene.composition?.nodes.some(node => node.kind === 'asset' || node.role || node.states || ASSET_GRAMMAR_ICONS.has(node.icon)));
}

const SENTENCES = new Intl.Segmenter('en-GB', { granularity: 'sentence' });
const LIST_LIKE_LINE = /^\s*(?:[•◦▪▫‣⁃∙·●○■□◆◇►▸▶➤→✓✔✗✘★☆*+\-–—]|\(?\d+[.)]|\(?[a-z][.)])\s/iu;
const ABBREVIATION_END = /(?:^|[\s("'‘“])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Hon|St|Mt|Sgt|Capt|Lt|Col|Gen|Sen|Gov|Fr|Sr|Jr|vs|cf|approx|e\.g|i\.e|[A-Z])\.$/u;
const SPLIT_BLOCKS = new Set(['paragraph', 'quote']);

/** Starts each spoken sentence on a new line unless a line break is already there; bullet-like and decorative lines stay as written. */
function sentenceLines(runs: PresentationRun[]): { runs: PresentationRun[]; source: string; map: (offset: number) => number } {
  const source = runs.map(run => run.text).join('');
  const edits: Array<{ start: number; end: number }> = [];
  for (const { segment, index } of SENTENCES.segment(source)) {
    const end = index + segment.length;
    const gap = /\s*$/.exec(segment)?.[0] ?? '';
    if (!segment.trim() || gap.includes('\n') || !source.slice(end).trim()) continue;
    const start = end - gap.length;
    if (ABBREVIATION_END.test(source.slice(index, start))) continue;
    const lineEnd = source.indexOf('\n', start);
    const line = source.slice(source.lastIndexOf('\n', start - 1) + 1, lineEnd < 0 ? undefined : lineEnd);
    if (LIST_LIKE_LINE.test(line) || !/[\p{L}\p{N}]/u.test(line)) continue;
    edits.push({ start, end });
  }
  if (!edits.length) return { runs, source, map: offset => offset };
  const result: PresentationRun[] = [];
  let offset = 0;
  let next = 0;
  for (const run of runs) {
    let text = '';
    for (let index = 0; index < run.text.length; index++, offset++) {
      if (edits[next]?.start === offset) {
        if (text) result.push({ ...run, text });
        text = '';
        result.push({ text: '\n', styles: [] });
        if (edits[next]!.end === offset) next++;
      }
      const edit = edits[next];
      if (edit && offset >= edit.start && offset < edit.end) {
        if (offset + 1 === edit.end) next++;
        continue;
      }
      text += run.text[index];
    }
    if (text) result.push({ ...run, text });
  }
  return { runs: result, source,
    map: offset => edits.reduce((value, edit) => edit.start > offset ? value : value + 1 - (Math.min(offset, edit.end) - edit.start), offset) };
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
export function presentationScript(contentJson: string, options: PresentationOptions = {}): { text: string; runs: PresentationRun[]; warnings: string[]; visuals: PresentationVisualScene[]; visualIssue: string | null } {
  const raw: unknown = JSON.parse(contentJson);
  if (!Array.isArray(raw)) throw new Error('This note does not contain a supported block document.');
  let omitted = 0;
  const anchors = new Map<string, { runs: PresentationRun[]; start: number; source?: string; map?: (offset: number) => number }>();
  const plain = (text: string): PresentationRun => ({ text, styles: [] });
  const sectionBreak: PresentationRun[] = [];
  const normalize = (blocks: unknown[], depth: number): PresentationRun[][] => {
    if (depth > 50) throw new Error('This note is nested too deeply to present.');
    let number = 0;
    return blocks.flatMap(value => {
      const block = record(value);
      if (!block) throw new Error('This note contains an invalid block.');
      if (options.script && block.type === 'heading') {
        return [sectionBreak, ...Array.isArray(block.children) ? normalize(block.children, depth) : []];
      }
      const content = record(block.content);
      let runs: PresentationRun[];
      let split: ReturnType<typeof sentenceLines> | null = null;
      if (block.type === 'table' && Array.isArray(content?.rows)) {
        runs = content.rows.flatMap((row, rowIndex) => {
          const cells = record(row)?.cells;
          if (!Array.isArray(cells)) throw new Error('This note contains an unsupported table.');
          return [...(rowIndex ? [plain('\n')] : []), ...cells.flatMap((cell, index) =>
            [...(index ? [plain(' | ')] : []), ...inline(cell, 0, [], options)])];
        });
      } else {
        runs = inline(block.content, 0, block.type === 'heading' ? ['bold'] : block.type === 'codeBlock' ? ['code'] : [], options);
        if (options.script && SPLIT_BLOCKS.has(String(block.type))) {
          split = sentenceLines(runs.map(run => ({ ...run, text: run.text.replace(/\r\n?/g, '\n') })));
          runs = split.runs;
        }
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
      const lead = depth && runs.some(run => run.text) ? '  '.repeat(depth) : '';
      if (lead) runs.unshift(plain(lead));
      if (typeof block.id === 'string') {
        const sentences = split;
        anchors.set(block.id, sentences ? { runs, start: 0, source: lead + sentences.source,
          map: offset => offset < lead.length ? offset : lead.length + sentences.map(offset - lead.length) } : { runs, start: 0 });
      }
      return [runs,
        ...(Array.isArray(block.children) ? normalize(block.children, depth + 1) : [])];
    });
  };
  const lines: PresentationRun[][] = [];
  const lineText = (line: PresentationRun[] | undefined): string => line?.map(run => run.text.replace(/\r\n?/g, '\n')).join('') ?? '';
  let pendingGap = false;
  for (const line of normalize(raw, 0)) {
    if (line === sectionBreak) { pendingGap = lines.length > 0; continue; }
    const current = lineText(line);
    const previous = lineText(lines[lines.length - 1]);
    // A blank line separates script sections unless the author already left one.
    if (pendingGap && current.trim() && !/^\s*\n/.test(current) && previous.trim() && !/\n\s*$/.test(previous)) lines.push([]);
    pendingGap = false;
    lines.push(line);
  }
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
  // Visual problems never block presenting: the script is presented without visuals and the reason is kept for Open browser visuals.
  const visuals: PresentationVisualScene[] = [];
  let visualIssue: string | null = null;
  let sectionIndex = 0;
  const reason = (error: unknown): string => error instanceof Error ? error.message : 'The visuals could not be read.';
  if (options.script) for (const block of raw as VisualScriptBlock[]) {
    if (!block.props?.scriptSection) continue;
    const section = sectionIndex++;
    const value = block.props.scriptVisuals;
    if (!value) continue;
    try {
      const plan = parseScriptVisuals(value);
      if (!visualSourceCurrent(plan.source, block)) throw new Error('The visuals are out of date. Ask Athena to update them for the current script.');
      parseScriptVisuals(plan, block);
      const resolve = visualCueResolver(block);
      const at = (cue: VisualCue): number => {
        const resolved = resolve(cue);
        const anchor = resolved && anchors.get(resolved.blockId);
        if (!resolved || !anchor) throw new Error('A visual cue no longer matches the spoken text. Ask Athena to update the section visuals.');
        const content = anchor.source ?? anchor.runs.map(run => run.text.replace(/\r\n?/g, '\n')).join('');
        if (resolved.quote && content.split(resolved.quote).length !== 2) throw new Error('A visual cue quotation cannot be resolved uniquely in the presented text.');
        const position = resolved.quote ? content.indexOf(resolved.quote) : 0;
        return anchor.start + (anchor.map ? anchor.map(position) : position);
      };
      for (const scene of plan.scenes) visuals.push({ ...scene, section, at: at(scene.cue), items: scene.items.map(item => ({ ...item, at: at(item.cue) })) });
    } catch (error) {
      visualIssue = `Visuals were left out of this presentation. Section "${visualSpokenText(block.content).trim() || 'Untitled'}": ${reason(error)}`;
      break;
    }
  }
  if (!visualIssue && visuals.length) {
    try { parsePresentationVisuals(visuals, text.length); }
    catch (error) { visualIssue = `Visuals were left out of this presentation. ${reason(error)}`; }
  }
  return { text, runs, visuals: visualIssue ? [] : visuals, visualIssue,
    warnings: omitted ? [`${omitted} media block(s) are represented by captions where available; media is not shown.`] : [] };
}
