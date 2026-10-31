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
- **Present**: a teleprompter on the Elgato display through Athena Desktop.

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
2. **Podcast topic organisation.** Each Thursday Athena prepares a ranked topic brief for the Friday recording, threaded to earlier episodes, and creates that recording's **Podcast** episode in Think ("Cloudy with a Chance of Insights: Episode N: <title>", numbered from the last episode). The episode is a note content type with five tabs: **Prep** (the brief conversation), **Script** (a free-text intro using the standard show opening and a brief running order drawn from Richard's, David's and Cyrus's topic lists in Prep, then unnumbered, reorderable topic cards; no outro. Each synopsis is a readable mini-script of up to three paragraphs that introduces its topic, backed by selective bullets highlighting key features, constraints, what has not yet been demonstrated and potential enterprise uses without presenting possibilities as confirmed capabilities. Drafted through the existing Draft script action and presented on the Elgato display through Athena Desktop), **Transcript** (a Riverside .txt, .srt or .docx export), **Show Notes** (drafted by the show notes persona from the transcript only) and **Campaign**. Today's podcast card opens the episode's Prep tab. Episode-coverage summaries recover from an output-token limit by retrying only the failed chunk once at 3,000 tokens, then splitting that chunk into two if needed. Each half has the same bounded retry, with no further splitting; successful chunks are not rerun, no source text is omitted, and truncated model responses are not accepted. Summaries use the podcast-specific request timeout, not the generic lightweight-call timeout. The overall eight-minute deadline and Thursday schedule are unchanged; a terminal failure cancels outstanding requests. Tracking topics over time matters here and in competitive monitoring (use case 5); nowhere else.

**Create show notes** on the Show Notes tab queues the Podcast show-notes writer
through the existing specialist job engine. No embedded Athena chat or manual
save/export step is required. The transcript remains the authority for the episode
content; the Prep conversation supplies candidate reference URLs only for resources
actually discussed. Missing URLs can be located with bounded official-source
searches and must be opened for verification. Unverifiable references are disclosed
in the saved package, not only in a chat reply.

Reference checking runs separately with at most four tool rounds and one candidate
URL per resource, followed by a report of verified URLs and unavailable references.
Drafting has only Output read/save tools: it cannot spend its save budget searching
again. The worker preserves the established seven-output package and generates it in
three bounded batches. Its job-owned draft workspace is reused on retries,
without overwriting previous user conversations. Complete output names are checked
before saving, with one bounded repair pass for missing or invalid batch outputs.
Matching platform reference sets take priority over description length: both
descriptions are shortened together if Spotify needs more room for the full footer.
Spotify's body is converted to the permitted HTML tags if it was
incorrectly returned as Markdown, validated against the platform's title/body
limits, and saved in a native HTML code block for copying. Reference links remain
clickable in prose and literal anchors in the Spotify source. Generation cannot
publish, schedule, or invoke unrelated write tools. Episode revision checks and
the current worker lease fence the final save; an existing show-notes document is
never overwritten. Users can leave the tab while it runs, see progress/failures,
and edit the resulting document in the unchanged Think editor/properties shell.
Show Notes and legacy script documents are episode-owned internal records, not
independent Think list entries. List counts and pagination exclude them; matching
their content returns the parent Podcast episode. Existing generated content and
the episode's Show Notes and Campaign editors remain available.
Podcast Prep uses the existing Think note editor, not an embedded Athena chat.
The episode note body holds the editable brief, with its headings, lists and
source links. Existing saved briefs are converted once without another model
call; non-empty document content is never overwritten, and clearing an imported
brief does not cause it to be imported again. The original conversation remains
stored as supporting history. No separate Prep entry is created in the note list.
The Episode properties Progress list uses a checkmark for saved content and an
empty circle for missing content. These indicate availability, not review or
approval: Prep has saved document content, Script has saved intro or cards,
Transcript has uploaded text, and Show Notes has a saved package.
Campaign also appears in Progress, with its live preparation, approval, pause,
attention or all-posts-sent status. Its check means a saved campaign plan exists,
not that every post has been delivered.
Prep shows the document loading/error states with Retry, not a conversation
composer. Script drafting uses the edited Prep as the authoritative brief and
the original conversation only as supporting history. Saving changes to the
episode document advances the episode revision so stale script work cannot
overwrite a script based on a newer brief.

Explicit approval of the exact publishing draft version takes precedence over
archiving or shelving its Discover source. Filing the source is not cancellation
of an approved post; pause or hold publishing, or revoke its approval, to stop it.
Held items do not reserve account capacity or displace eligible posts.
Automatic low-value shelving, like age-based archiving, excludes parked articles
and sources of live publishing topics (pending, assessing, ready or held).
Discover evaluates short-social suitability independently of long-form depth.
A concrete, timely development relevant to the audience can qualify for Bluesky
with good or strong social fit even at a low composite score and zero analytical
depth. This uses the existing LinkedIn Standalone short-social route, not a new
content type. It does not promote blog, newsletter or podcast suitability.
Zero audience relevance, zero novelty, advertorial exclusions and already-covered
stories cannot use this low-composite exception. Existing scores are not
automatically rewritten or rescored.
An overdue approved commitment retains its assigned time and is shown as awaiting
delivery checks instead of silently moving to a later slot. Actual sends still
enforce current publishing windows, account limits, retry deadlines, approvals
and package dependencies. Schedule inspection does not send posts.

