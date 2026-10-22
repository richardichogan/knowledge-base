# Knowledge coverage: test traceability

Maps every mandatory test ID in the knowledge-coverage spec (sections 11 and 17.7) and every acceptance criterion
(AC-01..AC-16, section 12.1) to the test file that proves it, or to an approved manual procedure.

* Test files live in `knowledge-hub-backend/scripts/` and are registered in `scripts/run-isolated-tests.mjs` unless noted.
  Filenames marked **planned** are owned by the implementing phase; an ID is only "covered" once its file exists and runs.
* Shared fixtures, the evaluation pack and the benchmark live in `knowledge-hub-backend/scripts/fixtures/knowledge/`
  (`corpus.ts`, `familyFixtures.ts`, `perfDataset.ts`, `seed.ts`, `evalPack.ts`) with their own tests in
  `knowledge-fixtures.test.ts`. Fixtures pin the clock at `2026-10-22T09:00:00Z` (`Europe/London`), use stable UUIDs, seed
  `p-imagine` and `p-independent`, and need no network or model.
* Mock-model tests verify orchestration only. Reasoning quality is verified by the live evaluation (procedure M-1).

## Manual procedures

| Ref | Procedure | Evidence required |
| --- | --------- | ----------------- |
| M-1 | **Live evaluation.** Owner approves AI usage, then run `KNOWLEDGE_EVAL_LIVE=approved KNOWLEDGE_EVAL_ADAPTER=<module> node --import tsx/esm scripts/knowledge-eval.ts --live` (three runs). Without approval the harness refuses (exit 2, "unverified"). Human reviewers check claim support against `requiredPassages`; a model judge may assist but is not the release authority. | Per-run JSON in `KNOWLEDGE_EVAL_OUT`: deployment id, parameters, time, per-question retrieved records, answer, citations, token usage. Every run must meet all section 12.2 thresholds, and decision-acceptance, supersession and deterministic-rule facts must be 100% each run. |
| M-2 | **PostgreSQL 16 performance.** Isolated PG16, then `PERF_DATABASE_URL=... node --import tsx/esm scripts/knowledge-perf.ts` (10 warm-up + 200 measured per path; cold reported separately). Without `PERF_DATABASE_URL`, or on a non-16 server, the result is "unverified" (exit 2). `PERF_SCALE` other than 1 is not acceptance evidence. | JSON report: hardware, PG version, dataset counts, per-path cold/p50/p95, errors, rows scanned, query count, query plans, semantic mode. Owner approval is required to relax any threshold. |
| M-3 | **Concurrency and first-token latency.** Five simultaneous retrieval turns plus one indexing worker against the M-2 database; instrument in-flight DB queries; record SQLSTATE 53300 / deadlock counts and a control indexed read p95 (<= 1 s). Compare native first answer-token latency with the same-environment baseline (<= +10%). | Run log with in-flight query maxima and error counts; baseline vs candidate latency. |
| M-4 | **Live freshness and scheduling.** Healthy worker: native edit searchable lexically within 5 s and semantically within 5 min. Worker not scheduled (night-time): UI reports delayed semantic state without any scheduler change. | Timestamps from the health endpoint before/after. |
| M-5 | **Cost.** Dry-run embedding/backfill estimate approved by the owner; per-question tokens, calls, semantic queries and embeddings recorded; fixed-pack median billed tokens <= 1.5x baseline. Missing usage means "unverified". | Cost sheet linked to the M-1 evidence. |
| M-6 | **Mobile/desktop visual check.** Side panel/widget source list, health partial state and mobile chat expansion/exclusion inspected at desktop and mobile viewports after component tests pass. | Screenshots. |
| M-7 | **Monitoring enablement.** Owner approval for any rule/project before monitoring is enabled; core semantic delivery may complete with monitoring disabled. | Written approval; MON-01..04 green. |

## Mandatory test cases

### 11.1 Coverage and focused context

| ID | Test file | Notes |
| -- | --------- | ----- |
| COV-01 | `knowledge-manifest.test.ts` | Existing; compares the manifest with the `ContentSource` union. `knowledge-fixtures.test.ts` also asserts fixture families/sources equal the manifest. |
| COV-02 | `knowledge-read.test.ts` (planned) | Seeds `MINIMAL_FIXTURES` (one per family): discover, read, origin, locator. |
| COV-03 | `knowledge-read.test.ts` (planned) | Metadata-only (V1) and extraction-failed records; state/reason not counted readable. |
| COV-04 | `knowledge-health.test.ts` | Unsupported/unconfigured family reports explicit status, never empty success. |
| CTX-01..CTX-05 | `focused-context.test.ts` | Extended with `unrelatedRecords(1000)`; asserts no global/graph/chat search, no classifier call, read-only tool set. |
| CTX-06 | `focused-context.test.ts` + `knowledge-safety.test.ts` (planned) | Exclusion load failure produces safe unavailable status. |

### 11.2 Discovery, identity, ranking and filters

