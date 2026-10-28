/**
 * Project Docs sync
 *
 * For each project in the DB that has at least one GitHub repo, fetches
 * all .md files under /docs/ (plus any top-level README.md) and upserts
 * them as content_items with source = 'github-doc'.
 *
 * Uses the git commits API to get the last-modified date per file (one
 * request per file, cached per run via a Map so the same file is never
 * fetched twice).
 *
 * Items are read-only — editing happens on GitHub directly.
 */

import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { NOTE_SUMMARY_MAX_LENGTH } from '../../config/constants.js';
import type { ContentItem } from '../../types/contentItem.js';
import { publishedNotePaths, removePublishedNoteCopies } from '../../services/githubDocumentIdentity.js';
import { normalizeGitHubRepository } from './projectContext.js';
import { addSourceFailure, syncFailureSummary, type SyncFailure } from '../../sync/sourceDiagnostics.js';
import { ValidationError } from '../../types/errors.js';

const SOURCE: ContentItem['source'] = 'github-doc';

// ── GitHub API shapes ─────────────────────────────────────────────────────────

interface GitTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
}

interface GitTree {
  sha: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

interface GitBlob {
  content: string;
  encoding: string;
}

interface GitRef {
  object: { sha: string };
}
interface Repository { default_branch: string }

interface GitCommit {
  commit: { committer: { date: string } };
}

export function decodeProjectDocument(bytes: Buffer): string {
  const bomHigh = 0xff;
  const bomLow = 0xfe;
  const encoding = bytes[0] === bomHigh && bytes[1] === bomLow ? 'utf-16le'
    : bytes[0] === bomLow && bytes[1] === bomHigh ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new ValidationError(`Cannot decode document as ${encoding}; original content was not indexed.`); }
  if (text.includes('\0')) throw new ValidationError('The document contains NUL characters after decoding; original content was not indexed.');
  return text;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function titleFromPath(filePath: string): string {
  const stem = filePath.split('/').pop()?.replace(/\.md$/i, '') ?? filePath;
  return stem
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncProjectDocs(
  db: Pool,
): Promise<{ indexed: number; errors: number; failures: SyncFailure[] }> {
  let indexed = 0;
  let errors = 0;
  const failures: SyncFailure[] = [];

  // Load projects with GitHub repos from the DB
  type ProjectRow = { id: string; name: string; github_repos: string[] };
  const result = await db.query<ProjectRow>(
    `SELECT id, name, github_repos FROM projects WHERE github_repos IS NOT NULL AND array_length(github_repos, 1) > 0`,
  );

  if (result.rows.length === 0) {
    console.warn('[project-docs] No projects with GitHub repos found — skipping');
    return { indexed: 0, errors: 0, failures };
  }

  const client = new GitHubClient();

  for (const project of result.rows) {
    for (const configuredRepo of project.github_repos) {
      let repo: string;
      let branch: string;
      let headSha: string;
      try {
        repo = normalizeGitHubRepository(configuredRepo);
        const repository = await client.get<Repository>(`/repos/${repo}`);
        branch = repository.default_branch;
        const ref = await client.get<GitRef>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        headSha = ref.object.sha;
      } catch (error) {
        addSourceFailure(failures, configuredRepo, error);
        console.error(`[project-docs] Could not resolve a repository for ${project.name}: ${error instanceof Error ? error.message : String(error)}`);
        errors++;
        continue;
      }
      const notePaths = await publishedNotePaths(db, repo);
      await removePublishedNoteCopies(db, repo);

      let tree: GitTree;
      try {
        tree = await client.get<GitTree>(
          `/repos/${repo}/git/trees/${headSha}`,
          { recursive: '1' },
        );
      } catch (error) {
        addSourceFailure(failures, repo, error);
        console.error(`[project-docs] Could not fetch tree for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
        errors++;
        continue;
      }
      if (tree.truncated) {
        const maxFailures = 20;
        if (failures.length < maxFailures) failures.push({ target: repo, code: 'incomplete-tree', action: 'The GitHub tree was truncated; document coverage is incomplete.' });
        console.error(`[project-docs] ${repo}: GitHub returned a truncated tree; document coverage is incomplete.`);
        errors++;
      }

      // All .md files in the repo
      const mdBlobs = tree.tree.filter(
        (item) =>
          item.type === 'blob' &&
          item.path.endsWith('.md'),
      );

      for (const blob of mdBlobs) {
        if (notePaths.has(blob.path)) continue;
        try {
          // Get last commit date for this file
          let publishedAt = new Date().toISOString();
          try {
            const commits = await client.get<GitCommit[]>(
              `/repos/${repo}/commits`,
              { path: blob.path, sha: headSha, per_page: '1' },
            );
            if (commits.length > 0 && commits[0]) {
              publishedAt = commits[0].commit.committer.date;
            }
          } catch {
            // Fall back to now — not critical
          }

          // Fetch file content
          const gitBlob = await client.get<GitBlob>(`/repos/${repo}/git/blobs/${blob.sha}`);
          const rawContent = decodeProjectDocument(Buffer.from(
            gitBlob.content.replace(/\n/g, ''),
            'base64',
          ));

          const title = titleFromPath(blob.path);
          const plainBody = stripMarkdown(rawContent);
          const summary = plainBody.slice(0, NOTE_SUMMARY_MAX_LENGTH).replace(/\s+/g, ' ');

          const item: Omit<ContentItem, 'id' | 'indexedAt'> = {
            source: SOURCE,
            sourceId: `${repo}::${blob.path}`,
            title,
            summary,
            body: plainBody,
            publishedAt,
            url: `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${blob.path.split('/').map(encodeURIComponent).join('/')}`,
            projectContext: project.id,
            metadata: {
              repo,
              path: blob.path,
              blobSha: blob.sha,
              sourceLabel: project.name,
            },
            tags: ['github-doc', project.name.toLowerCase().replace(/\s+/g, '-')],
          };

          await upsertContentItem(db, item);
          indexed++;
        } catch (err) {
          addSourceFailure(failures, `${repo}/${blob.path}`, err);
          errors++;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[project-docs] Failed to index ${repo}/${blob.path}: ${message}`);
        }
      }
    }
  }

  await upsertSyncState(db, SOURCE, {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: syncFailureSummary(errors, failures),
  });

  console.warn(`[project-docs] Done: indexed=${indexed}, errors=${errors}`);
  return { indexed, errors, failures };
}
