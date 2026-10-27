# Athena

> **Product spec:** [docs/athena-spec.md](docs/athena-spec.md) (purpose, use cases, areas, principles). This README is the detailed feature reference.

> Formerly "Personal Knowledge Hub". The product is now called **Athena**; code, folders (`knowledge-hub-*`) and Azure resources (`kh-prod-*`) keep their original names.

The browser favicon and installable-app icons use the teal Athena "A". Their
versioned URLs prevent browsers from retaining the former KH icon after an update.

Athena uses the same conversation, message and composer styling in standalone
chat, floating chat and the Think/Library side panels. Context and note-linked
conversation identities remain distinct. Type **@** to choose a person, project,
saved Think note (including specifications) or indexed Library document.
Document references use saved IDs, resolve current server-side content on each
turn, respect the chat's excluded sources, and remain available for follow-up
questions. Up to five sources are included per turn; long sources are explicitly
labelled as clipped. The Used sources line lets you inspect or exclude them.

Persona, page context, action and project controls are compact icons in the top
command bar, alongside the icon-only Save to Think action and chat controls.
Click a settings icon to expand its current setting. Active grounding and
actions use teal, and tooltips name the current selection. Popovers open below the
composer without clipping inside diagram panels and dismiss on Escape or outside
interaction. Athena's animated presence and next-step suggestions live inside the
scrolling response area, not a separate composer strip. No divider separates the
animation from the message field. The animation follows the reply directly
rather than sitting at the bottom of unused response space. Each reply's source
attribution, context and references, and alternate-model controls are grouped
under a collapsed **Response details** menu.
The ribbon animates in place within the working indicator or latest response;
it no longer flies between the reply heading and composer or overlays the input.
Live anchor callbacks keep it attached when chat history or progress views are
replaced, across standalone, note, diagram and floating chats. Thinking smoothly
alternates faster and slower rotation with a slight size and light pulse in the
shared renderer; the host stays fixed and reduced-motion/static renders do not pulse.
Saved reply headings use a still 20px Athena icon; only the working indicator
and latest response's presence use the full-size animated ribbon.
As a new answer appears, its small heading icon briefly animates in the answering
pose with an **Athena · Answering** label before settling back to the still icon.
Checked replies reveal paragraph by paragraph with a short soft entrance, capped
at roughly three seconds for long answers. This is presentation after validation,
not provisional model streaming; reduced-motion users see the answer immediately.
Typing uses a brighter, more rippled attentive pose with a visible
**Reading your message…** cue, returning to idle after typing pauses.
Previous/next message arrows sit at the top-left of the chat command bar,
separate from the settings and actions on the right.
While Athena works, the ribbon sits beside the current activity and elapsed time,
without an activity-history list. These are actual
operation updates, not model reasoning or estimated percentage progress.
Streaming model connections allow 30 seconds for response headers. A transient
connection failure before headers gets one retry within the original request
deadline, with a visible reconnecting status. This does not replay tools or retry
partially received answers. Transport failures retain their underlying error code
and cause rather than reporting only `fetch failed`.

Technical spec and use-case notes offer **MD / HTML** views. MD keeps the
existing document editor; HTML is a sanitized, formatted review view generated
from the current document, including unsaved edits. Build specs (new and existing)
and Use Case summaries offer the same switch; linked specs open in Think with
both views. Switching views does not save, convert or duplicate the source.
Other note types are unchanged. Select a passage in HTML, describe the change,
and ask Athena for a bounded proposal. Before/after source text is shown for
explicit acceptance or discard; changed sources invalidate stale proposals.
Think accepts into the live editor with its existing history and autosave
protection; Build accepts into the draft (Save/Create is still required); Use Case
summary acceptance saves through its existing update action. Reviewed Build saves
and summary acceptance reject concurrent source changes rather than overwriting
them, retaining the local draft on failure. Think selections
must be unique within one paragraph or list item. Review instructions/proposals
are temporary, not approved requirements: accept or copy them before leaving
the view. No changes are applied merely by requesting review.

Use Case handoff sends the source Markdown, never a duplicate HTML rendering.
Both GitHub Copilot's prompt and Athena Build's spec state that Markdown is
authoritative and unresolved questions must be raised, not invented away.
Optionally select up to eight attached links as supporting mockups/prototypes.
These links are added to the canonical spec note under non-authoritative visual
references (with a history checkpoint), so both handoff destinations retain them.
Save the note before handoff and reload it afterwards if references were added.
Linked visuals are reference material, not production code. No Lavish dependency
or executable HTML editor is installed.

**Design is a note content type in Think.** Use **New note**, then choose
**Design** in the existing properties control. Changing type preserves the
same note ID, writing, history, tags and project. There is no separate New Design
action or workspace. Think creates/develops content; Plan manages work in progress.

Its four tabs—**Use case, Spec, Architecture, Diagram**—open linked originals.
The Notes list shows each Design once, not its linked originals as separate
top-level entries. Standalone documents remain visible. Searching linked writing
returns its Design; pagination/counts use the same grouping. Archived or
retyped parents do not hide their originals, and excluded/detached links no
longer group them. Flat note lookups and document pickers still include originals.

**Share note by email** in note Actions sends a formatted snapshot of the current
note text (including unsaved writing), without publishing to GitHub. Choose
recipients, review the text preview and confirm Send. The existing SMTP2GO
connection, hidden recipients and duplicate-send protection are reused. Headings,
emphasis, lists, tables and links are formatted in the email, with a plain-text
alternative; images are linked rather than remotely loaded. Recipients receive
the actual writing, not access to Athena or private linked content.
Actions remains in Think's command bar. Properties describes the active original.
Design is already the parent note; there is no separate parent-editing mode.
Empty document tabs retain the Design editor/properties.
Diagrams retain their own established canvas properties. Multiple linked versions
remain accessible, but require an explicit choice for visual generation/handoff.
Existing linked note/canvas entries open the corresponding Design tab; multiple
Design memberships require a parent choice. Standalone assets remain standalone.

Migrations 104/105 add persistence and create separate Design-type parent notes
for the five originally reviewed Use Cases. Their original content/types/history
are unchanged. Migration 107 adds parents for the four subsequently reviewed
standalone Use Cases, also preserving their originals. Already linked assets are
not given duplicate parents. Migration 106 corrects the four original specification documents to the
**Spec** tab without rewriting their original note types or content. **Link**
appears only for an empty section; populated sections open their linked originals.
Explicit existing references are retained; titles never infer attachments.

When a Design note is selected, the existing right-hand panel offers a single
**Design** tab with **Actions**, **Activity** and **Outputs** sections. It is
absent for standalone notes. Athena and document properties remain available,
including the diagram's native properties. The document area no longer repeats
generation controls above and below the writing.

Choose **Specification type: Standard / IMAGINE** under Design actions.
Migration 111 saves that choice on the Design; existing
Designs require an explicit choice, never one inferred from their title.
Changing the choice does not rewrite any document. The Spec writer (including
Blueprint prerequisites) uses the saved type: Standard writes a product spec;
IMAGINE fills the complete versioned demo-specification form one section per
request and renders its mandatory sections and tables server-side.
Activity shows actual section progress and failures. A timed-out section is retried
once without regenerating completed sections. Validated sections are checkpointed
on the specialist job, not saved as partial specs; a later retry reuses them only
when the template, selected source content/revisions and Design revision match.
Complete demo specifications and their generation inputs share a 500,000-character
limit, so an accepted document remains readable by its next generation. Per-field,
table-shape and revision checks still apply. Finalizing a complete checkpoint can
explicitly prohibit further model calls; changed sources then require a new decision.
Blueprint generation reads each note's complete Markdown once, without duplicating
its editor blocks. Feedback instead receives complete native blocks, including IDs,
children, media and mentions needed for precise edits (Markdown is retained for
sources without blocks). Both requests retain diagram documents and have a
750,000-character serialized-input bound, including the previous Blueprint,
direction or feedback and allowed source IDs. Nothing is truncated. Stored source
snapshots remain complete for revision checks, history and feedback acceptance.
Blueprint actors and screen names come from the selected use case/specification,
not from Athena's role as the author. IMAGINE Blueprints name the digital workers,
Digital Steward and human business roles responsible for each action. Actor
markers classify automatic work, humans and systems and identify the actor in a
source-named label or visible text; they do not require an Athena lane or invent
a human approval gate.
Generation and feedback both correct unsupported actor assignments from older
Blueprints. Existing stored visuals retain their styling without the old
hard-coded "Athena does this automatically" legend.
Bulk model requests longer than five minutes use explicit HTTP header/body
timeouts and an overall abort deadline, rather than native fetch's independent
five-minute header limit. Blueprint generation retains its nine-minute deadline;
transport failures include their error code and never save a partial Blueprint.
Invalid or incomplete form responses
do not replace the existing spec. Regeneration preserves note history and
rejects concurrent source or type changes. Both writers are instructed to
include requirements rather than defer to missing specifications, and to
distinguish supplied facts, proposed detail and unresolved business decisions.
Selecting IMAGINE does not approve simulations or authorise live integrations.
Outputs open the existing linked document tabs; earlier document versions stay
in History. Failed Spec writer activity remains visible after reload with a
Retry action.

Athena's conversation stays attached to the Design parent while tabs expose the
active original. Athena reads the package's selected documents and exact revisions
before saving. Explicit requests to revise or save Use case, Spec or Architecture
update those originals with history; a missing section is created and linked in
the same transaction. Related section saves are atomic. Generic note/demo-spec
creation and Outputs cannot stand in for saving a Design section. Native
references/media are retained through targeted block changes, not lossy rewrites.
Current writing is saved before the chat turn; tabs are held stable during it and
saved writing refreshes in place without reloading the page or dropping the chat.
Concurrent source/version changes reject the save instead of overwriting drafts.
Migration 108 links the publishing conversation's saved Use Case/latest Spec into
their correct tabs and retains its original writing and earlier Spec as references.

The **Spec** tab alone offers **MD/HTML**; Use case and Architecture remain
document editors, and Diagram retains its native canvas. In Spec's **HTML** view,
Athena creates one shared, source-mapped interactive
visual directly from the linked requirements; extra direction is optional.
Creation shows live source-loading, model-generation, validation and saving
stages with elapsed time and a reduced-motion-aware animation. Stage messages
come from the server; no invented percentage or simulated model progress is shown.
The artifact uses the selected Markdown and diagram revisions. Explore screen states,
fields, journeys and choices; annotate an element or selected text and queue
feedback. **Ask Athena to propose Markdown changes** records the exact feedback
in the parent's existing Athena conversation and prepares bounded before/after
edits plus a revised visual. **Accept all changes** saves the targeted original
notes, history checkpoints and revised visual atomically. **Discard** changes no
source writing. Feedback/proposals survive reload; stale sources, versions and
missing anchors block acceptance. Older feedback remains visible until resolved
or explicitly discarded.

The artifact is generated from validated declarative visual data, not model
scripts. Its locally controlled HTML runs in an opaque-origin iframe with no
same-origin access, network, forms or parent credentials. The interaction bridge
checks the frame, per-render token, artifact revision, target and payload bounds.
There is no Lavish CLI, dependency, hook or external artifact hosting.

**Actions → Copilot package** creates an immutable snapshot for both archive
download and explicitly confirmed GitHub publication. Files include `design.md`
(preserved parent writing), the available `use-case.md`, `specification.md`,
`architecture.md`, `visual-design.html`, `diagram.json`, `diagram.svg`, `README.md`
and `manifest.json`. The manifest records selected original IDs/revisions, source
mapping, SHA-256 file hashes, missing inputs and open decisions. Stale visuals
block packaging; missing inputs and pending decisions visibly mark it incomplete.
Export does not invoke AI or change sources.

Markdown governs requirements; HTML conveys visual/interaction intent; diagrams
provide structural context. Copilot must clarify conflicts/open decisions, not
promote unaccepted feedback to requirements. GitHub publishes exactly the same
snapshot bytes in one non-forced commit, preserving unrelated files and checking
destination ownership, changed files/branch and the entire returned manifest.
Nothing is published or deployed automatically.

Saved diagram reads also use the checkpointed full-source reader in chat, so
large diagrams are processed page by page rather than discarded at the ordinary
retrieval-context limit. Search results remain discovery previews, not completed
reads. Deleted or excluded diagrams are reported as unavailable; they are not
described as a source-size failure. Reading checks the diagram and linked-context
version between pages and before returning a completed review.

Choose **Spec** in the message action selector, or begin with `/spec`, for a
grounded coding-agent specification: scope/non-goals, requirements, bounded
implementation steps, acceptance criteria, verification, rollout and stop
conditions. Missing facts and unresolved decisions must be identified as blockers,
not invented. **Save to Think → Agent-ready specification** creates a Spec note
from the conversation and its saved-document references. Exporting from a
note-linked panel does not move the conversation away from its original note.
The small dot beside Athena reports activity only: grey means idle; pulsing teal
means generating a reply. It does not indicate saving, sync or connectivity.

Proactive link suggestions omit generic labels such as "Review" and ambiguous
same-title destinations. Click the suggested title to preview its actual target
before linking. Manual search still allows those targets when deliberately chosen.
For M365 reports from the local **Daily Insights** folder, see the
[desktop capture setup and safety rules](athena-desktop/README.md).

Microsoft sign-in renews silently where possible. When interactive sign-in is
required, Athena shows a session-expired dialog with a **Re-authenticate** button
instead of refreshing or redirecting unexpectedly. User-initiated re-authentication
opens a Microsoft popup, keeping the current page and unsaved editor content
mounted. Allow pop-ups for Athena; cancelled or blocked sign-in can be retried.
The existing `/signin` callback relays MSAL v5 responses before loading the app.
Popup callbacks never mount the sign-in gate or initialise another MSAL client,
preventing nested-popup failures while keeping the original editor mounted.
Regression fixture: `tests/auth-callback.html` in the frontend, run with the
existing browser runner's `ATHENA_BROWSER_CHECKS=auth-callback` mode. It exercises
the real MSAL bridge for popup, redirect, query/hash and error responses.

