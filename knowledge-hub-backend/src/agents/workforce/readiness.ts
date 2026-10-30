import type { Pool } from 'pg';

export const WORKFORCE_MIGRATIONS = [
  '123_workforce_foundation.sql',
  '124_workforce_chat_notices.sql',
  '125_workforce_notice_acknowledgement.sql',
  '126_workforce_blog_revisions.sql',
] as const;

/** Enabled executors must not start against an incomplete shared database. */
export async function assertWorkforceSchemaReady(db: Pool): Promise<void> {
  const tracking = await db.query<{ present: boolean }>(
    "SELECT to_regclass('applied_migrations') IS NOT NULL AS present",
  );
  if (!tracking.rows[0]?.present) throw new Error('Workforce setup is missing. Run npm run workforce:setup -- --help before enabling the executor.');
  const applied = await db.query<{ filename: string }>(
    'SELECT filename FROM applied_migrations WHERE filename=ANY($1::text[])', [[...WORKFORCE_MIGRATIONS]],
  );
  const installed = new Set(applied.rows.map(row => row.filename));
  const pending = WORKFORCE_MIGRATIONS.filter(name => !installed.has(name));
  if (pending.length) throw new Error(`Workforce setup is incomplete: ${pending.join(', ')}. Run npm run workforce:setup -- --help; workers were not started.`);
  await db.query(`SELECT a.id,a.brief,a.budget_profile_id,p.limits,j.assignment_id,j.lease_owner,j.lease_until,
      e.acknowledged_at,m.workforce_event_id FROM agent_assignments a
      JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
      LEFT JOIN agent_jobs j ON j.assignment_id=a.id
      LEFT JOIN agent_assignment_events e ON e.assignment_id=a.id
      LEFT JOIN ai_chat_messages m ON m.workforce_event_id=e.id LIMIT 0`);
}
