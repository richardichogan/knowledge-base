/**
 * Document text extraction utilities for PDF, DOCX, PPTX files.
 *
 * Each extractor takes a Buffer and returns plain text.
 * Used by contentStoreSync to index document files as content items.
 */

const pdfParse = require('pdf-parse');
import * as mammoth from 'mammoth';
import JSZip from 'jszip';

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
    const data = await pdfParse(buffer);
    return {
      text: data.text || '',
      pageCount: data.numpages,
      error: undefined,
    };
  } catch (err) {
    return {
      text: '',
      pageCount: 0,
      error: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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
    default:
      return {
        text: '',
        error: `Unsupported format: .${ext}`,
      };
  }
}
