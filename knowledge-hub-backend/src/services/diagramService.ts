/**
 * services/diagramService.ts
 * Storage for diagram canvases (canvases.canvas_type = 'diagram').
 *
 * Tables (migration 055):
 *  - canvas_diagrams: current document + revision (one row per diagram canvas).
 *  - canvas_diagram_revisions: the last KEEP_REVISIONS saved documents.
 *  - canvas_diagram_assets: validated PNG / SVG bytes (BYTEA, <= 5 MiB each).
 *
 * Assets are stored in Postgres rather than Azure Blob Storage: the existing
 * private blob containers each belong to another feature (chat screens, chat
 * files, documents) and a new container would be created at runtime, which is a
 * cloud-side change. In Postgres the bytes are private, saved in the same
 * transaction that checks the canvas, and deleted with the canvas (ON DELETE
 * CASCADE), with no new production configuration.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDb } from '../db/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { emptyDiagram, type CanvasType, type DiagramAsset, type DiagramDocument, type DiagramSnapshot } from '../types/diagram.js';
import {
  DIAGRAM_LIMITS, validateAssetName, validateAssetUpload, validateDiagramDocument, validateRevision,
} from './diagramValidation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEEP_REVISIONS = 50;
const DRILLDOWN_TITLE_MAX = 200;

export function canvasTypeMismatch(actual: CanvasType): ConflictError {
  return new ConflictError(
    actual === 'diagram'
      ? 'This canvas is a diagram; this action only applies to brainstorm canvases'
      : 'This canvas is a brainstorm; this action only applies to diagram canvases',
    'CANVAS_TYPE_MISMATCH',
    { canvasType: actual },
  );
}

async function lockCanvasType(db: Pool | PoolClient, id: string, forUpdate: boolean): Promise<CanvasType | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<{ canvas_type: CanvasType }>(
    `SELECT canvas_type FROM canvases WHERE id = $1 AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0]?.canvas_type ?? null;
}

export async function getCanvasType(id: string): Promise<CanvasType | null> {
  return lockCanvasType(getDb(), id, false);
}

/** Throws 404 when the canvas doesn't exist, 409 CANVAS_TYPE_MISMATCH when it's the other type. */
export async function requireCanvasType(id: string, expected: CanvasType, db: Pool | PoolClient = getDb(), forUpdate = false): Promise<void> {
  const actual = await lockCanvasType(db, id, forUpdate);
  if (actual === null) throw new NotFoundError('Canvas');
  if (actual !== expected) throw canvasTypeMismatch(actual);
}

/** Creates the revision-0 document for a new diagram canvas (inside the caller's transaction); empty unless `initial` is given. */
export async function initDiagram(client: PoolClient, canvasId: string, initial: DiagramDocument = emptyDiagram()): Promise<void> {
  const doc = JSON.stringify(initial);
  await client.query(
    `INSERT INTO canvas_diagrams (canvas_id, revision, document) VALUES ($1, 0, $2) ON CONFLICT (canvas_id) DO NOTHING`,
    [canvasId, doc]);
  await client.query(
    `INSERT INTO canvas_diagram_revisions (canvas_id, revision, document) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING`,
    [canvasId, doc]);
}

export async function getDiagram(canvasId: string): Promise<DiagramSnapshot> {
  const db = getDb();
  await requireCanvasType(canvasId, 'diagram', db);
  const read = async (): Promise<DiagramSnapshot | null> => {
    const r = await db.query<{ revision: number; document: DiagramDocument }>(
      `SELECT revision, document FROM canvas_diagrams WHERE canvas_id = $1`, [canvasId]);
    const row = r.rows[0];
    return row === undefined ? null : { revision: row.revision, document: row.document };
  };
  const existing = await read();
  if (existing !== null) return existing;
  await db.query(
    `INSERT INTO canvas_diagrams (canvas_id, revision, document) VALUES ($1, 0, $2) ON CONFLICT (canvas_id) DO NOTHING`,
    [canvasId, JSON.stringify(emptyDiagram())]);
  const initialized = await read();
  if (initialized === null) throw new NotFoundError('Diagram');
  return initialized;
}

export interface DiagramDrilldown { nodeId: string; canvasId: string; title: string }