**Draft script from prep** queues the Podcast script writer through Athena's persistent
specialist worker system. Script generation and its synopsis style pass run in the background,
with live progress, Background work history and a completion or failure notification linked
to the episode's Script tab. The user can leave the episode or switch stages while it runs;
script editing is disabled during generation. The worker saves only against the requested
episode revision and its current job attempt, so newer saved changes are never overwritten.
Existing local/production worker-pool separation applies; local drafting still uses the shared database.

The Podcast script writer has its own spoken-voice guidance, separate from blog drafting:
conversational British English, natural contractions, short speakable sentences and accessible
explanations, with technical detail limited to what explains the key features and constraints.
The presentation display labels cards **Topic 1**, **Topic 2**, etc. in their current
order instead of showing full topic titles. Saved titles and script-editor headings
remain unchanged.

Each topic card targets a three-to-five-minute segment, no more than five minutes including
its synopsis and supporting discussion, with room for conversation rather than padding.
This is a drafting/pacing target, not a measured recording-duration guarantee.
David's angle is deep architecture, Cyrus's is cyber security, and Richard's is enterprise
alignment and practical organisational use. These angles do not substitute for the actual
topic assignments supplied in Prep. Richard's cards introduce the topic and essential
enterprise takeaway in the first paragraph, followed by optional detail and selective
supporting bullets. Cards stay self-contained so he can shorten or skip his material live
to preserve the other presenters' sections; Athena does not automatically cut topics or
change the running order. The light style pass preserves this core-first structure.
Athena drafts topic cards only for Richard, never scripts, synopses or bullets for David
or Cyrus. They supply their own contributions, usually shortly before recording; their
supplied topic lists are used only for brief intro running-order mentions. Missing lists
are not invented and do not imply their sections are cancelled. After the running order,
the intro briefly explains that the show is recorded as live, normally without editing
except for technical issues, which are often left in too. This is not a live-stream claim
or a promise that every recording is entirely unedited.

The episode's embedded Athena chat resolves the structured script, not just its parent
note title/body. `read_podcast_script` supplies the saved intro, complete paged cards with
stable IDs/revision, worker state and per-card/combined spoken reading-time estimates at
130–160 words per minute. Synopsis-only and all-written-material estimates are separate;
live discussion and the other presenters are not measured. `update_podcast_script` saves
explicitly requested intro or individual card-field edits through the normal script service,
preserving all untouched content. It requires a current read and revision, checks source
exclusions/project scope and rejects edits while the script worker is active. The editor
saves pending changes before a chat turn, locks script editing during the turn and reloads
saved episode data afterwards. Generic parent-note edits and disconnected drafts are not
substitutes for a script edit. Full regeneration remains background specialist work.

The Script editor uses the compact Athena typography without background cards, with a
fixed action row above the independently scrolling script body, never floating
over its text. Card titles grow to show their full text;
the existing move/delete controls wrap within the card header when space is limited.
Intro, synopsis and bullet fields retain inline editing and visible focus states without
nested raised-grey input panels. The Think shell and Athena/properties panel are unchanged.

Selected words in intro, synopsis and individual bullet fields can receive teal,
yellow or pink emphasis, or have colour cleared. Compact Pause and Beat controls
insert visual delivery reminders at the cursor without changing scrolling.
Annotations are stored in the existing text fields as `[colour=teal]text[/colour]`
(also yellow/pink; `plain` clears emphasis), `[pause]` and `[beat]`. The same
dependency-free parser is used by the frontend and backend: normal script saves
reject unbalanced colour spans, and Athena reads/preserves annotations through
its existing typed script tools and revision checks. Spoken-duration estimates
exclude colour tags and visual cues. No schema migration or separate document is needed.

Athena Desktop 0.1.11 renders the saved annotated script as safe text runs, not HTML.
The passage at the existing reading guide is bright while surrounding passages
are dimmed; positioning follows manual scrolling, text size and vertical mirroring.
Colour tags are not displayed; Pause and Beat appear as non-spoken visual markers.
The Presenter view retrieves episode scripts rather than substituting the parent
Prep document. Older desktop versions explicitly reject annotated presentation
with an update message rather than dropping the formatting. The desktop update
must be released separately; web changes alone do not update its output renderer.

The Script editor leaves a full blank line between every intro, synopsis and bullet sentence
(two newline characters, like separate short paragraphs). Continuation sentences remain under the same bullet marker; Enter starts
a new bullet and Shift+Enter adds a line within it. Normal script saves retain this formatting
and Elgato presentation applies it to the intro, synopses and bullet text as well. Left-button text selection (or keyboard
selection) in intro, synopsis or bullet fields reveals a compact passage toolbar with
Rewrite, Rephrase and Add specific content. The latter accepts an explicit addition.
An action saves pending script edits, then opens a focused request in the existing Athena
panel for the user to send. It identifies the episode, card, field and exact selected text;
Athena reads the current script and changes only the requested passage through the normal
script tool, asking rather than guessing if the passage is ambiguous or has changed.

Generated podcast synopses receive a light AI-trope check using the relaxed article policy:
factual lists, ordinary comparisons and occasional rhetorical contrasts are allowed.
Only flagged synopses receive one targeted revision pass, preserving facts and spoken tone.
The intro, bullets, unflagged synopses and manually saved edits are not rewritten.
An incomplete or unsuccessful style pass fails visibly without replacing the saved script.

