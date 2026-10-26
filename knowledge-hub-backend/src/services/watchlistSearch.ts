import { createHash } from 'node:crypto';
import { callTavilyMcpTool, getTavilyMcpTools, isTavilyEnabled } from '../ai/tavilyMcpClient.js';
import { parseTavilySearch } from '../ai/digestWebSearch.js';
import type { WatchProfileSource } from '../types/watchlists.js';

export interface WatchSearchArticle { id: string; title: string; body: string; url: string; published_at: Date; metadata: Record<string, unknown> }
export interface WatchSearchResult { articles: WatchSearchArticle[]; searches: number; failures: number }
export class WatchProfileResearchError extends Error {}

const RESULTS_PER_SEARCH = 8;
const DAY = 86_400_000;
const MAX_QUERY_CONTEXT = 120;
const HEX_ID_LENGTH = 32;
const UUID_SEGMENT_LENGTH = 4;
const UUID_FIRST_LENGTH = 8;
const UUID_LAST_LENGTH = 12;
const UUID_PARTS = [UUID_FIRST_LENGTH, UUID_SEGMENT_LENGTH, UUID_SEGMENT_LENGTH, UUID_SEGMENT_LENGTH, UUID_LAST_LENGTH] as const;
const WEEK_DAYS = 7;
const MONTH_DAYS = 31;

/** Each monitored name gets its own focused searches: announcements and press first, then blogs and product pages. */
export function entityQueries(name: string, context: string): Array<{ query: string; topic: 'news' | 'general' }> {
  const subject = `"${name}" ${context.slice(0, MAX_QUERY_CONTEXT)}`.trim();
  return [
    { query: `${subject} press release announcement`, topic: 'news' },
    { query: `${subject} blog product update new offering`, topic: 'general' },
  ];
}

function articleId(url: string): string {
  const hex = createHash('sha256').update(url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()).digest('hex').slice(0, HEX_ID_LENGTH);
  let offset = 0;
  return UUID_PARTS.map(length => { const part = hex.slice(offset, offset + length); offset += length; return part; }).join('-');
}

export function profileSources(raw: unknown, retrievedAt: string): WatchProfileSource[] {
  const sources = new Map<string, WatchProfileSource>();
  for (const hit of parseTavilySearch(raw)) {
    if (!hit.content) continue;
    const id = articleId(hit.url);
    const published = hit.publishedAt ? new Date(hit.publishedAt) : null;
    sources.set(id, {
      id, title: hit.title, url: hit.url, excerpt: hit.content, retrievedAt,
      publishedAt: published && Number.isFinite(published.getTime()) ? published.toISOString() : null,
    });
  }
  return [...sources.values()].slice(0, RESULTS_PER_SEARCH);
}

/** Background references have no news window; an undated product page is not a new announcement. */
export async function searchCompanyProfile(name: string, context: string): Promise<WatchProfileSource[]> {
  if (!isTavilyEnabled()) throw new WatchProfileResearchError('Background research is unavailable because web search is not configured.');
  const tool = (await getTavilyMcpTools()).find(t => t.function.name === 'tavily_search');
  if (!tool) throw new WatchProfileResearchError('Background research could not connect to web search. Existing knowledge is retained.');
  const props = (tool.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  const args: Record<string, unknown> = {
    query: `"${name}" ${context.slice(0, MAX_QUERY_CONTEXT)} official overview products services capabilities`,
  };
  if ('max_results' in props) args['max_results'] = RESULTS_PER_SEARCH;
  if ('topic' in props) args['topic'] = 'general';
  const raw = await callTavilyMcpTool('tavily_search', args);
  if (typeof raw === 'object' && raw !== null && 'error' in raw) {
    throw new WatchProfileResearchError('Background web research failed. Existing knowledge is retained; Run now retries it.');
  }
  const sources = profileSources(raw, new Date().toISOString());
  if (!sources.length) throw new WatchProfileResearchError('Background research found no usable source excerpts. Further research is needed; existing knowledge is retained.');
  return sources;
}

async function searchArgs(query: string, topic: 'news' | 'general', windowStart: Date, now: Date): Promise<Record<string, unknown>> {
  const tool = (await getTavilyMcpTools()).find(t => t.function.name === 'tavily_search');
  const props = (tool?.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const has = (key: string): boolean => key in props;
  const days = Math.max(1, Math.ceil((now.getTime() - windowStart.getTime()) / DAY));
  const args: Record<string, unknown> = { query };
  if (has('max_results')) args['max_results'] = RESULTS_PER_SEARCH;
  if (has('topic')) args['topic'] = topic;
  if (has('start_date') && has('end_date')) {
    args['start_date'] = windowStart.toISOString().slice(0, 'YYYY-MM-DD'.length);
    args['end_date'] = now.toISOString().slice(0, 'YYYY-MM-DD'.length);
  } else if (has('time_range')) args['time_range'] = days <= 1 ? 'day' : days <= WEEK_DAYS ? 'week' : days <= MONTH_DAYS ? 'month' : 'year';
  else if (has('days')) args['days'] = days;
  return args;
}

/** Undated hits are dropped: without a date they cannot be shown to be new in the monitored window. */
export async function searchWatchEntities(entities: Array<{ name: string }>, context: string, windowStart: Date, now: Date,
  enabled: () => boolean = isTavilyEnabled): Promise<WatchSearchResult> {
  const result: WatchSearchResult = { articles: [], searches: 0, failures: 0 };
  if (!enabled()) return result;
  const seen = new Set<string>();
  for (const entity of entities) {
    for (const { query, topic } of entityQueries(entity.name, context)) {
      result.searches++;
      try {
        const raw = await callTavilyMcpTool('tavily_search', await searchArgs(query, topic, windowStart, now));
        if (typeof raw === 'object' && raw !== null && 'error' in raw) throw new Error(String((raw as { error: unknown }).error));
        for (const hit of parseTavilySearch(raw)) {
          const published = hit.publishedAt ? new Date(hit.publishedAt) : null;
          if (!published || !Number.isFinite(published.getTime()) || published < windowStart || published > now) continue;
          const id = articleId(hit.url);
          if (seen.has(id)) continue;
          seen.add(id);
          result.articles.push({ id, title: hit.title, body: hit.content, url: hit.url, published_at: published, metadata: { origin: 'web-search' } });
        }
      } catch (error) {
        result.failures++;
        console.warn(`[Watchlists] web search "${query}" failed:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return result;
}
