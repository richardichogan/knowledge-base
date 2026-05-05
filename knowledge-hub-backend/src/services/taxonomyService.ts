/**
 * services/taxonomyService.ts
 * AI-driven concept tag application for any content item.
 *
 * Exported functions:
 *   tagContent()  — applies concept tags to one item, queues unknown suggestions
 *   loadConceptTags() — loads the flat concept tag list from the DB
 */
import type { Pool } from 'pg';
import { FoundryClient } from '../ai/foundryClient.js';

/** Flat representation of a concept tag returned by loadConceptTags(). */
export interface ConceptTag {
  id: string;
  name: string;
  parentName: string;
}

/** Result of a single tagging call. */
export interface TaggingResult {
  appliedTagIds: string[];
  suggestedNewTags: string[];
}

const SYSTEM_PROMPT = `You are a content tagging assistant. Given a content item from a personal
knowledge hub and a taxonomy of concept tags, identify which tags apply.

Apply tags conservatively. A tag should be applied only if the content is
substantively about that concept, not merely mentions it in passing.

Apply between 0 and 6 tags per item. Most items will have 2 to 4.
If nothing in the taxonomy fits, return an empty array.

Return ONLY valid JSON in this format:
{
  "tags": ["Tag Name", "Tag Name"],
  "suggested_new_tags": ["Tag Name"]
}

\`suggested_new_tags\` are tags you believe should exist in the taxonomy but do not yet.`;

/**
 * Load all concept tags from the database, grouped with parent names.
 * Cached for the lifetime of the process — concept tags rarely change mid-run.
 */
let _conceptTagCache: ConceptTag[] | null = null;

export async function loadConceptTags(db: Pool): Promise<ConceptTag[]> {
  if (_conceptTagCache) return _conceptTagCache;
  const rows = await db.query<{ id: string; name: string; parent_name: string | null }>(
    `SELECT c.id, c.name, p.name AS parent_name
     FROM tags c LEFT JOIN tags p ON p.id = c.parent_id
     WHERE c.role = 'concept' AND c.parent_id IS NOT NULL
     ORDER BY p.name, c.name`,
  );
  _conceptTagCache = rows.rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentName: r.parent_name ?? 'General',
  }));
  return _conceptTagCache;
}

/** Invalidate the in-process cache (e.g. after seeding). */
export function invalidateConceptTagCache(): void {
  _conceptTagCache = null;
}

/**
 * Apply concept tags to one content item using GPT-4o mini.
 * Writes tag assignments to the appropriate junction table.
 * Queues unknown suggestions into pending_tag_suggestions.
 * Failures are logged but never re-throw — callers must not roll back
 * their own inserts because of a tagging failure.
 */
export async function tagContent(
  db: Pool,
  summary: string,
  contentId: string,
  contentType: 'note' | 'discover_item' | 'task' | 'cfp_item' | 'document' | 'commit' | 'pull_request',
  exampleTitle: string,
): Promise<TaggingResult> {
  try {
    const conceptTags = await loadConceptTags(db);
    if (conceptTags.length === 0) return { appliedTagIds: [], suggestedNewTags: [] };

    const taxonomy = buildTaxonomyListing(conceptTags);
    const truncated = summary.slice(0, 2000);

    const client = new FoundryClient();
    const raw = await client.chat('gpt-4o-mini', [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Content:\n${truncated}\n\nAvailable concept tags:\n${taxonomy}` },
    ], 400);

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { tags?: string[]; suggested_new_tags?: string[] };

    const appliedTagIds: string[] = [];
    for (const tagName of parsed.tags ?? []) {
      const match = conceptTags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
      if (!match) continue;
      await applyTag(db, contentId, contentType, match.id);
      appliedTagIds.push(match.id);
    }

    const suggestedNewTags = parsed.suggested_new_tags ?? [];
    for (const name of suggestedNewTags) {
      await upsertSuggestion(db, name, exampleTitle);
    }

    return { appliedTagIds, suggestedNewTags };
  } catch (err) {
    console.error(`[TaxonomyService] tagging failed for ${contentType}:${contentId}`, err);
    return { appliedTagIds: [], suggestedNewTags: [] };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTaxonomyListing(tags: ConceptTag[]): string {
  const groups: Record<string, string[]> = {};
  for (const t of tags) {
    (groups[t.parentName] ??= []).push(t.name);
  }
  return Object.entries(groups)
    .map(([parent, children]) => `${parent}: ${children.join(', ')}`)
    .join('\n');
}

async function applyTag(
  db: Pool,
  contentId: string,
  contentType: string,
  tagId: string,
): Promise<void> {
  const tableMap: Record<string, { table: string; idCol: string }> = {
    note:         { table: 'note_tags',          idCol: 'note_id' },
    discover_item:{ table: 'discover_item_tags',  idCol: 'discover_item_id' },
    task:         { table: 'task_tags',           idCol: 'task_id' },
  };
  const mapping = tableMap[contentType];
  if (!mapping) return; // commits/PRs/docs/cfp_items stored in content_items — no junction table yet

  await db.query(
    `INSERT INTO ${mapping.table} (${mapping.idCol}, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [contentId, tagId],
  );
}

async function upsertSuggestion(db: Pool, name: string, exampleTitle: string): Promise<void> {
  await db.query(
    `INSERT INTO pending_tag_suggestions (suggested_name, suggested_count, example_content)
     VALUES ($1, 1, ARRAY[$2::text])
     ON CONFLICT (suggested_name) DO UPDATE
       SET suggested_count = pending_tag_suggestions.suggested_count + 1,
           example_content = CASE
             WHEN array_length(pending_tag_suggestions.example_content, 1) < 5
             THEN array_append(pending_tag_suggestions.example_content, $2::text)
             ELSE pending_tag_suggestions.example_content
           END,
           updated_at = now()
     WHERE pending_tag_suggestions.status = 'pending'`,
    [name.trim(), exampleTitle.slice(0, 200)],
  );
}
