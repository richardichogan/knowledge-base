# PostgreSQL capacity upgrade

- Status: Completed and verified, 2026-10-21 at 22:00 UTC.
- Resource: kh-prod-pg-r6mgdn, rg-knowledge-hub-prod, Alliance Tenant Reporting,
  UK South.
- Assessment: Standard_B1ms Burstable, PostgreSQL 16, 32 GB Premium_LRS storage,
  seven-day backups. Confirmed connection exhaustion during Watchlist project
  context loading. Current max_connections 50, reserved_connections 5 and
  superuser_reserved_connections 10; sampled 33 idle client connections and one
  active connection.
- User approved General Purpose Standard_D2ds_v5, two vCores / 8 GB RAM,
  increased ongoing cost and possible brief disconnect during in-place resize.
- Availability: Azure list-skus includes Standard_D2ds_v5 in UK South.
- Preserve server/address, PostgreSQL version, data, storage, backups, networking
  and credentials. No deletion, migration or application deployment.
- Validate Ready state, target SKU and real database connection limits after
  completion. Application query-concurrency fixes remain separate and local.
- Rollback: retain the same server and data; if the resize fails, inspect Azure
  state before retrying. A return to Standard_B1ms / Burstable requires user
  confirmation and another brief interruption. No automatic destructive rollback.
- Result: Azure reports GeneralPurpose Standard_D2ds_v5, Ready. PostgreSQL 16,
  32 GB storage and seven-day backup retention preserved.
- Azure retained max_connections=50 after the compute resize. User separately
  approved max_connections=100 and a restart. Parameter update and restart
  completed successfully; no configuration restart is pending.
- Direct SQL connection verified knowledge_hub is reachable with
  max_connections=100, reserved_connections=5 and
  superuser_reserved_connections=10: 85 ordinary slots versus 35 previously.
- No application code was deployed and no Watchlist analysis was rerun.