Podcast news research replaces unreadable source candidates with the next ranked
readable candidates, keeping the Discover/web selection order. At most 32 source
reads are attempted for up to 16 evidenced articles, with three reads in flight.
Unavailable sources appear explicitly under research limitations and cannot be
cited as evidence. If no sources can be read, preparation fails visibly instead
of inventing a brief.
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
| **Plan** (`/plan`) | Tasks in Board and Focus views, with saved views, Athena check-ins and at-risk prompts. Status moves update immediately and reconcile only the saved task in place, preserving other task order and origin links without refetching the whole list. Completing recurring tasks still refreshes to discover the next occurrence. Failed moves restore the task and show an error. Open use cases appear in the Board's Backlog or In Progress columns without creating duplicate task records. |
| **Think** (`/think`) | Notes (BlockNote editor with history, recovery, tags, `@` mentions of people, projects and documents, and GitHub publishing), **Sparks** (capture, connect into themes, mature, ship) and **canvases** (diagrams with drilldowns and links to notes, exportable to draw.io and Mural). |
| **Build** (`/build`) | Specs are split into dependency-ordered tasks and dispatched to GitHub cloud coding agents (Copilot or Claude) as issues. Their PRs are tracked and merged. |
| **Athena chat** | Available everywhere: a side panel, a floating widget and `/chat`. It has personas: general, brainstorming, blog post, LinkedIn, demo designer, web designer, podcast prep, podcast show notes and Copilot coach. Chats record decisions and Outputs, and can be turned into a spec note. |
| **Activity** (`/my-work`) | Activity from connected systems (M365 calendar, mail and To Do, GitHub, GitLab, the blog CMS, IBM and Alliance sources), plus connections, tokens and sync status. Also holds the Mural and SMTP2GO integration settings. |
| **Sources** (`/library`) | Indexed documents and source material, searchable and used for grounding. |
| **Knowledge graph** (`/graph`) | A simple force-directed 2D graph and an accessible relationship list, without a 3D option. Search, focus and inspect recorded or explicitly labelled inferred connections; start from a note's Connections-panel mini graph. |
| **Memory** (`/memory`) | What Athena remembers about Richard and his work. |
| **People** (`/people`) | Contacts with email aliases, organisation, role and topics. Import contact reports from Markdown; mention people with `@` in notes and chat. |
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
Selected note text copies directly from the selected document fragment, not
through Markdown conversion. Literal Spotify HTML retains its tags and URLs
without added backslash line breaks; rich/native clipboard payloads remain intact.
The reading/action pane shares Discover's 14px reading text, 1.6 line height,
clear semibold section hierarchy and 24px section rhythm. Existing document
measure, editor gutters, authored list markers, saved text colours, action
locations and properties remain intact. The formatting toolbar uses a subtle
divider and explicit focus and disabled states.

The overview reserves space for different entity types before filling its 500-record limit with recent activity. Results are capped at 2,500 edges and visibly labelled when truncated. Search and filters operate on the loaded subset, not the entire knowledge base. Starting from a record loads one or two connection hops, retaining older context regardless of the overview's date filter. The note graph shows the loaded two-hop recorded neighbourhood without a second client-side node cap, labels truncated results and opens the full explorer.

The supplied Active in controls replace the former historical-window playback. Activity is whole days since the latest stored update; project activity is the most recent loaded member update, falling back to the project itself only when it has no loaded members. It is **not a historical graph diff or a complete event log**. Indexed sources may have index timestamps rather than source dates. Deleted records, earlier revisions and unknown relationship start dates are not reconstructed.

### Quick learning

Quick learning opens in Athena's existing modal shell through the top-right Tools menu,
keeping the current workspace underneath. Its `/learn` deep links also open the modal;
it is not a standalone workspace page, Today widget or primary navigation destination.
Questions, explanations and the learning-agent discussion all stay inside the same modal. New sessions contain ten
single-answer, four-option questions across Microsoft and GitHub, mixing strategy,
enablement and product knowledge at foundation, practitioner and advanced levels.
There are no code-debugging or syntax-repair questions. Submitted answers are immutable.
Progress, results and question-specific learning-agent discussions persist per authenticated
user in the shared database, including unfinished sessions that can be resumed.
Existing five-question sessions retain their original size, scores and answers.

The start screen shows the daily test, topic progress and saved sessions; introductory
copy and progress/history stay out of Q&A mode. Topic IDs come from the official-source
catalog rather than model-generated names. Each topic shows lifetime correct/answered
and accuracy, recent correct/answered and accuracy, and paginated dated answer history.
Withdrawn questions keep their historical scores but do not influence adaptive ranking.
After three source-valid answers for a topic, the latest ten determine weakness.
Six of ten questions revisit weaker subjects; four maintain breadth, prioritising
less-practised topics. Until weak areas have enough history, the mix remains balanced.
Categories and levels still vary; topic-specific generation does not substitute a different
subject when a candidate fails review. The chosen plan is persisted per session for retries.

