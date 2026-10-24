import type { Pool } from 'pg';

/** Conservatively account for pre-ledger posts; historic Discover records lack an account snapshot. */
export async function importPublishingHistory(db: Pool, destination: 'bluesky' | 'linkedin', account: string): Promise<void> {
  const key = destination === 'bluesky' ? 'blueskyPost' : 'linkedinPost';
  await db.query(`INSERT INTO publishing_deliveries(identity,destination,account,topic_id,status,attempted_at,published_at,receipt,error)
    SELECT 'discover:' || c.id,$1,$2,(SELECT topic_id FROM publishing_sources WHERE item_id=c.id),
      CASE WHEN c.metadata->$3->>'status'='posted' THEN 'sent' ELSE 'unconfirmed' END,
      COALESCE((c.metadata->$3->>'postedAt')::timestamptz,(c.metadata->$3->>'claimedAt')::timestamptz,c.indexed_at),
      (c.metadata->$3->>'postedAt')::timestamptz,c.metadata->$3,
      CASE WHEN c.metadata->$3->>'status'<>'posted' THEN 'Legacy delivery requires reconciliation.' ELSE NULL END
    FROM content_items c WHERE c.metadata->$3->>'status' IN ('posted','posting','unconfirmed')
      AND COALESCE(c.metadata->$3->>'ledgerManaged','false')<>'true'
      AND (c.metadata->$3->>'status'<>'posted' OR (c.metadata->$3->>'postedAt')::timestamptz>NOW()-INTERVAL '2 days')
    ON CONFLICT(identity,destination) DO NOTHING`, [destination, account, key]);
  await db.query(`INSERT INTO publishing_deliveries(identity,destination,account,status,attempted_at,published_at,receipt,error)
    SELECT 'jobs:' || r.id || ':' || $1,$1,
      CASE WHEN $1='linkedin' THEN COALESCE(r.artifacts->'linkedinAccount'->>'id',$2)
        ELSE COALESCE(r.artifacts->'publishTargets'->>'blueskyAccount',$2) END,
      CASE WHEN s->>'status'='succeeded' THEN 'sent' ELSE 'unconfirmed' END,
      COALESCE((s->>'startedAt')::timestamptz,r.created_at),
      CASE WHEN s->>'status'='succeeded' THEN COALESCE((s->>'finishedAt')::timestamptz,r.updated_at) ELSE NULL END,
      s->'result',CASE WHEN s->>'status'<>'succeeded' THEN 'Legacy job delivery requires reconciliation.' ELSE NULL END
    FROM managed_job_runs r CROSS JOIN LATERAL jsonb_array_elements(r.steps) s
    WHERE s->>'key'=$1 AND (
      (s->>'status'='succeeded' AND COALESCE((s->>'finishedAt')::timestamptz,r.updated_at)>NOW()-INTERVAL '2 days')
      OR s->>'status'='unconfirmed'
      OR (s->>'status'='running' AND (s->>'startedAt')::timestamptz<(SELECT MIN(created_at) FROM publishing_feeds)))
    ON CONFLICT(identity,destination) DO NOTHING`, [destination, account]);
}
