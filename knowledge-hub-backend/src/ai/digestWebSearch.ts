/**
 * ai/digestWebSearch.ts — web search for the Monday Microsoft digest.
 *
 * Discover only knows what its feeds publish. This searches the web (Tavily) for the digest week's
 * Microsoft and GitHub announcements, mostly on official Microsoft/GitHub sites, so updates no
 * feed carried still make the round-up. Results outside the week, or already in Discover, are dropped.
 */
import { callTavilyMcpTool, getTavilyMcpTools, isTavilyEnabled } from './tavilyMcpClient.js';

export interface DigestWindow {
  /** Inclusive start (Monday 00:00 UK). */
  start: Date;
  /** Exclusive end (the following Monday 00:00 UK). */
  end: Date;
  /** YYYY-MM-DD of the Monday and the Sunday, UK dates. */
  firstDay: string;
  lastDay: string;
}

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
  publishedAt: string | null;
}

const OFFICIAL_DOMAINS = [
  'microsoft.com', 'blogs.microsoft.com', 'news.microsoft.com', 'azure.microsoft.com', 'techcommunity.microsoft.com',
  'devblogs.microsoft.com', 'learn.microsoft.com', 'powerplatform.microsoft.com', 'cloudblogs.microsoft.com',
  'github.blog', 'github.com',
];

/** Each search covers one area; `official: false` also looks at independent press for the week's big stories. */
export const DIGEST_SEARCHES: Array<{ query: string; official: boolean }> = [
  { query: 'Microsoft Azure announcements and new features', official: true },
  { query: 'Microsoft 365 Copilot and Copilot Studio updates', official: true },
  { query: 'Microsoft Foundry Azure OpenAI AI agents announcements', official: true },
  { query: 'Microsoft security Defender Entra Sentinel Purview updates', official: true },
  { query: 'Microsoft Fabric Power Platform Dynamics 365 updates', official: true },
  { query: 'Microsoft Teams SharePoint Windows Intune enterprise updates', official: true },
  { query: 'GitHub Copilot and GitHub platform announcements', official: true },
  { query: 'Microsoft announces', official: false },
  { query: 'Microsoft Azure outage retirement pricing change', official: false },
];
const RESULTS_PER_SEARCH = 8;
const MAX_HITS = 40;
const CONTENT_CHARS = 400;
const CONCURRENCY = 3;

/** Normalises a URL for dedupe: no scheme, www, query, hash, or trailing slash; lower-case. */
export function normaliseDigestUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function asHit(r: Record<string, unknown>): WebSearchHit | null {
  const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
  const url = typeof r['url'] === 'string' ? r['url'].trim() : '';
  if (title === '' || !/^https?:\/\//i.test(url)) return null;
  const content = typeof r['content'] === 'string' ? r['content'] : '';
  const date = r['published_date'] ?? r['publishedDate'] ?? r['published_at'];
  return { title, url, content: content.replace(/\s+/g, ' ').trim().slice(0, CONTENT_CHARS), publishedAt: typeof date === 'string' && date !== '' ? date : null };
}

/** Reads a tavily_search result: JSON ({results: [...]}) or the text layout ("Title: / URL: / Content:"). */
export function parseTavilySearch(raw: unknown): WebSearchHit[] {
  const text = typeof raw === 'object' && raw !== null && 'result' in raw ? (raw as { result: unknown }).result : raw;
  if (typeof text !== 'string') {
    const list = (text as { results?: unknown } | null)?.results;
    return Array.isArray(list) ? list.flatMap((r) => { const h = asHit(r as Record<string, unknown>); return h === null ? [] : [h]; }) : [];
  }
  try {
    const parsed = JSON.parse(text) as { results?: unknown };
    if (Array.isArray(parsed.results)) {
      return parsed.results.flatMap((r) => { const h = asHit(r as Record<string, unknown>); return h === null ? [] : [h]; });
    }
  } catch { /* text layout */ }
  const hits: WebSearchHit[] = [];
  for (const block of text.split(/\n(?=Title:)/)) {
    const field = (name: string): string => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(block)?.[1]?.trim() ?? '';
    const hit = asHit({ title: field('Title'), url: field('URL'), content: field('Content'), published_date: field('Published Date') || field('Published') });
    if (hit !== null) hits.push(hit);
  }
  return hits;
}

/** True when the hit is dated inside the window. Undated official pages are kept; undated press is not. */
export function inWindow(hit: WebSearchHit, window: DigestWindow, official: boolean): boolean {
  if (hit.publishedAt === null) return official;
  const t = new Date(hit.publishedAt).getTime();
  if (!Number.isFinite(t)) return official;
  return t >= window.start.getTime() && t < window.end.getTime();
}

/** Only the arguments this Tavily server's tavily_search accepts (its schema has changed over time). */
async function searchArgs(query: string, official: boolean, window: DigestWindow): Promise<Record<string, unknown>> {
  const tool = (await getTavilyMcpTools()).find((t) => t.function.name === 'tavily_search');
  const props = (tool?.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const has = (k: string): boolean => k in props;
  const args: Record<string, unknown> = { query: has('start_date') ? query : `${query} ${window.firstDay} to ${window.lastDay}` };
  if (has('max_results')) args['max_results'] = RESULTS_PER_SEARCH;
  if (has('topic')) args['topic'] = official ? 'general' : 'news';
  if (has('start_date') && has('end_date')) {
    args['start_date'] = window.firstDay;
    args['end_date'] = window.lastDay;
  } else if (has('time_range')) {
    args['time_range'] = 'week';
  } else if (has('days')) {
    args['days'] = 8;
  }
  if (official && has('include_domains')) args['include_domains'] = OFFICIAL_DOMAINS;
  return args;
}

/**
 * Searches the web for the window's Microsoft/GitHub updates. Returns [] when Tavily isn't configured
 * or every search fails, so the digest still runs on Discover alone.
 */
export async function searchDigestWeek(window: DigestWindow, knownUrls: Iterable<string>): Promise<WebSearchHit[]> {
  if (!isTavilyEnabled()) return [];
  const seen = new Set([...knownUrls].map(normaliseDigestUrl));
  const hits: WebSearchHit[] = [];
  let failures = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < DIGEST_SEARCHES.length) {
      const { query, official } = DIGEST_SEARCHES[next++]!;
      const raw = await callTavilyMcpTool('tavily_search', await searchArgs(query, official, window));
      if (typeof raw === 'object' && raw !== null && 'error' in raw) {
        failures++;
        console.warn(`[WeeklyDigest] web search "${query}" failed: ${String((raw as { error: unknown }).error)}`);
        continue;
      }
      for (const hit of parseTavilySearch(raw)) {
        const key = normaliseDigestUrl(hit.url);
        if (seen.has(key) || !inWindow(hit, window, official)) continue;
        seen.add(key);
        hits.push(hit);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.warn(`[WeeklyDigest] web search: ${hits.length.toString()} new update(s) from ${DIGEST_SEARCHES.length.toString()} searches (${failures.toString()} failed)`);
  return hits.slice(0, MAX_HITS);
}
