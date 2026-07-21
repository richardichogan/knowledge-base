import type { Pool, QueryResult } from 'pg';
import type { ContentItem, ContentItemSummary } from '../types/index.js';
import { tagContent } from '../services/taxonomyService.js';

const TAG_SUMMARY_CHARS = 2000;

// ── Content items ─────────────────────────────────────────────────────────────

/**
 * Upserts a content item into the index.
 * For discovered-article: conflicts on url (stable across feed snapshots).
 * For all other sources: conflicts on (source, source_id).
 * Returns true if this was a newly inserted row, false if it already existed.
 */
export async function upsertContentItem(
  db: Pool,
  item: Omit<ContentItem, 'id' | 'indexedAt'>,
): Promise<{ isNew: boolean; id: string }> {
  // discovered-article rows are keyed by URL because the CMS assigns a new
  // source_id on every feed snapshot — the URL is the stable identifier.
  if (item.source === 'discovered-article' && item.url) {
    const sql = `
      INSERT INTO content_items
        (source, source_id, title, summary, body, published_at, url, project_context, metadata, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (url) WHERE source = 'discovered-article' AND url IS NOT NULL AND url != ''
      DO UPDATE SET
        source_id = EXCLUDED.source_id,
        title     = EXCLUDED.title,
        summary   = EXCLUDED.summary,
        body      = EXCLUDED.body,
        metadata  = content_items.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS is_new
    `;
    const result = await db.query<{ id: string; is_new: boolean }>(sql, [
      item.source, item.sourceId, item.title, item.summary, item.body,
      item.publishedAt, item.url, item.projectContext,
      JSON.stringify(item.metadata), item.tags,
    ]);
    const row = result.rows[0];
    const isNew = row?.is_new ?? false;
    const id = row?.id ?? '';
    if (id && isNew) {
      const summary = `${item.title}\n\n${(item.summary ?? item.body ?? '')}`.slice(0, TAG_SUMMARY_CHARS);
      void tagContent(db, summary, id, item.source, item.title).catch((err: unknown) => {
        console.error(`[queries] Auto-tag failed for ${item.source}:${item.sourceId}`, err instanceof Error ? err.message : err);
      });
    }
    return { isNew, id };
  }

  const sql = `
    INSERT INTO content_items
      (source, source_id, title, summary, body, published_at, url, project_context, metadata, tags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (source, source_id) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      body = EXCLUDED.body,
      url = EXCLUDED.url,
      -- Merge metadata: preserve scoring fields (platform, sourceType, spark, etc.) that were calculated
      -- Only update the source-provided fields (status, newsWorthiness, sourceTitle, etc.)
      metadata = content_items.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS is_new
  `;
  const result = await db.query<{ id: string; is_new: boolean }>(sql, [
    item.source,
    item.sourceId,
    item.title,
    item.summary,
    item.body,
    item.publishedAt,
    item.url ?? null,
    item.projectContext,
    JSON.stringify(item.metadata),
    item.tags,
  ]);
  
  // If no row returned, item already exists - get the existing ID
  if (result.rows.length === 0) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM content_items WHERE source = $1 AND source_id = $2`,
      [item.source, item.sourceId]
    );
    return { isNew: false, id: existing.rows[0]?.id ?? '' };
  }
  
  const row = result.rows[0];
  const isNew = row?.is_new ?? false;
  const id = row?.id ?? '';

  // Fire-and-forget: tag NEW items only.
  if (id && isNew) {
    const summary = `${item.title}\n\n${(item.summary ?? item.body ?? '')}`.slice(0, TAG_SUMMARY_CHARS);
    void tagContent(db, summary, id, item.source, item.title).catch((err: unknown) => {
      console.error(`[queries] Auto-tag failed for ${item.source}:${item.sourceId}`, err instanceof Error ? err.message : err);
    });
  }

  return { isNew, id };
}

/** Returns paginated timeline items ordered by published_at DESC. */
export async function queryTimeline(
  db: Pool,
  options: {
    source?: string;
    projectContext?: string;
    page?: number;
    pageSize: number;
    before?: string; // ISO date cursor — fetch items published before this datetime
  },
): Promise<{ items: ContentItemSummary[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.source) {
    conditions.push(`ci.source = $${paramIndex++}`);
    params.push(options.source);
  }
  if (options.projectContext) {
    conditions.push(`ci.project_context = $${paramIndex++}`);
    params.push(options.projectContext);
  }
  if (options.before) {
    conditions.push(`ci.published_at < $${paramIndex++}`);
    params.push(options.before);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // When using cursor-based pagination, skip the expensive COUNT
  const total = options.before
    ? -1
    : parseInt(
        (await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM content_items ci ${where}`, params))
          .rows[0]?.count ?? '0',
        10,
      );

  // Legacy offset pagination (page param) or cursor pagination (before param)
  const offset = options.before ? 0 : ((options.page ?? 1) - 1) * options.pageSize;
  const dataParams = [...params, options.pageSize, offset];

  const dataResult: QueryResult<ContentItemRow> = await db.query(
    `SELECT ci.id, ci.source, ci.source_id, ci.title, ci.summary, ci.published_at, ci.indexed_at,
            ci.url, ci.project_context, ci.metadata, ci.tags,
            array_agg(cit.tag_id) FILTER (WHERE cit.tag_id IS NOT NULL) AS taxonomy_tag_ids
     FROM content_items ci
     LEFT JOIN content_item_tags cit ON cit.content_item_id = ci.id
     ${where}
     GROUP BY ci.id
     ORDER BY ci.published_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    dataParams,
  );

  return { items: dataResult.rows.map(rowToSummary), total };
}

/** Full-text search using PostgreSQL tsvector. */
export async function searchContentItems(
  db: Pool,
  query: string,
  options: { source?: string; page: number; pageSize: number },
): Promise<{ items: ContentItemSummary[]; total: number }> {
  const conditions = [`search_vector @@ plainto_tsquery('english', $1)`];
  const params: unknown[] = [query];
  let paramIndex = 2;

  if (options.source) {
    conditions.push(`source = $${paramIndex++}`);
    params.push(options.source);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const offset = (options.page - 1) * options.pageSize;

  const countResult: QueryResult<{ count: string }> = await db.query(
    `SELECT COUNT(*) AS count FROM content_items ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const dataParams = [...params, options.pageSize, offset];
  const dataResult: QueryResult<ContentItemRow> = await db.query(
    `SELECT id, source, source_id, title, summary, published_at, indexed_at,
            url, project_context, metadata, tags,
            ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
     FROM content_items ${where}
     ORDER BY rank DESC, published_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    dataParams,
  );

  return { items: dataResult.rows.map(rowToSummary), total };
}

/**
 * Retrieves top-N relevant items for RAG context.
 *
 * `plainto_tsquery` ANDs every word together, so a multi-word query like
 * "project imagine" only matches rows containing *both* "project" and
 * "imagine" literally — which silently returns zero rows for the vast
 * majority of real content that just mentions "imagine" on its own. If the
 * AND query comes back empty, fall back to an OR-joined tsquery built from
 * the same words so any single matching term still surfaces results.
 */
export async function getRagItems(
  db: Pool,
  query: string,
  limit: number,
): Promise<ContentItem[]> {
  const andResult: QueryResult<ContentItemRow & { body: string }> = await db.query(
    `SELECT id, source, source_id, title, summary, body, published_at, indexed_at,
            url, project_context, metadata, tags,
            ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
     FROM content_items
     WHERE search_vector @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC, published_at DESC
     LIMIT $2`,
    [query, limit],
  );
  if (andResult.rows.length > 0) return andResult.rows.map(rowToItem);

  // Fallback: OR the individual words together via to_tsquery so a phrase
  // like "project imagine" still matches rows that only contain "imagine".
  const orQuery = query
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => w.replace(/[^\w]/g, ''))
    .filter((w) => w !== '')
    .join(' | ');
  if (orQuery === '') return [];

  const orResult: QueryResult<ContentItemRow & { body: string }> = await db.query(
    `SELECT id, source, source_id, title, summary, body, published_at, indexed_at,
            url, project_context, metadata, tags,
            ts_rank(search_vector, to_tsquery('english', $1)) AS rank
     FROM content_items
     WHERE search_vector @@ to_tsquery('english', $1)
     ORDER BY rank DESC, published_at DESC
     LIMIT $2`,
    [orQuery, limit],
  );
  return orResult.rows.map(rowToItem);
}

// ── Sync state ────────────────────────────────────────────────────────────────

export async function getSyncState(
  db: Pool,
  source: string,
): Promise<{ lastSyncAt: Date | null; lastCursor: string | null } | null> {
  const result = await db.query<{ last_sync_at: Date | null; last_cursor: string | null }>(
    `SELECT last_sync_at, last_cursor FROM sync_state WHERE source = $1`,
    [source],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { lastSyncAt: row.last_sync_at, lastCursor: row.last_cursor };
}

export async function upsertSyncState(
  db: Pool,
  source: string,
  updates: { lastSyncAt?: Date; lastCursor?: string; itemCount?: number; lastError?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO sync_state (source, last_sync_at, last_cursor, item_count, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_sync_at = COALESCE($2, sync_state.last_sync_at),
       last_cursor  = COALESCE($3, sync_state.last_cursor),
       item_count   = COALESCE($4, sync_state.item_count),
       last_error   = $5,
       updated_at   = NOW()`,
    [
      source,
      updates.lastSyncAt ?? null,
      updates.lastCursor ?? null,
      updates.itemCount ?? null,
      updates.lastError ?? null,
    ],
  );
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface ContentItemRow {
  id: string;
  source: string;
  source_id: string;
  title: string;
  summary: string;
  body?: string;
  published_at: Date;
  indexed_at: Date;
  url: string | null;
  project_context: string;
  metadata: unknown;
  tags: string[];
  taxonomy_tag_ids: string[] | null;
}

function rowToSummary(row: ContentItemRow): ContentItemSummary {
  const base: ContentItemSummary = {
    id: row.id,
    source: row.source as ContentItemSummary['source'],
    sourceId: row.source_id,
    title: row.title,
    summary: row.summary,
    publishedAt: row.published_at.toISOString(),
    indexedAt: row.indexed_at.toISOString(),
    projectContext: row.project_context,
    metadata: row.metadata as Record<string, unknown>,
    tags: row.tags,
    taxonomyTagIds: row.taxonomy_tag_ids ?? [],
  };
  if (row.url !== null) {
    base.url = row.url;
  }
  return base;
}

function rowToItem(row: ContentItemRow & { body: string }): ContentItem {
  return {
    ...rowToSummary(row),
    body: row.body,
  };
}
