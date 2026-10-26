import type { Pool } from 'pg';
import type { WatchCompanyProfile, WatchlistInput, WatchProfileSource } from '../types/watchlists.js';
import { searchCompanyProfile, WatchProfileResearchError } from './watchlistSearch.js';

interface ProfileRow {
  entity_name: string; sources: Record<string, WatchProfileSource>; researched_at: Date | null;
  last_attempt_at: Date; last_error: string | null; search_context: string;
}
const RESEARCH_CONCURRENCY = 2;

export async function loadWatchlistProfiles(db: Pool, id: string): Promise<Map<string, WatchCompanyProfile>> {
  const { rows } = await db.query<ProfileRow>(
    'SELECT * FROM discover_watchlist_company_profiles WHERE watchlist_id=$1', [id]);
  return new Map(rows.map(row => [row.entity_name, {
    sources: Object.values(row.sources).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt)),
    researchedAt: row.researched_at?.toISOString() ?? null, lastAttemptAt: row.last_attempt_at.toISOString(),
    error: row.last_error, searchContext: row.search_context,
  }]));
}

/** Manual checks refresh profiles; scheduled checks initialise or repair missing background. */
export async function refreshWatchlistProfiles(db: Pool, id: string, config: WatchlistInput, refresh: boolean,
  research: typeof searchCompanyProfile = searchCompanyProfile): Promise<void> {
  const saved = await loadWatchlistProfiles(db, id);
  const context = config.searchContext ?? '';
  const pending = config.entities.filter(entity => {
    const profile = saved.get(entity.name);
    return refresh || !profile?.sources.length || !!profile.error || profile.searchContext !== context;
  });
  const update = async (name: string): Promise<void> => {
    const attemptedAt = new Date().toISOString();
    let sources: WatchProfileSource[] = [];
    let error: string | null = null;
    try {
      sources = await research(name, context);
      if (!sources.length) throw new Error('No background sources were returned.');
    } catch (cause) {
      error = cause instanceof WatchProfileResearchError ? cause.message
        : 'Background research could not establish usable sources. Existing knowledge is retained; Run now retries it.';
      console.warn(`[Watchlists] Background research needs attention for ${name}: ${error}`);
    }
    await db.query(
      `INSERT INTO discover_watchlist_company_profiles AS p
        (watchlist_id,entity_name,search_context,sources,researched_at,last_attempt_at,last_error)
       SELECT $1,$2,$3,$4::jsonb,CASE WHEN $5::text IS NULL THEN $6::timestamptz ELSE NULL END,$6::timestamptz,$5
        WHERE EXISTS(SELECT 1 FROM discover_watchlists WHERE id=$1 AND config=$7::jsonb)
       ON CONFLICT(watchlist_id,entity_name) DO UPDATE SET
         sources=p.sources || EXCLUDED.sources,
         search_context=CASE WHEN EXCLUDED.last_error IS NULL THEN EXCLUDED.search_context ELSE p.search_context END,
         researched_at=COALESCE(EXCLUDED.researched_at,p.researched_at),
         last_attempt_at=EXCLUDED.last_attempt_at,last_error=EXCLUDED.last_error
       WHERE p.last_attempt_at<=EXCLUDED.last_attempt_at`,
      [id, name, context, JSON.stringify(Object.fromEntries(sources.map(source => [source.id, source]))),
        error, attemptedAt, JSON.stringify(config)],
    );
  };
  for (let offset = 0; offset < pending.length; offset += RESEARCH_CONCURRENCY) {
    await Promise.all(pending.slice(offset, offset + RESEARCH_CONCURRENCY).map(entity => update(entity.name)));
  }
}