Production queues the next weekday's daily test at 22:00 Europe/London on Sunday–Thursday
nights, including daylight-saving changes. One persisted daily session per owner and date
prevents duplicate tests across scheduler ticks or restarts. Each learner is enrolled after
using Quick learning with their authenticated account; the local `dev-user` is not scheduled.
New daily sessions do not overwrite unfinished manual or older daily sessions.
The existing production scheduler and specialist worker perform preparation; local automatic
jobs remain disabled. A daily test becomes ready only when all ten questions pass review.
The scoped learning agent receives the learner's topic progress and schedule as well as the
question, submitted answer, evidence and discussion; scores remain immutable from chat.

The `learning-question-writer` specialist prepares sessions in the existing background
worker pool. It reuses unseen admissible bank questions where possible, or reads bounded
official English Microsoft Learn/GitHub documentation to prepare candidates. Each option,
correct-answer explanation and main explanation must cite numbered source passages.
The application copies those passages directly from fetched text, rather than asking
the model to reproduce quotations; invented or out-of-range references are rejected.
Learner-facing explanations identify answers by their content, never internal indices,
option numbers, letters or positions. Admission and follow-up validation reject such
positional references rather than guessing which answer the prose intended.
A separate model review must independently derive the same unique answer, confirm the
evidence supports every claim and reject ambiguous guidance, unsupported negatives,
missing product/plan qualifiers and coding questions. A rejected candidate can receive one
targeted correction using the review findings, followed by the same strict review again.
If it still fails, preparation tries a different official source and continues replacing
rejected candidates until the slot passes, with one repair per candidate. Cancellation
still stops work, and operational failures remain explicit. Rejected drafts are never assigned as quiz questions. A session becomes
ready only when every required slot contains an approved question; operational failures remain explicit
and can resume without discarding accepted questions or submitted answers. Unanswered held
slots in older incomplete sessions can be replaced during preparation.
There is no weakening of the admission rules or rejection-count cutoff. The initial documentation catalog
is intentionally bounded; this is not exhaustive coverage of every Microsoft/GitHub product.
There are no new model resources, dependencies or scheduled generation costs.

Official pages are fetched again before displaying a question, accepting an answer or
answering a follow-up. A normalised-text hash detects changes; changed questions are held
out of the bank rather than served from stale evidence. Source failures withhold the
question temporarily without pretending verification succeeded. Reports immediately
hold the question and preserve the submitted answer; held questions are not automatically
re-admitted. Later sessions can generate replacement questions. An evidence-reviewed
candidate that still fails the semantic review is saved as a withheld slot, not a playable
question, so the learner can continue past it without losing questions that passed.
Preparation/network failures are visible and retryable; unchecked questions are never served.
If no questions pass, the session remains unavailable.

After submission, the page reveals the correct answer, why every option does or does
not fit, supporting quotations, source links and check time. The dedicated learning
agent receives the full persisted question, choices, explanations, official source text,
submitted answer and recent saved discussion, not just a page title. Its source-backed
follow-up answers undergo a separate evidence check before saving. Unsupported follow-ups
receive an explicit refusal to guess. It cannot silently edit the key or regrade the learner;
reporting is the correction path. The modal's conversation uses this dedicated agent
rather than the ungrounded general chat, and leaves the underlying workspace's Athena context intact.

These are AI-assisted evidence checks, not a guarantee of factual correctness. The UI
states that limit; it does not label a model's confidence as proof. Past scores are
historical results, not a promise that withdrawn questions remain current.

### Athena-only task deliverables

Athena develops content in Think and tracks commitments in Plan. This workflow
does not use Copilot Cowork, a plugin or an external handoff. IBM M365 Graph is
unavailable. There is no Graph write permission, email send action or new Plan
control in that deliverable-brief workflow.

- **Deliverable brief** is a Work content type in Think, using the existing
  editor and properties panel. Its template covers outcome/definition of done,
  sources/evidence, decisions only Richard can make, deliverable specification
  and target OneDrive path. The properties panel holds the linked task, exact
  folder/file name and produced-file state. Athena develops the brief in Think;
  there is no handoff-prompt action.
- **Email draft** is one task-linked Think note per email. Compact To, Cc and
  Subject fields sit above the existing body editor. Status, sent date,
  linked task/brief and Copy email remain in the properties panel. Richard
  copies and sends through IBM himself. Sent requires explicit confirmation;
  setting the task to Waiting on the recipient requires a separate confirmation.
  Replies are known only when Richard supplies them. Sent writing/recipient
  fields are protected; a follow-up uses a new draft.
- Athena initiates this workflow through `create_deliverable_brief` and
  `create_email_draft`. `read_work_content` reads current structured metadata
  and pages the body. Requested edits use `update_deliverable_brief` or
  `update_email_draft`, after the open editor saves pending body and field
  edits. Writes check both note and properties revisions; original-body
  protection and normal indexing are preserved.
- Existing OneDrive sync matches that exact path case-insensitively, including
  already-indexed files and moves/renames with an unchanged cTag. It links the
  document to the brief and task and records activity. **Ready for review is
  not approved or completed**; task status never changes on file detection.
  Refresh status fetches saved state; it does not start a sync or production job.
- Work fields use side tables `deliverable_briefs` and `email_drafts`; authored
  bodies stay in normal note blocks. Pending properties drafts are retained
  locally per signed-in identity and cleared with note drafts on sign-out.
  Conflicts do not overwrite retained drafts.

