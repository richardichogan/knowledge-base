/* eslint-disable no-console */
/**
 * consolidate-duplicate-tags.ts
 *
 * Merges duplicate/near-duplicate taxonomy tags into a single canonical tag.
 * For each pair: re-points all junction table rows to the "keep" tag, then deletes the duplicate.
 */

import { Pool } from 'pg';

const db = new Pool({ connectionString: process.env['DATABASE_URL'] });

// All tables that have a tag_id FK to tags.id (simple junction: tag_id + one other FK)
const JUNCTION_TABLES = [
  { table: 'cfp_item_tags',       itemCol: 'cfp_item_id' },
  { table: 'content_item_tags',   itemCol: 'content_item_id' },
  { table: 'task_tags',           itemCol: 'task_id' },
  { table: 'document_tags',       itemCol: 'doc_id' },
  { table: 'discover_item_tags',  itemCol: 'discover_item_id' },
  { table: 'note_tags',           itemCol: 'note_id' },
] as const;

// [keepId, deleteId, reason]
// keepId = the tag we keep
// deleteId = the tag we delete and remap to keepId
const MERGES: Array<{ keep: string; remove: string; reason: string }> = [
  // ── Podcast / Podcasting ──────────────────────────────────────────────────
  {
    keep:   'ab3ebfc4-61b4-47f1-a6ed-525e44d6f1c1', // Podcast
    remove: 'ce8b3931-1b33-41fc-8a27-a345a778e305', // Podcasting
    reason: '"Podcast" and "Podcasting" are the same concept',
  },

  // ── OIDC / OIDC Authentication ────────────────────────────────────────────
  {
    keep:   '3ae76090-2363-477f-abe0-4baa4176d81a', // OIDC
    remove: 'f820aae5-df8a-4495-88c7-1da79ac1dfd9', // OIDC Authentication
    reason: '"OIDC Authentication" is redundant — OIDC already implies auth',
  },

  // ── Automated Merging / Automated Pull Request Merging ────────────────────
  {
    keep:   '579570bc-5cad-4ca7-92cf-1eb515549b03', // Automated Pull Request Merging
    remove: '57adfbf2-1569-487a-bbaa-63d21a120186', // Automated Merging
    reason: '"Automated Merging" is vague — "Automated Pull Request Merging" is specific',
  },

  // ── Production Incidents / Production Incident Management / Production Issue
  {
    keep:   'cb822d35-fa42-4a96-ba41-fba16023f935', // Production Incident Management
    remove: '3893fa24-945b-4f64-aa4b-14ced72d60f0', // Production Incidents
    reason: '"Production Incidents" consolidated into "Production Incident Management"',
  },
  {
    keep:   'cb822d35-fa42-4a96-ba41-fba16023f935', // Production Incident Management
    remove: '9d2c9b3a-9a8a-4d41-9ee4-1d7178de2c12', // Production Issue
    reason: '"Production Issue" consolidated into "Production Incident Management"',
  },

  // ── Field Name Management / Field Naming Conventions ─────────────────────
  {
    keep:   '526a4b54-7c6f-4518-991b-7a360797333a', // Field Naming Conventions
    remove: '342a3882-d518-456e-8763-7f5c9ec5af5c', // Field Name Management
    reason: '"Field Name Management" is a duplicate of "Field Naming Conventions"',
  },

  // ── Blog sub-tags: Blog Maintenance / Blog Post Editing / Blog Post Rendering / Blog SIte
  // These are too granular and fragmented — consolidate into parent "Blog" tag (under d57e1766)
  // But first check if "Blog" (under 368c358b) or the blog parent itself is the right keeper
  // The blog parent is d57e1766, and "Blog Maintenance/Editing/Rendering/Site" are children.
  // Consolidate typo "Blog SIte" → remap to "Blog Post Editing" as closest, but actually
  // "Blog Maintenance" covers maintenance/editing/rendering all at once.
  {
    keep:   '11791537-9284-4343-91d8-a8d306b3093b', // Blog Maintenance
    remove: 'aa0e2d1b-a768-4203-816f-a6ee88528730', // Blog Post Editing
    reason: '"Blog Post Editing" is covered by "Blog Maintenance"',
  },
  {
    keep:   '11791537-9284-4343-91d8-a8d306b3093b', // Blog Maintenance
    remove: 'fca7ca29-67f9-4e00-802a-1d42ac5c36a2', // Blog Post Rendering
    reason: '"Blog Post Rendering" is covered by "Blog Maintenance"',
  },
  {
    keep:   '11791537-9284-4343-91d8-a8d306b3093b', // Blog Maintenance
    remove: 'cd3175f7-331b-4da0-bb7c-73c0eafd61c2', // Blog SIte (typo)
    reason: '"Blog SIte" (typo) consolidated into "Blog Maintenance"',
  },

  // ── Roadmap Planning / Roadmap Tracking ──────────────────────────────────
  {
    keep:   '32c1e35a-8b8d-4edc-a575-0e25808c98a9', // Roadmap Planning
    remove: '5b22dab5-e105-405c-9c3a-10908a49da26', // Roadmap Tracking
    reason: '"Roadmap Tracking" is a subset of "Roadmap Planning"',
  },

  // ── Upload Behavior / Upload Scalability ─────────────────────────────────
  {
    keep:   'a48a0103-a5e6-408f-9db5-da40ffeb21e8', // Upload Behavior
    remove: 'e9a3577d-fd3a-416d-b4ce-7c4e2863b711', // Upload Scalability
    reason: '"Upload Scalability" is a sub-concern of "Upload Behavior"',
  },

  // ── Deployment Safety / Deployment Failure ───────────────────────────────
  {
    keep:   '2fb3c653-f773-4982-89e8-73547d892aad', // Deployment Safety
    remove: '39b0ef07-3c6b-4c8b-ac6d-08d0df84a17f', // Deployment Failure
    reason: '"Deployment Failure" is a sub-concern of "Deployment Safety"',
  },

  // ── Web App Deployment / Azure Web App Deployment / App Service Deployment
  {
    keep:   '90390a56-f1db-45dd-961e-901eba2fdc75', // Azure Web App Deployment
    remove: 'c67e1369-37bc-43e0-8ac8-139126c8e9e9', // Web App Deployment
    reason: '"Web App Deployment" is a duplicate of "Azure Web App Deployment"',
  },
  {
    keep:   '90390a56-f1db-45dd-961e-901eba2fdc75', // Azure Web App Deployment
    remove: '1fd3cf3c-b03d-4d54-8902-d0dd25158ffb', // App Service Deployment
    reason: '"App Service Deployment" is a duplicate of "Azure Web App Deployment"',
  },

  // ── Production Deployment / Demo Deployment ──────────────────────────────
  {
    keep:   '07229e5b-67ad-47f2-814f-8b6e474d9ad0', // Production Deployment
    remove: '507bf4ae-1fd5-4789-846c-f096252fc15d', // Demo Deployment
    reason: '"Demo Deployment" consolidated into "Production Deployment"',
  },

  // ── Pattern Library / Patterns ───────────────────────────────────────────
  {
    keep:   'a298a813-1574-4753-9d9f-18cc2eeb0069', // Pattern Library
    remove: '5fa19efd-a347-4afd-bdb3-643d41f2444f', // Patterns
    reason: '"Patterns" is too vague — consolidated into "Pattern Library"',
  },

  // ── Diagram Assistant / Diagramming Assets ───────────────────────────────
  {
    keep:   'a76054f9-358c-49c8-8a03-985ab7ba02d3', // Diagram Assistant
    remove: '22f752f0-2e14-4131-b96d-e3d53c21ebc5', // Diagramming Assets
    reason: '"Diagramming Assets" consolidated into "Diagram Assistant"',
  },
];

