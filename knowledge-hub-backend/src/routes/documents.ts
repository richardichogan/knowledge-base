/**
 * GET /api/documents/library?repos[]=owner/repo&repoLabels={"owner/repo":"Label"}
 *   Returns a unified flat list of formal markdown documents from:
 *     1. richardichogan/content-store  — all .md files
 *     2. /docs folders + README.md in each provided ?repos[] param
 *
 * GET /api/documents/content?repo=owner/repo&path=file.md
 *   Returns the decoded content of a single file.
 *
 * Uses the server-side GITHUB_ACCESS_TOKEN.  Never exposes the token
 * to the browser.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

// ── Shared types ──────────────────────────────────────────────────────────────

export type DocType = 'blog-draft' | 'spec' | 'newsletter' | 'readme' | 'doc';

export interface DocEntry {
  /** Unique stable id: `repo::path` */
  id: string;
  title: string;
  type: DocType;
  /** owner/repo */
  repo: string;
  /** File path within the repo */
  path: string;
  /** Human-readable source label, e.g. "Content Store" or project name */
  sourceLabel: string;
  /** GitHub web URL */
  htmlUrl: string;
  size: number;
  tags: string[];
  /** Taxonomy tag IDs assigned by the user */
  taxonomyTagIds: string[];
}

export interface DocumentContent {
  path: string;
  content: string;
  sha: string;
}

// ── GitHub API shapes ─────────────────────────────────────────────────────────

interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface GitHubTree {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeItem[];
}

interface GitHubBlobResponse {
  sha: string;
  content: string;
  encoding: string;
}

interface GitHubRepoRef {
  object: { sha: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function titleFromPath(filePath: string): string {
  const filename = filePath.split('/').pop() ?? filePath;
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferDocType(filePath: string, isContentStore: boolean): DocType {
  const lower = filePath.toLowerCase();
  const filename = lower.split('/').pop() ?? '';

  if (filename === 'readme.md') return 'readme';
  if (!isContentStore) return 'doc';

  if (lower.startsWith('posts/') || lower.startsWith('drafts/')) return 'blog-draft';
  if (lower.startsWith('spec') || lower.endsWith('-spec.md') || lower.includes('/spec')) return 'spec';
  if (lower.startsWith('newsletter')) return 'newsletter';
  return 'doc';
}

function inferTags(filePath: string, sourceLabel: string, isContentStore: boolean): string[] {
  const tags: string[] = [sourceLabel.toLowerCase().replace(/\s+/g, '-')];
  if (isContentStore) {
    const folder = filePath.split('/')[0];
    if (folder && folder !== filePath) tags.push(folder.toLowerCase());
  }
  return [...new Set(tags)];
}

async function getRepoTree(gh: GitHubClient, repo: string): Promise<GitHubTreeItem[]> {
  const ref = await gh
    .get<GitHubRepoRef>(`/repos/${repo}/git/ref/heads/main`)
    .catch(() => gh.get<GitHubRepoRef>(`/repos/${repo}/git/ref/heads/master`));

  const tree = await gh.get<GitHubTree>(
    `/repos/${repo}/git/trees/${ref.object.sha}`,
    { recursive: '1' },
  );

  return tree.tree;
}

const CONTENT_STORE = 'richardichogan/content-store';

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/documents/library
 *
 * Always includes content-store.  Optional ?repos[]=owner/repo params add
 * project repos (docs/ folder + README.md only).
 */
router.get('/library', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const gh = new GitHubClient();

      // Extra project repos from query string
      const extraRepos: string[] = Array.isArray(req.query['repos'])
        ? (req.query['repos'] as string[]).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r))
        : typeof req.query['repos'] === 'string' && /^[\w.-]+\/[\w.-]+$/.test(req.query['repos'])
          ? [req.query['repos']]
          : [];

      // Optional label map: JSON string of { "owner/repo": "Human Label" }
      const labelMap: Record<string, string> = {};
      if (typeof req.query['repoLabels'] === 'string') {
        try {
          Object.assign(labelMap, JSON.parse(req.query['repoLabels']) as Record<string, string>);
        } catch { /* ignore malformed JSON */ }
      }

      const docs: DocEntry[] = [];

