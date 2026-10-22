# Knowledge coverage

This page documents what Athena can discover and read, how that is reported, and how to roll the feature back. The source of truth for dispositions is `knowledge-hub-backend/src/ai/knowledge/manifest.ts`; the Knowledge health page (`/health`, `GET /api/health/knowledge`) reports the same families live. Test traceability is in [knowledge-test-traceability.md](knowledge-test-traceability.md).

## How coverage is reported

Coverage is never a single percentage. Knowledge health shows, per family:

- **State:** Up to date, Partial coverage, Unsupported extraction, Not configured, Temporarily unavailable, or Excluded by design.
- **Counts:** indexed records (canonical `content_items` rows for the family's sources), plus eligible, pending and failed. A count that cannot be measured is returned as `null` and shown as "Not measured", never as zero.
- **Extraction distribution:** full text, metadata only (empty body) and at the ingestion size cap (8,000 characters). Per-record extraction state is not recorded, so "failed" and "unsupported" extraction are not separately counted.
- **Last indexed** and the **last successful sync**; **error categories** are a fixed vocabulary (`sync-errors`, `sync-run-failed`). No error text, prompt or source body is ever returned.
- **Semantic search** state. It is never "Up to date" because a provider is connected: it needs measured, drained indexing work with at least one completed item. A configured provider with no measured work reads "Connected, coverage not measured".

Eligible counts and per-family pending/failed counts are not recorded anywhere today, so no record-coverage percentage is shown. Optional tables (indexing work, decision records) are feature-detected; when absent the figures are "Not measured".

In chat, the "Used:" line separates **Found** (search candidate, not necessarily read), **Read** (available to the answer) and **Cited** (supports the answer). Older replies without a `lifecycle` field show explicitly looked-at sources as Read and background retrieval as Found. Deleted or missing targets show "No longer available" and are not linked. External links must be http(s) and are dropped if they carry credentials. Warnings are scoped to the reply or one source; there is no permanent global banner for a temporary optional-provider failure.

## Feature flag and indexing switch

- `KNOWLEDGE_ORCHESTRATION` (`1`, `true`, `on` or `yes`) turns on the new orchestration. It is off by default; the previous tools stay registered and compatible.
- Bulk indexing is controlled by the admin switch for durable indexing work. Pausing it stops new batches but keeps pending work, leases and tombstones so nothing is lost.

## Rollback procedure

1. Set `KNOWLEDGE_ORCHESTRATION` off on the container app (`az containerapp update --set-env-vars KNOWLEDGE_ORCHESTRATION=false`) and let the new revision become Healthy. Old compatible tools resume.
2. Pause bulk indexing with the admin switch. Durable pending work is kept.
3. Do not delete canonical source records, old indexes, embeddings or migrations. Migrations are additive, so the previous application version starts against the current schema.
4. Deletion and exclusion enforcement must hold in both paths. If the old path cannot enforce a newly required protection, disable that retrieval rather than re-enabling an unsafe fallback.
5. Diagnose from safe failure counts, provider status and revision-level retry metadata on Knowledge health. Never log prompt or source bodies or secrets.
6. Rollback triggers: any leak, incorrect accepted-decision attribution, a false comprehensive claim, a sustained budget breach, or a critical regression. A deployment can be healthy while reasoning acceptance fails; report those as separate outcomes.

## Exclusions

Never included in any projection: tokens, passwords, signing material, connection strings, secret-bearing configuration, auth headers, raw environment variables, binary/base64 blobs, internal backups, unconfirmed write proposals presented as completed actions, and operational payloads without a reviewed user-facing projection. A title or path alone does not authorise sending contents to every model; private (IBM/IMAGINE) material is kept distinct from independent/public outputs.

## Known partial coverage

- Indexed copies are capped at ingestion (library files at 8,000 characters), so long documents are only fully readable through ID-based readers.
- Notes have no paged reader yet; note bodies may be truncated in the index.
- YouTube records are metadata and description only. There is no transcript, so a video must never be described as watched.
- Connected activity (email, GitLab, GitHub, Microsoft Graph, CMS) is only what has been synced; mailbox and remote state are not claimed complete.
- Chat decisions have no acceptance, supersession or review state, so acceptance is unknown.
- People, Sparks, Use cases, Build, Governance and CFP/practice have no chat reader yet and are reported as Not configured.

## Audit appendix: families

| Family | Availability | Access path | Reason |
| --- | --- | --- | --- |
| project | supported | `get_project_details` | live read tool exists |
| note | partial | `search_knowledge_base` | no ID-based paged reader; body may be truncated in the index |
| library-document | partial | `search_library`, `find_files` | content capped; extraction completeness not recorded |
| discover-article | partial | `inspect_discover_feed`, `search_knowledge_base` | dismissed/parked state needs explicit filters |
| youtube | partial | `search_knowledge_base` | no transcript |
| connected-activity | partial | `search_knowledge_base` | last-sync disclosure required |
| task | supported | `list_tasks` | archived/completed filters to verify |
| person | unavailable | none | no chat tool |
| spark | unavailable | `create_spark` (write only) | no read tool |
| canvas | supported | `search_diagrams`, `read_diagram` | read tools exist |
| graph | partial | `search_knowledge_graph` | edge provenance needs verification |
| watchlist | supported | `get_discover_watchlist_records` | read-only tool exists |
| chat | supported | `search_past_chats`, `read_past_chat` | targeted retrieval exists |
| output-decision | partial | `read_output` | acceptance unknown |
| memory | supported | `list_memories` | revoked memories stay excluded |
| use-case | unavailable | none | no chat reader |
| build | unavailable | none | no chat reader |
| governance | unavailable | none | no chat reader |
| podcast-content | partial | `get_content_pipeline` | partial tool coverage |
| cfp-practice | unavailable | none | no chat reader |
| knowledge-health | partial | `src/health/knowledgeHealth.ts` | eligible/pending/failed counts not recorded |

## Audit appendix: all 30 `ContentSource` values

| ContentSource | Family | Availability | Note |
| --- | --- | --- | --- |
| cms-blog | connected-activity | partial | CMS body may be truncated at ingestion |
| cms-newsletter | connected-activity | partial | CMS body may be truncated at ingestion |
| cms-podcast-show-notes | podcast-content | partial | extraction completeness unrecorded |
| cms-session-summary | connected-activity | partial | summary only |
| gitlab-commit | connected-activity | partial | message/metadata only |
| gitlab-mr | connected-activity | partial | indexed text only |
| gitlab-issue | connected-activity | partial | indexed text only |
| gitlab-pipeline | connected-activity | partial | status metadata only |
| github-commit | connected-activity | partial | message/metadata only |
| github-pr | connected-activity | partial | indexed text only |
| github-issue | connected-activity | partial | indexed text only |
| github-content-store | library-document | partial | files capped at ingestion |
| github-doc | library-document | partial | files capped at ingestion |
| graph-calendar | connected-activity | partial | entries as synced |
| graph-todo | connected-activity | partial | items as synced |
| podcast-episode | podcast-content | partial | episode text as indexed |
| ai-session | chat | partial | indexed copy is a summary, not verbatim |
| email | connected-activity | partial | only synced mail |
| github-action | connected-activity | partial | run metadata only |
| github-release | connected-activity | partial | indexed text only |
| github-deployment | connected-activity | partial | status metadata only |
| github-pr-review | connected-activity | partial | indexed text only |
| gitlab-release | connected-activity | partial | indexed text only |
| gitlab-deployment | connected-activity | partial | status metadata only |
| note | note | partial | indexed copy; see note family |
| task | task | partial | indexed copy may be stale; live tool authoritative |
| discovered-article | discover-article | partial | dismissed/parked state to disclose |
| ica-document | library-document | partial | extraction completeness unrecorded |
| user-upload | library-document | partial | extraction completeness unrecorded |
| onedrive-document | library-document | partial | extraction completeness unrecorded |
