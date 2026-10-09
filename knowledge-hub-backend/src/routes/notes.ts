/**
 * Notes routes — Change 002
 *
 * GET  /api/notes         — paginated list of active notes
 *                            (?view=summary → titles/previews only, no bodies)
 * GET  /api/notes/:id     — one active note
 * POST /api/notes         — create a note
 * DELETE /api/notes/:id   — archive (soft delete) a note
 */

import { queueAutoTag } from '../services/autoTagging.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { upsertContentItem } from '../db/queries.js';
import { upsertTags } from '../db/tagHelpers.js';
import { upsertNode } from '../services/nodeService.js';
import { parseNoteContent, blockContentSpans } from '../utils/noteContent.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import { env } from '../config/env.js';
import { indexContentItem } from '../ai/foundryIqIndexer.js';
import { HTTP_STATUS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, NOTE_TITLE_MAX_LENGTH, NOTE_SUMMARY_MAX_LENGTH } from '../config/constants.js';
import type { ApiSuccess, PaginatedList, Note, CreateNoteInput, ContentItem } from '../types/index.js';
import { ValidationError, NotFoundError } from '../types/index.js';
import { writeNote, listNoteVersions, getNoteVersion, parseWriting, writingFingerprint } from '../services/noteVersionService.js';
import { checkPublication, listRepositoryFolders, listWritableRepositories, publicationRow, publicationView, publishNote, remoteNote, scheduleGitHubPublish, startPublication } from '../services/noteGitHubService.js';
import { githubMarkdownBlocks } from '../services/noteMarkdown.js';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { ConflictError } from '../types/errors.js';

const router = Router();
const MAX_REPOSITORY_PAGE = 100;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * BlockNote stores content as a JSON array of blocks.
 * Each block has a `type` (e.g. "heading", "paragraph") and `content` array of
 * inline elements with a `text` field.
 * Extract a display title from the first heading block, falling back to the
 * first paragraph text, then a generic label.
 */
function extractNoteTitle(contentJson: string): string {
  const { title, blocks } = parseNoteContent(contentJson);
  if (title !== null) return title.slice(0, NOTE_TITLE_MAX_LENGTH);
  // Fall back to first heading, then first paragraph text
  for (const type of ['heading', 'paragraph']) {
    const block = blocks.find((b) => b.type === type);
    if (block) {
      const text = blockContentSpans(block).map((c) => c.text ?? '').join('').trim();
      if (text) return text.slice(0, NOTE_TITLE_MAX_LENGTH);
    }
  }
  return 'Untitled Note';
}

function extractNoteSummary(contentJson: string): string {
  const { blocks } = parseNoteContent(contentJson);
  return blocks
    .flatMap((b) => blockContentSpans(b))
    .map((c) => c.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_SUMMARY_MAX_LENGTH);
}