      // 1. Content store — all .md files
      try {
        const tree = await getRepoTree(gh, CONTENT_STORE);
        for (const item of tree) {
          if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
          docs.push({
            id: `${CONTENT_STORE}::${item.path}`,
            title: titleFromPath(item.path),
            type: inferDocType(item.path, true),
            repo: CONTENT_STORE,
            path: item.path,
            sourceLabel: 'Content Store',
            htmlUrl: `https://github.com/${CONTENT_STORE}/blob/main/${item.path}`,
            size: item.size ?? 0,
            tags: inferTags(item.path, 'Content Store', true),
            taxonomyTagIds: [],
          });
        }
      } catch (err) {
        // Don't silently hide — surface as a clear server error so the UI knows
        console.error('[documents] content-store fetch failed:', err);
        throw new Error(
          `Failed to load content-store from GitHub. Check GITHUB_ACCESS_TOKEN — original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2. Project repos — docs/ folder and README.md only
      await Promise.allSettled(
        extraRepos.map(async (repo) => {
          const label = labelMap[repo] ?? repo.split('/')[1] ?? repo;
          const tree = await getRepoTree(gh, repo);
          for (const item of tree) {
            if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
            if (!item.path.startsWith('docs/') && item.path.toLowerCase() !== 'readme.md') continue;
            docs.push({
              id: `${repo}::${item.path}`,
              title: titleFromPath(item.path),
              type: inferDocType(item.path, false),
              repo,
              path: item.path,
              sourceLabel: label,
              htmlUrl: `https://github.com/${repo}/blob/main/${item.path}`,
              size: item.size ?? 0,
              tags: inferTags(item.path, label, false),
              taxonomyTagIds: [],
            });
          }
        }),
      );

      docs.sort((a, b) => a.title.localeCompare(b.title));

      // Join taxonomy tag IDs from document_tags table
      if (docs.length > 0) {
        const db = getDb();
        const docIds = docs.map((d) => d.id);
        const tagRows = await db.query<{ doc_id: string; tag_id: string }>(
          `SELECT doc_id, tag_id::text FROM document_tags WHERE doc_id = ANY($1)`,
          [docIds],
        );
        const tagMap = new Map<string, string[]>();
        for (const row of tagRows.rows) {
          const arr = tagMap.get(row.doc_id) ?? [];
          arr.push(row.tag_id);
          tagMap.set(row.doc_id, arr);
        }
        for (const doc of docs) {
          doc.taxonomyTagIds = tagMap.get(doc.id) ?? [];
        }
      }

      const body: ApiSuccess<DocEntry[]> = { success: true, data: docs };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * GET /api/documents/content?repo=owner/repo&path=file.md
 * Returns the decoded markdown content of a single file.
 */
router.get('/content', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const repo = req.query['repo'] as string | undefined;
      const filePath = req.query['path'] as string | undefined;

      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !filePath) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: { message: 'Missing or invalid ?repo=owner/repo&path=file.md' },
        });
        return;
      }

      const gh = new GitHubClient();
      const blob = await gh.get<GitHubBlobResponse>(`/repos/${repo}/contents/${filePath}`);
      const content =
        blob.encoding === 'base64'
          ? Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8')
          : blob.content;

      const body: ApiSuccess<DocumentContent> = {
        success: true,
        data: { path: filePath, content, sha: blob.sha },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * GET /api/documents/tags?docId=repo::path
 * Returns taxonomy tag IDs for a document.
 */
router.get('/tags', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const docId = req.query['docId'] as string | undefined;
      if (!docId) throw new ValidationError('docId is required', {});
      const db = getDb();
      const rows = await db.query<{ tag_id: string }>(
        `SELECT tag_id::text FROM document_tags WHERE doc_id = $1`,
        [docId],
      );
      const body: ApiSuccess<string[]> = { success: true, data: rows.rows.map((r) => r.tag_id) };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

/**
 * PUT /api/documents/tags
 * Body: { docId: string; tagIds: string[] }
 * Replaces all tags for a document.
 */
router.put('/tags', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { docId, tagIds } = req.body as { docId?: string; tagIds?: unknown };
      if (!docId || typeof docId !== 'string') throw new ValidationError('docId is required', {});
      if (!Array.isArray(tagIds)) throw new ValidationError('tagIds must be an array', {});
      const ids = (tagIds as unknown[]).filter((id): id is string => typeof id === 'string');
      const db = getDb();
      await db.query('DELETE FROM document_tags WHERE doc_id = $1', [docId]);
      if (ids.length > 0) {
        const firstParam = 2;
        const values = ids.map((_, i) => `($1, $${i + firstParam}::uuid)`).join(', ');
        await db.query(
          `INSERT INTO document_tags (doc_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [docId, ...ids],
        );
      }
      const body: ApiSuccess<string[]> = { success: true, data: ids };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as documentsRouter };