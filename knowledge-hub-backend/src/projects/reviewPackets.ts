import type { Pool } from 'pg';
import { ValidationError, NotFoundError, ConflictError } from '../types/errors.js';
import { assertProject } from './cockpit.js';

export type PacketSourceType = 'note' | 'output' | 'decision';
export type ItemState = 'current' | 'changed' | 'missing';

export interface PacketSource { sourceType: PacketSourceType; sourceId: string; label: string; identity: string; content: string; href: string; updatedAt: string | null }

export interface PacketItem {
  position: number;
  sourceType: PacketSourceType;
  sourceId: string;
  label: string;
  capturedIdentity: string;
  capturedContent: string;
  checked: boolean;
  state: ItemState;
  currentIdentity: string | null;
  href: string;
}

export interface ReviewPacket {
  id: string;
  projectId: string;
  title: string;
  status: 'draft' | 'approved';
  approvedAt: string | null;
  createdAt: string;
  items: PacketItem[];
  staleCount: number;
}

export interface PacketSummary { id: string; title: string; status: 'draft' | 'approved'; approvedAt: string | null; createdAt: string; itemCount: number }

export interface PacketCandidate { sourceType: PacketSourceType; sourceId: string; label: string; identity: string; updatedAt: string | null }

const TYPES: PacketSourceType[] = ['note', 'output', 'decision'];
const MAX_TITLE = 200;
const MAX_ITEMS = 100;
const LABEL_LENGTH = 100;
const CANDIDATE_LIMIT = 50;
const PACKET_LIST_LIMIT = 50;
const ITEM_FIELDS = 7;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

const labelOf = (value: unknown, fallback: string): string => {
  const line = String(value ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  const flat = line === '' ? fallback : line.replace(/^#+\s*/, '');
  return flat.length > LABEL_LENGTH ? `${flat.slice(0, LABEL_LENGTH)}…` : flat;
};

const SOURCE_QUERIES: Record<PacketSourceType, { sql: string; idColumn: string; order: string }> = {
  note: {
    sql: `SELECT id::text AS source_id, content AS body, md5(COALESCE(content, '')) AS identity, updated_at,
            content AS label_text, '/think?noteId=' || id::text AS href FROM notes WHERE project_id = $1 AND status = 'active'`,
    idColumn: 'id', order: 'updated_at DESC, id',
  },
  output: {
    sql: `SELECT o.id::text AS source_id, COALESCE(v.content, '') AS body, 'v' || COALESCE(v.version, 0)::text AS identity,
            o.updated_at, o.title AS label_text, '/chat?session=' || s.id::text AS href
          FROM chat_outputs o JOIN ai_chat_sessions s ON s.id = o.session_id
          LEFT JOIN LATERAL (SELECT version, content FROM chat_output_versions WHERE output_id = o.id ORDER BY version DESC LIMIT 1) v ON TRUE
          WHERE s.project_id = $1`,
    idColumn: 'o.id', order: 'o.updated_at DESC, o.id',
  },
  decision: {
    sql: `SELECT d.id::text AS source_id, d.text AS body, md5(d.status || ':' || d.text) AS identity, d.updated_at,
            d.text AS label_text, '/chat?session=' || s.id::text AS href
          FROM chat_decisions d JOIN ai_chat_sessions s ON s.id = d.session_id WHERE s.project_id = $1`,
    idColumn: 'd.id', order: 'd.updated_at DESC, d.id',
  },
};

const FALLBACK_LABEL: Record<PacketSourceType, string> = { note: 'Untitled note', output: 'Untitled output', decision: 'Decision' };

async function loadSources(db: Pool, projectId: string, type: PacketSourceType, ids: string[] | null, limit: number | null): Promise<PacketSource[]> {
  const q = SOURCE_QUERIES[type];
  const params: unknown[] = [projectId];
  let sql = q.sql;
  if (ids !== null) { params.push(ids); sql += ` AND ${q.idColumn}::text = ANY($2)`; }
  sql += ` ORDER BY ${q.order}`;
  if (limit !== null) sql += ` LIMIT ${limit}`;
  const r = await db.query(sql, params);
  return r.rows.map((row: Record<string, unknown>) => ({
    sourceType: type, sourceId: String(row['source_id']), identity: String(row['identity']),
    content: String(row['body'] ?? ''), label: labelOf(row['label_text'], FALLBACK_LABEL[type]),
    href: String(row['href']), updatedAt: iso(row['updated_at']),
  }));
}

export async function listCandidates(db: Pool, projectId: string): Promise<{ items: PacketCandidate[]; limitPerType: number }> {
  await assertProject(db, projectId);
  const groups = await Promise.all(TYPES.map((t) => loadSources(db, projectId, t, null, CANDIDATE_LIMIT)));
  const items = groups.flat().map((s) => ({
    sourceType: s.sourceType, sourceId: s.sourceId, label: s.label, identity: s.identity,
    updatedAt: s.updatedAt,
  }));
  return { items, limitPerType: CANDIDATE_LIMIT };
}

interface ItemRef { sourceType: PacketSourceType; sourceId: string }

function parseRefs(value: unknown): ItemRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('Select at least one item', { items: 'required' });
  if (value.length > MAX_ITEMS) throw new ValidationError(`A packet can hold at most ${MAX_ITEMS} items`, { items: 'too many' });
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const type = r['sourceType'];
    const id = r['sourceId'];
    if (!TYPES.includes(type as PacketSourceType) || typeof id !== 'string' || id === '') {
      throw new ValidationError('Each item needs a sourceType (note, output or decision) and sourceId', { items: 'invalid' });
    }
    const key = `${String(type)}:${id}`;
    if (seen.has(key)) throw new ValidationError('An item can only be selected once', { items: 'duplicate' });
    seen.add(key);
    return { sourceType: type as PacketSourceType, sourceId: id };
  });
}

