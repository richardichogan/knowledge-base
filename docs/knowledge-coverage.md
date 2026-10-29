# Knowledge coverage

This page documents what Athena can discover and read, how that is reported, and how to roll the feature back. The source of truth for dispositions is `knowledge-hub-backend/src/ai/knowledge/manifest.ts`; the Knowledge health page (`/health`, `GET /api/health/knowledge`) reports the same families live. Test traceability is in [knowledge-test-traceability.md](knowledge-test-traceability.md).

## How coverage is reported

Coverage is never a single percentage. Knowledge health shows, per family:

- **State:** Up to date, Partial coverage, Unsupported extraction, Not configured, Temporarily unavailable, or Excluded by design.
- **Counts:** indexed records (canonical `content_items` rows for the family's sources), plus eligible, pending and failed. A count that cannot be measured is returned as `null` and shown as "Not measured", never as zero.
- **Extraction distribution:** stored text, metadata only (empty body) and text at a known source-specific ingestion cap (OneDrive: 250,000 characters; ICA: 20,000; email: 5,000). A search preview limit is not an ingestion limit. At-cap counts are a truncation risk, not proof of missing original text; per-record extraction completeness is not always recorded.
- **Last indexed** and the **last successful sync**; **error categories** are a fixed vocabulary (`sync-errors`, `sync-run-failed`). No error text, prompt or source body is ever returned.
- **Semantic search** state. It is never "Up to date" because a provider is connected: it needs measured, drained indexing work with at least one completed item. A configured provider with no measured work reads "Connected, coverage not measured".

Eligible counts and per-family pending/failed counts are not recorded anywhere today, so no record-coverage percentage is shown. Optional tables (indexing work, decision records) are feature-detected; when absent the figures are "Not measured".

In chat, the "Used:" line separates **Found** (search candidate, not necessarily read), **Read** (available to the answer) and **Cited** (supports the answer). Older replies without a `lifecycle` field show explicitly looked-at sources as Read and background retrieval as Found. Deleted or missing targets show "No longer available" and are not linked. External links must be http(s) and are dropped if they carry credentials. Warnings are scoped to the reply or one source; there is no permanent global banner for a temporary optional-provider failure.

Discovery lookups reserve room for explicit reads even before the model requests a full review. Detailed reviews use complete originals when they fit; direct reads leave room for subsequent checkpointed source syntheses rather than filling the answer context with the first document. Full diagram reads use the same review limits. If a budget still prevents completion, coverage limitations precede the answer, and the answering model is instructed to identify unchecked sources rather than present a complete assessment.

Voice transcription enters the same composer submission path as typed input, including the current note/canvas, conversation, project, action and pending attachment. Both on-screen and desktop voice send the transcript together with any existing draft. Review-only dictation still appends to the draft without sending, and blocked submissions retain the transcript.

Think documents offer **Actions > Export > Export as Word (.docx)**. Export uses the current editor contents, including unsaved edits, and generates the file locally. Headings, text emphasis, nested lists, tables and images are retained; hyperlinks and internal mention chips become ordinary labelled text without clickable targets. Passage tags remain in Athena and are not exported as Word metadata.

The Think document Actions menu keeps Copy, Present and Pop out directly accessible. Export, Share & publish, Create & build and Manage expand in place, with Delete separate at the bottom. Groups start collapsed each time the menu opens. Arrow keys navigate enabled actions; Right/Left expand or collapse groups, and Escape closes the menu and returns focus to Actions.

Notes (Connections), task details, diagram properties and selected diagram elements share **Manage links**. The modal searches notes, diagrams and tasks by title, filters by type, and adds or removes links immediately. Task linking also retains document search and existing chat/document links. Manual relationships are visible and removable from either end; they do not insert note text or change task status. Diagram-wide and shape-specific links remain separate, with shape links identified on the other item. Pending diagram changes are saved before link changes. Existing task links and diagram-note links remain in their original tables; migration `118_entity_manual_links.sql` adds storage only for the previously unsupported combinations. Inline mentions, inferred connections and drill-down diagrams keep their existing behaviour.

Diagram and shape/connector descriptions share Bold, Italic and Bulleted list controls. Bullets apply to the current or selected lines; Enter continues a list and Enter on an empty bullet ends it. The preview renders real list markers. Shape/connector descriptions still autosave; diagram properties still require Save. Standard shape icons include **System** (monitor), also available as a visible header preset beside Agent, Human and Pipeline; that preset sets the System header and monitor icon. Yes/No labels no longer trigger automatic connector or label colours; saved colours and AI-flow control/outcome semantics are unchanged.

Note review and wording updates use unique exact text replacements, preserving block types, styles, links and nested content. They do not authorise a whole-note rewrite. Structural edits require an explicit structural request, and body-edit previews cannot rename or delete the title heading. Full redrafts retain the existing title heading. Proposals are still unsaved until the user clicks Apply; destructive changes retain the existing history checkpoint.

The Notes workspace owns the shared Actions control and side panel independently of each document editor. Switching notes or Design sections keeps those controls mounted; pending loads show the existing Athena ribbon activity with a loading label only inside the document area. A late save from the previous note cannot reopen it over the current selection.

## Feature flag and indexing switch

- `KNOWLEDGE_ORCHESTRATION` (`1`, `true`, `on` or `yes`) turns on the new orchestration. It is off by default; the previous tools stay registered and compatible.
- Bulk/backfill indexing is controlled by a persisted admin switch (`knowledge_indexing_settings`, key `bulk_indexing`, migration 091). It defaults OFF and an unreadable switch counts as OFF. While OFF, the hourly sweep `runFoundryIqBackfillJob`, the bulk drain/reconcile (`drainIndexingWork`, `bulkReconcileIndexingBacklog`) and `node scripts/foundryIqIndex.mjs --backfill` refuse to run (typed error `BULK_INDEXING_DISABLED`, HTTP 409; the script exits 2). Normal incremental per-write indexing and dry-run estimates (`--backfill --dry-run`, the GET below) are never gated.
- Admin API (authenticated by the `x-cron-secret` header only; fails closed if `CRON_SECRET` is unset): `GET /api/knowledge/admin/indexing` returns the switch, queue summary and dry-run estimate; `PUT /api/knowledge/admin/indexing` with `{"enabled": true|false}` sets it.
- Durable indexing work (`knowledge_indexing_work`, migration 089) is drained by the hourly production sweep when the switch is ON, and the sweep is skipped in development and whenever Foundry IQ is not configured (`FOUNDRY_IQ_SEARCH_ENDPOINT` / `FOUNDRY_IQ_SEARCH_ADMIN_KEY`). Work stays queued while the switch is OFF, with leases and delete tombstones intact.

## BAU monitoring

Every knowledge-orchestrated Athena turn (general persona, `KNOWLEDGE_ORCHESTRATION` on) writes one row to `knowledge_turn_audit` (migration 092): ids, counts and a category only. No user or assistant text is stored. Writing is fire-and-forget after the reply is built; a failure is logged and never affects the answer. Rows older than 90 days are pruned nightly.

Normal chat routes record the audit after saving the accepted answer so
`assistant_message_id` identifies the exact reply. Direct conversation-service
callers without a persistence hook retain the session-level audit fallback.
Older rows with a null message id are not backfilled by guessing timestamps.

**Categories** (first match wins, most severe first): `tool_error` (a tool returned an error), `source_unavailable` (a cited/found record was missing or excluded), `wrong_abstain` (the answer declined although records were found or read), `bad_citation` (ids stripped or a citation repair needed), `unverified_quote` (quote not matched to source text), `budget_hit` (a retrieval budget ran out), `found_not_read` (records found, none opened), `partial` (limited without a specific budget), `no_retrieval` (nothing searched), `ok`.

**Nightly review** (`knowledgeNightlyReviewJob`, about 02:00 UTC, claimed once per day, zero model calls) aggregates attributed production turns from the previous UTC day into `knowledge_daily_review`: category counts, rates, the 10 worst turns (audit ids and session ids only) and flags. Development and unattributed audit rows are excluded. Migration 109 marks new snapshots with `environment: prod`; older snapshots remain explicitly unattributed and may mix local tests with production. No historical accuracy is invented by backfilling them. Critical = `tool_error`, `wrong_abstain`, `bad_citation`, `unverified_quote`.

| Flag | Raised when |
|---|---|
| `criticalRate` | critical turns above 5% |
| `noRetrievalRate` | never; the rate remains informational, not a failure flag |
| `abstainWithEvidence` | `wrong_abstain` above 5% |
| `lowSample` | fewer than 5 turns (low sample, not an alarm) |

**Reading the report:** `GET /api/health/knowledge` has a `turnReview` section with the latest seven snapshots (`trend`, newest first), their environment attribution and an interpretation note. Snapshots cover whole days, not the usage date/persona filters. Check flags first, then `categoryCounts`, then look up `worstTurns` ids in `knowledge_turn_audit` to inspect the actual conversation. No-retrieval turns are excluded from worst-turn rankings, including the read-only projection of legacy snapshots. Stored historical rows are not rewritten. A failing section reports "could not be read" and never fails the endpoint.

These categories are **investigation signals, not scored answer quality**.
`no_retrieval` also includes note edits, answers from the open document, external
web reads and conversational follow-ups. `bad_citation` includes a repair attempt
even if the repaired answer succeeded. Do not interpret their rates as proven
incorrect-answer rates or fix them by indiscriminately forcing more searches.

### Read-only review, 23 October 2026

The latest completed nightly review is for **22 October (UTC)**, generated at
02:02 UTC on 23 October: 9 turns, comprising 2 `ok`, 2 `tool_error`,
2 `bad_citation` and 3 `no_retrieval`. It raised `criticalRate` (44.44%) and
`noRetrievalRate` (33.33%). This is a small first-day sample.

A separate trailing-24-hour snapshot contained 25 turns: 3 `ok`,
2 `tool_error`, 4 `bad_citation`, 7 `no_retrieval`, 6 `budget_hit` and
3 `source_unavailable`. All six budget-hit rows named `source_chars`; five
recorded no explicit record reads. These are overlapping diagnostic concerns:
category precedence can hide a budget hit behind a more severe category.

Immediate code corrections:

- Remove the bare word "any" as an exhaustive-query trigger. Ordinary questions
  such as "Any actions for me from this meeting?" no longer receive an
  unrelated count disclaimer. Explicit exhaustive/count requests, empty-search
  warnings and real budget limitations keep their safeguards.
- Instruct action answers to lead with explicit assignments and keep useful
  inferred follow-ups separate. Do not invent ownership or deadlines.
- With orchestration on, cap knowledge and Library search body previews at
  1,000 characters per result. Full-body discovery could exhaust the 48,000
  character source budget before the explicit reader ran. Explicit ID readers
  and the total budget are unchanged; the flag-off path retains its limits.
- Do not register oversized tool payloads as read evidence when those payloads
  were replaced by a limit warning before reaching the model.
- Link future normal-chat audits to their saved assistant message.

The usage snapshot showed no failed chat-model calls (137 calls), but three
failures in 120 `article-project-fit` calls. Model-call success does not establish
answer correctness. Embeddings accounted for 5,306 calls and about 5.52 million
input tokens; cost cannot be inferred without the deployed model's rates and
workload/backfill context. No budget increases, reindexing, historical rewrites
or production configuration changes were made during this review.

The two tool errors and three unavailable-source turns still require
tool-specific evidence before changing provider or reader behaviour. The audit
stores counts rather than tool names/error messages; no root cause is claimed
from those counts alone.

**Kill switch:** `az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --set-env-vars KNOWLEDGE_ORCHESTRATION=false` (also stops audit writes).

## Rollback procedure

1. Set `KNOWLEDGE_ORCHESTRATION` off on the container app (`az containerapp update --set-env-vars KNOWLEDGE_ORCHESTRATION=false`) and let the new revision become Healthy. Old compatible tools resume.
2. Stop bulk indexing with the admin switch: `PUT /api/knowledge/admin/indexing` `{"enabled": false}` (header `x-cron-secret`). It is already OFF by default. Per-write indexing continues and durable pending work is kept.
3. Do not delete canonical source records, old indexes, embeddings or migrations. Migrations are additive, so the previous application version starts against the current schema.
4. Deletion and exclusion enforcement must hold in both paths. If the old path cannot enforce a newly required protection, disable that retrieval rather than re-enabling an unsafe fallback.
5. Diagnose from safe failure counts, provider status and revision-level retry metadata on Knowledge health. Never log prompt or source bodies or secrets.
6. Rollback triggers: any leak, incorrect accepted-decision attribution, a false comprehensive claim, a sustained budget breach, or a critical regression. A deployment can be healthy while reasoning acceptance fails; report those as separate outcomes.

## Exclusions

Never included in any projection: tokens, passwords, signing material, connection strings, secret-bearing configuration, auth headers, raw environment variables, binary/base64 blobs, internal backups, unconfirmed write proposals presented as completed actions, and operational payloads without a reviewed user-facing projection. A title or path alone does not authorise sending contents to every model; private (IBM/IMAGINE) material is kept distinct from independent/public outputs.

## Known partial coverage

- Library searches return bounded previews. `read_knowledge_record` pages stored bodies and supports checkpointed full-document review; this does not recover text omitted during original extraction.
- Notes have an ID-based paged reader; extraction and index completeness still require measurement.
- YouTube records are metadata and description only. There is no transcript, so a video must never be described as watched.
- Connected activity (email, GitLab, GitHub, Microsoft Graph, CMS) is only what has been synced; mailbox and remote state are not claimed complete.
- Chat decisions have no acceptance, supersession or review state, so acceptance is unknown.
- People, Sparks, Build, Governance and CFP/practice have no dedicated chat reader and are reported as Not configured. The open Design package can read its use-case section; this is partial coverage, not global use-case discovery.

## Audit appendix: families

| Family | Availability | Access path | Reason |
| --- | --- | --- | --- |
| project | supported | `get_project_details` | live read tool exists |
| note | partial | `search_knowledge_base`; `read_knowledge_record` | paged stored-body reader; extraction/index completeness unmeasured |
| library-document | partial | `search_library`, `find_files`, `read_knowledge_record` | bounded previews; paged stored-body reading; original extraction completeness unmeasured |
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
| use-case | partial | `read_design_package` (open Design only) | open use-case section readable; no global discovery |
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
| github-content-store | library-document | partial | stored text can be paged; original extraction completeness unmeasured |
| github-doc | library-document | partial | Markdown text indexed without a document-length cap; search previews are bounded |
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
