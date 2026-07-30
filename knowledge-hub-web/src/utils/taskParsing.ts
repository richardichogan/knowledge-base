/**
 * Parses free-form selected text into one or more task drafts.
 *
 * If the text looks like a list (multiple non-empty lines), each line becomes
 * its own task (bullet/numbering markers stripped). Otherwise the whole
 * block becomes a single task, with a truncated title and the full text as body.
 */

const TITLE_MAX_LEN = 120;
const BULLET_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s*/;

function truncateTitle(text: string): string {
  return text.length > TITLE_MAX_LEN ? `${text.slice(0, TITLE_MAX_LEN)}…` : text;
}

export interface ParsedTaskDraft {
  title: string;
  body: string;
}

export function parseTasksFromText(text: string): ParsedTaskDraft[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET_PREFIX, '').trim())
    .filter((line) => line.length > 0);

  if (lines.length <= 1) {
    const full = text.trim();
    return [{ title: truncateTitle(full), body: full }];
  }

  return lines.map((line) => ({ title: truncateTitle(line), body: line }));
}
