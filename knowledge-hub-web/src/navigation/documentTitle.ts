import { PRIMARY_DESTINATIONS, matchesDestination, selectedTool } from './destinations';

export const APP_TITLE = 'Athena';
const SEPARATOR = ' · ';
const MAX_PART_LENGTH = 60;

const STANDALONE_SECTIONS: Record<string, string> = {
  '/chat': 'Chat',
  '/autocue': 'Autocue',
};

export function formatTitleDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** The workspace or tool name for a route, e.g. "Think" or "Knowledge health". */
export function sectionTitle(pathname: string, search: string): string | undefined {
  const standalone = Object.entries(STANDALONE_SECTIONS).find(([path]) => matchesDestination(pathname, path));
  if (standalone) return standalone[1];
  const tool = selectedTool(pathname, search);
  if (tool) return tool.label;
  return PRIMARY_DESTINATIONS.find((item) => item.path !== undefined
    && (item.path === '/' ? pathname === '/' : matchesDestination(pathname, item.path)))?.label;
}

function truncate(part: string): string {
  return part.length > MAX_PART_LENGTH ? `${part.slice(0, MAX_PART_LENGTH - 1).trimEnd()}…` : part;
}

/**
 * Builds the browser tab title, most specific first so it survives tab
 * truncation: "Meeting with Dhalia · Notes · Think · Athena".
 * Empty and repeated parts (e.g. a view named like its section) are dropped.
 */
export function buildDocumentTitle(parts: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>([APP_TITLE.toLowerCase()]);
  const kept: string[] = [];
  for (const raw of parts) {
    const part = raw?.replace(/\s+/g, ' ').trim();
    if (!part) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(truncate(part));
  }
  return [...kept, APP_TITLE].join(SEPARATOR);
}
