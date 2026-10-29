# Athena: product spec

This is the current product spec for Athena. It supersedes `2026-04-12-knowledge-hub-spec.md`.

- For feature-by-feature detail of what is built, see `README.md`.
- For engineering rules, see `constitution.md`.
- For the backlog, see `docs/planned-features.md`.

## 1. What Athena is

Athena is Richard's personal, single-user **work and knowledge hub**, and the AI assistant (also called Athena) inside it. It is not a content pipeline. Publishing is one small use among many.

It is one place to:

- **See** what needs attention across his work: tasks, calendar, email, GitHub, GitLab, Microsoft 365 and other connected systems (Today, Activity);
- **Read** and monitor the outside world: Microsoft and industry articles, YouTube channels and videos, calls for papers, and named competitors (Discover, Watchlists, Sources);
- **Think**: notes, Sparks (ideas), diagrams and a knowledge graph, with an AI that knows his projects, people and memory (Think, Graph, Memory);
- **Plan and govern**: tasks, projects, people, registers of risks and issues, and review packets (Plan, Projects, People);
- **Turn ideas into specs and build them** via GitHub Copilot or cloud coding agents (Use cases, Build);
- **Produce and share** when he chooses: podcast prep, blog and LinkedIn posts, Bluesky posts, diagram exports to Mural and draw.io, notes published to GitHub, and manual emails (Share);
- **Present**: a voice-paced teleprompter (Autocue).

Athena does most of the writing. Richard mostly prompts, decides and reviews; he does not usually draft by hand.

Athena knows her role from first-party application instructions, not from searching historical notes: Richard's thinking partner and working assistant, not GitHub Copilot or a generic document summariser. Her viewpoint favours useful outcomes, sound reasoning, evidence, simple workable designs and testable behaviour. She can offer a reasoned opinion without pretending it is a sourced fact or claiming human experience.

Each chat turn supplies an authoritative capability snapshot derived from its filtered tools, read-only restrictions, note/canvas preview availability, Outputs visibility and user-selected local folders. Athena explains practical outcomes and limits from that context; she does not need old PRs to establish her name or capabilities. A capability description is not proof an integration is healthy, a record has been read or an action has succeeded.

The current conversation determines what "this" refers to. An open transcript is reference material, not automatic permission to critique or rewrite it. Identity questions do not force knowledge retrieval, and a tentative "we need to fix this, what do you think?" does not force an edit to the visible note. Explicit note-edit requests still use the existing preview workflow.

Open-ended work is conversational, not output-first. Athena actively explores Richard's goals, reasoning, priorities and trade-offs through focused questions and constructive challenge. An exploratory exchange starts with a brief observation or challenge and one substantive question, then develops through his answers before settling on a recommendation. One question at a time does not mean only one per conversation. She uses known or retrievable facts rather than asking Richard to repeat them, but those facts do not replace understanding his choices. Clear factual questions, agreed unambiguous actions and explicit requests for an immediate draft still receive a direct response.

Across personas, Athena pushes back on unsupported premises, conflicting requirements and approaches that will not achieve the stated goal. She explains the concern and asks the question needed to resolve it, rather than producing a confident answer on an unresolved premise or agreeing to keep things moving.

The current intent determines the working mode, not the topic or selected persona: "help me design a demo" invites dialogue; "generate the specification from what we agreed" calls for action without reopening decisions. Clear standalone action requests do not require prior discussion. Athena switches modes as the conversation develops.

An ambiguous "what do you think?" about the document in view first gets a short choice between a concept reaction and a full specification review. That scope question is returned without a model call, reading the document, or invoking tools. The chosen depth is used on subsequent turns rather than asked again; a different document does not blindly inherit it. Quick concept reactions stay about the idea; full reviews remain detailed and retain recursive reading for sources larger than the inline context.

Pure exploratory turns and answers to their questions use the supplied conversation without retrieval or action tools, unless the request also asks for evidence or an action. Searching every source before asking about intent is not required. Blog, demo and show-notes formats govern requested deliverables, not all dialogue within those personas. Saved liked replies are optional references for explicit outputs, not templates for conversational length or structure. Migration 098 replaces only the exact active legacy profile instruction demanding output before questions; personal facts, independently edited preferences, examples and history are preserved.

The turn-level dialogue contract is applied after legacy profile preferences and conversation history so older output-first instructions do not undo it. High-confidence exploratory exchanges and corrections are buffered before publication; an overlong reply or self-answered question receives at most one tool-free pacing repair within the existing turn budget. Actions are never replayed by that repair. Deterministic and opt-in synthetic multi-turn model evaluations cover consequential questions, using the answer, direct delivery, corrections and contextual humour; their heuristic checks are not a guarantee of conversational judgement.

Full-document reading keeps strict checkpoint and quotation validation. A failed source gets only its bounded same-page retry, not a fresh set of reading-model attempts on every tool round or through an indexed alias. Committed checkpoints remain resumable on a later turn, and rejected pages never count as read. Validation errors identify the offending field or length without logging source text.

