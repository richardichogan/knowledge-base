/**
 * GitHub Content Store sync
 *
 * Fetches every .md file from the configured content-store repository
 * (default: richardichogan/content-store) via the GitHub Trees API, parses
 * YAML front-matter, and upserts each file as a read-only content_item with
 * source = 'github-content-store'.
 *
 * Items are treated as read-only — they are never created or edited through
 * the Knowledge Hub; syncing always overwrites with the latest GitHub version.
 *
 * Front-matter fields supported:
 *   title       — display title (falls back to filename stem)
 *   date        — ISO date string used for publishedAt
 *   summary     — short description
 *   tags        — YAML list of tag strings
 *   project     — maps to projectContext (optional)
 *   url         — canonical external URL (optional)
 */

import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { NOTE_SUMMARY_MAX_LENGTH } from '../../config/constants.js';
import type { ContentItem } from '../../types/contentItem.js';
import { extractDocumentText } from './documentExtractor.js';

/** Number of hex chars to show in a short Git SHA log message. */
const GIT_SHORT_SHA_LENGTH = 7;

// ── GitHub API shapes ─────────────────────────────────────────────────────────

interface GitTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  url: string;
}

interface GitTree {
  sha: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

interface GitBlob {
  content: string;   // base64 encoded
  encoding: string;  // always "base64" for text blobs
}

interface GitRef {
  object: { sha: string };
}

// ── Front-matter parser ───────────────────────────────────────────────────────

interface ParsedFrontMatter {
  title?: string;
  date?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  project?: string;
  url?: string;
}

/**
 * Minimal YAML front-matter parser.
 * Handles only the simple key: value syntax used in content-store files.
 * Does not support nested objects or anchors.
 */
function parseFrontMatter(raw: string): { meta: ParsedFrontMatter; body: string } {
  const DELIMITER = '---';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  if (lines[0]?.trim() !== DELIMITER) {
    return { meta: {}, body: raw };
  }

  const closeIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === DELIMITER);
  if (closeIdx === -1) {
    return { meta: {}, body: raw };
  }

  const fmLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n').trim();
  const meta: ParsedFrontMatter = {};

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of fmLines) {
    // List item continuation
    if (currentList !== null && /^\s+-\s+/.test(line)) {
      currentList.push(line.replace(/^\s+-\s+/, '').trim());
      continue;
    }

    // Flush previous list
    if (currentList !== null) {
      assignMeta(meta, currentKey!, currentList);
      currentKey = null;
      currentList = null;
    }

    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key = '', value = ''] = match;
    const trimmed = value.trim();

    // Inline list: tags: [a, b, c]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const items = trimmed
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      assignMeta(meta, key, items);
      continue;
    }

    // Start of block list
    if (trimmed === '') {
      currentKey = key;
      currentList = [];
      continue;
    }

    assignMeta(meta, key, trimmed);
  }

  if (currentList !== null && currentKey !== null) {
    assignMeta(meta, currentKey, currentList);
  }

  return { meta, body };
}

