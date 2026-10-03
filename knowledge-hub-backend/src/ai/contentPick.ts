/**
 * ai/contentPick.ts — turns strong discovered articles into one daily content pick.
 *
 * 1. Deep dive: for each article scoring 80%+ that hasn't been assessed, read the
 *    full text and judge it against Richard's own recent pieces and his co-hosts'
 *    recent podcast topics: what is the news, what is his angle, which ONE format
 *    suits, and is it fresh or a rehash.
 * 2. Pick: choose the single strongest assessed article, favouring the format whose
 *    deadline is coming (podcast / newsletter alternate fortnights), and keep it until
 *    he acts on it or drops it.
 * The morning briefing shows the pick; chat tools read and update it.
 */
import type { Pool } from 'pg';
import { getFoundryClient } from './foundryClient.js';
import { fetchWebPage } from './chatTools.js';
import { isTavilyEnabled, getTavilyMcpTools, callTavilyMcpTool } from './tavilyMcpClient.js';
import { getSchedule, describeSchedule, TOO_LATE_DAYS, type ScheduledFormat } from './contentSchedule.js';
import { STRONG_SCORE } from '../integrations/discovery/feedSync.js';

export type ContentFormat = 'blog' | 'linkedin' | 'newsletter' | 'podcast';
const FORMATS: readonly ContentFormat[] = ['blog', 'linkedin', 'newsletter', 'podcast'];

/** An assessed article must be judged at least this worthwhile to be picked. */
export const PICK_MIN_WORTH = 75;
/** Candidates for the pick must be this recent. */
const CANDIDATE_WINDOW_DAYS = 14;
/** A pick not acted on for this long is replaced. */
const PICK_MAX_AGE_DAYS = 10;
/** A standing pick is replaced when a new candidate is at least this many points stronger. */
const REPLACE_MARGIN = 12;
/** Window before a deadline in which suggestions for that format are favoured. */
const PREP_WINDOW_DAYS = 10;
const DEEP_DIVE_ARTICLE_CHARS = 8_000;
const EPISODE_EXCERPT_CHARS = 1_800;

export interface DeepDive {
  at: string;
  /** Where the article text came from: the page itself, a licensed extraction service for sites that block direct reads, or only the feed summary. */
  textSource?: 'page' | 'extract' | 'summary';
  news: string;
  angle: string;
  format: ContentFormat;
  formatReason: string;
  whyNow: string;
  headline: string;
  keyPoints: string[];
  covered: { own: string[]; coHosts: string[]; verdict: 'fresh' | 'related' | 'rehash' };
  risks: string;
  worth: number;
}

export interface DailyPick {
  pickId: string;
  articleId: string;
  title: string;
  url: string | null;
  sourceTitle: string;
  publishedAt: string;
  score: number;
  dive: DeepDive;
  /** True when this is a pick carried over from an earlier day (still open). */
  carriedOver: boolean;
}

// ── Context: his own work and his co-hosts' topics ───────────────────────────

async function ownContext(db: Pool): Promise<{ own: string; episodes: string }> {
  const piece = async (source: string, label: string, limit: number): Promise<string[]> => {
    const { rows } = await db.query<{ title: string; d: string }>(
      `SELECT title, to_char(published_at, 'YYYY-MM-DD') AS d FROM content_items WHERE source = $1 ORDER BY published_at DESC LIMIT $2`,
      [source, limit],
    );
    return rows.map((r) => `- [${label} ${r.d}] ${r.title}`);
  };
  const own = [...(await piece('cms-blog', 'blog', 10)), ...(await piece('cms-newsletter', 'newsletter', 4)), ...(await piece('cms-podcast-show-notes', 'podcast', 4))].join('\n');

  const eps = await db.query<{ title: string; d: string; body: string }>(
    `SELECT title, to_char(published_at, 'YYYY-MM-DD') AS d, left(coalesce(body, ''), $1) AS body FROM content_items
      WHERE (source = 'cms-podcast-show-notes' OR (source = 'note' AND (title ILIKE 'Podcast Show Notes%' OR title ILIKE 'Cloudy:%')))
      ORDER BY published_at DESC LIMIT 3`,
    [EPISODE_EXCERPT_CHARS],
  );
  const episodes = eps.rows.map((e) => `### ${e.title} (${e.d})\n${e.body}`).join('\n\n');
  return { own, episodes };
}

// ── Deep dive ────────────────────────────────────────────────────────────────