Her personality is curious, candid, warm and understated. She recognises playful sarcasm and can reciprocate with dry wit, while taking frustration seriously, particularly when she caused it. Humour is contextual, not mandatory; it must not trivialise a concern or turn sarcasm into permission to act.

Note reviews include native table cells and nested text, preserving row and cell boundaries in both the current-note chat context and backend note rendering. Proposed edits are not saved changes: Apply/Discard remains explicit. Invalid edit batches are rejected rather than silently proposing only the valid subset. If time runs out after proposals are produced, Athena reports the available preview and unfinished verification instead of telling Richard to repeat the request.

The learning loop reuses Memory's approval-based suggestions. Weekly review pairs each user correction with its preceding assistant reply, records the source conversation and verifies the supporting user quote. It can propose collaboration and verification preferences as well as style preferences; it must not treat assistant assertions as user instructions, generalise one-off prototype permissions or turn software defects into user workarounds. Suggestions remain inactive until approved. Deterministic defects belong in fixes and regression tests, not learned excuses.

It runs as a desktop web app at athena.themicrosoftcloudblog.com, with the Athena Desktop (Electron) wrapper, which also captures local M365 reports. The standalone `/chat` page is the only screen designed for mobile. A Raycast extension and an Android app (`knowledge-hub-raycast`, `knowledge-hub-app`) are secondary clients.

### Retrieval meanings and boundaries

The operational vocabulary reuses the knowledge-family/source manifest and complements the typed semantic relationships; it is not a second graph or a copy of the database schema in the prompt. Discover articles, feed subscriptions and Watchlist runs are different collections. Think notes, Library documents, saved chats, live tasks, recorded decisions, diagrams and connected activity have distinct entry points. Explicit collection requests take priority over generic retrieval and current-project reference URLs.

Indexed searches apply source, Discover workflow state and time constraints before candidate limits, including exact matches and live hydration of semantic hits. Collection browsing does not require invented topic keywords. Discover defaults to `to-review`; saved, blog, published, archived, shelved and parked material require the corresponding scope. Cross-collection comparisons can explicitly include more than one indexed family. Strict project scope and source exclusions remain enforced; no-result searches never silently widen the user's collection or dates. Search/browse results are bounded samples, not exhaustive counts or the precise UI feed order.

“Interesting” does not imply recent. “New/latest” indexed requests without dates use a disclosed trailing seven-day window. Relative calendar periods use Europe/London, including DST; explicit ISO ranges include start and exclude end. Publication/creation, source activity, first discovery and last indexing are not interchangeable. New ingestion records whether publication time was supplied by the source; a fallback time is not proof of fresh news. Legacy publication provenance remains unknown where it was not captured.

Short retries and date refinements retain the latest relevant user request's collection, not an assistant's mistaken search topic or the title of an open note. Explicit subject changes replace it. This is a bounded vocabulary resolver, not a claim of arbitrary natural-language understanding: the runtime exposes applied filters, unavailable coverage and collection definitions rather than silently guessing complete coverage.

Full document, specification and newsletter reviews use a read-checkpoint-continue pipeline rather than a whole-document character or page cap. Each bounded page is processed into private task-scoped working memory; its summary, verified excerpts, version and continuation are committed atomically before advancing. All checkpoint summaries are subsequently combined hierarchically, with bounded inputs at each level. This is derived memory, not a claim that the final chat context contains every original character or that summarisation is lossless. Exact source passages remain rereadable by offset, and checkpoint summaries can be recalled through the same source reader using the review ID and memory offset.

Reading checkpoints are private to the chat, review objective, source and scope, separated between development and production; they are not user-profile memories or edits to the source. An interrupted read can resume its last committed page using `resumeReading`; source-version changes invalidate prior checkpoints. Exclusions and access scope are revalidated on every page and before using cached memory. Provider failures and cancellation never advance an unfinished page. Background turns use progress-aware inactivity deadlines so active checkpointed reading is not cut off by the ordinary turn duration. Stored-source coverage and import/extraction completeness remain separate. Supporting retrieval and ordinary manually paged reads retain bounded budgets.

Health exposes conversation retrieval signals as well as provider usage: measured scope, prevented cross-collection attempts, inherited scope, possible deferred retries, temporal/default-window use, unread search hits, unverified quotes, budget exhaustion and tool errors. Deferred retries are heuristic review flags, not proven failures. Audit storage contains categories/counts only, never prompts or source text. Legacy rows without scope/environment attribution stay separate and unmeasured. No-retrieval can be correct for conversation, provider success is not task success, and these signals are not an accuracy score. Health's selected dates are UTC and environment/persona/feature filters apply; deployment-attributed turn quality is explicitly unavailable.

Workflow health separately records new specialist attempts, direct Design operations and claimed scheduled jobs. Model calls inherit a workflow ID, stage and explicit purpose through async-local context; diagnostic callers must explicitly choose diagnostic purpose, not rely on worker-name guesses. No prompts or document text enter this telemetry. Blog checks distinguish completed operations from review-blocked/ready drafts and successful blog delivery. Elapsed run time and summed model-call time are different measures. Earlier calls/jobs are not retroactively attributed; running records can represent work interrupted by process failure. Workflow cohorts use start time; call aggregates follow the usage date/environment/model filters. Review/delivery counts overlap completed runs and do not prove user acceptance.

