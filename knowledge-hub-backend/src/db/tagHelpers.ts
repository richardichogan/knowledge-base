/**
 * db/tagHelpers.ts — shared helper to upsert tags into global_tags.
 * Called by notes and projects routes whenever tags are saved.
 */

import type { Pool } from 'pg';

/**
 * Upsert each tag into global_tags, incrementing usage_count on conflict.
 * Safe to call with an empty array (no-op).
 */
export async function upsertTags(db: Pool, tags: string[]): Promise<void> {
  const trimmed = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  if (trimmed.length === 0) return;

  // Build a multi-row VALUES clause: ($1), ($2), ...
  const placeholders = trimmed.map((_, i) => `($${i + 1})`).join(', ');

  await db.query(
    `INSERT INTO global_tags (tag)
     VALUES ${placeholders}
     ON CONFLICT (tag) DO UPDATE
       SET usage_count = global_tags.usage_count + 1,
           updated_at  = NOW()`,
    trimmed,
  );
}