/** Create a packet from an explicit, ordered selection. Every source must belong to the project. */
export async function createPacket(db: Pool, projectId: string, input: { title?: unknown; items?: unknown }): Promise<ReviewPacket> {
  await assertProject(db, projectId);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '' || title.length > MAX_TITLE) throw new ValidationError(`title is required (max ${MAX_TITLE} characters)`, { title: 'invalid' });
  const refs = parseRefs(input.items);
  const found = new Map<string, PacketSource>();
  for (const type of TYPES) {
    const ids = refs.filter((r) => r.sourceType === type).map((r) => r.sourceId);
    if (ids.length === 0) continue;
    for (const s of await loadSources(db, projectId, type, ids, null)) found.set(`${type}:${s.sourceId}`, s);
  }
  const missing = refs.filter((r) => !found.has(`${r.sourceType}:${r.sourceId}`));
  if (missing.length > 0) throw new ValidationError('Some selected items do not exist in this project', { items: 'not in project' });

  const p = await db.query('INSERT INTO review_packets (project_id, title) VALUES ($1, $2) RETURNING id', [projectId, title]);
  const packetId = String((p.rows[0] as { id: string }).id);
  try {
    const values: unknown[] = [packetId];
    const rows = refs.map((r, position) => {
      const s = found.get(`${r.sourceType}:${r.sourceId}`) as PacketSource;
      values.push(position, s.sourceType, s.sourceId, s.label, s.identity, s.content, s.href);
      const first = values.length - (ITEM_FIELDS - 1);
      const slots = Array.from({ length: ITEM_FIELDS }, (_, i) => `$${first + i}`);
      return `($1, ${slots.join(', ')})`;
    });
    await db.query(`INSERT INTO review_packet_items (packet_id, position, source_type, source_id, label, captured_identity, captured_content, href)
      VALUES ${rows.join(', ')}`, values);
  } catch (error) {
    await db.query('DELETE FROM review_packets WHERE id = $1', [packetId]);
    throw error;
  }
  return getPacket(db, projectId, packetId);
}

export async function listPackets(db: Pool, projectId: string): Promise<PacketSummary[]> {
  await assertProject(db, projectId);
  const r = await db.query(
    `SELECT p.id, p.title, p.status, p.approved_at, p.created_at, (SELECT COUNT(*)::int FROM review_packet_items i WHERE i.packet_id = p.id) AS item_count
     FROM review_packets p WHERE p.project_id = $1 ORDER BY p.created_at DESC, p.id LIMIT ${PACKET_LIST_LIMIT}`, [projectId]);
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row['id']), title: String(row['title']), status: row['status'] as 'draft' | 'approved',
    approvedAt: iso(row['approved_at']), createdAt: iso(row['created_at']) ?? '', itemCount: Number(row['item_count']),
  }));
}