Source sync retains up to 20 safe failure categories, targets and corrective actions per source, with an explicit total error count. Raw provider response bodies are not shown in Health. These latest shared-source runs do not follow usage filters; older records retain counts only. Project Markdown ingestion decodes strict UTF-8 or BOM-tagged UTF-16LE/BE and rejects invalid text/NULs rather than discarding bytes. Graph sign-in requests Mail.Read.Shared for the podcast shared mailbox; existing sign-ins retain their granted scopes during refresh, and need renewed consent plus mailbox read permission. Expired ICA consulting keys and GitHub repository access require credential/access correction, not silent source removal.

## 2. Primary use cases

In priority order:

1. **Ideas to product specs and Imagine demos.**
   - Spot an idea in Discover, a Spark, a note or a diagram.
   - Shape it into a spec for a product: an Imagine demo, the Imagine demo platform, or another IBM or personal product.
   - Hand it to GitHub Copilot to build. That is usually an interactive GitHub Copilot session; Athena Build is the option for clear, separable work.
   - See section 6.
2. **Podcast topic organisation.** Each Thursday Athena prepares a ranked topic brief for the Friday recording, threaded to earlier episodes. Richard reshapes it in conversation, and the show notes persona writes the notes. Episode-coverage summaries recover from an output-token limit by retrying only the failed chunk once at 3,000 tokens, then splitting that chunk into two if needed. Each half has the same bounded retry, with no further splitting; successful chunks are not rerun, no source text is omitted, and truncated model responses are not accepted. Summaries use the podcast-specific request timeout, not the generic lightweight-call timeout. The overall eight-minute deadline and Thursday schedule are unchanged; a terminal failure cancels outstanding requests. Tracking topics over time matters here and in competitive monitoring (use case 5); nowhere else.
3. **Content.** Once Richard picks a topic (often a Discover item), Athena writes the blog or LinkedIn post for his review. Blog drafting is explicitly started as a Quick take or Article and runs as a background specialist job with a completion notification. The saved blog draft receives passage-level factual/style checks and a separate whole-piece editorial review: a reasoned argument, practical application, clear attribution, documented product boundaries and natural voice. Publication blocks only for identified major reputational risks or an incomplete review. Major risks are material factual falsehoods, fabricated experience/quotations/attribution, confidential or identifying disclosures, and seriously misleading regulated or safety-related advice. The final review assesses the current article and all outstanding passage concerns against evidence; each blocker identifies the exact passage and concrete harm. Style, repetition, polish, weak argument, omissions, minor inaccuracies and citation/naming discrepancies remain visible advisory warnings, not blockers. A merely unverified claim does not itself prove a major risk. Where the source leaves a relevant product-capability gap, the job uses at most two official-documentation searches and two successfully read documents (at most four page-read attempts); search snippets are never factual evidence. Failed research or malformed/incomplete review responses still prevent sending. A passage kept without changes must have no defect findings: supporting commentary triggers a bounded response-correction retry, not an unresolved article issue. Completed passage reviews with substantive findings count as reviewed; missing or failed assessments do not. Rechecking user edits repeats research against the current draft and is read-only. Source links retain the source title; feed publication dates are labelled as such, and unknown dates are not invented. Existing drafts must pass the current reputational-risk review for their exact content before sending. CMS-required fields, taxonomy and delivery data contracts still apply; article/quick-take publication does not reject writing patterns or silently normalise reviewed punctuation. Quick-take length/layout targets are editorial guidance. This is validation of a user-requested draft, not an autonomous content-planning pipeline.
   Blog jobs retrieve a bounded set of relevant published posts, active profile/preferences and the user's own saved chat statements. A separate extraction and privacy/provenance check produces up to five anonymised author insights before the writer sees them. Only individually approved insights reach the writer; rejected insights are withheld and their count recorded. If none pass, drafting stops. Incomplete privacy assessments also stop drafting. The writer receives no raw private records or internal provenance references. Client names, employers, dates, locations, figures and identifying combinations must be removed; a recorded position or incident must not be inferred from a question or pasted third-party review. Background supports a proposed first-person recommendation, never invented past experience. Relevant Financial Services examples should distinguish preferences from authoritative KYC/eligibility facts without presenting memory as a suitability assessment. Private author context is excluded from external research planning. The editorial gate requires an explicit practitioner position and clear first-person attribution of proposed scenario controls and ownership.

   Editorial quotations may match the original HTML or its rendered text, with entities decoded and whitespace normalised. Descriptive links using the exact documentation URL in `href` cite their attributed paragraph; bare URLs and per-sentence repeated links are not required. A footer labelled "feed publication date" discloses feed provenance. Invalid review responses receive one bounded retry with diagnostic feedback, and failed responses are recorded without changing the draft.

   Source-footer titles and URLs are compared directly with saved source evidence, with HTML entities decoded, rather than judged by the editorial model. Differences are advisory unless the final review identifies material misattribution or another major risk. Awkward source punctuation and site suffixes are preserved. Product-naming findings must identify the exact disputed wording in its actual article passage and supply an exact supporting quotation and URL from the retrieved documentation. A platform label or unambiguous shorthand is not automatically an obsolete service name. Contradictory footer findings, unrelated quotations and invented documentation evidence trigger the bounded response-correction retry; repeated invalid findings leave the review incomplete and block sending rather than becoming article defects or a silent pass.

   Authorial voice does not require repeated "I would" openings: an explicitly attributed position can carry several following sentences. Writer and editor check concrete repetition, unexplained operational jargon and dangling transitions without imposing a phrase-count quota. Banking scenarios use communication preferences, not chat-stated risk appetite, as examples of bounded conversational memory; authoritative assessments remain separate. Preview-dependent production proposals explain the release decision and applicable terms, or state which terms still need verification. Research uses the existing bounds to seek relevant production-use, support/SLA and change conditions; preview status alone does not establish restrictions. Documentation access dates reflect supplied retrieval timestamps and are not represented as personal human verification.

   The blog review dialog foregrounds the title, post type and existing rich-text/HTML editor. Secondary metadata is collapsed under Post details; advisory suggestions and review history are separately collapsed with counts. Major blockers and category-loading/validation errors remain visible. Successful publication or saving to the blog replaces the editor with one success message and the existing post/admin links. Dismissing that message closes the whole publishing flow and returns to the underlying screen, without another completion popup.
