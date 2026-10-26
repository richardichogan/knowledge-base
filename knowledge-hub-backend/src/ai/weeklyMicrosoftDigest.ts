/**
 * ai/weeklyMicrosoftDigest.ts — the Monday-morning Microsoft round-up.
 *
 * Collates every Microsoft and GitHub update from the last full week (Monday to Sunday, UK time):
 * what Discover picked up (shelved ones included, so nothing is missed), the tenant's Microsoft 365
 * Message Center posts (from the blog mailbox), and a web search for anything the feeds missed, into:
 *   - a full CMS blog package for The Microsoft Cloud Blog (title, slug, image, content, excerpt, TL;DR,
 *     takeaways, categories, tags, LinkedIn and X posts), saved as a Think note (contentType "blog"), and
 *   - a Slack-ready summary, posted to SLACK_WEBHOOK_URL when it is set.
 * Both are saved in a pinned "Weekly Microsoft updates" Athena chat. Runs once
 * per week (Mondays from 08:00 UK, see scheduler.ts) or on demand.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { getFoundryClient } from './foundryClient.js';
import { setSessionPinned, renameSession } from './chatSessionStore.js';
import { getSyncState, upsertSyncState } from '../db/queries.js';
import { workToday, WORK_TIMEZONE } from '../integrations/ibm/ibmMeetings.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import { createNoteRecord, scheduleNoteIndexing } from '../routes/notes.js';
import { BLOG_PACKAGE_RULES } from './blogHouseStyle.js';
import { searchDigestWeek, type DigestWindow, type WebSearchHit } from './digestWebSearch.js';

const STATE_KEY = 'weekly-microsoft-digest';
export const DIGEST_HOUR = 8;
export const DIGEST_LATEST_HOUR = 18;
const DIGEST_PROJECT_ID = 'microsoft-cloud-blog';
export const DIGEST_SOURCE_GROUPS = ['Microsoft', 'GitHub'] as const;
export const WEB_SEARCH_SOURCE = 'Web search';
const MAX_ARTICLES = 80;
/** Message Center posts get their own allowance so a busy week of feed articles can't crowd them out. */
const MAX_MESSAGE_CENTER = 40;
const MESSAGE_CENTER_SOURCE_ID = 'message-center';
const SUMMARY_CHARS = 320;
// The standard slot is a reasoning model: hidden reasoning shares these budgets, so a tight cap truncates the package.
const BLOG_MAX_TOKENS = 20_000;
const SLACK_MAX_TOKENS = 6_000;
const SLACK_TIMEOUT_MS = 15_000;

export interface DigestArticle {
  id: string;
  title: string;
  url: string | null;
  summary: string | null;
  source: string;
  group: string;
  publishedAt: string;
  score: number | null;
  shelved: boolean;
  selectionReason?: string;
  body?: string;
  bodyExcerpted?: boolean;
  readAt?: string;
  verifiedClaims?: string[];
  validationReason?: string;
}

export interface WeeklyDigest {
  week: string;
  sessionId: string;
  noteId: string | null;
  noteUrl: string | null;
  articleCount: number;
  slackPosted: boolean;
  slackText: string;
  generatedAt: string;
}

interface StoredDigest { week: string; sessionId: string; noteId: string | null; generatedAt: string }

