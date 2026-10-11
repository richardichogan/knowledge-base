/**
 * ai/weeklyMicrosoftDigest.ts — the Monday-morning Microsoft round-up.
 *
 * Collates every Microsoft and GitHub update Discover picked up in the last
 * 7 days (shelved ones included, so nothing is missed) into:
 *   - a blog draft for The Microsoft Cloud Blog, saved as a Think note (contentType "blog"), and
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

const STATE_KEY = 'weekly-microsoft-digest';
export const DIGEST_HOUR = 8;
export const DIGEST_LATEST_HOUR = 18;
const DIGEST_PROJECT_ID = 'microsoft-cloud-blog';
export const DIGEST_SOURCE_GROUPS = ['Microsoft', 'GitHub'] as const;
const LOOKBACK_DAYS = 7;
const MAX_ARTICLES = 80;
const SUMMARY_CHARS = 320;
const BLOG_MAX_TOKENS = 3_000;
const SLACK_MAX_TOKENS = 1_200;
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

/** Every Microsoft/GitHub Discover article from the last week, best first. Shelved ones are included. */
export async function gatherDigestArticles(db: Pool, now = new Date()): Promise<DigestArticle[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const { rows } = await db.query<{
    id: string; title: string; url: string | null; summary: string | null; source: string | null; grp: string;
    published_at: Date | string; score: string | null; shelved: boolean;
  }>(
    `SELECT id::text, title, url, summary,
            metadata->>'sourceTitle' AS source, metadata->>'sourceGroup' AS grp,
            COALESCE(published_at, indexed_at) AS published_at,
            metadata->>'compositeScore' AS score,
            (metadata ? 'shelvedAt') AS shelved
       FROM content_items
      WHERE source = 'discovered-article'
        AND metadata->>'sourceGroup' = ANY($1::text[])
        AND COALESCE(published_at, indexed_at) >= $2
        AND COALESCE(published_at, indexed_at) <= $3
      ORDER BY (metadata->>'compositeScore')::numeric DESC NULLS LAST, COALESCE(published_at, indexed_at) DESC
      LIMIT $4`,
    [[...DIGEST_SOURCE_GROUPS], since, now, MAX_ARTICLES],
  );
  return rows.map((r) => {
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
export function formatDigestFacts(articles: DigestArticle[]): string {
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
        const summary = (a.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS);
        const score = a.score === null ? '' : ` [score ${a.score.toFixed(1)}]`;
        return `- ${a.publishedAt.slice(0, 10)} ${a.title}${score}${a.url !== null ? ` — ${a.url}` : ''}${summary !== '' ? `\n  ${summary}` : ''}`;
      }),
    ].join('\n'));
  return `${articles.length.toString()} Microsoft and GitHub updates from the last ${LOOKBACK_DAYS.toString()} days.\n\n${sections.join('\n\n')}`;
}

const VOICE_RULES = [
  'Voice: Richard Hogan, Microsoft practice lead and author of The Microsoft Cloud Blog. Grounded, practical, ' +
    'lightly British, slightly cynical, with dry wit. Descriptive first, so a reader knows exactly what changed, ' +
    'then a short "so what" in his voice where it earns it. No hype, no salesy language, no breathless enthusiasm.',
  'House rules: Oxford commas. No hyphens or em dashes as punctuation (use commas or brackets). Never use ' +
    '"resonates". No "not X, it\'s Y" constructions. No rhythmic triplets. Do not use "signal" as a mass noun. ' +
    'No vague "most organisations" claims.',
  'Only use facts and links from the input. Never invent announcements, dates, or URLs.',
].join('\n');

const BLOG_PROMPT = [
  'Write the weekly Microsoft round-up post for The Microsoft Cloud Blog from the updates below.',
  VOICE_RULES,
  'Format (Markdown):',
  '- First line: "# " plus an editorial, specific title for the week (not "Weekly round-up").',
  '- A two or three sentence opening on the theme of the week.',
  '- "## " sections by area (e.g. AI and Copilot, Azure, Microsoft 365, Security and Identity, Power Platform and ' +
    'Dynamics, GitHub, Research). Skip empty areas.',
  '- In each section, cover every notable update: what it is, in a sentence or two, linked to its source ' +
    '([title](url)), and why it matters for architects and IT leaders where that is clear. Group minor items ' +
    'into one short paragraph rather than dropping them. Prose, not bullet lists.',
  '- "## The one to watch": the single update that matters most and why, in his voice.',
  '- End with a horizontal rule and "*Sources: the links above, collated from Microsoft and GitHub blogs.*"',
  'Aim for 700 to 1,100 words.',
].join('\n');

const SLACK_PROMPT = [
  'Write an internal Slack post summarising this week\'s Microsoft and GitHub updates for a Microsoft practice team.',
  VOICE_RULES,
  'Slack mrkdwn only: *bold* for headings, links as <url|short title>, "•" bullets are fine here.',
  'Structure: a one line opener (with a light Richard twist), then 3 to 6 short headed groups by area, each with ' +
    'the most relevant updates as one line bullets (what changed, linked). Finish with "*Worth a look:*" and the one ' +
    'update people should read first.',
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

/** Builds the digest, saves the blog note and pinned chat, and posts to Slack when configured. */
export async function generateWeeklyMicrosoftDigest(db: Pool, now = new Date()): Promise<WeeklyDigest> {
  const previous = await loadState(db);
  const week = digestWeekKey(now);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, day: 'numeric', month: 'short' }).format(new Date(`${week}T12:00:00Z`));
  const articles = await gatherDigestArticles(db, now);

  let blog = '';
  let slackText: string;
  let noteId: string | null = null;
  let noteUrl: string | null = null;
  if (articles.length === 0) {
    slackText = `*Microsoft updates, week of ${label}*\nNothing new from the Microsoft or GitHub feeds this week. Either Redmond took a week off, or the feeds did.`;
  } else {
    const facts = formatDigestFacts(articles);
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
    `**Weekly Microsoft updates — week of ${label}** (${articles.length.toString()} updates from Microsoft and GitHub feeds)`,
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
