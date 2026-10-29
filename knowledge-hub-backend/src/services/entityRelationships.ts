import { getDb } from '../db/db.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { findLinkTargets, linkHref } from './noteLinks.js';
import { getDiagram } from './diagramService.js';
import { linkNote, unlinkNote, linkElementNote, unlinkElementNote } from './canvasService.js';

export type RelationshipType = 'note' | 'diagram' | 'task';
export interface RelationshipScope { type: RelationshipType; id: string; elementId?: string }
export interface Relationship {
  key: string;
  type: string;
  id: string;
  title: string;
  href: string;
  elementId: string;
  elementTitle: string;
}
const MAX_RELATIONSHIP_ID_LENGTH = 200;

// Keep existing task and diagram links authoritative; don't copy or migrate them.
const LINKS = `
  SELECT 'manual:'||id::text AS key, a_type, a_id, a_element, b_type, b_id, b_element,
    ''::text AS title, ''::text AS href FROM entity_manual_links
  UNION ALL SELECT 'task:'||id, 'task', task_id::text, '',
    CASE WHEN target_type='canvas' THEN 'diagram' ELSE target_type END, target_id, '', target_title, COALESCE(target_url,'') FROM task_links
  UNION ALL SELECT 'canvas:'||canvas_id||':'||note_id, 'diagram', canvas_id::text, '', 'note', note_id::text, '', '', '' FROM canvas_notes
  UNION ALL SELECT 'element:'||canvas_id||':'||element_id||':'||note_id,
    'diagram', canvas_id::text, element_id::text, 'note', note_id::text, '', '', '' FROM diagram_element_notes`;
const TITLES = `
  SELECT 'note'::text AS type,id::text,note_list_metadata(content)->>'title' AS title
    FROM notes WHERE status='active'
  UNION ALL SELECT 'diagram',id::text,title FROM canvases WHERE deleted_at IS NULL AND canvas_type='diagram'
  UNION ALL SELECT 'task',id::text,title FROM tasks`;

export function relationshipScope(type: unknown, id: unknown, elementId?: unknown): RelationshipScope {
  if (type !== 'note' && type !== 'diagram' && type !== 'task') throw new ValidationError('Invalid relationship type');
  if (typeof id !== 'string' || !id || id.length > MAX_RELATIONSHIP_ID_LENGTH) throw new ValidationError('Invalid relationship id');
  if (elementId !== undefined && (type !== 'diagram' || typeof elementId !== 'string'
    || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(elementId))) {
    throw new ValidationError('Invalid diagram element');
  }
  return { type, id, ...(elementId === undefined ? {} : { elementId }) };
}

async function requireScope(scope: RelationshipScope, checkElement = true): Promise<string> {
  const target = (await findLinkTargets(getDb(), '', scope.type, scope.id))[0];
  if (!target) throw new NotFoundError('Linked item');
  if (scope.elementId && checkElement) {
    const { document } = await getDiagram(scope.id);
    if (![...document.nodes, ...document.edges, ...(document.footnotes ?? [])].some(item => item.id === scope.elementId)) {
      throw new NotFoundError('Diagram element');
    }
  }
  return target.title;
}

