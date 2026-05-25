/* eslint-disable no-console */
import { Pool } from 'pg';
import 'dotenv/config';

const db = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function main(): Promise<void> {
  const { rows: [{ id: parentId }] } = await db.query<{ id: string }>(
    "SELECT id FROM tags WHERE slug = 'architecture-and-method'",
  );
  const { rows: childRows } = await db.query<{ id: string }>(
    'SELECT id FROM tags WHERE parent_id = $1', [parentId],
  );
  const childIds = childRows.map((r) => r.id);
  console.log(`Children to collapse: ${childIds.length}`);

  const compositeTables: Array<[string, string]> = [
    ['content_item_tags',  'content_item_id'],
    ['note_tags',          'note_id'],
    ['discover_item_tags', 'discover_item_id'],
    ['task_tags',          'task_id'],
    ['cfp_item_tags',      'cfp_item_id'],
    ['document_tags',      'doc_id'],
  ];

  for (const [tbl, col] of compositeTables) {
    // Insert parent-tag row for each distinct item that has a child-tag row (skip conflicts)
    await db.query(
      `INSERT INTO ${tbl} (${col}, tag_id)
       SELECT DISTINCT ${col}, $1::uuid
       FROM ${tbl}
       WHERE tag_id = ANY($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [parentId, childIds],
    );
    // Delete all child-tag rows
    const d = await db.query(
      `DELETE FROM ${tbl} WHERE tag_id = ANY($1::uuid[])`,
      [childIds],
    );
    console.log(`  ${tbl}: deleted ${d.rowCount ?? 0} rows`);
  }

  // Tables with standalone PK — just delete
  await db.query('DELETE FROM cert_output_tags  WHERE tag_id = ANY($1::uuid[])', [childIds]);
  await db.query('DELETE FROM repo_tag_mappings WHERE tag_id = ANY($1::uuid[])', [childIds]);

  const del = await db.query('DELETE FROM tags WHERE parent_id = $1', [parentId]);
  console.log(`\nDeleted ${del.rowCount ?? 0} child tags`);

  const { rows: [{ count }] } = await db.query<{ count: string }>('SELECT COUNT(*) FROM tags');
  console.log(`Final tag count: ${count}`);

  const { rows: byRole } = await db.query<{ role: string; count: string }>(
    'SELECT role, COUNT(*) FROM tags GROUP BY role ORDER BY role',
  );
  for (const r of byRole) console.log(`  ${r.role}: ${r.count}`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
