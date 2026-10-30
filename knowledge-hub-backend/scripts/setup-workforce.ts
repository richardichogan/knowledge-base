import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { contentSignature, parseBudgetLimits, WORKFORCE_VERSION } from '../src/agents/workforce/contracts.js';
import { workforceTransaction } from '../src/agents/workforce/store.js';
import { assertWorkforceSchemaReady, WORKFORCE_MIGRATIONS as MIGRATIONS } from '../src/agents/workforce/readiness.js';

const HELP = `Manual-blog workforce setup (no authoring or publishing is performed).

Read-only readiness:
  npm run workforce:setup -- --check --owner <authenticated-user-id>

Explicit setup:
  npm run workforce:setup -- --apply --owner <authenticated-user-id> --calls <integer> --tokens <integer> --minutes <integer> --approve --workers-drained

For a shared production database, also pass --shared-database.
The owner must match the application's authenticated user ID (dev-user only
when using the existing development authentication).

--apply installs only migrations 123-126 and creates/reuses an immutable,
owner-approved manual-blog budget profile. Earlier migrations must already be
applied. Stop incompatible workers first. Repeating the same setup does not
refill assignments, alter existing profiles or start work.

After setup, start the local backend with ATHENA_WORKFORCE_MANUAL_BLOG=true.
Use Start drafting in Discover/Spark, inspect Background work, then open the
saved draft in the existing editor. Recheck uses Momus without rewriting.
No automatic publishing is enabled; local scheduled delivery remains disabled.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' }, check: { type: 'boolean' }, apply: { type: 'boolean' },
      owner: { type: 'string' }, calls: { type: 'string' }, tokens: { type: 'string' }, minutes: { type: 'string' },
      approve: { type: 'boolean' }, 'workers-drained': { type: 'boolean' }, 'shared-database': { type: 'boolean' },
    },
    strict: true, allowPositionals: false,
  });
  if (values.help) { console.log(HELP); return; }
  if (Boolean(values.check) === Boolean(values.apply)) throw new Error('Choose exactly one of --check or --apply. Use --help for setup instructions.');
  const ownerId = values.owner?.trim();
  if (!ownerId) throw new Error('--owner must be the authenticated application user ID.');
  if (values.check && (values.approve || values['workers-drained'] || values.calls || values.tokens || values.minutes)) {
    throw new Error('--check is read-only; approval, worker-drain and budget arguments belong to --apply.');
  }
  const limits = values.apply ? parseBudgetLimits({
    calls: Number(values.calls), tokens: Number(values.tokens), durationMs: Number(values.minutes) * 60_000,
  }) : null;
  if (values.apply && (!values.approve || !values['workers-drained'])) {
    throw new Error('Setup requires --approve for the supplied numeric limits and --workers-drained after stopping incompatible workers.');
  }

  const { env } = await import('../src/config/env.js');
  const { assertSafeDatabase } = await import('../src/runtime.js');
  assertSafeDatabase(env.DATABASE_MODE, env.DATABASE_URL, env.NODE_ENV);
  if (values.apply && (env.DATABASE_MODE === 'production' || env.NODE_ENV === 'production') && !values['shared-database']) {
    throw new Error('This is a shared production database. Explicit setup additionally requires --shared-database.');
  }
  const { getDb, closeDb } = await import('../src/db/db.js');
  const db = getDb();
  try {
    const tracking = await db.query<{ present: boolean }>("SELECT to_regclass('applied_migrations') IS NOT NULL AS present");
    if (!tracking.rows[0]?.present) throw new Error('The existing application schema must be installed before workforce setup.');
    const applied = await db.query<{ filename: string }>('SELECT filename FROM applied_migrations');
    const installed = new Set(applied.rows.map(row => row.filename));
    const directory = new URL('../src/db/migrations/', import.meta.url);
    const predecessors = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && name < MIGRATIONS[0]!);
    const missingPredecessors = predecessors.filter(name => !installed.has(name));
    if (missingPredecessors.length) throw new Error(`Earlier application migrations are missing: ${missingPredecessors.join(', ')}. Workforce setup does not apply unrelated migrations.`);
    const pending = MIGRATIONS.filter(name => !installed.has(name));
    if (values.apply) {
      const running = await db.query("SELECT id FROM agent_jobs WHERE status='running' LIMIT 1");
      if (running.rowCount) throw new Error('A specialist job is still running. Drain incompatible workers before setup.');
      const { applyMigrations } = await import('../src/db/migrate.js');
      await applyMigrations(db, '', MIGRATIONS.map(filename => ({
        filename, sql: readFileSync(new URL(filename, directory), 'utf8'),
      })));
    } else if (pending.length) {
      console.log(JSON.stringify({ ready: false, pendingMigrations: pending, ownerId, next: 'Run explicit setup with approved limits; see --help.' }, null, 2));
      process.exitCode = 1;
      return;
    }

    await assertWorkforceSchemaReady(db);
    const profile = values.apply && limits ? await workforceTransaction(db, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-budget-profile:manual-blog'))");
      const existing = await client.query<{ id: string; limits: unknown }>(
        `SELECT id,limits FROM agent_budget_profiles WHERE workflow='manual-blog' AND workflow_version=$1
          AND policy_profile='manual-blog' AND approved_by=$2 AND enabled ORDER BY approved_at DESC,id LIMIT 1 FOR SHARE`,
        [WORKFORCE_VERSION, ownerId],
      );
      const latest = existing.rows[0];
      if (latest && contentSignature(parseBudgetLimits(latest.limits)) === contentSignature(limits)) return latest;
      const id = randomUUID();
      await client.query(
        `INSERT INTO agent_budget_profiles(id,workflow,workflow_version,policy_profile,version,limits,approved_by,approved_at,enabled)
          SELECT $1,'manual-blog',$2,'manual-blog',COALESCE(MAX(version),0)+1,$3::jsonb,$4,clock_timestamp(),TRUE
          FROM agent_budget_profiles WHERE workflow='manual-blog' AND workflow_version=$2 AND policy_profile='manual-blog'`,
        [id, WORKFORCE_VERSION, JSON.stringify(limits), ownerId],
      );
      return { id, limits };
    }) : (await db.query<{ id: string; limits: unknown }>(
      `SELECT id,limits FROM agent_budget_profiles WHERE workflow='manual-blog' AND workflow_version=$1
        AND policy_profile='manual-blog' AND approved_by=$2 AND enabled ORDER BY approved_at DESC,id LIMIT 1`,
      [WORKFORCE_VERSION, ownerId],
    )).rows[0];
    if (profile) parseBudgetLimits(profile.limits);
    const ready = Boolean(profile) && env.ATHENA_WORKFORCE_MANUAL_BLOG;
    console.log(JSON.stringify({
      ready, ownerId, profileId: profile?.id ?? null, limits: profile?.limits ?? null,
      executorConfigured: env.ATHENA_WORKFORCE_MANUAL_BLOG,
      next: !profile ? 'Run setup with explicit approved limits.' : !env.ATHENA_WORKFORCE_MANUAL_BLOG
        ? 'Start/restart the local backend with ATHENA_WORKFORCE_MANUAL_BLOG=true.'
        : 'Start/restart the local backend, then use the existing Start drafting action. This check is configuration readiness, not a live editorial acceptance result.',
    }, null, 2));
    if (values.check && !ready) process.exitCode = 1;
  } finally { await closeDb(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error('[workforce setup]', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
