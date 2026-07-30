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
import { loadConceptTags, invalidateConceptTagCache } from '../services/taxonomyService.js';
import { FoundryClient } from '../ai/foundryClient.js';

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

export const CONTENT_STORE = 'richardichogan/content-store';

// ── Library cache — avoids hammering GitHub on every page load ─────────────────
const LIBRARY_CACHE_TTL_MS = 300_000; // 5 minutes
let _libraryCache: { docs: DocEntry[]; builtAt: number } | null = null;

export async function buildLibrary(gh: GitHubClient, extraRepos: string[], labelMap: Record<string, string>): Promise<DocEntry[]> {
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
    console.warn('[Documents] content-store fetch failed:', err instanceof Error ? err.message : err);
  }

  // 2. Project repos — docs/ folder and README.md only
  await Promise.allSettled(
    extraRepos.map(async (repo) => {
      const label = labelMap[repo] ?? repo.split('/')[1] ?? repo;
      try {
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
      } catch { /* repo inaccessible — skip */ }
    }),
  );

  return docs;
}

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

      // Use cache if fresh, otherwise rebuild (and serve stale on GitHub failure)
      let docs: DocEntry[];
      const now = Date.now();
      if (_libraryCache && (now - _libraryCache.builtAt) < LIBRARY_CACHE_TTL_MS) {
        docs = _libraryCache.docs;
      } else {
        try {
          docs = await buildLibrary(gh, extraRepos, labelMap);
          if (docs.length > 0) {
            _libraryCache = { docs, builtAt: now };
          } else if (_libraryCache) {
            // GitHub rate-limited — return stale cache rather than empty
            console.warn('[Documents] GitHub returned 0 docs — serving stale cache');
            docs = _libraryCache.docs;
          }
        } catch {
          docs = _libraryCache?.docs ?? [];
        }
      }

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

// ── Document retag progress state ─────────────────────────────────────────────
let docRetagProgress: { done: number; total: number; running: boolean; completedAt: string | null } = {
  done: 0, total: 0, running: false, completedAt: null,
};

const DOC_SUMMARY_CHARS = 3_000;

const DOC_MAX_TOKENS = 300;
const DOC_TAG_PARAM_OFFSET = 2;

const DOC_SYSTEM_PROMPT = `You are a content tagging assistant. Given a document (markdown file from a GitHub repository) and a taxonomy of concept tags, identify which tags apply.

Apply tags conservatively — only if the document is substantively about that concept.
Apply between 0 and 6 tags. Return ONLY valid JSON:
{ "tags": ["Tag Name", "Tag Name"] }`;

/**
 * GET /api/documents/retag/status
 * Returns the current document retag progress.
 */
router.get('/retag/status', (_req: Request, res: Response): void => {
  res.status(HTTP_STATUS.OK).json({ success: true, data: docRetagProgress });
});

/**
 * POST /api/documents/retag
 * Re-runs AI tagging on all documents in the library (content-store + project repos).
 * Runs in background — returns 202 immediately.
 */
router.post('/retag', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const gh = new GitHubClient();

      invalidateConceptTagCache();
      const conceptTags = await loadConceptTags(db);
      if (conceptTags.length === 0) {
        res.status(HTTP_STATUS.OK).json({ success: true, data: { queued: 0, message: 'No concept tags in taxonomy' } });
        return;
      }

      // Build taxonomy string for the AI prompt
      const groups: Record<string, string[]> = {};
      for (const t of conceptTags) {
        (groups[t.parentName] ??= []).push(t.name);
      }
      const taxonomyListing = Object.entries(groups)
        .map(([parent, children]) => `${parent}: ${children.join(', ')}`)
        .join('\n');

      // Get project repos from DB + optional body override
      const body = req.body as { repos?: unknown };
      const bodyRepos = Array.isArray(body?.repos)
        ? (body.repos as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      const projectRows = await db.query<{ github_repos: string[]; name: string }>(
        `SELECT github_repos, name FROM projects WHERE array_length(github_repos, 1) > 0`,
      );
      const dbRepos: string[] = projectRows.rows.flatMap((r) => r.github_repos ?? []);
      const extraRepos: string[] = [...new Set([...dbRepos, ...bodyRepos])];

      // Collect all docs (same logic as /library)
      type DocSpec = { id: string; repo: string; path: string; title: string };
      const docs: DocSpec[] = [];

      try {
        const tree = await getRepoTree(gh, CONTENT_STORE);
        for (const item of tree) {
          if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
          docs.push({ id: `${CONTENT_STORE}::${item.path}`, repo: CONTENT_STORE, path: item.path, title: titleFromPath(item.path) });
        }
      } catch { /* content-store inaccessible */ }

      await Promise.allSettled(
        extraRepos.map(async (repo) => {
          const tree = await getRepoTree(gh, repo);
          for (const item of tree) {
            if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
            if (!item.path.startsWith('docs/') && item.path.toLowerCase() !== 'readme.md') continue;
            docs.push({ id: `${repo}::${item.path}`, repo, path: item.path, title: titleFromPath(item.path) });
          }
        }),
      );

      const total = docs.length;
      docRetagProgress = { done: 0, total, running: true, completedAt: null };

      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { queued: total, message: `Retagging ${total} documents in background` },
      });

      // Background processing — rate-limited: 1 GitHub call per 500ms to avoid secondary rate limit
      void (async (): Promise<void> => {
        const client = new FoundryClient();
        let done = 0;
        const RATE_LIMIT_DELAY_MS = 500;

        for (const doc of docs) {
          try {
            // Fetch file content via blob SHA (already in DocSpec) or fall back to contents API
            await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
            const blob = await gh.get<GitHubBlobResponse>(`/repos/${doc.repo}/contents/${doc.path}`);
            const content = blob.encoding === 'base64'
              ? Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8')
              : blob.content;

            const truncated = content.slice(0, DOC_SUMMARY_CHARS);

            const raw = await client.chat('gpt-4o-mini', [
              { role: 'system', content: DOC_SYSTEM_PROMPT },
              { role: 'user', content: `Document: ${doc.title}\n\n${truncated}\n\nAvailable concept tags:\n${taxonomyListing}` },
            ], DOC_MAX_TOKENS);

            const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            const parsed = JSON.parse(cleaned) as { tags?: string[] };

            const matchedIds: string[] = [];
            for (const tagName of parsed.tags ?? []) {
              const match = conceptTags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
              if (match) matchedIds.push(match.id);
            }

            if (matchedIds.length > 0) {
              // Replace existing tags for this doc
              await db.query('DELETE FROM document_tags WHERE doc_id = $1', [doc.id]);
              const values = matchedIds.map((_, i) => `($1, $${i + DOC_TAG_PARAM_OFFSET}::uuid)`).join(', ');
              await db.query(
                `INSERT INTO document_tags (doc_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`,
                [doc.id, ...matchedIds],
              );
            }
          } catch (err) {
            console.error(`[DocRetag] failed for ${doc.id}:`, err);
          }
          done++;
          docRetagProgress.done = done;
        }

        docRetagProgress.running = false;
        docRetagProgress.completedAt = new Date().toISOString();
        process.stdout.write(`[DocRetag] complete — ${done} documents processed\n`);
      })();

    } catch (err) { next(err); }
  })();
});

export { router as documentsRouter };