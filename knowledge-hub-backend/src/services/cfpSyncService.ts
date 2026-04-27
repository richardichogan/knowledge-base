/**
 * cfpSyncService.ts
 *
 * Fetches Call for Papers from CallingAllPapers API and the Adato Systems RSS
 * digest, deduplicates, persists to cfp_items, and AI-scores new entries.
 *
 * Auto-archives items scoring below 0.35 — they never surface in the feed.
 */

import type { Pool } from 'pg';
import { FoundryClient } from '../ai/foundryClient.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Supported sync sources */
export type CfpSource = 'callingallpapers' | 'adatosystems';

/** Workflow states for a CFP item */
export type CfpWorkflowState = 'to_review' | 'saved' | 'submitted' | 'archived';

/** A single normalised CFP entry before DB insertion */
interface NormalisedCfp {
  source: CfpSource;
  conferenceName: string;
  description: string | null;
  tags: string[];
  eventUri: string | null;
  cfpUri: string;
  cfpDeadline: Date;
  eventStart: Date | null;
  eventEnd: Date | null;
  location: string | null;
  isVirtual: boolean;
  rawPayload: unknown;
}

/** Filter options for getCfpItems */
export interface CfpFilter {
  workflowState?: CfpWorkflowState;
  limit?: number;
  offset?: number;
}

