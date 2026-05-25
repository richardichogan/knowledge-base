/* eslint-disable no-console */
/**
 * collapse-tags.ts — Tag taxonomy consolidation
 *
 * Collapses ~459 concept + filing children down to ~40 canonical tags.
 *
 * Strategy per removed tag:
 *   1. Find all junction table rows pointing to it
 *   2. Re-point them to the designated keeper (or parent)
 *   3. Delete the orphaned tag row
 *
 * Safe to re-run — skips tags that don't exist.
 */

import { Pool } from 'pg';

const db = new Pool({ connectionString: process.env['DATABASE_URL'] });

// ── All junction tables that carry a tag_id FK ────────────────────────────────
// compositeKey = true  → PK is (itemCol, tag_id), no separate id column
// compositeKey = false → PK is a standalone `id` column

const JUNCTION_TABLES: Array<{ table: string; itemCol: string; compositeKey: boolean }> = [
  { table: 'cert_output_tags',  itemCol: 'output_id',        compositeKey: true },
  { table: 'cfp_item_tags',     itemCol: 'cfp_item_id',      compositeKey: true },
  { table: 'content_item_tags', itemCol: 'content_item_id',  compositeKey: true },
  { table: 'task_tags',         itemCol: 'task_id',          compositeKey: true },
  { table: 'document_tags',     itemCol: 'doc_id',           compositeKey: true },
  { table: 'discover_item_tags',itemCol: 'discover_item_id', compositeKey: true },
  { table: 'note_tags',         itemCol: 'note_id',          compositeKey: true },
  // repo_tag_mappings has PK `id` — each row maps one tag to arrays of repos
  // Simply delete the row; arrays have no dedup issue.
  { table: 'repo_tag_mappings', itemCol: 'id',               compositeKey: false },
];

// ── Remapping table: remove_slug → keep_slug ──────────────────────────────────
// Ordered so children are processed before any parent collapse.

