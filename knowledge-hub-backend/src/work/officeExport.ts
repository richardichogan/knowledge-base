import type { Pool } from 'pg';
import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, Table, TableRow, TableCell, WidthType,
} from 'docx';
import { createRequire } from 'node:module';
import type pptxgen from 'pptxgenjs';
import { textToBlocks, type NoteInline, type NoteMarkdownBlock, type NoteText } from '../ai/markdownToNoteBlocks.js';
import { getWorkContent, workMarkdown } from './workContent.js';
import { ConflictError, ValidationError } from '../types/errors.js';

export const DELIVERABLE_CONTENT_HEADING = 'Deliverable content';
const MAX_SLIDES = 60;
const MAX_SLIDE_CHARS = 1800;
const MAX_TABLE_ROWS = 12;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_CELL_CHARS = 200;
const SLIDE_WIDTH = 13.333;
const MARGIN = 0.6;
const TITLE_HEIGHT = 0.8;
const BODY_TOP = 1.6;
const BODY_HEIGHT = 5.1;
const BODY_FONT = 20;
const TITLE_FONT = 30;
const TABLE_FONT = 16;
const WORD_SIZE = 22;
const WORD_SPACING = 160;
const FILE_STEM_CHARS = 150;
const SLIDE_TITLE_CHARS = 120;
const LEVEL_TWO = 2;
const LEVEL_THREE = 3;
const WORD_INDENT = 720;
const WORD_HANGING = 360;
const BULLET_INDENT_STEP = 12;
const MAX_SLIDE_LINES = 14;
const SLIDE_LINE_CHARS = 85;
const CONTROL_CHARACTER_LIMIT = 32;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

export interface DeliveryContent {
  title: string; markdown: string; revision: number; noteRevision: number; taskId: string | null;
  fileStem: string;
}
function inlineText(parts: NoteInline[]): string {
  return parts.map(part => part.type === 'text' ? part.text : part.content.map(run => run.text).join('')).join('');
}
function blockText(block: NoteMarkdownBlock): string {
  return block.type === 'table' ? block.content.rows.map(row => row.cells.map(cell => inlineText(cell.content)).join(' | ')).join('\n')
    : block.type === 'divider' ? '' : inlineText(block.content);
}