/** A CFP item as returned to the API layer */
export interface CfpItem {
  id: string;
  source: CfpSource;
  conferenceName: string;
  description: string | null;
  tags: string[];
  eventUri: string | null;
  cfpUri: string;
  cfpDeadline: string;    // ISO string
  eventStart: string | null;
  eventEnd: string | null;
  location: string | null;
  isVirtual: boolean;
  relevanceScore: number | null;
  relevanceReason: string | null;
  workflowState: CfpWorkflowState;
  discoveredAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

const CAP_URL = 'https://callingallpapers.com/api/cfp';
const RSS_URL = 'https://adatosystems.com/feed/';
const AUTO_ARCHIVE_THRESHOLD = 0.35;
const SCORE_BATCH_SIZE = 10;

const SCORING_SYSTEM_PROMPT = `You are a relevance scoring assistant for a technology professional. Your job is to evaluate whether a conference Call for Papers (CFP) is worth the user's attention as a potential speaker.

The user's professional profile:
- Global Chief Architect in IBM's Microsoft Practice
- Focus areas: Microsoft Azure, Microsoft 365, Dynamics 365, Power Platform, Microsoft Copilot, cloud security, AI architecture, agentic AI systems
- Industry specialisation: Financial Services
- Content created: blog posts, newsletter, podcast on Microsoft cloud technology
- Speaking goal: build visibility through conference speaking in the Microsoft and cloud architecture community
- Location: United Kingdom — prefers European and UK events but considers global events with strong relevance

Score the CFP on a scale from 0.0 to 1.0 where:
- 0.8–1.0: Strong match. Topics align directly with user's focus areas.
- 0.5–0.79: Partial match. Some overlap with user's expertise.
- 0.2–0.49: Weak match. Loosely related.
- 0.0–0.19: No match.

Respond only with valid JSON: { "score": 0.0, "reason": "One sentence." }`;

// ── CallingAllPapers fetch ────────────────────────────────────────────────

/** Raw shape returned by the CallingAllPapers API */
interface CapEntry {
  name?: string;
  description?: string;
  tags?: string[];
  eventUri?: string;
  cfpUri?: string;
  dateCfpEnd?: string;
  dateEventStart?: string;
  dateEventEnd?: string;
  location?: string;
}

/**
 * Fetches open CFPs from CallingAllPapers.
 * Filters out any with a deadline in the past.
 */
async function fetchFromCallingAllPapers(): Promise<NormalisedCfp[]> {
  const res = await fetch(CAP_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CallingAllPapers fetch failed: ${res.status}`);

  const json = await res.json() as { cfps?: CapEntry[] };
  const entries: CapEntry[] = json.cfps ?? (Array.isArray(json) ? (json as CapEntry[]) : []);
  const now = new Date();

  return entries
    .filter((e): e is CapEntry & { name: string; cfpUri: string; dateCfpEnd: string } =>
      !!e.name && !!e.cfpUri && !!e.dateCfpEnd)
    .map((e) => ({
      source: 'callingallpapers' as CfpSource,
      conferenceName: e.name.trim(),
      description: e.description?.trim() ?? null,
      tags: e.tags ?? [],
      eventUri: e.eventUri ?? null,
      cfpUri: e.cfpUri,
      cfpDeadline: new Date(e.dateCfpEnd),
      eventStart: e.dateEventStart ? new Date(e.dateEventStart) : null,
      eventEnd: e.dateEventEnd ? new Date(e.dateEventEnd) : null,
      location: e.location?.trim() ?? null,
      isVirtual: /virtual|online|remote/i.test(e.location ?? ''),
      rawPayload: e,
    }))
    .filter((c) => c.cfpDeadline > now);
}

// ── Adato RSS fetch ───────────────────────────────────────────────────────

/**
 * Fetches the Adato Systems RSS feed and extracts CFP entries.
 * Posts contain structured CFP listings; we parse via regex patterns.
 */
async function fetchFromAdatoRss(): Promise<NormalisedCfp[]> {
  const res = await fetch(RSS_URL, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
  if (!res.ok) throw new Error(`Adato RSS fetch failed: ${res.status}`);

  const xml = await res.text();
  const now = new Date();
  const results: NormalisedCfp[] = [];

  // Extract <item> blocks
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(xml)) !== null) {
    const item = itemMatch[1];
    // Get post content — try <content:encoded> first, fallback to <description>
    const contentMatch = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/.exec(item ?? '')
      ?? /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(item ?? '');
    if (!contentMatch) continue;

    const content = contentMatch[1] ?? '';

    // Each CFP entry follows a pattern like:
    // Conference Name — Location | Dates | CFP closes: DATE | Submit: URL | Website: URL
    // We use broad patterns to pick up variations.
    const cfpBlockPattern =
      /([A-Z][^\n|—–-]{5,80})\s*[|—–-]\s*([^\n|]{3,80})\s*\|[^\n]*?CFP[^:]*:\s*([A-Za-z0-9 ,]+\d{4})[^\n]*(?:Submit|CFP Link|Apply)[^:]*:\s*(https?:\/\/[^\s<"]+)/gi;

    let match: RegExpExecArray | null;
    const CONTEXT_BEFORE = 20;
    const CONTEXT_AFTER = 200;
    while ((match = cfpBlockPattern.exec(content)) !== null) {
      const nameRaw = match[1];
      const locationRaw = match[2];
      const deadlineRaw = match[3];
      const cfpUri = match[4];
      if (!nameRaw || !locationRaw || !deadlineRaw || !cfpUri) continue;
      const cfpDeadline = new Date(deadlineRaw.trim());
      if (isNaN(cfpDeadline.getTime()) || cfpDeadline <= now) continue;

      // Try to extract website URL nearby
      const surroundingText = content.slice(
        Math.max(0, match.index - CONTEXT_BEFORE),
        match.index + match[0].length + CONTEXT_AFTER,
      );
      const websiteMatch = /(?:Website|Event|Conference)[^:]*:\s*(https?:\/\/[^\s<"]+)/i.exec(surroundingText);

      results.push({
        source: 'adatosystems',
        conferenceName: nameRaw.trim(),
        description: null,
        tags: [],
        eventUri: websiteMatch?.[1] ?? null,
        cfpUri: cfpUri.trim(),
        cfpDeadline,
        eventStart: null,
        eventEnd: null,
        location: locationRaw.trim(),
        isVirtual: /virtual|online|remote/i.test(locationRaw),
        rawPayload: { source: 'adato-rss', name: nameRaw.trim(), deadline: deadlineRaw },
      });
    }
  }

  return results;
}

// ── Deduplication & persistence ───────────────────────────────────────────

/**
 * Inserts new CFP items, skipping duplicates via the unique constraint on
 * (conference_name, event_start). Returns count of newly inserted rows.
 */
async function persistCfps(db: Pool, items: NormalisedCfp[]): Promise<number> {
  let inserted = 0;

  for (const item of items) {
    const result = await db.query(
      `INSERT INTO cfp_items
         (source, conference_name, description, tags, event_uri, cfp_uri,
          cfp_deadline, event_start, event_end, location, is_virtual, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (conference_name, event_start) DO NOTHING
       RETURNING id`,
      [
        item.source,
        item.conferenceName,
        item.description,
        item.tags,
        item.eventUri,
        item.cfpUri,
        item.cfpDeadline,
        item.eventStart,
        item.eventEnd,
        item.location,
        item.isVirtual,
        JSON.stringify(item.rawPayload),
      ],
    );
    if ((result.rowCount ?? 0) > 0) inserted++;
  }

  return inserted;
}

// ── AI scoring ────────────────────────────────────────────────────────────

/** Scores a batch of unscored CFP items and auto-archives low-relevance ones. */
async function scoreUnscored(db: Pool): Promise<void> {
  const foundry = new FoundryClient();

  const { rows } = await db.query<{
    id: string; conference_name: string; description: string | null;
    tags: string[]; location: string | null; event_start: Date | null; event_end: Date | null;
  }>(
    `SELECT id, conference_name, description, tags, location, event_start, event_end
     FROM cfp_items
     WHERE relevance_score IS NULL AND workflow_state = 'to_review'
     ORDER BY discovered_at DESC
     LIMIT $1`,
    [SCORE_BATCH_SIZE],
  );

  for (const row of rows) {
    try {
      const userMsg = [
        `Conference: ${row.conference_name}`,
        row.description ? `Description: ${row.description.slice(0, 500)}` : null,
        row.tags.length ? `Tags: ${row.tags.join(', ')}` : null,
        row.location ? `Location: ${row.location}` : null,
        row.event_start ? `Event dates: ${row.event_start.toISOString().slice(0, 10)}` +
          (row.event_end ? ` – ${row.event_end.toISOString().slice(0, 10)}` : '') : null,
      ].filter(Boolean).join('\n');

      const raw = await foundry.chat(
        'gpt-4o-mini',
        [
          { role: 'system', content: SCORING_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        200,
      );

      const parsed = JSON.parse(raw) as { score: number; reason: string };
      const score = Math.max(0, Math.min(1, parsed.score));
      const state = score < AUTO_ARCHIVE_THRESHOLD ? 'archived' : 'to_review';

      await db.query(
        `UPDATE cfp_items
         SET relevance_score = $1, relevance_reason = $2, workflow_state = $3, scored_at = NOW()
         WHERE id = $4`,
        [score, parsed.reason, state, row.id],
      );
    } catch (err) {
      console.error(`[CFP] Scoring failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetches from both sources, deduplicates, persists, and scores new items.
 * Safe to call multiple times — idempotent via unique constraint.
 */
export async function syncCfps(db: Pool): Promise<{ indexed: number; errors: number }> {
  let indexed = 0;
  let errors = 0;

  const results = await Promise.allSettled([
    fetchFromCallingAllPapers(),
    fetchFromAdatoRss(),
  ]);

  const all: NormalisedCfp[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else {
      errors++;
      console.error(`[CFP] Fetch error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }

  try {
    indexed = await persistCfps(db, all);
  } catch (err) {
    errors++;
    console.error(`[CFP] Persist error: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await scoreUnscored(db);
  } catch (err) {
    errors++;
    console.error(`[CFP] Scoring error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { indexed, errors };
}

/**
 * Returns CFP items for the Discover feed, ordered by deadline ascending
 * so the most urgent ones appear first.
 */
export async function getCfpItems(db: Pool, filter: CfpFilter = {}): Promise<CfpItem[]> {
  const { workflowState = 'to_review', limit = 50, offset = 0 } = filter;

  const { rows } = await db.query<{
    id: string; source: string; conference_name: string; description: string | null;
    tags: string[]; event_uri: string | null; cfp_uri: string; cfp_deadline: Date;
    event_start: Date | null; event_end: Date | null; location: string | null;
    is_virtual: boolean; relevance_score: number | null; relevance_reason: string | null;
    workflow_state: string; discovered_at: Date;
  }>(
    `SELECT id, source, conference_name, description, tags, event_uri, cfp_uri,
            cfp_deadline, event_start, event_end, location, is_virtual,
            relevance_score, relevance_reason, workflow_state, discovered_at
     FROM cfp_items
     WHERE workflow_state = $1
     ORDER BY cfp_deadline ASC
     LIMIT $2 OFFSET $3`,
    [workflowState, limit, offset],
  );

  return rows.map((r) => ({
    id: r.id,
    source: r.source as CfpSource,
    conferenceName: r.conference_name,
    description: r.description,
    tags: r.tags ?? [],
    eventUri: r.event_uri,
    cfpUri: r.cfp_uri,
    cfpDeadline: r.cfp_deadline.toISOString(),
    eventStart: r.event_start?.toISOString() ?? null,
    eventEnd: r.event_end?.toISOString() ?? null,
    location: r.location,
    isVirtual: r.is_virtual,
    relevanceScore: r.relevance_score,
    relevanceReason: r.relevance_reason,
    workflowState: r.workflow_state as CfpWorkflowState,
    discoveredAt: r.discovered_at.toISOString(),
  }));
}

/**
 * Updates the workflow state of a single CFP item.
 * Returns true if the row was found and updated.
 */
export async function updateCfpWorkflowState(
  db: Pool,
  id: string,
  state: CfpWorkflowState,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE cfp_items SET workflow_state = $1 WHERE id = $2 RETURNING id`,
    [state, id],
  );
  return (result.rowCount ?? 0) > 0;
}
