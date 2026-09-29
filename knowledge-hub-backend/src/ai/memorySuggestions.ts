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
  const client = getFoundryClient();
  const text = await client.chat('gpt-4o-mini', [
    {
      role: 'system',
      content:
        'Turn the user\'s feedback on an AI reply into ONE standing instruction the assistant should follow in future. ' +
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
  const { rows: msgs } = await db.query<{ content: string }>(
    `SELECT m.content FROM ai_chat_messages m
      WHERE m.role = 'user' AND m.created_at > NOW() - INTERVAL '7 days'
      ORDER BY m.created_at DESC LIMIT 300`,
  );
  if (msgs.length < 5) return 0;
  const { rows: existing } = await db.query<{ content: string }>(
    `SELECT content FROM athena_memories WHERE kind = 'instruction' AND status IN ('active', 'paused', 'suggested', 'dismissed')`,
  );
  const client = getFoundryClient();
  const text = await client.chat('gpt-4o-mini', [
    {
      role: 'system',
      content:
        'You review a user\'s recent messages to an AI assistant. Find lasting preferences or corrections they stated ' +
        'or repeated (formatting, tone, length, what to always/never include, UK spelling, etc). Ignore one-off requests ' +
        'and anything already covered by the existing instructions. Return up to 5, as JSON only: ' +
        '[{"instruction": "...", "scope": "global|persona|project|output", "scopeValue": "...", "evidence": "short quote"}]. ' +
        'Return [] if there is nothing clear.',
    },
    {
      role: 'user',
      content: `Existing instructions:\n${existing.map((e) => `- ${e.content}`).join('\n') || '(none)'}\n\n` +
        `Recent messages (newest first):\n${msgs.map((m) => `- ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`,
    },
  ], 800).catch(() => '[]');

  const found = parseJson<Array<Partial<Draft> & { evidence?: string }>>(text) ?? [];
  const seen = new Set(existing.map((e) => e.content.trim().toLowerCase()));
  let created = 0;
  for (const item of found.slice(0, 5)) {
    const draft = normaliseDraft(item, '', 'general');
    if (draft.instruction === '' || seen.has(draft.instruction.toLowerCase())) continue;
    await createMemory(db, {
      content: draft.instruction,
      scopeType: draft.scope,
      scopeValue: draft.scopeValue,
      status: 'suggested',
      origin: 'weekly',
      sourceExcerpt: typeof item.evidence === 'string' ? item.evidence : null,
    });
    seen.add(draft.instruction.toLowerCase());
    created++;
  }
  return created;
}
