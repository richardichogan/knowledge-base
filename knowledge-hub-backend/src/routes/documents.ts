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

  if (isContentStore) {
    if (lower.startsWith('posts/') || lower.startsWith('drafts/')) return 'blog-draft';
    if (lower.startsWith('spec') || lower.endsWith('-spec.md') || lower.includes('/spec')) return 'spec';
    if (lower.startsWith('newsletter')) return 'newsletter';
    return 'doc';
  }

  // Project repo heuristics
  if (lower.endsWith('-spec.md') || lower.includes('/spec') || lower.startsWith('specs/') || lower.startsWith('rfcs/')) return 'spec';
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

/** The canonical writing content store. Must exist — Library is broken without it. */
export const CONTENT_STORE = 'richardichogan/content-store';

/**
 * Root-level .md files that are repo meta/housekeeping — never surfaced as documents.
 * Everything else under docs/ and other named doc folders is included.
 */
const EXCLUDED_META_FILES = new Set([
  'contributing.md', 'changelog.md', 'code_of_conduct.md',
  'license.md', 'security.md', 'codeowners.md', 'authors.md',
  'maintainers.md', 'notice.md', 'patents.md',
]);

/**
 * Returns true if a file path from a project repo should appear in the Library.
 * Rules:
 *   - Never include .github/ or hidden directories
 *   - Root-level: README.md and any .md not in the meta exclusion list above
 *   - Sub-directories: only docs/, architecture/, specs/, rfcs/, wiki/, design/
 */
function isDocumentablePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  // Never include .github/ templates, hidden dirs, or node_modules
  if (lower.startsWith('.github/') || lower.startsWith('.') || lower.startsWith('node_modules/')) return false;

  const hasDir = lower.includes('/');

  if (!hasDir) {
    // Root-level: include README and curated doc files, exclude meta/housekeeping
    return lower.endsWith('.md') && !EXCLUDED_META_FILES.has(lower);
  }

  // Sub-directory: only explicit documentation folders
  return (
    lower.startsWith('docs/') ||
    lower.startsWith('architecture/') ||
    lower.startsWith('specs/') ||
    lower.startsWith('rfcs/') ||
    lower.startsWith('wiki/') ||
    lower.startsWith('design/')
  );
}

