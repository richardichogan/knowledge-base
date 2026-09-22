/**
 * noteTextService — renders a stored note into plain text for indexing and
 * for handing to the model.
 *
 * Notes are stored as a `{ title, contentType, contentJson }` wrapper where
 * contentJson is a serialised BlockNote block array. That raw JSON must never
 * be what reaches Postgres FTS or the Foundry IQ embedding: BlockNote emits
 * roughly 180 characters of structural boilerplate per 20 characters of real
 * prose, so an embedding built from the raw JSON is mostly noise that is
 * identical across every note — long notes become effectively invisible to
 * semantic search and every note looks alike. Rendering to plain text first
 * is what makes note retrieval work at all.
 *
 * Image blocks are replaced with their stored vision analysis so a pasted
 * diagram or screenshot contributes its actual meaning to both the index and
 * the model's view of the note.
 */

import type { Pool } from 'pg';
import {
  parseNoteContent,
  extractImageBlockUrls,
  blocksToTextWithImages,
  blobIdFromUrl,
} from '../utils/noteContent.js';

/**
 * Renders a note's raw stored content as plain text, substituting each
 * embedded image block with its stored vision analysis.
 *
 * If the input has no parseable blocks it is assumed to already be plain text
 * and returned as-is. That fallback matters: `content_items.body` for notes now
 * holds rendered text rather than the original wrapper JSON, so callers that
 * re-render a stored body would otherwise get an empty string back.
 */
export async function renderNoteAsText(db: Pool, rawContentJson: string): Promise<string> {
  const { blocks } = parseNoteContent(rawContentJson);
  if (blocks.length === 0) return rawContentJson;

  const imageUrls = extractImageBlockUrls(blocks);
  const visionByBlobId = new Map<string, string>();
  if (imageUrls.length > 0) {
    const ids = imageUrls.map(blobIdFromUrl).filter((id) => id !== '');
    if (ids.length > 0) {
      try {
        const result = await db.query<{ id: string; vision_analysis: string }>(
          `SELECT id, vision_analysis FROM kb_images WHERE id = ANY($1)`,
          [ids],
        );
        for (const row of result.rows) {
          if (row.vision_analysis !== '') visionByBlobId.set(row.id, row.vision_analysis);
        }
      } catch (err) {
        // Vision lookup is an enrichment — never fail the render over it.
        console.error('[noteText] Vision analysis lookup failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  return blocksToTextWithImages(blocks, visionByBlobId);
}
