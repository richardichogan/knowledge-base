/**
 * Definition notes are the user's authoritative wording for a term. When a defined term appears
 * in his message or the document he is viewing, the definition is put in front of Athena so she
 * uses that wording across every project and flags drift from it.
 */

import { getDb } from '../db/db.js';
import { renderNoteAsText } from '../services/noteTextService.js';

interface Definition { id: string; term: string; text: string }

const CACHE_MS = 60_000;
const MAX_DEFINITIONS = 8;
const MAX_DEFINITION_CHARS = 2_000;

let cache: { at: number; definitions: Promise<Definition[]> } | null = null;

/** Called when a note is saved or deleted so an edited definition is used on the next turn. */
export function invalidateDefinitions(): void {
  cache = null;
}

async function loadDefinitions(): Promise<Definition[]> {
  const db = getDb();
  const result = await db.query<{ id: string; title: string; content: string }>(
    `SELECT id, COALESCE(note_list_metadata(content)->>'title', '') AS title, content::text AS content FROM notes
     WHERE status = 'active' AND note_list_metadata(content)->>'contentType' = 'definition'`,
  );
  const definitions = await Promise.all(result.rows.map(async (row) => ({
    id: row.id,
    term: row.title.trim(),
    text: (await renderNoteAsText(db, row.content)).trim(),
  })));
  return definitions.filter((d) => d.term !== '' && d.text !== '');
}

function definitions(): Promise<Definition[]> {
  if (cache === null || Date.now() - cache.at > CACHE_MS) {
    const pending = loadDefinitions().catch((err: unknown) => {
      console.error('[definitions] Could not load definitions:', err instanceof Error ? err.message : err);
      cache = null;
      return [];
    });
    cache = { at: Date.now(), definitions: pending };
  }
  return cache.definitions;
}

function mentions(term: string, text: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}s?($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** The prompt block for definitions whose term appears in the given text, or '' when none do. */
export async function formatDefinitionsContext(text: string, viewingTitle?: string): Promise<string> {
  const viewing = viewingTitle?.trim().toLowerCase();
  if (text.trim() === '') return '';
  const matched = (await definitions())
    .filter((d) => d.term.toLowerCase() !== viewing && mentions(d.term, text))
    .slice(0, MAX_DEFINITIONS);
  if (matched.length === 0) return '';
  const entries = matched.map((d) => {
    const body = d.text.length > MAX_DEFINITION_CHARS ? `${d.text.slice(0, MAX_DEFINITION_CHARS)}…` : d.text;
    return `### ${d.term} (definition note id ${d.id})\n${body}`;
  });
  return [
    '## Authoritative definitions',
    'These are his own definitions and apply across every project. When you use one of these terms, use this meaning and wording. '
      + 'If his message or the document uses a term in a way that conflicts with its definition, point out the difference briefly '
      + 'rather than silently adopting either version.',
    ...entries,
  ].join('\n\n');
}