export async function getPacket(db: Pool, projectId: string, packetId: string): Promise<ReviewPacket> {
  const p = await db.query(
    'SELECT id, project_id, title, status, approved_at, created_at FROM review_packets WHERE id::text = $1 AND project_id = $2', [packetId, projectId]);
  const head = p.rows[0] as Record<string, unknown> | undefined;
  if (head === undefined) throw new NotFoundError('Review packet');
  const rows = (await db.query(
    `SELECT position, source_type, source_id, label, captured_identity, captured_content, href, checked
     FROM review_packet_items WHERE packet_id = $1 ORDER BY position`, [String(head['id'])])).rows as Record<string, unknown>[];
  const live = new Map<string, string>();
  for (const type of TYPES) {
    const ids = rows.filter((r) => r['source_type'] === type).map((r) => String(r['source_id']));
    if (ids.length === 0) continue;
    for (const s of await loadSources(db, projectId, type, ids, null)) live.set(`${type}:${s.sourceId}`, s.identity);
  }
  const items: PacketItem[] = rows.map((r) => {
    const type = r['source_type'] as PacketSourceType;
    const id = String(r['source_id']);
    const current = live.get(`${type}:${id}`) ?? null;
    const state: ItemState = current === null ? 'missing' : current === String(r['captured_identity']) ? 'current' : 'changed';
    return {
      position: Number(r['position']), sourceType: type, sourceId: id, label: String(r['label']),
      capturedIdentity: String(r['captured_identity']), capturedContent: String(r['captured_content']),
      checked: r['checked'] === true, state, currentIdentity: current, href: String(r['href']),
    };
  });
  return {
    id: String(head['id']), projectId: String(head['project_id']), title: String(head['title']),
    status: head['status'] as 'draft' | 'approved', approvedAt: iso(head['approved_at']), createdAt: iso(head['created_at']) ?? '',
    items, staleCount: items.filter((i) => i.state !== 'current').length,
  };
}

export async function setItemChecked(db: Pool, projectId: string, packetId: string, position: number, checked: unknown): Promise<ReviewPacket> {
  if (typeof checked !== 'boolean') throw new ValidationError('checked must be true or false', { checked: 'invalid' });
  const packet = await getPacket(db, projectId, packetId);
  if (packet.status === 'approved') throw new ConflictError('An approved packet can no longer be changed', 'PACKET_APPROVED');
  const r = await db.query('UPDATE review_packet_items SET checked = $3 WHERE packet_id = $1 AND position = $2', [packet.id, position, checked]);
  if (r.rowCount === 0) throw new NotFoundError('Packet item');
  return getPacket(db, projectId, packetId);
}

/** Records approval only. It must not publish, post, create issues or start Build. */
export async function approvePacket(db: Pool, projectId: string, packetId: string, acknowledgeStale: unknown): Promise<ReviewPacket> {
  const packet = await getPacket(db, projectId, packetId);
  if (packet.status === 'approved') return packet;
  if (packet.staleCount > 0 && acknowledgeStale !== true) {
    throw new ValidationError('Some sources changed or were removed since this packet was created; acknowledge to approve anyway', { acknowledgeStale: 'required' });
  }
  await db.query(`UPDATE review_packets SET status = 'approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1`, [packet.id]);
  return getPacket(db, projectId, packetId);
}

export async function deletePacket(db: Pool, projectId: string, packetId: string): Promise<void> {
  const r = await db.query('DELETE FROM review_packets WHERE id::text = $1 AND project_id = $2', [packetId, projectId]);
  if (r.rowCount === 0) throw new NotFoundError('Review packet');
}

const SLUG_LENGTH = 60;

/** Deterministic Markdown: full captured content in selection order, with identities and checklist state. No truncation. */
export function renderPacketMarkdown(packet: ReviewPacket): { filename: string; markdown: string } {
  const lines: string[] = [`# ${packet.title}`, '', `Status: ${packet.status === 'approved' ? 'Approved' : 'Draft'}`, `Items: ${packet.items.length}`, ''];
  for (const item of packet.items) {
    lines.push(`## ${item.position + 1}. ${item.label}`, '',
      `- Type: ${item.sourceType}`, `- Source: ${item.href}`, `- Captured version: ${item.capturedIdentity}`,
      `- Checklist: ${item.checked ? '[x] reviewed' : '[ ] not reviewed'}`,
      `- Source state: ${item.state === 'current' ? 'unchanged since capture' : item.state === 'changed' ? 'changed since capture' : 'no longer available'}`,
      '', item.capturedContent, '');
  }
  const slug = packet.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_LENGTH) || 'review-packet';
  return { filename: `${slug}.md`, markdown: `${lines.join('\n').trimEnd()}\n` };
}
