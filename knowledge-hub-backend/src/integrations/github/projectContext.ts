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
import { ValidationError } from '../../types/errors.js';

export function normalizeGitHubRepository(value: string): string {
  const name = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) {
    throw new ValidationError('Choose a GitHub repository as owner/repository or its https://github.com URL.');
  }
  return name;
}

export function projectGitHubRepositories(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((repo): repo is string => typeof repo === 'string')) {
    throw new ValidationError('GitHub repositories must be a list of repository names or URLs.');
  }
  return [...new Set(value.filter(repo => repo.trim()).map(normalizeGitHubRepository))];
}

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
      map.set(normalizeGitHubRepository(repo).toLowerCase(), row.id);
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
