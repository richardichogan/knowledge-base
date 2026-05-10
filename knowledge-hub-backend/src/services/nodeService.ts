/**
 * services/nodeService.ts
 * Maintains the nodes table — an index over all content types for the graph layer.
 *
 * Exported functions:
 *   upsertNode()    — insert or update a single node
 *   deleteNode()    — remove a node (cascades edges automatically)
 *   syncAllNodes()  — full sweep upsert from all eight content tables
 */
import type { Pool } from 'pg';

/** Supported content ref types — must match edge_type constants in edgeService.ts */
export const REF_TYPES = [
  'discover_item', 'cfp_item', 'spark', 'note',
  'document', 'task', 'commit', 'pull_request',
  'blog_post', 'podcast_episode',
] as const;

export type RefType = typeof REF_TYPES[number];

/** A graph node mirroring a content item. */
export interface GraphNode {
  id: string;
  refId: string;
  refType: RefType;
  title: string;
  tags: string[];
  updatedAt: string;
}

/**
 * Upserts a single node keyed on (ref_id, ref_type).
 * Returns the node's UUID.
 */
export async function upsertNode(
  db: Pool,
  refId: string,
  refType: RefType,
  title: string,
  tags: string[],
): Promise<string> {
  const row = await db.query<{ id: string }>(
    `INSERT INTO nodes (ref_id, ref_type, title, tags)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ref_id, ref_type) DO UPDATE
       SET title = EXCLUDED.title, tags = EXCLUDED.tags, updated_at = now()
     RETURNING id`,
    [refId, refType, title, tags],
  );
  return row.rows[0]!.id;
}

/** Deletes a node and its edges (edges cascade automatically). */
export async function deleteNode(db: Pool, refId: string, refType: RefType): Promise<void> {
  await db.query('DELETE FROM nodes WHERE ref_id = $1 AND ref_type = $2', [refId, refType]);
}

/**
 * Full-sweep sync: upserts nodes for all content tables.
 * Safe to run repeatedly — uses ON CONFLICT DO UPDATE.
 */
export async function syncAllNodes(db: Pool): Promise<void> {
  await Promise.all([
    syncDiscoverItems(db),
    syncCfpItems(db),
    syncSparks(db),
    syncNotes(db),
    syncDocuments(db),
    syncTasks(db),
    syncCommits(db),
  ]);
}

async function syncDiscoverItems(db: Pool): Promise<void> {
  const rows = await db.query<{ id: string; title: string }>(
    `SELECT id::text, COALESCE(title, url, 'Untitled') AS title
     FROM content_items WHERE source = 'discovered-article'`,
  );
  for (const r of rows.rows) await upsertNode(db, r.id, 'discover_item', r.title, []);
}

async function syncCfpItems(db: Pool): Promise<void> {
  const rows = await db.query<{ id: string; conference_name: string }>(
    `SELECT id::text, COALESCE(conference_name, 'Untitled CFP') AS conference_name FROM cfp_items`,
  );
  for (const r of rows.rows) await upsertNode(db, r.id, 'cfp_item', r.conference_name, []);
}

async function syncSparks(db: Pool): Promise<void> {
  const MAX_TITLE_LEN = 80;
  const TRUNCATE_AT = 77;
  const rows = await db.query<{ id: string; body: string; tags: string[] }>(
    `SELECT id::text, body, tags FROM sparks`,
  );
  for (const r of rows.rows) {
    const title = r.body.length > MAX_TITLE_LEN ? r.body.slice(0, TRUNCATE_AT) + '…' : r.body;
    await upsertNode(db, r.id, 'spark', title, r.tags);
  }
}

async function syncNotes(db: Pool): Promise<void> {
  const rows = await db.query<{ id: string; content: string }>(
    `SELECT id::text, content FROM notes`,
  );
  for (const r of rows.rows) {
    let title = 'Untitled Note';
    try { const p = JSON.parse(r.content) as { title?: string }; title = p.title ?? title; } catch { /* ignore */ }
    await upsertNode(db, r.id, 'note', title, []);
  }
}

async function syncDocuments(db: Pool): Promise<void> {
  // Documents live in content_items with source = 'github-doc'
  const rows = await db.query<{ id: string; title: string }>(
    `SELECT id::text, COALESCE(title, 'Untitled Document') AS title
     FROM content_items WHERE source = 'github-doc'`,
  );
  for (const r of rows.rows) await upsertNode(db, r.id, 'document', r.title, []);
}

async function syncTasks(db: Pool): Promise<void> {
  const rows = await db.query<{ id: string; title: string }>(
    `SELECT id::text, COALESCE(title, 'Untitled Task') AS title FROM tasks`,
  );
  for (const r of rows.rows) await upsertNode(db, r.id, 'task', r.title, []);
}

async function syncCommits(db: Pool): Promise<void> {
  const rows = await db.query<{ id: string; title: string }>(
    `SELECT id::text, COALESCE(title, source_id, 'Commit') AS title
     FROM content_items WHERE source IN ('github-commit', 'gitlab-commit')`,
  );
  for (const r of rows.rows) await upsertNode(db, r.id, 'commit', r.title, []);
}