4. **Programme governance and communications** (parked).
   - The intent is for Athena to coach the areas Richard finds hardest: governance discipline (owners, dates, reviews, escalation, steering readiness) and communications (drafts written for the reader, difficult messages, reviewing his own drafts).
   - Athena helps; it does not run the programme.
   - No work is planned until this is picked up again.
5. **Competitive and market monitoring** (built; owner review ongoing).
   - Discover **Watchlists** track named organisations and products against one explicit question, a versioned comparison baseline and comparison criteria.
   - Athena records dated, evidence-backed changes and explains what they mean for the comparison. "No meaningful change" is a valid result.
   - It earns its place only if it changes a decision, exposes a weak assumption, or saves meaningful research time.
   - Spec: `docs/specs/competitor-watchlists.md`.

6. **Staying on top of work.** Today, Activity and Plan give one view of what is overdue, blocked, due, failing or waiting for a decision, across all connected systems.
7. **Remembering people and context.** People holds contacts; Memory and project context let Athena answer with the right background without re-explaining.

## 3. Areas

| Area | Role |
|---|---|
| **Today** (`/`) | What needs attention now: overdue, blocked or due tasks; failed connections; open Athena decisions; continue-working items; recent changes; and suggestions worth exploring (Discover picks with a reason, growing Spark themes). Also shows the Thursday podcast prep. |
| **Discover** (`/discover`) | A ranked feed of articles from Microsoft and industry sources, weighted by relevance, freshness, authority and project fit, with calls for papers (CFPs), saved views and interest weights. **Sources** manages RSS/Atom feeds and **YouTube** channels, and imports single videos with a public-caption attempt; missing captions leave description-only evidence and separately attributed related background links. **Watchlists** monitor named competitors against a question and versioned baseline. **Parking lot** keeps items for a future newsletter or podcast. Items can be saved, turned into Sparks or use cases, or turned into quick LinkedIn, Bluesky and blog posts. |
| **Plan** (`/plan`) | Tasks in Board and Focus views, with saved views, Athena check-ins and at-risk prompts. Open use cases appear in the Board's Backlog or In Progress columns without creating duplicate task records. |
| **Think** (`/think`) | Notes (BlockNote editor with history, recovery, tags, `@` mentions of people, projects and documents, and GitHub publishing), **Sparks** (capture, connect into themes, mature, ship) and **canvases** (diagrams with drilldowns and links to notes, exportable to draw.io and Mural). |
| **Build** (`/build`) | Specs are split into dependency-ordered tasks and dispatched to GitHub cloud coding agents (Copilot or Claude) as issues. Their PRs are tracked and merged. |
| **Athena chat** | Available everywhere: a side panel, a floating widget and `/chat`. It has personas: general, brainstorming, blog post, LinkedIn, demo designer, web designer, podcast prep, podcast show notes and Copilot coach. Chats record decisions and Outputs, and can be turned into a spec note. |
| **Activity** (`/my-work`) | Activity from connected systems (M365 calendar, mail and To Do, GitHub, GitLab, the blog CMS, IBM and Alliance sources), plus connections, tokens and sync status. Also holds the Mural and SMTP2GO integration settings. |
| **Sources** (`/library`) | Indexed documents and source material, searchable and used for grounding. |
| **Knowledge graph** (`/graph`) | A simple force-directed 2D graph and an accessible relationship list, without a 3D option. Search, focus and inspect recorded or explicitly labelled inferred connections; start from a note's Connections-panel mini graph. |
| **Memory** (`/memory`) | What Athena remembers about Richard and his work. |
| **People** (`/people`) | Contacts with email aliases, organisation, role and topics. Import contact reports from Markdown; mention people with `@` in notes and chat. |
| **Autocue** (`/autocue`) | A full-screen teleprompter for note scripts, paced by the speaker's voice or a gamepad. Runs outside the normal app shell. |
| **Projects** (`/projects`) | Project goal, role, dates, expected outputs, and the project **cockpit**, which holds the register of questions, risks and issues, and review packets. |
| **Share** | Manual, review-before-send emails through SMTP2GO (Mural links, draw.io attachments, GitHub note links), Mural export, GitHub note publishing and Bluesky/LinkedIn personal-profile posting from Discover articles. Automatic publishing is permitted only through an explicitly enabled Jobs workflow with automatic delivery selected. |
| **Management** | Tag Manager, repo-to-tag and repo-to-project mappings, Knowledge health (AI usage, sync runs, index freshness), practice-exam score history, and voice transcription and speech. |