function assignMeta(meta: ParsedFrontMatter, key: string, value: string | string[]): void {
  switch (key.toLowerCase()) {
    case 'title':
      if (typeof value === 'string') meta.title = value.replace(/^['"]|['"]$/g, '');
      break;
    case 'date':
      if (typeof value === 'string') meta.date = value;
      break;
    case 'summary':
    case 'description':
      if (typeof value === 'string') meta.summary = meta.summary ?? value;
      break;
    case 'tags':
      meta.tags = Array.isArray(value) ? value : [value];
      break;
    case 'project':
      if (typeof value === 'string') meta.project = value;
      break;
    case 'url':
      if (typeof value === 'string') meta.url = value;
      break;
    default:
      break;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strips markdown syntax to produce a plain-text body for FTS. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')        // fenced code blocks
    .replace(/`[^`]+`/g, '')              // inline code
    .replace(/!\[.*?\]\(.*?\)/g, '')       // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → link text
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
    .replace(/^\s*[-*+]\s+/gm, '')         // unordered list markers
    .replace(/^\s*\d+\.\s+/gm, '')         // ordered list markers
    .replace(/^\s*>\s+/gm, '')             // blockquotes
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Derives a title from a file path when front-matter has none. */
function titleFromPath(path: string): string {
  const stem = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
  return stem
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Maps an optional project string from front-matter to a ProjectContext. */
function resolveProjectContext(project: string | undefined): ContentItem['projectContext'] {
  if (!project) return 'personal';
  const lower = project.toLowerCase();
  if (lower.includes('ibm') || lower.includes('thought')) return 'ibm-thought-leadership';
  if (lower.includes('structara')) return 'structara-ai';
  return 'personal';
}

// ── Main sync ─────────────────────────────────────────────────────────────────

const SOURCE: ContentItem['source'] = 'github-content-store';
const CONTENT_STORE_TAG = 'content-store';

export async function syncContentStore(db: Pool): Promise<{ indexed: number; errors: number }> {
  const repo = env.GITHUB_CONTENT_STORE_REPO;
  if (!repo) {
    console.warn('[content-store] GITHUB_CONTENT_STORE_REPO not set — skipping');
    return { indexed: 0, errors: 0 };
  }

  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  // ── Detect whether anything has changed since last sync ──────────────────
  const syncState = await getSyncState(db, SOURCE);
  const lastCursor = syncState?.lastCursor ?? null; // stores the HEAD commit SHA

  let headSha: string;
  try {
    const ref = await client.get<GitRef>(`/repos/${repo}/git/ref/heads/main`);
    headSha = ref.object.sha;
  } catch {
    // Try "master" branch if "main" doesn't exist
    try {
      const ref = await client.get<GitRef>(`/repos/${repo}/git/ref/heads/master`);
      headSha = ref.object.sha;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[content-store] Could not resolve HEAD ref: ${message}`);
      return { indexed: 0, errors: 1 };
    }
  }

  if (lastCursor === headSha) {
    // Nothing has changed — skip fetching blobs
    console.warn(`[content-store] No changes since last sync (${headSha.substring(0, GIT_SHORT_SHA_LENGTH)})`);
    return { indexed: 0, errors: 0 };
  }

  // ── Fetch the full recursive tree ────────────────────────────────────────
  let tree: GitTree;
  try {
    tree = await client.get<GitTree>(
      `/repos/${repo}/git/trees/${headSha}`,
      { recursive: '1' },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[content-store] Failed to fetch tree: ${message}`);
    return { indexed: 0, errors: 1 };
  }

  if (tree.truncated) {
    console.warn('[content-store] Tree was truncated by GitHub — some files may be missed');
  }

  // Filter to .md, .pdf, .docx, .pptx blobs only (skip README, _template, etc.)
  const contentBlobs = tree.tree.filter(
    (item) =>
      item.type === 'blob' &&
      /\.(md|pdf|docx|pptx)$/i.test(item.path) &&
      !item.path.startsWith('_') &&
      !/README\.(md|pdf|docx|pptx)$/i.test(item.path),
  );

  console.warn(`[content-store] Found ${contentBlobs.length} content files to sync`);

  // ── Fetch and upsert each file ────────────────────────────────────────────
  for (const blob of contentBlobs) {
    try {
      const gitBlob = await client.get<GitBlob>(`/repos/${repo}/git/blobs/${blob.sha}`);
      const buffer = Buffer.from(gitBlob.content.replace(/\n/g, ''), 'base64');

      let title = titleFromPath(blob.path);
      let body = '';
      const ext = blob.path.toLowerCase().split('.').pop() || '';

      // Handle based on file type
      if (ext === 'md') {
        // Markdown: parse front-matter
        const rawContent = buffer.toString('utf-8');
        const { meta, body: mdBody } = parseFrontMatter(rawContent);
        title = meta.title?.trim() || title;
        body = stripMarkdown(mdBody);
      } else if (['pdf', 'docx', 'pptx'].includes(ext)) {
        // Documents: extract text
        const result = await extractDocumentText(buffer, blob.path);
        if (result.error) {
          console.warn(`[content-store] Document extraction warning for ${blob.path}: ${result.error}`);
        }
        body = result.text;
      }

      const summary = body.slice(0, NOTE_SUMMARY_MAX_LENGTH).replace(/\s+/g, ' ');
      const publishedAt = new Date().toISOString();
      const tags: string[] = [CONTENT_STORE_TAG];

      const item: Omit<ContentItem, 'id' | 'indexedAt'> = {
        source: SOURCE,
        sourceId: blob.sha,
        title,
        summary,
        body,
        publishedAt,
        url: `https://github.com/${repo}/blob/main/${blob.path}`,
        projectContext: resolveProjectContext(undefined),
        metadata: {
          repo,
          path: blob.path,
          blobSha: blob.sha,
          commitSha: headSha,
          fileType: ext,
        },
        tags,
      };

      await upsertContentItem(db, item);
      indexed++;
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[content-store] Failed to index ${blob.path}: ${message}`);
    }
  }

  // ── Persist sync state, storing HEAD SHA as cursor ───────────────────────
  await upsertSyncState(db, SOURCE, {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
    lastCursor: headSha,
  });

  return { indexed, errors };
}