export async function listDrilldowns(canvasId: string): Promise<DiagramDrilldown[]> {
  const db = getDb();
  await requireCanvasType(canvasId, 'diagram', db);
  const r = await db.query<DiagramDrilldown>(
    `SELECT d.node_id AS "nodeId", c.id AS "canvasId", c.title
     FROM diagram_drilldowns d JOIN canvases c ON c.id = d.child_canvas_id
     WHERE d.canvas_id = $1 AND c.deleted_at IS NULL`, [canvasId]);
  return r.rows;
}

/** Creation and association are atomic; the parent lock also prevents duplicate children. */
export async function openDrilldown(canvasId: string, nodeId: string, body: unknown): Promise<DiagramDrilldown> {
  if (!UUID_RE.test(nodeId)) throw new ValidationError('nodeId must be a UUID', { nodeId: 'invalid' });
  if (typeof body !== 'object' || body === null || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'revision')) {
    throw new ValidationError('Body must be { revision }', { body: 'invalid' });
  }
  const revision = validateRevision((body as { revision?: unknown }).revision);
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await requireCanvasType(canvasId, 'diagram', client, true);
    const current = await client.query<{ revision: number; document: DiagramDocument; project: string | null }>(
      `SELECT d.revision, d.document, c.project FROM canvas_diagrams d
       JOIN canvases c ON c.id = d.canvas_id WHERE d.canvas_id = $1 AND c.deleted_at IS NULL`, [canvasId]);
    const parent = current.rows[0];
    if (parent === undefined) throw new NotFoundError('Diagram');
    if (parent.revision !== revision) {
      throw new ConflictError('The parent diagram changed. Reload before opening a drill-down.',
        'DIAGRAM_REVISION_CONFLICT', { revision: String(parent.revision) });
    }
    const node = parent.document.nodes.find(item => item.id === nodeId);
    if (node === undefined) throw new NotFoundError('Diagram shape');
    const existing = await client.query<DiagramDrilldown>(
      `SELECT d.node_id AS "nodeId", c.id AS "canvasId", c.title FROM diagram_drilldowns d
       JOIN canvases c ON c.id = d.child_canvas_id
       WHERE d.canvas_id = $1 AND d.node_id = $2 AND c.deleted_at IS NULL`, [canvasId, nodeId]);
    let result = existing.rows[0];
    if (result === undefined) {
      const title = `${node.label.trim() || 'Untitled shape'} - detail`.slice(0, DRILLDOWN_TITLE_MAX);
      const child = await client.query<{ id: string }>(
        `INSERT INTO canvases (title, project, canvas_type) VALUES ($1, $2, 'diagram') RETURNING id`, [title, parent.project]);
      const childId = child.rows[0]!.id;
      // A drill-down keeps its parent's diagram type, so AI flow detail stays an AI flow.
      await initDiagram(client, childId, parent.document.diagramType === 'ai-flow' ? { ...emptyDiagram(), diagramType: 'ai-flow' } : emptyDiagram());
      await client.query(
        `INSERT INTO diagram_drilldowns (canvas_id, node_id, child_canvas_id) VALUES ($1, $2, $3)`, [canvasId, nodeId, childId]);
      result = { nodeId, canvasId: childId, title };
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/**
 * Saves a new document if `revision` is still the current revision (optimistic
 * concurrency), returning the new snapshot with revision + 1. A stale revision
 * is a 409 DIAGRAM_REVISION_CONFLICT carrying the current revision; nothing is
 * written. An invalid document is a 422 with the offending path.
 */
export async function saveDiagram(canvasId: string, body: unknown): Promise<DiagramSnapshot> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Body must be { revision, document }', { body: 'invalid' });
  }
  const extra = Object.keys(body).filter((k) => k !== 'revision' && k !== 'document');
  if (extra.length > 0) throw new ValidationError(`Unexpected property ${extra[0]!}`, { [extra[0]!]: 'is not an allowed property' });
  const { revision: rawRevision, document: rawDocument } = body as { revision?: unknown; document?: unknown };
  const revision = validateRevision(rawRevision);

  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    // Locking the canvas row serialises saves and asset uploads for this canvas.
    await requireCanvasType(canvasId, 'diagram', client, true);
    await client.query(
      `INSERT INTO canvas_diagrams (canvas_id, revision, document) VALUES ($1, 0, $2) ON CONFLICT (canvas_id) DO NOTHING`,
      [canvasId, JSON.stringify(emptyDiagram())]);
    const cur = await client.query<{ revision: number }>(
      `SELECT revision FROM canvas_diagrams WHERE canvas_id = $1 FOR UPDATE`, [canvasId]);
    const current = cur.rows[0]!.revision;
    if (current !== revision) {
      throw new ConflictError(
        `Diagram has changed since revision ${revision} (current revision is ${current}); reload before saving`,
        'DIAGRAM_REVISION_CONFLICT',
        { revision: String(current) },
      );
    }
    const assets = await client.query<{ id: string }>(`SELECT id::text FROM canvas_diagram_assets WHERE canvas_id = $1`, [canvasId]);
    const document = validateDiagramDocument(rawDocument, new Set(assets.rows.map((a) => a.id)));
    const json = JSON.stringify(document);
    const upd = await client.query<{ revision: number }>(
      `UPDATE canvas_diagrams SET document = $1, revision = revision + 1, updated_at = NOW()
        WHERE canvas_id = $2 AND revision = $3 RETURNING revision`,
      [json, canvasId, revision]);
    const next = upd.rows[0]?.revision;
    if (next === undefined) {
      throw new ConflictError('Diagram has changed; reload before saving', 'DIAGRAM_REVISION_CONFLICT', {});
    }
    await client.query(
      `INSERT INTO canvas_diagram_revisions (canvas_id, revision, document) VALUES ($1, $2, $3)
       ON CONFLICT (canvas_id, revision) DO UPDATE SET document = EXCLUDED.document, created_at = NOW()`,
      [canvasId, next, json]);
    await client.query(`DELETE FROM canvas_diagram_revisions WHERE canvas_id = $1 AND revision <= $2`, [canvasId, next - KEEP_REVISIONS]);
    const elementIds = [...document.nodes.map((n) => n.id), ...document.edges.map((e) => e.id), ...(document.footnotes ?? []).map((f) => f.id)];
    await client.query(
      `DELETE FROM diagram_element_notes WHERE canvas_id = $1 AND NOT (element_id = ANY($2::uuid[]))`, [canvasId, elementIds]);
    await client.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
    await client.query('COMMIT');
    return { revision: next, document };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stores a validated PNG / SVG for a diagram canvas. Identical bytes uploaded
 * again to the same canvas return the existing asset (stable id).
 */