Think's **Copy note** action copies the whole current note as Markdown, including
unsaved edits and its title, with paragraphs, lists and links preserved.

Think notes have a **History** side-panel tab for lightweight recovery. On the
first changed save, the previous writing is checkpointed; further automatic
checkpoints are at most once per 30 minutes per note. Metadata-only and unchanged
saves do not create checkpoints. Autosave still saves current writing normally.
Athena replacements/deletions preserve the exact live draft before applying a
batch, and restoring preserves the current writing before replacing it.
Only the newest 30 checkpoints per note are retained (including protected ones),
with no age expiry. Intermediate autosaves are not an exhaustive edit log.
Restore affects title, content type and rich body only; current project, tags,
links and GitHub settings stay unchanged. Checkpoints retain image references,
not image files, and are never AI-indexed or added to Connections.
Conflicting writes pause autosave and keep the editor draft: copy it before
reopening the saved note. History is Think-only, not task/Discover/canvas history
or deleted-note recovery, and is not a substitute for backups.

Think's **Recovery** button opens a modal without unmounting the current editor.
**Recently archived notes** uses the existing soft archive: search and browse
25 summaries per page, load a full read-only preview on demand, then explicitly
restore. Restoration preserves writing, History, project, tags, links and GitHub
settings; it increments the revision and queues normal indexing. A repeated or
delayed retry reports an already-active note without rewriting newer writing.
Normal note lists/deep links still exclude archived notes. This does not recover
permanently deleted records or publish a note.

Edits also capture a versioned **device-local writing copy**, scoped to the
signed-in tenant/account, note and base revision, with separate writer IDs for
different tabs/editor instances. Copies contain exact title, content type and
rich-body JSON, not unsaved project/taxonomy changes, publication settings or
image files. They are plain text in this browser's local storage, not encrypted,
cross-device backups or an exhaustive edit log. Clearing site data, private
browsing, unavailable storage or quota limits can prevent recovery; visible
errors never imply a server save succeeded. Records are bounded to 2,000,000
serialized characters; browsing reads at most 100 copies and explicitly reports
unreadable records or incomplete coverage.

Recovery offers preview, exact JSON/manual-copy fallback and explicit discard.
Open a source note to compare earlier local copies with freshly fetched saved
writing. Nothing restores automatically. A changed server revision requires
review and confirmation; every restore uses that reviewed revision. Current
server writing is preserved through the same 30-checkpoint History policy,
while replaced unsaved open writing is retained as a separate local copy.
An unsupported preview disables restore instead of converting away rich blocks.
Late save acknowledgements remove only the exact submitted local snapshot, never
newer typing. A lost response retains the local copy for review rather than
blindly overwriting the server on retry.

Explicit discard removes only the reviewed, unchanged record. Explicit sign-out
removes all note-draft records on this device (not chat drafts or preferences)
and changes a recovery-session marker so pending saves and previously mounted
editors cannot recreate those copies. If cleanup fails, sign-out stops with an
error rather than claiming the sensitive writing was removed. After a sign-out
or account/session change, copy any still-open writing before reopening its note.

Run the isolated history database regression from `knowledge-hub-backend` with
`node --import tsx/esm --test scripts/note-history.test.ts`. It uses in-memory
PostgreSQL, never the configured application database.
The real-editor browser fixture is `knowledge-hub-web/tests/note-history.html`;
use the existing browser runner with `ATHENA_BROWSER_CHECKS=note-history` and
`TODAY_FIXTURE_URL` pointing at that fixture on an isolated Vite server.
The credential-isolated root runner includes draft-storage and real recovery
route/database tests. With `TODAY_BROWSER_PATH` pointing to Chromium,
`node scripts/run-browser-checks.mjs --modes=note-recovery,note-history,markdown-export`
checks real page reload, exact rich writing, response-loss/conflict protection,
storage failure, archive retries, identity/sign-out and unchanged history/export
at desktop and phone widths; API/auth traffic is blocked and logout is mocked.

A unified personal intelligence layer that aggregates content, code activity, calendar events, and tasks from 10+ sources into a single, searchable, AI-queryable timeline — accessible from Android and Mac.

---

## Local quality gates

CI runs **Backend checks**, **Frontend checks** and **Browser checks** on pull
requests, including integration-branch PRs. Each application provides
`npm run typecheck`, `npm run build`, `npm run lint:check` and
`npm run test:isolated`. Frontend model tests resolve the existing backend
TypeScript runner, so install both lockfiles before running them.
Isolated tests use an allowlisted environment, an unreachable fixture database
and no application dotenv file; they never require production credentials.

`npm run lint` remains the full lint report. `lint:check` rejects new or changed
violations against explicit source-fingerprinted `.eslint-baseline.json` debt;
failures print each new violation's file, line and rule directly in the job log.
it does not claim the old debt is fixed. Do not refresh a baseline to hide a new
failure. To deliberately reduce debt, fix code and review the generated baseline
changes using `node ../scripts/check-lint-baseline.mjs --update`.

From the repository root, run `node scripts/run-browser-checks.mjs` with
`TODAY_BROWSER_PATH` pointing to installed Chromium/Edge. It starts and stops
its own strict-port fixture server and blocks live API/auth requests.
Use `--modes=auth-session,auth-callback,note-history,markdown-export,diagram-theme`
for the isolated authentication/editor/export regression set, or select
`navigation`, `discover` and `today` individually. Unsupported/live modes are
rejected. The navigation fixture intentionally fails one deferred loader to
exercise Retry; only that exact fixture error is excluded from the unexpected
JavaScript-error gate. Artifact captures use the active emulated browser page.
Selected journeys all run even if an earlier journey fails; the job still fails
if any journey fails. CI uploads per-journey screenshots and failure diagnostics
for seven days. All non-chat journeys run at desktop width only (1440px).
The separate `chat` journey covers the chat interface at 390px, including
draft/session recovery and failed sends; it does not run mobile navigation,
Today, Discover, editor or diagram checks. The viewport-scope regression checks
run without a browser using `node --test scripts/browser-viewports.test.mjs`.
The fixture server uses a separate reusable Vite dependency cache, so running
checks cannot invalidate the normal development server's prebundled modules.

For reliable releases, branch protection should require **Backend checks**,
**Frontend checks** and **Browser checks** before merging to `main`, without
administrative bypass. A direct push that starts CI only after landing on `main`
does not provide that gate. Workflow code does not configure repository protection;
those settings must be changed separately by an administrator.

Plan has Board and List views (the Calendar view was removed; saved views that
used it open on the Board). Open use cases also appear on the Board: Candidate
cases in Backlog and Refining, Spec ready and Handed off cases in In Progress.
Their cards open the use-case details; stage changes remain in the use-case
panel because a board column combines multiple lifecycle stages. Closed cases
do not appear on the active board. Project filters apply to both tasks and use
cases; a tag filter hides use cases because they do not carry task tags.
Date-only task values remain local calendar dates.
Recurring completion, successor creation and tag writes commit together; migration
`063_task_recurrence_identity.sql` prevents repeated completion from creating
multiple successors. External integration/indexing work runs only after commit.

Think browses note summaries in 100-item pages with a matching total and explicit
Load more. Search matches literal text in saved writing, including later pages;
type, project and taxonomy filters and modified/created/title sorting run on the
server with stable ID tie-breaking. This is not semantic/full-text search.
Legacy taxonomy-only project assignment remains supported, and full note bodies
are fetched only when opened. Filtering, loading and failed queries retain the
open editor and filter controls. Migration `064_note_list_metadata.sql` safely
reads legacy/wrapped metadata without changing stored writing or explicit titles.
Accepted saves reconcile server ordering/filter membership, and overlapping
pages are deduplicated by note ID; offset pagination is not a snapshot of
concurrent edits. Taxonomy-only project choices are available before their notes
have been loaded.

Project selectors share one live cache across workspaces, including Today,
Athena uploads and diagram properties. A valid empty list does not invent
configured projects; failures can retain real cached records with visible errors
and retry. Personal/unassigned and existing unknown scope IDs remain explicit.
All project pickers use the shared IBM / Nelfin / Personal hierarchy, including
diagram properties, task editing, Plan filters, Athena conversation grounding
and attachments, notes, use cases and Sources. Archived/completed projects are
hidden unless currently selected; stored project IDs are unchanged. Memory's
searchable picker shows parent/project paths, and linked watchlist projects use
the same grouped ordering. Reuse `ProjectOptions` (native or Carbon selects) or
`groupProjectsByParent` (searchable/multi-selection controls) for new pickers.
The isolated browser runner's `--modes=project-pickers,diagram-properties,watchlist-projects`
selection covers these pickers at desktop and phone widths without live API calls.
Memory, Library, Discover and Plan now expose failed reads/changes, retain edit
input and prevent duplicate pending submissions. Note summaries are tied to the
current note/request, so obsolete responses cannot replace a newer note's summary.
Project/task edit fields stay locked while saves are pending. Task status changes
roll back only the affected task in the original filter cache, and pending
move/delete actions cannot be submitted again for that task.

Build auto-merge currently trusts the three named GitHub Actions checks for
this repository only, with actual successful conclusions on the inspected head.
Missing/skipped checks or unknown repository policy require manual approval;
the GitHub merge is bound to the inspected SHA. Explicit manual merging remains
available. Existing workflow-change approval and integration-branch safeguards
are preserved. CI is not a deployment pipeline.

### Runtime and job safety

`/health` is process liveness only. `/ready` returns 503 until migrations,
database verification and interrupted-work recovery complete, and again while
stopping. API routes reject requests while unready. Initialization failure starts
no schedulers and exits nonzero; unrecoverable exceptions trigger bounded shutdown
(15 seconds), clearing initial/interval timers and interrupting live AI jobs.
Cloud probe configuration has not been changed or verified by these code changes.

Non-production server and migration-CLI startup require an explicit
`DATABASE_MODE=local` (a loopback database URL) or `DATABASE_MODE=disposable`
(an explicitly selected disposable database). Do not point disposable mode at
production. Development/test servers never start scheduled integration/AI jobs.
For local development using Athena's production content, explicitly set
`NODE_ENV=development` and `DATABASE_MODE=production`. This server mode skips
automatic migrations and interrupted-work recovery so it does not interfere
with production jobs; app actions still read and write production data.
The migration CLI still runs migrations when explicitly invoked.
Isolated tests still block dotenv and use disposable fixtures, not application
database settings.

Migrations use a dedicated PostgreSQL connection and session advisory lock;
each migration and its tracking row commit together. The existing SQL files were
checked for transaction-incompatible statements; none require a nontransactional
exception. Historical migrations include destructive canvas rebuilds, so this
does not make schema downgrade/replay safe or restore deleted data. No existing
migration SQL was changed. Additive migration `065_runtime_runs.sql` stores sync
runs and scheduler claims.

Manual sync returns a run ID; Timeline polls that run rather than inferring
completion from any source timestamp. Runs retain source results and distinguish
running/succeeded/partial/failed/interrupted. Monitoring is bounded to 30 minutes
even if reads fail; timeout is not success and does not cancel/restart server work.
The sync panel displays the latest run and per-source outcomes.

Daily/weekly scheduler identities use Europe/London dates and hours. Claimed
occurrences are not replayed after failure/restart: this avoids duplicating
external side effects, but a failed/interrupted job requires explicit operator
review; manual sync creates a new run. Startup marks unfinished sync/claimed jobs
and pending chat turns interrupted without executing their actions. A new chat
request is explicit, duplicate running turns are rejected, and late completion
cannot clear another turn's metadata. Live reconnect remains in-memory while the
process survives. These safeguards assume the existing single-replica deployment;
do not enable multiple replicas without lease/ownership recovery changes.

## Discover publishing feeds

**Discover → Publishing** has two posting-automation switches: **Bluesky** and
**Blog / LinkedIn**, both initially **off**. Off pauses new publication, not
editorial preparation; a request already in flight cannot be recalled.
The existing 06:00 and 13:00 UK content sync supplies candidates and refreshes
drafts; an independent production worker also selects, reads, drafts and reviews.
The background worker assesses at most 12 topics per rolling 24 hours, four distinct sources per
topic, with at most two automatic revisions. Unreadable, oversized or excessive
source evidence is held rather than silently omitted.

The Drafts workspace shows finished, editorially reviewed posts: a compact
shortlist on the left and the complete selected post on the right, with destination
tabs. Discovery candidates, empty records and unfinished reviews are not approval
items. Selection is heavily Microsoft-first and freshness-led; non-Microsoft
stories require an exceptional, recorded audience-relevance rationale. **Drafts has
at most eight entries total**, with a blog and its social copies counting as one
entry. Per-feed caps plus alternatives remain ceilings within that overall limit.
Sending an entry for scheduling removes its whole topic from Drafts, even when an
optional social copy is still pending. Scheduled items are separate from the
eight-entry draft limit and never fill Drafts again merely because they are blocked.
Every content sync reselects the freshest Microsoft-first candidates and reviews
the unscheduled shortlist. Each sync processes at most eight candidate topics,
allowing up to eight new-topic assessments even when the background worker's
rolling allowance is exhausted or Drafts is full. Newer reviewed drafts displace
older proposals in the shortlist; existing draft history is retained. The
background worker's limit and all editorial gates remain in place.
Sync refresh cannot publish, approve or rewrite scheduled copies.
Refresh failures are logged and recorded in Publishing Audit; incomplete drafts
are not offered for approval. Refresh audit reports selected topics, assessment
attempts and completions, actually recorded reviews, skips and failures separately;
selection alone is never reported as a completed review.