function divePrompt(schedule: string, own: string, episodes: string): string {
  return `You are the editorial strategist for Richard Hogan, Global Chief Architect in IBM's Microsoft Practice. He writes sceptical, strategic analysis for enterprise IT leaders and architects. He publishes ONE blog post roughly weekly, a fortnightly newsletter (Reaching for the Cloud: a considered issue on a broad, cross-cutting theme), a fortnightly podcast (Cloudy with a Chance of Insights: three hosts, a 10-15 minute topic needs a genuine tension or debate), and LinkedIn posts (a quick, sharp take).

Today's publishing rhythm:
${schedule}

You will be given ONE article that already scored highly in triage. Decide whether it is worth a piece from Richard NOW, and in which ONE format. Judge only from the article text and his own recent work below. Do not invent facts or quotes.

## His own recent pieces
${own || '(none)'}

## Recent podcast episodes (all three hosts' segments, so you can avoid repeating what his co-hosts covered)
${episodes || '(none)'}

## Decide
- news: what actually happened, in two plain sentences.
- angle: the thing Richard would say that the source does not — his take, in two sentences. If you cannot find a real angle, say so and give a low worth.
- format: exactly ONE of blog, linkedin, newsletter, podcast, whichever genuinely suits (blog = an argued 800+ word piece; linkedin = a short take; newsletter = broad cross-cutting theme worth a whole issue; podcast = a real debate that sustains 10-15 minutes). Use the publishing rhythm: a format whose deadline is within two days is too late for new material.
- formatReason: one sentence on why that format.
- whyNow: a dated hook from the article's own date ("announced 2 Oct") and why it matters this week. Never use an undated hook.
- headline: a working title or opening line in his voice.
- keyPoints: three short bullets he would make.
- covered: own = titles of his pieces that overlap SPECIFICALLY (same story or the same argument, not just the same broad theme); coHosts = topics his co-hosts covered recently that overlap specifically; verdict = "fresh" (nothing specific overlaps), "related" (same story from a different angle), or "rehash" (he or a co-host has already made this argument).
- risks: what could make this piece weak (thin angle, already everywhere, needs sources he lacks).
- worth: 0-100, how strongly you would recommend he writes/records it THIS week. Be sceptical: 85+ only for a clear, fresh angle on genuinely significant news.

Return ONLY JSON:
{"news":"","angle":"","format":"blog|linkedin|newsletter|podcast","formatReason":"","whyNow":"","headline":"","keyPoints":["","",""],"covered":{"own":[],"coHosts":[],"verdict":"fresh|related|rehash"},"risks":"","worth":0}`;
}

function parseDive(raw: string): DeepDive {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const json = cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1);
  const p = JSON.parse(json) as Partial<DeepDive> & { covered?: Partial<DeepDive['covered']> };
  const format = FORMATS.find((f) => f === p.format);
  if (format === undefined) throw new Error('the assessment did not name a format');
  const verdict = p.covered?.verdict === 'related' || p.covered?.verdict === 'rehash' ? p.covered.verdict : 'fresh';
  let worth = Math.max(0, Math.min(100, Math.round(Number(p.worth) || 0)));
  // The model already weighs overlap in its own score; only a true rehash is capped hard.
  if (verdict === 'rehash') worth = Math.min(worth, 40);
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
  return {
    at: new Date().toISOString(),
    news: text(p.news), angle: text(p.angle), format, formatReason: text(p.formatReason), whyNow: text(p.whyNow),
    headline: text(p.headline), keyPoints: list(p.keyPoints).slice(0, 4),
    covered: { own: list(p.covered?.own), coHosts: list(p.covered?.coHosts), verdict },
    risks: text(p.risks), worth,
  };
}

