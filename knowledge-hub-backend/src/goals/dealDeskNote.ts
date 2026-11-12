/**
 * goals/dealDeskNote.ts — block-level reading and additive editing of a Deal desk note.
 * The job only ever appends rows and bullets under headings that already exist (or adds a missing section at the end).
 * It never renames, removes, re-levels or reorders a heading, never rewrites the title and never changes a row or bullet that is already there.
 */
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';

export const DEAL_STAGES = ['Qualify', 'Shape', 'Propose', 'Negotiate', 'Won', 'Lost'] as const;
export type DealStage = typeof DEAL_STAGES[number];
export const STANCES = ['Champion', 'Supporter', 'Neutral', 'Sceptic', 'Blocker'] as const;

export const NEXT_STEP_HEADING = 'Next step';
export const PEOPLE_HEADING = 'Who matters';
export const NEXT_STEP_COLUMNS = ['Action', 'Owner', 'Due', 'Done'] as const;
export const PEOPLE_COLUMNS = ['Name', 'Role', 'Stance'] as const;
export const BULLET_HEADINGS = ['Objections heard', 'Proof points', 'Competitor moves'] as const;
const PLACEHOLDER = 'not yet known.';

export interface Block { type: string; props?: Record<string, unknown>; content?: unknown; children?: unknown[]; [key: string]: unknown }
type Cell = { content?: unknown } | unknown[];
interface TableContent { type?: string; headerRows?: number; rows?: { cells?: Cell[] }[] }

export const normalise = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (typeof item !== 'object' || item === null) return '';
    const part = item as { text?: unknown; content?: unknown };
    return typeof part.text === 'string' ? part.text : inlineText(part.content);
  }).join('');
}
const cellText = (cell: Cell): string => inlineText(Array.isArray(cell) ? cell : cell.content).replace(/\s+/g, ' ').trim();
export const blockText = (block: Block): string => inlineText(block.content).trim();

const isHeading = (block: Block): boolean => block.type === 'heading';
const isPlaceholder = (block: Block): boolean =>
  (block.type === 'paragraph' || block.type === 'bulletListItem') && normalise(blockText(block)) === PLACEHOLDER;

/** The block range under a heading, up to the next heading of any level. */
export function findSection(blocks: Block[], heading: string): { start: number; end: number } | null {
  const start = blocks.findIndex(block => isHeading(block) && normalise(blockText(block)) === normalise(heading));
  if (start < 0) return null;
  const next = blocks.findIndex((block, index) => index > start && isHeading(block));
  return { start, end: next < 0 ? blocks.length : next };
}

const tableIn = (blocks: Block[], section: { start: number; end: number }): Block | undefined =>
  blocks.slice(section.start + 1, section.end).find(block => block.type === 'table');

function headerNames(table: TableContent, fallback: readonly string[]): string[] {
  const first = table.rows?.[0]?.cells;
  return (table.headerRows ?? 0) > 0 && first ? first.map(cell => normalise(cellText(cell))) : fallback.map(normalise);
}

/** Existing body rows keyed by lower-cased column name; null when the section has no table. */
export function readTable(blocks: Block[], heading: string, fallback: readonly string[]): Record<string, string>[] | null {
  const section = findSection(blocks, heading);
  const table = section ? tableIn(blocks, section) : undefined;
  if (!table) return null;
  const content = table.content as TableContent;
  const names = headerNames(content, fallback);
  return (content.rows ?? []).slice(content.headerRows ?? 0).map(row =>
    Object.fromEntries(names.map((name, index) => [name, cellText(row.cells?.[index] ?? [])])));
}

/** Existing text under a bulleted section (bullets and paragraphs), excluding the "Not yet known." placeholder. */
export function readBullets(blocks: Block[], heading: string): string[] {
  const section = findSection(blocks, heading);
  if (!section) return [];
  return blocks.slice(section.start + 1, section.end)
    .filter(block => !isPlaceholder(block) && (block.type === 'bulletListItem' || block.type === 'paragraph' || block.type === 'numberedListItem'))
    .map(blockText).filter(Boolean);
}

/** Plain text under a heading, for reading a legacy Stage section. */
export function sectionText(blocks: Block[], heading: string): string {
  const section = findSection(blocks, heading);
  return section ? blocks.slice(section.start + 1, section.end).map(blockText).filter(Boolean).join('\n') : '';
}

const escapeCell = (value: string): string => value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

