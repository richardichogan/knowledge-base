---
applyTo: "knowledge-hub-backend/**"
---

# Backend (knowledge-hub-backend) instructions

## Server

- Runs on port **3000** via `node --import tsx/esm src/server.ts`. Check it isn't already running before starting it (avoid EADDRINUSE).
- The frontend needs this running to show data — if the frontend shows empty data, check the backend first.

## Database migrations

- Migrations live in `knowledge-hub-backend/migrations/*.sql` and run automatically on every backend startup via `runMigrations()` in `src/db/migrate.ts`, tracked in an `applied_migrations` table — idempotent, safe to redeploy without a manual migration step.
- The Dockerfile must copy both `schema.sql` and `migrations/*.sql` into `dist/db/` — if a new migration isn't showing up in prod logs after deploy, check this first.

## Verification

- Always run `tsc --noEmit` in `knowledge-hub-backend` after changes, before declaring work done.
- Never deploy to production without an explicit instruction from the user to do so. See the root `copilot-instructions.md` for the full Azure deployment runbook.
