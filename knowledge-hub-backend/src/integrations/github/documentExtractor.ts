/**
 * Document text extraction utilities for PDF, DOCX, PPTX files.
 *
 * Each extractor takes a Buffer and returns plain text.
 * Used by contentStoreSync to index document files as content items.
 */

import { createRequire } from 'module';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';

// pdf-parse is CommonJS-only; this package runs under "type": "module", so a
// bare top-level `require` throws at real ESM runtime (tsx's dev loader
// tolerates it, which is why this went unnoticed until a route actually
// imported this module in production).
const require = createRequire(import.meta.url);
// pdf-parse v2 exports a PDFParse class (v1 exported a function — calling
// it that way failed every PDF with "pdfParse is not a function").
interface PdfParser {
  getText: (params?: { partial?: number[] }) => Promise<{ text: string; total: number; pages: Array<{ num: number; text: string }> }>;
  getImage: (params?: { imageThreshold?: number; imageBuffer?: boolean; imageDataUrl?: boolean }) => Promise<{
    pages: Array<{ pageNumber: number; images: Array<{ width: number; height: number }> }>;
  }>;
  getScreenshot: (params?: { partial?: number[]; desiredWidth?: number; imageBuffer?: boolean; imageDataUrl?: boolean }) => Promise<{
    pages: Array<{ pageNumber: number; data: Uint8Array }>;
  }>;
  destroy: () => Promise<void>;
}
const { PDFParse } = require('pdf-parse') as { PDFParse: new (opts: { data: Uint8Array }) => PdfParser };

export interface ExtractionResult {
  text: string;
  pageCount?: number;
  error: string | undefined;
}

/** Decodes the small set of XML entities that appear in OOXML text runs. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Natural-sorts OOXML part names like "slide2.xml" before "slide10.xml". */
function sortByTrailingNumber(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const numA = parseInt(a.match(/(\d+)/)?.[1] ?? '0', 10);
    const numB = parseInt(b.match(/(\d+)/)?.[1] ?? '0', 10);
    return numA - numB;
  });
}

/**
 * Extract text from a PDF buffer.
 * Returns page count and full text concatenated across all pages.
 */
