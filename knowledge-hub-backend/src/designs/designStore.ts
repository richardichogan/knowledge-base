import type { Pool } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { getUseCase, type UseCaseDetail } from '../useCases/useCaseStore.js';
import { parseNoteContent } from '../utils/noteContent.js';

export const DESIGN_ROLES = ['use_case', 'spec', 'architecture', 'diagram', 'reference'] as const;
export const DESIGN_STATUSES = ['draft', 'in_review', 'ready', 'archived'] as const;
export type DesignRole = typeof DESIGN_ROLES[number];
export type AssetType = 'note' | 'canvas' | 'usecase' | 'link';
export interface Design {
  id: string; parentNoteId: string; title: string; summary: string; projectId: string | null; sourceUseCaseId: string | null; sourceNoteId: string | null;
  status: typeof DESIGN_STATUSES[number]; revision: number; mapped: boolean; updatedAt: string;
}
export interface DesignAsset {
  sourceType: AssetType; sourceId: string; title: string; role: DesignRole; href: string;
  origin: 'explicit' | 'manual'; available: boolean;
}
export interface DesignDetail extends Design { assets: DesignAsset[]; selections: Partial<Record<DesignRole, string>> }
interface Row {
  id: string; parent_note_id: string; title: string; summary: string; project_id: string | null; source_use_case_id: string | null; source_note_id: string | null;
  status: Design['status']; revision: number; mapped: boolean; updated_at: Date;
}
const view = (row: Row): Design => ({
  id: row.id, parentNoteId: row.parent_note_id, title: row.title, summary: row.summary, projectId: row.project_id, sourceUseCaseId: row.source_use_case_id, sourceNoteId: row.source_note_id,
  status: row.status, revision: row.revision, mapped: row.mapped, updatedAt: row.updated_at.toISOString(),
});
const ALL_DESIGNS = `
  SELECT d.id,d.parent_note_id,note_list_metadata(n.content)->>'title' AS title,d.summary,n.project_id,
    d.source_use_case_id,d.source_note_id,d.status,d.revision,false AS mapped,n.updated_at
  FROM designs d JOIN notes n ON n.id=d.parent_note_id
  WHERE n.status='active' AND note_list_metadata(n.content)->>'contentType'='design'`;
const MAX_ASSETS = 200;
const MAX_DESIGNS = 500;
const MAX_LINK_LENGTH = 2048;
const MAX_ASSET_ID_LENGTH = 100;

/** Effective original-note membership, including inherited links and manual exclusions. */
export const DESIGN_NOTE_MEMBERSHIPS_SQL = `
  SELECT DISTINCT d.parent_note_id,candidate.note_id
  FROM designs d
  JOIN notes parent ON parent.id=d.parent_note_id AND parent.status='active'
    AND note_list_metadata(parent.content)->>'contentType'='design'
  CROSS JOIN LATERAL (
    SELECT d.source_note_id::text AS note_id
    UNION SELECT l.target_note_id::text FROM note_links l WHERE l.source_note_id=d.source_note_id
    UNION SELECT u.spec_note_id::text FROM use_cases u WHERE u.id=d.source_use_case_id
    UNION SELECT s.source_id::text FROM use_case_sources s WHERE s.use_case_id=d.source_use_case_id AND s.source_type='note'
    UNION SELECT a.source_id FROM design_assets a WHERE a.design_id=d.id AND a.source_type='note' AND NOT a.excluded
  ) candidate
  LEFT JOIN design_assets override ON override.design_id=d.id AND override.source_type='note'
    AND override.source_id=candidate.note_id
  WHERE candidate.note_id IS NOT NULL AND candidate.note_id<>d.parent_note_id::text
    AND NOT COALESCE(override.excluded,false)`;

