import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import type { InterestWeight } from '../types/watchlists.js';
const MAX_TERM = 128;
const MAX_WEIGHT = 2;

export async function listInterestWeights(db: Pool): Promise<InterestWeight[]> {
  return (await db.query<InterestWeight>('SELECT kind,term,weight FROM discover_interest_weights ORDER BY kind,term')).rows;
}
export function parseInterestWeight(value: unknown): InterestWeight {
  if (!value || typeof value !== 'object') throw new ValidationError('Invalid interest weight.');
  const v = value as Record<string, unknown>;
  if ((v['kind'] !== 'topic' && v['kind'] !== 'source') || typeof v['term'] !== 'string'
    || !v['term'].trim() || v['term'].length > MAX_TERM || typeof v['weight'] !== 'number'
    || !Number.isFinite(v['weight']) || v['weight'] < 0 || v['weight'] > MAX_WEIGHT) throw new ValidationError('Interest weights must be between 0 and 2.');
  return { kind: v['kind'], term: v['term'].trim().toLowerCase(), weight: v['weight'] };
}
export async function saveInterestWeight(db: Pool, value: unknown): Promise<InterestWeight[]> {
  const v = parseInterestWeight(value);
  await db.query(`INSERT INTO discover_interest_weights(kind,term,weight) VALUES($1,$2,$3)
    ON CONFLICT(kind,term) DO UPDATE SET weight=EXCLUDED.weight,updated_at=NOW()`, [v.kind, v.term, v.weight]);
  return listInterestWeights(db);
}
/** Match literal text rather than LIKE patterns, so a configured "%" is not a wildcard. */
export function interestSql(alias: string): { factor: string; topics: string; source: string; saved: string } {
  const match = `strpos(lower(${alias}.title || ' ' || COALESCE(${alias}.body,'')),iw.term)>0`;
  const topics = `(SELECT string_agg(iw.term || ' ×' || iw.weight::text, ', ' ORDER BY iw.term)
    FROM discover_interest_weights iw WHERE iw.kind='topic' AND ${match})`;
  const topic = `COALESCE((SELECT CASE WHEN MIN(iw.weight)=0 THEN 0 ELSE AVG(iw.weight) END
    FROM discover_interest_weights iw WHERE iw.kind='topic' AND ${match}),1)`;
  const source = `COALESCE((SELECT iw.weight FROM discover_interest_weights iw WHERE iw.kind='source'
    AND iw.term=lower(COALESCE(${alias}.metadata->>'sourceTitle',''))),1)`;
  const saved = `CASE WHEN EXISTS(SELECT 1 FROM content_items saved WHERE saved.source='discovered-article'
    AND saved.workflow_state='saved' AND saved.id<>${alias}.id
    AND saved.metadata->>'sourceTitle'=${alias}.metadata->>'sourceTitle'
    AND saved.published_at>NOW()-INTERVAL '90 days') THEN 1.1 ELSE 1 END`;
  return { factor: `(${topic}) * (${source}) * (${saved})`, topics, source, saved };
}