/** The Monday (YYYY-MM-DD, UK time) of the week containing `now` — the digest's once-per-week key. */
export function digestWeekKey(now = new Date()): string {
  const today = workToday(now);
  const d = new Date(`${today}T12:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function ukWeekdayHour(now: Date): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(now);
  return {
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '0'),
  };
}

/** True on a Monday between 08:00 and 18:00 UK when this week's digest hasn't been made yet. */
export function digestDueAt(lastWeek: string | null, now = new Date()): boolean {
  const { weekday, hour } = ukWeekdayHour(now);
  if (weekday !== 'Mon' || hour < DIGEST_HOUR || hour >= DIGEST_LATEST_HOUR) return false;
  return lastWeek !== digestWeekKey(now);
}

/** UTC instant of 00:00 UK time on a YYYY-MM-DD date. */
export function ukMidnight(day: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: WORK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (wall - guess));
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The week the digest covers: the last full Monday–Sunday (UK) before the current week. */
export function digestWindow(now = new Date()): DigestWindow {
  const thisMonday = digestWeekKey(now);
  const firstDay = addDays(thisMonday, -7);
  return { start: ukMidnight(firstDay), end: ukMidnight(thisMonday), firstDay, lastDay: addDays(thisMonday, -1) };
}

/** "Mon 2 Jun to Sun 8 Jun" */
export function windowLabel(w: DigestWindow): string {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  return `${f.format(new Date(`${w.firstDay}T12:00:00Z`))} to ${f.format(new Date(`${w.lastDay}T12:00:00Z`))}`;
}

/** Web search hits as digest entries (grouped under "Web search"; GitHub hits count as GitHub). */
export function webHitsToArticles(hits: WebSearchHit[], _w: DigestWindow): DigestArticle[] {
  return hits.map((h, i) => ({
    id: `web-${i.toString()}`,
    title: h.title,
    url: h.url,
    summary: h.content,
    source: WEB_SEARCH_SOURCE,
    group: /(^|\.)github\.(blog|com)$/i.test(safeHost(h.url)) ? 'GitHub' : 'Microsoft',
    publishedAt: h.publishedAt !== null && Number.isFinite(Date.parse(h.publishedAt)) ? new Date(h.publishedAt).toISOString() : '',
    score: null,
    shelved: false,
  }));
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function loadState(db: Pool): Promise<StoredDigest | null> {
  const s = await getSyncState(db, STATE_KEY);
  if (s?.lastCursor == null) return null;
  try { return JSON.parse(s.lastCursor) as StoredDigest; } catch { return null; }
}

export async function weeklyDigestDue(db: Pool, now = new Date()): Promise<boolean> {
  const { weekday } = ukWeekdayHour(now);
  if (weekday !== 'Mon') return false;
  const state = await loadState(db);
  return digestDueAt(state?.week ?? null, now);
}

/**
 * Every Microsoft/GitHub Discover article from the digest week, best first, then the week's Message
 * Center posts (which have their own allowance). Shelved ones are included.
 */
export async function gatherDigestArticles(db: Pool, now = new Date()): Promise<DigestArticle[]> {
  const { start: since, end: until } = digestWindow(now);
  const select = (messageCenter: boolean, limit: number) => db.query<{
    id: string; title: string; url: string | null; summary: string | null; source: string | null; grp: string;
    published_at: Date | string; score: string | null; shelved: boolean;
  }>(
    `SELECT id::text, title, url,
            COALESCE(NULLIF(left(btrim(body), $5::int), ''), summary) AS summary,
            metadata->>'sourceTitle' AS source, metadata->>'sourceGroup' AS grp,
            COALESCE(published_at, indexed_at) AS published_at,
            metadata->>'compositeScore' AS score,
            (metadata ? 'shelvedAt') AS shelved
       FROM content_items
      WHERE source = 'discovered-article'
        AND metadata->>'sourceGroup' = ANY($1::text[])
        AND (COALESCE(metadata->>'sourceId', '') = $6) = $7
        AND published_at >= $2
        AND published_at < $3
      ORDER BY (metadata->>'compositeScore')::numeric DESC NULLS LAST, COALESCE(published_at, indexed_at) DESC
      LIMIT $4`,
    [[...DIGEST_SOURCE_GROUPS], since, until, limit, SUMMARY_CHARS * 2, MESSAGE_CENTER_SOURCE_ID, messageCenter],
  );
  const [feeds, messageCenter] = await Promise.all([select(false, MAX_ARTICLES), select(true, MAX_MESSAGE_CENTER)]);
  return [...feeds.rows, ...messageCenter.rows].map((r) => {
    const score = r.score === null ? NaN : Number(r.score);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      summary: r.summary,
      source: r.source ?? r.grp,
      group: r.grp,
      publishedAt: new Date(r.published_at).toISOString(),
      score: Number.isFinite(score) ? score : null,
      shelved: r.shelved,
    };
  });
}

/** The facts block the LLM writes from, grouped by source. */
export function formatDigestFacts(articles: DigestArticle[], period = 'the last week'): string {
  const bySource = new Map<string, DigestArticle[]>();
  for (const a of articles) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }
  const sections = [...bySource.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([source, list]) => [
      `## ${source} (${list.length.toString()})`,
      ...list.map((a) => {
        const summary = a.verifiedClaims ? a.verifiedClaims.join('\n  ') : (a.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS);
        const score = a.score === null ? '' : ` [score ${a.score.toFixed(1)}]`;
        return `- ${a.publishedAt.slice(0, 10)} ${a.title}${score}${a.url !== null ? ` — ${a.url}` : ''}${summary !== '' ? `\n  ${summary}` : ''}`;
      }),
    ].join('\n'));
  const web = articles.filter((a) => a.source === WEB_SEARCH_SOURCE).length;
  const note = web > 0 ? ` ${web.toString()} of them came from a web search for things the feeds missed (under "${WEB_SEARCH_SOURCE}").` : '';
  return `${articles.length.toString()} Microsoft and GitHub updates from ${period}.${note}\n\n${sections.join('\n\n')}`;
}

