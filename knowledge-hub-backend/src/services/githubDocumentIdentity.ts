import type { Pool } from 'pg';
import { deleteIndexedContentItems } from '../ai/foundryIqIndexer.js';

export function githubDocumentId(repo: string, path: string): string {
  return `${repo}::${path}`;
}

export async function publishedNotePaths(db: Pool, repo: string): Promise<Set<string>> {
  const rows = await db.query<{ path: string }>('SELECT path FROM note_github_publications WHERE lower(repo) = lower($1)', [repo]);
  return new Set(rows.rows.map(row => row.path));
}

export async function removeGitHubDocumentCopies(db: Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;
  // Remove the vector copy first. A failure keeps the database rows so the next
  // sync can retry cleanup instead of orphaning searchable stale documents.
  await deleteIndexedContentItems(ids);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM nodes WHERE ref_type = 'document' AND ref_id::text = ANY($1::text[])", [ids]);
    await client.query("DELETE FROM content_items WHERE id::text = ANY($1::text[]) AND source IN ('github-doc', 'github-content-store')", [ids]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

export async function removePublishedNoteCopies(db: Pool, repo: string): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `SELECT ci.id FROM content_items ci JOIN note_github_publications p
     ON lower(p.repo) = lower(ci.metadata->>'repo') AND p.path = ci.metadata->>'path'
     WHERE lower(p.repo) = lower($1) AND ci.source IN ('github-doc', 'github-content-store')`, [repo]);
  await removeGitHubDocumentCopies(db, rows.rows.map(row => row.id));
}

/** Preserve the original item ID (and its links) when upgrading from hash keys. */
export async function reconcileContentStore(
  db: Pool, repo: string, livePaths: Set<string>, notePaths: Set<string>,
): Promise<void> {
  const rows = await db.query<{ id: string; path: string; source_id: string }>(
    `SELECT id, metadata->>'path' AS path, source_id FROM content_items
     WHERE source = 'github-content-store' AND lower(metadata->>'repo') = lower($1)
     ORDER BY indexed_at, id`, [repo]);
  const keep = new Map<string, { id: string; source_id: string }>();
  const discard: string[] = [];
  for (const row of rows.rows) {
    if (!livePaths.has(row.path) || notePaths.has(row.path) || keep.has(row.path)) discard.push(row.id);
    else keep.set(row.path, row);
  }
  await removeGitHubDocumentCopies(db, discard);
  for (const [path, row] of keep) {
    const sourceId = githubDocumentId(repo, path);
    if (row.source_id !== sourceId) {
      await db.query("UPDATE content_items SET source_id = $2 WHERE id = $1 AND source = 'github-content-store'", [row.id, sourceId]);
    }
  }
  await removePublishedNoteCopies(db, repo);
}