function emptyTable(columns: readonly string[], blankRows = 0): Block {
  const body = Array.from({ length: blankRows }, () => `|${columns.map(() => '  ').join('|')}|`);
  return textToBlocks([`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, ...body].join('\n'))[0] as unknown as Block;
}
const textBlock = (type: Block['type'], text: string, props?: Record<string, unknown>): Block =>
  ({ type, ...(props ? { props } : {}), content: text ? [{ type: 'text', text, styles: {} }] : [] });

function ensureSection(blocks: Block[], heading: string): { start: number; end: number } {
  const found = findSection(blocks, heading);
  if (found) return found;
  blocks.push(textBlock('heading', heading, { level: 2 }));
  return { start: blocks.length - 1, end: blocks.length };
}

function removePlaceholders(blocks: Block[], section: { start: number; end: number }): { start: number; end: number } {
  let { end } = section;
  for (let i = end - 1; i > section.start; i--) if (isPlaceholder(blocks[i]!)) { blocks.splice(i, 1); end--; }
  return { start: section.start, end };
}

const rowIsEmpty = (row: { cells?: Cell[] }): boolean => (row.cells ?? []).every(cell => cellText(cell) === '');

/**
 * Adds rows to the table under `heading`, creating the table (or the section, at the end) only when missing.
 * Fully empty rows are dropped when real rows arrive; every other existing row is left as it is.
 */
export function addTableRows(source: Block[], heading: string, columns: readonly string[], rows: Record<string, string>[]): Block[] {
  const blocks = structuredClone(source);
  let section = ensureSection(blocks, heading);
  let table = tableIn(blocks, section);
  if (!table) {
    section = removePlaceholders(blocks, section);
    table = emptyTable(columns, 1);
    blocks.splice(section.start + 1, 0, table);
  }
  if (!rows.length) return blocks;
  section = removePlaceholders(blocks, findSection(blocks, heading)!);
  const content = table.content as TableContent;
  const names = headerNames(content, columns);
  const headerRows = content.headerRows ?? 0;
  content.rows = [...(content.rows ?? []).filter((row, index) => index < headerRows || !rowIsEmpty(row)),
    ...rows.map(values => ({ cells: names.map(name => ({ type: 'tableCell', props: { textAlignment: 'left' },
      content: values[name] ? [{ type: 'text', text: escapeCell(values[name]!).replace(/\\\|/g, '|'), styles: {} }] : [] })) }))];
  return blocks;
}

/** Adds bullets after the last existing bullet (or at the end of the section); a "Not yet known." placeholder is replaced. */
export function addBullets(source: Block[], heading: string, items: string[]): Block[] {
  const blocks = structuredClone(source);
  if (!items.length) return blocks;
  const section = removePlaceholders(blocks, ensureSection(blocks, heading));
  let at = section.end;
  for (let i = section.end - 1; i > section.start; i--) if (blocks[i]!.type === 'bulletListItem') { at = i + 1; break; }
  blocks.splice(at, 0, ...items.map(item => textBlock('bulletListItem', item)));
  return blocks;
}

/** The note must open with an H1 so the editor never titles it after its first section; an existing first H1 is left alone. */
export function withTitleBlock(source: Block[], title: string): Block[] {
  const first = source[0];
  if (first && isHeading(first) && first.props?.['level'] === 1) return source;
  return [textBlock('heading', title, { level: 1 }), ...structuredClone(source)];
}

/** Opens a Deal desk note: title, intro, the two tables and the bulleted sections. */
export function dealTemplate(title: string, intro: string): Block[] {
  return [
    textBlock('heading', title, { level: 1 }), textBlock('paragraph', intro),
    textBlock('heading', NEXT_STEP_HEADING, { level: 2 }), emptyTable(NEXT_STEP_COLUMNS, 1),
    textBlock('heading', PEOPLE_HEADING, { level: 2 }), emptyTable(PEOPLE_COLUMNS, 1),
    ...BULLET_HEADINGS.flatMap(heading => [textBlock('heading', heading, { level: 2 }), textBlock('bulletListItem', 'Not yet known.')]),
  ];
}

/** Brings an existing brief to the Deal desk layout without touching any heading or any existing text. */
export function convertBlocks(source: Block[], title: string): Block[] {
  let blocks = withTitleBlock(source, title);
  blocks = addTableRows(blocks, NEXT_STEP_HEADING, NEXT_STEP_COLUMNS, []);
  return addTableRows(blocks, PEOPLE_HEADING, PEOPLE_COLUMNS, []);
}

export function stageFromText(text: string): DealStage | null {
  return DEAL_STAGES.find(stage => new RegExp(`\\b${stage}\\b`, 'i').test(text)) ?? null;
}
