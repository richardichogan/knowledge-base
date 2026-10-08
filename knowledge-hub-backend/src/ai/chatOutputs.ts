/**
 * ai/chatOutputs.ts — deliverables kept with a chat (the Outputs panel):
 * named documents with versions. Athena saves them with the save_output
 * tool; the user can edit them (a new version Athena then builds on).
 */
import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import { validateImagineDemoBrief } from './imagineDemoBriefSkill.js';

export type OutputFormat = 'markdown' | 'text' | 'html';

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

const KINDS = new Set(['prompt', 'spec', 'stories', 'screens', 'script', 'document', 'mockup']);

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
  if (input.author === 'athena') validateImagineDemoBrief(content);
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
      if (existing.rows[0].format !== 'markdown') content = unwrapFence(content);
    } else {
      if (title === '') throw new Error('title is required for a new output');
      const kind = input.kind !== undefined && KINDS.has(input.kind) ? input.kind : 'document';
      const format: OutputFormat = input.format === 'text' || input.format === 'html' ? input.format : 'markdown';
      if (format !== 'markdown') content = unwrapFence(content);
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

/** Personas whose deliverables belong in the Outputs panel. */
const OUTPUT_PERSONAS = new Set(['demo_designer', 'blog_post', 'podcast_prep', 'web_designer', 'podcast_show_notes']);
const MIN_FENCED_CHARS = 400;
/** He asked for a copy-paste prompt (the only non-page deliverable moved out of a reply). */
const PROMPT_ASK = /\b(prompts?|ghcp)\b/i;
/** A fenced block that is a whole web page (a mock-up) — always belongs in Outputs. */
const HTML_PAGE = /```html\n\s*(<!doctype html|<html)/i;

/**
 * Names a deliverable found in a reply and decides whether it revises one of
 * this chat's existing outputs (same deliverable, updated) or is a new one.
 * A small gpt-4o call; falls back to a plain title if it fails or is slow.
 */
async function nameDeliverable(
  userMessage: string,
  content: string,
  kind: string,
  existing: ChatOutputSummary[],
): Promise<{ title: string; reviseId: string | undefined }> {
  const fallbackHeading = /^#{1,3} (.+)$/m.exec(content)?.[1]?.trim();
  const fallback = { title: (kind === 'prompt' ? 'GHCP prompt' : fallbackHeading ?? 'Spec').slice(0, 100), reviseId: undefined };
  try {
    const list = existing.map((o, i) => `o${(i + 1).toString()}: ${o.title}`).join('\n') || '(none)';
    const raw = await Promise.race([
      getFoundryClient('output-title').chat('standard', [
        {
          role: 'system',
          content: 'You name deliverables saved to a chat\'s Outputs panel. Return ONLY JSON: {"title": "...", "revises": "o2" | null}. ' +
            'title: specific, under 70 characters, naming what it is for (for a coding prompt: "GHCP prompt: <screen or feature>"). ' +
            'revises: the id of an existing output ONLY if this is an updated version of that same deliverable (same screen/feature and purpose); otherwise null.',
        },
        { role: 'user', content: `Existing outputs:\n${list}\n\nHis request: ${userMessage.slice(0, 500)}\n\nKind: ${kind}\n\nDeliverable (start):\n${content.slice(0, 2_500)}` },
      ], 200),
      new Promise<string>((_r, reject) => { setTimeout(() => { reject(new Error('naming timed out')); }, 8_000); }),
    ]);
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { title?: string; revises?: string | null };
    const index = typeof parsed.revises === 'string' ? Number(parsed.revises.replace(/\D/g, '')) - 1 : -1;
    const revise = index >= 0 ? existing[index] : undefined;
    const title = (parsed.title ?? '').trim();
    return { title: revise?.title ?? (title !== '' ? title.slice(0, 100) : fallback.title), reviseId: revise?.id };
  } catch (err) {
    console.warn('[outputs] naming failed; using a plain title:', err);
    return fallback;
  }
}

/**
 * Safety net for when the model writes a deliverable he asked for into its
 * reply instead of saving it: the deliverable (a sizeable copy-paste block,
 * such as a GHCP prompt, or an HTML mock-up page) is saved to Outputs — as a new version of the
 * same deliverable or a new output — and taken out of the reply, which keeps
 * any short framing plus a line saying where it went. Returns the reply to
 * show and store (unchanged when nothing was saved).
 */
export async function moveDeliverableToOutputs(db: Pool, sessionId: string, persona: string, userMessage: string, reply: string): Promise<string> {
  const isPage = HTML_PAGE.test(reply);
  if (!OUTPUT_PERSONAS.has(persona) || (!isPage && !PROMPT_ASK.test(userMessage))) return reply;
  const blocks = [...reply.matchAll(/```([\w-]*)\n([\s\S]*?)\n```/g)].map((m) => Object.assign([m[0], m[2]] as [string, string], { lang: m[1] ?? '' }));
  const biggest = blocks.sort((a, b) => b[1].length - a[1].length)[0];
  let content: string;
  let format: OutputFormat;
  let rest: string;
  if (biggest !== undefined && biggest[1].trim().length >= MIN_FENCED_CHARS) {
    content = biggest[1].trim();
    format = biggest.lang.toLowerCase() === 'html' && /^(<!doctype html|<html)/i.test(content) ? 'html' : 'text';
    // A code example in an ordinary answer stays put unless he asked for a prompt.
    if (format === 'text' && !PROMPT_ASK.test(userMessage)) return reply;
    rest = reply.replace(biggest[0], '').trim();
  } else {
    // Long answers stay in the chat, however structured — only copy-paste blocks and pages are moved.
    return reply;
  }
  const wantsPrompt = format !== 'html' && /\b(prompt|ghcp|copilot)\b/i.test(userMessage);
  const kind = format === 'html' ? 'mockup' : wantsPrompt ? 'prompt' : persona === 'demo_designer' ? 'spec' : 'document';
  const { title, reviseId } = await nameDeliverable(userMessage, content, kind, await listOutputs(db, sessionId));
  const saved = await saveOutputVersion(db, sessionId, { outputId: reviseId, title, kind, format, content, author: 'athena', note: 'Saved from the reply' });
  const where = `Saved **${saved.title}** in Outputs${saved.version > 1 ? ` as version ${saved.version.toString()}` : ''} — open it there to copy or edit.`;
  // Keep a short lead-in (what it covers); drop long leftovers that would repeat it.
  const lead = rest.length > 0 && rest.length <= 1_200 ? `${rest}\n\n` : '';
  return `${lead}${where}`;
}

/**
 * Athena saved to Outputs this turn but also pasted the deliverable into her
 * reply: take the pasted copy out (any sizeable copy-paste block, and the text
 * of anything saved this turn), so the reply only says what was saved.
 * Returns the reply to show and store.
 */
export async function removeSavedCopiesFromReply(db: Pool, sessionId: string, since: Date, reply: string): Promise<string> {
  const { rows } = await db.query<{ title: string; version: number; content: string }>(
    `SELECT o.title, v.version, v.content FROM chat_output_versions v JOIN chat_outputs o ON o.id = v.output_id
      WHERE o.session_id = $1 AND v.created_at >= $2 ORDER BY v.created_at`,
    [sessionId, since],
  );
  if (rows.length === 0) return reply;
  let out = reply.replace(/```[\w-]*\n([\s\S]*?)\n```/g, (block, inner: string) => (inner.trim().length >= MIN_FENCED_CHARS ? '' : block));
  // An unfenced copy of a saved deliverable: cut from where it starts.
  for (const r of rows) {
    const start = r.content.trim().slice(0, 160);
    const at = start.length >= 60 ? out.indexOf(start) : -1;
    if (at >= 0) out = out.slice(0, at);
  }
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  if (out === reply.trim()) return reply;
  const saved = rows[rows.length - 1]!;
  const line = `Saved **${saved.title}** in Outputs${saved.version > 1 ? ` as version ${saved.version.toString()}` : ''} — open it there to copy or edit.`;
  if (out.length > 1_200) out = out.slice(0, 1_200).replace(/\s+\S*$/, '…');
  return out === '' ? line : /outputs/i.test(out) ? out : `${out}\n\n${line}`;
}