const REMAP: Array<[string, string]> = [

  // ── AI children ─────────────────────────────────────────────────────────────
  ['ai-architecture',             'generative-ai'],
  ['ai-assisted-development',     'generative-ai'],
  ['ai-dashboard',                'ai-observability'],
  ['ai-driven-job-market',        'ai'],
  ['ai-for-non-developers',       'ai'],
  ['ai-integration',              'generative-ai'],
  ['copilot-best-practices',      'copilot'],
  ['copilot-studio',              'copilot'],
  ['data-model-design',           'generative-ai'],
  ['microsoft-365-copilot',       'copilot'],
  ['models',                      'generative-ai'],
  ['rag',                         'generative-ai'],
  ['structara-ai',                'ai'],
  ['structara-ai-pipeline',       'ai'],
  ['agentic-devops',              'devops-and-automation'],

  // ── DevOps and Automation children ──────────────────────────────────────────
  ['artifact-caching',            'cicd'],
  ['azure-verified-modules',      'infrastructure-as-code'],
  ['code-documentation-automation','developer-productivity-tools'],
  ['code-quality-gates',          'cicd'],
  ['crossplane',                  'infrastructure-as-code'],
  ['dependabot-automation',       'cicd'],
  ['epac',                        'infrastructure-as-code'],
  ['frontend-testing',            'cicd'],
  ['jest',                        'cicd'],
  ['keda',                        'container-orchestration'],
  ['linting',                     'cicd'],
  ['pipeline-modernization',      'cicd'],
  ['self-healing-infrastructure', 'infrastructure-as-code'],
  ['vercel-automation',           'cicd'],

  // ── Microsoft Cloud children ─────────────────────────────────────────────────
  ['adoption',                         'microsoft-cloud'],
  ['apps-on-azure',                    'azure'],
  ['azure-ad-application-registration','microsoft-entra'],
  ['azure-blog',                       'azure'],
  ['azure-cli',                        'azure'],
  ['azure-devops',                     'cicd'],
  ['azure-infrastructure-blog',        'azure'],
  ['azure-local',                      'azure'],
  ['azure-log-analytics',              'azure-monitor'],
  ['azure-roleassignments',            'microsoft-entra'],
  ['azure-web-app-deployment',         'azure'],
  ['blob-storage',                     'azure'],
  ['cloud-operations',                 'azure'],
  ['dynamics-365',                     'microsoft-365'],
  ['key-vault-management',             'microsoft-entra'],
  ['microsoft-partnership-manager',    'microsoft-cloud'],
  ['microsoft-uk-stories',             'microsoft-cloud'],
  ['power-pages',                      'power-platform'],
  ['sharepoint',                       'microsoft-365'],
  ['sovereign-cloud',                  'azure'],
  ['teams',                            'microsoft-365'],

  // ── Observability and Data children ─────────────────────────────────────────
  ['adx-ingestion',               'azure-monitor'],
  ['adx-integration',             'azure-monitor'],
  ['ai-for-operations',           'analytics'],
  ['alert-aggregation',           'azure-monitor'],
  ['analytics-calculation-script','analytics'],
  ['benchmarking',                'analytics'],
  ['cloudflare',                  'observability-and-data'],
  ['cost-optimization',           'finops'],
  ['dashboard-coverage-calculation','analytics'],
  ['dashboard-engineering',       'analytics'],
  ['dashboard-implementation',    'analytics'],
  ['data-lake-integration',       'databases'],
  ['drift-detection',             'azure-monitor'],
  ['lake-data-analysis',          'analytics'],
  ['lake-tables',                 'databases'],
  ['redis-enterprise',            'databases'],
  ['root-cause-analysis',         'azure-monitor'],
  ['screen-recording',            'observability-and-data'],
  ['status-page-transparency',    'azure-monitor'],
  ['synapse',                     'databases'],
  ['token-economics',             'finops'],
  ['trace-clarity',               'telemetry'],
  ['transparency',                'observability-and-data'],

  // ── Security and Identity children ──────────────────────────────────────────
  ['agentic-identity',                 'identity-governance'],
  ['agent-network-security',           'cloud-security'],
  ['attack-simulation-enhancements',   'microsoft-security'],
  ['attack-visualization',             'microsoft-security'],
  ['cryptographic-posture-management', 'compliance'],
  ['cyber-asset-fingerprinting',       'cloud-security'],
  ['defender-logs',                    'sentinel'],
  ['honeypot',                         'cloud-security'],
  ['multi-user-support',               'access-control'],
  ['oauth-security',                   'identity-governance'],
  ['oidc',                             'identity-governance'],
  ['privacy',                          'compliance'],
  ['privileged-access',                'access-control'],
  ['red-teaming',                      'cloud-security'],
  ['risk-management',                  'governance'],
  ['robotstxt',                        'cloud-security'],
  ['sase',                             'cloud-security'],
  ['sas-token-management',             'access-control'],
  ['security-views',                   'microsoft-security'],
  ['sentinel-data-lake',               'sentinel'],
  ['spam-protection',                  'email-security'],
  ['subscriber-quarantine',            'email-security'],

  // ── Industry children ────────────────────────────────────────────────────────
  ['ai-for-insurance-claims',   'financial-services'],
  ['claims-dashboard',          'financial-services'],
  ['customer-service',          'contact-center'],
  ['datacenter-architecture',   'industry'],
  ['digital-twin',              'manufacturing'],
  ['edge-computing',            'industry'],
  ['electric-grid',             'industry'],
  ['electric-power-systems',    'industry'],
  ['electric-transmission',     'industry'],
  ['electric-utilities',        'industry'],
  ['energy-infrastructure',     'industry'],
  ['grid-snap',                 'industry'],
  ['grid-topology',             'industry'],
  ['legal',                     'industry'],
  ['open-energy-dataset',       'industry'],
  ['power-grid',                'industry'],
  ['transmission-grid-modeling','industry'],
  ['workforce-planning',        'industry'],

  // ── Eminence / filing children ───────────────────────────────────────────────
  ['featured-posts',        'blog-maintenance'],
  ['homepage-carousel',     'blog-maintenance'],
  ['session-management',    'blog-maintenance'],
  ['website-content-update','blog-maintenance'],

  // ── IBM Projects / filing children ──────────────────────────────────────────
  ['acre-engineering', 'acre'],
  ['acre-project',     'acre'],
  ['css',              'ibm-projects'],
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function slugToId(slug: string): Promise<string | null> {
  const r = await db.query<{ id: string }>('SELECT id FROM tags WHERE slug = $1', [slug]);
  return r.rows[0]?.id ?? null;
}

async function processRemap(removeSlug: string, keepSlug: string): Promise<void> {
  const removeId = await slugToId(removeSlug);
  if (removeId === null) {
    console.log(`  SKIP  "${removeSlug}" — not found`);
    return;
  }
  const keepId = await slugToId(keepSlug);
  if (keepId === null) {
    console.warn(`  WARN  "${removeSlug}" → keeper "${keepSlug}" not found — skipping`);
    return;
  }

  let totalMoved = 0;

  for (const { table, itemCol, compositeKey } of JUNCTION_TABLES) {
    if (compositeKey) {
      // Composite PK: update tag_id, skip rows that would create a duplicate
      const r = await db.query(
        `UPDATE ${table}
         SET tag_id = $1
         WHERE tag_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM ${table} t2
             WHERE t2.${itemCol} = ${table}.${itemCol}
               AND t2.tag_id = $1
           )`,
        [keepId, removeId],
      );
      // Delete any remaining rows for the removed tag (they're duplicates of the keeper)
      await db.query(`DELETE FROM ${table} WHERE tag_id = $1`, [removeId]);
      totalMoved += r.rowCount ?? 0;
    } else {
      // Standalone PK (repo_tag_mappings): just delete the row for the removed tag
      const r = await db.query(`DELETE FROM ${table} WHERE tag_id = $1`, [removeId]);
      totalMoved += r.rowCount ?? 0;
    }
  }

  // Delete any child tags whose parent was this tag (reassign to keep tag's parent)
  await db.query(
    `UPDATE tags SET parent_id = (SELECT parent_id FROM tags WHERE id = $1) WHERE parent_id = $2`,
    [keepId, removeId],
  );

  // Delete the tag itself
  await db.query('DELETE FROM tags WHERE id = $1', [removeId]);
  console.log(`  OK    "${removeSlug}" → "${keepSlug}" (${totalMoved} rows remapped)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const before = await db.query<{ count: string }>('SELECT COUNT(*) FROM tags');
  console.log(`\nTags before: ${before.rows[0]?.count ?? '?'}`);

  console.log('\nRemapping tags…');
  for (const [removeSlug, keepSlug] of REMAP) {
    await processRemap(removeSlug, keepSlug);
  }

  const after = await db.query<{ count: string }>('SELECT COUNT(*) FROM tags');
  console.log(`\nTags after: ${after.rows[0]?.count ?? '?'}`);
  console.log('\nFinal tag list:');
  const list = await db.query<{ role: string; name: string; parent: string | null }>(
    `SELECT t.role, t.name, p.name AS parent
     FROM tags t
     LEFT JOIN tags p ON p.id = t.parent_id
     ORDER BY t.role, p.name NULLS FIRST, t.name`,
  );
  for (const row of list.rows) {
    const indent = row.parent != null ? `  ↳ [${row.parent}]` : '';
    console.log(`  ${row.role.padEnd(8)} ${indent} ${row.name}`);
  }

  await db.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