export async function buildLibrary(gh: GitHubClient, extraRepos: string[], labelMap: Record<string, string>): Promise<DocEntry[]> {
  const docs: DocEntry[] = [];

  // 1. Content store — all .md files. This repo must exist; log an error if it's unreachable.
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
    console.error(`[Documents] CRITICAL: content-store (${CONTENT_STORE}) is unreachable — Library will be empty. Check GITHUB_ACCESS_TOKEN has access to this repo.`, err instanceof Error ? err.message : err);
  }

  // 2. Project repos — docs/, README, root-level .md files, and common doc folders
  await Promise.allSettled(
    extraRepos.map(async (repo) => {
      const label = labelMap[repo] ?? repo.split('/')[1] ?? repo;
      try {
        const tree = await getRepoTree(gh, repo);
        for (const item of tree) {
          if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
          if (!isDocumentablePath(item.path)) continue;
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
 * Returns the indexed Library view from PostgreSQL, not a live GitHub scrape.
 * Sources:
 *   1. github-content-store
 *   2. github-doc
 */
router.get('/library', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const result = await db.query<{
        source: 'github-doc' | 'github-content-store';
        title: string;
        html_url: string | null;
        project_context: string | null;
        metadata: Record<string, unknown> | null;
        body: string | null;
      }>(
        `SELECT
           ci.source,
           COALESCE(NULLIF(ci.title, ''), 'Untitled Document') AS title,
           ci.url AS html_url,
           ci.project_context,
           ci.metadata,
           ci.body
         FROM content_items ci
         WHERE ci.source IN ('github-doc', 'github-content-store')
         ORDER BY ci.updated_at DESC, ci.indexed_at DESC`,
      );

      const docsById = new Map<string, DocEntry>();
      for (const row of result.rows) {
        const metadata = row.metadata ?? {};
        const repo = typeof metadata['repo'] === 'string' ? metadata['repo'] : '';
        const path = typeof metadata['path'] === 'string' ? metadata['path'] : '';
        if (!repo || !path || !path.toLowerCase().endsWith('.md')) continue;

        const sourceLabel =
          typeof metadata['sourceLabel'] === 'string' && metadata['sourceLabel']
            ? metadata['sourceLabel']
            : row.source === 'github-content-store'
              ? 'Content Store'
              : row.project_context ?? repo;

        const id = `${repo}::${path}`;
        if (docsById.has(id)) continue;

        docsById.set(id, {
          id,
          title: row.title,
          type: inferDocType(path, row.source === 'github-content-store'),
          repo,
          path,
          sourceLabel,
          htmlUrl: row.html_url ?? `https://github.com/${repo}/blob/main/${path}`,
          size: Buffer.byteLength(row.body ?? '', 'utf8'),
          tags: inferTags(path, sourceLabel, row.source === 'github-content-store'),
          taxonomyTagIds: [],
        });
      }

      const docs = [...docsById.values()];

      docs.sort((a, b) => a.title.localeCompare(b.title));

      // Join taxonomy tag IDs from document_tags table
      if (docs.length > 0) {
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
        if (CONTENT_STORE) {
          const tree = await getRepoTree(gh, CONTENT_STORE);
          for (const item of tree) {
            if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
            docs.push({ id: `${CONTENT_STORE}::${item.path}`, repo: CONTENT_STORE, path: item.path, title: titleFromPath(item.path) });
          }
        }
      } catch { /* content-store inaccessible */ }

      await Promise.allSettled(
        extraRepos.map(async (repo) => {
          const tree = await getRepoTree(gh, repo);
          for (const item of tree) {
            if (item.type !== 'blob' || !item.path.endsWith('.md')) continue;
            if (!isDocumentablePath(item.path)) continue;
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

/**
 * POST /api/documents/upload
 * Body: multipart/form-data
 *   file: Buffer (PDF, DOCX, PPTX)
 *   title?: string (optional, defaults to filename stem)
 *
 * Commits the uploaded file to richardichogan/content-store via GitHub API.
 * Returns the file path and metadata.
 */
router.post('/upload', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
      const title = (req.body as any)?.title as string | undefined;

      if (!file || !file.buffer) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: { message: 'No file provided' },
        });
        return;
      }

      const filename = file.originalname || 'document';
      const ext = filename.toLowerCase().split('.').pop() || '';

      // Validate file type
      if (!['pdf', 'docx', 'pptx'].includes(ext)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: { message: `Unsupported file type: .${ext}. Supported: PDF, DOCX, PPTX` },
        });
        return;
      }

      const gh = new GitHubClient();
      const contentStoreRepo = 'richardichogan/content-store';

      // Generate path: documents/ + sanitized filename
      const sanitized = filename.replace(/[^a-z0-9.-]/gi, '_').toLowerCase();
      const filePath = `documents/${sanitized}`;

      // Encode file as base64 for GitHub API
      const base64Content = file.buffer.toString('base64');

      // Commit via GitHub API (put contents)
      const commitMessage = title
        ? `Upload: ${title}`
        : `Upload: ${sanitized}`;

      await gh.put(`/repos/${contentStoreRepo}/contents/${filePath}`, {
        message: commitMessage,
        content: base64Content,
        branch: 'main',
      });

      const body: ApiSuccess<{ path: string; title: string; message: string }> = {
        success: true,
        data: {
          path: filePath,
          title: title || filename.replace(/\.[^.]+$/, ''),
          message: `File uploaded to ${contentStoreRepo}/${filePath}. It will be indexed on the next sync.`,
        },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as documentsRouter };