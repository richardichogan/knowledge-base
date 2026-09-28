/**
 * Display-side stripping of the stored page-context marker.
 *
 * When a message is sent while a document is open, the backend persists it as
 * `[Viewing note: "Title"]\n<what the user typed>` (see routes/ai.ts). That
 * marker is deliberate - it keeps a later turn's RAG query anchored to the
 * document without re-injecting its whole body into history - but it is
 * plumbing, not something the user wrote, so it must never be shown back to
 * them.
 *
 * Stored data is left untouched; this only affects rendering.
 */

import type { ChatMessage } from '../types';

/**
 * Matches a leading `[Viewing <type>: "<title>"]` or `[Context: ...]` marker
 * and the newline that follows it. Anchored to the start so a bracketed phrase
 * occurring mid-message is never touched.
 */
const CONTEXT_PREFIX_RE = /^\[(?:Viewing|Context)\b[^\]]*\]\s*\n?/;

/**
 * Removes a leading page-context marker from a single piece of stored text.
 * Text without a marker is returned unchanged.
 */
export function stripContextPrefix(text: string): string {
  return text.replace(CONTEXT_PREFIX_RE, '');
}

/**
 * Removes the page-context marker from every user message in a restored
 * history, so a reloaded conversation shows exactly what was typed.
 * Assistant messages are never prefixed, so they are passed through untouched.
 */
export function stripHistoryContextPrefixes(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.role === 'user'
      ? { ...message, content: stripContextPrefix(message.content) }
      : message,
  );
}