Old routes (`/tasks`, `/calendar`, `/notes`, `/documents`, `/timeline`, `/search`, `/ai`, `/blog-post`) redirect to the areas above.

Configuration opens in centred, scrollable modals: Memory, Connections and sync,
Tag Manager, and repository tag/project mappings. Opening these from Tools or
the command palette preserves the current workspace; Done, close or Escape
returns to it. Existing settings URLs remain valid, including browser Back.
People, Companies, Activity, Sources, Knowledge graph, project cockpits and
Knowledge health remain full-page workspaces.

### Jobs and scheduled prompts

**Tools → Jobs** (`/jobs`) opens a workspace-preserving modal for schedules,
prompts, desktop imports, publishing approvals and audit history. Compact
schedule rows show timing, status and the next run; secondary actions expand
on demand. Runs/approvals and audit have separate views with shared filters.
Configuration and run review use focused dialogs. Direct links, including run
links, open the same modal. Athena can design and manage saved jobs from any chat surface;
the Jobs screen is not a required setup wizard. Chat proposals display the exact
configuration and require a user confirmation card before they change a schedule
or enable publishing. Discussing a possible job does not enable one.

Schedules have an explicit IANA timezone, selected days (workdays, full week or
weekly days), and one or more local times. Content sync starts with **06:00 and
13:00 Europe/London**, seven days a week. The former startup/08:00/14:00/20:00
triggers are removed. Weekly Microsoft updates retains Monday 08:00 and its
previous-full-Monday-to-Sunday evidence window, Think note, pinned chat and Slack
summary. Its new blog → Bluesky/LinkedIn delivery chain initially requires
approval. Both social destinations use the confirmed public blog URL.

Jobs can run a saved grounded Athena prompt, ingest Daily Insights, save a Think
result or a Markdown file, and deliver through the existing publishing adapters.
Outputs, prompts and schedules are versioned. Preview generates review artifacts
but never publishes, imports data or writes production output files. Approval
applies to the saved version and exact outgoing artifacts; editing a job
invalidates pending runs/approvals. Automatic delivery is an explicit per-job
permission, not a default model decision.

Daily Insights ingestion reads `Daily-Briefing-YYYY-MM-DD.md` from a folder already
authorised on a registered Athena Desktop device. It schedules **ingestion**, not
M365 Copilot's generation of that file. While the desktop is closed, local jobs
wait; on reconnect only the latest eligible occurrence catches up. If its dated
file is late, ingestion waits until the next scheduled occurrence, then records
the old one as missed. Library file indexing continues separately. The initial
Daily Insights job is a paused draft until its device, folder and desired
schedule are confirmed; existing legacy capture continues until this transition.
Markdown output files use `athena-<run-id>.md` and never overwrite user edits.

Run history records per-step outcomes, source evidence, artifacts, publishing
links and errors; the audit log records configuration changes, actors, approvals,
retries and missed occurrences. Successful delivery steps are retained on retry.
An uncertain blog/social response is **unconfirmed**, not automatically retried:
check the destination and reconcile its public URL or explicitly confirm that
nothing was delivered. Pausing prevents new dispatch and later delivery steps;
it cannot retract an external request already in flight. Archived jobs retain
their history. Internal indexing, tagging, health and other maintenance timers
remain separate and are not editable here.

### Athena chat motion

Chat uses the supplied [Athena Ribbon](specs/athena-ribbon.md) Canvas renderer: a glowing, twisted cyan ribbon inside a glass sphere, with all nine supplied moods and the original 380ms parameter easing. Its host background is transparent. The welcome character is 240px with pointer tracking; assistant-message characters and the single travelling character stay 56px. Only the latest message animates; older messages use settled `still` poses. The travelling character moves from above the composer to the working slot, then the accepted answer's corner and back without resizing; there is no duplicate header avatar. The existing 1.5-second answer entrance/return plays once for the accepted reply, never provisional text from tool rounds or evidence repairs. Progress stays visible until completion, including when asking another model.

The latest accepted reply's follow-up suggestions appear one at a time beside the resting character, not as large pills below the answer. If a reply has no follow-ups, including restored history, local note/document prompts or conversation starters keep the helper useful. The empty-chat starter prompts also live here rather than in a second set of pills. Suggestions rotate every seven seconds without playback or next controls; rotation pauses on hover, keyboard focus and hidden/offscreen panels. Reduced motion keeps the first suggestion static. Hover underlines the suggestion without changing its background. Selecting a suggestion fills and focuses the composer without submitting it. Suggestions hide while a draft is present or Athena is working, recording, transcribing or restoring history. No extra model calls generate or rotate these suggestions.

