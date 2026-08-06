/**
 * Document text extraction utilities for PDF, DOCX, PPTX files.
 *
 * Each extractor takes a Buffer and returns plain text.
 * Used by contentStoreSync to index document files as content items.
 */

const pdfParse = require('pdf-parse');
import * as mammoth from 'mammoth';

export interface ExtractionResult {
  text: string;
  pageCount?: number;
  error: string | undefined;
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
 * PPTX is a ZIP archive containing XML files. Placeholder for now.
 */
export async function extractPptxText(_buffer: Buffer): Promise<ExtractionResult> {
  // Placeholder — PPTX support requires XML parsing
  return {
    text: '[PPTX file detected — text extraction not yet implemented]',
    error: undefined,
  };
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
    default:
      return {
        text: '',
        error: `Unsupported format: .${ext}`,
      };
  }
}
