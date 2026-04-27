#!/usr/bin/env node
/**
 * seed-projects.mjs
 *
 * Reads data/projects.json and upserts every project into the target
 * PostgreSQL database.  Run against production with:
 *
 *   DATABASE_URL="postgresql://..." node scripts/seed-projects.mjs
 *
 * Safe to re-run — uses INSERT ... ON CONFLICT DO UPDATE.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve pg from the backend's node_modules (pg is not installed at workspace root)
const { default: pg } = await import(
  path.join(__dirname, '..', 'knowledge-hub-backend', 'node_modules', 'pg', 'lib', 'index.js')
);

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const projectsPath = path.join(__dirname, '..', 'data', 'projects.json');
const projects = require(projectsPath);

const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
const { Pool } = pg;
const pool = new Pool({
  connectionString: databaseUrl,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
});

const UPSERT_SQL = `
  INSERT INTO projects
    (id, name, colour, category, priority, description,
     gitlab_paths, github_repos, links, tags, created_at, updated_at)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
  ON CONFLICT (id) DO UPDATE SET
    name         = EXCLUDED.name,
    colour       = EXCLUDED.colour,
    category     = EXCLUDED.category,
    priority     = EXCLUDED.priority,
    description  = EXCLUDED.description,
    gitlab_paths = EXCLUDED.gitlab_paths,
    github_repos = EXCLUDED.github_repos,
    links        = EXCLUDED.links,
    tags         = EXCLUDED.tags,
    updated_at   = EXCLUDED.updated_at
`;

let inserted = 0;
let updated = 0;

for (const p of projects) {
  const { rowCount } = await pool.query(UPSERT_SQL, [
    p.id,
    p.name,
    p.colour ?? 'gray',
    p.category ?? 'work',
    p.priority ?? 'medium',
    p.description ?? '',
    p.gitlabPaths ?? [],
    p.githubRepos ?? [],
    JSON.stringify(p.links ?? []),
    p.tags ?? [],
    p.createdAt ?? new Date().toISOString(),
    p.updatedAt ?? new Date().toISOString(),
  ]);
  if (rowCount === 1) inserted++;
  else updated++;
  console.log(`  ✓ ${p.id}`);
}

await pool.end();
console.log(`\nDone — ${inserted} upserted across ${projects.length} projects.`);