| ID | Test file | Notes |
| -- | --------- | ----- |
| SRC-01..SRC-04 | `knowledge-search.test.ts` (planned) | Uses D1/D2 + `noisyMatches()`, D4/D5, D3 scope cases. |
| SRC-05, SRC-06 | `knowledge-search.test.ts` (planned) | D6 fusion rank; partial-term ranking against golden relevance. |
| SRC-07 | `knowledge-search.test.ts` (planned) | `AMBIGUOUS_QUERIES.sqlLike`, apostrophes, Unicode paths. |
| SRC-08 | `knowledge-search.test.ts` (planned) | Canonical identity across note/content item/graph node. |
| SRC-09 | `knowledge-search.test.ts` (planned) | URL-less note/task opens internally. |
| SRC-10 | `knowledge-search.test.ts` (planned) | A1/A2 syndication counted once. |
| SRC-11 | `knowledge-search.test.ts` (planned) | A3/A4 parked/dismissed; also `discover-parking.test.ts` for existing behaviour. |
| SRC-12 | `knowledge-structured.test.ts` (planned) | T1/T2/T3 strict membership and stable pages. |
| SRC-13 | `knowledge-search.test.ts` (planned) + `people.test.ts` | PE1/PE2 explicit-link rule. |

### 11.3 Full reads, passages and versions

| ID | Test file | Notes |
| -- | --------- | ----- |
| READ-01..READ-06 | `knowledge-read.test.ts` (planned) | D1 tail passage (offset 28,000), full paging, version change, cursor validation/scope, D7 surrogate round-trip (`D7_PAGE_BOUNDARY`). |
| READ-07 | `knowledge-read.test.ts` (planned) | BlockNote via the existing renderer. |
| READ-08 | `knowledge-read.test.ts` (planned) | V1 has no transcript. |
| READ-09 | `knowledge-read.test.ts` (planned) | `totalChars` is not original length. |
| READ-10 | `knowledge-read.test.ts` (planned) | O1 v2 current; v1 only on permitted request. |

### 11.4 Relationships, structured state and dates

| ID | Test file | Notes |
| -- | --------- | ----- |
| REL-01..REL-05 | `knowledge-traversal.test.ts` (planned) | Uses `EDGES`; REL-03 limits/truncation; REL-04 X3 dangling node; REL-05 U1/B1/S1 lifecycle. |
| STATE-01..STATE-03 | `knowledge-structured.test.ts` (planned) | Live T1; P1 current date; exact overdue count beyond search cap (uses T5/T6 and perf `expectedOverdueTasks`). |
| STATE-04 | `knowledge-health.test.ts` | Connector unavailable cannot claim "none". |
| STATE-05 | `knowledge-structured.test.ts` (planned) | Source-modified vs import time (A1). |
| DATE-01..DATE-03 | `knowledge-structured.test.ts` (planned) | Week boundaries at the pinned clock; half-open ranges; spring DST 23-hour day. |

### 11.5 Provenance, citations and reasoning

| ID | Test file | Notes |
| -- | --------- | ----- |
| EVD-01..EVD-05 | `knowledge-evidence.test.ts` (planned) | Conflict statement, H1/H2, A1 separation, citation/quote validation. Reasoning quality for EVD-01..03 also in the evaluation pack (CN-01, CN-02, XS-03). |
| EVD-06 | `knowledge-evidence.test.ts` (planned) + web `knowledgeEvidence.test.tsx` (planned) | Found/Read/Cited counts. |
| EVD-07, EVD-08 | `discover-watchlists.test.ts` + `knowledge-evidence.test.ts` (planned) | W1/W2/W3; pack CN-03/CN-04. |
| EVD-09, EVD-10 | `knowledge-evidence.test.ts` (planned) | Summary labelling; reconstruction wording. |
| EVD-11, EVD-12 | `knowledge-evidence.test.ts` (planned) | Bounded-scope answer; single correction only. Pack CN-09. |

### 11.6 Exclusions, safety and side effects

| ID | Test file | Notes |
| -- | --------- | ----- |
| SAFE-01..SAFE-07 | `knowledge-safety.test.ts` (planned) | Alias exclusion (N1), deleted X3, tracked quotation removal, in-flight exclusion, X1 injection, X2 `SECRET_CANARY` absent from tool output/model request/citations/logs, O1 session scope. |
| SAFE-08 | `knowledge-safety.test.ts` (planned) | Private to public boundary and existing confirmation. |
| SAFE-09 | `knowledge-safety.test.ts` (planned) | SSRF policy unchanged; no auto-fetch. |
| SAFE-10 | `knowledge-safety.test.ts` (planned) | Read-only harness: row-count snapshot before/after on the seeded database. |

### 11.7 Freshness, indexing and failure recovery

| ID | Test file | Notes |
| -- | --------- | ----- |
| IDX-01..IDX-08 | `knowledge-indexing.test.ts` (planned) | Outage persistence, failed item accounting, version/tombstone ordering, lease recovery, coalescing, retry limits, canonical reconciliation. |
| IDX-09, IDX-10 | `knowledge-indexing.test.ts` (planned) + `knowledge-health.test.ts` | FTS-only and both-unavailable outcomes. |
| IDX-11, IDX-12 | M-4 | Needs a live healthy worker and real clocks. |

