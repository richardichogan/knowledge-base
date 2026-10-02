/**
 * integrations/github/xlsxReader.ts — reads an .xlsx (or .csv) into a grid
 * of cells that keeps each value in its real column, shows dates as dates,
 * and keeps formulas next to their results; then lays each sheet out as a
 * table with column letters and row numbers, so Athena reads it the way it
 * looks in Excel. XLSX is a ZIP of XML parts, parsed directly (no `xlsx`
 * package — see documentExtractor.ts).
 */
import JSZip from 'jszip';

export interface SheetGrid {
  name: string;
  /** rows[r][c] — '' for empty cells. Row 0 is spreadsheet row 1. */
  rows: string[][];
  /** Rows in the sheet (before the row limit). */
  totalRows: number;
}

const MAX_ROWS_PER_SHEET = 500;
const MAX_COLUMNS = 40;
const MAX_CELL_CHARS = 200;

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** "C" → 2, "AA" → 26. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 2 → "C". */
export function columnLetter(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Built-in number formats that are dates/times (ECMA-376 18.8.30).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dyhs]/i.test(bare) || /m/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** Excel serial date → "2026-10-01" (or with " 14:30" when there's a time part). */
function serialToDate(serial: number, date1904: boolean): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + Math.round(serial * 86_400_000));
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return serial % 1 === 0 || time === '00:00' ? date : `${date} ${time}`;
}

export async function readXlsx(buffer: Buffer): Promise<SheetGrid[]> {
  const zip = await JSZip.loadAsync(buffer);
  const text = async (path: string): Promise<string> => (await zip.file(path)?.async('text')) ?? '';

  const sharedStrings = [...(await text('xl/sharedStrings.xml')).matchAll(/<si>(.*?)<\/si>/gs)]
    .map((si) => [...si[1]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => decodeXml(t[1] ?? '')).join(''));

  // Which cell styles are dates.
  const styles = await text('xl/styles.xml');
  const customFormats = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) customFormats.set(Number(m[1]), decodeXml(m[2] ?? ''));
  const cellXfs = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(styles)?.[1] ?? '';
  const dateStyles = [...cellXfs.matchAll(/<xf\b([^>]*)/g)].map((xf) => {
    const id = Number(/numFmtId="(\d+)"/.exec(xf[1] ?? '')?.[1] ?? '0');
    return BUILTIN_DATE_FORMATS.has(id) || (customFormats.has(id) && isDateFormatCode(customFormats.get(id)!));
  });

  // Sheets in workbook order, resolved to their part files through the relationships.
  const workbook = await text('xl/workbook.xml');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(workbook);
  const rels = new Map<string, string>();
  for (const m of (await text('xl/_rels/workbook.xml.rels')).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1] ?? '')?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1] ?? '')?.[1];
    if (id !== undefined && target !== undefined) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decodeXml(/\bname="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? 'Sheet'),
    path: `xl/${rels.get(/\br:id="([^"]+)"/.exec(m[1] ?? '')?.[1] ?? '') ?? ''}`,
  }));

  const grids: SheetGrid[] = [];
  for (const sheet of sheets) {
    const xml = await text(sheet.path);
    if (xml === '') continue;
    const rows: string[][] = [];
    let totalRows = 0;
    for (const row of xml.matchAll(/<row\b([^>]*)>(.*?)<\/row>/gs)) {
      const rowNumber = Number(/\br="(\d+)"/.exec(row[1] ?? '')?.[1] ?? rows.length + 1);
      totalRows = Math.max(totalRows, rowNumber);
      if (rowNumber > MAX_ROWS_PER_SHEET) continue;
      const cells: string[] = [];
      let nextCol = 0;
      for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
        const attrs = cell[1] ?? '';
        const inner = cell[2] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const col = ref !== undefined ? columnIndex(ref) : nextCol;
        nextCol = col + 1;
        if (col >= MAX_COLUMNS) continue;
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
        const raw = /<v>(.*?)<\/v>/s.exec(inner)?.[1];
        let value = '';
        if (type === 's') value = sharedStrings[Number(raw ?? -1)] ?? '';
        else if (type === 'inlineStr') value = decodeXml(/<t[^>]*>(.*?)<\/t>/s.exec(inner)?.[1] ?? '');
        else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
        else if (raw !== undefined) {
          const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? '0');
          const n = Number(raw);
          value = type !== 'e' && type !== 'str' && dateStyles[style] === true && Number.isFinite(n) ? serialToDate(n, date1904) : decodeXml(raw);
        }
        const formula = /<f[^>]*>(.*?)<\/f>/s.exec(inner)?.[1];
        if (formula !== undefined && formula !== '') value = `${value} (=${decodeXml(formula)})`;
        else if (/<f\b[^>]*t="shared"/.test(inner)) value = `${value} (formula)`;
        while (cells.length < col) cells.push('');
        cells[col] = value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
      }
      while (rows.length < rowNumber - 1) rows.push([]);
      rows[rowNumber - 1] = cells;
    }
    grids.push({ name: sheet.name, rows, totalRows });
  }
  return grids;
}

/** Parses CSV text (quoted fields, embedded commas/quotes/newlines) into one grid. */
export function readCsv(textIn: string, name: string): SheetGrid {
  const textBody = textIn.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let totalRows = 0;
  for (let i = 0; i < textBody.length; i++) {
    const ch = textBody[i]!;
    if (quoted) {
      if (ch === '"' && textBody[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && textBody[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      totalRows += 1;
      if (rows.length < MAX_ROWS_PER_SHEET) rows.push(row.slice(0, MAX_COLUMNS));
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    totalRows += 1;
    if (rows.length < MAX_ROWS_PER_SHEET) rows.push(row.slice(0, MAX_COLUMNS));
  }
  return { name, rows, totalRows };
}

function escapeCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Each sheet as a table with column letters and row numbers (blank rows dropped). */
export function formatSheets(grids: SheetGrid[]): string {
  return grids.map((g) => {
    const width = Math.max(0, ...g.rows.map((r) => r.length));
    const used = g.rows.map((r, i) => ({ r, n: i + 1 })).filter(({ r }) => r.some((v) => v !== ''));
    if (width === 0 || used.length === 0) return '';
    const letters = Array.from({ length: width }, (_v, i) => columnLetter(i));
    const shown = Math.min(g.totalRows, MAX_ROWS_PER_SHEET);
    const header = `Sheet: ${g.name} (rows 1–${shown.toString()}${g.totalRows > MAX_ROWS_PER_SHEET ? ` of ${g.totalRows.toString()} — the rest are not included` : ''}; columns A–${letters[letters.length - 1]!})`;
    return [
      header,
      `| Row | ${letters.join(' | ')} |`,
      `|---|${letters.map(() => '---').join('|')}|`,
      ...used.map(({ r, n }) => `| ${n.toString()} | ${letters.map((_l, c) => escapeCell(r[c] ?? '')).join(' | ')} |`),
    ].join('\n');
  }).filter(Boolean).join('\n\n');
}
