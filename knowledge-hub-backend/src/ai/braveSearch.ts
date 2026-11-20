import { env } from '../config/env.js';
import { rethrowAssignmentControl, withAssignmentResearch } from '../agents/workforce/modelBudget.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const FRESHNESS: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function searchBrave(args: Record<string, unknown>, fetchSearch = fetch): Promise<unknown> {
  const key = env.BRAVE_SEARCH_API_KEY;
  if (!key) return { error: 'Brave Search is not configured.' };
  if (typeof args.query !== 'string' || !args.query.trim()) return { error: 'A public search query is required.' };
  const domains = Array.isArray(args.include_domains) ? args.include_domains : [];
  if (!domains.every((domain): domain is string => typeof domain === 'string' && HOST.test(domain))) {
    return { error: 'Brave Search could not apply the requested source domains.' };
  }
  const excluded = Array.isArray(args.exclude_domains) ? args.exclude_domains : [];
  if (!excluded.every((domain): domain is string => typeof domain === 'string' && HOST.test(domain))) {
    return { error: 'Brave Search could not apply the excluded source domains.' };
  }
  const url = new URL(ENDPOINT);
  const siteFilter = domains.length ? ` (${domains.map(domain => `site:${domain}`).join(' OR ')})` : '';
  url.searchParams.set('q', `${args.query}${siteFilter}${excluded.map(domain => ` -site:${domain}`).join('')}`);
  const count = typeof args.max_results === 'number' && Number.isFinite(args.max_results)
    ? Math.max(1, Math.min(20, Math.trunc(args.max_results))) : 5;
  url.searchParams.set('count', String(count));
  if (typeof args.start_date === 'string' && ISO_DAY.test(args.start_date)
    && typeof args.end_date === 'string' && ISO_DAY.test(args.end_date)) {
    url.searchParams.set('freshness', `${args.start_date}to${args.end_date}`);
  } else if (typeof args.time_range === 'string' && Object.hasOwn(FRESHNESS, args.time_range)) {
    url.searchParams.set('freshness', FRESHNESS[args.time_range]!);
  }

  try {
    return await withAssignmentResearch(async signal => {
      const timeout = AbortSignal.timeout(8_000);
      const response = await fetchSearch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
      if (!response.ok) return { error: `Brave Search returned HTTP ${response.status}.` };
      const result = await response.json() as { web?: { results?: Array<{
        url?: string; title?: string; description?: string; page_age?: string;
      }> } };
      const matches = (hostname: string, domain: string): boolean =>
        hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`);
      const results = (result.web?.results ?? []).flatMap(hit => {
        if (typeof hit?.url !== 'string' || typeof hit.title !== 'string' || typeof hit.description !== 'string') return [];
        let link: URL;
        try { link = new URL(hit.url); } catch { return []; }
        if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password
          || (domains.length && !domains.some(domain => matches(link.hostname, domain)))
          || excluded.some(domain => matches(link.hostname, domain))) return [];
        return [{ url: link.href, title: hit.title, content: hit.description,
          ...(typeof hit.page_age === 'string' ? { published_date: hit.page_age } : {}) }];
      });
      return { result: JSON.stringify({ provider: 'brave', results }) };
    });
  } catch (error) {
    rethrowAssignmentControl(error);
    return { error: 'Brave Search could not complete the request.' };
  }
}
