/**
 * services/discoverPicks.ts — the morning "Worth posting today" picks on Today.
 * Three to-review or saved Discover articles, never already posted, each with a suggested angle.
 * Generated daily by the `discover-picks` managed job and on demand from Today or Athena.
 */
import type { Pool } from 'pg';
import { getFoundryClient } from '../ai/foundryClient.js';
import { getSyncState, upsertSyncState } from '../db/queries.js';
import { formatFitSql } from '../integrations/cms/formatFit.js';
import { discoverRankSql } from '../integrations/cms/discoverRank.js';
import { DISCOVER_RECENCY_HALF_LIFE_DAYS } from '../config/constants.js';
import { POSTED_ARTICLE_SQL } from './discoverWorkflow.js';

const STATE_KEY = 'discover-picks';
const CANDIDATES = 12;
const PICKS = 3;
const EXCERPT_CHARS = 700;
const ANGLE_CHARS = 400;
const MAX_TOKENS = 1_200;
const TIMEOUT_MS = 90_000;
const ISO_DATE_LENGTH = 10;

export interface DiscoverPick {
  id: string; title: string; url: string | null; source: string;
  workflowState: 'to-review' | 'saved'; publishedAt: string | null; angle: string;
}
export interface DiscoverPicks {
  generatedAt: string; trigger: 'job' | 'manual' | 'athena';
  picks: DiscoverPick[]; removed: number; note: string | null;
}

interface CandidateRow {
  id: string; title: string; url: string | null; source_title: string; workflow_state: 'to-review' | 'saved';
  published_at: Date | null; excerpt: string | null; relevance_explanation: string | null;
}

const PROMPT = [
  'You are Athena choosing what Richard Hogan (IBM consultant focused on Microsoft, Azure, Copilot and AI adoption) should post on LinkedIn or Bluesky today.',
  `From the candidate Discover articles, choose the ${PICKS} that are most worth a social post today: timely, credible, and where Richard has a distinct practitioner view.`,
  'Avoid picking near-duplicate stories. For each pick, write a one-sentence angle in UK English: the point of view Richard would take, not a summary of the article.',
  'Use only the facts given. Return the article ids exactly as provided.',
].join('\n');

let inFlight: Promise<DiscoverPicks> | null = null;

async function candidates(db: Pool): Promise<CandidateRow[]> {
  const { rank } = discoverRankSql('ci', '$1');
  const { rows } = await db.query<CandidateRow>(
    `SELECT ci.id, ci.title, ci.url, COALESCE(ci.metadata->>'sourceTitle', '') AS source_title, ci.workflow_state,
            ci.published_at, LEFT(COALESCE(ci.summary, ci.body, ''), ${EXCERPT_CHARS}) AS excerpt, ci.relevance_explanation
       FROM content_items ci
      WHERE ci.source = 'discovered-article' AND ci.workflow_state IN ('to-review', 'saved')
        AND NOT COALESCE(${POSTED_ARTICLE_SQL}, FALSE) AND ci.relevance_score IS NOT NULL
      ORDER BY ${formatFitSql('ci', 'social')} DESC, (${rank}) DESC NULLS LAST, ci.published_at DESC NULLS LAST, ci.id
      LIMIT $2`,
    [DISCOVER_RECENCY_HALF_LIFE_DAYS, CANDIDATES]);
  return rows;
}

async function save(db: Pool, value: DiscoverPicks): Promise<void> {
  await upsertSyncState(db, STATE_KEY, { lastSyncAt: new Date(value.generatedAt), lastCursor: JSON.stringify(value), itemCount: value.picks.length, lastError: null });
}

async function generate(db: Pool, trigger: DiscoverPicks['trigger']): Promise<DiscoverPicks> {
  const rows = await candidates(db);
  const generatedAt = new Date().toISOString();
  if (rows.length === 0) {
    const empty: DiscoverPicks = { generatedAt, trigger, picks: [], removed: 0, note: 'No unposted to-review or saved Discover articles are available.' };
    await save(db, empty);
    return empty;
  }
  const facts = rows.map(r => ({
    id: r.id, title: r.title, source: r.source_title, state: r.workflow_state,
    published: r.published_at?.toISOString().slice(0, ISO_DATE_LENGTH) ?? 'unknown', whyRelevant: r.relevance_explanation ?? '', excerpt: r.excerpt ?? '',
  }));
  const raw = await getFoundryClient('discover-picks').chat('standard',
    [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify(facts) }], MAX_TOKENS, TIMEOUT_MS, undefined,
    { name: 'discover_picks', schema: {
      type: 'object', additionalProperties: false, required: ['picks'],
      properties: { picks: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'angle'],
        properties: { id: { type: 'string' }, angle: { type: 'string' } },
      } } },
    } });
  const parsed = JSON.parse(raw) as { picks?: Array<{ id?: unknown; angle?: unknown }> };
  const byId = new Map(rows.map(r => [r.id, r]));
  const seen = new Set<string>();
  const picks: DiscoverPick[] = [];
  for (const p of parsed.picks ?? []) {
    const row = typeof p.id === 'string' ? byId.get(p.id) : undefined;
    const angle = typeof p.angle === 'string' ? p.angle.trim().slice(0, ANGLE_CHARS) : '';
    if (!row || !angle || seen.has(row.id) || picks.length >= PICKS) continue;
    seen.add(row.id);
    picks.push({ id: row.id, title: row.title, url: row.url, source: row.source_title, workflowState: row.workflow_state,
      publishedAt: row.published_at?.toISOString() ?? null, angle });
  }
  if (picks.length === 0) throw new Error('Athena did not return any valid Discover picks.');
  const result: DiscoverPicks = { generatedAt, trigger, picks, removed: 0, note: null };
  await save(db, result);
  return result;
}

/** Regenerates the picks; concurrent requests share one generation. */
export function refreshDiscoverPicks(db: Pool, trigger: DiscoverPicks['trigger']): Promise<DiscoverPicks> {
  inFlight ??= generate(db, trigger).finally(() => { inFlight = null; });
  return inFlight;
}

/** Latest saved picks, dropping any article posted, dismissed or moved since they were chosen. */
export async function getDiscoverPicks(db: Pool): Promise<DiscoverPicks | null> {
  const state = await getSyncState(db, STATE_KEY);
  if (state?.lastCursor == null) return null;
  let stored: DiscoverPicks;
  try { stored = JSON.parse(state.lastCursor) as DiscoverPicks; } catch { return null; }
  if (stored.picks.length === 0) return stored;
  const { rows } = await db.query<{ id: string; workflow_state: 'to-review' | 'saved' }>(
    `SELECT id, workflow_state FROM content_items
      WHERE id::text = ANY($1::text[]) AND workflow_state IN ('to-review', 'saved') AND NOT COALESCE(${POSTED_ARTICLE_SQL}, FALSE)`,
    [stored.picks.map(p => p.id)]);
  const live = new Map(rows.map(r => [String(r.id), r.workflow_state]));
  const picks = stored.picks.filter(p => live.has(p.id)).map(p => ({ ...p, workflowState: live.get(p.id)! }));
  return { ...stored, picks, removed: stored.picks.length - picks.length };
}

export function discoverPicksRunning(): boolean { return inFlight !== null; }
