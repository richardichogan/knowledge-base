import type { Pool } from 'pg';
import type { OutputFormat } from './chatOutputs.js';

interface ExportOutput {
  title: string;
  format: OutputFormat;
  content: string;
}

const SHOW_NOTES_ORDER = [
  'Titles and metadata',
  'YouTube show notes',
  'Spotify show notes',
  'Blog show notes',
  'Companion blog post',
  'Social campaign',
  'Bluesky daily posts',
];
const MIN_FENCE_LENGTH = 3;

export function combineOutputsForThink(
  outputs: ExportOutput[],
  title: string,
  persona: string,
): { title: string; bodyMarkdown: string } {
  const ordered = persona === 'podcast_show_notes'
    ? [...outputs].sort((a, b) => {
      const rank = (name: string): number => {
        const index = SHOW_NOTES_ORDER.findIndex((item) => item.toLowerCase() === name.toLowerCase());
        return index === -1 ? SHOW_NOTES_ORDER.length : index;
      };
      return rank(a.title) - rank(b.title);
    })
    : outputs;
  const sections = ordered.map((output) => {
    let content = output.content;
    if (output.format !== 'markdown') {
      const runs = content.match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(MIN_FENCE_LENGTH, ...runs.map((run) => run.length + 1)));
      const language = output.format === 'html' || output.title.toLowerCase() === 'spotify show notes' ? 'html' : 'text';
      content = `${fence}${language}\n${content}\n${fence}`;
    }
    return `## ${output.title.replace(/[\r\n]+/g, ' ')}\n\n${content}`;
  });
  return { title, bodyMarkdown: sections.join('\n\n') };
}

export async function getOutputsForThink(
  db: Pool,
  sessionId: string,
  persona: string,
): Promise<{ title: string; bodyMarkdown: string } | null> {
  const { rows } = await db.query<ExportOutput & { session_title: string | null }>(
    `SELECT o.title, o.format, v.content, s.title AS session_title
     FROM chat_outputs o
     JOIN ai_chat_sessions s ON s.id = o.session_id
     LEFT JOIN LATERAL (
       SELECT content FROM chat_output_versions
       WHERE output_id = o.id ORDER BY version DESC LIMIT 1
     ) v ON true
     WHERE o.session_id = $1 ORDER BY o.created_at, o.id`,
    [sessionId],
  );
  if (rows.length === 0) return null;
  if (rows.some((row) => typeof row.content !== 'string' || row.content.trim() === '')) {
    throw new Error('Cannot export: a saved Output has no content');
  }
  return combineOutputsForThink(rows, rows[0]?.session_title ?? 'Athena outputs', persona);
}