Standard Bluesky drafts pair the announcement with a brief proposed Richard-style
comment: a grounded practical judgement, caveat or implication shaped by saved
preferences. Voice review rejects bare headline summaries; accuracy review keeps
interpretation distinct from reported facts and prohibits invented personal
experience. The comment shares the existing copy/link character allowance and
still requires Richard's exact-version approval.

Manual **Publish to blog** drafting reads the original discovered article before
checking claims, rather than relying on its feed description. Its factual and
style editor patches only defective sentences or phrases, checks alternative
wordings before accepting them, and retains successful corrections between passes.
Rejected replacements are supplied to the next pass so it does not repeat the same
failed rewrite. Clean copy, source links and quoted wording are preserved during
style repairs. The revised draft receives another factual and style review before
appearing in the existing editor; no review or repair publishes a post. Spark
drafts use the same repair process against their supplied ideas.

Publishing blog packages are **quick takes**, not long articles: target 300–450
words, maximum 600, one argument, a title of at most 60 characters, no body
subheadings or lists, and at most two takeaways. Packages include the slug,
excerpt, summary, categories, tags and original source reference, with no image
fields. The existing publishing API receives HTML paragraphs and `postType: quick`;
the source URL is a separate field. LinkedIn copy is 120–150 words with a closing
question and two or three hashtags. Twitter/X copy is saved with the blog package
for manual use only, not as another automated destination.

**Send for scheduling** approves the exact version; it does not publish immediately.
Human approval is required. **Send package for scheduling** approves the exact
saved Blog and LinkedIn versions together in one transaction; there is no second
approval step. Both copies remain readable in their destination tabs. A changed
version rejects the whole approval rather than approving unseen copy. Standalone
Bluesky uses **Send for scheduling**. Scheduling assigns a persisted, exact-version slot,
spreading posts across the configured publishing window while respecting account-wide
spacing and daily limits. The Scheduling agenda shows each destination's planned time
in its feed timezone, paused state and blockers; approved items without a
usable slot remain visible rather than disappearing from the shortlist. Blog and
LinkedIn slots wait for package approval; promotion waits for the verified public blog
URL. Planned LinkedIn promotion is at least 15 minutes after the blog.
Blog-flow Bluesky follows confirmed LinkedIn delivery, with its planned slot at
least 15 minutes later. Both social destinations append the verified new blog
URL, never the source article. Standalone Bluesky remains source-linked.
Automation must be enabled before delivery. Drafts do not expire automatically;
freshness guides editorial selection, not an arbitrary deadline on approved posts.
Missed slots roll to the next opening, not a catch-up burst; use
**Refresh schedule** to recalculate locally without enabling posting. The production
worker also refreshes the plan and cannot claim a draft before its assigned time.
Sources, selection reasons,
accuracy/voice findings and immutable versions remain in secondary disclosures.
Editing invalidates
approval; changing the blog also invalidates hook consistency and approval.
Publication waits for package approval and a current passed review. Blog-first
delivery verifies the final public article before binding its URL into social
copy. Blog delivery is never repeated just because a social destination failed.
Scheduling, History and Audit expose queue state, receipts and reconciliation.
The blog's accepted URL is saved before public verification. A temporary 404 or
network failure triggers read-only rechecks after 5, 15 and then 60 minutes
(hourly thereafter), not another blog creation request. Confirmation restores
the delivery-held approved version to normal scheduling without changing its
copy or approval. Interrupted accepted deliveries are checked after the delivery
lease expires; older accepted-but-unverified records can use their saved CMS
slug to locate and verify the exact article. Manual holds, changed versions and
unknown send outcomes are not automatically overridden. Content mismatches or
invalid public URLs still require reconciliation. Managed jobs retain accepted
URLs across restarts and use the same verification backoff and social order.
The interface reports delivery holds as delivery problems, not failed editorial
preparation. Initial approvals, feed switches and account-wide pacing still apply.
Athena can inspect this same state and propose confirmed feed settings from any
chat; it cannot grant publishing approvals or reconcile outcomes itself.

Editorial model output uses strict JSON schemas and rejects truncated responses
before parsing or saving them. Output exhaustion gets one bounded retry; a failed
revision preserves the saved version. Empty generated copy is rejected before any
destination is stored or reviewed. Isolated regression tests cover these boundaries;
`PUBLISHING_EVAL_LIVE=approved node --import tsx/esm scripts/publishing.eval.ts`
additionally exercises real model calls using synthetic evidence and an isolated
database, with production telemetry writes intercepted and no publishing calls.

Review revisions return exact sentence/paragraph replacements, not regenerated
articles or posts. Only those passages are patched into the saved content;
unaffected text and metadata are retained. Ambiguous, overlapping or stale
replacements are rejected without saving a version. The patched draft receives
fresh accuracy and voice checks, with the same bounded revision limit and
exact-version approval requirements.

Local development uses the same configured database, including real drafts,
feed settings and exact-version approvals; it is not a separate publishing
preview. **Send for scheduling** from localhost updates that shared queue.
Local scheduled jobs and delivery workers remain disabled. Production delivery
still requires its feed switch and all approval and pacing checks.
To explicitly prepare a bounded batch without approving or posting anything,
run `PUBLISHING_PREPARE=approved node --import tsx/esm scripts/prepare-publishing.ts`
from `knowledge-hub-backend`. Both posting switches must be off. This loads saved
connection credentials and uses the production worker lock and editorial checks.

Default opportunities are 08:00–20:00 Europe/London, all week. Policies expose
days, timezone, window and editorial guidance. Bluesky is capped at
four/day with two-hour spacing; LinkedIn at three/day with three-hour spacing.
These are ceilings, never targets. Blog-linked Bluesky shares the same cap;
same-event follow-ups require a distinct argument and a 24-hour gap. Queued
source promotion is held when a blog argument supersedes it.

The account-wide ledger includes Athena's Jobs and manual Discover social posts,
not posts made directly on the platforms. Legacy Discover receipts did not store
an account, so recent/unresolved legacy posts are conservatively attributed to
the currently selected account. Unknown outcomes reserve capacity until a human
reconciles them; they are never blindly retried. Confirmed rate-limit rejections
retry after 5/15/60 minutes; configuration/permanent failures require a user
decision. Reconciliation records the actual post URL and publication time.
All writes and worker execution are disabled on development servers because
local development uses the production content database. Migration 100 runs only
through normal backend startup/deployment; isolated tests use PGlite and fake
readers/models/delivery adapters.

## Email account connection list

**Tools → Connections and sync** lists the Alliance, Hotmail, and Gmail
mailboxes under **Email accounts**. The Alliance address uses the configured
`ALLIANCE_ALLOWED_UPN`. Listing an address does not authorise mailbox access.
Alliance sign-in requests delegated `Mail.Read` (user-consentable, no admin
consent needed) unless `ALLIANCE_MAIL_ENABLED=false`. Existing OneDrive
sign-ins keep refreshing with their original scopes, so reconnect at
`/auth/alliance` and accept the mail permission to start the `alliance-mail`
sync. It indexes important inbox mail from the last 30 days as `email` items
tagged `alliance`. Personal Microsoft/Google accounts need separate
authorisation. Existing IMAP configuration is labelled
as configured, not verified/connected. The authenticated
`GET /api/sources/email-accounts` endpoint never returns credentials.

## Thursday podcast preparation

News sources come from two places with equal weight: the Discover list (in its
ranked order) and web news search. Source slots alternate between the two, so
neither fills the brief alone, and each source link says where it came from.

Athena prepares a shortlist at 07:00 Europe/London on the Thursday immediately
before a scheduled Friday recording. The existing podcast schedule and "Podcast
Record" calendar override remain authoritative; off-weeks do not generate a
brief. If the schedule explicitly documents Friday recording with a following
Monday release, a stored Monday release resolves to the preceding Friday,
without rewriting the publishing schedule. Actual calendar recording events
take precedence and are never reinterpreted as release dates.
An otherwise non-Friday schedule is reported on Today and must be corrected with
Athena rather than silently assuming a recording date. Explicitly cancelled
calendar events are skipped. Calendar information is only as current as its
last successful sync.

The Microsoft-focused brief ranks up to six candidates and recommends three discussions in
decreasing depth: an enterprise-focused lead, a shorter second, and a lighter
third. Richard's focus is enterprise consequences, particularly AI; security
and pure architecture remain Cyrus's and David's territory. Available recent
episode transcripts/show notes are read in bounded chunks, alongside recent
own posts, Discover, and required fresh web research. Previously covered
subjects qualify only when material new outside news changes the discussion.
The lead is anchored to what Cloudy actually discusses: the last twelve
published show notes are passed to the model as an archive, and the lead must
name the episode (`showThreadId`) it continues with new developments; a lead
without a valid published-episode thread is rejected. Web queries follow the
show's themes (agents as accountable digital workers, AI governance, provider
concentration and sovereignty, Copilot adoption and value). Candidates must be
AI news on those themes; courses, training, docs, how-tos, pricing and event
pages are excluded before reading, and in-lane items rank ahead of fresher
off-lane Microsoft news. Each topic in the brief shows the Cloudy thread it
continues, or states that it is a new thread.
Sources are linked and dated. Tech Community articles are read from the publisher's
full article body embedded in the requested page, not its loading shell or a
search summary. Failed web searches or selected source reads fail preparation
with the actual error; cached Discover text is never substituted and failed
sources are not silently skipped. Missing transcripts, limited research coverage,
and insufficient candidates are disclosed, never filled with invented material.
Coverage summaries and source reads run at most three requests concurrently.
Preparation has an eight-minute deadline: a timeout marks the run failed, preserves
the previous brief, and prevents a late result from saving a new version.

The brief is posted as Athena's message in a Podcast Prep conversation, so it
can be discussed and reshaped before anything is saved; save an Output from the
conversation when the segments are settled. A refresh reads the conversation so
far. Today provides **Prepare now**, **Refresh brief**, and a link to the conversation. A persistent global
notification appears once the brief is posted; dismissing it is server-backed
and does not remove the Today link. Opening the brief uses a separate tab and
does not replace the current conversation. Email, browser push, and OS
notifications are not enabled.

Authenticated endpoints: `GET /api/today/podcast-prep`,
`POST /api/today/podcast-prep` (202, asynchronous generation), and
`POST /api/today/podcast-prep/acknowledge` (recording date and generation time).
Database leases deduplicate manual/scheduled triggers, expire after 30 minutes,
and allow up to three automatic attempts with a 15-minute retry delay during
Thursday daytime catch-up (before 18:00 UK). Failed runs stay visible and can
be retried manually. Refreshing preserves chat history and uses the latest
output/user edits as context.

Isolated regression: `scripts/podcast-prep.test.ts` in the backend. Browser
fixture: `tests/podcast-prep.html` in the frontend. With `TODAY_BROWSER_PATH`
pointing to Chromium, run
`node scripts/run-browser-checks.mjs --modes=podcast-prep`.

## Podcast episode campaigns

The existing Claude Markdown → import/paste into Think workflow is unchanged.
For **Podcast show notes**, Metadata has episode-specific YouTube, Spotify and
Apple Podcasts URL fields. Unambiguous episode links already in the note are
prefilled for checking and saving; show/channel links are rejected.

The **Campaign** sidebar tab prepares the launch blog, personal-account LinkedIn
posts and Bluesky campaign by selecting existing passages from the saved note.
The model returns source block references and proposed times, not rewritten copy.
The server copies those passages directly and converts Markdown formatting for
the destination. This keeps preparation small and preserves the authored wording.
Podcast-account LinkedIn copy and other platform material remain in the note.
Blog and LinkedIn contain all three listening links; Bluesky rotates YouTube,
Spotify and Apple, with the complete copy plus its actual URL checked against
the platform limit. Oversized posts stay visible in the draft and block approval;
they are never silently shortened. These links are not replaced by the launch blog URL.
An explicitly requested date window prepares only the remaining posts in that
window. A follow-up-only campaign does not recreate the launch blog or invent a
new LinkedIn reminder. Re-preparing preserves that saved window.

Read the complete copy and schedule, then approve the campaign once. Missing or
past dates, invalid links, ordering and spacing violations prevent approval;
past campaigns are never silently moved forward or published as catch-up posts.
Times may be proposed inside the existing account windows when the source gives
a date without a time; preparation notes identify these proposals. Edit the
original note and prepare again to revise a draft. An approved campaign is a
fixed copy: later note edits do not silently rewrite scheduled posts. Pause
before re-preparing; after publication starts, copy and links are locked while
pause/resume remains available. Resuming explicitly makes overdue approved posts
eligible in order, within the account limits.

The production scheduler uses the shared delivery ledger, daily limits, spacing,
connected-account checks and uncertain-send protections. Blog acceptance is
persisted before verification; delayed confirmation is retried read-only, never
by reposting. Subsequent posts wait for earlier confirmations. Failures and
receipts appear in Campaign; unresolved deliveries use the existing Publishing
History reconciliation controls. Local automatic delivery remains disabled,
while local editing and approval use the shared production database.

Migration `113_podcast_campaigns.sql` adds the note-linked campaign table without
changing existing notes or publishing queues. Authenticated endpoints are under
`/api/publishing/podcasts/:noteId`: GET, PUT `/links`, POST `/prepare`, and POST
`/decision`. No existing episode is prepared, approved or sent by the migration.

## Knowledge health

**Tools → Knowledge health** (`/health`, `GET /api/health/knowledge`) is a read-only view of AI usage, recent sync runs and index freshness, filtered by UTC date range (inclusive, up to 90 days; default last 7), environment, feature, persona and deployment. Every query is bounded and each section fails independently. Token totals count only calls where the provider reported usage (`ai_usage_log.usage_known`, added by migration 067); earlier rows and calls without usage show as "Not measured" rather than zero. No monetary estimate is shown because no pricing is configured, and prompts, content, session ids and error text are never returned.

