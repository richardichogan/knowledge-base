/**
 * The Discover weighted rank, shared by the Discover list and podcast research so both order
 * articles identically. Never stored: recomputed live from the editorial relevance_score with
 * recency decay, source authority, article type and project-fit factors.
 */
import { SOURCE_AUTHORITY_WEIGHTS, ARTICLE_TYPE_WEIGHTS } from './articleScoringPrompt.js';

/**
 * Builds a SQL CASE expression mapping a metadata text column's value to its weight, generated
 * directly from the same TS weight map used elsewhere — so tuning a weight constant takes effect
 * immediately in ranking, with no backfill/rescore step required to keep SQL and TS in sync.
 */
function buildWeightCaseExpr(column: string, weights: Record<string, number>, fallback = 1): string {
  const whens = Object.entries(weights)
    .map(([key, value]) => `WHEN '${key.replace(/'/g, "''")}' THEN ${value}`)
    .join(' ');
  return `CASE ${column} ${whens} ELSE ${fallback} END`;
}

export interface DiscoverRankSql { rank: string; recency: string; authority: string; articleType: string; project: string }

/** `halfLifeParam` is the SQL placeholder (e.g. `$3`) bound to the recency half-life in days. */
export function discoverRankSql(alias: string, halfLifeParam: string): DiscoverRankSql {
  const authority = buildWeightCaseExpr(`${alias}.metadata->>'sourceAuthorityTier'`, SOURCE_AUTHORITY_WEIGHTS, 1);
  const articleType = buildWeightCaseExpr(`${alias}.metadata->>'articleType'`, ARTICLE_TYPE_WEIGHTS, 1);
  const recency = `EXP(- EXTRACT(EPOCH FROM (NOW() - ${alias}.published_at)) / 86400.0 / ${halfLifeParam} * LN(2))`;
  const project = `(1 + COALESCE((${alias}.metadata->>'projectBoost')::real, 0))`;
  const rank = `COALESCE(${alias}.relevance_score, 0) * ${recency} * (${authority}) * (${articleType}) * ${project}`;
  return { rank, recency, authority, articleType, project };
}
