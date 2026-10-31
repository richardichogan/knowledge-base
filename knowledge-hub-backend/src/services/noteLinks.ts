import type { Pool } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { parseNoteContent } from '../utils/noteContent.js';

export const LINK_TYPES = ['note', 'spark', 'diagram', 'project', 'task', 'usecase', 'article', 'person', 'company'] as const;
export type LinkType = typeof LINK_TYPES[number];
export interface LinkTarget { type: LinkType; id: string; title: string; href: string; requiresClarification?: boolean }
type TargetRow = { type: LinkType; id: string; title: string; url: string | null };
const BACKLINK_PAGE_SIZE = 20;

const TARGETS = `
  SELECT 'note'::text AS type, id::text, note_list_metadata(content)->>'title' AS title, NULL::text AS url, updated_at AS touched
    FROM notes WHERE status = 'active'
  UNION ALL SELECT 'spark', id::text, LEFT(body, 160), NULL, created_at FROM sparks
  UNION ALL SELECT 'diagram', id::text, title, NULL, updated_at FROM canvases
    WHERE canvas_type = 'diagram' AND deleted_at IS NULL
  UNION ALL SELECT 'project', id, name, NULL, updated_at FROM projects WHERE lifecycle_state <> 'archived'
  UNION ALL SELECT 'task', id::text, title, NULL, updated_at FROM tasks WHERE archived = false AND title IS NOT NULL
  UNION ALL SELECT 'usecase', id::text, title, NULL, updated_at FROM use_cases WHERE stage <> 'dropped'
  UNION ALL SELECT 'person', id::text, name, NULL, updated_at FROM people
  UNION ALL SELECT 'company', id::text, name, NULL, updated_at FROM companies
  UNION ALL SELECT 'article', id::text, title, url, COALESCE(published_at, indexed_at) FROM content_items
    WHERE source = 'discovered-article' AND title IS NOT NULL AND url ~ '^https?://'`;

export function linkHref(type: LinkType, id: string, url?: string | null): string {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case 'note': return `/think?noteId=${encoded}`;
    case 'spark': return `/think?view=sparks&sparkId=${encoded}`;
    case 'diagram': return `/think?mapId=${encoded}`;
    case 'project': return `/projects?projectId=${encoded}`;
    case 'task': return `/plan?taskId=${encoded}`;
    case 'usecase': return `/plan?view=use-cases&useCase=${encoded}`;
    case 'article': return url ?? `/discover?tab=saved`;
    case 'person': return `/people?personId=${encoded}`;
    case 'company': return `/companies?companyId=${encoded}`;
  }
}

export async function findLinkTargets(db: Pool, query: string, type?: LinkType, id?: string, exclude?: string): Promise<LinkTarget[]> {
  const literal = query.replace(/[\\%_]/g, '\\$&');
  const result = await db.query<TargetRow>(
    `WITH targets AS (${TARGETS}),
     matched AS (
       SELECT type,id,title,url,touched,
         ROW_NUMBER() OVER (PARTITION BY type ORDER BY
           CASE WHEN LOWER(title) = LOWER($3) THEN 0 WHEN title ILIKE $6 THEN 1 ELSE 2 END, touched DESC NULLS LAST, id) AS type_rank
       FROM targets
       WHERE ($1::text IS NULL OR type = $1) AND ($2::text IS NULL OR id = $2)
         AND ($3 = '' OR title ILIKE $4 OR (type='person' AND id IN
           (SELECT id::text FROM people WHERE concat_ws(' ',organisation,array_to_string(emails,' ')) ILIKE $4)))
         AND NOT (type = 'note' AND id = COALESCE($5, ''))
     )
     SELECT type,id,title,url FROM matched
     WHERE $1::text IS NOT NULL OR type_rank <= 4
     ORDER BY type_rank, CASE type WHEN 'note' THEN 0 WHEN 'project' THEN 1 WHEN 'spark' THEN 2 WHEN 'diagram' THEN 3 WHEN 'task' THEN 4 WHEN 'usecase' THEN 5 ELSE 6 END
     LIMIT 24`,
    [type ?? null, id ?? null, query, `%${literal}%`, exclude ?? null, `${literal}%`],
  );
  return result.rows.map(row => ({ type: row.type, id: row.id, title: row.title, href: linkHref(row.type, row.id, row.url) }));
}

const MAX_AUTOMATIC_LINKS = 8;
const MIN_DISTINCTIVE_TITLE_LENGTH = 5;

