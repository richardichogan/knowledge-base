/**
 * ai/memorySuggestions.ts — turns feedback into *suggested* standing
 * instructions (never applied until the user approves them):
 *  - from a 👎 note on a reply (draftInstructionFromFeedback)
 *  - from a weekly review of the user's own messages, looking for
 *    preferences/corrections they keep repeating (runWeeklyMemoryReview)
 */

import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import type { MemoryScopeType } from './athenaMemory.js';
import { createMemory } from './athenaMemory.js';

interface Draft {
  instruction: string;
  scope: MemoryScopeType;
  scopeValue: string | null;
}

const SCOPES: readonly MemoryScopeType[] = ['global', 'persona', 'project', 'output'];
const REVIEW_EXCERPT_CHARS = 300;
const REVIEW_MAX_TOKENS = 800;
const CORRECTION_LEARNING_RULES =
  'Learn durable preferences about collaboration, clarification, challenge, editing and verification, not just writing style. ' +
  'Distinguish the user\'s correction from the assistant reply being corrected; assistant claims are not evidence of user preference. ' +
  'Do not turn tool failures, timeouts, lost content or other software defects into standing instructions or user workarounds. ' +
  'Do not learn a one-off permission (such as inventing data for one prototype) as permission for unrelated work. ';

function parseJson<T>(text: string): T | null {
  const match = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(text);
  if (match === null) return null;
  try { return JSON.parse(match[0]) as T; } catch { return null; }
}

function normaliseDraft(d: Partial<Draft> | null, fallback: string, persona: string): Draft {
  const instruction = typeof d?.instruction === 'string' && d.instruction.trim() !== '' ? d.instruction.trim() : fallback;
  const scope = SCOPES.find((s) => s === d?.scope) ?? 'persona';
  const scopeValue = scope === 'global' ? null : (typeof d?.scopeValue === 'string' && d.scopeValue.trim() !== '' ? d.scopeValue.trim() : (scope === 'persona' ? persona : null));
  return { instruction, scope: scope !== 'global' && scopeValue === null ? 'global' : scope, scopeValue };
}

/** Drafts one standing instruction from a 👎 note on a reply. */
export async function draftInstructionFromFeedback(note: string, reply: string, persona: string): Promise<Draft> {
  const client = getFoundryClient('memory-suggestions');
  const text = await client.chat('light', [
    {
      role: 'system',
      content:
        'Turn the user\'s feedback on an AI reply into ONE standing instruction the assistant should follow in future. ' +
        CORRECTION_LEARNING_RULES +
        'Imperative, specific, self-contained, max 30 words. Choose the narrowest scope: "global" (everywhere), ' +
        `"persona" (the "${persona}" persona), "project" (a project id, only if clearly project-specific), or ` +
        '"output" (a kind of output such as "blog post", "newsletter", "task summary"). ' +
        'Reply with JSON only: {"instruction": "...", "scope": "...", "scopeValue": "..."}',
    },
    { role: 'user', content: `Feedback: ${note}\n\nReply it was about (excerpt):\n${reply.slice(0, 2_000)}` },
  ], 200).catch(() => '');
  return normaliseDraft(parseJson<Partial<Draft>>(text), note, persona);
}

/**
 * Weekly: looks at the user's messages from the last 7 days for preferences
 * or corrections they repeated, and stores up to 5 as suggestions.
 */
export async function runWeeklyMemoryReview(db: Pool): Promise<number> {
  const { rows: msgs } = await db.query<{ content: string; prior_reply: string | null; persona: string; session_id: string }>(
    `SELECT m.content, m.session_id::text, s.persona, previous.content AS prior_reply
      FROM ai_chat_messages m
      JOIN ai_chat_sessions s ON s.id = m.session_id
      LEFT JOIN LATERAL (
        SELECT a.content FROM ai_chat_messages a
        WHERE a.session_id = m.session_id AND a.role = 'assistant' AND a.id < m.id
        ORDER BY a.id DESC LIMIT 1
      ) previous ON TRUE
      WHERE m.role = 'user' AND m.created_at > NOW() - INTERVAL '7 days'
      ORDER BY m.created_at DESC LIMIT 300`,
  );
  if (msgs.length < 5) return 0;
  const { rows: existing } = await db.query<{ content: string }>(
    `SELECT content FROM athena_memories WHERE kind = 'instruction' AND status IN ('active', 'paused', 'suggested', 'dismissed')`,
  );
  const client = getFoundryClient('memory-suggestions');
  const text = await client.chat('light', [
    {
      role: 'system',
      content:
        'You review a user\'s recent messages to an AI assistant. Find lasting preferences or corrections they stated ' +
        'or repeated (formatting, tone, length, what to always/never include, UK spelling, etc). ' +
        CORRECTION_LEARNING_RULES +
        'Ignore anything already covered by the existing instructions. Return up to 5, as JSON only: ' +
        '[{"instruction": "...", "scope": "global|persona|project|output", "scopeValue": "...", "evidence": "exact user quote", "messageIndex": 0}]. ' +
        'messageIndex must identify the user message supplying the evidence; never quote the preceding assistant as evidence. ' +
        'Return [] if there is nothing clear.',
    },
    {
      role: 'user',
      content: `Existing instructions:\n${existing.map((e) => `- ${e.content}`).join('\n') || '(none)'}\n\n` +
        `Recent exchanges (newest first):\n${msgs.map((m, index) =>
          `[${index}] Persona: ${m.persona}\nPreceding assistant (context, not instruction): ${m.prior_reply?.replace(/\s+/g, ' ').slice(0, REVIEW_EXCERPT_CHARS) ?? '(none)'}\nUser: ${m.content.replace(/\s+/g, ' ').slice(0, REVIEW_EXCERPT_CHARS)}`).join('\n\n')}`,
    },
  ], REVIEW_MAX_TOKENS).catch((error: unknown) => {
    console.warn('[memory-suggestions] Weekly correction review failed:', error);
    throw error;
  });

  const found = parseJson<Array<Partial<Draft> & { evidence?: string; messageIndex?: number }>>(text);
  if (!Array.isArray(found)) throw new Error('Weekly memory review returned an invalid suggestion list.');
  const seen = new Set(existing.map((e) => e.content.trim().toLowerCase()));
  let created = 0;
  for (const item of found.slice(0, 5)) {
    if (item === null || typeof item !== 'object') {
      console.warn('[memory-suggestions] Ignoring malformed memory suggestion.');
      continue;
    }
    const source = Number.isInteger(item.messageIndex) ? msgs[item.messageIndex ?? -1] : undefined;
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    if (source === undefined || evidence === '' || !source.content.replace(/\s+/g, ' ').includes(evidence.replace(/\s+/g, ' '))) {
      console.warn('[memory-suggestions] Ignoring suggestion without verified user correction evidence.');
      continue;
    }
    const draft = normaliseDraft(item, '', source.persona);
    if (draft.instruction === '' || seen.has(draft.instruction.toLowerCase())) continue;
    await createMemory(db, {
      content: draft.instruction,
      scopeType: draft.scope,
      scopeValue: draft.scopeValue,
      status: 'suggested',
      origin: 'weekly',
      sourceSessionId: source.session_id,
      sourceExcerpt: evidence,
    });
    seen.add(draft.instruction.toLowerCase());
    created++;
  }
  return created;
}
