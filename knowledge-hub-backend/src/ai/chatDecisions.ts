/**
 * ai/chatDecisions.ts — a running list of what's been decided and what's
 * still open in a chat (the Decisions panel). Updated after each exchange
 * by a small model call (on by default for the specialist personas), edited
 * by the user, and given to Athena so prompts and specs she writes include
 * every agreed point.
 */
import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';

export type DecisionStatus = 'decided' | 'open';

export interface ChatDecision {
  id: string;
  status: DecisionStatus;
  text: string;
  source: 'auto' | 'user';
  createdAt: string;
  updatedAt: string;
}

/** Personas where decisions are tracked unless the chat turns it off. */
const TRACKED_BY_DEFAULT = new Set(['demo_designer', 'brainstorming', 'blog_post', 'podcast_prep']);
const MAX_DECISIONS = 40;

function toDecision(r: { id: string; status: DecisionStatus; text: string; source: 'auto' | 'user'; created_at: Date; updated_at: Date }): ChatDecision {
  return { id: r.id, status: r.status, text: r.text, source: r.source, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
}

export async function listDecisions(db: Pool, sessionId: string): Promise<ChatDecision[]> {
  const { rows } = await db.query<{ id: string; status: DecisionStatus; text: string; source: 'auto' | 'user'; created_at: Date; updated_at: Date }>(
    `SELECT id::text, status, text, source, created_at, updated_at FROM chat_decisions WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  return rows.map(toDecision);
}

export async function addDecision(db: Pool, sessionId: string, status: DecisionStatus, text: string, source: 'auto' | 'user'): Promise<ChatDecision> {
  await db.query(`INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);
  const { rows } = await db.query<{ id: string; status: DecisionStatus; text: string; source: 'auto' | 'user'; created_at: Date; updated_at: Date }>(
    `INSERT INTO chat_decisions (session_id, status, text, source) VALUES ($1, $2, $3, $4)
     RETURNING id::text, status, text, source, created_at, updated_at`,
    [sessionId, status, text.trim(), source],
  );
  return toDecision(rows[0]!);
}

export async function updateDecision(db: Pool, id: string, patch: { status?: DecisionStatus | undefined; text?: string | undefined }): Promise<void> {
  await db.query(
    `UPDATE chat_decisions SET status = COALESCE($2, status), text = COALESCE($3, text), updated_at = NOW() WHERE id = $1`,
    [id, patch.status ?? null, patch.text?.trim() || null],
  );
}

export async function deleteDecision(db: Pool, id: string): Promise<void> {
  await db.query(`DELETE FROM chat_decisions WHERE id = $1`, [id]);
}

/** Whether this chat keeps a decisions list: its own setting, else the persona default. */
export async function isTrackingDecisions(db: Pool, sessionId: string): Promise<{ enabled: boolean; explicit: boolean | null; personaDefault: boolean }> {
  const { rows } = await db.query<{ track_decisions: boolean | null; persona: string | null }>(
    `SELECT track_decisions, persona FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  const explicit = rows[0]?.track_decisions ?? null;
  const personaDefault = TRACKED_BY_DEFAULT.has(rows[0]?.persona ?? 'general');
  return { enabled: explicit ?? personaDefault, explicit, personaDefault };
}

export async function setTrackingDecisions(db: Pool, sessionId: string, enabled: boolean | null): Promise<void> {
  await db.query(
    `INSERT INTO ai_chat_sessions (id, track_decisions) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET track_decisions = EXCLUDED.track_decisions`,
    [sessionId, enabled],
  );
}

/** The decisions list for Athena's context ('' when empty). */
export async function buildDecisionsBlock(db: Pool, sessionId: string): Promise<string> {
  const decisions = await listDecisions(db, sessionId);
  if (decisions.length === 0) return '';
  const decided = decisions.filter((d) => d.status === 'decided');
  const open = decisions.filter((d) => d.status === 'open');
  return [
    '## Decisions so far in this chat (the Decisions panel, kept with him)',
    decided.length > 0
      ? `Decided — agreed with him; treat as settled and include every one in any prompt, spec or summary you write:\n${decided.map((d) => `- ${d.text}`).join('\n')}`
      : '',
    open.length > 0 ? `Open — still need his answer; don't assume them:\n${open.map((d) => `- ${d.text}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

type DecisionOp =
  | { op: 'add'; status: DecisionStatus; text: string }
  | { op: 'resolve'; id: string; text?: string }
  | { op: 'update'; id: string; text: string }
  | { op: 'remove'; id: string };

/**
 * Updates the list from the latest exchange (a small gpt-4o call). Returns
 * true if anything changed. Never throws — the list is a convenience.
 */
export async function updateDecisionsFromExchange(db: Pool, sessionId: string, userMessage: string, reply: string): Promise<boolean> {
  try {
    const current = await listDecisions(db, sessionId);
    const alias = new Map(current.map((d, i) => [`d${(i + 1).toString()}`, d]));
    const listText = current.length === 0
      ? '(empty)'
      : [...alias.entries()].map(([a, d]) => `${a} [${d.status}${d.source === 'user' ? ', added by him' : ''}] ${d.text}`).join('\n');
    const raw = await getFoundryClient().chat('gpt-4o', [
      {
        role: 'system',
        content: [
          'You keep a running decisions log for a working chat between Richard and his assistant Athena.',
          'Given the current log and the latest exchange, return ONLY JSON: {"ops": [...]} where each op is one of',
          '{"op":"add","status":"decided"|"open","text":"…"}, {"op":"resolve","id":"d3","text":"what was decided"},',
          '{"op":"update","id":"d2","text":"…"}, {"op":"remove","id":"d4"}.',
          'Record only real decisions (something he agreed to, chose or instructed, or a proposal he accepted) and',
          'genuinely open questions that need his answer. Not Athena\'s suggestions he hasn\'t accepted, not general facts.',
          'One short, specific line each (under 25 words), plain English, no duplicates of existing items.',
          'Resolve an open item when he answers it; update an item when he changes it; remove only items he explicitly',
          'dropped, and never items added by him. If nothing changed, return {"ops": []}.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Current log:\n${listText}\n\nLatest exchange:\nRichard: ${userMessage.slice(0, 3_000)}\n\nAthena: ${reply.slice(0, 6_000)}`,
      },
    ], 1_200);
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const ops = (JSON.parse(json) as { ops?: DecisionOp[] }).ops ?? [];
    let changed = false;
    let count = current.length;
    for (const op of ops) {
      if (op.op === 'add' && (op.status === 'decided' || op.status === 'open') && typeof op.text === 'string' && op.text.trim() !== '' && count < MAX_DECISIONS) {
        await addDecision(db, sessionId, op.status, op.text, 'auto');
        count += 1;
        changed = true;
        continue;
      }
      const target = 'id' in op ? alias.get(op.id) : undefined;
      if (target === undefined) continue;
      if (op.op === 'resolve') {
        await updateDecision(db, target.id, { status: 'decided', text: op.text });
        changed = true;
      } else if (op.op === 'update' && typeof op.text === 'string') {
        await updateDecision(db, target.id, { text: op.text });
        changed = true;
      } else if (op.op === 'remove' && target.source !== 'user') {
        await deleteDecision(db, target.id);
        changed = true;
      }
    }
    return changed;
  } catch (err) {
    console.warn('[decisions] update failed:', err);
    return false;
  }
}