export async function suggestLinkTargets(db: Pool, writing: string, exclude?: string): Promise<LinkTarget[]> {
  const note = exclude ? (await db.query<{ content: string }>('SELECT content FROM notes WHERE id::text=$1', [exclude])).rows[0] : undefined;
  const automatic = note ? hasAutomaticNamedLinks(note.content) : false;
  const { rows } = await db.query<TargetRow & { title_count: string | number }>(
    `WITH targets AS (${TARGETS})
     SELECT type,id,title,url,COUNT(*) OVER (PARTITION BY lower(trim(title))) AS title_count FROM targets
     WHERE length(trim(title)) >= 2 AND strpos(lower($1), lower(trim(title))) > 0
       AND NOT (type='note' AND id=COALESCE($2,''))
     ORDER BY length(title) DESC, type, id LIMIT 100`, [writing, exclude ?? null]);
  return rows.filter(row => {
    const title = row.title.trim();
    if (!isDistinctiveLinkTitle(title) || (automatic ? Number(row.title_count) <= 1 : Number(row.title_count) !== 1)) return false;
    const escaped = row.title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(writing);
  }).slice(0, MAX_AUTOMATIC_LINKS).map(row => ({ type: row.type, id: row.id, title: row.title.trim(), href: linkHref(row.type, row.id, row.url),
    ...(automatic ? { requiresClarification: true } : {}) }));
}

function hasAutomaticNamedLinks(content: string): boolean {
  if (!content.trim().startsWith('{')) return false;
  const value: unknown = JSON.parse(content);
  return Boolean(value && typeof value === 'object' && 'automaticNamedLinks' in value && value.automaticNamedLinks === true);
}

