import type { Pool } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';

export interface ParkingSelection { newsletter: boolean; podcast: boolean }
export interface DiscoverParking extends ParkingSelection { parkedAt: string; updatedAt: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parkingArticleId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('Invalid Discover article ID.');
  return value;
}

export function parseParkingSelection(value: unknown): ParkingSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Choose newsletter, podcast or both.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'newsletter' && key !== 'podcast')
    || typeof input['newsletter'] !== 'boolean' || typeof input['podcast'] !== 'boolean'
    || (!input['newsletter'] && !input['podcast'])) {
    throw new ValidationError('Choose newsletter, podcast or both.');
  }
  return { newsletter: input['newsletter'], podcast: input['podcast'] };
}

interface ParkingRow {
  newsletter: boolean; podcast: boolean; parked_at: Date; updated_at: Date;
}
function toParking(row: ParkingRow): DiscoverParking {
  return { newsletter: row.newsletter, podcast: row.podcast,
    parkedAt: row.parked_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export async function getDiscoverParking(db: Pool, id: string): Promise<DiscoverParking | null> {
  const { rows } = await db.query<ParkingRow & { article_id: string | null }>(
    `SELECT p.* FROM content_items ci LEFT JOIN discover_parking p ON p.article_id=ci.id
     WHERE ci.id=$1 AND ci.source='discovered-article'`, [parkingArticleId(id)]);
  const row = rows[0];
  if (!row) throw new NotFoundError('Discover article');
  return row.article_id ? toParking(row) : null;
}

export async function saveDiscoverParking(db: Pool, id: string, value: unknown): Promise<DiscoverParking> {
  const selection = parseParkingSelection(value);
  const { rows } = await db.query<ParkingRow>(
    `INSERT INTO discover_parking(article_id,newsletter,podcast)
     SELECT id,$2,$3 FROM content_items WHERE id=$1 AND source='discovered-article'
     ON CONFLICT(article_id) DO UPDATE SET newsletter=EXCLUDED.newsletter,podcast=EXCLUDED.podcast,updated_at=NOW()
     RETURNING *`, [parkingArticleId(id), selection.newsletter, selection.podcast]);
  if (!rows[0]) throw new NotFoundError('Discover article');
  return toParking(rows[0]);
}

export async function removeDiscoverParking(db: Pool, id: string): Promise<void> {
  await getDiscoverParking(db, id);
  await db.query('DELETE FROM discover_parking WHERE article_id=$1', [id]);
}
