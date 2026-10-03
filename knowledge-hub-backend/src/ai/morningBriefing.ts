/**
 * ai/morningBriefing.ts — Athena's morning briefing.
 *
 * Generated at 09:00 UK time (after the morning sync), covering everything
 * since the previous briefing: GitHub activity per repo (with failed CI runs
 * and deployments, and open PRs from others called out), today's meetings,
 * tasks due or overdue, new OneDrive documents, and integrations that are
 * failing. Saved as a pinned "Morning briefing" Athena chat (the previous
 * day's is unpinned), which the app opens first the first time Athena is
 * used each day and shows on the Today page.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { getFoundryClient } from './foundryClient.js';
import { setSessionPinned, renameSession } from './chatSessionStore.js';
import { getSyncState, upsertSyncState } from '../db/queries.js';
import { buildContentPickFacts } from './contentPick.js';
import { buildTodayScheduleBlock, workToday, WORK_TIMEZONE } from '../integrations/ibm/ibmMeetings.js';

const STATE_KEY = 'morning-briefing';
export const BRIEFING_HOUR = 9;
const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_MS = DAY_MS;
/** After a long weekend the briefing still only looks back this far. */
const MAX_LOOKBACK_DAYS = 4;
const MAX_LOOKBACK_MS = MAX_LOOKBACK_DAYS * DAY_MS;
const COMMITS_LISTED = 5;
const ISO_DATE_CHARS = 10;
const ERROR_CHARS = 160;
const GITHUB_ITEMS_LIMIT = 250;
const LIST_LIMIT = 15;
const BRIEFING_MAX_TOKENS = 1_400;
const FACTS_MAX_CHARS = 24_000;

export interface Briefing {
  date: string;
  sessionId: string;
  markdown: string;
  generatedAt: string;
}

interface StoredBriefing { date: string; sessionId: string; generatedAt: string }

/** The hour (0–23) in UK time. */
export function workHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, hour: '2-digit', hour12: false }).format(now));
}

async function loadState(db: Pool): Promise<StoredBriefing | null> {
  const s = await getSyncState(db, STATE_KEY);
  if (s?.lastCursor == null) return null;
  try { return JSON.parse(s.lastCursor) as StoredBriefing; } catch { return null; }
}

export async function getTodaysBriefing(db: Pool): Promise<Briefing | null> {
  const state = await loadState(db);
  if (state === null || state.date !== workToday()) return null;
  const msg = await db.query<{ content: string }>(
    `SELECT content FROM ai_chat_messages WHERE session_id::text = $1 AND role = 'assistant' ORDER BY created_at LIMIT 1`, [state.sessionId]);
  const markdown = msg.rows[0]?.content;
  return markdown === undefined ? null : { ...state, markdown };
}

// ── Gathering ─────────────────────────────────────────────────────────────────

interface Row { source: string; title: string; published_at: Date; url: string | null; metadata: Record<string, unknown> | null }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function gatherFacts(db: Pool, since: Date): Promise<string> {
  const me = (env.GITHUB_USERNAME ?? '').toLowerCase();
  const sections: string[] = [];