/** Only plain inline writing is linked: existing links, code and embedded assets remain intact. */
export function applyNamedReferences(value: unknown, targets: LinkTarget[]): unknown {
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let run: Record<string, unknown>[] = [];
    const flush = (): void => {
      if (!run.length) return;
      const text = run.map(span => String(span['text'])).join('');
      const matches: { start: number; end: number; target: LinkTarget }[] = [];
      for (const target of [...targets].sort((a, b) => b.title.length - a.title.length)) {
        const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const match of text.matchAll(new RegExp(`\\[\\[${escaped}\\]\\]|(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'))) {
          const start = match.index;
          const end = start + match[0].length;
          if (!matches.some(other => start < other.end && end > other.start)) matches.push({ start, end, target });
        }
      }
      matches.sort((a, b) => a.start - b.start);
      const copy = (from: number, to: number): void => {
        let offset = 0;
        for (const span of run) {
          const writing = String(span['text']);
          const start = Math.max(0, from - offset);
          const end = Math.min(writing.length, to - offset);
          if (end > start) output.push({ ...span, text: writing.slice(start, end) });
          offset += writing.length;
        }
      };
      let cursor = 0;
      for (const match of matches) {
        copy(cursor, match.start);
        output.push(match.target.type === 'note'
          ? { type: 'noteMention', props: { noteId: match.target.id } }
          : { type: 'entityMention', props: { entityType: match.target.type, entityId: match.target.id } });
        cursor = match.end;
      }
      copy(cursor, text.length);
      run = [];
    };
    for (const item of value as unknown[]) {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string'
        && !('styles' in item && item.styles && typeof item.styles === 'object' && 'code' in item.styles && item.styles.code === true)) {
        run.push(item as Record<string, unknown>);
      } else { flush(); output.push(applyNamedReferences(item, targets)); }
    }
    flush();
    return output;
  }
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if (['codeBlock', 'link', 'noteMention', 'entityMention'].includes(String(item['type']))) return value;
  return Object.fromEntries(Object.entries(item).map(([key, child]) =>
    [key, ['content', 'children', 'rows', 'cells'].includes(key) ? applyNamedReferences(child, targets) : child]));
}

export async function linkNamedReferences(db: Pick<Pool, 'query'>, content: string, exclude?: string): Promise<string> {
  const { parseWriting } = await import('./noteVersionService.js');
  const writingContent = parseWriting(content);
  const outer: unknown = content.trim().startsWith('{') ? JSON.parse(content) as unknown : null;
  const wrapped = outer && typeof outer === 'object' && !Array.isArray(outer) ? outer as Record<string, unknown> : null;
  const blocks: unknown = JSON.parse(writingContent.contentJson) as unknown;
  if (!Array.isArray(blocks)) throw new ValidationError('Named-reference linking requires valid note blocks.');
  const writing = plainMentionText(blocks).join('\n');
  const { rows } = await db.query<TargetRow & { title_count: string | number }>(
    `WITH targets AS (${TARGETS})
     SELECT type,id,title,url,COUNT(*) OVER (PARTITION BY lower(trim(title))) AS title_count FROM targets
     WHERE length(trim(title)) >= 2 AND strpos(lower($1), lower(trim(title))) > 0
       AND NOT (type='note' AND id=COALESCE($2,''))`, [writing, exclude ?? null]);
  const targets = rows.filter(row => Number(row.title_count) === 1 && isDistinctiveLinkTitle(row.title))
    .map(row => ({ type: row.type, id: row.id, title: row.title.trim(), href: linkHref(row.type, row.id, row.url) }));
  return JSON.stringify({ ...writingContent, ...(wrapped ?? {}), automaticNamedLinks: true,
    contentJson: JSON.stringify(applyNamedReferences(blocks, targets)) });
}

const GENERIC_LINK_TITLES = new Set([
  'review', 'reviews', 'note', 'notes', 'new note', 'untitled', 'untitled note',
  'task', 'tasks', 'new task', 'meeting', 'meetings', 'project', 'projects',
  'summary', 'overview', 'update', 'updates', 'draft', 'test', 'testing',
  'plan', 'planning', 'research', 'spec', 'specification', 'description',
  'action', 'actions', 'follow up', 'follow-up', 'todo', 'to do', 'done', 'general',
  'status', 'progress', 'discussion', 'agenda', 'minutes', 'decision', 'decisions',
  'email', 'document', 'documents', 'specs',
]);

/** Manual linking remains unrestricted; unsolicited matches must be distinctive. */
export function isDistinctiveLinkTitle(title: string): boolean {
  const cleaned = title.trim().replace(/\s+/g, ' ');
  return !GENERIC_LINK_TITLES.has(cleaned.toLocaleLowerCase())
    && (cleaned.length >= MIN_DISTINCTIVE_TITLE_LENGTH || /^[A-Z][A-Z0-9]{2,}$/.test(cleaned));
}

export async function entityBacklinks(db: Pool, type: LinkType, id: string, offset: number): Promise<{ items: LinkTarget[]; hasMore: boolean }> {
  if (type === 'note') return noteBacklinks(db, id, offset);
  if (!(await findLinkTargets(db, '', type, id)).length) throw new NotFoundError('Linked item not found');
  const { rows } = await db.query<{ id: string; title: string }>(
    `SELECT n.id,note_list_metadata(n.content)->>'title' AS title FROM notes n
     WHERE n.status='active' AND jsonb_path_exists(note_link_document(n.content),
       'lax $.** ? (@.type == "entityMention" && @.props.entityType == $type && @.props.entityId == $id)',
       jsonb_build_object('type',$1::text,'id',$2::text))
     ORDER BY n.updated_at DESC,n.id LIMIT 21 OFFSET $3`, [type, id, offset]);
  return { items: rows.slice(0, BACKLINK_PAGE_SIZE).map(row => ({ type: 'note', ...row, href: linkHref('note', row.id) })),
    hasMore: rows.length > BACKLINK_PAGE_SIZE };
}

function plainMentionText(value: unknown): string[] {
  if (Array.isArray(value)) {
    const runs: string[] = [];
    let text = '';
    for (const item of value as unknown[]) {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string'
        && !('styles' in item && item.styles && typeof item.styles === 'object' && 'code' in item.styles && item.styles.code === true)) {
        text += item.text;
      } else {
        if (text) { runs.push(text); text = ''; }
        runs.push(...plainMentionText(item));
      }
    }
    if (text) runs.push(text);
    return runs;
  }
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (['codeBlock', 'link', 'noteMention', 'entityMention'].includes(String(item['type']))) return [];
  return [...plainMentionText(item['content']), ...plainMentionText(item['children']), ...plainMentionText(item['rows']), ...plainMentionText(item['cells'])];
}

export async function unlinkedNoteMentions(db: Pool, id: string, offset: number): Promise<{ items: LinkTarget[]; hasMore: boolean }> {
  const target = (await findLinkTargets(db, '', 'note', id))[0];
  if (!target) throw new NotFoundError('Note not found');
  const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
  const { rows } = await db.query<{ id: string; title: string; content: string }>(
    `SELECT n.id,note_list_metadata(n.content)->>'title' AS title,n.content FROM notes n
     WHERE n.status='active' AND n.id<>$1
       AND NOT EXISTS(SELECT 1 FROM note_links l WHERE l.source_note_id=n.id AND l.target_note_id=$1)
     ORDER BY n.updated_at DESC,n.id`, [id]);
  const matches = rows.filter(row => plainMentionText(parseNoteContent(row.content).blocks).some(run => pattern.test(run)));
  return { items: matches.slice(offset, offset + BACKLINK_PAGE_SIZE).map(row => ({ type: 'note', id: row.id, title: row.title, href: linkHref('note', row.id) })),
    hasMore: matches.length > offset + BACKLINK_PAGE_SIZE };
}

export interface LinkPreview { summary: string; details: { label: string; value: string }[] }
const PREVIEW_QUERIES: Record<Exclude<LinkType, 'note'>, string> = {
  spark: "SELECT body AS summary, to_char(created_at,'YYYY-MM-DD') AS d1 FROM sparks WHERE id::text=$1",
  diagram: "SELECT description AS summary, to_char(updated_at,'YYYY-MM-DD') AS d1 FROM canvases WHERE id::text=$1 AND deleted_at IS NULL",
  project: "SELECT concat_ws(E'\\n\\n', description, 'Goal: ' || NULLIF(goal,'')) AS summary, lifecycle_state AS d1, category AS d2, priority::text AS d3 FROM projects WHERE id=$1",
  task: "SELECT body AS summary, status AS d1, priority::text AS d2, due_date::text AS d3 FROM tasks WHERE id::text=$1",
  usecase: "SELECT summary, stage AS d1, product_kind AS d2 FROM use_cases WHERE id::text=$1",
  article: "SELECT COALESCE(NULLIF(summary,''), LEFT(body, 1200)) AS summary, to_char(published_at,'YYYY-MM-DD') AS d1, url AS d2 FROM content_items WHERE id::text=$1",
  person: "SELECT concat_ws(E'\\n\\n',NULLIF(threads,''),NULLIF(notes,'')) AS summary, organisation AS d1,role AS d2,array_to_string(emails,', ') AS d3 FROM people WHERE id::text=$1",
  company: "SELECT description AS summary,website AS d1 FROM companies WHERE id::text=$1",
};
const PREVIEW_LABELS: Record<Exclude<LinkType, 'note'>, string[]> = {
  spark: ['Created'], diagram: ['Updated'], project: ['Stage', 'Category', 'Priority'], task: ['Status', 'Priority', 'Due'],
  usecase: ['Stage', 'Kind'], article: ['Published', 'Source'],
  person: ['Organisation', 'Role / relationship', 'Email'],
  company: ['Website'],
};
const MAX_SUMMARY = 1500;

export async function linkPreview(db: Pool, type: Exclude<LinkType, 'note'>, id: string): Promise<LinkPreview> {
  const result = await db.query<Record<string, string | null>>(PREVIEW_QUERIES[type], [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Linked item not found');
  const details = PREVIEW_LABELS[type].flatMap((label, index) => {
    const value = row[`d${index + 1}`];
    return value ? [{ label, value }] : [];
  });
  return { summary: (row['summary'] ?? '').trim().slice(0, MAX_SUMMARY), details };
}

export async function noteBacklinks(db: Pool, id: string, offset: number): Promise<{ items: LinkTarget[]; hasMore: boolean }> {
  const existing = await db.query("SELECT id FROM notes WHERE id=$1 AND status='active'", [id]);
  if (!existing.rows[0]) throw new NotFoundError('Note not found or archived');
  const result = await db.query<{ id: string; title: string }>(
    `SELECT n.id, note_list_metadata(n.content)->>'title' AS title FROM note_links l
     JOIN notes n ON n.id=l.source_note_id WHERE l.target_note_id=$1 AND n.status='active'
     ORDER BY n.updated_at DESC, n.id LIMIT 21 OFFSET $2`, [id, offset]);
  return { items: result.rows.slice(0, BACKLINK_PAGE_SIZE).map(row => ({ type: 'note', ...row, href: linkHref('note', row.id) })), hasMore: result.rows.length > BACKLINK_PAGE_SIZE };
}

/** Resolve ID references before exports/indexing; never trust a persisted display title. */
export async function resolveNoteLinks(db: Pool, content: string): Promise<unknown[]> {
  const { blocks } = parseNoteContent(content);
  const refs = new Map<string, Promise<LinkTarget | undefined>>();
  async function walk(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value === null || typeof value !== 'object') return value;
    const item = value as Record<string, unknown>;
    if (item['type'] === 'noteMention' || item['type'] === 'entityMention') {
      const props = item['props'] as Record<string, unknown> | undefined;
      const type = item['type'] === 'noteMention' ? 'note' : props?.['entityType'];
      const id = item['type'] === 'noteMention' ? props?.['noteId'] : props?.['entityId'];
      if (typeof type !== 'string' || !LINK_TYPES.some(t => t === type) || typeof id !== 'string') {
        return { type: 'text', text: 'Unavailable link', styles: {} };
      }
      const key = `${type}:${id}`;
      if (!refs.has(key)) refs.set(key, findLinkTargets(db, '', type as LinkType, id).then(targets => targets[0]));
      const target = await refs.get(key);
      return target ? { type: 'link', href: target.href, content: [{ type: 'text', text: target.title, styles: {} }] }
        : { type: 'text', text: `Unavailable ${type}`, styles: {} };
    }
    const entries = await Promise.all(Object.entries(item).map(async ([key, child]): Promise<[string, unknown]> => [key, await walk(child)]));
    const resolved: Record<string, unknown> = Object.fromEntries(entries);
    return resolved;
  }
  return await walk(blocks) as unknown[];
}
