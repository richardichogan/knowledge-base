/**
 * ai/chatOutputs.ts — deliverables kept with a chat (the Outputs panel):
 * named documents with versions. Athena saves them with the save_output
 * tool; the user can edit them (a new version Athena then builds on).
 */
import type { Pool } from 'pg';

export type OutputFormat = 'markdown' | 'text';

export interface ChatOutputSummary {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  format: OutputFormat;
  version: number;
  updatedAt: string;
}

export interface ChatOutputVersion {
  version: number;
  content: string;
  author: 'athena' | 'user';
  note: string | null;
  createdAt: string;
}

export interface ChatOutput extends ChatOutputSummary {
  versions: ChatOutputVersion[];
}

const KINDS = new Set(['prompt', 'spec', 'stories', 'screens', 'script', 'document']);

function toSummary(r: Record<string, unknown>): ChatOutputSummary {
  return {
    id: r['id'] as string,
    sessionId: r['session_id'] as string,
    title: r['title'] as string,
    kind: r['kind'] as string,
    format: r['format'] as OutputFormat,
    version: Number(r['version'] ?? 0),
    updatedAt: (r['updated_at'] as Date).toISOString(),
  };
}

const SUMMARY_SQL = `
  SELECT o.id::text, o.session_id::text, o.title, o.kind, o.format, o.updated_at,
         (SELECT MAX(v.version) FROM chat_output_versions v WHERE v.output_id = o.id) AS version
  FROM chat_outputs o`;

export async function listOutputs(db: Pool, sessionId: string): Promise<ChatOutputSummary[]> {
  const { rows } = await db.query(`${SUMMARY_SQL} WHERE o.session_id = $1 ORDER BY o.updated_at DESC`, [sessionId]);
  return rows.map(toSummary);
}

export async function getOutput(db: Pool, outputId: string): Promise<ChatOutput | null> {
  const { rows } = await db.query(`${SUMMARY_SQL} WHERE o.id = $1`, [outputId]);
  if (rows[0] === undefined) return null;
  const versions = await db.query<{ version: number; content: string; author: 'athena' | 'user'; note: string | null; created_at: Date }>(
    `SELECT version, content, author, note, created_at FROM chat_output_versions WHERE output_id = $1 ORDER BY version`,
    [outputId],
  );
  return {
    ...toSummary(rows[0] as Record<string, unknown>),
    versions: versions.rows.map((v) => ({ version: v.version, content: v.content, author: v.author, note: v.note, createdAt: v.created_at.toISOString() })),
  };
}

/**
 * Saves a deliverable: a new output, or (with outputId) a new version of an
 * existing one in the same chat. Returns its id and the version written.
 */
export async function saveOutputVersion(
  db: Pool,
  sessionId: string,
  input: { outputId?: string | undefined; title?: string | undefined; kind?: string | undefined; format?: string | undefined; content: string; author: 'athena' | 'user'; note?: string | undefined },
): Promise<{ id: string; version: number; title: string }> {
  let content = input.content.trim();
  if (content === '') throw new Error('content is empty');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let id = input.outputId;
    let title = input.title?.trim() ?? '';
    if (id !== undefined && id !== '') {
      const existing = await client.query<{ title: string; format: OutputFormat }>(
        `UPDATE chat_outputs SET updated_at = NOW()${title !== '' ? ', title = $3' : ''}
         WHERE id = $1 AND session_id = $2 RETURNING title, format`,
        title !== '' ? [id, sessionId, title] : [id, sessionId],
      );
      if (existing.rows[0] === undefined) throw new Error(`No output ${id} in this chat`);
      title = existing.rows[0].title;
      if (existing.rows[0].format === 'text') content = unwrapFence(content);
    } else {
      if (title === '') throw new Error('title is required for a new output');
      const kind = input.kind !== undefined && KINDS.has(input.kind) ? input.kind : 'document';
      const format = input.format === 'text' ? 'text' : 'markdown';
      if (format === 'text') content = unwrapFence(content);
      await client.query(`INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);
      const created = await client.query<{ id: string }>(
        `INSERT INTO chat_outputs (session_id, title, kind, format) VALUES ($1, $2, $3, $4) RETURNING id::text`,
        [sessionId, title, kind, format],
      );
      id = created.rows[0]!.id;
    }
    const next = await client.query<{ version: number }>(
      `INSERT INTO chat_output_versions (output_id, version, content, author, note)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4 FROM chat_output_versions WHERE output_id = $1
       RETURNING version`,
      [id, content, input.author, input.note?.trim() || null],
    );
    await client.query('COMMIT');
    return { id, version: next.rows[0]!.version, title };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A copy-paste output shown as one block doesn't need the code fence models wrap it in. */
function unwrapFence(content: string): string {
  const m = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(content);
  return m?.[1] !== undefined && !m[1].includes('\n```') ? m[1].trim() : content;
}

export async function renameOutput(db: Pool, outputId: string, title: string): Promise<void> {
  await db.query(`UPDATE chat_outputs SET title = $2, updated_at = NOW() WHERE id = $1`, [outputId, title.trim()]);
}

export async function deleteOutput(db: Pool, outputId: string): Promise<void> {
  await db.query(`DELETE FROM chat_outputs WHERE id = $1`, [outputId]);
}

/** Outputs saved or revised in a chat since a time (the turn's start) — shown as chips on the reply. */
export async function outputsChangedSince(db: Pool, sessionId: string, since: Date): Promise<ChatOutputSummary[]> {
  const { rows } = await db.query(`${SUMMARY_SQL} WHERE o.session_id = $1 AND o.updated_at >= $2 ORDER BY o.updated_at`, [sessionId, since]);
  return rows.map(toSummary);
}

const OUTPUTS_BLOCK_BUDGET = 30_000;

/**
 * The chat's outputs (latest version of each) for Athena's context, so she
 * revises the current text — including the user's own edits.
 */
export async function buildOutputsBlock(db: Pool, sessionId: string): Promise<string> {
  const outputs = await listOutputs(db, sessionId);
  if (outputs.length === 0) return '';
  const parts: string[] = [
    '## Outputs in this chat (the Outputs panel)',
    'These are the deliverables saved in this chat, latest version of each. To revise one, call save_output with its ' +
      'output_id and the FULL new content; versions written by "user" are his own edits, so build on them.',
  ];
  let budget = OUTPUTS_BLOCK_BUDGET;
  for (const o of outputs) {
    const latest = await db.query<{ content: string; author: string }>(
      `SELECT content, author FROM chat_output_versions WHERE output_id = $1 ORDER BY version DESC LIMIT 1`,
      [o.id],
    );
    const v = latest.rows[0];
    if (v === undefined) continue;
    const header = `### ${o.title} — output_id ${o.id}, ${o.kind}, v${o.version.toString()} (by ${v.author})`;
    const body = v.content.length <= budget ? v.content : `${v.content.slice(0, Math.max(0, budget))}\n[…truncated — ask him to open it if you need the rest]`;
    budget -= body.length;
    parts.push(header, body);
    if (budget <= 0) break;
  }
  return parts.join('\n\n');
}
