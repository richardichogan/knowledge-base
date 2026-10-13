# Operations runbook

What is verified from repository code is marked **(code)**. Anything that needs the live Azure environment is marked **(cloud, not verified here)** and must be run as separate, explicitly permitted work. Never deploy or touch production without an explicit instruction.

## 1. Release identity

A release is the triple recorded at deploy time:

| Part | Where it comes from |
|---|---|
| Git commit on `main` | `git rev-parse HEAD` after the pre-deploy sync |
| Backend image | `cad79107555facr.azurecr.io/kh-prod-api:v<NN>` (increment the current tag) |
| Frontend | built from the same synced worktree; no version stamp exists |

Record these in the deploy message. The backend has no version endpoint: `/health` returns only `status` and `timestamp` (code). Identify the running backend with
`az containerapp show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --query "properties.template.containers[0].image" -o tsv`.
Identify applied schema with `SELECT filename, applied_at FROM applied_migrations ORDER BY filename`.

## 2. Migration compatibility

- Migrations are `knowledge-hub-backend/src/db/migrations/NNN_*.sql`, applied automatically at server start by `applyMigrations` (code).
- Each file runs in its own transaction, guarded by a Postgres advisory lock, and is recorded in `applied_migrations`. A failed file rolls back and stops startup; the revision will not become ready.
- Migrations are **forward-only**. There are no down scripts. Write them additive (`IF NOT EXISTS`, new nullable columns or tables) so the previous image keeps working against the new schema.
- Compatibility rule: the schema may be ahead of the running image by one release, never behind. Deploy order is backend (applies migrations) then frontend.
- Next free number: 070.

## 3. Smoke checks after a deploy

1. `az containerapp revision list --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --query "[].{name:name,active:properties.active,health:properties.healthState,running:properties.runningState}" -o table` shows the new revision `Healthy` and running.
2. `az containerapp logs show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --tail 30` shows `apply <file>` for new migrations and no errors.
3. `GET /health` returns `ok`; `GET /ready` returns 200 with `ready` (code). `/ready` returns 503 while starting.
4. Open the site, sign in, and load Today, Projects (open a Cockpit), Think and Chat. Confirm no error banners.
5. If any check fails, follow section 4.

## 4. Rollback and its limits

- **Code:** `az containerapp update ... --image cad79107555facr.azurecr.io/kh-prod-api:v<previous>` (or activate the previous revision). Frontend: redeploy a build from the previous commit.
- **Schema is not rolled back.** Because migrations are additive, the previous image normally runs on the newer schema. A migration that dropped or renamed anything cannot be undone by rollback; restore from backup (section 5) instead.
- **Data written by new features** (for example packets, register items, health data) stays in place and is simply unused by the old image.
- Rolling back never reverts secrets or environment variables; revert those separately.

## 5. Backup and restore

Repository code does not take or verify backups. Treat all of the following as **(cloud, not verified here)**:

- Confirm the database's automated backup/point-in-time-restore retention in the Azure portal or with `az`, and record the retention window.
- A restore is always into a **new** server/database, never over production. Validate the restored copy (section 3 checks against it), then cut over deliberately.
- A real restore rehearsal has not been performed. Do it as its own permissioned task and record the date, source time, duration and result here.

Offline rehearsal (code): run `node scripts\run-isolated-tests.mjs` from the repo root. It builds disposable in-memory PGlite databases, applies migrations and exercises recovery and cockpit logic with no network access.

## 6. Environment isolation

- Local development must use a local or disposable database and never the production connection string. Check `DATABASE_URL` before starting the backend.
- Tests use in-memory PGlite, and the packet evaluation cases assert no non-loopback network calls (code).
- Secrets live in Container App secrets and are referenced with `secretref:`; never put them in source or committed `.env` files.
- Production OpenAI, SMTP and source-sync credentials must not be copied into local environments. Use separate test resources.
- **(cloud, not verified here)** Confirm that the production database firewall/VNet rules reject non-production clients, and record the result.

## 7. Cloud verification still to do

Each needs explicit permission before running: backup retention check, restore rehearsal into a scratch database, network-isolation probe, and confirmation that rollback to the previous image works.
