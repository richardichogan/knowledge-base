import { decodeEntities, fetchPublic } from '../integrations/discovery/feedReader.js';
import { parseTavilySearch } from './digestWebSearch.js';
import { callTavilyMcpTool, getTavilyMcpTools, isTavilyEnabled } from './tavilyMcpClient.js';
import { callLearnMcpTool } from './learnMcpClient.js';
import { getFoundryClient, type LlmJsonSchema } from './foundryClient.js';

/**
 * Link Finder: every web link Athena writes is opened before anyone sees it.
 * A link that does not lead to a real page is swapped for a verified page that
 * serves the same purpose; when no such page can be found the link is reported
 * as unresolved so the caller can hold the content back. Model output is never
 * trusted for an address: only pages that were actually fetched are used.
 */

/** unverified: the site refused to let a checker in (bot wall, sign-in code), so the page may or may not exist. */
export type LinkStatus = 'ok' | 'broken' | 'unreachable' | 'unverified' | 'skipped';
export interface LinkCheck { url: string; status: LinkStatus; reason: string; finalUrl?: string; title?: string }
export interface LinkCandidate { url: string; title?: string; snippet?: string }
export interface LinkFix { from: string; to: string; title?: string; reason: string }
export interface LinkProblem { url: string; reason: string }
export interface LinkGuardResult { text: string; checked: number; fixed: LinkFix[]; unresolved: LinkProblem[] }
export interface LinkTarget { url: string; label: string; context: string }

export interface LinkFinderDeps {
  check: (url: string, signal?: AbortSignal) => Promise<LinkCheck>;
  search: (target: LinkTarget, signal?: AbortSignal) => Promise<LinkCandidate[]>;
  choose: (target: LinkTarget, candidates: Array<LinkCandidate & { title: string }>, signal?: AbortSignal) => Promise<string | null>;
}

export interface LinkGuardOptions {
  /** Links the user wrote themselves; they are left alone. */
  userText?: string[];
  /** Pages Athena read this turn (tool results): searched first for a replacement, and proof a walled link is real. */
  evidenceText?: string[];
  signal?: AbortSignal | undefined;
  deps?: Partial<LinkFinderDeps>;
}

const CHECK_TIMEOUT_MS = 12_000;
const READ_BYTES = 120_000;
const CHECK_CONCURRENCY = 6;
const MAX_LINKS = 40;
const MAX_CANDIDATES = 8;
const CONTEXT_CHARS = 400;
const LINK_CONTEXT_CHARS = 800;
const BEFORE_CHARS = 350;
const OPENING_CHARS = 160;
const SEARCH_CONTEXT_CHARS = 250;
const OK_CACHE_MS = 60 * 60_000;
const BROKEN_CACHE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 800;
const SEARCH_RESULTS = 8;
const CHOOSER_TOKENS = 300;
const CHOOSER_TIMEOUT_MS = 30_000;
// Bot walls (partner.microsoft.com among them) refuse an honest checker but show a real browser the true page.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GROUNDED_CACHE_MS = 60 * 60_000;