  // GitHub, grouped by repo.
  const gh = await db.query<Row>(
    `SELECT source, title, published_at, url, metadata FROM content_items
      WHERE source IN ('github-commit','github-pr','github-pr-review','github-issue','github-action','github-deployment','github-release')
        AND published_at > $1
      ORDER BY published_at DESC LIMIT $2`,
    [since.toISOString(), GITHUB_ITEMS_LIMIT],
  );
  const byRepo = new Map<string, Row[]>();
  for (const r of gh.rows) {
    const repo = str(r.metadata?.['repo']) || 'unknown repo';
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), r]);
  }
  const failures: string[] = [];
  const repoLines: string[] = [];
  for (const [repo, rows] of byRepo) {
    const commits = rows.filter((r) => r.source === 'github-commit');
    const prs = rows.filter((r) => r.source === 'github-pr');
    const issues = rows.filter((r) => r.source === 'github-issue');
    const releases = rows.filter((r) => r.source === 'github-release');
    const reviews = rows.filter((r) => r.source === 'github-pr-review');
    const runs = rows.filter((r) => r.source === 'github-action');
    const deploys = rows.filter((r) => r.source === 'github-deployment');
    for (const r of runs) {
      const c = str(r.metadata?.['conclusion']);
      if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') failures.push(`- CI failed: ${r.title} (${repo})${r.url !== null ? ` ${r.url}` : ''}`);
    }
    for (const r of deploys) {
      const s = str(r.metadata?.['state']);
      if (s === 'failure' || s === 'error') failures.push(`- Deployment failed: ${r.title}${r.url !== null ? ` ${r.url}` : ''}`);
    }
    const parts = [
      commits.length > 0 ? `${commits.length.toString()} commit(s): ${commits.slice(0, COMMITS_LISTED).map((c) => `"${c.title}"`).join('; ')}` : '',
      ...prs.map((p) => `PR #${str(p.metadata?.['number'])} "${p.title}" — ${str(p.metadata?.['state'])} by ${str(p.metadata?.['authorLogin'])}`),
      ...issues.map((i) => `Issue #${str(i.metadata?.['number'])} "${i.title}" — ${str(i.metadata?.['state'])}`),
      ...releases.map((r) => `Release "${r.title}"`),
      ...reviews.map((r) => `Review: ${r.title}`),
      runs.length > 0 ? `${runs.length.toString()} CI run(s)` : '',
      deploys.length > 0 ? `${deploys.length.toString()} deployment(s)` : '',
    ].filter(Boolean);
    repoLines.push(`### ${repo}\n${parts.map((p) => `- ${p}`).join('\n')}`);
  }
  sections.push(`## GitHub since ${since.toISOString()}\n${repoLines.length > 0 ? repoLines.join('\n') : 'No activity.'}`);
  if (failures.length > 0) sections.push(`## Needs attention: failures\n${failures.slice(0, LIST_LIMIT).join('\n')}`);

  // Open PRs by other people (likely waiting on Richard).
  const open = await db.query<Row>(
    `SELECT source, title, published_at, url, metadata FROM content_items
      WHERE source = 'github-pr' AND metadata->>'state' = 'open' AND lower(coalesce(metadata->>'authorLogin','')) <> $1
      ORDER BY published_at DESC LIMIT $2`,
    [me, LIST_LIMIT],
  );
  if (open.rows.length > 0) {
    sections.push(`## Open PRs from others (may need Richard's review)\n${open.rows.map((p) =>
      `- ${str(p.metadata?.['repo'])} #${str(p.metadata?.['number'])} "${p.title}" by ${str(p.metadata?.['authorLogin'])}, updated ${p.published_at.toISOString().slice(0, ISO_DATE_CHARS)}${p.url !== null ? ` ${p.url}` : ''}`).join('\n')}`);
  }

  sections.push(await buildTodayScheduleBlock(db));

  const tasks = await db.query<{ title: string; due_date: Date; status: string; project_id: string | null }>(
    `SELECT title, due_date, status, project_id FROM tasks
      WHERE archived = FALSE AND status <> 'completed' AND due_date IS NOT NULL AND due_date <= CURRENT_DATE
      ORDER BY due_date LIMIT $1`, [LIST_LIMIT]);
  if (tasks.rows.length > 0) {
    sections.push(`## Tasks due today or overdue\n${tasks.rows.map((t) =>
      `- ${t.title} (due ${t.due_date.toISOString().slice(0, ISO_DATE_CHARS)}, ${t.status}${t.project_id !== null ? `, ${t.project_id}` : ''})`).join('\n')}`);
  }

  const docs = await db.query<{ title: string; project_context: string | null }>(
    `SELECT title, project_context FROM content_items WHERE source = 'onedrive-document' AND indexed_at > $1 ORDER BY indexed_at DESC LIMIT $2`,
    [since.toISOString(), LIST_LIMIT]);
  if (docs.rows.length > 0) {
    sections.push(`## New or updated OneDrive documents\n${docs.rows.map((d) => `- ${d.title}${d.project_context !== null ? ` (${d.project_context})` : ''}`).join('\n')}`);
  }

  const broken = await db.query<{ source: string; last_error: string }>(
    `SELECT source, last_error FROM sync_state
      WHERE last_error IS NOT NULL AND last_error <> '' AND updated_at > NOW() - INTERVAL '2 days' AND source <> $1
        AND last_error NOT ILIKE '%visual pages described%'
      ORDER BY source`, [STATE_KEY]);
  if (broken.rows.length > 0) {
    sections.push(`## Integrations reporting errors\n${broken.rows.map((b) => `- ${b.source}: ${b.last_error.slice(0, ERROR_CHARS)}`).join('\n')}`);
  }
  return sections.join('\n\n').slice(0, FACTS_MAX_CHARS);
}