export function extractDeliverableContent(markdown: string): string {
  const blocks = textToBlocks(markdown);
  const headings = blocks.map((block, index) => ({ block, index })).filter(({ block }) =>
    block.type === 'heading' && inlineText(block.content).trim().toLowerCase() === DELIVERABLE_CONTENT_HEADING.toLowerCase());
  if (headings.length !== 1) throw new ValidationError('Use exactly one level-one “Deliverable content” heading in the brief, followed by the finished content. Brief instructions are not a finished deliverable.');
  const match = headings[0]!;
  if (match.block.type !== 'heading' || match.block.props?.level !== 1) throw new ValidationError('“Deliverable content” must be a level-one heading. Use level-two headings for slides.');
  // The section is the final part of the brief. Keeping it last avoids exporting specification/evidence instructions as content.
  const section = markdown.match(/^# Deliverable content[ \t]*\r?\n([\s\S]*)$/im)?.[1]?.trim();
  if (!section || !blocks.slice(match.index + 1).some(block => blockText(block).trim())) throw new ValidationError('Develop the Deliverable content section in Think before downloading.');
  if (blocks.slice(match.index + 1).some(block => block.type === 'heading' && block.props?.level === 1)) {
    throw new ValidationError('Keep Deliverable content as the final level-one section. Use level-two or deeper headings within it.');
  }
  if (/!\[[^\]]*\](?:\(|\[)/.test(section) || /<(?:img|video|audio|svg)\b/i.test(section)) {
    throw new ValidationError('This download supports editable text, lists and tables. Remove embedded images from Deliverable content or replace them with explicit source links; images are not silently omitted.');
  }
  return section;
}

export async function readDeliveryContent(db: Pool, id: string): Promise<DeliveryContent> {
  const before = await getWorkContent(db, id);
  if (before.type !== 'deliverable-brief') throw new ValidationError('Use a Deliverable brief for Word and PowerPoint downloads.');
  const markdown = extractDeliverableContent(await workMarkdown(db, id));
  const after = await getWorkContent(db, id);
  if (before.noteRevision !== after.noteRevision || before.revision !== after.revision) throw new ConflictError('The brief changed while it was being read. Save and retry.', 'DELIVERY_CONFLICT');
  const note = await db.query<{ content: string }>('SELECT content FROM notes WHERE id=$1', [id]);
  const wrapper: unknown = JSON.parse(note.rows[0]!.content);
  const title = wrapper && typeof wrapper === 'object' && 'title' in wrapper && typeof wrapper.title === 'string' ? wrapper.title : 'Deliverable';
  const fileStem = Array.from(after.fileName.replace(/\.(docx|pptx|xlsx|pdf)$/i, '') || title)
    .map(char => /[/\\:*?"<>|]/.test(char) || char.charCodeAt(0) < CONTROL_CHARACTER_LIMIT ? '-' : char).join('').slice(0, FILE_STEM_CHARS) || 'Deliverable';
  return { title, markdown, fileStem, revision: after.revision, noteRevision: after.noteRevision, taskId: after.taskId };
}

function wordRuns(parts: NoteInline[]): Array<TextRun | ExternalHyperlink> {
  return parts.map(part => part.type === 'link'
    ? new ExternalHyperlink({ link: part.href, children: part.content.map(run => new TextRun({ text: run.text, bold: run.styles.bold === true, italics: run.styles.italic === true, style: 'Hyperlink' })) })
    : new TextRun({ text: part.text, bold: part.styles.bold === true, italics: part.styles.italic === true, strike: part.styles.strike === true,
      ...(part.styles.code ? { font: 'Consolas' } : {}) }));
}
function wordBlocks(blocks: NoteMarkdownBlock[], depth = 0): Array<Paragraph | Table> {
  return blocks.flatMap((block): Array<Paragraph | Table> => {
    if (block.type === 'divider') return [new Paragraph({ text: '', spacing: { after: WORD_SPACING } })];
    if (block.type === 'table') return [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: block.content.rows.map((row, index) => new TableRow({
        tableHeader: index === 0,
        children: row.cells.map(cell => new TableCell({ children: [new Paragraph({ children: wordRuns(cell.content) })] })),
      })),
    })];
    const headings = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
    const heading = block.type === 'heading' ? headings[block.props?.level === LEVEL_THREE ? LEVEL_THREE : LEVEL_TWO] : undefined;
    const paragraph = new Paragraph({
      children: wordRuns(block.content), ...(heading ? { heading } : {}),
      ...(block.type === 'bulletListItem' || block.type === 'checkListItem' ? { bullet: { level: depth } } : {}),
      ...(block.type === 'numberedListItem' ? { numbering: { reference: 'delivery-numbering', level: depth } } : {}),
      spacing: { after: WORD_SPACING },
    });
    return [paragraph, ...wordBlocks(block.children ?? [], depth + 1)];
  });
}
export async function createWordFile(content: DeliveryContent): Promise<Buffer> {
  const doc = new Document({
    creator: 'Athena', title: content.title,
    styles: { default: { document: { run: { font: 'Aptos', size: WORD_SIZE } } } },
    numbering: { config: [{ reference: 'delivery-numbering', levels: Array.from({ length: 9 }, (_, level) => ({
      level, format: 'decimal' as const, text: `%${level + 1}.`, alignment: 'left' as const,
      style: { paragraph: { indent: { left: WORD_INDENT * (level + 1), hanging: WORD_HANGING } } },
    })) }] },
    sections: [{ children: [new Paragraph({ text: content.title, heading: HeadingLevel.TITLE }), ...wordBlocks(textToBlocks(content.markdown))] }],
  });
  return Packer.toBuffer(doc);
}

interface SlideContent { title: string; blocks: NoteMarkdownBlock[] }
export function deliverySlides(markdown: string): SlideContent[] {
  const slides: SlideContent[] = [];
  for (const block of textToBlocks(markdown)) {
    if (block.type === 'heading' && block.props?.level === LEVEL_TWO) slides.push({ title: inlineText(block.content), blocks: [] });
    else if (block.type === 'divider') continue;
    else if (!slides.length && blockText(block).trim()) throw new ValidationError('PowerPoint content must start with a level-two slide title. Each level-two heading starts a slide.');
    else slides[slides.length - 1]?.blocks.push(block);
  }
  if (!slides.length || slides.length > MAX_SLIDES) throw new ValidationError(`Use between 1 and ${MAX_SLIDES} level-two slide headings.`);
  for (const slide of slides) {
    if (!slide.title.trim() || slide.title.length > SLIDE_TITLE_CHARS) throw new ValidationError(`Each slide needs a concise title of up to ${SLIDE_TITLE_CHARS} characters.`);
    if (slide.blocks.map(blockText).join('\n').length > MAX_SLIDE_CHARS) throw new ValidationError(`Slide “${slide.title}” is too dense. Split it into more level-two slide sections before downloading.`);
    const tables = slide.blocks.filter(block => block.type === 'table');
    const estimatedLines = (blocks: NoteMarkdownBlock[]): number => blocks.reduce((total, block) => total
      + blockText(block).split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / SLIDE_LINE_CHARS)), 0)
      + (block.type !== 'table' && block.type !== 'divider' ? estimatedLines(block.children ?? []) : 0), 0);
    if (!tables.length && estimatedLines(slide.blocks) > MAX_SLIDE_LINES) {
      throw new ValidationError(`Slide “${slide.title}” has too many text lines. Split it into more slides to keep the deck readable.`);
    }
    if (tables.length > 1 || tables.length && slide.blocks.some(block => block.type !== 'table' && blockText(block).trim())) {
      throw new ValidationError(`Slide “${slide.title}” needs its table on a dedicated slide to preserve legibility.`);
    }
    for (const table of tables) {
      if (table.type === 'table' && (table.content.rows.length > MAX_TABLE_ROWS || table.content.rows.some(row =>
        row.cells.length > MAX_TABLE_COLUMNS || row.cells.some(cell => inlineText(cell.content).length > MAX_TABLE_CELL_CHARS)))) {
        throw new ValidationError(`Table on “${slide.title}” is too large. Split it into tables with at most ${MAX_TABLE_ROWS} rows, ${MAX_TABLE_COLUMNS} columns and ${MAX_TABLE_CELL_CHARS} characters per cell.`);
      }
    }
  }
  return slides;
}
function slideRuns(blocks: NoteMarkdownBlock[], depth = 0): pptxgen.default.TextProps[] {
  return blocks.flatMap((block): pptxgen.default.TextProps[] => {
    if (block.type === 'table' || block.type === 'divider') return [];
    const spans = block.content.flatMap((part): Array<NoteText & { href: string | undefined }> => part.type === 'text' ? [{ ...part, href: undefined }]
      : part.content.map(run => ({ ...run, href: part.href })));
    const runs = spans.map((part, index) => ({
      text: part.text,
      options: { bold: part.styles.bold === true || block.type === 'heading', italic: part.styles.italic === true,
        ...(part.href ? { hyperlink: { url: part.href } } : {}),
        ...(index === 0 && ['bulletListItem', 'numberedListItem', 'checkListItem'].includes(block.type)
          ? { bullet: block.type === 'numberedListItem' ? { type: 'number' as const } : { indent: BODY_FONT + depth * BULLET_INDENT_STEP } } : {}),
      },
    }));
    return [...runs, { text: '\n', options: { breakLine: false } }, ...slideRuns(block.children ?? [], depth + 1)];
  });
}
export async function createPowerPointFile(content: DeliveryContent): Promise<Buffer> {
  // Use the package's Node/CommonJS entry; its ESM entry cycles under the server's tsx loader.
  const PowerPoint: unknown = createRequire(import.meta.url)('pptxgenjs');
  const isPowerPointConstructor = (value: unknown): value is typeof pptxgen.default =>
    typeof value === 'function' && 'prototype' in value && isObject(value.prototype) && typeof value.prototype.addSlide === 'function';
  if (!isPowerPointConstructor(PowerPoint)) throw new Error('The PowerPoint generator did not load correctly.');
  const deck = new PowerPoint();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'Athena';
  deck.subject = 'Editable deliverable developed in Think';
  deck.title = content.title;
  deck.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' };
  for (const item of deliverySlides(content.markdown)) {
    const slide = deck.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(item.title, { x: MARGIN, y: MARGIN, w: SLIDE_WIDTH - MARGIN - MARGIN, h: TITLE_HEIGHT,
      fontFace: 'Aptos Display', fontSize: TITLE_FONT, bold: true, color: '202020', margin: 0, breakLine: false });
    const table = item.blocks.find(block => block.type === 'table');
    if (table?.type === 'table') {
      slide.addTable(table.content.rows.map(row => row.cells.map(cell => ({ text: inlineText(cell.content) }))), {
        x: MARGIN, y: BODY_TOP, w: SLIDE_WIDTH - MARGIN - MARGIN, h: BODY_HEIGHT, fontSize: TABLE_FONT,
        color: '202020', border: { color: 'D0D0D0', pt: 1 }, fill: { color: 'FFFFFF' }, margin: 0.08,
        autoPage: false, bold: false,
      });
    } else slide.addText(slideRuns(item.blocks), {
      x: MARGIN, y: BODY_TOP, w: SLIDE_WIDTH - MARGIN - MARGIN, h: BODY_HEIGHT,
      fontSize: BODY_FONT, color: '202020', margin: 0, valign: 'top', fit: 'shrink', paraSpaceAfter: 10,
    });
    slide.addNotes(`Source: ${content.title}. Saved Think note revision ${content.noteRevision}; linked task ${content.taskId ?? 'not set'}.`);
  }
  const output = await deck.write({ outputType: 'nodebuffer' });
  if (!Buffer.isBuffer(output)) throw new Error('PowerPoint generation did not return a file buffer.');
  return output;
}
export async function exportDelivery(db: Pool, id: string, format: unknown, revision: unknown, noteRevision: unknown): Promise<{ buffer: Buffer; filename: string; mime: string }> {
  if (format !== 'docx' && format !== 'pptx') throw new ValidationError('Choose Word or PowerPoint.');
  const content = await readDeliveryContent(db, id);
  if (content.revision !== revision || content.noteRevision !== noteRevision) throw new ConflictError('The brief or content changed. Save and review it before downloading.', 'DELIVERY_CONFLICT');
  const buffer = format === 'docx' ? await createWordFile(content) : await createPowerPointFile(content);
  const current = await getWorkContent(db, id);
  if (current.revision !== content.revision || current.noteRevision !== content.noteRevision) throw new ConflictError('The content changed during generation. Save and retry.', 'DELIVERY_CONFLICT');
  return { buffer, filename: `${content.fileStem}.${format}`, mime: format === 'docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
}
