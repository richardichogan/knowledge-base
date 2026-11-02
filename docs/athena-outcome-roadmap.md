# Athena outcome roadmap

Recorded 31 October 2026 following a read-only code and product review.
These are proposed directions, not approved implementation specifications.
The owner requested that they be documented and that work begin on item 1;
The owner selected task-creation coverage as the first implementation slice.
Broader output/continuation workflows remain proposals requiring further decisions.

## Objective

Connect the existing capabilities into a useful loop:

**Goal → useful work → evidence → owner decision → accepted outcome.**

Prioritise advancing commitments, developing product specifications and Imagine
demos, preparing for consequential discussions, and producing usable deliverables.
Publishing remains one use of Athena, not its organising principle.

## Boundaries

- Athena-only: no Cowork integration or workflow.
- Do not assume access to IBM's Microsoft 365 Graph.
- IBM email assistance creates drafts in Think for manual review, copying and sending.
- Alliance file access currently uses read scopes. File production does not imply
  permission to upload, overwrite or deliver through Graph.
- Think remains where content is created and developed; Plan manages work.
- Preserve existing editors, properties panels, controls and approval boundaries.
- Proposal generation does not authorise execution, external delivery, task closure,
  architectural changes or additional agent work.
- Every implemented capability must expose actual content and state to Athena through
  the normal typed services, permissions and revision checks.
- Do not infer success from a completed job, task counts, quiz accuracy or a saved file.
- Confirm missing scope, placement, output and workflow decisions before implementation.

## 1. Task-help continuity and broader supported outputs

### Existing foundation

Automatic task-help assessment prepares an unapproved proposal and a completion
notification for tasks created through the direct task API and Athena's
`create_task`. Execution currently supports research, email drafting or an explicit
unsupported result. Research produces source-backed Think findings.

Relevant code:

- `knowledge-hub-backend/src/work/taskAssistance.ts`
- `knowledge-hub-backend/src/work/taskAssistanceQueue.ts`
- `knowledge-hub-backend/src/agents/specialists/taskAssistance.ts`
- `knowledge-hub-backend/src/routes/tasks.ts`
- `knowledge-hub-web/src/features/plan/TaskDetail.tsx`

### Proposed extension

Support concrete task outputs such as decision papers, options comparisons,
specification drafts, proposed architecture changes and meeting briefs.
Preserve the task, source evidence, unresolved questions and retained human
decisions when continuing from findings into an agreed deliverable.

First suggested content slice:

**Research → decision paper → explicitly approved document/specification changes.**

The result stays in Think, linked to its Plan task. Existing documents must be
read and changes applied through their existing revision-checked editing workflow.
Do not create a disconnected replacement editor or treat a chat response as a
persisted document change.

### Coverage prerequisite

Other task producers insert records separately, including daily-report imports,
meeting-preparation imports, recurring children and Spark graduation.
Agree when each should generate a proposal, how an authenticated owner is
identified, and how duplicates, retries and notification volume are handled.
Do not backfill existing tasks or reassess every importer update without approval.

### Agreed first slice (31 October 2026)

- Generate automatic help for newly created non-recurring tasks outside Inbox.
- Wait until Inbox acceptance for imported and Athena-created Inbox tasks.
- Apply the same acceptance rule through the app and Athena's update tool.
- Exclude recurring tasks and their children from automatic assessment.
- Include new passage follow-up tasks, which are created directly in Backlog.
- Do not backfill old tasks, reassess ordinary edits or repeat prior assessment
  attempts when a task is returned to Inbox and accepted again.
- Preserve manual Help me, proposal approval and existing completion notifications.
- Surface saved-task/failed-assessment partial success through existing notices.

Development implementation is in the current worktree; this is not a deployment
record or proof of a live task/proposal/notification roundtrip.

### Acceptance direction