// ── Generating ────────────────────────────────────────────────────────────────

const BRIEFING_PROMPT = [
  'You are Athena, writing Richard\'s morning briefing. Using ONLY the facts provided, write a short, scannable briefing in UK English Markdown:',
  '1. Start with "## Needs your attention" — only real actions: failed CI runs or deployments, open PRs from others that may need his review, overdue tasks, meetings that need prep, broken integrations he must fix (e.g. an expired key). If nothing, say so in one line.',
  '2. "## Overnight on GitHub" — one short line per repo that had activity (what happened, not a list of every commit). Skip repos with only routine CI runs.',
  '3. "## Today" — his meetings (times, and flag clashes or prep), then tasks due today.',
  '4. Optionally "## New documents" if any arrived.',
  '5. "## Content pick" — from the "Content pick" facts: the ONE suggested topic in the ONE format given, as a short block that opens with the FORMAT and the working title on one bold line (for example "**Blog post: <title>**" or "**Podcast topic: <title>**"), then a line on why it is worth doing now (the dated hook), his angle in one or two sentences, the link, and a closing line saying what is lined up for the next podcast and newsletter with their dates. Offer nothing else: no second format unless the facts give a reason. If a pick is carried over, say he has not acted on it yet. If the facts say there is no pick, write one line saying nothing was strong enough today. Never invent a topic.',
  'If there are more than 5 open PRs, list the 5 most recent and add "and N more".',
  'Keep it under 330 words. Only use links that appear in the facts — never placeholder links. Never invent anything not in the facts. No greeting line and no sign-off.',
].join('\n');

/** Generates (or regenerates) today's briefing and saves it as the pinned "Morning briefing" chat. */
export async function generateMorningBriefing(db: Pool): Promise<Briefing> {
  const previous = await loadState(db);
  const now = new Date();
  const since = previous !== null && previous.date !== workToday()
    ? new Date(Math.max(new Date(previous.generatedAt).getTime(), now.getTime() - MAX_LOOKBACK_MS))
    : new Date(now.getTime() - DEFAULT_LOOKBACK_MS);
  const facts = `${await gatherFacts(db, since)}\n\n${await buildContentPickFacts(db).catch((err: unknown) => { console.warn('[Briefing] content pick failed:', err); return ''; })}`;
  const markdown = await getFoundryClient('morning-brief').chat(
    'standard',
    [{ role: 'system', content: BRIEFING_PROMPT }, { role: 'user', content: facts }],
    BRIEFING_MAX_TOKENS,
  );

  const date = workToday(now);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(now);
  // Regenerating today's briefing replaces it; a new day gets a new chat.
  const sessionId = previous !== null && previous.date === date ? previous.sessionId : randomUUID();
  if (previous !== null && previous.date === date) {
    await db.query(`DELETE FROM ai_chat_messages WHERE session_id::text = $1`, [sessionId]);
  } else {
    await db.query(`INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);
    if (previous !== null) await setSessionPinned(db, previous.sessionId, false).catch(() => undefined);
  }
  await db.query(
    `INSERT INTO ai_chat_messages (session_id, role, content, persona, sources) VALUES ($1, 'assistant', $2, 'general', $3)`,
    [sessionId, markdown, ['morning_briefing']],
  );
  await renameSession(db, sessionId, `Morning briefing — ${label}`);
  await setSessionPinned(db, sessionId, true);
  await db.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id::text = $1`, [sessionId]);

  const stored: StoredBriefing = { date, sessionId, generatedAt: now.toISOString() };
  await upsertSyncState(db, STATE_KEY, { lastSyncAt: now, lastCursor: JSON.stringify(stored), lastError: null });
  return { ...stored, markdown };
}

/**
 * True when today's briefing is due: from 09:00 UK, if none has been made
 * today — or one was made early (before 09:00) by hand, which the 09:00 run
 * remakes so it includes the morning sync.
 */
export async function briefingDue(db: Pool, now = new Date()): Promise<boolean> {
  if (workHour(now) < BRIEFING_HOUR) return false;
  const state = await loadState(db);
  if (state === null || state.date !== workToday(now)) return true;
  return workHour(new Date(state.generatedAt)) < BRIEFING_HOUR;
}