The **Knowledge coverage** section adds, additively, per-family capability state from the coverage manifest, indexed counts, extraction distribution (full text, metadata only, at the 8,000-character ingestion cap), last indexed/successful sync, safe error categories and semantic-layer status. Counts that cannot be measured (eligible records, per-family pending/failed, absent indexing-work or decision tables) are returned as `null` and shown as "Not measured"; no percentage is invented and a connected provider alone is never shown as up to date. In chat, the "Used:" line separates Found, Read and Cited sources, shows "No longer available" for missing targets and scopes warnings to the reply. See [docs/knowledge-coverage.md](docs/knowledge-coverage.md) for the full audit, the `KNOWLEDGE_ORCHESTRATION` flag and the rollback procedure.

## Project cockpit and register

Each project card has a **Cockpit** button (`GET /api/projects/:id/cockpit`) showing the outcome, blocked/open commitments, a register of questions, risks and issues, and collapsed supporting evidence (chat decisions, notes, outputs). Sections fail independently and lists are capped with totals. The register (`/api/projects/:id/register`, migration 068) is created, resolved and linked to tasks by the user; "Add to register" on a chat decision is idempotent and never changes the decision. Diagram callouts are not yet promotable. No completion percentage is invented.

## Review packets

The cockpit has a **Review packets** panel (`/api/projects/:id/packets`, migration 069). A packet is a fixed copy of explicitly chosen notes, outputs and decisions, with source links, captured version identities, a reviewed checklist and a live changed/missing indicator. Approving a packet only records the approval (and needs an explicit acknowledgement if sources changed); it never publishes, posts, creates issues or starts Build. Packets export to deterministic Markdown. To change the selection, create a new packet. `knowledge-hub-backend/scripts/review-packets.test.ts` includes a curated offline evaluation set (grounding, project scope, missing/stale evidence, action confirmation) with no network calls; live AI evaluation is not implemented and must stay opt-in and separately approved.

## Remaining roadmap

Implemented: recovery, knowledge health (migration 067), project cockpit and register (migration 068), review packets (migration 069), operational documentation ([docs/operations.md](docs/operations.md): release identity, migration compatibility, smoke checks, rollback limits, backup/restore, environment isolation). Cloud backup/restore and isolation verification are separate, permissioned work and are not claimed as verified. Still to do:

1. **Build trial run, UI half.** Agent assignment and agent PRs were verified against a scratch repository. Decompose, Start, the runner and the approval flow still need a signed-in session. See [docs/operations.md](docs/operations.md) section 8 for all findings.

### Planned features (not yet implemented)

These came from the UX review and competitor research. Item 1 is built; the rest are not. Full detail (current code, what to build, acceptance) is in [docs/planned-features.md](docs/planned-features.md). Order proposed (value against effort); mobile and tablet work is out of scope except `/chat`.

1. **Command palette actions (built).** Cmd+K finds any note, project, spark, diagram, task, use case, Discover article, Athena chat or linked source by title. Searches wait until typing pauses for 250 ms; changing the query or closing the palette cancels in-flight browser requests. Each failed search shows its error and a keyboard-accessible Retry action while successful results remain available. Local actions and navigation filter immediately. It runs actions (capture a Spark, ask Athena about this page, open chats, go to Think) and lists recent items first. "New task" and "saved view" actions are still to do (effort S–M).
2. **Backlinks and unlinked mentions in Think.** A panel on each note listing notes that link to it and text that mentions its title. Chosen instead of deeper folders (M).
3. **`@` mentions and `[[` wiki links in the note editor.** Type `@` or `[[topic]]` to link to an existing note, or to create a new note with that title. Each link creates a backlink. `@Athena` runs an instruction on a selection, with Athena's text clearly marked as AI-written (M).
4. **"Why Athena picked this" in Discover.** Merged into item 11 (M).
5. **Keyboard triage and density toggle for Discover and Think.** Single-key archive, save, skip and create-from, plus compact and comfortable density (S–M).
6. **Content pipeline board.** A stage view (idea, draft, published) across Discover, Think, Plan and Build for blog, newsletter, LinkedIn and podcast (M).
7. **Visible, editable Athena memory.** Show what Athena knows about you, with accept or reject, and a change view (S–M).
8. **Standard empty states and page templates.** Each area teaches its own shortcuts on first use (S).
9. **Optional spatial view in Think** for arranging Sparks and notes (M–L).
10. **Side-peek** to open linked items beside the current view (M–L).
11. **Discover Watchlists (competitive and market monitoring).** Track named organisations and products against one question and an explicit, versioned baseline, with dated, evidence-linked change briefs. "No meaningful change" is a valid result. Spec: [docs/specs/competitor-watchlists.md](docs/specs/competitor-watchlists.md) (L).

Items 2 and 3 share one note-link definition, described in section 0 of the spec.

Ideas parked for later: Angle Deck, timeline-of-thinking canvas, podcast "on air" persona, source-staleness badges, voice-note capture, repurposing side-by-side, pipeline health counter and "ask the archive".

Next free migration number: 082 (the latest is `081_use_cases.sql`; check the migrations folder first).

## Consistent interface (desktop)

Athena is desktop-first; only the standalone `/chat` screen is designed for phones and tablets.

- **Identity:** every project or topic has one colour and one icon, resolved from a single canonical index. The same chip appears in lists, tags, headers, cards and pickers. Areas colour their topics.
- **Project lifecycle:** Projects opens on Active; archived records remain available through the Archived filter without losing their tags or linked content.
- **Unified tagging:** projects and topics are chosen through one tag picker and tag panel, so a note, source or task is tagged the same way everywhere.
- **Shared page header:** Today, Discover, Plan, Think, Sources, Projects and others use one `PageHeader` (title, subtitle, command row), with matching spacing.
- **Control sizes:** buttons, dropdowns and icon buttons share `--kh-control-height` (36px; `--kh-control-height-compact` 32px for dense rows), so items on one command row align.
- **Type, radius and scrollbars:** heading tokens (`--kh-heading-section/item/label`), radius tokens (`--kh-radius-sm/md/lg/pill`) and one thin scrollbar style (from Plan) apply app-wide. No visible text is below 12px.
- **Side panels:** Think's Athena panel and other docked panels use a shared native-dialog frame that docks beside content on wide screens and overlays on narrow ones.
- **Think list toolbar:** search sits beside small icon buttons for Sort (dropdown), Group and Previews. The old Filters row is removed. The list shows 100 notes at a time with **Load more** ("100 of 111 notes").
- **Compact Notes:** with Group and Previews off, one-line rows show the title, type and existing delete action; the full local timestamp is in the row tooltip. Modified and Created sorts use collapsible local-date buckets (Today, Yesterday, Monday-based weeks, then months). Counts cover loaded search results, and Load more extends existing buckets. Collapsed buckets are remembered locally using stable month keys; selecting a note reveals its bucket. Title sort stays unbucketed, and project groups and preview cards are unchanged.
- **Sources list:** paginated with Load more. The same file in different repositories appears as separate rows, each showing its repository path.
- **Header badges:** Think (new spark themes), Discover (new articles since your last visit), Plan (overdue tasks) and Build (tasks awaiting you) show counts from `GET /api/nav/attention`. A badge is hidden at zero.
- **Back button:** the "‹ Notes/Canvases" button in Think only appears at phone widths.## Navigation
The single desktop header contains **Today, Discover, Plan, Think, Build and Projects**. The Athena identity returns to Today. **Tools** groups Activity (the existing `/my-work` route), Sources (`/library`), Knowledge graph and Memory separately from management actions. Connections and sync opens Activity's existing sync-status panel without starting a sync; Tag Manager, repo-to-tag mappings and repo project mappings retain their existing panels/routes. On narrow screens, Today stays visible and the menu separates Main destinations from Tools.

Search remains available through the header or Cmd+K / Ctrl+K. Its command palette uses the same destination groups and also searches Athena items, chats and sources, and runs quick actions. The toolbar is the only global Athena launcher: it opens the existing popout or reveals and focuses the Sources rail without changing context. It is disabled throughout Think, which uses its built-in Athena panel. There is no floating launcher on any screen. Sparks and Canvas remain Think modes, and quick Spark capture remains available in Think or with Cmd+. / Ctrl+. All existing URLs and redirects are preserved. No global project selector or new administration/search functionality is added.

The command palette is a native modal dialog, traps Tab/Shift+Tab, and returns
focus to its launching control. Discovery exposes selected filter states; a
card's Enter/Space selection never intercepts a nested action's keyboard event.
Plan remembers its mode and exact project/tag scope in a versioned browser-local
record. Missing project/tag choices stay visibly scoped until explicitly changed;
an unavailable saved scope never silently widens to all content.

