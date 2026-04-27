/**
 * projectContext.ts
 *
 * Shared helper for resolving a GitHub repo full_name (e.g. "richardichogan/ACRE")
 * to a project ID by matching against projects.github_repos in the DB.
 *
 * Falls back to 'personal' when no project claims the repo — consistent with
 * the pre-existing behaviour for unmatched repos.
 *
 * Results are cached in a module-level Map for the lifetime of the process
 * (refreshed on each sync run) to avoid N×M DB queries.
 */

import type { Pool } from 'pg';

interface ProjectRow {
  id: string;
  github_repos: string[];
}

/** Cached mapping: repoFullName (lower-cased) → project id */
let repoToProjectCache: Map<string, string> | null = null;

/**
 * Populates (or refreshes) the in-process cache from the DB.
 * Call once per sync run, before iterating repos.
 */
export async function loadProjectContextCache(db: Pool): Promise<void> {
  const result = await db.query<ProjectRow>(
    `SELECT id, github_repos FROM projects WHERE array_length(github_repos, 1) > 0`,
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    for (const repo of row.github_repos) {
      map.set(repo.toLowerCase(), row.id);
    }
  }
  repoToProjectCache = map;
}

/**
 * Returns the project id for a GitHub repo full_name, or 'personal' if none.
 * Call `loadProjectContextCache` before using this.
 */
export function resolveProjectContext(repoFullName: string): string {
  if (!repoToProjectCache) return 'personal';
  return repoToProjectCache.get(repoFullName.toLowerCase()) ?? 'personal';
}