No connector or plugin is part of this workflow. Office files saved separately
in Alliance OneDrive can still be linked by the existing read-only sync; file
tracking does not imply Athena generated or approved the file.

Local verification on 31 October 2026 used the real Investigate First Mate task:
Athena created a brief and an unsent source-request draft, read and edited the
brief, and the normal Think editor displayed the saved changes. Email copy
worked; the task remained in backlog and no message was sent. Both packages
passed TypeScript checks. File-sync detection and Sent/Waiting confirmations
were not exercised against real commitments. No production deployment occurred.

### Named links on Athena-created notes

Athena addresses the user directly as **you/your** in conversation and personal
findings, recommendations and decision lists, rather than describing them in
the third person. Drafts written in the user's voice use **I/my** (or **we/our**
for an actual shared-team viewpoint). Exact quotations, public host credits and
third-party attribution retain their original wording. This applies to future
writing and does not rewrite existing notes.

New notes created by Athena and its agents receive a named-reference linking
pass before persistence, including research, exports, podcast notes, work
content and generated Design documents. Unique, distinctive names become
native note/entity mentions, so existing backlink and graph indexing applies.
All matching occurrences are linked, including nested writing and names split
across styled spans. Existing links, code, media and surrounding styles remain
unchanged. Older notes are not edited and semantic-only relationships are not
inferred. Manually created notes retain their existing suggestion workflow.

Duplicate names are not guessed. In an automatically linked note the existing
link-suggestion bar surfaces those destinations as **Clarify link targets**,
with previews and the existing linking controls. Clear references require no
approval click. Link-pass failures prevent creation rather than silently
saving an apparently complete, unlinked note.

Copying or cutting selected note writing supplies visible text, including
resolved backlink titles, in the clipboard's plain-text payload. Rich-text HTML
and native BlockNote references remain available for formatted/internal pastes.
Code text is preserved literally rather than interpreted as structured data.
YouTube show notes are ordinary text with preserved line breaks, not code blocks.
Existing YouTube sections are displayed the same way when opened; Spotify's
literal HTML stays in its code block. Copying does not add fences or remove URL
slashes.

### Approval-first task assistance

Today and Plan remain separate entry points. Selecting a task uses the same
task-detail component, existing task editor, activity and connections, with
Athena available alongside. Plan retains Board and Focus when no task is selected.
The selected-task list reuses Today's review rows, section heading and quiet
navigation control styling; it does not introduce a separate Plan list style.
Today details and the shared Plan task detail match Discover's expanded
32/40px reading titles, saved-colour project/topic chips, source-link treatment,
bordered context blocks, 24px section rhythm, quieter metadata and compact
bordered/accent actions. Activity tabs and
connection headers retain their own control styling rather than inheriting
generic task-button borders. Activity entries share the panel's text edge;
editing, assistance, activity and connections stay in their established locations.

**Help me** assesses whether Athena can advance part of the task. This is an
intent assessment, not a keyword trigger or an automatic job on task creation.
Review, investigate, look at, think about, validate and compare may indicate
research; missing information is not a reason to create an unrelated email.
The saved proposal explains the work, expected result, missing information,
public search queries and decisions you retain. Research questions do not block
approval or execution: Iris investigates them and flags unresolved ambiguity
in the findings without choosing for you or changing original artefacts.
Email prerequisites still require clarification and reassessment. New direction
requires a new assessment; unsupported tasks are explained without a job.

**Approve and start** commissions a durable specialist job against the saved,
owner-bound proposal and task snapshot. Iris reads actual sources and returns
source-backed Think findings using the proposal UUID as its database chat-session
identity. Failed jobs are retried explicitly, not automatically after a code fix.
Findings include fit/gaps and proposed changes. Repository work
locates and verifies the repository, then compares it with relevant Athena
architecture or project artefacts. Project work prioritises existing notes,
specifications and saved diagram structure, with general component knowledge
and official documentation as supporting evidence. Unverified identity, source
failures and partial reading must be reported, not concealed as compatibility.

External search is restricted to the exact queries displayed in the approved
proposal. Private project/client material is not part of public search queries.
Research tools are read-only; execution has bounded tool rounds and a five-minute
deadline. Approved public research requires available Tavily search schemas,
a successful approved web search and an actual public-source read; internal
reads alone or a guessed repository URL returning 404 cannot satisfy that work.
No-source research cannot be saved as completed findings. Saved results
are linked to the task and recorded in its activity; the existing specialist
notification path reports completion or failure. Lease and task-snapshot checks
prevent stale attempts from applying their results; retries reuse saved results.

Email assistance creates a copyable draft in a linked Think note, with a
**Copy email draft** action on the task. It does not send mail or mark it Sent.
Research does not overwrite existing diagrams or turn findings into approved
architecture. Neither route changes task status, deadlines or waiting state.
Ready for review means the assistant finished its preparatory work, not that
Richard completed the task. Casual Athena discussion does not approve execution.

Implementation fit: existing specialist jobs, source readers, notifications,
Think notes and task links are reused; ACA/SWA hosting and local delivery
assumptions remain unchanged. No new dependencies or infrastructure are needed;
model work is approval-triggered and bounded. Proposal contracts are validated,
owner-bound and fenced by task snapshots and worker leases. Existing encrypted
connection credentials are reused without writing secrets; public searches
require the displayed approved queries. The safer scope is this assisted,
draft-only workflow, not automatic task dispatch or completion. Existing design
hook warnings in unchanged stylesheet rules are outside this change; the new
task styles use the guide's existing tokens and typography.

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