export async function listRelationships(scope: RelationshipScope): Promise<Relationship[]> {
  await requireScope(scope, false);
  const { rows } = await getDb().query<Relationship>(
    `WITH links AS (${LINKS}), targets AS (${TITLES}), related AS (
      SELECT key,
        CASE WHEN a_type=$1 AND a_id=$2 AND a_element=$3 THEN b_type ELSE a_type END AS type,
        CASE WHEN a_type=$1 AND a_id=$2 AND a_element=$3 THEN b_id ELSE a_id END AS id,
        CASE WHEN a_type=$1 AND a_id=$2 AND a_element=$3 THEN b_element ELSE a_element END AS element,
        CASE WHEN a_type=$1 AND a_id=$2 AND a_element=$3 THEN title ELSE '' END AS fallback_title,
        CASE WHEN a_type=$1 AND a_id=$2 AND a_element=$3 THEN href ELSE '' END AS href
      FROM links WHERE (a_type=$1 AND a_id=$2 AND a_element=$3) OR (b_type=$1 AND b_id=$2 AND b_element=$3)
    )
    SELECT r.key,r.type,r.id,COALESCE(NULLIF(t.title,''),NULLIF(r.fallback_title,''),r.id) AS title,
      r.href,r.element AS "elementId",
      CASE WHEN r.element='' THEN '' ELSE COALESCE(NULLIF(el.value->>'label',''),NULLIF(el.value->>'text',''),'Diagram element') END AS "elementTitle"
    FROM related r LEFT JOIN targets t ON t.type=r.type AND t.id=r.id
    LEFT JOIN LATERAL (
      SELECT value FROM canvas_diagrams cd CROSS JOIN LATERAL
        jsonb_array_elements(COALESCE(cd.document->'nodes','[]') || COALESCE(cd.document->'edges','[]') || COALESCE(cd.document->'footnotes','[]'))
      WHERE r.type='diagram' AND cd.canvas_id::text=r.id AND value->>'id'=r.element LIMIT 1
    ) el ON r.element<>''
    WHERE (r.type NOT IN ('note','diagram','task') OR t.id IS NOT NULL)
      AND (r.element='' OR el.value IS NOT NULL)
    ORDER BY title,r.key`, [scope.type, scope.id, scope.elementId ?? '']);
  return rows.map(row => ({
    ...row,
    href: row.type === 'note' || row.type === 'diagram' || row.type === 'task' ? linkHref(row.type, row.id)
      : row.type === 'chat' ? `/chat?session=${encodeURIComponent(row.id)}`
        : /^(https?:\/\/|\/(?!\/))/.test(row.href) ? row.href : '',
  }));
}

export async function addRelationship(source: RelationshipScope, target: RelationshipScope): Promise<void> {
  const [sourceTitle, targetTitle] = await Promise.all([requireScope(source), requireScope(target)]);
  if (source.type === target.type && source.id === target.id) throw new ValidationError('An item cannot link to itself');
  const existing = await listRelationships(source);
  if (existing.some(row => row.type === target.type && row.id === target.id && row.elementId === (target.elementId ?? ''))) return;
  const diagram = source.type === 'diagram' ? source : target.type === 'diagram' ? target : undefined;
  const note = source.type === 'note' ? source : target.type === 'note' ? target : undefined;
  if (diagram && note) {
    if (diagram.elementId) await linkElementNote(diagram.id, diagram.elementId, note.id);
    else await linkNote(diagram.id, note.id);
    return;
  }
  const task = source.type === 'task' ? source : target.type === 'task' ? target : undefined;
  const other = task === source ? target : source;
  if (task && other.type !== 'task' && !other.elementId) {
    await getDb().query(
      `INSERT INTO task_links (task_id,target_type,target_id,target_title,target_url)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [task.id, other.type, other.id, other === source ? sourceTitle : targetTitle, linkHref(other.type, other.id)]);
    return;
  }
  const endpoints = [source, target].sort((a, b) => {
    const left = [a.type, a.id, a.elementId ?? ''].join('\0');
    const right = [b.type, b.id, b.elementId ?? ''].join('\0');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const a = endpoints[0]!;
  const b = endpoints[1]!;
  await getDb().query(
    `INSERT INTO entity_manual_links (a_type,a_id,a_element,b_type,b_id,b_element)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [a.type, a.id, a.elementId ?? '', b.type, b.id, b.elementId ?? '']);
}

export async function removeRelationship(scope: RelationshipScope, key: string): Promise<void> {
  const link = (await listRelationships(scope)).find(row => row.key === key);
  if (!link) throw new NotFoundError('Link');
  const [kind, id, elementOrNote, noteId] = key.split(':');
  if (kind === 'manual') await getDb().query('DELETE FROM entity_manual_links WHERE id=$1', [id]);
  else if (kind === 'task') await getDb().query('DELETE FROM task_links WHERE id=$1', [id]);
  else if (kind === 'canvas') await unlinkNote(id!, elementOrNote!);
  else if (kind === 'element') await unlinkElementNote(id!, elementOrNote!, noteId!);
}