- A task receives the appropriate proposal without duplicate assessment jobs.
- Approved assistance retrieves actual evidence and persists the agreed output.
- Follow-on work retains task/source context without requiring it to be pasted again.
- Stale inputs, failed reads and unfinished work are reported accurately.
- Original artefacts and pending user edits are preserved.
- Record owner acceptance separately from job completion.

### Decisions still required

Coverage scope is agreed above. Supported first output; initiation and placement of
follow-on actions; document creation versus existing-document editing; approval
granularity; acceptable assessment/notification behaviour.

## 2. Weekly outcome review

**Agreed implementation slice, 1 November 2026:** an on-demand direction and
progress review of the last seven days, on the main project record. Retain dated
history with the latest review expanded. Retrieve linked saved project evidence
automatically; no scheduled jobs or additional navigation.

Adapt the review to the saved work type: Project/Side project considers goals and
deliverables; BAU considers sustained responsibilities, service health and
recurring friction; Aspiration considers opportunities and momentum; Exploration
considers learning, tested assumptions and unanswered questions.

Each saved review includes meaningful progress, activity without a demonstrated
outcome, blockers/uncertainty and one proposed next move with **why Athena picked
it**. Findings link to captured evidence and disclose excerpts, missing sources
and the difference between a saved record update and demonstrated achievement.
No completion percentages, invented milestones or automatic task/goal changes.
Athena can read dated reviews and their captured evidence through typed tools,
and generate a new review when explicitly requested.

Extend existing project outcomes, review packets and Plan review rather than
introducing another OKR system or dashboard.

Compare agreed goals and expected outputs with linked deliverables, decisions,
tasks and available repository evidence. Distinguish demonstrated progress,
activity without a clear outcome, blocked progress and a proposed next move.
Expected outputs need explicit evidence links; task counts do not establish
percentage completion.

Relevant code:

- `knowledge-hub-backend/src/projects/cockpit.ts`
- `knowledge-hub-backend/src/projects/reviewPackets.ts`
- `knowledge-hub-backend/src/projects/workContext.ts`
- `knowledge-hub-backend/src/services/planReview.ts`
- `knowledge-hub-backend/src/services/planNudges.ts`

Success means helping choose valuable work, not merely moving overdue dates.
Automatic cadence and execution of suggested actions remain outside this slice.

Local activation verified on 1 November 2026: additive migration 131 applied to
the shared production database with owner approval; a real Reckitt review was
generated and persisted through the local UI. Its seven-day period, evidence
references, rationale and retry identity were verified through Athena's tools,
and a read-only conversation retrieved it before explaining the recommendation.
These application changes have not been pushed or deployed.

## 3. Athena-native document and deck production

**Agreed first slice:** editable Word and PowerPoint downloads, with clean neutral
formatting, from the existing Think Deliverable brief and linked task. Preserve
the editor, properties panel and existing brief instructions.

Finished content goes in a final level-one `# Deliverable content` section.
Word exports that section; level-two `##` headings define PowerPoint slides.
Downloads save pending editor changes and check both note and work revisions.
Athena can read the full saved body, develop its content through the supported
editor tools, and generate a requested format through `prepare_deliverable_download`.
That tool returns generation evidence and the Think link, not a claim that the
file was delivered or accepted.

No Microsoft 365 Graph access is required. Direct OneDrive delivery remains
outside this slice and requires separately agreed write permissions, exact
destination, overwrite policy and approval. Existing produced-file metadata
remains distinct from local downloads.

Relevant code:

- `knowledge-hub-backend/src/work/workContent.ts`
- `knowledge-hub-backend/src/work/officeExport.ts`
- `knowledge-hub-backend/src/ai/workContentTools.ts`
- `knowledge-hub-web/src/notes/WorkContent.tsx`

Success means reducing manual assembly before the document can be used.
This first slice supports editable text, lists, hyperlinks and tables. Embedded
images are explicitly rejected rather than silently dropped; oversized slides
and tables require splitting in Think. Corporate templates, media-rich decks
and direct M365 delivery remain future decisions.