All main workspace screens share the same PageHeader geometry: 24px title,
24px top/side gutters, a compact 64px header with 8px bottom padding, one Carbon bottom divider and a
16px gap below it. Title, subtitle and existing right-hand actions retain their
roles without page-specific typography or offsets.
Plan controls stay on one row; on narrower desktops their action labels become
accessible icon controls, retaining tooltips and the existing actions.
The redundant Tools breadcrumb row is removed so tool destinations use the
same title and divider position as the primary destinations.
The Notes list's label/refresh/collapse/search/sort/group/preview block is
temporarily omitted. Cmd/Ctrl+K remains the global search entry point. Stored
list search is ignored while the controls are omitted, not deleted; the controls
and preferences remain recoverable by restoring the NoteList showTools prop.

Think's Notes view uses the same quiet list treatment as Discover: unboxed
panes, open rows and selected-row tint. Compact unselected titles use at most
two lines; the selected title wraps fully with semibold emphasis. The existing
labelled content-type flag remains beneath the title. Date/project grouping, preview and density
preferences remain intact. Its header and controls use compact spacing without
moving actions, editors, content-type tabs, properties or Athena. Sparks and
Canvas styling is unchanged.

Primary navigation resumes the last visited deep link within each area on the
current browser; explicit links still open their requested item. Think retains
the selected note in its URL, remembers its search and existing sort settings,
and restores list/editor scroll positions during navigation in the current tab.
Discover remembers its page and existing view, and both lists have independent
compact-spacing preferences. With focus in the list, J/K move and O opens;
Discover also supports S to save and A to archive non-blog/non-published articles.
Shortcuts do not run inside form controls, editors or modal dialogs.

Today and every Discover list use a Carbon three-column review workspace:
a wider, information-rich list, the selected item's structured details and
an embedded Athena panel. The columns share one bounded workspace height and
scroll independently. List and Athena widths are drag- and keyboard-resizable
and remembered per layout profile. Athena starts collapsed to a labelled rail;
opening it uses workspace space, not a full-window drawer. The first available
item is selected automatically, and a selection is retained while it remains
in the current list. Existing workflows, editors and approval boundaries remain
in place; selecting an item never generates an assessment or approves an action.
Today keeps its existing work groups and selectable meeting/podcast preparation.
Discover retains article views, CFPs, mailbox filters and Watchlist evidence and
history. Article selection opens the details directly, without an Explore
button. Thumbs down is the single dismissal control for For you and Shelved:
it archives the article and counts as one negative source-ranking point,
matching an ordinary manual archive, rather than the former two points.
There is no separate Not interested button. Thumbs up still counts as two
positive points; saved/blog items retain their Archive action.
Article controls, including feedback votes, Save, state changes and creation
actions, remain available in the reading pane's compact article toolbar. Left cards use a
pointer cursor without separate open-link or information buttons. The saved
assessment and original-source link remain in the reading pane. The reading header has
a prominent 32px title (40px in a wide reading pane), a saved Athena treatment
or existing relevance band, and the saved assessment above a compact feedback/Save toolbar,
with secondary creation actions in More, and clearly grouped source, publication date, workflow status,
topics, relevance assessment and project fit, using saved fields only.
Today and Discover use open list rows and an unboxed reading surface rather
than nested background panels. Only column separators, quiet row rules and
the selected-row tint define the workspace. The briefing is compact and
unboxed. Selecting a different item resets the reading pane to its title
without resetting the independent list scroll.
The shared header keeps its count under the title; view tabs and keyboard
hints share a row when space permits. The full-width briefing sits above the
columns without a repeated Standouts heading in the list.
Format actions use compact 32px single-line buttons, with fit beside the label,
wrapping as whole controls instead of large equal-sized grid boxes.
Compact article rows retain
source/date, full titles, topics and a saved treatment/relevance label; the
justification is shown in the selected article's reading pane.
Recommended formats are actionable immediately after the assessment and
toolbar, followed by structured project-fit rows and supporting metadata.
Quick/full blog actions preselect the corresponding length in the existing
dialog without starting a job; social opens the existing preparation dialog.
Newsletter/podcast actions open the same parking editor with that destination
selected, retaining other choices and requiring the normal explicit save.
Project-fit evidence does not imply an attachment or expose an unsupported
Attach operation. Wide-screen lists default
to 560px and can be resized up to 760px, preserving saved user widths.
Publishing retains its existing dialog, draft editors, scheduling,
delivery history and audit views with the same embedded review composition.
Athena receives stable item IDs, the active view and actual structured saved
content and job state. Summaries and failed retrievals are identified as such,
with existing bounded tools used for full source or historical content.

The existing shell includes a collapsible background-work history, backed by
durable specialist jobs and their live updates. Running work remains visible
after navigation or reload; completion notices link to the saved result.
Completion is not approval or publication. This is not a combined monitor for
all chats, imports and scheduled jobs.