export async function uploadAsset(
  canvasId: string, body: unknown, contentTypeHeader: string | undefined, rawName: unknown,
): Promise<{ asset: DiagramAsset; created: boolean }> {
  const name = validateAssetName(rawName);
  const meta = validateAssetUpload(body, contentTypeHeader);
  const bytes = body as Buffer;
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await requireCanvasType(canvasId, 'diagram', client, true);
    const existing = await client.query<{ id: string; name: string; content_type: string }>(
      `SELECT id::text, name, content_type FROM canvas_diagram_assets WHERE canvas_id = $1 AND sha256 = $2`, [canvasId, sha256]);
    const found = existing.rows[0];
    if (found !== undefined) {
      await client.query('COMMIT');
      return { asset: { id: found.id, name: found.name, contentType: found.content_type }, created: false };
    }
    const count = await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM canvas_diagram_assets WHERE canvas_id = $1`, [canvasId]);
    if (Number(count.rows[0]?.n ?? 0) >= DIAGRAM_LIMITS.maxAssetsPerCanvas) {
      throw new ConflictError(`A diagram can have at most ${DIAGRAM_LIMITS.maxAssetsPerCanvas} images`, 'ASSET_LIMIT_REACHED', {});
    }
    const ins = await client.query<{ id: string }>(
      `INSERT INTO canvas_diagram_assets (canvas_id, name, content_type, byte_size, width, height, sha256, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
      [canvasId, name, meta.contentType, bytes.length, meta.width, meta.height, sha256, bytes]);
    await client.query('COMMIT');
    return { asset: { id: ins.rows[0]!.id, name, contentType: meta.contentType }, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface StoredAsset extends DiagramAsset { data: Buffer; sha256: string }

/** An asset of this canvas only; 404 for unknown ids or ids belonging to another canvas. */
export async function getAsset(canvasId: string, assetId: string): Promise<StoredAsset> {
  if (!UUID_RE.test(canvasId) || !UUID_RE.test(assetId)) throw new NotFoundError('Asset');
  const r = await getDb().query<{ id: string; name: string; content_type: string; data: Buffer; sha256: string }>(
    `SELECT id::text, name, content_type, data, sha256 FROM canvas_diagram_assets WHERE id = $1 AND canvas_id = $2`,
    [assetId, canvasId]);
  const row = r.rows[0];
  if (row === undefined) throw new NotFoundError('Asset');
  return { id: row.id, name: row.name, contentType: row.content_type, data: row.data, sha256: row.sha256 };
}

// ─── Named versions ─────────────────────────────────────────────────────────

export const MAX_VERSIONS_PER_DIAGRAM = 100;
const VERSION_NAME_MAX = 120;

export interface DiagramVersionSummary { id: string; name: string; revision: number; createdAt: string }
export interface DiagramVersion extends DiagramVersionSummary { document: DiagramDocument }

function versionName(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('name is required', { name: 'required' });
  const name = v.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > VERSION_NAME_MAX) {
    throw new ValidationError(`name must be 1-${VERSION_NAME_MAX} characters`, { name: 'invalid length' });
  }
  return name;
}

function toSummary(r: { id: string; name: string; revision: number; created_at: Date | string }): DiagramVersionSummary {
  return { id: r.id, name: r.name, revision: r.revision, createdAt: new Date(r.created_at).toISOString() };
}

export async function listVersions(canvasId: string): Promise<DiagramVersionSummary[]> {
  const db = getDb();
  await requireCanvasType(canvasId, 'diagram', db);
  const r = await db.query<{ id: string; name: string; revision: number; created_at: Date }>(
    `SELECT id::text, name, revision, created_at FROM canvas_diagram_versions WHERE canvas_id = $1 ORDER BY created_at DESC, id`, [canvasId]);
  return r.rows.map(toSummary);
}

/** Saves the current stored document under a name. */
export async function createVersion(canvasId: string, body: unknown): Promise<DiagramVersionSummary> {
  const name = versionName((body as { name?: unknown } | null)?.name);
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    await requireCanvasType(canvasId, 'diagram', client, true);
    const count = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM canvas_diagram_versions WHERE canvas_id = $1`, [canvasId]);
    if (Number(count.rows[0]?.n ?? 0) >= MAX_VERSIONS_PER_DIAGRAM) {
      throw new ValidationError(`A diagram can have at most ${MAX_VERSIONS_PER_DIAGRAM} named versions; delete one first`, { name: 'too many versions' });
    }
    const r = await client.query<{ id: string; name: string; revision: number; created_at: Date }>(
      `INSERT INTO canvas_diagram_versions (canvas_id, name, revision, document)
       SELECT canvas_id, $2, revision, document FROM canvas_diagrams WHERE canvas_id = $1
       RETURNING id::text, name, revision, created_at`, [canvasId, name]);
    const row = r.rows[0];
    if (row === undefined) throw new NotFoundError('Diagram');
    await client.query('COMMIT');
    return toSummary(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getVersion(canvasId: string, versionId: string): Promise<DiagramVersion> {
  const db = getDb();
  await requireCanvasType(canvasId, 'diagram', db);
  if (!UUID_RE.test(versionId)) throw new NotFoundError('Version');
  const r = await db.query<{ id: string; name: string; revision: number; created_at: Date; document: DiagramDocument }>(
    `SELECT id::text, name, revision, created_at, document FROM canvas_diagram_versions WHERE canvas_id = $1 AND id = $2`, [canvasId, versionId]);
  const row = r.rows[0];
  if (row === undefined) throw new NotFoundError('Version');
  return { ...toSummary(row), document: row.document };
}

export async function deleteVersion(canvasId: string, versionId: string): Promise<void> {
  const db = getDb();
  await requireCanvasType(canvasId, 'diagram', db);
  if (!UUID_RE.test(versionId)) throw new NotFoundError('Version');
  const r = await db.query(`DELETE FROM canvas_diagram_versions WHERE canvas_id = $1 AND id = $2`, [canvasId, versionId]);
  if (r.rowCount === 0) throw new NotFoundError('Version');
}