Local activation used the user-approved First Mate framing draft, based only on
the saved brief evidence. Both Office files were retrieved through the running
frontend proxy and download endpoint. The Word package contains the finished
section and an editable table; the five-slide PowerPoint retains editable text
and a table. Athena read the saved section and generated both formats through
its tool. Native Office visual rendering remains unverified. Application changes
have not been pushed or deployed.

## 4. Meeting continuity

Extend existing meeting preparation instead of rebuilding it.

- Before: intended outcome, unresolved decisions, evidence and useful questions.
- After: proposed decisions, commitments and document changes grounded in supplied
  notes or transcripts.
- Next meeting: what happened to previous commitments and what remains unresolved.

Use existing calendar/report imports and saved project evidence. Disclose missing
coverage; never imply attendance or access to an unavailable mailbox.
Confirm inferred owners, deadlines and follow-ups before applying them.

Relevant code:

- `knowledge-hub-backend/src/projects/workContext.ts`
- `knowledge-hub-backend/src/services/dailyInsights.ts`
- `knowledge-hub-backend/src/integrations/ibm/ibmMeetings.ts`

Success means fewer repeated briefings and forgotten commitments.
Input capture, meeting identity and approval flow require agreement.

## 5. Demo rehearsal and challenge partner

Use the agreed scenario, script, architecture and implementation evidence to
challenge a demo from business, architecture and assurance perspectives.
Return specific weak points, likely questions, unsupported claims and proposed
corrections, not a generic readiness score.

Separate story rehearsal, code/evidence review and actual runtime demonstration.
Reuse the existing demo acceptance guidance; a specification read cannot prove
that a demo works or authorise live operations.

Relevant code:

- `knowledge-hub-backend/src/ai/demoSpecificationTemplate.ts`
- `knowledge-hub-backend/src/ai/demoSpecification.ts`
- `knowledge-hub-backend/src/build/handoffContract.ts`

Success means a clearer, defensible story and fewer unsupported demonstration claims.
Agree rehearsal inputs, depth and output before implementation.

## 6. Watchlist findings to proposed responses

Extend "what changed?" into "does this change what we should do?"
Propose a linked comparison update, investigation, use-case revision or stakeholder
brief, or explicitly recommend no action.

Each response identifies the affected artefact, evidence, baseline version and
required decision. Vendor announcements do not authorise rewriting the owner's
position. Proposed relationships must not masquerade as confirmed dependencies.

Relevant code:

- `knowledge-hub-backend/src/services/discoverWatchlists.ts`
- `knowledge-hub-backend/src/useCases/useCaseStore.ts`

Success means monitoring informs consequential work rather than adding reading backlog.
Agree response types, initiation and deduplication.

## 7. Just-in-time learning for actual work

Extend adaptive subject practice to a selected discussion, demo or task:
source-backed explanation, scenario exercise, stakeholder questions and feedback.
Keep private project material out of public search queries.

Existing quiz accuracy remains quiz accuracy, not evidence of professional readiness.

Relevant code:

- `knowledge-hub-backend/src/learning/progress.ts`
- `knowledge-hub-backend/src/learning/agent.ts`
- `knowledge-hub-backend/src/learning/sources.ts`

Success means being better prepared to explain and defend real decisions.
Agree project-to-learning mapping, exercise format and retention of feedback.

## Suggested sequence

1. Agree and complete task-help creation coverage, then deepen task-help continuity
   with decision-paper/specification support.
2. Add weekly outcome review.
3. Produce editable documents/decks.
4. Apply the foundations to meeting continuity and demo rehearsal.
5. Connect monitoring and learning to selected work.

Do not prioritise additional dashboards, content boards, personas or broad
autonomous scheduling over closing these handoff gaps.

## Review limitations

This roadmap is grounded in selected code paths and the current product spec.
It is not an exhaustive correctness audit, a live integration health report,
an inspection of the owner's current task data or an implementation estimate.
The existing `docs/planned-features.md` contains historical recommendations and
superseded implementation assumptions; this document does not adopt its stale
testing, migration or autonomous design guidance.