const VOICE_RULES = [
  'Voice: Richard Hogan, Microsoft practice lead and author of The Microsoft Cloud Blog. Grounded, practical, ' +
    'lightly British, slightly cynical, with dry wit. Descriptive first, so a reader knows exactly what changed, ' +
    'then a short "so what" in his voice where it earns it. No hype, no salesy language, no breathless enthusiasm.',
  'House rules: Oxford commas. No hyphens or em dashes as punctuation (use commas or brackets). Never use ' +
    '"resonates". No "not X, it\'s Y" constructions. No rhythmic triplets. ' +
    'No "less about X, more about Y". Do not use "signal" as a mass noun. ' +
    'No vague "most organisations" claims.',
  'Only use facts and links from the input. Never invent announcements, dates, or URLs.',
].join('\n');

export const BLOG_PROMPT = [
  'Write the weekly Microsoft round-up post for The Microsoft Cloud Blog from the updates below, as a complete ' +
    'CMS-ready package. This is a practical list of important updates grouped by area, with brief commentary, ' +
    'not a literary essay. Use short update paragraphs or bullets where useful. Pull on a common thread only ' +
    'when the evidence supports it. Do not force a theme or pad to a word count. Produce the package directly.',
  VOICE_RULES,
  '',
  BLOG_PACKAGE_RULES,
  '',
  '### How to apply this to a weekly round-up',
  '- Output Markdown. The very first line is "# " plus the CMS title. Then give each of the 10 CMS fields under its ' +
    'own "## " heading, using exactly these names in this order: Title, Slug, Featured image URL, Image prompt, ' +
    'Content, Excerpt, Summary TL;DR, Key takeaways, Categories, Tags. Then "## LinkedIn post" and "## Twitter/X post".',
  '- Title: editorial and specific to what actually happened this week, never "Weekly round-up" or "This week in Microsoft".',
  '- Featured image URL: only an image URL that appears in the input; otherwise write "None available, use the image prompt".',
  '- Content: use a brief factual opener, then "### " sections by area (e.g. AI and ' +
    'Copilot, Azure, Microsoft 365, Security and Identity, Power Platform and Dynamics, GitHub, Research), skipping ' +
    'empty areas. Cover the selected validated updates as short paragraphs or a list: what changed, linked to its source as [title](url), and why it ' +
    'matters for architects and IT leaders where that is clear. Fold minor items into one short paragraph rather than ' +
    'dropping them. Include a "### The one to watch" section near the end. The source reference that ends the body ' +
    'is a horizontal rule, then "*Sources: [title](url), [title](url), ...*" listing every article linked above.',
  '- Microsoft 365 Message Center posts (their source is "Microsoft 365 Message Center", titles end with the MC id) ' +
    'are announcements of upcoming tenant changes, retirements, and required actions. If there are any, add a ' +
    '"### Message Center: changes to plan for" section before "The one to watch": the ones that matter most to admins ' +
    'and architects, each with what changes, when (only dates given in the input), and any action required, citing ' +
    'the MC id. Fold routine ones into a single sentence. Their links open the Microsoft 365 admin centre, so name ' +
    'the MC id in the text as well as linking it.',
  '- "Web search" entries were found by searching the web for the week. Treat them like the rest, but only include ' +
    'ones that are genuinely Microsoft or GitHub announcements from this week, skip any that duplicate another entry, ' +
    'and prefer the official Microsoft or GitHub link when two cover the same news.',
  '- Twitter/X post: use the URL of the "one to watch" article. LinkedIn post: no URLs.',
  '- Never invent announcements, dates, figures, or URLs; use only what is in the input.',
  '- Factual enumerations, source titles and direct quotations are not rhetorical triplets. Preserve them. ' +
    'Apply house style to your own commentary, not to copied source wording.',
  '- The evidence contains summaries, not necessarily full primary pages. Attribute reported announcements to their ' +
    'named source and preserve preview/GA qualifiers. Do not infer universal rollout or completed transitions from a planned change.',
].join('\n');