All chat surfaces share one mood controller: typing/mic input listens, pending work thinks, and accepted answers answer for 1500ms. Explicit errors show `sorry` alongside the existing error text; successful positive feedback/thanks shows `happy`; completed tasks/actions or saved outputs show `excited`; suggestions show `curious`; evidence warnings or the explicit format-clarification prompt show `unsure`. Emotions last 2500ms and never override a new active turn. No model confidence is guessed from prose or added to the backend contract. Progress updates, including wrapped messages, restoration and note-summary loading, remain below the thinker. Scrolling the active reply out of view returns the character to the composer without moving the reader's scroll position. Reduced motion freezes oscillation and pointer tracking while permitting the mood shape to settle, then stops frames. Hidden/offscreen instances cancel both RAF and timer callbacks. Pending-turn elapsed time and Stop controls remain available.

Reply metadata sits in a quiet reference area below the answer. **Context & references** expands the project, instructions, current document and source details; its collapsed summary shows counts instead of repeating long titles. Source groups retain their Cited/Read/Found distinctions, links, notices and per-chat inclusion controls.

### Knowledge atlas

The atlas reads existing entity records and saved relationships without creating a second authoritative graph. It includes company/programme links, people and roles, note links, decisions and semantic relationships alongside indexed source connections. Inferred links are hidden by default and never presented as confirmed roles or facts. Positions organise neighbourhoods; distance does not measure relationship strength.

Saved taxonomy tags are live graph entities connected by `tagged_with` edges,
including automatically assigned tags and filing tags. These edges reflect saved
membership, not a confirmed semantic assertion; their evidence identifies the
assignment source and tag role. Popular tags are not excluded by the legacy
shared-tag 50-use cutoff. Note, task, Discover, Library, content-item and CFP
tag junctions share the same projection, including Library `repo::path` and
upload identities. Taxonomy parents and project filing identities are linked.
Exploring a tag shows its tagged records within
the normal graph caps; direct neighbours take priority over second-hop context.
Adding, removing or renaming a tag is reflected without a graph-sync job.
Inline passage markers (Important, Follow-up, Question, Risk and Issue) remain
separate and do not automatically become graph records.

The graph reads current source records rather than trusting the `nodes` index
for existence, titles or saved relationships. Sparks and themes, live canvases,
Use Cases, source content (including calendar, email and publications), chat
outputs and build specifications join the existing entity types without waiting
for a sync. Archived notes/tasks, dropped Use Cases, deleted canvases and
publication mirrors are excluded; links to publication mirrors resolve to their
original Think note. Existing indexed UUID seeds remain supported.

Resolved `[[links]]` and `@mentions` connect their saved targets. Endpoint aliases
normalise diagram/canvas, article/Discover, Use Case, Library and semantic-source
identities. Saved task/source links, Spark capture and graduation, canvas pinned
notes and referenced cards, connections between referenced cards, diagram
annotations and live drilldowns, Use Case sources/specs/builds, Design assets
(including inherited assets and exclusions), note conversations, outputs,
register questions/risks/issues, passage extractions, build PRs and publication
attribution are projected from their authoritative storage. Arbitrary external
URLs connect only when they identify an existing indexed content record;
unresolved text, diagram shapes and free-text canvas cards do not invent global
knowledge entities.

Legacy cached `has_spark` and `on_map` edges are replaced by live links; cached
pairwise `tag_overlap` edges are superseded by taxonomy membership paths so
removing a tag cannot leave a false connection. Timestamp-proximity edges stay
excluded. Inferred links remain explicitly labelled; the existing opt-in now
filters them on the server before neighbourhood traversal and caps, preventing
hidden inferred neighbours from crowding out recorded connections. Graph views
refresh after successful record writes and on reopening/focus. External records
open their stored HTTP(S) URL; native records retain their specific hub route.
Two-hop traversal distances and returned-node metadata are computed in shared
sets, not repeated full-graph scans for each node; response content and caps
remain the same.

The supplied [Knowledge Atlas handoff](specs/knowledge-atlas.md) now defines the graph's visual and motion language. The actual `public/athena/atlas-graph.js` custom element renders the Carbon G100 dot grid, rounded project hulls, ringed project hubs, degree-sized items, curved relationships and unlinked groups. The main page has type chips, search, 7/30/90-day activity controls, a legend and a 360px inspector. Full-graph labels share a six-title maximum, prioritising the root, hover and selection before path/search matches and project hubs. Titles are regular-weight, ellipsised and collision-checked; selecting a densely connected node or zooming in never labels every neighbour. Full titles and activity details remain available through hover and the inspector rather than secondary text around nodes.

The supplied spring/repulsion constants, seeded cluster bloom, ambient drift, activity pulses and directional flow particles are retained. Dragging holds a node at the pointer while its neighbours react; releasing resumes physics, rather than permanently pinning every node as the previous renderer did. Reflow restarts the deterministic layout. Canvas dragging pans; wheel/pinch zoom at the pointer; selection eases to a record and draws in its neighbours. Zoom, Fit and Reflow controls are scoped to their own graph.

