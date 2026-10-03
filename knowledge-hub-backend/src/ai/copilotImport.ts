/**
 * ai/copilotImport.ts — notes whose title starts "M365 Copilot Import:" are summaries written by M365
 * Copilot (Richard cannot connect M365 to Athena, so he pastes them in). They are good for recovering his
 * thinking, but they are a reconstruction, not a record of who agreed what.
 */

const TITLE_PREFIX = /^\s*M365 Copilot Import\s*:/i;

export function isCopilotImport(title: string | null | undefined): boolean {
  return title !== null && title !== undefined && TITLE_PREFIX.test(title);
}

/** Added next to such a note wherever it reaches Athena (open in Think, or found by search). */
export const COPILOT_IMPORT_CAUTION =
  'Source status: an M365 Copilot summary — a reconstruction written by Copilot, not a primary record. Use it for ' +
  'his thinking, structure and direction. Attribute it ("this note says…"), never state that a meeting decided, ' +
  'agreed or approved something, or that a named person said it, on its strength alone, and say what primary ' +
  'source (transcript, email, deck markup) would confirm it.';