export async function extractPdfText(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const data = await parser.getText();
      return {
        text: data.text || '',
        pageCount: data.total,
        error: undefined,
      };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch (err) {
    return {
      text: '',
      pageCount: 0,
      error: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── PDF with visual pages (diagrams, charts, scans) ──────────────────────────

/** Pages with fewer words than this are treated as visual (diagram/scan). */
const PDF_VISUAL_PAGE_MAX_WORDS = 50;
/** An embedded image at least this large (px area) makes a page worth describing. */
const PDF_LARGE_IMAGE_AREA = 300 * 200;
/** Cap on pages described per document, to bound vision cost. */
export const PDF_MAX_VISUAL_PAGES = 15;

export interface PdfVisualResult extends ExtractionResult {
  /** Pages that were rendered and described. */
  visualPages: number[];
  /** True when more pages qualified than the cap allowed. */
  visualCapped: boolean;
}

/**
 * Extracts a PDF's text and, decided page by page from its content, renders
 * the visual pages — little text (a diagram, chart or scan) or a large
 * embedded image — and adds a description of each from `describe` (vision).
 * Text-heavy pages are only text-extracted.
 */
export async function extractPdfWithVisuals(
  buffer: Buffer,
  describe: (png: Buffer) => Promise<string>,
): Promise<PdfVisualResult> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const textResult = await parser.getText();
    const pages = textResult.pages;

    // Pages carrying a sizeable image (tiny logos/icons filtered out).
    let imagePages = new Set<number>();
    try {
      const images = await parser.getImage({ imageThreshold: 150, imageBuffer: false, imageDataUrl: false });
      imagePages = new Set(images.pages
        .filter((p) => p.images.some((img) => img.width * img.height >= PDF_LARGE_IMAGE_AREA))
        .map((p) => p.pageNumber));
    } catch {
      // Image listing is best-effort; fall back to the word-count rule only.
    }

    const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;
    const qualifying = pages
      .filter((p) => words(p.text) < PDF_VISUAL_PAGE_MAX_WORDS || imagePages.has(p.num))
      .map((p) => p.num);
    const toDescribe = qualifying.slice(0, PDF_MAX_VISUAL_PAGES);

    const descriptions = new Map<number, string>();
    if (toDescribe.length > 0) {
      const shots = await parser.getScreenshot({ partial: toDescribe, desiredWidth: 1400, imageBuffer: true, imageDataUrl: false });
      for (const shot of shots.pages) {
        const text = await describe(Buffer.from(shot.data)).catch(() => '');
        if (text.trim() !== '') descriptions.set(shot.pageNumber, text.trim());
      }
    }

    const body = pages.map((p) => {
      const visual = descriptions.get(p.num);
      return [
        `Page ${p.num.toString()}:`,
        p.text.trim(),
        visual !== undefined ? `[Visual content on page ${p.num.toString()}, described by vision analysis]\n${visual}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    return {
      text: body,
      pageCount: textResult.total,
      visualPages: [...descriptions.keys()],
      visualCapped: qualifying.length > toDescribe.length,
      error: undefined,
    };
  } catch (err) {
    return {
      text: '',
      pageCount: 0,
      visualPages: [],
      visualCapped: false,
      error: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Extract text from a DOCX buffer.
 * Returns full document text.
 */
export async function extractDocxText(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value || '',
      error: undefined,
    };
  } catch (err) {
    return {
      text: '',
      error: `DOCX extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Extract text from a PPTX buffer.
 * PPTX is a ZIP archive with one `ppt/slides/slideN.xml` per slide; each text
 * run lives in an `<a:t>` element. We don't need a full OOXML parse for RAG
 * purposes — regex-extracting `<a:t>` runs per slide is robust enough and
 * avoids pulling in a heavy/vulnerable XML-schema-aware dependency.
 */
export async function extractPptxText(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = sortByTrailingNumber(
      Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
    );
    if (slideNames.length === 0) {
      return { text: '', error: 'PPTX extraction failed: no slides found' };
    }

    const slideTexts: string[] = [];
    for (const [i, slideName] of slideNames.entries()) {
      const slideFile = zip.files[slideName];
      if (!slideFile) continue;
      const xml = await slideFile.async('text');
      const runs = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map((m) => decodeXmlEntities(m[1] ?? ''));
      const slideText = runs.join(' ').replace(/\s+/g, ' ').trim();
      if (slideText) slideTexts.push(`Slide ${i + 1}:\n${slideText}`);
    }

    return { text: slideTexts.join('\n\n'), error: undefined };
  } catch (err) {
    return {
      text: '',
      error: `PPTX extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const XLSX_MAX_ROWS_PER_SHEET = 500;

/**
 * Extract text from an XLSX buffer.
 * XLSX is a ZIP archive: `xl/sharedStrings.xml` holds the deduplicated string
 * table, and each `xl/worksheets/sheetN.xml` holds cell references into it
 * (or inline strings/numbers). We regex-parse both — enough fidelity for
 * RAG ingestion without pulling in the unpatched-on-npm `xlsx` package.
 */
export async function extractXlsxText(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);

    // Shared string table: each <si> block may contain one or more <t> runs
    // (rich text splits a single cell's text across multiple runs).
    const sharedStrings: string[] = [];
    const sharedStringsFile = zip.files['xl/sharedStrings.xml'];
    if (sharedStringsFile) {
      const xml = await sharedStringsFile.async('text');
      const siBlocks = [...xml.matchAll(/<si>(.*?)<\/si>/gs)];
      for (const block of siBlocks) {
        const runs = [...block[1]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => decodeXmlEntities(m[1] ?? ''));
        sharedStrings.push(runs.join(''));
      }
    }

    // Sheet display names, in workbook order, mapped from workbook.xml.
    const workbookFile = zip.files['xl/workbook.xml'];
    const sheetNames: string[] = workbookFile
      ? [...(await workbookFile.async('text')).matchAll(/<sheet[^>]*name="([^"]*)"[^>]*\/>/g)].map((m) =>
          decodeXmlEntities(m[1] ?? ''),
        )
      : [];

    const sheetFileNames = sortByTrailingNumber(
      Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)),
    );
    if (sheetFileNames.length === 0) {
      return { text: '', error: 'XLSX extraction failed: no worksheets found' };
    }

    const sheetTexts: string[] = [];
    for (const [i, sheetFileName] of sheetFileNames.entries()) {
      const sheetFile = zip.files[sheetFileName];
      if (!sheetFile) continue;
      const xml = await sheetFile.async('text');
      const rowBlocks = [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].slice(0, XLSX_MAX_ROWS_PER_SHEET);
      const rowLines: string[] = [];
      for (const rowBlock of rowBlocks) {
        const cells = [...rowBlock[1]!.matchAll(/<c\s+([^>]*?)\/?>(?:(.*?)<\/c>)?/gs)];
        const cellValues = cells.map((cell) => {
          const attrs = cell[1] ?? '';
          const cellType = attrs.match(/\bt="([^"]*)"/)?.[1];
          const cellInner = cell[2] ?? '';
          if (cellType === 's') {
            const idx = parseInt(cellInner.match(/<v>(\d+)<\/v>/)?.[1] ?? '-1', 10);
            return sharedStrings[idx] ?? '';
          }
          if (cellType === 'inlineStr') {
            return decodeXmlEntities(cellInner.match(/<t[^>]*>(.*?)<\/t>/s)?.[1] ?? '');
          }
          return decodeXmlEntities(cellInner.match(/<v>(.*?)<\/v>/s)?.[1] ?? '');
        });
        const line = cellValues.join('\t').trim();
        if (line) rowLines.push(line);
      }
      if (rowLines.length > 0) {
        const sheetName = sheetNames[i] ?? `Sheet ${i + 1}`;
        sheetTexts.push(`Sheet: ${sheetName}\n${rowLines.join('\n')}`);
      }
    }

    return { text: sheetTexts.join('\n\n'), error: undefined };
  } catch (err) {
    return {
      text: '',
      error: `XLSX extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Dispatch extraction based on file extension.
 * Returns empty text if format is unsupported.
 */
export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
): Promise<ExtractionResult> {
  const ext = filename.toLowerCase().split('.').pop() || '';

  switch (ext) {
    case 'pdf':
      return extractPdfText(buffer);
    case 'docx':
      return extractDocxText(buffer);
    case 'pptx':
      return extractPptxText(buffer);
    case 'xlsx':
      return extractXlsxText(buffer);
    case 'md':
    case 'markdown':
    case 'txt':
      return { text: buffer.toString('utf8'), error: undefined };
    default:
      return {
        text: '',
        error: `Unsupported format: .${ext}`,
      };
  }
}
