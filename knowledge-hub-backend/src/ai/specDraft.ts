/**
 * ai/specDraft.ts — turns a chat into the first draft of a spec note: what the
 * conversation established, laid out in spec sections, ready to be iterated on
 * in Think with Athena proposing edits. Faithful to the conversation — it
 * records what was said and marks what hasn't been discussed; it invents nothing.
 */
import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import { getOrCreateSessionHistory } from './chatSessionStore.js';
import { listDecisions } from './chatDecisions.js';
import { listOutputs } from './chatOutputs.js';

const MAX_MESSAGE_CHARS = 3_500;
const MAX_TRANSCRIPT_CHARS = 90_000;
const SPEC_MAX_TOKENS = 7_000;

const SYSTEM = `You turn a working conversation between Richard and his assistant Athena into the FIRST DRAFT of a spec note that they will keep refining. Write Markdown for UK English readers.

Rules:
- Use ONLY what the conversation establishes. Do not invent requirements, users, numbers, names or decisions. Where something has not been discussed, write one line: _Not discussed yet._ — never fill a gap with a guess.
- Record Richard's own conclusions as decisions; record suggestions Athena made that he did not accept as options or open questions, not decisions.
- Keep source links that the conversation used (for example an article it reviewed) in a "Sources" section, as Markdown links.
- Be specific and concise: short paragraphs and bullets, no filler, no meta commentary about the chat.

Structure (keep these headings, in this order):
# <a clear title for the use case or product, ending "— spec">
## Summary
Two or three sentences: what this is, and why it matters.
## Why it fits
How it relates to the project, product or direction discussed, including any reasoning about fit or where the headline could mislead.
## Users and their needs
## What it does
The capabilities, in plain terms. Add user stories ("As a …, I want …, so that …") only where the conversation supports them.
## Screens and flow
## Data and integrations
## Governance, risks and dependencies
## Decisions so far
A bullet per settled decision.
## Open questions
A bullet per question that still needs an answer.
## Next steps
## Sources

Return ONLY the Markdown.`;

export async function draftSpecFromSession(db: Pool, sessionId: string): Promise<{ title: string; markdown: string }> {
  const history = await getOrCreateSessionHistory(db, sessionId);
  if (history.length === 0) throw new Error('This chat has no messages yet.');

  // The opening message plus the most recent exchange, each trimmed, within a total budget.
  const lines = history.map((m) => `${m.role === 'user' ? 'Richard' : 'Athena'}: ${m.content.replace(/^\[Viewing[^\n]*\]\n?/, '').slice(0, MAX_MESSAGE_CHARS)}`);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i]!.length;
    if (total > MAX_TRANSCRIPT_CHARS && i > 0) break;
    kept.unshift(lines[i]!);
  }
  if (kept.length < lines.length && lines[0] !== undefined && kept[0] !== lines[0]) kept.unshift(lines[0], '[… earlier messages omitted …]');

  const decisions = await listDecisions(db, sessionId);
  const outputs = await listOutputs(db, sessionId);
  const extras = [
    decisions.length > 0
      ? `Decisions panel (kept with Richard during the chat):\n${decisions.map((d) => `- [${d.status}] ${d.text}`).join('\n')}`
      : '',
    outputs.length > 0 ? `Outputs saved in the chat: ${outputs.map((o) => o.title).join('; ')}` : '',
  ].filter(Boolean).join('\n\n');

  const raw = await getFoundryClient().chatBulk(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${extras !== '' ? `${extras}\n\n---\n\n` : ''}Conversation:\n\n${kept.join('\n\n')}` },
    ],
    SPEC_MAX_TOKENS,
    180_000,
  );
  const markdown = raw.trim().replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '').trim();
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? 'Spec';
  return { title, markdown };
}
