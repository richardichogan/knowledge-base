/**
 * Notes routes — Change 002
 *
 * GET  /api/notes         — paginated list of active notes
 * POST /api/notes         — create a note
 * DELETE /api/notes/:id   — archive (soft delete) a note
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { upsertContentItem } from '../db/queries.js';
import { upsertTags } from '../db/tagHelpers.js';
import { upsertNode } from '../services/nodeService.js';
import { env } from '../config/env.js';
import { HTTP_STATUS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, NOTE_TITLE_MAX_LENGTH, NOTE_SUMMARY_MAX_LENGTH } from '../config/constants.js';
import type { ApiSuccess, PaginatedList, Note, CreateNoteInput } from '../types/index.js';
import { ValidationError, NotFoundError } from '../types/index.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * BlockNote stores content as a JSON array of blocks.
 * Each block has a `type` (e.g. "heading", "paragraph") and `content` array of
 * inline elements with a `text` field.
 * Extract a display title from the first heading block, falling back to the
 * first paragraph text, then a generic label.
 */
interface BlockContent { text?: string }
interface Block { type?: string; content?: BlockContent[]; children?: Block[] }
interface NoteContentWrapper { title?: string; contentType?: string; contentJson?: string }

/**
 * Content is stored as JSON: { title, contentType, contentJson }
 * where contentJson is a serialised BlockNote block array.
 * Extract the title from the wrapper first, then fall back to the first
 * heading/paragraph block in contentJson.
 */
function parseNoteContent(contentJson: string): { title: string | null; blocks: Block[] } {
  try {
    const outer = JSON.parse(contentJson) as unknown;
    // Wrapped format: { title, contentType, contentJson }
    if (outer !== null && typeof outer === 'object' && !Array.isArray(outer)) {
      const wrapper = outer as NoteContentWrapper;
      const title = typeof wrapper.title === 'string' && wrapper.title.trim() !== '' && wrapper.title !== 'Untitled'
        ? wrapper.title.trim()
        : null;
      let blocks: Block[] = [];
      if (typeof wrapper.contentJson === 'string') {
        try {
          const inner = JSON.parse(wrapper.contentJson) as unknown;
          blocks = Array.isArray(inner) ? (inner as Block[]) : [];
        } catch { /* ignore */ }
      }
      return { title, blocks };
    }
    // Raw array format (legacy)
    const blocks = Array.isArray(outer) ? (outer as Block[]) : [];
    return { title: null, blocks };
  } catch {
    return { title: null, blocks: [] };
  }
}

function extractNoteTitle(contentJson: string): string {
  const { title, blocks } = parseNoteContent(contentJson);
  if (title !== null) return title.slice(0, NOTE_TITLE_MAX_LENGTH);
  // Fall back to first heading, then first paragraph text
  for (const type of ['heading', 'paragraph']) {
    const block = blocks.find((b) => b.type === type);
    if (block) {
      const text = (block.content ?? []).map((c) => c.text ?? '').join('').trim();
      if (text) return text.slice(0, NOTE_TITLE_MAX_LENGTH);
    }
  }
  return 'Untitled Note';
}

function extractNoteSummary(contentJson: string): string {
  const { blocks } = parseNoteContent(contentJson);
  return blocks
    .flatMap((b) => b.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_SUMMARY_MAX_LENGTH);
}

/** Syncs a saved note into content_items so it appears in the timeline. */
async function syncNoteToTimeline(db: ReturnType<typeof getDb>, note: Note): Promise<void> {
  await upsertContentItem(db, {
    source: 'note',
    sourceId: note.id,
    title: extractNoteTitle(note.content),
    summary: extractNoteSummary(note.content),
    body: note.content,
    publishedAt: note.updatedAt,
    url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}`,
    projectContext: 'personal',
    metadata: { noteId: note.id, tags: note.tags },
    tags: note.tags,
  });
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
        }>(
          `SELECT n.id, n.content, n.created_at, n.updated_at, n.tags, n.linked_items, n.status, n.project_id,
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

router.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;

      if (typeof id !== 'string' || id.trim() === '') {
        throw new ValidationError('id is required', {});
      }

      const input = req.body as Partial<{ content: string; tags: string[]; projectId: string | null }>;

      if (typeof input.content !== 'string' || input.content.trim() === '') {
        throw new ValidationError('content is required', { content: 'must be a non-empty string' });
      }

      // project_id: explicit null clears it, string assigns it, undefined = no change
      const hasProjectId = 'projectId' in input;
      const projectId: string | null | undefined = hasProjectId
        ? (typeof input.projectId === 'string' && input.projectId.trim() !== '' ? input.projectId.trim() : null)
        : undefined;

      // Build SET clause dynamically so we only touch project_id when provided
      const setClauses = ['content = $1', 'tags = $2', 'updated_at = NOW()'];
      const params: unknown[] = [input.content.trim(), input.tags ?? []];
      if (hasProjectId) {
        setClauses.push(`project_id = $${params.length + 1}`);
        params.push(projectId ?? null);
      }
      params.push(id);
      const idParam = `$${params.length}`;

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
        `UPDATE notes
         SET ${setClauses.join(', ')}
         WHERE id = ${idParam} AND status = 'active'
         RETURNING id, content, created_at, updated_at, tags, linked_items, status, project_id`,
        params,
      );

      const row = result.rows[0];
      if (row === undefined) throw new NotFoundError(`Note ${id} not found or already archived`);

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

      const body: ApiSuccess<Note> = { success: true, data: note };
      res.status(HTTP_STATUS.OK).json(body);
      // Auto-upsert tags into global_tags (fire-and-forget)
      upsertTags(db, note.tags).catch((e: unknown) => {
        console.error('[notes] Failed to upsert tags:', e);
      });
      // Mirror note into content_items for timeline visibility (fire-and-forget)
      syncNoteToTimeline(db, note).catch((e: unknown) => {
        console.error('[notes] Failed to sync updated note to timeline:', e);
      });
      // Keep graph node in sync with updated content/tags (fire-and-forget)
      void (async (): Promise<void> => {
        try {
          let title = 'Untitled Note';
          try { const p = JSON.parse(note.content) as { title?: string }; title = p.title ?? title; } catch { /* ignore */ }
          await upsertNode(db, note.id, 'note', title, note.tags);
        } catch (e: unknown) {
          console.error('[notes] Failed to upsert graph node on update:', e);
        }
      })();
    } catch (err) {
      next(err);
    }
  })();
});

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