**Saved views** in Plan and Discover names the current filters and view mode
(including Discovery's sort/CFP state). Up to 20 versioned views are stored on
this device, not synced between accounts/devices. Saving the same name updates
it; deleting a view does not change current filters. **Copy view link** captures
validated filter values in a versioned URL parameter, not underlying writing.
Shared links apply only to their matching workspace; malformed/duplicate links
show an error and retain current scope. Unavailable project/tag/source choices
remain visible rather than silently widening a saved filter. Storage failures
retain the entered name, and invalid stored views can be explicitly reset after
confirmation. Browser-local preferences and links may include project/tag IDs,
source names and title searches: share them only with intended recipients.

Heavy routes, Athena's popout, Think's editors/import and the graph canvas load
on demand. Recovery belongs to the failed view, outside AppShell's implementation:
**Retry** creates a fresh loader without reloading the page, authentication or
other mounted work. Normal prop changes do not recreate the loader/editor.
This is view recovery, not a backup or a guarantee that a crashing component's
own in-memory state survives.

The measured raw bootstrap entry is **2,425.4 KiB**, versus the review's
**4,658.7 KiB** baseline (about 48% smaller). The build now emits separate Athena,
Note editor, Diagram and Graph canvas entry chunks; Markdown conversion and its
editor dependencies are also deferred until requested. Shared dependencies and
syntax grammars may load with these features. Global Carbon/application CSS
remains substantial; these are build-byte measurements, not claimed production
transfer timings or Core Web Vitals.

Knowledge graph read failures offer **Retry**, including failed API envelopes.
**Relationships** presents the loaded graph as keyboard-accessible, paginated
text (50 rows at a time), using the same type/confidence filters. Inferred
relationships retain their confidence label. Coverage distinguishes indexed
data from source content, and a truncated graph is explicitly incomplete;
client-side filtering cannot restore nodes omitted by the server. Selecting a
node focuses its details and closing returns focus to the selected control.

Navigation regressions use the same isolated fixture server and Chromium executable as the Today checks below. Run `node tests/run-navigation-browser.mjs` from `knowledge-hub-web` with `TODAY_BROWSER_PATH` set. The fixture covers desktop (1440px), keyboard/focus behaviour, supporting routes, existing management panels, embedded Athena launch and failed supporting services. Mobile coverage is limited to the separate `chat` journey. API/auth requests are blocked. Unit tests run with `node --import tsx/esm --test ../knowledge-hub-web/tests/navigation.test.ts` from the backend folder.

## Blog publishing categories

Blog drafts and publishing share the CMS's accepted category list, exposed to the
editor through `/api/discover/blog-categories`. It applies to articles and quick
takes from Discover and Sparks, the blog persona, weekly digests and companion
blog posts. Unsupported categories are rejected before sending; topics such as
Dynamics 365 and Power Platform belong in tags. Quick take is `postType: quick`,
not a category. `BLOG_POSTS_URL` configures the publishing endpoint (default
`https://themicrosoftcloudblog.com/api/v1/posts/`); category changes do not imply
a different URL.

The blog publishing popup opens the Post field in rich-text mode, with an HTML
source toggle. Both modes edit the same HTML content, and both Save as draft and
Publish live send that HTML to the blog API. Switching views without editing
preserves the original source; rich rendering and pasted HTML are sanitized.

## Watchlist history

Company panels keep saved background separate from the latest monitoring check.
A quiet, incomplete or failed check does not clear previously recorded company
developments: the last dated findings remain visible, explicitly marked as older,
with source links and their original comparison-context version. Saved-finding
counts cover the whole archive, not just the latest page of checks.

Migration 112 stores persistent company background sources. **Run now** refreshes
background and checks for new developments; scheduled checks initialise missing
profiles and retry failed background research. Background searches are not
restricted to the news window, so undated product and company references can be
retained. Their excerpts are attributed search results, not independently
verified full-page reviews. Retrieval dates are never presented as publication
dates. Refreshes merge sources by URL identity and retain older references;
failed or empty research preserves existing knowledge and shows an actionable
gap. A changed monitoring configuration rejects stale research writes.
These retained references and earlier findings are also available to Athena,
clearly separated from developments in the requested date window.

The latest briefing is not the whole archive. A visible **History** section below
the company breakdown follows the selected company and shows its saved checks,
newest first, with expandable findings, source links and comparison-context
versions. History pages reuse the existing saved reports; no new analysis is run.
Repeated findings remain dated observations, not automatically inferred trends.
The full cross-company archive remains under **Earlier checks**.

Watchlist history preserves failed checks even when no coverage was recorded.
They display a failure and an explicit missing-coverage notice, not a quiet-market
conclusion, and do not prevent opening a previous completed briefing.
If the AI omits a required project assessment, Watchlists requests one correction
using the same evidence and project context. The corrected report must pass all
existing validation; missing assessments are never invented or silently ignored.
Validation failures are identified as analysis failures rather than source-health
problems. Normal successful runs still use one analysis request.
Project context is loaded sequentially, including its supporting documents, so
monitoring all active projects does not create a burst of database connections.

## Newsletter and podcast parking lot

Parked articles remain in For you when otherwise eligible and show a
**Parked: Newsletter**, **Parked: Podcast** or combined label on their cards.
The default For you ranking keeps a modest Microsoft/GitHub preference, but
progressively discounts repeated publisher-family entries so useful independent
stories surface on the first page. Relevance, freshness, project fit and explicit
interest weights still matter; no article is hidden to meet a source quota.
Balancing is applied before pagination, not to each fetched page. Latest,
editorial, explicit-source and format-specific sorts keep their requested ordering.
Pick reasons explain the diversity adjustment; it does not lower an article's
intrinsic relevance label.
Saved-source boosts use one-time membership lookups instead of a full content
scan for each article. Eligibility/count queries omit that always-positive boost,
and ranking inputs are materialized once before source balancing.
The initial For you list and its 100-item briefing share one request and a
one-minute query cache, rather than running the full ranked query twice on entry.

Discover's **Parking lot** keeps articles for a future **Newsletter**, **Podcast**
or both. Open an article's **Explore** panel (including Saved articles), choose
**Park for later**, select either or both destinations, then **Save to parking lot**. Entries
are stored on the server, appear once even when marked for both, and survive feed
refreshes. The pool shows the original source, excerpt and link; **Edit parking**
changes destinations or removes the entry without deleting the article.

Parking is separate from Saved, Planned for blog, Published and Archived. It
does not publish, schedule, generate drafts or automatically add material to
podcast preparation. Existing Saved articles are not automatically moved into
the pool. This first version accepts Discover articles only.

## Teleprompter text and preferences

Each open Think note's **Actions** menu includes **Pop out** for a read-only
content window and, in supported Athena Desktop versions, **Present** for the
presentation display. These commands no longer occupy separate toolbar buttons.

Both presentation modes preserve inline line breaks, paragraph spacing and empty
paragraphs from saved notes. Formatting spans stay on the same line; nested
blocks, links and readable table text are retained.
Athena Desktop saves speed, text size, mirror, flip and opacity on that device
between sessions. Browser Autocue saves text size and microphone sensitivity in
that browser's local storage; blocked storage shows an error. These preferences
are not cross-device sync and do not resume playback or a previous scroll position.

## Blueprint regeneration and navigation

Notes, specs, use cases and Blueprints share an 858px maximum column width
(10% wider than the previous 780px), shrinking to fit narrower editor panes.

The Blueprint's **Regenerate Blueprint** button and optional direction field
are always visible above its preview, without a collapsed section. Regeneration remains
explicit and preserves the previous revision in history. Decision links scroll
within the embedded Blueprint without navigating away from the preview.

## Scheduled sync and weekly editorial review

Blog-linked Bluesky drafts budget the copy, two line breaks and the complete
CMS permalink together against the 300-grapheme limit. Managed jobs and Discover
publishing check the generated slug's permalink before approval; editorial
repairs shorten only unapproved copy. Delivery checks the actual returned blog
URL again and never truncates links or silently rewrites approved posts.

A completed content sync with individual source errors is shown as **Succeeded
with source errors**, retaining per-source counts and diagnostics. Total source
failure still fails the job. Older completed partial-sync runs use the same
display label without rewriting their original audit records.

The weekly Microsoft job selects important, dated Microsoft updates from the
reporting week, reads their source pages, and validates claims before writing.
Unreadable or unverified sources are excluded with explicit source-gap records;
undated search results are not assigned an invented publication date.
The article is primarily a factual update list with brief commentary, not a
forced narrative. Factual enumerations and quoted source wording are preserved.

The job reviews its exact outgoing blog, Slack and social
package for accuracy and voice using standing preferences and the weekly job's
saved instructions (not unrelated Discover feed policies). It applies only passage-level repairs, then repeats both reviews,
with the same two-revision limit as Discover publishing. Each version and its
findings are retained in the job artifacts and audit. An unresolved review
holds delivery; approval cannot bypass it. Think and chat receive the reviewed
blog rather than the rejected initial draft. Retrying preserves completed
generation and resumes editorial review instead of discarding the draft.
The writer's Markdown fields are canonical: the blog HTML and saved CMS document
are rendered from them, not rewritten by another model. Metadata findings can
be repaired explicitly. Repairs replace only an exact phrase or single sentence.
Valid edits are retained; rejected edits receive one targeted correction attempt
against the updated text, without regenerating the article or accepted edits.
Remaining rejected edits stay in the audit; both reviewers then check the actual
saved text. Only their genuine pass, plus deterministic validation, clears delivery.
After a repair, accuracy checks the whole package; voice resolves its existing
findings and checks the exact changed passages, without reopening untouched prose.
Both accuracy and voice remain mandatory after every repair. Incomplete model
responses fail before review. Slack text is a separate internal digest of the
same evidence and remains available to copy when Slack delivery is disabled.

`AZURE_OPENAI_ENDPOINT_STANDARD` and `AZURE_OPENAI_API_KEY_STANDARD` optionally
route the standard chat slot separately from the main embedding/light endpoint.
Weekly generation and structured editorial calls use the GPT54 endpoint/key
and `AZURE_OPENAI_DEPLOYMENT_SCREEN_READ` bulk deployment. The latter must
support Chat Completions with strict JSON schemas and reasoning effort.

## IMAGINE demo specifications

Open the source Think note, discuss the use case with its Athena side-panel chat,
then choose **Actions > Create demo specification**. This saves current source
edits and prepares a request in that same chat; review it and press **Send**.
Alternatively, ask Athena in a chat to create an IMAGINE demo specification and
identify the source Think note (and any earlier conversation to read).

The dedicated versioned template follows the supplied `demo-use-case.md`, not the
shorter generic use-case/demo brief. Athena reads the full saved note through
knowledge retrieval and uses confirmed chat decisions. The server constructs all
ten sections, every fixed requirement and table row, G0-G7 criteria and the exact
Build instruction. Every editable bullet/cell must have a nonempty answer before
the new specification can be saved. Additional table rows cover further actors,
agents, dependencies, scenarios and source requirements.

Missing facts remain explicit unresolved blockers; proposed technical detail is
not evidence, authorization or human acceptance. The generated note includes its
template version and links to the source note and conversation, inherits the
source project and never overwrites the original. Referenced repository methods
must be read separately or flagged unavailable. This action does not execute the
embedded Build instruction or authorize deployment or other live side effects.

## Athena request interpretation

The active chat path interprets requests through the conversation model, not
keyword-triggered tool selection, forced edits, stock clarification replies or
regex-derived collection/project restrictions. The current request, previous
exchanges and supplied document remain available so the model can interpret
negation, spelling mistakes, corrections and short follow-ups in context.

Core read tools are available immediately. Other permitted capabilities are
listed in a compact catalogue; `load_tools` loads their existing schemas for a
later round without executing them. Availability still depends on actual
read-only mode, the open editor, Design ownership and visible destinations.
Every tool invocation is checked against the schemas supplied for that round.
No new tags, taxonomy, approval queue, backfill or automatic tagging work is
introduced. Existing content tags are unchanged.

Explicit user-imposed source/state/date/project boundaries can be declared as
typed `retrievalScope` arguments when loading tools. The server validates and
enforces these boundaries on subsequent retrieval for the rest of that turn;
readers that cannot enforce them are withheld. Individual queries may narrow
them but cannot broaden them. These are retrieval boundaries, not a change to
write permissions or removal of context already supplied. A new user turn can revise the boundary.
Mentioning a collection is not automatically a restriction to it. The model
must distinguish hard boundaries from intermediate lookup filters.

Keyword/full-text matching remains a useful retrieval signal alongside semantic
search; neither a word match nor a search preview establishes that a source has
been read. Full-document reading budgets follow the structured read request,
not phrases in the chat. Coverage warnings use actual tool results and limits.
Note edits remain Apply/Discard previews and default to formatting-preserving
text replacements; structural proposals require an explicit tool `editMode`.
Pasted meeting lists are imported through the model-selected
`import_meeting_list` tool, which accepts only the actual supplied list, not
invented meeting details. Merely discussing or quoting one no longer triggers
an import before the model sees the request.

## Quick LinkedIn posts from Discover

Discover automatically archives unactioned articles older than 14 days, or
older than 7 days when their current score marks them low-value. Age uses the
stored `published_at` timestamp, not the last indexing time. Saved and parked
articles are exempt; existing blog/published and live-publishing safeguards
remain. Archiving changes the workflow state and records its reason; it does
not delete the article or its body. Archived items are hidden from the normal
Discover review list.

Discover article badges show the live weighted **rank**, the default feed order, not the
original relevance percentage. Rank is relevance weighted by freshness, source
authority, article type and project fit, displayed on a 100-point scale with one
decimal place. Boosts can take it above 100; it is not a percentage. CFP scores
and deadline ordering are unchanged.
Microsoft product-group blogs count as Microsoft official sources: Tech Community
blog articles (Foundry, Entra, Azure boards) and the locale-prefixed microsoft.com
product blogs (Copilot, Copilot Studio, Microsoft 365, Power Platform). Tech
Community forum threads remain Community. Sources include the Microsoft Foundry
Blog, Copilot Studio blog and GitHub Changelog, where model, Copilot runtime and
GitHub Copilot announcements are first published.

Articles can also sort by **Editorial relevance** or **Latest**. Each server
order uses stable ID ties and the same workflow/source/literal-title filters
across pages; badges remain weighted ranks and alternative sorting is labelled.
This is offset pagination of live data, not a frozen snapshot during concurrent
ingestion or scoring.

Discover cards no longer show a rank breakdown or a relevance-feedback form:
the feedback was stored for review only and never changed ranking, so it was
removed (the `discover_feedback` table from migration 066 is no longer written).
The separate **thumbs up/down** controls do affect ranking: explicit votes count
double in the learned source weight, alongside saved and manually archived
articles. A down-vote archives a review/shelved article; clicking the active vote
clears the vote without undoing that archive. Automatic age-based archives do
not count as negative feedback.

The existing 09:00 UK **Morning briefing** in Athena includes a **Discover
roundup** of up to three newly published, to-review articles, using the same
ranking, source diversity and interest/feedback weights as Discover. It covers
the briefing window (normally since the previous briefing, at most four days;
24 hours for a first briefing or same-day regeneration). Future and unknown
publication dates, archived/saved articles and explicitly excluded interests
are omitted. Each entry carries its source link, publication date and a bounded
saved source excerpt, not a new AI interpretation. An empty roundup says so explicitly;
a query failure fails briefing generation rather than claiming no articles.
This adds no model calls, embeddings or scheduled jobs, leaves the publishing
**Content pick** unchanged, and keeps automatic local delivery disabled.

The rank sits in its own heading column beside the source and article title,
so its larger number does not expand the metadata row or push the title down.
Discover uses larger reading type for source metadata, titles, synopses and chips.

Connections reuse the existing shared graph, not a canvas-only relationship model.
Use the existing right-click menu on selected Think note text to **Create Spark**.
The Spark retains the selection and its source-note reference. After saving,
its graph node and source connection are committed together (if the source is
not yet indexed, the existing scheduled sync resolves the connection).
**Send Spark to Canvas** adds a card referencing that Spark; existing Spark items
also expose a **From: <source>** link and a **Map spark** action. Canvas cards can then be
connected to new ideas using the existing connection controls. Sparks remain a
Think subview, not a separate main navigation destination; diagram canvases are
not offered in this card-based mapping flow.
Think shows contextual connections before linked canvases. Notes, Plan tasks,
Discover articles, Library documents, Sparks and indexed GitHub activity can be
related through explicit links, shared concept tags or scheduled AI inference.
Each connection displays its reason; weak or unexplained AI suggestions are not
saved. Inference compares actual note text, task descriptions and article/GitHub
content, with candidates balanced across item types (up to 30 candidates and five
new suggestions per source per run). Connection-only checks run every 15 minutes,
processing up to 25 new/changed items per pass after a two-minute settling delay.
Content-version checkpoints persist across restarts, including no-match results;
failed assessments retry and edits made during a check remain pending. Existing
content is baselined on migration, not bulk reassessed. This job only reads stored
content and updates graph metadata/relationships: it never starts source sync,
search re-indexing or embeddings. The existing source-sync and Foundry backfill
schedules are unchanged. GitHub issues, PRs, reviews, actions, releases
and deployments join the existing commit index on the next regular sync. Notes
and tasks open their specific item; Discover and GitHub connections open the
original source when available. Existing saved relationships are retained.

Article actions (including Copy URL, Canvas, Spark and Connections) remain visible
without hovering; the action row wraps on narrow screens.

**LinkedIn post** on a Discover article or Inbox email opens a short, editable
draft in a popup: a brief summary and, where supported, one enterprise IT
observation (at most 90 generated words). **Copy post + link** preserves blank
lines and appends the original source URL. Email links open the original message
and require mailbox access; they are not public article links. Review email
content for private information before sharing. Successfully copying an article's
post moves it to **Published**, matching **Copy URL**; it does not post to LinkedIn.
Generating/closing drafts, failed clipboard copies and copying Inbox emails do
not change workflow state. Failed workflow updates are shown with a retry option.

**Post to Bluesky** (Discover articles, **Bluesky / X** format) publishes the
edited copy plus the original link directly to Bluesky, with clickable links and
a link card (the article's `og:image` as thumbnail when available). It asks for
confirmation, is limited to Bluesky's 300 characters, moves the article to
**Published**, records the post URL on the article and blocks posting the same
article twice. Inbox emails are never posted. It needs `BLUESKY_APP_PASSWORD`
(a Bluesky app password, never the account password; in production an ACA
secret) and optionally `BLUESKY_IDENTIFIER` (default `richardihogan.bsky.social`).
Without the password the button is hidden and copy-and-paste still works.
Tests: `node --import tsx/esm --test scripts\bluesky.test.ts`.

**Post to LinkedIn** (Discover articles, **LinkedIn** format) publishes the reviewed
copy and original link publicly to your connected **personal profile**, with an
article link attachment. Athena checks the account and names it in the confirmation
before publishing. It enforces a 3,000-character limit including the URL, records
the post link, moves the article to **Published**, and prevents duplicate posts.
LinkedIn and Bluesky have independent publishing records, so an article can be
shared once to each. Inbox emails cannot be posted directly to either service.
Copying remains available without credentials and does not publish to LinkedIn.

Setup uses LinkedIn's supported [OAuth token generator](https://www.linkedin.com/developers/tools/oauth/token-generator):
create a LinkedIn developer app, enable **Share on LinkedIn** and **Sign In with
LinkedIn using OpenID Connect**, and authorise `openid`, `profile` and
`w_member_social` for your own profile. Add the resulting **access token** in
**My Work > Sync Status > Connection tokens and API keys > LinkedIn**. Tokens
are checked against LinkedIn's member endpoint and stored encrypted/write-only
using Athena's existing credential storage. Account verification does not prove
publishing permission; LinkedIn checks `w_member_social` when posting. Alternatively
set backend `LINKEDIN_ACCESS_TOKEN` (an ACA secret reference in production).
Never use your LinkedIn password, paste the token in chat or expose it in frontend
configuration. Tokens expire: renew in the same card; there is no automatic
refresh, in-app OAuth sign-in, company Page posting, feed sync or analytics.

A timeout, server error or unverifiable publish response leaves a protected
**unconfirmed** claim. Athena does not automatically retry or mark the article
Published; check your LinkedIn profile first. If publication succeeds but saving
the result fails, Athena shows the live post link and an explicit recording
warning rather than claiming that the workflow update succeeded.
Targeted tests: from `knowledge-hub-backend`, run
`node --import tsx/esm --test scripts/linkedin.test.ts scripts/linkedin-draft.test.ts scripts/bluesky.test.ts`.

Browser alerts and confirmations use Athena's styled in-app dialogs throughout
the web app, with focus trapping, Escape dismissal and Cancel as the initial
focus for destructive actions.

Regression checks: from `knowledge-hub-backend`, run
`node --import tsx/esm --test scripts\linkedin-draft.test.ts ..\knowledge-hub-web\tests\appDialogs.test.ts`.
The isolated browser fixture needs only Vite on a free port (default 5186);
from `knowledge-hub-web`, set `TODAY_BROWSER_PATH` to an installed Chromium
executable and run `node tests\run-discover-browser.mjs`. It uses mock data,
blocks live API/auth requests and checks desktop layouts, draft/copy failures,
source links and dialog behaviour.

## Athena export to Think

**Export chat to Think** saves one note containing the full latest version of every saved Output, without AI summarisation or a generation-token limit. Separate Outputs remain unchanged. Show Notes packages follow the podcast section order; YouTube plain text and Spotify HTML are preserved in code blocks. Chats without Outputs retain the structured conversation export.

## Capturing Sparks with Athena

Ask Athena to "save that as a spark" or "create a spark: …" to capture a brief thought in **Think > Sparks**, without creating a note or task. Sparks are standalone by default, support optional tag names, and can be attached to a known source when requested. They use the existing Spark clustering pipeline. Athena does not save Sparks unsolicited, and read-only "Ask another model" replies cannot create them.

## Sparks: the idea incubator

**Think > Sparks** works as Capture → Connect → Mature → Ship:

- **Capture** — the composer, the right-click menu, Discover and Athena all save sparks with their source.
- **Connect** — the clustering job groups related sparks into **themes** (three or more). Themes are living: new related sparks join existing themes first, and a theme that grows is flagged *Grew* on the Sparks page and suggested again on Today. Users can also curate by hand: start a theme from any spark ("Add to theme… → New theme…"), move sparks between themes or back to *Loose*, rename themes (double-click the name), merge, dismiss and restore.
- **Mature** — **Develop with Athena** opens the Athena side panel with a prompt containing every spark in the theme and its source. Athena always has the user's themes and loose sparks as page context.
- **Ship** — **Turn into** creates a structured note outline (AI, with a plain-list fallback), a canvas of spark cards, a project, or a blog post (the same draft/review/publish modal as Discover). The theme becomes *Developed*, shows a link to what it became and how many sparks arrived since, and its sparks are marked *Used in…*. Developed themes can be reopened.

Themes are filtered by Growing / Developed / Dismissed; search covers theme names, spark text and source titles. A note's **Connections** side tab lists sparks captured from, or connected to, that note. Today's "Worth exploring" suggests growing themes of three or more sparks; **Create outline note** uses the same graduation as the Sparks page.

## Think canvases

In diagrams, double-click a shape to edit its text; double-click empty canvas
to create a process shape.
Shape Properties also provides left/center/right and top/middle/bottom text
alignment. Alignment is saved with the diagram and used in SVG/PNG exports.
While moving shapes (including a multi-selection), drawing guides show every
matching left/centre/right and top/middle/bottom alignment. Gap indicators show
the distance to nearby shapes in diagram units; purple `=` indicators mark equal
gaps, including a repeated gap alongside two neighbours. The **Snap** menu's
**Grid snap** and **Shape and equal-spacing snap** are independent, saved toggles; shape snapping includes equal
spacing. Grid visibility is separate. Hold **Alt** to temporarily bypass snapping
and guides. Shape/equal-gap targets now take priority over the grid within eight
screen pixels; the nearest target wins on each axis. Distance guidewires sit
outside the shapes with dotted witnesses and end caps. Existing saved Snap
preferences are preserved, and resizing uses the same shape-before-grid priority.

Athena-generated process diagrams use centred rows, consistent 80-unit gaps
between connected columns and 40-unit gaps between branches. Unconnected
components use compact aligned grids (20-unit horizontal / 16-unit vertical gaps).
Feedback/rework loops no longer push the main flow into distant columns.
Existing manual layouts are unchanged by content/style edits; ask Athena to
**rearrange the layout** to explicitly reflow a saved diagram, retaining its
container hierarchy. For a reference-led request, use: "Read [diagram title] as
the layout reference. Use consistent shape sizes, aligned rows and columns,
equal gaps, clear groups and a main reading path; keep feedback routes separate
and put detailed explanations in footnotes." These are layout requirements,
not permission to change the diagram's meaning.

Select a **Text** shape and choose **Properties > Callout type** to mark it as
Question, Risk, Issue, Assumption, Decision or Action. Each has a distinct
outline icon and type label above the text; Plain text removes the classification.
Callouts retain text alignment, size and background controls and are preserved
in saved diagrams, duplication, versions and SVG/PNG/draw.io exports. Athena can
read and find these categories; they do not imply approval or create Plan tasks.
Properties offers connector line and shape border thickness from 0.5 to 6 px.
Shape border colour (including no border) and solid/dashed/dotted styles are
also available in Properties and preserved in SVG/PNG exports.
Properties and diagram Athena chat share the same 380 px side-panel width on desktop;
both move below the drawing on narrow screens.
Shape backgrounds retain neutral, blue, green, amber and transparent, with a named
IBM Carbon subset covering blue, purple, cyan, teal, green, magenta, red, yellow
and orange. Border, connector and text palettes include the corresponding accents.
The dark canvas adapts light fills for contrast; exports retain the saved IBM colours.
Shape and connector descriptions support **Bold** and *Italic* toolbar buttons,
Ctrl+B / Ctrl+I and a live formatted preview. Formatting is stored as plain-text-compatible
Markdown (`**bold**`, `*italic*`), not HTML. Footnotes, presentation descriptions and
SVG/PNG/draw.io note exports retain emphasis; draw.io tooltips use plain text.
The Document shape uses a wavy bottom edge to denote artefacts such as reports,
specifications and deliverables, with the same styling and text controls.
The Arrow shape supports right, left, up and down directions, plus double-headed
horizontal and vertical options under **Properties > Direction**, with
shaft-aligned labels and connector ports, and editable SVG/draw.io exports.
New shape labels default to 16 px, with 18 px container and swimlane headings.
Properties provides a 10-36 px Text size control; existing diagrams retain saved sizes.
Container headers grow with the title's font size and wrapped lines, keeping
the divider below the heading. Text alignment applies within the header.
Hold Space and drag over the canvas to pan (even after using toolbar buttons),
or drag with the middle mouse button. Text fields keep normal space typing.
The Line tool draws standalone lines: select it, then drag on the canvas.
Lines have no arrowheads or shape attachments; drag their endpoints to reshape
them and use Properties for colour, solid/dashed/dotted style and thickness.
Arrowheads scale with connector thickness on the canvas and in exports;
existing diagrams retain their original 1.5 px line weight.

Athena's optional context-file reads are bounded to five seconds. Background
chat deadlines and Stop cover context/tool preparation as well as model
generation; cancelled turns discard late results rather than staying busy.

Athena no longer automatically searches the knowledge base, graph and other
chats on every message. The supplied source, recent conversation, standing
instructions and current saved project remain available; extra sources are
read through tools when the question needs them, including across projects.
The project catalogue lists identities and status rather than every project's
goal, and the legacy project-context blob is no longer layered over current
project records. Unsolicited first-turn task reminders are not injected.
People context matches names in the current request, not eight earlier turns.
Today's date is supplied without the diary; `get_today_schedule` reads meetings
on demand. Saved Outputs contribute an index only; `read_output` reads the
latest version in this chat in 12,000-character pages before discussion or
revision. Source documents, user edits and saved data are not shortened or
deleted by this change. The reply's existing `contextUsed` metadata records
`initialSize` character counts for the assembled system, history, current
turn, tool schemas and Outputs index, not their contents or token estimates.
These counts describe the initial request, not later tool rounds. Diagram
drawing tools (`create_diagram`, `update_diagram`, about 40% of all tool
schema text) and Discover admin tools (adding or changing feeds, moving
articles, the weekly digest) are only offered when the current message, the
last four messages or an open diagram points at them; reading tools are always
offered. Model routing is unchanged.

Think action feedback stays within the editor column rather than overlaying
the side-panel tabs. GitHub metadata groups its publication status, file link
and compact primary/secondary actions.

Athena can read the actual Discover RSS/Atom subscriptions, including disabled
sources and check errors. Feed/source questions load that configuration rather
than unrelated project documents. New feed candidates can be checked read-only
using the existing feed reader; configured URLs are identified as duplicates.

**Push to GitHub** publishes a linked Markdown copy of a Think note. Choose a
writable repository, browse its folders, then edit the full relative `.md` path
and commit message. New folders can be entered directly. Publication uses the
repository's default branch and pins the repository, branch and path for
subsequent updates; the dialog warns when the chosen repository is public.
Only repositories listed in Projects' GitHub repository settings are offered,
deduplicated across projects and checked for write access using the backend's
`GITHUB_ACCESS_TOKEN`. Folder browsing and new publications enforce this same
restriction server-side; repositories merely accessible to the account are
not destinations.
A project's suggested repository is selected only after it appears in the
writable list. Unavailable project repositories are not offered as destinations.
Publishing is disabled while repository folders load or access fails; backend
errors and GitHub quota-reset guidance are displayed rather than only an HTTP code.
New publication filenames default to the readable note title (for example,
`content/notes/imagine-executive-travel-disruption-recovery-spec.md`), not its
document ID. The ID remains inside the Markdown metadata for stable identity.
Title changes and later project configuration changes do not move an existing
publication or break its synchronization. Existing linked paths stay pinned.

Think remains the master note. Writing changes (including Athena edits and
history restores) queue an automatic GitHub update after 30 seconds without
further saves. Pending work survives backend restarts and the regular sync job
retries failures; errors remain visible on the note. GitHub SHA checks prevent
overwriting outside edits. **Review versions** lets you publish the Think
version or accept the reviewed GitHub writing, preserving the previous Think
writing in History. **Check GitHub** checks for outside changes immediately.

The published file is linked from the note, not listed or indexed separately in
Library. Both GitHub document ingestion paths skip linked publications, and
Library/search/context queries suppress any stale copies pending cleanup.
Content-store documents use repository + path as their stable identity;
sync removes deleted files and historical hash-keyed duplicates from database,
vector search and the connections graph. Backend migration
`061_note_github_publications.sql` stores publication state; legacy fake
`githubPath` values do not count as successfully published notes.

Use **Refresh notes** beside the Notes list heading (or in its collapsed rail)
to fetch newly created notes without reloading the page. Search/filter choices,
selection and unsaved open-note writing stay intact; failures preserve the list
and show a retryable message.

Athena chat's **Save to Think** creates a spec note or summary and shows a
completion popup. It does not navigate, open a window or embed Think in chat.

Athena-created drafts, chat exports and saved Outputs use a shared GFM Markdown
parser when creating Think notes. Consecutive headings, nested lists, checkboxes,
tables, quotes, links and inline formatting become native editor blocks; fenced
code stays literal. Raw HTML remains text and unsafe link schemes are not activated.
This fixes new transfers; existing saved notes are not automatically rewritten.

The Design workflow supersedes the former **Create IMAGINE demo brief** shortcut
and its injected Athena skill. Previously saved briefs remain versioned Markdown
Outputs, not implementation code or approval.
Use **Copy** for GHCP or **Download Markdown brief for GHCP** to place the file in
`docs/prds/<demo-id>.md` in the target repository. Download/copy never pushes to
GitHub, runs Build, or authorizes live side effects; `evidence-led-demo` must be
available to the downstream coding agent.

Standard and agentic diagrams use the **Athena Modern Diagrams** finish:
white rounded cards, soft shadows, tinted decisions and groups, a white dotted
sheet, rounded connectors and white branch-label pills. Agentic steps show
locally bundled Carbon role icons and lighter governance chips. Roles and
findings come from existing metadata; ordinary shapes acquire no invented
owners. The editor and SVG/PNG exports share their appearance, including
export previews; exports still offer white or transparent backgrounds.
Recognised default styles are adapted at render time, without migrating saved
documents. Custom colours, shape kinds, positions, connections, text settings,
properties and grid/snap controls remain available. Draw.io retains native
shapes and stored colours. See `DESIGN.md` for the diagram-specific palette.

For process, decision, terminator and document shapes, **Properties → Header**
accepts custom text or Agent/Human/Pipeline presets; **None** removes it.
**Properties → Icon** offers local Carbon icons, **Automatic** or **None**.
Automatic follows a chosen header preset or the existing AI step type.
Headers and icons are presentation-only, remain separate from the Title and
underlying role, and are saved with the diagram and included in SVG/PNG exports.

Select one diagram shape or connector to edit its **Title** and **Description**
in the right-hand **Properties** panel. Title is the visible label (including
image captions); Description is stored with the item, up to 10,000 characters,
but is not printed on the drawing or PNG/SVG exports. Both autosave, participate
in undo/redo and are preserved when duplicating items. Use the Properties button
to hide/show the panel. Multi-selection asks you to select a single item.
Existing diagrams remain compatible and start with empty descriptions.

Use **Athena** in the diagram toolbar to discuss the saved diagram. Athena reads
shape titles/descriptions, artefact kinds, explicit container membership and
connector direction, together with linked-note excerpts. It can search and compare
other saved diagrams in the chat's project (or across projects when no project is
selected), citing diagram links and labels. Standalone lines and visual proximity
are not semantic connections; inferred similarities are distinguished from saved
relationships. This is structured reading, not image analysis of uploaded icons,
and does not enable diagram editing by Athena. Unsaved edits are not included.
Large diagrams and note excerpts are bounded and explicitly marked as incomplete.
Athena's transcript scrolls only when the conversation exceeds the available
height; prompt-pinning space does not create a scrollbar for short conversations.
Diagram footnotes are transparent and borderless, with a subtle dashed horizontal
divider above the Notes heading in the canvas and SVG/PNG/draw.io exports.
The divider matches the diagram content width, not the viewport or notes columns.
Footnotes flow down four notes per
column before starting the next column to the right. Canvas, SVG/PNG and draw.io
exports share this layout.

From a note, **Create diagram** opens a new blank diagram linked to that note;
it does not automatically generate shapes from the note's prose. In a diagram,
**Properties → Linked notes → Link a note** associates an existing note, and
the note's **Connections → Canvases** provides the return link. Linked notes
can be opened or unlinked from the diagram. These are links to the live,
editable diagram, not static image embeds.

**New canvas** offers two separate editors:

- **Brainstorm** preserves the existing network of idea cards and linked Think/Library/Athena content.
- **Diagram** is a visual editor for architecture diagrams and process flows: shapes, text, nested containers/swimlanes, attached straight/right-angle connectors, PNG/SVG icons and compact formatting controls. Diagrams are editable documents, not screenshots. Note-linked diagrams and brainstorms remain separate; the note's brainstorming action still opens a brainstorm.

Paste image data copied from msicons.com, drag an image file onto the diagram, or upload PNG/SVG. Some websites/browsers copy only an image URL rather than image bytes; in that case download the icon and upload it. Imported SVG must be a self-contained, safe image: scripts, external resources and active content are rejected. Icons preserve their aspect ratio.

The **Microsoft icons** picker contains a curated official set from Azure, Power Platform, Fabric and Microsoft 365 architecture symbols. It is bundled locally rather than fetched from third-party sites while drawing. Microsoft 365 symbols are not current product logos. Product marks must not be distorted, recoloured or used as your own branding; sources and permitted-use terms are in `knowledge-hub-web/public/diagram-icons/NOTICE.txt`.

PNG/SVG export includes the full diagram, including objects outside the viewport, and embeds icons. SVG remains scalable; a PNG icon embedded in an SVG remains raster. PNG output is limited to 16,384 pixels per side and 64 megapixels; use SVG for larger drawings. Export fails explicitly if an icon has not loaded rather than silently omitting it.

Diagram checks use the existing TypeScript loader and isolated browser fixture:

```powershell
cd knowledge-hub-web
$loader = ([System.Uri](Resolve-Path '..\knowledge-hub-backend\node_modules\tsx\dist\loader.mjs').Path).AbsoluteUri
node --import $loader --test src\features\diagram\tests\diagramGeometry.test.ts
npx tsc --noEmit -p tests\tsconfig.json
# Start Vite on a free port (the runner defaults to 5142); no backend is required.
$env:TODAY_BROWSER_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests\run-diagram-browser.mjs
```

The diagram fixture blocks live API/auth requests, uses test-only architecture/process data, and verifies full-bounds embedded SVG export and PNG rendering at desktop width only.

Diagram documents and their last 50 saved revisions are stored in PostgreSQL. Saves use optimistic revision checks; a conflicting save reports an error instead of overwriting another session. Dedicated canvas-scoped image rows store PNG/SVG bytes without OCR or new blob containers, credentials or environment variables. Deleting a canvas deletes its diagram and assets. Migration `055_diagram_canvases.sql` runs through the normal startup migration path and preserves existing canvases as Brainstorm.

Limits are 1,000 nodes, 2,000 connectors, 100 bends per connector, 200 uploaded assets per canvas and 5 MiB per asset. Uploaded PNGs are limited to 16,384 pixels per side and 40 million pixels. Run backend validation and revision-conflict checks from `knowledge-hub-backend` with `node --import tsx/esm --test scripts\diagram.test.ts`; these include every bundled icon and reject unsafe SVG uploads.

## Use cases (ideas → specs → build)

A **use case** tracks one idea for one product, from what you found to what shipped:
`candidate → refining → spec ready → handed off → shipped` (or `dropped`). Each one is an
**Imagine demo**, an **Imagine platform** change, or **another product**.

1. **Capture.** Right-click a Discover item, spark or note and choose **Make a use case…**, or use the visible
   actions: **Use case** in Discover's Explore panel, **Turn into → Use case…** on a Spark theme (attaches all its
   sparks), **Make a use case…** in a spark's menu, the **Use case** section of a note's Details panel, and the
   rocket button in a canvas header. The dialog can instead add the item to an open use case. It confirms in place
   with **Open in Plan**, so triage is not interrupted.
