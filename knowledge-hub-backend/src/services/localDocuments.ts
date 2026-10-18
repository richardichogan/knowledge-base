/**
 * Files indexed from folders on the user's PC by Athena Desktop.
 *
 * They are ordinary `user-upload` content items whose source_id is
 * `local:<deviceId>:<sha256 of the normalised path>`, so re-uploading a changed
 * file replaces the same row (and keeps its links) instead of adding a copy.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import { deleteIndexedContentItems } from '../ai/foundryIqIndexer.js';

const LOCAL_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{64}$/;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PATH_LENGTH = 1_024;
const MAX_DEVICE_NAME_LENGTH = 120;
const DEVICE_ID_CHARS = 36;

export interface LocalUploadFields {
  localKey: string;
  localPath: string;
  localHash: string;
  deviceId: string;
  deviceName: string;
}

export interface LocalIndexEntry {
  localKey: string;
  localPath: string;
  localHash: string;
  contentItemId: string;
  blobPath: string | null;
}

export function localSourceId(localKey: string): string {
  return `local:${localKey}`;
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

/** The local-file fields of an upload, or null for an ordinary upload. Partial or malformed fields are rejected. */
export function parseLocalUploadFields(body: Record<string, unknown>): LocalUploadFields | null {
  const names = ['localKey', 'localPath', 'localHash', 'deviceName'] as const;
  if (names.every((n) => body[n] === undefined)) return null;
  const localKey = body['localKey'];
  const localPath = body['localPath'];
  const localHash = body['localHash'];
  const deviceName = body['deviceName'];
  if (typeof localKey !== 'string' || !LOCAL_KEY_PATTERN.test(localKey)) {
    throw new ValidationError('localKey must be "<deviceId>:<sha256>"', { localKey: 'invalid' });
  }
  if (typeof localPath !== 'string' || localPath.trim() === '' || localPath.length > MAX_PATH_LENGTH) {
    throw new ValidationError('localPath required', { localPath: 'invalid' });
  }
  if (typeof localHash !== 'string' || !HASH_PATTERN.test(localHash)) {
    throw new ValidationError('localHash must be a sha256 hex digest', { localHash: 'invalid' });
  }
  if (typeof deviceName !== 'string' || deviceName.trim() === '' || deviceName.length > MAX_DEVICE_NAME_LENGTH) {
    throw new ValidationError('deviceName required', { deviceName: 'invalid' });
  }
  return { localKey, localPath, localHash, deviceId: localKey.slice(0, DEVICE_ID_CHARS), deviceName: deviceName.trim() };
}

/** The stored copy of a local file, if it has been indexed. */
export async function findLocalDocument(db: Pool, localKey: string): Promise<LocalIndexEntry | null> {
  const { rows } = await db.query<{ id: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, metadata FROM content_items WHERE source = 'user-upload' AND source_id = $1`,
    [localSourceId(localKey)],
  );
  const row = rows[0];
  return row === undefined ? null : toEntry(row.id, row.metadata);
}

/** Every file indexed from one PC. */
export async function listLocalIndex(db: Pool, deviceId: string): Promise<LocalIndexEntry[]> {
  if (!isDeviceId(deviceId)) throw new ValidationError('deviceId required', { deviceId: 'invalid' });
  const { rows } = await db.query<{ id: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, metadata FROM content_items
     WHERE source = 'user-upload' AND source_id LIKE $1
     ORDER BY metadata->>'localPath'`,
    [`local:${deviceId}:%`],
  );
  return rows.map((r) => toEntry(r.id, r.metadata));
}

function toEntry(id: string, metadata: Record<string, unknown> | null): LocalIndexEntry {
  const m = metadata ?? {};
  return {
    localKey: typeof m['localKey'] === 'string' ? m['localKey'] : '',
    localPath: typeof m['localPath'] === 'string' ? m['localPath'] : '',
    localHash: typeof m['localHash'] === 'string' ? m['localHash'] : '',
    contentItemId: id,
    blobPath: typeof m['blobPath'] === 'string' ? m['blobPath'] : null,
  };
}

/**
 * Removes local files (removed from disk or from an indexed folder) from search,
 * the graph, the Library and blob storage. Search goes first so a failure keeps
 * the rows and the next sync retries instead of leaving stale searchable copies.
 */
export async function removeLocalDocuments(
  db: Pool,
  localKeys: string[],
  deleteBlob: (blobPath: string) => Promise<void>,
): Promise<number> {
  const bad = localKeys.find((k) => !LOCAL_KEY_PATTERN.test(k));
  if (bad !== undefined) throw new ValidationError('localKeys must be "<deviceId>:<sha256>"', { localKeys: 'invalid' });
  if (localKeys.length === 0) return 0;
  const { rows } = await db.query<{ id: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, metadata FROM content_items WHERE source = 'user-upload' AND source_id = ANY($1::text[])`,
    [localKeys.map(localSourceId)],
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await deleteIndexedContentItems(ids);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM nodes WHERE ref_type = 'document' AND ref_id::text = ANY($1::text[])", [ids]);
    await client.query("DELETE FROM content_items WHERE id::text = ANY($1::text[]) AND source = 'user-upload'", [ids]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  for (const row of rows) {
    const blobPath = toEntry(row.id, row.metadata).blobPath;
    if (blobPath !== null) await deleteBlob(blobPath);
  }
  return rows.length;
}