const SLACK_PROMPT = [
  'Write an internal Slack post summarising this week\'s Microsoft and GitHub updates for a Microsoft practice team.',
  VOICE_RULES,
  'Slack mrkdwn only: *bold* for headings, links as <url|short title>, "•" bullets are fine here.',
  'Structure: a one line opener (with a light Richard twist), then 3 to 6 short headed groups by area, each with ' +
    'the most relevant updates as one line bullets (what changed, linked). If there are Microsoft 365 Message Center ' +
    'posts, add a "*Message Center: plan for*" group with the retirements, deadlines, and required actions (with the ' +
    'MC id and any date given). Finish with "*Worth a look:*" and the one update people should read first.',
  'Keep it under 350 words. No greeting, no sign off.',
].join('\n');

/** Posts text to the configured Slack incoming webhook. Returns false when none is configured or it fails. */
export async function postToSlack(text: string, webhookUrl = env.SLACK_WEBHOOK_URL): Promise<boolean> {
  if (webhookUrl === undefined || webhookUrl === '') return false;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[WeeklyDigest] Slack webhook returned ${res.status.toString()}`);
    return res.ok;
  } catch (err) {
    console.warn('[WeeklyDigest] Slack post failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

function blogTitle(markdown: string, fallback: string): string {
  const line = markdown.split('\n').find((l) => l.startsWith('# '));
  return line !== undefined ? line.slice(2).trim() : fallback;
}

/** Generation only: used by previews and approved job delivery without posting or changing live state. */
export async function prepareWeeklyMicrosoftDigest(db: Pool, now = new Date(), instructions = ''): Promise<{
  blog: string; slackText: string; label: string; articleCount: number; sources: DigestArticle[];
  sourceGaps: Array<{ id: string; title: string; error: string }>;
}> {
  const window = digestWindow(now);
  const label = windowLabel(window);
  const fromDiscover = await gatherDigestArticles(db, now);
  const web = await searchDigestWeek(window, fromDiscover.flatMap(a => a.url ? [a.url] : []));
  const { prepareWeeklyEvidence } = await import('./weeklyEvidence.js');
  const { sources, gaps: sourceGaps } = await prepareWeeklyEvidence(db,
    [...fromDiscover, ...webHitsToArticles(web, window)].filter(article => article.publishedAt
      && new Date(article.publishedAt) >= window.start && new Date(article.publishedAt) < window.end));
  if (!sources.length) throw new Error('No Microsoft updates found for the reporting period. Check sources before retrying.');
  const facts = formatDigestFacts(sources, label);
  const client = getFoundryClient('weekly-msft-job');
  const [blog, slackText] = await Promise.all([
    client.chatBulk([{ role: 'system', content: BLOG_PROMPT },
      { role: 'user', content: `${facts}\n\nSaved editorial instructions:\n${instructions}` }], BLOG_MAX_TOKENS),
    client.chatBulk([{ role: 'system', content: SLACK_PROMPT }, { role: 'user', content: `${facts}\n\nSaved editorial instructions:\n${instructions}` }], SLACK_MAX_TOKENS),
  ]);
  return { blog, slackText, label, articleCount: sources.length, sources, sourceGaps };
}

/** Builds the digest, saves the blog note and pinned chat, and posts to Slack when configured. */
export async function generateWeeklyMicrosoftDigest(db: Pool, now = new Date()): Promise<WeeklyDigest> {
  const previous = await loadState(db);
  const week = digestWeekKey(now);
  const window = digestWindow(now);
  const label = windowLabel(window);
  const fromDiscover = await gatherDigestArticles(db, now);
  const web = await searchDigestWeek(window, fromDiscover.flatMap((a) => (a.url !== null ? [a.url] : [])))
    .catch((err: unknown) => { console.warn('[WeeklyDigest] web search failed:', err instanceof Error ? err.message : String(err)); return []; });
  const articles = [...fromDiscover, ...webHitsToArticles(web, window)];

  let blog = '';
  let slackText: string;
  let noteId: string | null = null;
  let noteUrl: string | null = null;
  if (articles.length === 0) {
    slackText = `*Microsoft updates, ${label}*\nNothing new from the Microsoft or GitHub feeds or the web this week. Either Redmond took a week off, or the feeds did.`;
  } else {
    const facts = formatDigestFacts(articles, label);
    const client = getFoundryClient('weekly-msft-digest');
    [blog, slackText] = await Promise.all([
      client.chat('standard', [{ role: 'system', content: BLOG_PROMPT }, { role: 'user', content: facts }], BLOG_MAX_TOKENS),
      client.chat('standard', [{ role: 'system', content: SLACK_PROMPT }, { role: 'user', content: facts }], SLACK_MAX_TOKENS),
    ]);
    const title = blogTitle(blog, `Microsoft this week: ${label}`);
    const body = blog.replace(/^# .*\n+/, '');
    const wrapper = { title, contentType: 'blog', contentJson: JSON.stringify(textToBlocks(body)) };
    const note = await createNoteRecord(db, { content: JSON.stringify(wrapper), tags: ['weekly-digest', 'microsoft'], projectId: DIGEST_PROJECT_ID });
    scheduleNoteIndexing(db, note);
    noteId = note.id;
    noteUrl = `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}`;
  }

  const slackPosted = await postToSlack(slackText);
  const chatMarkdown = [
    `**Weekly Microsoft updates — ${label}** (${fromDiscover.length.toString()} from Discover and Message Center, ${web.length.toString()} more from a web search)`,
    noteUrl !== null ? `\nBlog draft saved to Think: [open the draft](${noteUrl})` : '',
    `\n**Slack summary** ${slackPosted ? '(posted to Slack)' : env.SLACK_WEBHOOK_URL === undefined ? '(Slack is not connected yet, copy it from here)' : '(the Slack post failed, copy it from here)'}`,
    '',
    '```',
    slackText,
    '```',
    blog !== '' ? `\n---\n\n${blog}` : '',
  ].join('\n');

  // Rerunning in the same week replaces that week's chat; a new week gets a new one.
  const sameWeek = previous !== null && previous.week === week;
  const sessionId = sameWeek ? previous.sessionId : randomUUID();
  if (sameWeek) {
    await db.query(`DELETE FROM ai_chat_messages WHERE session_id::text = $1`, [sessionId]);
  } else {
    await db.query(`INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);
    if (previous !== null) await setSessionPinned(db, previous.sessionId, false).catch(() => undefined);
  }
  await db.query(
    `INSERT INTO ai_chat_messages (session_id, role, content, persona, sources) VALUES ($1, 'assistant', $2, 'general', $3)`,
    [sessionId, chatMarkdown, ['weekly_microsoft_digest']],
  );
  await renameSession(db, sessionId, `Weekly Microsoft updates — ${label}`);
  await setSessionPinned(db, sessionId, true);
  await db.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id::text = $1`, [sessionId]);

  const generatedAt = now.toISOString();
  const stored: StoredDigest = { week, sessionId, noteId, generatedAt };
  await upsertSyncState(db, STATE_KEY, { lastSyncAt: now, lastCursor: JSON.stringify(stored), lastError: null });
  return { week, sessionId, noteId, noteUrl, articleCount: articles.length, slackPosted, slackText, generatedAt };
}