2. **Track.** Plan → **Use cases** groups use cases by product. Filter by stage (open by default) and product;
   the Plan project filter applies too. Each row shows stage, sources, project and time since the last update;
   a refining or spec-ready use case with no update for 14 days shows its age in amber, and Today's
   **Continue working** shows a one-line link when any have stalled.
3. **Refine.** In the side panel, **Draft spec** has Athena write a spec note in Think from the sources and the
   project context (the IMAGINE demo brief template for Imagine kinds). Refine it in Think, then **Redraft** if
   needed (after a confirmation; the previous text stays in the note's history).
4. **Hand off.** **Hand off…** either publishes the spec note to GitHub (default path `docs/specs/<slug>.md`, or
   `docs/prds/<slug>.md` for Imagine) and gives a ready-to-paste GitHub Copilot prompt, or creates an Athena
   **Build** spec from it. Publishing needs `GITHUB_ACCESS_TOKEN` and the repo configured in Projects.
5. **Close the loop.** Add PR or issue links, then **Mark shipped** (or **Drop**).

Deep link: `/plan?view=use-cases&useCase=<id>`.

API (`/api/use-cases`): `GET /`, `POST /`, `GET|PATCH|DELETE /:id`, `POST /:id/sources`,
`DELETE /:id/sources/:type/:sourceId`, `POST /:id/links`, `DELETE /:id/links/:linkId`, `POST /:id/draft-spec`,
`POST /:id/handoff` (`{ mode: 'github' | 'build', repo?, path? }`). Migration `081_use_cases.sql` runs on startup.

Tests: from `knowledge-hub-backend`, `node --import tsx/esm --test scripts/use-cases.test.ts`; the frontend
helpers are in `knowledge-hub-web/tests/useCaseView.test.ts` (run with `npm run test:isolated` in `knowledge-hub-web`).

## Build (GitHub cloud coding agents)

**Build** turns a spec into dependency-ordered tasks and runs them on GitHub's cloud-hosted coding agents (Copilot coding agent or Claude), not the local agents in VS Code or the Copilot app.

1. Create a spec on the Build page, or use **Send to Build** on a Think note or a markdown Athena output. Pick the GitHub repo and, optionally, a target branch (defaults to the repo's default branch).
2. **Decompose**: Athena splits the spec into small tasks, each with dependencies, a size (S/M/L) and a suggested agent with a reason. You can change the agent and dependencies before starting.
3. **Start**: each ready task becomes a GitHub issue assigned to its agent (at most *max parallel* at once). The agent opens a PR from its own branch.
4. The runner checks every two minutes; **Check now** runs a pass immediately. It then does the following:
   - Asks the agent (via a PR comment) to fix failing checks or merge conflicts.
   - Squash-merges the PR once checks pass, if auto-merge is on.

   A task waits for you (*awaiting approval*, use **Merge now**) when any of these apply:
   - Auto-merge is off.
   - No CI checks ran.
   - The PR changes `.github/workflows/`.

   A task is marked *blocked* after repeated failed fix requests, or if the PR is closed unmerged; **Retry** puts it back in the loop. Merging a task releases the tasks that depend on it.

Branching: with **Use an integration branch** on (the default), **Start** creates `build/<slug>-<id>` from the target branch and every agent PR targets that branch, so the target branch only changes once. When all tasks are merged, the runner opens one PR from the integration branch into the target. Click **Merge into &lt;target&gt;** (a merge commit), or merge the PR on GitHub; either way the integration branch is then deleted. Repo, target branch and the toggle are locked once the integration branch exists. With the toggle off, agent PRs merge straight into the target branch. Local worktree work (e.g. in the Copilot app) should branch from and PR into the same target as normal.

Setup:

- Enable the agent(s) for the target repo in GitHub (Copilot coding agent and/or the Claude agent). **Start** fails with `BUILD_AGENT_UNAVAILABLE` if a chosen agent isn't assignable.
- Set `GITHUB_AGENT_TOKEN` to a **user** fine-grained PAT with read/write on contents, issues, pull requests and actions for the target repos. It falls back to `GITHUB_ACCESS_TOKEN`. In production, store it as a Container App secret: `az containerapp secret set ... --secrets github-agent-token=<pat>`, then `--set-env-vars GITHUB_AGENT_TOKEN=secretref:github-agent-token`.
- Workflows on agent PRs may need **Approve and run workflows** in GitHub before checks run; until they run, the task stays *awaiting approval*.
- The runner is off in local development so a dev backend never dispatches alongside production; set `BUILD_RUNNER_ENABLED=true` to enable it. Note that the local `.env` points at the production database.
- Migrations `056_build_pipeline.sql` (`build_specs`, `build_tasks`, `build_events`) and `057_build_integration_branch.sql` run on startup.

Tests: from `knowledge-hub-backend`, `node --import tsx/esm --test scripts\build.test.ts`.

## Project dates and saving

Athena reloads the assigned project's saved goal, role, ownership, state,
dates, importance and complete expected outputs on every turn. Current
project fields take precedence over older chat history and memories.
Unassigned chats have a saved-project catalog and `get_project_details`
lookup for named projects.

Projects uses the shared primary-page header, gutters and typography. Search
and filters sit below the header, with a visible result count. Cards show a
short summary; expandable Project details retains the complete goal, context
and expected outputs as readable text, not oversized pills. Desktop uses two
columns and mobile one; editing retains all full-length content.

Chat drafts are saved per conversation in the current browser tab and restored
after refresh. A draft is cleared only once the server accepts its turn;
the new conversation ID is saved before authentication or network requests.
If Microsoft sign-in has expired, the page redirects to sign in as before;
the draft is saved in session storage first and restored on return.

Project dates are returned as `YYYY-MM-DD` calendar dates (or `null`), without
timezone conversion, so editing a dated project preserves its dates. Project
save failures display the backend validation message rather than only an HTTP
status. Regression checks: from `knowledge-hub-backend`, run
`node --import tsx/esm --test scripts/projects.test.ts ../knowledge-hub-web/tests/apiError.test.ts`.

Expected outputs are full text descriptions, one per line, not short labels:
they are not truncated or capped at 30 entries/100 characters. Empty lines are
ignored by the form; the API rejects non-text or blank entries. Overall request
body limits still apply. Goal (2,000 characters), role and ownership (200 each)
have visible limits and pre-save validation that preserves the entered text.

## Today

Today prioritises overdue, blocked, urgent and near-due Plan tasks, failed connections/automation, and open Athena decisions. Recent Think notes, canvases, in-progress tasks and saved Outputs form a separate continuation list; routine activity is grouped rather than shown as a feed. Discover suggestions require a stored relevance explanation, and Spark themes must be growing (not developed or dismissed) with at least three Sparks.

The page initially shows at most five attention items, four continuations, three change summaries and three exploration suggestions. Each desktop column stacks independently, so Worth exploring follows Continue working without a gap caused by the attention list. Mobile keeps the attention, continuation, changes and exploration order. Source failures are local to each section and can be retried independently. Changes cover at least the last 24 hours (or since the last browser visit when older), so reopening Today does not immediately clear the list. They include saved Think notes, Plan updates/completions, Athena Outputs and the latest 100 activity entries ordered by source update time, excluding future events. Outputs and decisions cover the four most recent non-briefing Athena chats, not all historical chats. Today has no standalone Athena prompt box or suggested-prompt strip; use the toolbar instead. Item-specific Ask Athena actions retain their visible context and project handoff, leaving the prompt editable before sending. Capture thoughts through Athena or Think > Sparks; access the full morning briefing through Athena, not the home page.

Today regression checks use the existing backend `tsx` loader and an isolated browser fixture (not production data):

```powershell
cd knowledge-hub-backend
node --import tsx/esm --test ..\knowledge-hub-web\tests\todayViewModel.test.ts
cd ..\knowledge-hub-web
npx tsc --noEmit -p tests\tsconfig.json
# In a separate terminal, after checking that port 5142 is free:
npm run dev -- --port 5142
# In the test terminal:
$env:TODAY_BROWSER_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests\run-today-browser.mjs
```

The browser runner uses a temporary profile, checks desktop layouts at 1440px, and blocks `/api` and `/auth` requests. Only the separate `chat` journey uses a mobile viewport. It does not require a backend or authenticated production session. A blank initial fixture with an aborted source-module transport request may reload once within the bounded mount wait; JavaScript errors and application assertions are never retried. The fixture covers local loading/failure states, refresh, completion, disclosures and the real popout's prompt/context handoff. It also renders the actual Discover and Think pages with test-only data to compare Today's shared header typography, gutters and divider, Discover body typography and Think note-title typography. Today uses the existing left-aligned page frame, not a separate centred container.

## Repository structure

```
Knowledge-Base/
├── knowledge-hub-backend/   # Node.js + Express + TypeScript API server
├── knowledge-hub-web/       # React + TypeScript + Vite web frontend (primary — PC/Mac browser)
├── knowledge-hub-app/       # React Native Android app (Tier 2)
├── knowledge-hub-raycast/   # Raycast extension (Mac capture + session export)
├── CHANGE_LOG.md            # Post-spec decisions and scope changes
└── 2026-04-12-knowledge-hub-spec.md  # Full project spec v4
```

---

## Architecture overview

| Layer | Technology |
|---|---|
| Backend API | Node.js 20 · Express · TypeScript 5.5 |
| Database | PostgreSQL (Azure) — FTS via `tsvector` trigger |
| Blob storage | Azure Blob Storage (`blogcontent` container) — Managed Identity |
| CMS | Azure Blob Storage posts (`posts/<id>.json`) |
| Source syncing | GitLab · GitHub · Microsoft Graph (M365 Calendar + To Do) |
| Podcast | Configurable RSS URL (`PODCAST_RSS_URL` env var) |
| AI | Azure AI Foundry — GPT-4o / GPT-4o mini via REST |
| Auth (app→API) | JWT Bearer tokens |
| Auth (API→sources) | OAuth2 server-side (Graph refresh token · GitLab/GitHub PATs) |
| Mobile | React Native 0.74 · TypeScript |
| Mac companion | Raycast extension — `@raycast/api` |

---

## Quick start

### 1. Prerequisites

- Node.js 20+
- PostgreSQL instance (local or Azure)
- Azure subscription with Blob Storage account
- Azure AI Foundry deployment (GPT-4o + GPT-4o mini)
- Microsoft 365 account (personal) for Graph integration
- GitLab + GitHub personal access tokens

### 2. Web frontend (primary — PC/Mac browser)

```bash
cd knowledge-hub-web
npm install
cp .env.example .env
# In development the Vite proxy forwards /api to the backend (default port 3000).
# Set KH_API_PORT if the backend runs on a different port.
# Set VITE_API_TOKEN if your backend JWT auth is enabled.
npm run dev   # Starts Vite dev server on http://localhost:5173
```

Pages: **Timeline · Search · Notes · AI Chat · Tasks**

### 3. Backend

```bash
cd knowledge-hub-backend
npm install
cp .env.example .env
# Edit .env — fill in all required values
npm run migrate        # Creates tables and FTS trigger
npm run dev            # Starts ts-node-dev on port 3000
```

Key npm scripts:

| Script | Description |
|---|---|
| `npm run dev` | Start with hot reload (`ts-node-dev`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run lint` | ESLint + type check |
| `npm run migrate` | Run `schema.sql` against `DATABASE_URL` |
| `npm run validate:ibm` | IBM M365 calendar device-code validation |

### 3. React Native app (Android)

```bash
cd knowledge-hub-app
npm install
# Set env vars in a .env file or edit src/services/ApiClientContext.tsx
# KNOWLEDGE_HUB_API_URL — backend URL (default: http://10.0.2.2:3000 for Android emulator)
# KNOWLEDGE_HUB_API_TOKEN — JWT token for authentication
npx react-native run-android
```

### 4. Raycast extension (Mac)

```bash
cd knowledge-hub-raycast
npm install
# Set environment variables in your shell profile:
# export KNOWLEDGE_HUB_API_URL=http://localhost:3000
# export KNOWLEDGE_HUB_API_TOKEN=<your-jwt-token>
npm run dev   # Opens Raycast in development mode
```

---

## Environment variables

All required variables are documented in `knowledge-hub-backend/.env.example`.

The backend detects Azure Container Apps via its built-in `CONTAINER_APP_NAME`
variable and trusts exactly one ingress proxy hop for client IP/rate limiting.
Earlier forwarded IP entries remain untrusted; local/direct hosting trusts no
proxy. Stored note images are enriched only for valid UUID image references;
inline data URLs, temporary blob URLs and named external images are not queried
against the UUID-backed image table.

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing/verifying JWT tokens |
| `AZURE_BLOB_ACCOUNT_URL` | CMS/blog storage account URL (Managed Identity auth); not used for Athena files |
| `AZURE_STORAGE_CONNECTION_STRING` | CMS/blog blob authentication; not used for Athena files |
| `ATHENA_STORAGE_ACCOUNT_NAME` | Dedicated Athena storage account for `kb-documents`, `kb-images` and `chat-screens`; production: `khprodr6mgdnys` in Alliance Tenant Reporting |
| `ATHENA_STORAGE_ACCOUNT_KEY` | Dedicated Athena account key; use a Container Apps secret reference. No fallback to CMS credentials |
| `AZURE_OPENAI_ENDPOINT` | Azure AI Foundry endpoint |
| `AZURE_OPENAI_API_KEY` | Azure AI Foundry API key |
| `AZURE_OPENAI_DEPLOYMENT_GPT4O` | GPT-4o deployment name |
| `AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI` | GPT-4o mini deployment name |
| `GRAPH_CLIENT_ID` | Azure AD app client ID |
| `GRAPH_CLIENT_SECRET` | Azure AD app client secret |
| `GRAPH_TENANT_ID` | Azure AD tenant ID |
| `GRAPH_REFRESH_TOKEN` | M365 OAuth2 refresh token |
| `GITLAB_BASE_URL` | GitLab instance URL |
| `GITLAB_TOKEN` | GitLab personal access token |
| `GITLAB_USER_ID` | GitLab user ID |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_USERNAME` | GitHub username |
| `GITHUB_AGENT_TOKEN` | User fine-grained PAT for the Build pipeline (assign cloud agents, merge PRs); falls back to `GITHUB_ACCESS_TOKEN`. Secret — use `secretref:` |
| `BUILD_RUNNER_ENABLED` | `true` to run the Build runner in development (always on in production) |
| `PODCAST_RSS_URL` | Podcast RSS feed URL |
| `CMS_BLOB_CONTAINER` | Blob container name (default: `blogcontent`) |
| `CMS_POSTS_PREFIX` | Blob path prefix (default: `posts/`) |

Athena files must never reuse the CMS account credentials. The storage cutover
utility is `knowledge-hub-backend/scripts/migrate-athena-storage.mjs`, run with
`node --import tsx/esm` from the backend directory. It requires explicitly supplied
`SOURCE_ATHENA_STORAGE_ACCOUNT`, `SOURCE_ATHENA_STORAGE_KEY`,
`DESTINATION_ATHENA_STORAGE_ACCOUNT`, `DESTINATION_ATHENA_STORAGE_KEY` and
`DATABASE_URL` in the process environment, plus the existing Foundry Search
endpoint/admin key when updating citations. Run `inventory`, then `copy`; deploy
the dedicated Athena configuration, then run `rewrite` (which also copies and
verifies any final writes) and `verify`. Copies are SHA-256 verified and existing destination
blobs are never overwritten. Database replacements are restricted to verified
Athena-container URLs in reviewed Athena tables; blog paths and CMS records
are excluded. No source files are deleted and no source keys are rotated.
Keep credentials and signed URLs out of logs and migration artifacts.
An optional `ATHENA_MIGRATION_PROOF` path stores only blob identities, SHA-256
hashes and source/destination ETags, so interrupted verification can resume.
Cached hashes are reused only while both blob versions remain unchanged.

---

## Deployment (production)

Production is **manual** — there is no CI/CD pipeline. Deploys are run from a local
shell with the Azure CLI. The Azure MCP tools must not be used for this; they hang.

### Resources

| Purpose | Resource | Resource group |
|---|---|---|
| Backend container app | `kh-prod-api-vnet` | `rg-knowledge-hub-prod` |
| Container registry | `cad79107555facr` (image `kh-prod-api`) | `rg-knowledge-hub-prod` |
| Frontend static web app | `kh-prod-web` | `rg-knowledge-hub-prod` |

Subscription: **Alliance Tenant Reporting**.
Live site: <https://athena.themicrosoftcloudblog.com>
(the underlying Static Web Apps hostname `nice-mud-0f780fb03.7.azurestaticapps.net`
also still resolves).

### Before deploying anything

```bash
cd knowledge-hub-web     && npx tsc --noEmit
cd knowledge-hub-backend && npx tsc --noEmit
```

Both must be clean. Then commit and push the branch you intend to deploy — the
backend image is built from GitHub, not from your working tree, so uncommitted
changes are silently ignored.

### Backend

```bash
az account set --subscription "Alliance Tenant Reporting"

# 1. Find the tag currently deployed and pick the next one.
az containerapp show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --query "properties.template.containers[0].image" -o tsv

# 2. Build the image from the pushed branch (note the #branch:subdir syntax).
az acr build --registry cad79107555facr --image kh-prod-api:v<NN> \
  --file Dockerfile \
  "https://github.com/richardichogan/knowledge-base.git#<branch>:knowledge-hub-backend"

# 3. Roll the container app onto it.
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --image cad79107555facr.azurecr.io/kh-prod-api:v<NN>

# 4. Verify — do not consider the deploy done until the new revision is Healthy.
az containerapp revision list --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --query "[?properties.active].{name:name,health:properties.healthState,running:properties.runningState,image:properties.template.containers[0].image}" \
  -o table
```

The new revision takes a minute or two to go from `Activating` to
`Healthy` / `RunningAtMaxScale`. If it fails to start, read the logs rather than
guessing:

```bash
az containerapp logs show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --tail 50
```

### Frontend

```bash
cd knowledge-hub-web
npm run build   # loads .env.production — bakes in VITE_API_URL and the password gate

$token = az staticwebapp secrets list --name kh-prod-web \
  --resource-group rg-knowledge-hub-prod --query "properties.apiKey" -o tsv

npx --yes @azure/static-web-apps-cli deploy ./dist --deployment-token $token --env production
```

### Environment variables and secrets

Non-secret settings are plain env vars:

```bash
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --set-env-vars SOME_VAR=value
```

Secrets must go through the secret store and be referenced indirectly — never as a
literal env var value:

```bash
az containerapp secret set --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --secrets my-key=<value>
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --set-env-vars MY_KEY=secretref:my-key
```

### Custom domains and CORS

`CORS_ORIGIN` on the backend is a **comma-separated allow-list** of front-end
origins. Adding or changing a front-end domain requires updating it, otherwise the
site loads but every API call is blocked by the browser and the app appears empty:

```bash
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --set-env-vars "CORS_ORIGIN=https://athena.themicrosoftcloudblog.com,https://nice-mud-0f780fb03.7.azurestaticapps.net"
```

A new front-end domain does **not** require a frontend rebuild — `VITE_API_URL`
points at the backend, not at the site's own hostname.

---

## Pre-build validation

Before running in production, validate IBM calendar connectivity:

```bash
cd knowledge-hub-backend
npm run validate:ibm
```

This uses the Microsoft Azure CLI public client and device code flow — no secrets needed. Follow the on-screen instructions. The script will report one of:

- **SUCCESS** — IBM M365 calendar readable; proceed with integration
- **PARTIAL** — Some events visible; contact IT about Calendars.Read scope
- **CONDITIONAL ACCESS BLOCK** — IT policy prevents access; IBM calendar will be excluded from sync

---

## Tier 1 sources (synced automatically every 15–60 min)

| Source | Cadence |
|---|---|
| CMS blog posts (Azure Blob) | 15 min |
| GitLab commits | 30 min |
| GitLab merge requests | 30 min |
| GitLab issues | 30 min |
| GitLab pipelines | 30 min |
| GitHub commits | 30 min |
| GitHub pull requests | 30 min |
| GitHub issues | 30 min |
| M365 Calendar (personal) | 15 min |
| M365 To Do | 15 min |

---

## AI write actions (require confirmation)

All write actions follow a **propose → confirm → execute** flow. The AI will never modify data without explicit user confirmation.

Supported actions:

| Type | Description |
|---|---|
| `cms-update-social-push` | Mark a blog post's social push status |
| `todo-create-task` | Create a task in Microsoft To Do |
| `todo-update-task` | Update an existing To Do task |
| `github-create-issue` | Create a GitHub issue |
| `blob-save-markdown` | Save a markdown file to blob storage |

---

## Project conventions

- No file over 200 lines (single responsibility)
- No magic strings or numbers — all in `src/config/constants.ts`
- No credentials hardcoded — all via environment variables
- `exactOptionalPropertyTypes: true` — use `...(x !== undefined && { key: x })` spread pattern
- All write actions gated by `proposeWriteAction` → `confirmWriteAction`
- `content/posts/index.json` must **never** be written

---

## Roadmap

See the full project spec: `2026-04-12-knowledge-hub-spec.md`

**v0.1 (current):** Tier 1 backend, Android app, Raycast extension  
**v0.2:** IBM calendar integration (pending IT validation), CMS publish action, podcast sync  
**v0.3:** Social post drafting, LinkedIn/Twitter integration, Spotify podcast  