async function mergeTag(keep: string, remove: string, reason: string): Promise<void> {
  console.log(`\n  Merging: ${reason}`);

  // Re-point all junction tables
  for (const { table, itemCol } of JUNCTION_TABLES) {
    // First, delete rows that would cause a duplicate (keep already has this item tagged)
    await db.query(
      `DELETE FROM ${table} t1
       WHERE tag_id = $1
       AND EXISTS (
         SELECT 1 FROM ${table} t2
         WHERE t2.tag_id = $2
         AND t2.${itemCol} = t1.${itemCol}
       )`,
      [remove, keep],
    );

    // Then remap remaining
    const result = await db.query(
      `UPDATE ${table} SET tag_id = $1 WHERE tag_id = $2`,
      [keep, remove],
    );
    if ((result.rowCount ?? 0) > 0) {
      console.log(`    ${table}: remapped ${result.rowCount} rows`);
    }
  }

  // repo_tag_mappings has no per-item column — just remap the tag_id directly
  await db.query(`UPDATE repo_tag_mappings SET tag_id = $1 WHERE tag_id = $2`, [keep, remove]);

  // Update tasks.linked_tag_id
  const taskResult = await db.query(
    `UPDATE tasks SET linked_tag_id = $1 WHERE linked_tag_id = $2`,
    [keep, remove],
  );
  if ((taskResult.rowCount ?? 0) > 0) {
    console.log(`    tasks.linked_tag_id: remapped ${taskResult.rowCount} rows`);
  }

  // Update pending_tag_suggestions
  await db.query(`UPDATE pending_tag_suggestions SET merged_to_id = $1 WHERE merged_to_id = $2`, [keep, remove]);

  // Re-parent any child tags that pointed to the removed tag
  const childResult = await db.query(
    `UPDATE tags SET parent_id = $1 WHERE parent_id = $2`,
    [keep, remove],
  );
  if ((childResult.rowCount ?? 0) > 0) {
    console.log(`    child tags re-parented: ${childResult.rowCount}`);
  }

  // Delete the duplicate tag
  await db.query(`DELETE FROM tags WHERE id = $1`, [remove]);
  console.log(`    ✓ Deleted duplicate tag ${remove}`);
}

async function main() {
  console.log(`Starting tag consolidation — ${MERGES.length} merges planned\n`);

  // Print before count
  const before = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM tags`);
  console.log(`Tags before: ${before.rows[0]?.count ?? '?'}`);

  for (const merge of MERGES) {
    // Verify both tags still exist (earlier merges may have already removed one)
    const check = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM tags WHERE id = ANY($1)`,
      [[merge.keep, merge.remove]],
    );
    const found = check.rows.map(r => r.id);
    if (!found.includes(merge.keep)) {
      console.warn(`\n  SKIP: keep tag ${merge.keep} not found — skipping`);
      continue;
    }
    if (!found.includes(merge.remove)) {
      console.warn(`\n  SKIP: remove tag ${merge.remove} already gone — skipping`);
      continue;
    }

    const keepTag = check.rows.find(r => r.id === merge.keep);
    const removeTag = check.rows.find(r => r.id === merge.remove);
    console.log(`\n► "${removeTag?.name}" → "${keepTag?.name}"`);

    await mergeTag(merge.keep, merge.remove, merge.reason);
  }

  const after = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM tags`);
  console.log(`\n✅ Done. Tags after: ${after.rows[0]?.count ?? '?'} (removed ${parseInt(before.rows[0]?.count ?? '0') - parseInt(after.rows[0]?.count ?? '0')})`);

  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