export function requiredText(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new ValidationError(`${field} must contain ${empty ? '0' : '1'}-${max} characters.`);
  return value.trim();
}
export function assetRole(type: string | null): DesignRole {
  return type === 'spec' ? 'spec' : type === 'architecture' ? 'architecture' : type === 'use-case' ? 'use_case' : 'reference';
}
export function parseAsset(input: Record<string, unknown>): { sourceType: AssetType; sourceId: string; role: DesignRole } {
  const { sourceType, role } = input;
  if (sourceType !== 'note' && sourceType !== 'canvas' && sourceType !== 'usecase' && sourceType !== 'link') throw new ValidationError('Choose a note, diagram, use case or reference link.');
  if (!DESIGN_ROLES.some(value => value === role)) throw new ValidationError('Choose a valid Design section.');
  if ((sourceType === 'canvas' && role !== 'diagram') || (sourceType === 'usecase' && role !== 'use_case')
    || (sourceType === 'link' && role !== 'reference') || (sourceType === 'note' && role === 'diagram')) {
    throw new ValidationError('This asset type does not belong in that section.');
  }
  const sourceId = requiredText(input['sourceId'], 'Asset', sourceType === 'link' ? MAX_LINK_LENGTH : MAX_ASSET_ID_LENGTH);
  if (sourceType === 'link') {
    let url: URL;
    try { url = new URL(sourceId); } catch { throw new ValidationError('Choose a valid HTTP(S) reference URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ValidationError('Reference URLs must use HTTP(S) without credentials.');
  }
  return { sourceType, sourceId, role: role as DesignRole };
}

export async function listDesigns(db: Pool): Promise<{ items: Design[]; hasMore: boolean }> {
  const { rows } = await db.query<Row>(`SELECT * FROM (${ALL_DESIGNS}) d ORDER BY updated_at DESC,id LIMIT $1`, [MAX_DESIGNS + 1]);
  return { items: rows.slice(0, MAX_DESIGNS).map(view), hasMore: rows.length > MAX_DESIGNS };
}
async function parent(db: Pool, id: string): Promise<Design> {
  const { rows } = await db.query<Row>(`SELECT * FROM (${ALL_DESIGNS}) d WHERE id::text=$1 OR parent_note_id::text=$1 OR source_note_id::text=$1`, [id]);
  if (!rows[0]) throw new NotFoundError('Design');
  return view(rows[0]);
}
async function resolveAsset(db: Pool, sourceType: AssetType, sourceId: string, role: DesignRole, origin: DesignAsset['origin']): Promise<DesignAsset> {
  const base = { sourceType, sourceId, role, origin };
  if (sourceType === 'link') return { ...base, title: sourceId, href: sourceId, available: true };
  if (sourceType === 'note') {
    const { rows } = await db.query<{ content: string }>("SELECT content FROM notes WHERE id::text=$1 AND status='active'", [sourceId]);
    return { ...base, title: rows[0] ? parseNoteContent(rows[0].content).title ?? 'Untitled note' : 'Unavailable note',
      href: `/think?noteId=${encodeURIComponent(sourceId)}`, available: !!rows[0] };
  }
  if (sourceType === 'canvas') {
    const { rows } = await db.query<{ title: string }>("SELECT title FROM canvases WHERE id::text=$1 AND canvas_type='diagram' AND deleted_at IS NULL", [sourceId]);
    return { ...base, title: rows[0]?.title ?? 'Unavailable diagram', href: `/think?mapId=${encodeURIComponent(sourceId)}`, available: !!rows[0] };
  }
  const { rows } = await db.query<{ title: string }>('SELECT title FROM use_cases WHERE id::text=$1', [sourceId]);
  return { ...base, title: rows[0]?.title ?? 'Unavailable use case', href: `/plan?view=use-cases&useCase=${encodeURIComponent(sourceId)}`, available: !!rows[0] };
}
async function explicitAssets(db: Pool, uc: UseCaseDetail): Promise<DesignAsset[]> {
  const assets: DesignAsset[] = [await resolveAsset(db, 'usecase', uc.id, 'use_case', 'explicit')];
  if (uc.specNoteId) assets.push(await resolveAsset(db, 'note', uc.specNoteId, 'spec', 'explicit'));
  const notes = uc.sources.filter(source => source.sourceType === 'note' && source.sourceId !== uc.specNoteId);
  if (notes.length) {
    const { rows } = await db.query<{ id: string; content: string }>("SELECT id::text,content FROM notes WHERE id::text=ANY($1::text[]) AND status='active'", [notes.map(source => source.sourceId)]);
    for (const source of notes) assets.push(await resolveAsset(db, 'note', source.sourceId,
      assetRole(parseNoteContent(rows.find(row => row.id === source.sourceId)?.content ?? '').contentType), 'explicit'));
  }
  const canvases = uc.sources.filter(source => source.sourceType === 'canvas');
  if (canvases.length) {
    const { rows } = await db.query<{ id: string }>("SELECT id::text FROM canvases WHERE id::text=ANY($1::text[]) AND canvas_type='diagram' AND deleted_at IS NULL", [canvases.map(source => source.sourceId)]);
    for (const row of rows) assets.push(await resolveAsset(db, 'canvas', row.id, 'diagram', 'explicit'));
  }
  for (const link of uc.links) assets.push({ sourceType: 'link', sourceId: link.url, title: link.title, role: 'reference', href: link.url, origin: 'explicit', available: true });
  return assets;
}
export async function getDesign(db: Pool, id: string): Promise<DesignDetail> {
  const design = await parent(db, id);
  id = design.id;
  const assets = new Map<string, DesignAsset>();
  if (design.sourceUseCaseId) {
    for (const asset of await explicitAssets(db, await getUseCase(db, design.sourceUseCaseId))) assets.set(`${asset.sourceType}:${asset.sourceId}`, asset);
  }
  if (design.sourceNoteId) {
    const source = await db.query<{ content: string }>('SELECT content FROM notes WHERE id::text=$1', [design.sourceNoteId]);
    const root = await resolveAsset(db, 'note', design.sourceNoteId,
      assetRole(parseNoteContent(source.rows[0]?.content ?? '').contentType), 'explicit');
    assets.set(`note:${design.sourceNoteId}`, root);
    const { rows: references } = await db.query<{ source_type: 'note' | 'canvas'; source_id: string; content_type: string | null }>(`
      SELECT 'note' AS source_type,l.target_note_id::text AS source_id,note_list_metadata(n.content)->>'contentType' AS content_type
      FROM note_links l JOIN notes n ON n.id=l.target_note_id WHERE l.source_note_id::text=$1
      UNION ALL
      SELECT 'canvas',target_id,NULL FROM note_entity_links WHERE source_note_id::text=$1 AND target_type='diagram'`, [design.sourceNoteId]);
    for (const ref of references) {
      if (ref.source_id === design.sourceNoteId) continue;
      assets.set(`${ref.source_type}:${ref.source_id}`, await resolveAsset(db, ref.source_type, ref.source_id,
        ref.source_type === 'canvas' ? 'diagram' : assetRole(ref.content_type), 'explicit'));
    }
  }
  const { rows } = await db.query<{ source_type: AssetType; source_id: string; role: DesignRole; excluded: boolean }>('SELECT source_type,source_id,role,excluded FROM design_assets WHERE design_id::text=$1 ORDER BY added_at', [id]);
  for (const row of rows) {
    const key = `${row.source_type}:${row.source_id}`;
    if (row.excluded) assets.delete(key);
    else assets.set(key, await resolveAsset(db, row.source_type, row.source_id, row.role, 'manual'));
  }
  const noteIds = [...assets.values()].filter(asset => asset.sourceType === 'note').map(asset => asset.sourceId);
  if (noteIds.length) {
    const diagrams = await db.query<{ id: string }>(`SELECT c.id::text FROM canvases c WHERE c.canvas_type='diagram' AND c.deleted_at IS NULL
      AND (EXISTS(SELECT 1 FROM canvas_notes cn WHERE cn.canvas_id=c.id AND cn.note_id=ANY($1::text[]))
        OR EXISTS(SELECT 1 FROM diagram_element_notes en WHERE en.canvas_id=c.id AND en.note_id=ANY($1::text[])))`, [noteIds]);
    for (const row of diagrams.rows) {
      if (!assets.has(`canvas:${row.id}`)) assets.set(`canvas:${row.id}`, await resolveAsset(db, 'canvas', row.id, 'diagram', 'explicit'));
    }
  }
  for (const row of rows) {
    if (row.excluded) assets.delete(`${row.source_type}:${row.source_id}`);
  }
  const selection = await db.query<{ selections: DesignDetail['selections'] }>('SELECT selections FROM designs WHERE id=$1', [design.id]);
  return { ...design, assets: [...assets.values()], selections: selection.rows[0]!.selections };
}
export async function selectDesignAsset(db: Pool, id: string, input: Record<string, unknown>): Promise<DesignDetail> {
  const design = await getDesign(db, id);
  const role = input['role'];
  const sourceId = input['sourceId'];
  if (!design.assets.some(asset => asset.role === role && asset.sourceId === sourceId && asset.available)) throw new ValidationError('Choose an available linked asset.');
  const result = await db.query(`UPDATE designs SET selections=jsonb_set(selections,ARRAY[$2::text],to_jsonb($3::text)),
    revision=revision+1,updated_at=NOW() WHERE id=$1 AND revision=$4 RETURNING id`,
  [design.id, role, sourceId, input['expectedRevision']]);
  if (!result.rows.length) throw new ConflictError('Design links changed. Reload before selecting a version.', 'DESIGN_CONFLICT');
  return getDesign(db, design.id);
}
export async function attachAsset(db: Pool, id: string, input: Record<string, unknown>): Promise<DesignDetail> {
  const design = await getDesign(db, id);
  id = design.id;
  const asset = parseAsset(input);
  if (asset.sourceType === 'note' && asset.sourceId === design.parentNoteId) throw new ValidationError('The Design parent cannot link itself as a child document.');
  const existing = design.assets.some(value => value.sourceType === asset.sourceType && value.sourceId === asset.sourceId);
  if (!existing && design.assets.length >= MAX_ASSETS) throw new ValidationError('A Design supports up to 200 linked assets.');
  if (!(await resolveAsset(db, asset.sourceType, asset.sourceId, asset.role, 'manual')).available) throw new NotFoundError('Asset not found or archived');
  await saveAsset(db, id, asset, false);
  return getDesign(db, id);
}
export async function detachAsset(db: Pool, id: string, input: Record<string, unknown>): Promise<DesignDetail> {
  const design = await getDesign(db, id);
  id = design.id;
  const asset = design.assets.find(value => value.sourceType === input['sourceType'] && value.sourceId === input['sourceId']);
  if (!asset) throw new NotFoundError('Design asset');
  if (asset.sourceType === 'usecase' && asset.sourceId === design.sourceUseCaseId) throw new ValidationError('The original use case remains linked to its mapped Design.');
  if (asset.sourceType === 'note' && asset.sourceId === design.sourceNoteId) throw new ValidationError('The original source note remains linked to its mapped Design.');
  await saveAsset(db, id, asset, true);
  return getDesign(db, id);
}
async function saveAsset(db: Pool, id: string, asset: Pick<DesignAsset, 'sourceType' | 'sourceId' | 'role'>, excluded: boolean): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM designs WHERE id=$1 FOR UPDATE', [id]);
    await client.query(`INSERT INTO design_assets(design_id,source_type,source_id,role,excluded) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(design_id,source_type,source_id) DO UPDATE SET role=EXCLUDED.role,excluded=EXCLUDED.excluded`,
    [id, asset.sourceType, asset.sourceId, asset.role, excluded]);
    await client.query('UPDATE designs SET updated_at=NOW(),revision=revision+1 WHERE id=$1', [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function assetDesigns(db: Pool, sourceType: 'note' | 'canvas', sourceId: string): Promise<Array<{ id: string; parentNoteId: string; title: string; role: DesignRole }>> {
  const list = await listDesigns(db);
  if (list.hasMore) throw new ValidationError('Design membership exceeds the supported lookup size. Narrow the Design collection before continuing.');
  const matches = [];
  for (const item of list.items) {
    const design = await getDesign(db, item.id);
    const asset = design.assets.find(value => value.sourceType === sourceType && value.sourceId === sourceId);
    if (asset) matches.push({ id: design.id, parentNoteId: design.parentNoteId, title: design.title, role: asset.role });
  }
  return matches;
}

export async function searchAssets(db: Pool, query: string, sourceType?: 'note' | 'canvas'): Promise<DesignAsset[]> {
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const { rows } = await db.query<{ source_type: AssetType; source_id: string; title: string; content_type: string | null }>(`
    SELECT * FROM (
      SELECT 'note' AS source_type,id::text AS source_id,note_list_metadata(content)->>'title' AS title,
        note_list_metadata(content)->>'contentType' AS content_type,updated_at FROM notes WHERE status='active'
      UNION ALL SELECT 'canvas',id::text,title,'diagram',updated_at FROM canvases WHERE canvas_type='diagram' AND deleted_at IS NULL
      UNION ALL SELECT 'usecase',id::text,title,'use-case',updated_at FROM use_cases
    ) a WHERE title ILIKE $1 AND ($2::text IS NULL OR source_type=$2)
      ORDER BY updated_at DESC,source_id LIMIT 30`, [`%${escaped}%`, sourceType ?? null]);
  return rows.map(row => ({
    sourceType: row.source_type, sourceId: row.source_id, title: row.title,
    role: row.source_type === 'canvas' ? 'diagram' : assetRole(row.content_type),
    href: row.source_type === 'canvas' ? `/think?mapId=${encodeURIComponent(row.source_id)}`
      : row.source_type === 'usecase' ? `/plan?view=use-cases&useCase=${encodeURIComponent(row.source_id)}` : `/think?noteId=${encodeURIComponent(row.source_id)}`,
    origin: 'manual', available: true,
  }));
}
