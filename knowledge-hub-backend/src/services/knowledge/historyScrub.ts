import type { Pool } from 'pg';

export const EXCLUDED_REPLY_PLACEHOLDER = '[An earlier reply was omitted because it quoted a source that has since been excluded from this chat.]';

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const MIN_QUOTE = 25;

/** Fragments of an excluded record that would reveal it if an earlier reply quoted them. */
async function excludedFragments(db: Pool, excludedIds: ReadonlySet<string>): Promise<string[]> {
  if (excludedIds.size === 0) return [];
  const ids = [...excludedIds];
  const fragments: string[] = [];
  const add = (text: unknown): void => {
    if (typeof text !== 'string') return;
    const whole = normalise(text);
    if (whole.length >= MIN_QUOTE) fragments.push(whole);
    for (const part of text.split(/(?<=[.!?])\s+|\n+/)) {
      const piece = normalise(part);
      if (piece.length >= MIN_QUOTE) fragments.push(piece);
    }
  };
  const notes = await db.query<{ content: string }>(
    `SELECT content FROM notes WHERE id::text = ANY($1::text[])
        OR id::text IN (SELECT ref_id::text FROM nodes WHERE id::text = ANY($1::text[]))
        OR id::text IN (SELECT source_id FROM content_items WHERE source = 'note' AND id::text = ANY($1::text[]))`, [ids]);
  for (const n of notes.rows) add(safeNoteText(n.content));
  const items = await db.query<{ title: string; body: string | null; summary: string | null }>(
    `SELECT title, body, summary FROM content_items WHERE id::text = ANY($1::text[])
        OR id::text IN (SELECT ref_id::text FROM nodes WHERE id::text = ANY($1::text[]))`, [ids]);
  for (const i of items.rows) { add(i.title); add(i.body); add(i.summary); }
  const tasks = await db.query<{ title: string; body: string }>(`SELECT title, body FROM tasks WHERE id = ANY($1::text[])`, [ids]);
  for (const t of tasks.rows) { add(t.title); add(t.body); }
  return fragments;
}

function safeNoteText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { title?: string; contentJson?: string };
    const texts: string[] = [parsed.title ?? ''];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (typeof obj.text === 'string') texts.push(obj.text);
        Object.values(obj).forEach(walk);
      }
    };
    walk(typeof parsed.contentJson === 'string' ? JSON.parse(parsed.contentJson) : parsed.contentJson);
    return texts.join('\n');
  } catch {
    return raw;
  }
}

/** Replaces assistant messages that quote an excluded source so the model cannot re-read them from history. */
export async function scrubExcludedHistory<T extends { role: string; content: string }>(
  db: Pool, history: readonly T[], excludedIds: ReadonlySet<string>,
): Promise<T[]> {
  if (excludedIds.size === 0) return [...history];
  const fragments = await excludedFragments(db, excludedIds);
  if (fragments.length === 0) return [...history];
  return history.map((message) => {
    if (message.role !== 'assistant') return message;
    const text = normalise(message.content);
    return fragments.some(f => text.includes(f)) ? { ...message, content: EXCLUDED_REPLY_PLACEHOLDER } : message;
  });
}