The workforce foundation adds versioned assignment, artifact-reference and
owner-approved budget-profile storage without enabling a new team or changing
publication authority. Budget profiles start disabled; approved numeric limits
are immutable and require a new version to change. Reservations are durable
lifetime charges, including unknown provider usage, not credits automatically
refunded for retries. Assignment-aware Foundry calls reserve their allowance
before dispatch, including each streamed transport retry, and reconcile usage
without refunding uncertain responses. Text input uses a conservative byte-based
reservation plus output/context headroom, not a monetary-cost guarantee.
Images and provider-managed tools are refused without an approved accounting
contract. Public-page redirect hops and Tavily research operations use the same
call allowance; cancellation and budget failures cannot become optional missing
evidence. These guards do not activate budgets for legacy standalone jobs.

The manual-blog acceptance controller atomically commits a canonical domain
write, its immutable reference and its fixed successor. Replayed completion
cannot regenerate output or advance twice. Only the critic step may provide a
validated review disposition; the fixed chain allows one author revision and
an independent recheck, never an automatic second revision. A waiting disposition
retains its artifact without queuing a successor. Assignment claim, renewal,
expired-lease recovery, classified failures and explicit authorised resume
preserve the same pool, attempt limit, original scope, deadline and allowance.
An installed domain executor can use the existing worker's two concurrency
slots; unregistered workflows are never claimed. Legacy prerequisite failure
handling excludes assignment-backed steps.

The blog role services separate research/prompt preparation from authoring
while reusing the existing link and exact source-footer rules. Iris receives
only explicitly supplied source/author records; it has no database access or
private-corpus search capability and sanitises author context before sharing it. Calliope
authors candidates, while Momus reviews every paragraph and the whole piece
without editing or saving. A targeted author revision is bound to the exact
reviewed draft and evidence, refuses an incomplete critique and accepts or
rejects the entire protected passage patch set. Ambiguous quotations and
whole-piece omissions are not converted into unrestricted rewrites. A revision
does not certify itself; the fixed controller still requires independent recheck.

Assignment chat notices use a transactional outbox: the assistant message,
conversation timestamp and event receipt commit together. Retries do not
duplicate a notice, superseded events do not announce stale states, and a
deleted conversation is explicitly recorded as undeliverable. Notice delivery
does not grant publishing authority or undo delivery.
Durable owner-bound acknowledgement now covers global assignment notices as
well as the conversation outbox. The existing app-wide job feed announces the
assignment outcome and refreshes its conversation and Background work; a chat
outcome is not announced before its transactional conversation receipt exists.
Released feed subscriptions reject stale in-flight polling results.
Multiple events for the same assignment revision share one chat outcome and
one acknowledgement state, including events arriving after acknowledgement.

Owner-scoped assignment status, cancel and explicit resume endpoints expose
operational metadata rather than raw briefs or evidence. Resume refuses an
uninstalled source-authorised executor. Assignment-owned steps are excluded
from legacy job lists, and individual job reads/actions enforce assignment
ownership. Existing Background work now displays one assignment with its named
worker/stage, readiness/attention/cancelled state and any canonical draft link.
Cancel/resume use the existing confirmation dialogs, revision-bound requests
and visible action errors; they do not move editor controls or refresh budgets.

The manual-blog domain adapter stores immutable per-attempt stage snapshots in
the existing job domain and references their exact signatures. The original
draft job remains the editor link; subsequent reviews and the single targeted
revision update its canonical checkpoint without changing the saved original
or earlier artifact revisions. Its full checkpoint signature is revalidated,
so user changes to the draft, evidence or review context stop automatic
application rather than being overwritten. The existing exact send/recheck
contract remains authoritative.
An open workforce editor retains its original snapshot across background
refreshes. The first actual user edit sends an owner-checked intent that
supersedes active team work and fences its pending steps. It does not autosave
the user's text or replace the original editor. Local edits remain intact if
the request fails; the existing error surface explains the failure, and a
recheck retries the coordination before starting. If the team saved a newer
version before receiving the edit intent, the editor reports that race instead
of claiming nothing changed.

The source adapter reads only explicitly selected Discover/theme, published
blog context, active applicable author memories and user-authored messages.
It locks and checks exact versions, project boundaries, excluded aliases,
theme membership and the originating conversation's exclusion/project snapshot.
It does not give a specialist a database or unrestricted private search.
The agreed format and instruction are retained. The app-facing prepare/commission
API binds source versions, owner, originating action and the approved numeric
profile; preparation does not call a model. The existing explicit Start drafting
and Generate again actions now check the server's workforce capability. Disabled
pilot installations keep their legacy writer; enabled installations use the
bounded team and surface missing-profile/source failures without a legacy
fallback. These convenience actions retain automatic author/voice grounding
through a trusted bounded selector: up to 12 applicable active memories, three
voice samples, three related authored posts, up to five earlier links for a
Quick take, and six relevant user-authored messages from each of at most two
permitted conversations. Every selected record is version-bound before a role
reads it. Roles receive no database or corpus search capability.

Selection enforces project boundaries and source/conversation/graph exclusions
before applying its limits. Voice, authored perspective and earlier links have
separate purposes; writing samples are not factual research evidence. Related
context selection is deterministic lexical retrieval, not a paid embedding/model
step outside the assignment budget. Existing configured background is permitted
only when there is no stored author profile of any status; it cannot revive a
paused or dismissed profile. An empty permitted author-record set fails before
commissioning, research or model expenditure rather than widening retrieval or
weakening privacy checks. Operational grounding quality remains a pilot gate.

