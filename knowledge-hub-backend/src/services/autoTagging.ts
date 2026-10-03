/**
 * services/autoTagging.ts — tags Think notes and Plan tasks automatically once an item has settled.
 *
 * A note is tagged a while after you stop editing, and again only when its content has really changed
 * (tracked by a hash of what it was last tagged from). Tags are only ever ADDED, marked 'auto'; yours are
 * never touched, and a tag you remove is remembered (tag_rejections) and not re-applied to that item.
 * Notes may propose a new tag (it joins the review queue as evidence); tasks use existing tags only.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { tagContent } from './taxonomyService.js';
import { renderNoteAsText } from './noteTextService.js';

export type AutoTagKind = 'note' | 'task';

const SETTLE_MS: Record<AutoTagKind, number> = { note: 45_000, task: 20_000 };
const MIN_WORDS: Record<AutoTagKind, number> = { note: 40, task: 3 };
/** An item that already carries this many tags is left alone. */
const MAX_TAGS_BEFORE_SKIP = 8;
const NOTE_TEXT_CHARS = 6_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Schedules tagging for an item; calling it again while it is pending restarts the wait. */
export function queueAutoTag(db: Pool, kind: AutoTagKind, id: string, delayMs?: number): void {
  const key = `${kind}:${id}`;
  const existing = timers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void autoTagNow(db, kind, id).catch((err: unknown) => { console.warn(`[AutoTag] ${key} failed:`, err); });
  }, delayMs ?? SETTLE_MS[kind]));
}

async function loadItem(db: Pool, kind: AutoTagKind, id: string): Promise<{ title: string; text: string } | null> {
  if (kind === 'note') {
    const { rows } = await db.query<{ content: string }>(`SELECT content FROM notes WHERE id::text = $1 AND status = 'active'`, [id]);
    const raw = rows[0]?.content;
    if (raw === undefined) return null;
    let title = 'Note';
    try { title = (JSON.parse(raw) as { title?: string }).title ?? title; } catch { /* raw text */ }
    return { title, text: (await renderNoteAsText(db, raw)).slice(0, NOTE_TEXT_CHARS) };
  }
  const { rows } = await db.query<{ title: string; body: string | null }>(`SELECT title, body FROM tasks WHERE id::text = $1 AND archived = false`, [id]);
  const row = rows[0];
  return row === undefined ? null : { title: row.title, text: `${row.title}\n\n${row.body ?? ''}`.trim() };
}

/** Tags one note or task now, if it has enough content and has changed since it was last tagged. */
export async function autoTagNow(db: Pool, kind: AutoTagKind, id: string, force = false): Promise<{ applied: number; skipped?: string }> {
  const item = await loadItem(db, kind, id);
  if (item === null) return { applied: 0, skipped: 'not found' };
  const words = (item.text.match(/\S+/g) ?? []).length;
  if (words < MIN_WORDS[kind]) return { applied: 0, skipped: 'too short' };

  const hash = createHash('sha1').update(item.text).digest('hex');
  if (!force) {
    const seen = await db.query<{ content_hash: string }>(`SELECT content_hash FROM auto_tag_state WHERE content_kind = $1 AND content_id = $2`, [kind, id]);
    if (seen.rows[0]?.content_hash === hash) return { applied: 0, skipped: 'unchanged' };
  }
  const table = kind === 'note' ? 'note_tags' : 'task_tags';
  const col = kind === 'note' ? 'note_id' : 'task_id';
  const count = await db.query<{ n: string }>(`SELECT count(*) n FROM ${table} WHERE ${col}::text = $1`, [id]);
  if (!force && Number(count.rows[0]?.n ?? 0) >= MAX_TAGS_BEFORE_SKIP) return { applied: 0, skipped: 'already well tagged' };

  const result = await tagContent(db, `${item.title}\n\n${item.text}`, id, kind, item.title, { maxChars: NOTE_TEXT_CHARS });
  await db.query(
    `INSERT INTO auto_tag_state (content_kind, content_id, content_hash) VALUES ($1, $2, $3)
     ON CONFLICT (content_kind, content_id) DO UPDATE SET content_hash = EXCLUDED.content_hash, tagged_at = NOW()`,
    [kind, id, hash],
  );
  return { applied: result.appliedTagIds.length };
}
