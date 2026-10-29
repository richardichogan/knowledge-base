import {
  AlignmentType, Document, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph,
  Table, TableCell, TableRow, TextRun, WidthType,
  type IRunOptions, type ParagraphChild,
} from 'docx';
import { inlineText } from './linkLabels';

type Value = Record<string, unknown>;
type WordBlock = Paragraph | Table;
const object = (value: unknown): Value =>
  typeof value === 'object' && value !== null ? value as Value : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function runs(content: unknown, inherited: IRunOptions = {}): TextRun[] {
  if (typeof content === 'string') return [new TextRun({ ...inherited, text: content })];
  return array(content).flatMap(value => {
    const item = object(value);
    // Links retain their styled contents, never their target or hyperlink relationship.
    if (item['type'] === 'link') return runs(item['content'], inherited);
    const styles = object(item['styles']);
    const options: IRunOptions = {
      ...inherited,
      bold: styles['bold'] === true || inherited.bold === true,
      italics: styles['italic'] === true || inherited.italics === true,
      strike: styles['strike'] === true || inherited.strike === true,
      ...(styles['underline'] === true && { underline: {} }),
      ...(styles['code'] === true && { font: 'Consolas' }),
      ...(typeof styles['textColor'] === 'string' && /^#[\da-f]{6}$/i.test(styles['textColor'])
        && { color: styles['textColor'].slice(1) }),
    };
    const text = typeof item['text'] === 'string' ? item['text'] : inlineText(item);
    return text.split('\n').map((line, index) => new TextRun({
      ...options, text: line, ...(index > 0 && { break: 1 }),
    }));
  });
}

async function image(props: Value): Promise<ImageRun> {
  const url = props['url'];
  if (typeof url !== 'string' || !url) throw new Error('An image has no source URL.');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load an image for Word export (${response.status}).`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const width = Math.min(bitmap.width, 600);
    const height = Math.round(bitmap.height * width / bitmap.width);
    // Canvas normalises supported browser images to an embedded PNG, with no external relationship.
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare an image for Word export.');
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode an image.')), 'image/png');
    });
    return new ImageRun({ type: 'png', data: await png.arrayBuffer(), transformation: { width, height } });
  } finally {
    bitmap.close();
  }
}

export async function createWordExport(blocks: unknown[], title: string): Promise<Blob> {
  let listId = 0;
  const numbering: Array<{ reference: string; levels: Array<{
    level: number; format: typeof LevelFormat.DECIMAL | typeof LevelFormat.BULLET;
    text: string; alignment: typeof AlignmentType.LEFT;
    style: { paragraph: { indent: { left: number; hanging: number } } };
  }> }> = [];
  const listReference = (ordered: boolean): string => {
    const reference = `list-${++listId}`;
    numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
      level, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: ordered ? `%${level + 1}.` : '\u2022', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })) });
    return reference;
  };
  const convert = async (values: unknown[], depth = 0): Promise<WordBlock[]> => {
    const result: WordBlock[] = [];
    let activeList: string | undefined;
    let previousType: unknown;
    for (const value of values) {
      const block = object(value);
      const props = object(block['props']);
      const type = block['type'];
      const isList = type === 'bulletListItem' || type === 'numberedListItem';
      if (isList && type !== previousType) activeList = listReference(type === 'numberedListItem');
      if (!isList) activeList = undefined;
      previousType = type;
      const alignment = props['textAlignment'] === 'center' ? AlignmentType.CENTER
        : props['textAlignment'] === 'right' ? AlignmentType.RIGHT
          : props['textAlignment'] === 'justify' ? AlignmentType.JUSTIFIED : AlignmentType.LEFT;
      if (type === 'table') {
        const content = object(block['content']);
        const rows: TableRow[] = [];
        for (const [rowIndex, row] of array(content['rows']).entries()) {
          const cells = array(object(row)['cells']).map((cell, cellIndex) => {
            const data = object(cell);
            const cellProps = object(data['props']);
            const header = rowIndex < Number(content['headerRows'] ?? 0)
              || cellIndex < Number(content['headerCols'] ?? 0);
            return new TableCell({
              children: [new Paragraph({ children: runs(Array.isArray(cell) ? cell : data['content'], { bold: header }) })],
              ...(typeof cellProps['colspan'] === 'number' && cellProps['colspan'] > 1
                && { columnSpan: cellProps['colspan'] }),
              ...(typeof cellProps['rowspan'] === 'number' && cellProps['rowspan'] > 1
                && { rowSpan: cellProps['rowspan'] }),
            });
          });
          if (cells.length) rows.push(new TableRow({ children: cells }));
        }
        if (rows.length) result.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      } else {
        let children: ParagraphChild[] = runs(block['content']);
        if (type === 'image') {
          children = [await image(props)];
        } else if (['file', 'video', 'audio'].includes(String(type))) {
          children = [new TextRun(String(props['caption'] || props['name'] || type))];
        } else if (type === 'checkListItem') {
          children.unshift(new TextRun(props['checked'] === true ? '\u2612 ' : '\u2610 '));
        }
        const level = typeof props['level'] === 'number' ? props['level'] : 1;
        result.push(new Paragraph({
          children, alignment,
          ...(type === 'heading' && { heading: headings[Math.max(0, Math.min(5, level - 1))]! }),
          ...(activeList !== undefined && { numbering: { reference: activeList, level: Math.min(depth, 8) } }),
          ...(type === 'quote' && { indent: { left: 720 }, style: 'Quote' }),
          ...(type === 'codeBlock' && { children: runs(block['content'], { font: 'Consolas', size: 20 }) }),
        }));
        if (typeof props['caption'] === 'string' && props['caption'] && type === 'image') {
          result.push(new Paragraph({ children: [new TextRun({ text: props['caption'], italics: true })] }));
        }
      }
      const nested = array(block['children']);
      if (nested.length) result.push(...await convert(nested, isList ? depth + 1 : depth));
    }
    return result;
  };
  const children = await convert(blocks);
  const firstHeading = object(blocks[0]);
  const hasTitle = firstHeading['type'] === 'heading'
    && inlineText(firstHeading['content']).trim() === title.trim();
  if (!hasTitle) children.unshift(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  return Packer.toBlob(new Document({
    title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 },
      paragraph: { spacing: { after: 160 } } } } },
    numbering: { config: numbering },
    sections: [{ children }],
  }));
}