/** Extraction output carries site navigation and markdown links; keep the readable article. */
function cleanExtract(raw: string, title: string): string {
  let t = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const at = t.indexOf(title);
  if (at > 0 && at < t.length * 0.6) t = t.slice(at);
  return t.replace(/^[\s*\-]*$/gm, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const MIN_FULL_TEXT_CHARS = 800;

/** The article's text: read the page; if that fails or is thin, use the extraction service; else the feed summary. */
async function readArticleText(url: string | null, title: string, summary: string): Promise<{ text: string; source: 'page' | 'extract' | 'summary' }> {
  if (url !== null) {
    const page = (await fetchWebPage({ url })) as { success?: boolean; content?: string };
    if (page.success === true && typeof page.content === 'string' && page.content.length >= MIN_FULL_TEXT_CHARS) return { text: page.content, source: 'page' };
    if (isTavilyEnabled()) {
      try {
        await getTavilyMcpTools();
        const r = (await callTavilyMcpTool('tavily_extract', { urls: [url], extract_depth: 'basic' })) as { result?: unknown };
        const parsed = typeof r.result === 'string' ? (JSON.parse(r.result) as { results?: Array<{ raw_content?: string }> }) : {};
        const raw = parsed.results?.[0]?.raw_content;
        if (typeof raw === 'string') {
          const cleaned = cleanExtract(raw, title);
          if (cleaned.length >= MIN_FULL_TEXT_CHARS) return { text: cleaned, source: 'extract' };
        }
      } catch (err) {
        console.warn(`[ContentPick] extraction failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { text: summary, source: 'summary' };
}

interface ArticleRow { id: string; title: string; url: string | null; body: string | null; published_at: Date; metadata: Record<string, unknown> }

/** Reads one article in full and stores its assessment on the article. */
export async function runDeepDive(db: Pool, article: ArticleRow, ctx?: { schedule: string; own: string; episodes: string }): Promise<DeepDive> {
  const context = ctx ?? { schedule: describeSchedule(await getSchedule(db)), ...(await ownContext(db)) };
  const { text, source } = await readArticleText(article.url, article.title, article.body ?? '');
  const published = article.published_at.toISOString().slice(0, 10);
  const limited = source === 'summary'
    ? '\n\nNOTE: only the short feed summary is available — the site would not give up the full article. Judge significance from the title and summary alone, do not invent any detail beyond them, say plainly in "risks" that the full text could not be read, and do not give a worth above 60.'
    : '';
  const user = `Article: ${article.title}\nSource: ${String(article.metadata['sourceTitle'] ?? '')}\nPublished: ${published}\nURL: ${article.url ?? ''}\nTriage verdict: ${String(article.metadata['relevanceExplanation'] ?? '')}\n\nText:\n${text.slice(0, DEEP_DIVE_ARTICLE_CHARS)}${limited}`;
  const raw = await getFoundryClient().chatBulk(
    [{ role: 'system', content: divePrompt(context.schedule, context.own, context.episodes) }, { role: 'user', content: user }],
    3_000,
    150_000,
  );
  const dive = parseDive(raw);
  dive.textSource = source;
  if (source === 'summary') dive.worth = Math.min(dive.worth, 60);
  await db.query(`UPDATE content_items SET metadata = metadata || jsonb_build_object('deepDive', $2::jsonb) WHERE id = $1`, [article.id, JSON.stringify(dive)]);
  return dive;
}

/** Assesses strong, recent, un-assessed articles (a few per run, best first). Returns how many were done. */
export async function runPendingDeepDives(db: Pool, limit = 3, budgetMs = 240_000): Promise<number> {
  const { rows } = await db.query<ArticleRow & { relevance_score: number }>(
    `SELECT id::text, title, url, body, published_at, metadata, relevance_score FROM content_items
      WHERE source = 'discovered-article' AND workflow_state = 'to-review'
        AND relevance_score >= $1 AND published_at > now() - $2 * interval '1 day'
        AND NOT (metadata ? 'deepDive') AND COALESCE((metadata->>'deepDiveAttempts')::int, 0) < 2
      ORDER BY relevance_score DESC, published_at DESC LIMIT $3`,
    [STRONG_SCORE, CANDIDATE_WINDOW_DAYS, limit],
  );
  if (rows.length === 0) return 0;
  const started = Date.now();
  const ctx = { schedule: describeSchedule(await getSchedule(db)), ...(await ownContext(db)) };
  let done = 0;
  for (const row of rows) {
    if (Date.now() - started > budgetMs) break;
    try {
      await runDeepDive(db, { ...row, metadata: { ...row.metadata, relevanceExplanation: '' } }, ctx);
      done++;
    } catch (err) {
      console.warn(`[ContentPick] Deep dive failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      await db.query(
        `UPDATE content_items SET metadata = metadata || jsonb_build_object('deepDiveAttempts', COALESCE((metadata->>'deepDiveAttempts')::int, 0) + 1) WHERE id = $1`,
        [row.id],
      ).catch(() => undefined);
    }
  }
  return done;
}

// ── The pick ─────────────────────────────────────────────────────────────────

interface Candidate { id: string; title: string; url: string | null; published_at: Date; metadata: Record<string, unknown>; relevance_score: number; dive: DeepDive }

async function candidates(db: Pool): Promise<Candidate[]> {
  const { rows } = await db.query<Omit<Candidate, 'dive'>>(
    `SELECT ci.id::text, ci.title, ci.url, ci.published_at, ci.metadata, ci.relevance_score FROM content_items ci
      WHERE ci.source = 'discovered-article' AND ci.workflow_state IN ('to-review', 'saved')
        AND ci.published_at > now() - $1 * interval '1 day' AND ci.metadata ? 'deepDive'
        AND NOT EXISTS (SELECT 1 FROM content_picks p WHERE p.article_id = ci.id AND p.status IN ('done', 'dropped'))`,
    [CANDIDATE_WINDOW_DAYS],
  );
  return rows.map((r) => ({ ...r, dive: r.metadata['deepDive'] as DeepDive }));
}

function toPick(pickId: string, c: Candidate, carriedOver: boolean): DailyPick {
  return {
    pickId, articleId: c.id, title: c.title, url: c.url, sourceTitle: String(c.metadata['sourceTitle'] ?? ''),
    publishedAt: c.published_at.toISOString(), score: Math.round(c.relevance_score * 100), dive: c.dive, carriedOver,
  };
}

export interface PipelineSummary {
  pick: DailyPick | null;
  strongConsidered: number;
  linedUp: Array<{ format: ScheduledFormat; deadline: string; daysAway: number; candidates: number; best: string | null }>;
  scheduleText: string;
}

/** Keeps the open pick if it's still valid, else chooses a new one (or none). */
export async function chooseDailyPick(db: Pool): Promise<PipelineSummary> {
  const schedule = await getSchedule(db);
  const all = await candidates(db);

  // 1. Keep the open pick while it's still live.
  const open = await db.query<{ id: string; article_id: string; created_at: Date }>(
    `SELECT id::text, article_id::text, created_at FROM content_picks WHERE status = 'open' ORDER BY created_at DESC`,
  );
  let kept: DailyPick | null = null;
  for (const row of open.rows) {
    const c = all.find((x) => x.id === row.article_id);
    const fresh = Date.now() - row.created_at.getTime() < PICK_MAX_AGE_DAYS * 86_400_000;
    if (kept === null && c !== undefined && fresh) {
      kept = toPick(row.id, c, Date.now() - row.created_at.getTime() > 12 * 3_600_000);
    } else {
      const state = await db.query<{ workflow_state: string }>(`SELECT workflow_state FROM content_items WHERE id::text = $1`, [row.article_id]);
      const s = state.rows[0]?.workflow_state;
      const status = s === 'blog' || s === 'published' ? 'done' : s === 'archived' || s === 'shelved' ? 'dropped' : 'replaced';
      await db.query(`UPDATE content_picks SET status = $2, updated_at = NOW() WHERE id::text = $1`, [row.id, status]);
    }
  }

  // 2. Lined up for each deadline.
  const eligible = all.filter((c) => c.dive.worth >= PICK_MIN_WORTH - 5);
  const linedUp = (['newsletter', 'podcast'] as const).map((format) => {
    const mine = eligible.filter((c) => c.dive.format === format).sort((a, b) => b.dive.worth - a.dive.worth);
    return { format, deadline: schedule[format].next, daysAway: schedule[format].daysAway, candidates: mine.length, best: mine[0]?.dive.headline || mine[0]?.title || null };
  });
  // 3. Choose a new one. Formats whose deadline is too close are closed; the soonest open deadline is favoured.
  const closed = new Set<ContentFormat>((['newsletter', 'podcast'] as const).filter((f) => schedule[f].daysAway < TOO_LATE_DAYS));
  const open2 = (['newsletter', 'podcast'] as const).filter((f) => schedule[f].daysAway >= TOO_LATE_DAYS && schedule[f].daysAway <= PREP_WINDOW_DAYS).sort((a, b) => schedule[a].daysAway - schedule[b].daysAway);
  const due = open2[0];
  const ranked = all
    .filter((c) => !closed.has(c.dive.format) && c.dive.worth >= PICK_MIN_WORTH)
    .map((c) => ({ c, rank: c.dive.worth + (due !== undefined && c.dive.format === due ? 10 : 0) }))
    .sort((a, b) => b.rank - a.rank);

  // A standing pick is kept unless something clearly stronger has arrived since.
  if (kept !== null) {
    const keptRank = kept.dive.worth + (due !== undefined && kept.dive.format === due ? 10 : 0);
    const stronger = ranked.find((r) => r.c.id !== kept.articleId && r.rank >= keptRank + REPLACE_MARGIN);
    if (stronger === undefined) return { pick: kept, strongConsidered: all.length, linedUp, scheduleText: describeSchedule(schedule) };
    await db.query(`UPDATE content_picks SET status = 'replaced', updated_at = NOW() WHERE id::text = $1`, [kept.pickId]);
  }
  const best = ranked[0]?.c;
  let pick: DailyPick | null = null;
  if (best !== undefined) {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO content_picks (article_id, format, worth) VALUES ($1, $2, $3) RETURNING id::text`,
      [best.id, best.dive.format, best.dive.worth],
    );
    pick = toPick(ins.rows[0]!.id, best, false);
  }
  return { pick, strongConsidered: all.length, linedUp, scheduleText: describeSchedule(schedule) };
}

// ── For the morning briefing and chat ────────────────────────────────────────

const FORMAT_LABEL: Record<ContentFormat, string> = { blog: 'blog post', linkedin: 'LinkedIn post', newsletter: 'newsletter', podcast: 'podcast topic' };

export function describePipeline(p: PipelineSummary): string {
  const lines: string[] = ['## Content pick (from article discovery)', p.scheduleText];
  if (p.pick === null) {
    lines.push(`No pick today: ${p.strongConsidered.toString()} strong article(s) assessed in the last two weeks and none was judged strong enough (needs ${PICK_MIN_WORTH.toString()}+ and a fresh angle).`);
  } else {
    const { pick } = p;
    const d = pick.dive;
    lines.push(
      `PICK${pick.carriedOver ? ' (carried over from an earlier day — he has not acted on it yet)' : ''}: "${d.headline || pick.title}" as a ${FORMAT_LABEL[d.format]}`,
      `Article: ${pick.title} — ${pick.sourceTitle}, published ${pick.publishedAt.slice(0, 10)}, triage score ${pick.score.toString()}%, assessed worth ${d.worth.toString()}/100${pick.url !== null ? `\nLink: ${pick.url}` : ''}`,
      `The news: ${d.news}`,
      `His angle: ${d.angle}`,
      `Why this format: ${d.formatReason}`,
      `Why now: ${d.whyNow}`,
      `Key points: ${d.keyPoints.join(' | ')}`,
      `Coverage check: ${d.covered.verdict}${d.covered.own.length > 0 ? `; his related pieces: ${d.covered.own.join('; ')}` : ''}${d.covered.coHosts.length > 0 ? `; co-hosts covered: ${d.covered.coHosts.join('; ')}` : ''}`,
      `Risk: ${d.risks}`,
    );
  }
  const lined = p.linedUp.map((l) => `${l.format} (due in ${l.daysAway.toString()} days): ${l.candidates === 0 ? 'nothing lined up' : `${l.candidates.toString()} candidate(s), best "${l.best ?? ''}"`}`);
  lines.push(`Lined up: ${lined.join('; ')}`);
  return lines.join('\n');
}

/** Facts for the morning briefing (assesses any strong articles not yet assessed, within a short budget). */
export async function buildContentPickFacts(db: Pool): Promise<string> {
  await runPendingDeepDives(db, 3, 80_000).catch((err: unknown) => { console.warn('[ContentPick] deep dives failed:', err); });
  return describePipeline(await chooseDailyPick(db));
}

export type PickResolution = 'done' | 'dropped';

/** Closes the open pick: he went with it ('done') or doesn't want it ('dropped' — never suggested again). */
export async function resolveOpenPick(db: Pool, status: PickResolution): Promise<{ title: string } | null> {
  const open = await db.query<{ id: string; title: string }>(
    `SELECT p.id::text, ci.title FROM content_picks p JOIN content_items ci ON ci.id = p.article_id WHERE p.status = 'open' ORDER BY p.created_at DESC LIMIT 1`,
  );
  const row = open.rows[0];
  if (row === undefined) return null;
  await db.query(`UPDATE content_picks SET status = $2, updated_at = NOW() WHERE id::text = $1`, [row.id, status]);
  return { title: row.title };
}