Type controls retain directly connected records as context by default: a company focus therefore retains its linked notes. Options can disable contextual retention for strict type hiding; project anchors always remain visible. Search and activity dim nonmatching records without inventing or deleting relationships. The accessible Relationships view and inspector retain recorded/inferred labels and actual source metadata.

Ask Athena resolves named endpoints through the existing read-only entity-suggestion endpoint, then performs deterministic breadth-first search on the loaded, allowed edges. Exact endpoint pickers handle ambiguous names. There are no guessed/demo endpoints, model calls or data writes. The answer, quiet-record warnings and accessible step list accompany the supplied staggered path reveal. Paths are explicitly limited to the loaded graph; failure to find one is not proof of no relationship. Connector, single cross-link, quiet-project and unlinked-group insights are computed from that same bounded dataset.

Notes use the same custom element in a 300px-high responsive compact panel, with the note pinned at the centre and a two-hop neighbourhood. Only the compact note graph has a transparent canvas without a dot grid; its label backing and project centres match the surrounding panel. The full-page Atlas retains its G100 background and grid. Compact labels use regular-weight text without thick outlines and prioritise the root, hover and selection, with at most four non-overlapping, width-limited titles and space reserved for the zoom controls. Full names remain available on hover and in the keyboard-accessible connected-record list. Nodes and relationships are not removed to reduce label density. Dense hubs use inertia proportional to summed spring stiffness to prevent unstable forces sending the graph off-screen. Unchanged data refreshes preserve force positions, camera and entry timing instead of restarting the graph; changed graph data and explicit Reflow still rebuild it. Reduced motion pre-settles the layout, stops ambient animation and renders camera/path changes immediately. Hidden/offscreen instances stop both frame and timer loops; panels first opened from a hidden state get a fresh initial fit.
Linked-note previews in the Link tab render read-only BlockNote content directly, not in an iframe. Their editor and container backgrounds are transparent so the writing shares the panel surface, without a separate black rectangle or an added graph.
Think keeps its existing toolbar and pane layout. Note rows use a restrained accent selection, quieter dividers and wrapping metadata; linked-note previews use a compact heading scale, comfortable body leading and a separated backlinks section.

The overview reserves space for different entity types before filling its 500-record limit with recent activity. Results are capped at 2,500 edges and visibly labelled when truncated. Search and filters operate on the loaded subset, not the entire knowledge base. Starting from a record loads one or two connection hops, retaining older context regardless of the overview's date filter. The note graph shows the loaded two-hop recorded neighbourhood without a second client-side node cap, labels truncated results and opens the full explorer.

The supplied Active in controls replace the former historical-window playback. Activity is whole days since the latest stored update; project activity is the most recent loaded member update, falling back to the project itself only when it has no loaded members. It is **not a historical graph diff or a complete event log**. Indexed sources may have index timestamps rather than source dates. Deleted records, earlier revisions and unknown relationship start dates are not reconstructed.

## 4. Core objects

- **Project:** the scope most other objects belong to. It carries the context Athena reloads on every turn.
- **Note:** a rich document in Think. It can be versioned, tagged, published to GitHub, or turned into a Build spec.
- **Spark:** a captured idea with its source. Sparks cluster into **themes**, which can become a note, canvas, project or blog post.
- **Canvas:** a diagram, which can link to notes and drill down into other diagrams.
- **Content item:** a Discover article, YouTube video or other indexed source. Videos distinguish public captions from description-only evidence; secondary background sources are not transcripts.
- **Watchlist:** a monitored competitor question with a versioned baseline and dated findings.
- **Person:** a contact that notes and chat can reference.
- **Memory:** durable facts Athena keeps about Richard and his work.
- **Task:** a Plan item with status, priority and due date.
- **Chat, Decision and Output:** an Athena conversation, the decisions it settled, and the saved artefacts it produced.
- **Build spec and Build task:** work dispatched to cloud coding agents.
- **Register item and review packet:** project governance records.
- **Use case** (section 6): an idea tracked from its sources to a spec, a handoff, and what shipped.

## 5. AI principles

- **Invent nothing.** Drafts use only the sources, context and conversation provided. Gaps are marked (for example "_Not discussed yet._") rather than guessed.
- **AI text is attributable.** AI-written content is identifiable as such.
- **Writes need confirmation.** Athena proposes; actions that change data or post externally need Richard's confirmation.
- **Grounded and linked.** Sources are kept and linked, so any output can be traced to where it came from.

**Proposed extension, not built:** [AI knowledge coverage and grounded cross-source
reasoning](specs/athena-ai-knowledge-coverage.md) specifies on-demand access to
eligible records, full/versioned reads, relationships, freshness, exclusions and
evidence-backed answers. It includes mandatory test cases and release acceptance
criteria. It preserves focused chat context and does not introduce Fabric.

## 6. Use cases: ideas → specs → build

**Status: built.** See the README section "Use cases (ideas → specs → build)".