/** Turns a stored content type id into a readable label for the indexed text. */
function contentTypeLabel(contentType: string | null): string {
  if (contentType === null || contentType === 'note') return 'Note';
  return contentType
    .split('-')
    .map((part) => (part.length > 0 ? part[0]?.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/** The subset of a note needed to build its content_items mirror. */
export interface IndexableNote {
  id: string;
  content: string;
  projectId?: string | null;
  tags: string[];
  updatedAt: string;
}

/**
 * Builds the content_items payload for a note.
 *
 * The indexed body is rendered plain text, NOT the raw BlockNote wrapper
 * JSON. Indexing the raw JSON meant the FTS tsvector and the Foundry IQ
 * embedding were built almost entirely from structural boilerplate
 * ({"type":"paragraph","props":{...}}) that is identical across every note,
 * which is why notes kept failing to surface for questions their prose
 * clearly answered.
 *
 * The content type is prefixed onto the indexed text and carried in metadata
 * so Athena can tell a use case from a meeting note, and answer questions
 * like "what use cases do we have for Imagine?".
 */
export async function buildNoteIndexPayload(
  db: ReturnType<typeof getDb>,
  note: IndexableNote,
): Promise<Omit<ContentItem, 'id' | 'indexedAt'>> {
  const title = extractNoteTitle(note.content);
  const { contentType } = parseNoteContent(note.content);
  const typeLabel = contentTypeLabel(contentType);
  const rawSummary = extractNoteSummary(note.content);
  const noteText = await renderNoteAsText(db, note.content);

  return {
    source: 'note',
    sourceId: note.id,
    title,
    summary: `${typeLabel}: ${rawSummary}`.slice(0, NOTE_SUMMARY_MAX_LENGTH),
    body: `${typeLabel}: ${title}\n\n${noteText}`,
    publishedAt: note.updatedAt,
    url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}`,
    projectContext: note.projectId ?? 'personal',
    metadata: { noteId: note.id, contentType: contentType ?? 'note', tags: note.tags },
    tags: [...new Set([...(note.projectId ? [note.projectId] : []), ...note.tags])],
  };
}

/**
 * Syncs a saved note into content_items so it appears in the timeline, and
 * best-effort pushes it into the Foundry IQ Search index so it's
 * semantically queryable via search_knowledge_base immediately — previously
 * notes only ever reached Postgres full-text search, so a paraphrased
 * question (e.g. "approved LLM list" vs. a note phrased as "model
 * governance constraints") could never surface it.
 */
export async function syncNoteToTimeline(db: ReturnType<typeof getDb>, note: IndexableNote): Promise<void> {
  const payload = await buildNoteIndexPayload(db, note);
  const { id: contentItemId } = await upsertContentItem(db, payload);

  void indexContentItem({
    ...payload,
    id: contentItemId,
    indexedAt: new Date().toISOString(),
  }).catch((err: unknown) => {
    console.error('[notes] Foundry IQ index push failed:', err instanceof Error ? err.message : err);
  });
}

/** Lightweight list row for the Think sidebar — no note body (bodies can be MBs with images). */
interface NoteSummary {
  id: string;
  title: string;
  contentType: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  projectId?: string;
  taxonomyTagIds: string[];
}

const NOTE_PREVIEW_CHARS = 200;

/** Joins block text, recursing into children (mirrors the web client's extractNoteBlockText). */
function blockText(blocks: unknown[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { content?: unknown; children?: unknown };
    if (Array.isArray(block.content)) {
      const t = (block.content as { text?: unknown }[])
        .map((c) => (typeof c.text === 'string' ? c.text : ''))
        .join('')
        .trim();
      if (t !== '') out.push(t);
    }
    if (Array.isArray(block.children)) out.push(...blockText(block.children as unknown[]));
  }
  return out;
}

/**
 * Title / type / preview from the stored wrapper JSON — the same rules the
 * web client used when it derived these from full bodies (preview skips
 * leading lines that just repeat the title).
 */
function summariseNote(row: { id: string; content: string; created_at: string; updated_at: string; project_id: string | null; taxonomy_tag_ids: string[] }): NoteSummary {
  let title = 'Untitled';
  let contentType = 'note';
  let preview = '';
  try {
    const wrapper = JSON.parse(row.content) as { title?: unknown; contentType?: unknown; contentJson?: unknown };
    if (typeof wrapper.title === 'string') title = wrapper.title;
    if (typeof wrapper.contentType === 'string') contentType = wrapper.contentType;
    if (typeof wrapper.contentJson === 'string') {
      const blocks = JSON.parse(wrapper.contentJson) as unknown;
      if (Array.isArray(blocks)) {
        const lines = blockText(blocks);
        const t = title.trim().toLowerCase();
        let start = 0;
        while (start < lines.length && (lines[start] ?? '').trim().toLowerCase() === t) start += 1;
        preview = lines.slice(start).join('\n').slice(0, NOTE_PREVIEW_CHARS);
      }
    }
  } catch {
    // Unparseable legacy content — keep the defaults.
  }
  return {
    id: row.id,
    title,
    contentType,
    preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.project_id !== null && { projectId: row.project_id }),
    taxonomyTagIds: row.taxonomy_tag_ids ?? [],
  };
}

// Autosave PATCHes a note every few seconds while the user types. Re-indexing
// (timeline mirror, Foundry IQ embedding, graph node) on every one of those
// was wasted work, so it runs once per note after edits settle.
const INDEX_SETTLE_MS = 30_000;
const pendingIndexTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleNoteIndexing(db: ReturnType<typeof getDb>, note: Note): void {
  const existing = pendingIndexTimers.get(note.id);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingIndexTimers.delete(note.id);
    upsertTags(db, note.tags).catch((e: unknown) => {
      console.error('[notes] Failed to upsert tags:', e);
    });
    syncNoteToTimeline(db, note).catch((e: unknown) => {
      console.error('[notes] Failed to sync updated note to timeline:', e);
    });
    queueAutoTag(db, 'note', note.id, 0); // edits have settled: tag it if its content changed
    void (async (): Promise<void> => {
      try {
        let title = 'Untitled Note';
        try { const p = JSON.parse(note.content) as { title?: string }; title = p.title ?? title; } catch { /* ignore */ }
        await upsertNode(db, note.id, 'note', title, note.tags);
      } catch (e: unknown) {
        console.error('[notes] Failed to upsert graph node on update:', e);
      }
    })();
  }, INDEX_SETTLE_MS);
  timer.unref();
  pendingIndexTimers.set(note.id, timer);
}

// ── GET /api/notes ─────────────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, parseInt(String(req.query['pageSize'] ?? String(DEFAULT_PAGE_SIZE)), 10)),
      );
      const offset = (page - 1) * pageSize;

      const [rowsResult, countResult] = await Promise.all([
        db.query<{
          id: string;
          content: string;
          created_at: string;
          updated_at: string;
          tags: string[];
          linked_items: string[];
          status: string;
          project_id: string | null;
          taxonomy_tag_ids: string[];
          revision: number;
        }>(
          `SELECT n.id, n.content, n.created_at, n.updated_at, n.tags, n.linked_items, n.status, n.project_id, n.revision,
                  COALESCE(ARRAY_AGG(nt.tag_id) FILTER (WHERE nt.tag_id IS NOT NULL), '{}') AS taxonomy_tag_ids
           FROM notes n
           LEFT JOIN note_tags nt ON nt.note_id = n.id
           WHERE n.status = 'active'
           GROUP BY n.id
           ORDER BY n.created_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        ),
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM notes WHERE status = 'active'`,
        ),
      ]);

      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      if (req.query['view'] === 'summary') {
        const items = rowsResult.rows.map(summariseNote);
        const summaryBody: ApiSuccess<PaginatedList<NoteSummary>> = {
          success: true,
          data: { items, total, page, pageSize, hasMore: offset + items.length < total },
        };
        res.status(HTTP_STATUS.OK).json(summaryBody);
        return;
      }

      const notes: Note[] = rowsResult.rows.map((row) => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: row.tags,
        linkedItems: row.linked_items,
        status: row.status as Note['status'],
        ...(row.project_id !== null && { projectId: row.project_id }),
        taxonomyTagIds: row.taxonomy_tag_ids ?? [],
        revision: row.revision,
      }));

      const body: ApiSuccess<PaginatedList<Note>> = {
        success: true,
        data: {
          items: notes,
          total,
          page,
          pageSize,
          hasMore: offset + notes.length < total,
        },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

// ── GET /api/notes/:id ────────────────────────────────────────────────────────

router.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const result = await db.query<{
        id: string;
        content: string;
        created_at: string;
        updated_at: string;
        tags: string[];
        linked_items: string[];
        status: string;
        project_id: string | null;
        taxonomy_tag_ids: string[];
        revision: number;
      }>(
        `SELECT n.id, n.content, n.created_at, n.updated_at, n.tags, n.linked_items, n.status, n.project_id, n.revision,
                COALESCE(ARRAY_AGG(nt.tag_id) FILTER (WHERE nt.tag_id IS NOT NULL), '{}') AS taxonomy_tag_ids
           FROM notes n
           LEFT JOIN note_tags nt ON nt.note_id = n.id
          WHERE n.id::text = $1 AND n.status = 'active'
          GROUP BY n.id`,
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new NotFoundError(`Note ${String(id)} not found`);
      const note: Note = {
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: row.tags,
        linkedItems: row.linked_items,
        status: row.status as Note['status'],
        ...(row.project_id !== null && { projectId: row.project_id }),
        taxonomyTagIds: row.taxonomy_tag_ids ?? [],
        revision: row.revision,
      };
      const body: ApiSuccess<Note> = { success: true, data: note };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

// ── POST /api/notes ────────────────────────────────────────────────────────────

/**
 * Creates a note record: inserts into `notes`, then fires off (non-blocking)
 * side effects — tag upsert, content_items timeline mirror, graph node upsert.
 * Shared by the POST /api/notes route and the AI chat's create_note_draft tool.
 */
export async function createNoteRecord(
  db: ReturnType<typeof getDb>,
  input: Partial<CreateNoteInput>,
): Promise<Note> {
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new ValidationError('content is required', { content: 'must be a non-empty string' });
  }

  const projectId: string | null =
    typeof input.projectId === 'string' && input.projectId.trim() !== ''
      ? input.projectId.trim()
      : null;

  const result = await db.query<{
    id: string;
    content: string;
    created_at: string;
    updated_at: string;
    tags: string[];
    linked_items: string[];
    status: string;
    project_id: string | null;
  }>(
    `INSERT INTO notes (content, tags, project_id)
     VALUES ($1, $2, $3)
     RETURNING id, content, created_at, updated_at, tags, linked_items, status, project_id`,
    [input.content.trim(), input.tags ?? [], projectId],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error('Insert returned no rows');

  const note: Note = {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: row.tags,
    linkedItems: row.linked_items,
    status: row.status as Note['status'],
    ...(row.project_id !== null && { projectId: row.project_id }),
  };

  // Auto-upsert tags into global_tags (fire-and-forget)
  upsertTags(db, note.tags).catch((e: unknown) => {
    console.error('[notes] Failed to upsert tags:', e);
  });
  // Mirror note into content_items for timeline visibility (fire-and-forget)
  syncNoteToTimeline(db, note).catch((e: unknown) => {
    console.error('[notes] Failed to sync new note to timeline:', e);
  });
  queueAutoTag(db, 'note', note.id); // tagged once it has settled
  // Upsert graph node so the note appears in the connections graph immediately (fire-and-forget)
  void (async (): Promise<void> => {
    try {
      let title = 'Untitled Note';
      try { const p = JSON.parse(note.content) as { title?: string }; title = p.title ?? title; } catch { /* ignore */ }
      await upsertNode(db, note.id, 'note', title, note.tags);
    } catch (e: unknown) {
      console.error('[notes] Failed to upsert graph node:', e);
    }
  })();

  return note;
}

router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const note = await createNoteRecord(db, req.body as Partial<CreateNoteInput>);
      const body: ApiSuccess<Note> = { success: true, data: note };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

// ── PATCH /api/notes/:id ──────────────────────────────────────────────────────

router.get('/:id/github', (req, res, next) => {
  void (async (): Promise<void> => {
    const db = getDb();
    if (req.query['check'] === 'true') {
      res.json({ success: true, data: await checkPublication(db, String(req.params.id)) });
    } else {
      const row = await publicationRow(db, String(req.params.id));
      res.json({ success: true, data: row ? publicationView(row) : null });
    }
  })().catch(next);
});
router.get('/github/repositories', (req, res, next) => {
  void (async (): Promise<void> => {
    const page = Number(req.query['page'] ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > MAX_REPOSITORY_PAGE) throw new ValidationError('page must be between 1 and 100.');
    res.json({ success: true, data: await listWritableRepositories(getDb(), page) });
  })().catch(next);
});
router.get('/github/folders', (req, res, next) => {
  void listRepositoryFolders(getDb(), req.query['repo'], req.query['folder'] ?? '')
    .then(data => { res.json({ success: true, data }); }).catch(next);
});
router.post('/:id/github', (req, res, next) => {
  void (async (): Promise<void> => {
    const input = req.body as { repo?: unknown; filePath?: unknown; commitMessage?: unknown; expectedRevision?: unknown };
    const data = await startPublication(getDb(), String(req.params.id), input.repo, input.filePath, input.commitMessage, input.expectedRevision);
    res.json({ success: true, data });
  })().catch(next);
});
router.get('/:id/github/remote', (req, res, next) => {
  void (async (): Promise<void> => {
    const row = await publicationRow(getDb(), String(req.params.id));
    if (!row) throw new NotFoundError('GitHub publication');
    const remote = await remoteNote(new GitHubClient(), row);
    res.json({ success: true, data: {
      sha: remote?.sha ?? null,
      markdown: remote ? Buffer.from(remote.content.replace(/\s/g, ''), 'base64').toString('utf8') : null,
    } });
  })().catch(next);
});
router.post('/:id/github/resolve', (req, res, next) => {
  void (async (): Promise<void> => {
    const id = String(req.params.id);
    const db = getDb();
    const input = req.body as { choice?: unknown; remoteSha?: unknown; expectedRevision?: unknown };
    if ((input.choice !== 'think' && input.choice !== 'github')
        || (input.remoteSha !== null && typeof input.remoteSha !== 'string')
        || !Number.isInteger(input.expectedRevision)) {
      throw new ValidationError('Choose a reviewed version and provide its SHA and the current note revision.');
    }
    const noteResult = await db.query<{ content: string; revision: number }>(
      "SELECT content, revision FROM notes WHERE id = $1 AND status = 'active'", [id]);
    const note = noteResult.rows[0];
    if (!note) throw new NotFoundError('Note');
    if (note.revision !== input.expectedRevision) throw new ConflictError('This note changed. Review the versions again.', 'NOTE_REVISION_CONFLICT');
    if (input.choice === 'think') {
      const data = await publishNote(db, id, { expectedRemoteSha: input.remoteSha });
      res.json({ success: true, data });
      return;
    }
    const row = await publicationRow(db, id);
    if (!row) throw new NotFoundError('GitHub publication');
    const remote = await remoteNote(new GitHubClient(), row);
    if (!remote || remote.sha !== input.remoteSha) throw new ConflictError('The GitHub file changed again or was deleted. Review it again.', 'GITHUB_NOTE_CONFLICT');
    const markdown = Buffer.from(remote.content.replace(/\s/g, ''), 'base64').toString('utf8');
    const wrapper: unknown = JSON.parse(note.content);
    const metadata = typeof wrapper === 'object' && wrapper !== null && !Array.isArray(wrapper) ? wrapper : {};
    const contentJson = JSON.stringify(await githubMarkdownBlocks(markdown));
    const heading = parseNoteContent(contentJson).blocks.find(block => block.type === 'heading');
    const title = heading ? blockContentSpans(heading).map(span => span.text ?? '').join('').trim() : '';
    const data = await writeNote(db, id, {
      content: JSON.stringify({ ...metadata, ...(title && { title }), contentJson }),
      expectedRevision: note.revision, importGitHub: true,
    });
    // Keep the pre-import writing as a recovery checkpoint, not the imported writing.
    scheduleNoteIndexing(db, data);
    await db.query(
      `UPDATE note_github_publications SET blob_sha = $2, synced_fingerprint = $3, synced_revision = $4,
       status = CASE WHEN (SELECT revision FROM notes WHERE id = $1) = $4 THEN 'synced' ELSE 'pending' END,
       error = NULL, updated_at = NOW() WHERE note_id = $1`,
      [id, remote.sha, writingFingerprint(parseWriting(data.content)), data.revision]);
    const accepted = await publicationRow(db, id);
    if (!accepted) throw new NotFoundError('GitHub publication');
    if (accepted.status === 'pending') scheduleGitHubPublish(db, id);
    res.json({ success: true, data: publicationView(accepted) });
  })().catch(next);
});

router.get('/:id/history', (req, res, next) => {
  void listNoteVersions(getDb(), String(req.params.id))
    .then(data => { res.json({ success: true, data }); }).catch(next);
});
router.get('/:id/history/:versionId', (req, res, next) => {
  void getNoteVersion(getDb(), String(req.params.id), String(req.params.versionId))
    .then(data => { res.json({ success: true, data }); }).catch(next);
});
router.post('/:id/checkpoint', (req, res, next) => {
  void (async (): Promise<void> => {
    const input = req.body as { content?: unknown; expectedRevision?: number };
    if (typeof input.content !== 'string' || !input.content.trim()) throw new ValidationError('content is required', {});
    const data = await writeNote(getDb(), String(req.params.id), {
      content: input.content, expectedRevision: input.expectedRevision, protect: true,
    });
    res.json({ success: true, data });
  })().catch(next);
});
router.post('/:id/history/:versionId/restore', (req, res, next) => {
  void (async (): Promise<void> => {
    const input = req.body as { expectedRevision?: number; content?: unknown };
    if (input.content !== undefined && (typeof input.content !== 'string' || !input.content.trim())) throw new ValidationError('content must be a non-empty string', {});
    const data = await writeNote(getDb(), String(req.params.id), {
      expectedRevision: input.expectedRevision, restoreId: String(req.params.versionId),
      ...(typeof input.content === 'string' && { content: input.content }),
    });
    res.json({ success: true, data });
    scheduleNoteIndexing(getDb(), data);
  })().catch(next);
});

router.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;

      if (typeof id !== 'string' || id.trim() === '') {
        throw new ValidationError('id is required', {});
      }

      const input = req.body as Partial<{ content: string; tags: string[]; projectId: string | null; expectedRevision: number }>;

      if (typeof input.content !== 'string' || input.content.trim() === '') {
        throw new ValidationError('content is required', { content: 'must be a non-empty string' });
      }

      // project_id: explicit null clears it, string assigns it, undefined = no change
      const hasProjectId = 'projectId' in input;
      const projectId: string | null | undefined = hasProjectId
        ? (typeof input.projectId === 'string' && input.projectId.trim() !== '' ? input.projectId.trim() : null)
        : undefined;

      const note = await writeNote(db, id, {
        content: input.content.trim(), expectedRevision: input.expectedRevision,
        ...(Array.isArray(input.tags) && { tags: input.tags }),
        ...(hasProjectId && { projectId: projectId ?? null }),
      });

      const body: ApiSuccess<Note> = { success: true, data: note };
      res.status(HTTP_STATUS.OK).json(body);
      // Re-index once edits settle, not on every autosave.
      scheduleNoteIndexing(db, note);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * Appends BlockNote blocks to the end of an existing note (e.g. a mind-map
 * branch sent to a linked note). Same save + settle-then-index path as PATCH.
 */
export async function appendBlocksToNoteRecord(
  db: ReturnType<typeof getDb>,
  id: string,
  blocks: unknown[],
): Promise<Note> {
  const note = await writeNote(db, id, { appendBlocks: blocks });
  scheduleNoteIndexing(db, note);
  return note;
}

// ── DELETE /api/notes/:id (soft archive) ──────────────────────────────────────

router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;

      if (typeof id !== 'string' || id.trim() === '') {
        throw new ValidationError('id is required', {});
      }

      const result = await db.query(
        `UPDATE notes SET status = 'archived', updated_at = NOW()
         WHERE id = $1 AND status = 'active'`,
        [id],
      );

      if (result.rowCount === 0) {
        throw new NotFoundError(`Note ${id} not found or already archived`);
      }

      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
      // Remove the note from content_items so it disappears from the timeline
      db.query(`DELETE FROM content_items WHERE source = 'note' AND source_id = $1`, [id])
        .catch((e: unknown) => {
          console.error('[notes] Failed to remove archived note from timeline:', e);
        });
    } catch (err) {
      next(err);
    }
  })();
});

export { router as notesRouter };