import type { Pool } from 'pg';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Detects a strict "only project X" request. Deterministic and server-side; the model never
 * supplies scope. Returns the matching project id, or null when the message is not strict.
 */
export function detectStrictProjectScope(message: string, projects: ReadonlyArray<{ id: string; name: string }>): string | null {
  if (!/\bonly\b/i.test(message)) return null;
  let best: { id: string; len: number } | null = null;
  for (const project of projects) {
    const name = project.name.trim();
    if (!name) continue;
    const re = new RegExp(`\\bonly\\b[^.?!\\n]{0,40}?(?<![\\w])${escapeRe(name)}(?![\\w])`, 'i');
    if (re.test(message) && (!best || name.length > best.len)) best = { id: project.id, len: name.length };
  }
  return best?.id ?? null;
}

export async function resolveStrictProjectScope(db: Pool, message: string): Promise<string | null> {
  if (!/\bonly\b/i.test(message)) return null;
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM projects`);
  return detectStrictProjectScope(message, rows);
}
