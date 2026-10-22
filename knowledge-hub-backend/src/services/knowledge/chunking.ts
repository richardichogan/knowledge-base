/* eslint-disable @typescript-eslint/no-magic-numbers -- time, size and ranking constants */
/**
 * Deterministic, heading-aware passage chunking (spec 5.5).
 *
 * Every chunk is an exact contiguous slice of the canonical text, so offsets
 * are authoritative: text.slice(startOffset, endOffset) === chunk.text. Chunks
 * target 3,000 characters, never exceed 4,000 and begin with up to 400
 * characters of overlap with the previous chunk. No AI step is involved.
 */
import { createHash } from 'node:crypto';

export const CHUNK_TARGET_CHARS = 3000;
export const CHUNK_MAX_CHARS = 4000;
export const CHUNK_OVERLAP_CHARS = 400;
/** Bump when chunking rules change so every hash is invalidated once. */
export const CHUNKING_VERSION = 'c1';

export interface Chunk {
  /** Stable index-safe key: `<parentId>_<ordinal>`. */
  id: string;
  parentId: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  text: string;
  headingPath: string[];
  /** Hash of the chunking version and exact chunk text. */
  hash: string;
  /** Hash of the whole canonical text the chunk was cut from. */
  version: string;
}

interface Unit { start: number; end: number }

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

export function hashText(text: string): string { return sha(text); }

/** Moves a cut point so it never lands between the halves of a surrogate pair. */
function safeCut(text: string, index: number): number {
  return index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1)) ? index - 1 : index;
}

/** Paragraph units separated by blank lines; a heading line starts its own unit. */
function paragraphUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const boundary = /\n[ \t]*\n+|\n(?=#{1,6}[ \t])/g;
  let start = 0;
  for (let m = boundary.exec(text); m !== null; m = boundary.exec(text)) {
    if (m.index > start) units.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < text.length) units.push({ start, end: text.length });
  return units.flatMap((unit) => splitOversize(text, unit));
}

/** Splits a unit larger than the target at sentence/whitespace boundaries. */
function splitOversize(text: string, unit: Unit): Unit[] {
  if (unit.end - unit.start <= CHUNK_TARGET_CHARS) return [unit];
  const parts: Unit[] = [];
  let start = unit.start;
  while (unit.end - start > CHUNK_TARGET_CHARS) {
    const limit = start + CHUNK_TARGET_CHARS;
    const window = text.slice(start + Math.floor(CHUNK_TARGET_CHARS / 2), limit);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const space = window.lastIndexOf(' ');
    const offset = sentence >= 0 ? sentence + 1 : space >= 0 ? space : -1;
    const cut = safeCut(text, offset >= 0 ? start + Math.floor(CHUNK_TARGET_CHARS / 2) + offset + 1 : limit);
    parts.push({ start, end: cut });
    start = cut;
  }
  if (start < unit.end) parts.push({ start, end: unit.end });
  return parts;
}

function headingOf(line: string): { level: number; title: string } | null {
  const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  return m === null ? null : { level: m[1]!.length, title: m[2]! };
}

function nextBoundary(text: string, from: number): number {
  // Start overlap at a word boundary so the passage does not open mid-word.
  const limit = Math.min(text.length, from + 80);
  for (let i = from; i < limit; i += 1) if (/\s/.test(text.charAt(i))) return safeCut(text, i + 1);
  return safeCut(text, from);
}

export function chunkText(parentId: string, text: string): Chunk[] {
  if (text.trim() === '') return [];
  const version = sha(`${CHUNKING_VERSION}\n${text}`);
  const units = paragraphUnits(text);
  const spans: { start: number; end: number; contentStart: number }[] = [];

  let chunkStart = units[0]!.start;
  let contentStart = chunkStart;
  let lastEnd = units[0]!.start;
  for (const unit of units) {
    if (unit.end - chunkStart > CHUNK_TARGET_CHARS && lastEnd > contentStart) {
      spans.push({ start: chunkStart, end: lastEnd, contentStart });
      contentStart = unit.start;
      const overlapFrom = Math.max(chunkStart + 1, lastEnd - CHUNK_OVERLAP_CHARS);
      chunkStart = Math.min(nextBoundary(text, overlapFrom), unit.start);
    }
    lastEnd = unit.end;
  }
  spans.push({ start: chunkStart, end: lastEnd, contentStart });

  const stack: { level: number; title: string }[] = [];
  let scanned = 0;
  return spans.map((span, ordinal) => {
    // Heading path reflects every heading that opens at or before this chunk's own content.
    for (const unit of units) {
      if (unit.start < scanned) continue;
      if (unit.start > span.contentStart) break;
      const heading = headingOf(text.slice(unit.start, unit.end).split('\n', 1)[0] ?? '');
      if (heading !== null) {
        while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
        stack.push(heading);
      }
      scanned = unit.start + 1;
    }
    const chunkText = text.slice(span.start, span.end);
    return {
      id: `${parentId}_${String(ordinal)}`,
      parentId,
      ordinal,
      startOffset: span.start,
      endOffset: span.end,
      text: chunkText,
      headingPath: stack.map((h) => h.title),
      hash: sha(`${CHUNKING_VERSION}\n${chunkText}`),
      version,
    };
  });
}

export interface ChunkPlan {
  /** Chunks whose text is new or changed and must be embedded. */
  toEmbed: Chunk[];
  unchanged: Chunk[];
  /** Ordinals present in the previous index but absent now. */
  staleOrdinals: number[];
}

/** Compares against the previously indexed hashes so unchanged chunks are not re-embedded. */
export function planChunks(chunks: Chunk[], previous: ReadonlyMap<number, string>): ChunkPlan {
  const toEmbed: Chunk[] = [];
  const unchanged: Chunk[] = [];
  for (const chunk of chunks) (previous.get(chunk.ordinal) === chunk.hash ? unchanged : toEmbed).push(chunk);
  const present = new Set(chunks.map((c) => c.ordinal));
  const staleOrdinals = [...previous.keys()].filter((ordinal) => !present.has(ordinal)).sort((a, b) => a - b);
  return { toEmbed, unchanged, staleOrdinals };
}