const NOT_FOUND_PATH = /(?:^|\/)(?:notfound|not-found|page-not-found|404|error\/404|errors\/404)(?:[/?#.]|$)/i;
const NOT_FOUND_TITLE = /\bpage (?:not found|cannot be found|can['’]?t be found|does not exist|doesn['’]?t exist)\b|\bcontent not found\b|\bcan['’]?t find (?:the|this|that) page\b|^\s*(?:404\b|not found\b|error 404\b)/i;
// The user is discussing a link, not being given one.
const LINK_FAULT = String.raw`(?:broken|dead|invalid|incorrect|wrong|bad|fake|invented|hallucinated|doesn['’]?t work|does not work|didn['’]?t work|404|not found)`;
const DISCUSSING_LINK = new RegExp(String.raw`\b(?:link|url|address)s?\b[^.\n]{0,40}\b${LINK_FAULT}|\b${LINK_FAULT}\s+(?:link|url|address)`, 'i');
export const REMOVED_LINK = '(broken link removed)';
const URL_PATTERN = /https?:\/\/[^\s<>"'`\]|]+/gi;

const cache = new Map<string, { result: LinkCheck; until: number }>();
/** Walled links accepted because a real source supplied them, so a later check in the same turn agrees. */
const grounded = new Map<string, number>();

function tidyUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?*_~'"]+$/, '');
  const count = (s: string, c: string): number => s.split(c).length - 1;
  while (url.endsWith(')') && count(url, '(') < count(url, ')')) url = url.slice(0, -1).replace(/[.,;:!?*_~'"]+$/, '');
  return url;
}

function plain(line: string): string {
  return line.replace(URL_PATTERN, ' ').replace(/[`*_>#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * What the link is for: its own line, the lines leading up to it, the next line and the message's opening,
 * because a link often sits alone under "Reference:" with the explanation above it.
 */
function linkContext(text: string, start: number): string {
  const lines = text.split('\n');
  let index = text.slice(0, start).split('\n').length - 1;
  const own = plain(lines[index] ?? '');
  const before: string[] = [];
  let size = 0;
  for (let i = index - 1; i >= 0 && before.length < 4 && size < BEFORE_CHARS; i--) {
    const line = plain(lines[i]!);
    if (line === '') continue;
    before.unshift(line);
    size += line.length;
  }
  let after = '';
  while (++index < lines.length && after === '') after = plain(lines[index]!);
  const opening = lines.map(plain).find(line => line !== '') ?? '';
  const parts = [opening.slice(0, OPENING_CHARS), ...before, own, after].filter((part, i, all) => part !== '' && all.indexOf(part) === i);
  return parts.join(' / ').slice(-LINK_CONTEXT_CHARS);
}

/** The link's own line and the one before it: enough to tell whether the text is talking about the link itself. */
function nearLines(text: string, url: string): string {
  const start = Math.max(0, text.indexOf(url));
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  const previousLineStart = lineStart > 0 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0;
  return text.slice(previousLineStart, lineEnd === -1 ? undefined : lineEnd).replace(URL_PATTERN, ' ');
}

/** Every distinct web link in the text, with the words around it that say what it is for. */
export function extractLinks(text: string): LinkTarget[] {
  const targets = new Map<string, LinkTarget>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = tidyUrl(match[0]);
    if (targets.has(url)) continue;
    try { new URL(decodeEntities(url)); } catch { continue; }
    const start = match.index ?? 0;
    const markdownLabel = /\[([^\]]{1,200})\]\($/.exec(text.slice(Math.max(0, start - 210), start))?.[1];
    const htmlLabel = new RegExp(`href=["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([^<]{1,200})<`, 'i').exec(text)?.[1];
    targets.set(url, { url, label: (markdownLabel ?? htmlLabel ?? '').trim(), context: linkContext(text, start) });
  }
  return [...targets.values()];
}

/** Replaces one address everywhere it appears as a whole address (not inside a longer one). */
export function replaceLink(text: string, from: string, to: string): string {
  const pattern = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w\\-./?=&%#~+])`, 'g');
  return text.replace(pattern, () => to);
}

/** Takes a link out: a markdown link keeps its words, a bare address becomes a short marker. */
export function removeLink(text: string, url: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return replaceLink(text.replace(new RegExp(`\\[([^\\]]{1,200})\\]\\(${escaped}\\)`, 'g'), (_, label: string) => label), url, REMOVED_LINK);
}

/** An address shown to the user without its scheme, so it reads as text rather than a clickable (or re-checked) link. */
function shown(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

/** Free text (a failure reason, say) with every address made non-clickable. */
function unlinked(text: string): string {
  return text.replace(/https?:\/\//gi, '');
}

async function readTitle(response: Response): Promise<string> {
  if (response.body === null || !/html/i.test(response.headers.get('content-type') ?? '')) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  try {
    while (html.length < READ_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/title>/i.test(html)) break;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

/** Classifies one fetch. Sign-in pages and bot walls prove the page exists; only "not found" counts as broken. */
export function classify(url: string, status: number, finalUrl: string, title: string, headers?: Headers): LinkCheck {
  const base = { url, finalUrl, ...(title !== '' && { title }) };
  if (status === 404 || status === 410 || status === 400) return { ...base, status: 'broken', reason: `the page returned HTTP ${status}` };
  let path = '';
  try { path = new URL(finalUrl).pathname; } catch { /* keep empty */ }
  if (NOT_FOUND_PATH.test(path) && !NOT_FOUND_PATH.test(new URL(url).pathname)) {
    return { ...base, status: 'broken', reason: `it redirects to a "page not found" page (${finalUrl})` };
  }
  if (status >= 200 && status < 300 && NOT_FOUND_TITLE.test(title)) return { ...base, status: 'broken', reason: `the page says "${title}"` };
  if (status >= 200 && status < 400) return { ...base, status: 'ok', reason: 'the page opened' };
  if (status === 401 || status === 403 || status === 405 || status === 407 || status === 429 || status === 999
    || status === 503 && headers?.get('cf-mitigated') !== null && headers?.get('cf-mitigated') !== undefined) {
    return { ...base, status: 'unverified', reason: `the site would not let me open it to check (HTTP ${status})` };
  }
  if (status >= 400 && status < 500) return { ...base, status: 'broken', reason: `the page returned HTTP ${status}` };
  return { ...base, status: 'unreachable', reason: `the site returned HTTP ${status}` };
}

async function fetchOnce(url: string, signal?: AbortSignal): Promise<LinkCheck> {
  try {
    const response = await fetchPublic(decodeEntities(url), {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    signal?.throwIfAborted();
    const title = await readTitle(response).catch(() => '');
    if (response.body !== null && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
    return classify(url, response.status, response.url || url, title, response.headers);
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/could not find that host/.test(message)) return { url, status: 'broken', reason: 'that website does not exist' };
    if (/not on the public internet|only http and https|with a login/.test(message)) return { url, status: 'skipped', reason: message };
    return { url, status: 'unreachable', reason: `the page could not be opened (${message})` };
  }
}

/** Opens a link (following redirects) and says whether it leads to a real page. Cached briefly. */
const MAX_CACHED = 2_000;
function prune(map: Map<string, unknown>, expired: (value: unknown) => boolean): void {
  if (map.size < MAX_CACHED) return;
  for (const [key, value] of map) if (expired(value)) map.delete(key);
  if (map.size >= MAX_CACHED) map.clear();
}

export async function checkUrl(url: string, signal?: AbortSignal): Promise<LinkCheck> {
  prune(cache, value => (value as { until: number }).until <= Date.now());
  prune(grounded, value => (value as number) <= Date.now());
  const cached = cache.get(url);
  if (cached !== undefined && cached.until > Date.now()) return cached.result;
  let result = await fetchOnce(url, signal);
  if (result.status === 'unreachable') {
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    result = await fetchOnce(url, signal);
  }
  if (result.status === 'ok' || result.status === 'broken' || result.status === 'unverified') {
    cache.set(url, { result, until: Date.now() + (result.status === 'ok' ? OK_CACHE_MS : BROKEN_CACHE_MS) });
  }
  return result;
}

function siteOf(url: string): string {
  try {
    const parts = new URL(url).hostname.toLowerCase().split('.');
    const secondLevel = parts.length > 2 && parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3;
    return parts.slice(secondLevel ? -3 : -2).join('.');
  } catch { return ''; }
}

function searchQuery(target: LinkTarget): string {
  let path = '';
  try { path = new URL(target.url).pathname.split('/').filter(part => !/^[a-z]{2}-[a-z]{2}$/i.test(part)).join(' ').replace(/[-_]/g, ' '); } catch { /* none */ }
  return [target.label, path, target.context.slice(-SEARCH_CONTEXT_CHARS)].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS);
}

/** Web search (and Microsoft Learn search for Microsoft pages) for the page the link was meant to reach. */
async function searchWeb(target: LinkTarget): Promise<LinkCandidate[]> {
  const query = searchQuery(target);
  const site = siteOf(target.url);
  const found: LinkCandidate[] = [];
  if (site === 'microsoft.com') {
    const learn = await callLearnMcpTool('microsoft_docs_search', { query }).catch(() => null);
    const text = typeof learn === 'object' && learn !== null && 'result' in learn ? (learn as { result: unknown }).result : null;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text) as unknown;
        const list = Array.isArray(parsed) ? parsed : (parsed as { results?: unknown }).results;
        if (Array.isArray(list)) {
          for (const item of list as Array<Record<string, unknown>>) {
            const url = typeof item['contentUrl'] === 'string' ? item['contentUrl'] : typeof item['url'] === 'string' ? item['url'] : '';
            if (url !== '') found.push({ url, title: typeof item['title'] === 'string' ? item['title'] : '', snippet: typeof item['content'] === 'string' ? item['content'].slice(0, CONTEXT_CHARS) : '' });
          }
        }
      } catch {
        for (const match of text.matchAll(URL_PATTERN)) found.push({ url: tidyUrl(match[0]) });
      }
    }
  }
  if (isTavilyEnabled()) {
    const tool = (await getTavilyMcpTools()).find(t => t.function.name === 'tavily_search');
    const props = (tool?.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const run = async (domains: string[] | null): Promise<void> => {
      const args: Record<string, unknown> = { query };
      if ('max_results' in props) args['max_results'] = SEARCH_RESULTS;
      if (domains !== null && 'include_domains' in props) args['include_domains'] = domains;
      const raw = await callTavilyMcpTool('tavily_search', args);
      if (typeof raw === 'object' && raw !== null && 'error' in raw) return;
      for (const hit of parseTavilySearch(raw)) found.push({ url: hit.url, title: hit.title, snippet: hit.content.slice(0, CONTEXT_CHARS) });
    };
    if (site !== '') await run([site]);
    await run(null);
  }
  return found;
}

const CHOICE_SCHEMA: LlmJsonSchema = {
  name: 'link_finder_choice',
  schema: {
    type: 'object', additionalProperties: false, required: ['choice', 'reason'],
    properties: { choice: { type: 'integer' }, reason: { type: 'string' } },
  },
};

/** A light model picks which verified page does the job the broken link was meant to do, or none. */
async function chooseWithModel(target: LinkTarget, candidates: Array<LinkCandidate & { title: string }>, signal?: AbortSignal): Promise<string | null> {
  const list = candidates.map((c, index) => ({ index, url: c.url, title: c.title, snippet: (c.snippet ?? '').slice(0, CONTEXT_CHARS) }));
  const reply = await getFoundryClient('link-finder').chat('light', [
    { role: 'system', content: 'You replace a broken web link. Every candidate below has been opened and works. Pick the candidate that takes the reader to the same thing the broken link promised (same task, page or resource, same organisation), judging by the link text, its sentence and the broken address. A sign-in page for the right portal is acceptable. Prefer the official page about that specific task over a general landing, news or index page. If none clearly does that job, answer -1. Never pick a loosely related page. Reply as JSON {"choice": index or -1, "reason": short}.' },
    { role: 'user', content: JSON.stringify({ brokenLink: target.url, linkText: target.label, sentence: target.context, candidates: list }) },
  ], CHOOSER_TOKENS, CHOOSER_TIMEOUT_MS, signal, CHOICE_SCHEMA);
  const parsed = JSON.parse(reply) as { choice?: unknown };
  return typeof parsed.choice === 'number' && Number.isInteger(parsed.choice) && parsed.choice >= 0 && parsed.choice < candidates.length
    ? candidates[parsed.choice]!.url : null;
}

const defaultDeps: LinkFinderDeps = { check: checkUrl, search: target => searchWeb(target), choose: chooseWithModel };

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2));
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...await Promise.all(items.slice(index, index + size).map(run)));
  return results;
}

/** Finds a working page for a broken link: pages already read this turn first, then a web search. */
export async function findReplacement(target: LinkTarget, evidenceUrls: string[], deps: LinkFinderDeps, signal?: AbortSignal): Promise<{ url: string; title: string } | null> {
  const wanted = words(`${target.label} ${target.context} ${target.url}`);
  const score = (candidate: LinkCandidate): number => {
    const have = words(`${candidate.url} ${candidate.title ?? ''} ${candidate.snippet ?? ''}`);
    let shared = 0;
    for (const word of wanted) if (have.has(word)) shared++;
    return shared + (siteOf(candidate.url) === siteOf(target.url) ? 2 : 0);
  };
  const fromEvidence: LinkCandidate[] = evidenceUrls.filter(url => url !== target.url).map(url => ({ url }));
  const searched = await deps.search(target, signal).catch((err: unknown) => {
    console.warn('[link-finder] search failed:', err instanceof Error ? err.message : err);
    return [] as LinkCandidate[];
  });
  // One entry per page: the same page under another locale or #section only crowds out different pages.
  const pageKey = (url: string): string => tidyUrl(url).replace(/#.*$/, '').replace(/\/[a-z]{2}-[a-z]{2}(?=\/)/i, '').replace(/\/$/, '').toLowerCase();
  const seen = new Set<string>([pageKey(target.url)]);
  // Show readers the same language version as the link being replaced, not whichever locale the index returned.
  let locale = 'en-us';
  try { locale = /^\/([a-z]{2}-[a-z]{2})\//i.exec(new URL(target.url).pathname)?.[1]?.toLowerCase() ?? locale; } catch { /* default */ }
  const inLocale = (url: string): string => url.replace(/^(https?:\/\/[^/]+\/)[a-z]{2}-[a-z]{2}(?=\/)/i, `$1${locale}`);
  const pool = [...searched, ...fromEvidence].map(candidate => ({ ...candidate, url: inLocale(tidyUrl(candidate.url)) })).filter(candidate => {
    const key = pageKey(candidate.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return /^https?:\/\//i.test(candidate.url);
  }).sort((a, b) => score(b) - score(a)).slice(0, MAX_CANDIDATES);
  const checked = await inBatches(pool, CHECK_CONCURRENCY, async candidate => ({ candidate, check: await deps.check(candidate.url, signal) }));
  // Candidates come from a search index or a page already read, so a walled one is still a real address.
  const working = checked.filter(entry => entry.check.status === 'ok' || entry.check.status === 'unverified')
    .map(entry => ({ ...entry.candidate, title: entry.check.title ?? entry.candidate.title ?? '' }));
  if (working.length === 0) return null;
  const chosen = await deps.choose(target, working, signal).catch((err: unknown) => {
    console.warn('[link-finder] choice failed:', err instanceof Error ? err.message : err);
    return null;
  });
  const match = working.find(candidate => candidate.url === chosen);
  return match === undefined ? null : { url: match.url, title: match.title };
}

/**
 * Checks every link in Athena's text. Broken ones are swapped for a verified
 * page doing the same job; any that cannot be fixed come back as unresolved.
 */
export async function guardLinks(text: string, options: LinkGuardOptions = {}): Promise<LinkGuardResult> {
  const deps: LinkFinderDeps = { ...defaultDeps, ...options.deps };
  const userLinks = new Set((options.userText ?? []).flatMap(part => extractLinks(part).map(link => link.url)));
  const targets = extractLinks(text).filter(target => !userLinks.has(target.url)).slice(0, MAX_LINKS);
  if (targets.length === 0) return { text, checked: 0, fixed: [], unresolved: [] };
  const evidenceUrls = [...new Set((options.evidenceText ?? []).flatMap(part => extractLinks(part).map(link => link.url)))];
  const evidence = new Set(evidenceUrls);
  const checks = await inBatches(targets, CHECK_CONCURRENCY, async target => ({ target, check: await deps.check(target.url, options.signal) }));
  const fixed: LinkFix[] = [];
  const unresolved: LinkProblem[] = [];
  let result = text;
  const isGrounded = (url: string): boolean => {
    if (evidence.has(url)) { grounded.set(url, Date.now() + GROUNDED_CACHE_MS); return true; }
    const until = grounded.get(url);
    return until !== undefined && until > Date.now();
  };
  // A link that did not open passes only if a real source (a page or search result read this turn) supplied it.
  const failing = checks.filter(({ target, check }) => check.status === 'broken'
    || (check.status === 'unreachable' || check.status === 'unverified') && !isGrounded(target.url));
  options.signal?.throwIfAborted();
  const replacements = await Promise.all(failing.map(({ target }) => findReplacement(target, evidenceUrls, deps, options.signal)));
  for (const [index, { target, check }] of failing.entries()) {
    const replacement = replacements[index] ?? null;
    if (replacement === null) {
      // Talking about a bad link (an apology, say) needs no replacement; the address itself still never goes out.
      if (DISCUSSING_LINK.test(nearLines(text, target.url))) {
        result = removeLink(result, target.url);
        fixed.push({ from: target.url, to: REMOVED_LINK, reason: check.reason });
      } else unresolved.push({ url: target.url, reason: check.reason });
      continue;
    }
    grounded.set(replacement.url, Date.now() + GROUNDED_CACHE_MS);
    result = replaceLink(result, target.url, replacement.url);
    fixed.push({ from: target.url, to: replacement.url, ...(replacement.title !== '' && { title: replacement.title }), reason: check.reason });
  }
  return { text: result, checked: targets.length, fixed, unresolved };
}

/** A short, plain note telling the user which links were swapped. */
export function linkFixNote(fixes: LinkFix[]): string {
  if (fixes.length === 0) return '';
  const lines = fixes.map(fix => fix.to === REMOVED_LINK
    ? `- I took out a link that didn't work (${unlinked(fix.reason)}).`
    : `- \`${shown(fix.from)}\` didn't work (${unlinked(fix.reason)}), so I swapped in ${fix.to}${fix.title ? ` ("${unlinked(fix.title)}")` : ''}.`);
  return `**Link check:** I opened every link before sending this. ${fixes.length === 1 ? 'One was' : `${fixes.length} were`} broken and I've replaced ${fixes.length === 1 ? 'it' : 'them'}:\n${lines.join('\n')}`;
}

/** What the user sees when a link could not be verified or replaced: nothing with that link is given. */
export function linkBlockedMessage(problems: LinkProblem[]): string {
  const lines = problems.map(problem => `- \`${shown(problem.url)}\`: ${unlinked(problem.reason)}`);
  return `I've held this back rather than give you a link I couldn't verify. I opened every link, and ${problems.length === 1 ? 'this one doesn\'t' : 'these don\'t'} lead to a working page, and I couldn't find a verified replacement:\n${lines.join('\n')}\n\nIf you know the right page, paste it in and I'll use it; otherwise I can redo this without ${problems.length === 1 ? 'that link' : 'those links'}.`;
}

export interface ToolExchange {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: ReadonlyArray<{ id: string; function: { arguments: string } }>;
}

/**
 * What tools actually returned this turn, as proof a link is real. A failed call
 * proves nothing, and a call never vouches for the address it was asked to open
 * (fetch_web_page echoes the url it was given, even when the page is missing).
 */
export function toolEvidence(messages: readonly ToolExchange[]): string[] {
  const asked = new Map<string, string>();
  for (const message of messages) for (const call of message.tool_calls ?? []) asked.set(call.id, call.function.arguments);
  const evidence: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    let parsed: unknown = null;
    try { parsed = JSON.parse(message.content); } catch { /* plain text result */ }
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) continue;
    let content = message.content;
    for (const link of extractLinks(asked.get(message.tool_call_id ?? '') ?? '')) content = replaceLink(content, link.url, '');
    evidence.push(content);
  }
  return evidence;
}

/** Sent back to Athena once, so she can rewrite the reply herself before anything is held back. */
export function linkRepairInstruction(problems: LinkProblem[]): string {
  return `[Runtime link check: every link in your reply was opened. These do not lead to a working page and no verified replacement was found: ${problems.map(p => `${p.url} (${p.reason})`).join('; ')}. Rewrite the reply without them. Never invent or guess a web address: only give a link you opened with a tool in this conversation or that the user supplied. Search or open the page now if you need one; otherwise name the site and say where to find it.]`;
}

const SKIPPED_ARGUMENT_KEYS = /^(?:find|heading|.*[iI]ds?)$/;

function collectStrings(value: unknown, into: string[], key = ''): void {
  if (typeof value === 'string') { if (!SKIPPED_ARGUMENT_KEYS.test(key)) into.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, into, key); return; }
  if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) collectStrings(v, into, k);
}

function rewriteStrings(value: unknown, fixes: LinkFix[], key = ''): unknown {
  if (typeof value === 'string') {
    if (SKIPPED_ARGUMENT_KEYS.test(key)) return value;
    return fixes.reduce((text, fix) => fix.to === REMOVED_LINK ? removeLink(text, fix.from) : replaceLink(text, fix.from, fix.to), value);
  }
  if (Array.isArray(value)) return value.map(item => rewriteStrings(item, fixes, key));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, fixes, k)]));
  return value;
}

/** Guards the text a write tool is about to save: broken links are swapped in place; unresolved ones are reported. */
export async function guardArgumentLinks(args: Record<string, unknown>, options: LinkGuardOptions = {}): Promise<Omit<LinkGuardResult, 'text'> & { args: Record<string, unknown> }> {
  const strings: string[] = [];
  collectStrings(args, strings);
  if (!strings.some(text => /https?:\/\//i.test(text))) return { args, checked: 0, fixed: [], unresolved: [] };
  const guard = await guardLinks(strings.join('\n\n'), options);
  return {
    args: guard.fixed.length > 0 ? rewriteStrings(args, guard.fixed) as Record<string, unknown> : args,
    checked: guard.checked, fixed: guard.fixed, unresolved: guard.unresolved,
  };
}