Athena's existing blog handoff can commission the same team with authenticated
owner, server-issued per-turn action identity, explicit format, verified source
exclusions and strict project boundary. Read-only, missing-boundary and unsupported
collection/date/state-filtered turns fail closed. Model-supplied confirmation or
owner fields cannot grant this authority. Assignment status remains read-only.

Owner/pool/request-scoped action receipts let an exact retry recover its already
committed assignment without selecting new context or spending another allowance,
even if sources or the approved profile have since changed. Changed format,
instruction, candidate, trusted scope or immediate recheck source cannot reuse
that action identity. New actions still enforce current authority, source and
profile gates. Commissioning locks the action identity before the subject so
concurrent reuse across different subjects cannot race the request constraint.
After acquiring that lock, exact receipt recovery precedes source authorisation
and subject locking. This also covers a retry that began before the first
commission committed; recovery does not repeat canonical saves or start work.

The existing Recheck action recognises workforce drafts and commissions an
explicit new bounded Momus-only review of the exact submitted text against the
unchanged saved evidence and original draft. It does not resume/refill the old
assignment, conduct fresh research, invoke an author or grant another automatic
revision. Retries reuse their request identity. Original source, conversation and
checkpoint versions are revalidated; changed evidence is not silently refreshed.
Legacy recheck cannot accept workforce drafts, including when the pilot is
disabled. The submitted candidate and its explicitly unverified editor projection
are saved in the commissioning transaction, before a reviewer can claim the job.
A failed save rolls back both the assignment and job. The saved candidate remains
accessible if review has not started, fails, is cancelled or waits for attention;
an open editor still retains its own snapshot. A subsequent explicit recheck can
follow a cancelled pre-review checkpoint back through its version-bound lineage
to real accepted evidence/original-draft provenance. This does not fabricate an
accepted review or weaken the publishing gate.

`ATHENA_WORKFORCE_MANUAL_BLOG` defaults to disabled. Only an explicit enablement
registers the concrete executor, and that flag cannot supply a missing
owner-approved numeric budget. No numeric profile is seeded by the migrations.
The adapter/API
code is not proof of SQL race correctness, editorial quality, full existing-UI
integration or accepted operational pilot evidence. Those remain rollout gates,
and subsequent feature migrations remain gated on accepted blog-pilot evidence.

On 30 October 2026, Richard explicitly authorised the shared database changes
and production deployment. Migrations 123-126 were applied, an enabled profile
was configured for the existing production owner (60 calls including research
and retries, 1,000,000 reserved tokens and 30 minutes per assignment), and the
manual-blog executor was enabled in backend v276. The frontend keeps the
existing Start drafting, Background work and editor/Recheck surfaces. Publishing
remains manual. This is the deployed manual-blog pilot, not completion of the
later workforce migrations or a claim that live editorial acceptance has passed.

#### Manual-blog local pilot setup

The backend includes `npm run workforce:setup -- --help`. Setup is explicit,
does not generate content or publish, and never starts a worker. From
`knowledge-hub-backend`, use `npm run workforce:setup -- --check --owner <id>`
for read-only configuration readiness. The owner is the actual authenticated
application ID, not a display name; existing development authentication uses
`dev-user`. Missing migrations/profile or an unset executor flag produces a
nonzero readiness result with the next required step.

After draining incompatible workers, run
`npm run workforce:setup -- --apply --owner <id> --calls <approved-count> --tokens <approved-total> --minutes <approved-duration> --approve --workers-drained`.
Shared production data additionally requires `--shared-database`. No numeric
allowance is silently supplied. The command applies only workforce migrations
123-126 through the existing tracked/advisory-locked migration helper, refuses
missing earlier application migrations and running specialist jobs, and creates
an immutable owner-approved budget version. Repeating the current limits reuses
the current enabled profile; changing limits creates a version rather than
altering a running assignment's allowance. Existing profiles are not disabled.

Start the local backend with `ATHENA_WORKFORCE_MANUAL_BLOG=true` after setup;
keep its development mode and local worker-pool isolation. In Discover or Spark,
use the existing Start drafting action, choose Quick take/Article and inspect
the named stages in Background work. Open the saved candidate through its result
link. Editing stops automatic application; Recheck saves the submitted candidate
and commissions a separate Momus-only review. Publishing remains gated by the
exact reviewed content and the existing explicit send action. A configuration
readiness result is not operational or editorial acceptance evidence.
When the executor flag is enabled, startup also checks the tracked workforce
migrations and required runtime columns before starting any jobs. Incomplete
setup keeps readiness failed with a setup-specific error, rather than admitting
requests to a worker that cannot run them. The setup command uses the same check.

Specialist execution uses owned, renewable leases. Startup does not requeue
another worker's unexpired attempt; recovery only claims expired work in the
same pool and supported protocol. Draft checkpoints and generated Design,
Podcast and learning writes reject expired or superseded attempts. Equivalent
handoffs are serialised per subject, and a different request cannot silently
replace one already running. New assignment-backed steps are not admitted by
the shared worker until their versioned domain executor is installed.

The first rollout must drain incompatible old workers before leased work is
admitted. These changes do not increase concurrency or enable local automatic
delivery, migrate historical results into newly reviewed assignments, or claim
that existing standalone model calls already have assignment-wide budgets.

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