A *use case* tracks one idea for one product.

**Fields:**
- **Product kind:** Imagine demo, Imagine platform, or another product (which must have a project or repo).
- **Stage:** `candidate → refining → spec ready → handed off → shipped`, or `dropped`.

**Flow:**
1. **Capture.** "→ Use case" on a Discover item, Spark, note or canvas creates a use case, or adds the item to an existing one. The item stays attached as a source.
2. **Track.** Plan → **Use cases** lists use cases grouped by product, with stage, number of sources and time since the last update.
3. **Refine.** **Draft spec** has Athena write a spec note in Think from the sources and product context, using the IMAGINE demo brief template for Imagine. Richard refines it in Think with Athena.
4. **Hand off.**
   - **To GitHub**, the default: the spec is published to the repo as `docs/specs/<slug>.md` (or `docs/prds/<slug>.md` for Imagine). Athena gives a ready-to-paste GitHub Copilot prompt.
   - **Or to Athena Build.**
5. **Close the loop.** Richard adds PR links and marks the use case shipped. Today flags use cases that have stalled while refining.

Blueprint generation and feedback that rewrites an authored Blueprint require the configured dedicated bulk endpoint and key. If either is missing, the request fails explicitly without calling the light/chat model. The full generation and feedback output budgets remain unchanged; legacy lower-budget feedback and other bulk callers retain their existing fallback behaviour.

The existing Design properties panel offers a manual **Check consistency** action. It saves pending editor changes, then reads the selected saved inputs without rewriting documents, resolving decisions or blocking handoff. Coverage explicitly distinguishes missing, ambiguous and unavailable inputs; fewer than two supplied inputs do not trigger a model comparison. Reports are timestamped revision snapshots, not continuously current certification. Contradictions require exact quotations from at least two different sources; diagram evidence must identify a saved node/connector and quote its label or description. Unverifiable model citations reject the report, and source changes during review require a fresh check. Missing architecture/diagrams are not inferred from unrelated records or generated automatically.

### Connected-work usability

Primary navigation resumes the last visited deep link within each area on the
current browser; explicit links still open their requested item. Think retains
the selected note in its URL, remembers its search and existing sort settings,
and restores list/editor scroll positions during navigation in the current tab.
Discover remembers its page and existing view, and both lists have independent
compact-spacing preferences. With focus in the list, J/K move and O opens;
Discover also supports S to save and A to archive non-blog/non-published articles.
Shortcuts do not run inside form controls, editors or modal dialogs.

The existing shell includes a collapsible background-work history, backed by
durable specialist jobs and their live updates. Running work remains visible
after navigation or reload; completion notices link to the saved result.
Completion is not approval or publication. This is not a combined monitor for
all chats, imports and scheduled jobs.

Project cockpits show linked records changed since the previous successful visit
on the same browser, initially the last 24 hours, with selectable periods.
Notes, tasks, recorded decisions, risks/issues and canonical source activity
are bounded and evidence-linked. Source activity uses its update/publication
time, not indexing time; the result is current changed records, not an audit
diff or a claim that all integrations are current.

Today lists upcoming indexed calendar entries; Activity calendar cards offer the
same manual meeting-preparation action. The owner selects a project explicitly.
Preparation reads the invitation, goal, commitments, blockers, recorded decisions,
open register and six recent note excerpts. Coverage, truncation, cancellation
and older-note warnings are explicit. It does not infer previous meeting outcomes,
send invitations or generate content automatically. An optional discussion opens
the existing Athena assistant with the evidence; it makes no automatic note.

Design consistency also accepts a proposed decision change for manual impact
review. Each potential impact must quote an exact affected saved passage or
diagram element; unknown or changed sources reject the report. The proposal is
hypothetical, findings remain advisory, and no document or decision is rewritten.

## 7. What Athena is not

- Not multi-user, and not a team tool.
- Not a content drafting pipeline (see use case 3).
- Not a programme management system (see use case 4).
- Not a replacement for interactive GitHub Copilot development. Athena prepares the spec; building usually happens in GitHub Copilot.
- Not mobile-first, except `/chat`.

## 8. Built vs planned

- **Built:** everything in section 3, plus use cases (section 6) and Discover Watchlists (use case 5). The README documents each feature in detail; `docs/email-sharing.md`, `docs/mural-integration.md`, `docs/youtube-discovery.md` and `docs/people.md` cover the newer integrations.
- **Not built:**
  - Audio transcription or video-content summaries. Public caption retrieval is
    attempted; unavailable captions leave description-only evidence with separately
    attributed related background reading. See `docs/youtube-discovery.md`.
  - Two-way GitHub note sync (edits publish outward; GitHub-side edits need manual resolution).
  - A saved recipient picker for email sharing.
- **Planned:** `docs/planned-features.md`, which covers the command palette, backlinks, `@` and `[[` note links, keyboard triage, memory editing, empty states, a spatial view and side-peek. Its "content pipeline board" (item 6) is superseded by section 2: content needs no stage tracking, and its Watchlists item 11 is now built.
- **Assessed, not planned:** Fabric and Fabric IQ (`docs/fabric-iq-assessment.md`).
