# Fabric, Fabric IQ and Fabric data agents: assessment for Athena

Status: **assessment only. Do not implement.** Recorded on 18 October 2026 for future reference.

## Summary

For Athena as a day-to-day personal app, Fabric adds **little**. It is only worth doing if one of these matters:

1. Asking about Athena's data from Teams or Microsoft 365 Copilot.
2. Getting Power BI dashboards without building UI in Athena.
3. Showcasing Fabric IQ on a real app, as content for the blog and podcast.

Recommendation: **do not migrate Athena for Fabric.** If it's ever tried, run a small, time-boxed proof of concept (see the end of this document).

## Current database (as of this assessment)

- `kh-prod-pg-r6mgdn`: Azure Database for PostgreSQL flexible server, PostgreSQL 16, UK South.
  - Burstable `Standard_B1ms`, 32 GB storage.
  - Lives in `rg-knowledge-hub-prod`, subscription "Alliance Tenant Reporting".
- Public access is on, plus private endpoint `kh-prod-pg-pe`. Password auth only.
- `wal_level=replica`.
- Athena depends heavily on Postgres-only features:
  - `jsonb` (about 95 uses), `ON CONFLICT` (about 91), `gen_random_uuid` (about 44)
  - `tsvector`/`to_tsquery` full-text search
  - pgvector
  - 80 migrations and the `pg` driver

## Can Postgres move "into" Fabric?

No. Fabric's native databases are Fabric SQL database (the SQL Server engine) and Cosmos DB. Moving Athena to Fabric SQL database would mean rewriting the data layer, and it is not recommended.

What Fabric *can* do is **mirror** an Azure Database for PostgreSQL flexible server (this is GA):

- It continuously replicates the database, one-way, into OneLake as Delta/Parquet.
- You get a read-only SQL analytics endpoint and one-click Power BI.
- Athena keeps using Postgres unchanged.

## Moving the app to the new subscription

Moving gives no Fabric benefit by itself. Fabric works across the Entra tenant, and a capacity in one subscription should be able to mirror a server in another subscription in the same tenant (still to be verified).

Move only for billing or organisational reasons. If you do move, the migration covers:

- Container Apps and ACR
- Static Web App and its custom domain
- Postgres (restore or dump)
- VNet and the private endpoint
- Secrets and storage
- Azure OpenAI references (the GPT-5.5 resource is in another subscription)

## What each piece would give, with Athena examples

### 1. Mirroring plus a SQL endpoint and Power BI

Dashboards with no Athena UI work, for example:

- Discover saves against published posts, per month
- Podcast topics against episodes
- Stalled drafts by project
- Which sources lead to ideas that get used
- Build tasks that fail, by repo

### 2. Fabric data agent (GA)

Natural-language questions over the mirror, a semantic model or an ontology, usable from Teams, Microsoft 365 Copilot, Copilot Studio or Foundry:

- "What tasks are overdue on Project Imagine?"
- "Which Discover articles did I save this week but never turn into a note?"
- "How many LinkedIn posts came from Discover items this month?"

Athena's own chat can already answer most of these through its database tools. The gain is *where* you ask, not *what* you can ask.

### 3. Fabric IQ ontology (preview)

This is the genuinely new capability.

- **Entities:** Project, Topic/Tag, Note, Spark, Source, Task, ContentItem/Channel, Episode, BuildTask.
- **Relationships:** for example, Note mentions Topic; ContentItem derived from Source; Task belongs to Project.
- **Rules in plain language:**
  - "A draft is stalled if untouched for 7 days."
  - "A podcast topic is ready when it has two or more sources and a note."
- **Agents** can monitor these rules and alert or act. Example: "every Monday, tell me which planned podcast topics have no source notes yet."

This overlaps with planned features 4 (why-picked), 6 (pipeline board) and 7 (memory), and with the parked "pipeline health" and "ask the archive" ideas in `docs/planned-features.md`.

## What it would not give

- A faster app or better search.
- Any of the planned UI features, such as backlinks and `@` mentions.
- Live reads for Athena: the mirror is read-only and slightly behind live data, so Athena's UI still reads Postgres.
- Writes from Fabric: any write-back must go through Athena's API.
- Possibly a duplicate AI: Athena chat and a Fabric agent would answer about the same data.
- Overlap with the existing `kh-foundry-iq-search` (Azure AI Search / Foundry IQ retrieval).

## Costs and constraints

- **Capacity:** a paid Fabric capacity of F2 or higher, billed continuously, is required for data agents. The tenant settings for cross-geo AI processing and storage must also be enabled.
- **Database tier:** mirroring probably needs a tier above Burstable B1ms. Verify this against the compute-tier section of the mirroring docs.
- **Database setting:** `wal_level` must change to `logical`, which needs a server restart.
- **Table support:** check the limits on tables without primary keys and on unsupported data types.
- **Maturity:** the ontology is in preview.
- **Upkeep:** one more system to run.

## Proof of concept, if ever pursued

1. Mirror only the main tables: notes, tasks, projects, content_items, sparks, and podcast tables.
2. Build one semantic model or ontology and one data agent.
3. Try three real questions from Teams.
4. Keep it if it's actually used; otherwise switch the mirror and capacity off.

## Open questions

- Is the new subscription in the same Entra tenant?
- Should the whole app move, or only the Fabric pieces?
- What capacity SKU and region does the new subscription have? UK South is preferred.
- Is Entra auth on Postgres acceptable if mirroring prefers or needs it?
