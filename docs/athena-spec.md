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

Open-ended work is conversational, not output-first. Athena actively explores Richard's goals, reasoning, priorities and trade-offs through focused questions and constructive challenge. An exploratory exchange starts with a brief observation or challenge and one substantive question, then develops through his answers before settling on a recommendation. One question at a time does not mean only one per conversation. She uses known or retrievable facts rather than asking Richard to repeat them, but those facts do not replace understanding his choices. Clear factual questions, agreed unambiguous actions and explicit requests for an immediate draft still receive a direct response.

Across personas, Athena pushes back on unsupported premises, conflicting requirements and approaches that will not achieve the stated goal. She explains the concern and asks the question needed to resolve it, rather than producing a confident answer on an unresolved premise or agreeing to keep things moving.

The current intent determines the working mode, not the topic or selected persona: "help me design a demo" invites dialogue; "generate the specification from what we agreed" calls for action without reopening decisions. Clear standalone action requests do not require prior discussion. Athena switches modes as the conversation develops.

Her personality is curious, candid, warm and understated. She recognises playful sarcasm and can reciprocate with dry wit, while taking frustration seriously, particularly when she caused it. Humour is contextual, not mandatory; it must not trivialise a concern or turn sarcasm into permission to act.

Note reviews include native table cells and nested text, preserving row and cell boundaries in both the current-note chat context and backend note rendering. Proposed edits are not saved changes: Apply/Discard remains explicit. Invalid edit batches are rejected rather than silently proposing only the valid subset. If time runs out after proposals are produced, Athena reports the available preview and unfinished verification instead of telling Richard to repeat the request.

The learning loop reuses Memory's approval-based suggestions. Weekly review pairs each user correction with its preceding assistant reply, records the source conversation and verifies the supporting user quote. It can propose collaboration and verification preferences as well as style preferences; it must not treat assistant assertions as user instructions, generalise one-off prototype permissions or turn software defects into user workarounds. Suggestions remain inactive until approved. Deterministic defects belong in fixes and regression tests, not learned excuses.

It runs as a desktop web app at athena.themicrosoftcloudblog.com, with the Athena Desktop (Electron) wrapper, which also captures local M365 reports. The standalone `/chat` page is the only screen designed for mobile. A Raycast extension and an Android app (`knowledge-hub-raycast`, `knowledge-hub-app`) are secondary clients.

## 2. Primary use cases

In priority order:

1. **Ideas to product specs and Imagine demos.**
   - Spot an idea in Discover, a Spark, a note or a diagram.
   - Shape it into a spec for a product: an Imagine demo, the Imagine demo platform, or another IBM or personal product.
   - Hand it to GitHub Copilot to build. That is usually an interactive GitHub Copilot session; Athena Build is the option for clear, separable work.
   - See section 6.
2. **Podcast topic organisation.** Each Thursday Athena prepares a ranked topic brief for the Friday recording, threaded to earlier episodes. Richard reshapes it in conversation, and the show notes persona writes the notes. Tracking topics over time matters here and in competitive monitoring (use case 5); nowhere else.
3. **Content.** Once Richard picks a topic (often a Discover item), Athena writes the blog or LinkedIn post and it is published soon after. There is deliberately **no** drafting pipeline or stage tracking for content.
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
| **Share** | Manual, review-before-send emails through SMTP2GO (Mural links, draw.io attachments, GitHub note links), Mural export, GitHub note publishing and Bluesky posting. Nothing is sent or posted automatically. |
| **Management** | Tag Manager, repo-to-tag and repo-to-project mappings, Knowledge health (AI usage, sync runs, index freshness), practice-exam score history, and voice transcription and speech. |

Old routes (`/tasks`, `/calendar`, `/notes`, `/documents`, `/timeline`, `/search`, `/ai`, `/blog-post`) redirect to the areas above.

### Athena chat motion

Chat uses the supplied [Athena Ribbon](specs/athena-ribbon.md) Canvas renderer: a glowing, twisted cyan ribbon inside a glass sphere, with all nine supplied moods and the original 380ms parameter easing. Its host background is transparent. The welcome character is 240px with pointer tracking; assistant-message characters and the single travelling character stay 56px. Only the latest message animates; older messages use settled `still` poses. The travelling character moves from above the composer to the working slot, then the accepted answer's corner and back without resizing; there is no duplicate header avatar. The existing 1.5-second answer entrance/return plays once for the accepted reply, never provisional text from tool rounds or evidence repairs. Progress stays visible until completion, including when asking another model.

The latest accepted reply's follow-up suggestions appear one at a time beside the resting character, not as large pills below the answer. If a reply has no follow-ups, including restored history, local note/document prompts or conversation starters keep the helper useful. The empty-chat starter prompts also live here rather than in a second set of pills. Suggestions rotate every seven seconds without playback or next controls; rotation pauses on hover, keyboard focus and hidden/offscreen panels. Reduced motion keeps the first suggestion static. Hover underlines the suggestion without changing its background. Selecting a suggestion fills and focuses the composer without submitting it. Suggestions hide while a draft is present or Athena is working, recording, transcribing or restoring history. No extra model calls generate or rotate these suggestions.

All chat surfaces share one mood controller: typing/mic input listens, pending work thinks, and accepted answers answer for 1500ms. Explicit errors show `sorry` alongside the existing error text; successful positive feedback/thanks shows `happy`; completed tasks/actions or saved outputs show `excited`; suggestions show `curious`; evidence warnings or the explicit format-clarification prompt show `unsure`. Emotions last 2500ms and never override a new active turn. No model confidence is guessed from prose or added to the backend contract. Progress updates, including wrapped messages, restoration and note-summary loading, remain below the thinker. Scrolling the active reply out of view returns the character to the composer without moving the reader's scroll position. Reduced motion freezes oscillation and pointer tracking while permitting the mood shape to settle, then stops frames. Hidden/offscreen instances cancel both RAF and timer callbacks. Pending-turn elapsed time and Stop controls remain available.

Reply metadata sits in a quiet reference area below the answer. **Context & references** expands the project, instructions, current document and source details; its collapsed summary shows counts instead of repeating long titles. Source groups retain their Cited/Read/Found distinctions, links, notices and per-chat inclusion controls.

### Knowledge atlas

The atlas reads existing entity records and saved relationships without creating a second authoritative graph. It includes company/programme links, people and roles, note links, decisions and semantic relationships alongside indexed source connections. Inferred links are hidden by default and never presented as confirmed roles or facts. Positions organise neighbourhoods; distance does not measure relationship strength.

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