### 11.8 Performance, limits and compatibility

| ID | Test file | Notes |
| -- | --------- | ----- |
| PERF-01 | M-2 (`scripts/knowledge-perf.ts`) | Exact read, structured count/page, lexical; PG16 only. |
| PERF-02 | M-3 | Needs PG16 and in-flight query instrumentation. |
| PERF-03 | `knowledge-search.test.ts` (planned) | 20-project bounded queries, no unbounded fan-out. |
| PERF-04 | `knowledge-search.test.ts` + `knowledge-traversal.test.ts` (planned) | Independent text/tool/graph/time budgets. |
| PERF-05 | `focused-context.test.ts` | Abort propagation, no later rounds. |
| PERF-06, PERF-07 | `focused-context.test.ts` + M-5 | Token accounting; no extra calls or schema bloat on source-bound prompts. |
| REG-01 | `focused-context.test.ts`, `project-context.test.ts`, `diagram-context.test.ts`, `discover-watchlists.test.ts` | Existing suites must stay green. |
| REG-02 | `discover-views.test.ts`, `discover-parking.test.ts`, `local-documents.test.ts` | Existing ranking/parking/count/pagination. |
| REG-03 | `knowledge-indexing.test.ts` (planned) | Flags off and legacy index retained; migrations backward compatible. |
| UI-01 | web `knowledgeHealth.test.tsx` (planned) + M-6 | Component tests first, then visual check. |
| UI-02 | web `knowledgeMobileChat.test.tsx` (planned) + M-6 | Mobile source expansion/exclusion only. |

### 17.7 Semantic layer, rules, decisions, monitoring

| ID | Test file | Notes |
| -- | --------- | ----- |
| SEM-01..SEM-08 | `semantic-entities.test.ts`, `semantic-relationships.test.ts` (planned) | Fixtures SD1..SD3, ST1, SR1 (`SEMANTIC_FIXTURES`, `EDGES`); SEM-08 evaluates at both `SEMANTIC_FIXTURES.SD3.evaluateAt` instants. |
| RULE-01..RULE-07 | `semantic-rules.test.ts` (planned) | RULE-01 uses the T5/T6 date-only/timestamp overdue pair against chat and Plan/Today helpers. |
| DEC-01..DEC-04 | `semantic-decisions.test.ts` (planned) + M-1 | Deterministic orchestration in tests; advisory reasoning in pack SC-01, SC-02, SR-01, SR-02. |
| MON-01..MON-04 | `semantic-monitoring.test.ts` (planned) + M-7 | Disabled by default; idempotent notifications. |

## Acceptance criteria

| AC | Evidence |
| -- | -------- |
| AC-01 | `knowledge-manifest.test.ts` (COV-01) |
| AC-02 | `knowledge-read.test.ts`, `knowledge-indexing.test.ts`, `knowledge-safety.test.ts` parameterised over `MINIMAL_FIXTURES` (discover/read/update/delete/exclusion/provenance/unsupported field) |
| AC-03 | SRC-01..SRC-04, SRC-13; pack EI-01..EI-10 (exact identity 100%, `evaluateRecall`/`exactIdentity`) |
| AC-04 | READ-01, READ-02; pack PL-01, PL-03 (M-1) |
| AC-05 | CTX-01, CTX-02, PERF-07 |
| AC-06 | STATE-01..STATE-03, DATE-01..DATE-03, RULE-01; pack SL-01, SL-02 |
| AC-07 | SAFE-01..SAFE-07, CTX-06; pack CN-07, CN-08 (zero leaks every live run) |
| AC-08 | EVD-04, EVD-05; M-1 quote checks (100% citation identity/version validity) |
| AC-09 | COV-03, COV-04, IDX-09, IDX-10, STATE-04; pack CN-05, CN-06, CN-10 |
| AC-10 | PERF-04, PERF-05, IDX-01..IDX-12; M-2, M-3, M-4 |
| AC-11 | SAFE-10, SAFE-05, REL-05 |
| AC-12 | SAFE-08, READ-10, SAFE-07, CTX-06, REG-01 |
| AC-13 | UI-01, UI-02, EVD-06, M-6 |
| AC-14 | SEM-01..SEM-08; pack SR-01, SR-02 |
| AC-15 | RULE-01..RULE-07; pack SL-01, SL-02 |
| AC-16 | DEC-01..DEC-04, MON-01..MON-04; pack SC-01, SC-02; M-7 |

Evaluation gates (spec 12.2) map to the pack as follows: exact identity = EI-01..EI-10; paraphrase/long = PL-01..PL-10;
cross-source = XS-01..XS-10; conflict/no-answer/partial = CN-01..CN-10; semantic = SL-01, SL-02, SR-01, SR-02, SC-01, SC-02.
Recall@10 is computed by `recallAtK`/`evaluateRecall` over answerable questions only, with per-family recall so no supported
family hides below 80%.
