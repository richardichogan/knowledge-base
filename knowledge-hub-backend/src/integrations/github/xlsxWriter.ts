/**
 * integrations/github/xlsxWriter.ts — builds a simple .xlsx (one or more
 * sheets of text and numbers, header row in bold, columns sized to fit) from
 * plain rows, e.g. a table in one of Athena's replies. Written directly as
 * the ZIP of XML parts (no `xlsx` package — see documentExtractor.ts).
 */
import JSZip from 'jszip';
import { columnLetter } from './xlsxReader.js';

export interface SheetRows {
  name: string;
  rows: string[][];
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Control characters aren't allowed in XML.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Sheet names: max 31 chars, none of : \ / ? * [ ], unique. */
function sheetNames(sheets: SheetRows[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let name = (s.name.replace(/[:\\/?*[\]]/g, ' ').trim() || `Sheet${(i + 1).toString()}`).slice(0, 31);
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${(n++).toString()}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** A plain number ("1500.5", "-3", "1,234.50") → number; anything else stays text. */
function asNumber(v: string): number | null {
  const t = v.trim();
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function sheetXml(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: width }, (_v, c) => Math.min(60, Math.max(8, ...rows.map((r) => (r[c] ?? '').length + 2))));
  const body = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      const ref = `${columnLetter(ci)}${(ri + 1).toString()}`;
      const style = ri === 0 ? ' s="1"' : '';
      const n = ri === 0 ? null : asNumber(v);
      if (n !== null) return `<c r="${ref}"${style}><v>${n.toString()}</v></c>`;
      if (v === '') return '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${(ri + 1).toString()}">${cells}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + (rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '')
    + `<cols>${widths.map((w, i) => `<col min="${(i + 1).toString()}" max="${(i + 1).toString()}" width="${w.toString()}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${body}</sheetData></worksheet>`;
}

export async function writeXlsx(sheets: SheetRows[]): Promise<Buffer> {
  const names = sheetNames(sheets);
  const zip = new JSZip();
  // No separate folder entries — Excel's own files don't have them.
  const add = (path: string, data: string): void => { zip.file(path, data, { createFolders: false }); };
  add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${(i + 1).toString()}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');
  add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${(i + 1).toString()}" r:id="rId${(i + 1).toString()}"/>`).join('')
    + '</sheets></workbook>');
  add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_s, i) => `<Relationship Id="rId${(i + 1).toString()}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${(i + 1).toString()}.xml"/>`).join('')
    + `<Relationship Id="rId${(sheets.length + 1).toString()}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>');
  add('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
    + '</styleSheet>');
  sheets.forEach((s, i) => { add(`xl/worksheets/sheet${(i + 1).toString()}.xml`, sheetXml(s.rows)); });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
