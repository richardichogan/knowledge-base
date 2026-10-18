# Athena: product spec

This is the current product spec for Athena. It supersedes `2026-04-12-knowledge-hub-spec.md`.

- For feature-by-feature detail of what is built, see `README.md`.
- For engineering rules, see `constitution.md`.
- For the backlog, see `docs/planned-features.md`.

## 1. What Athena is

Athena is Richard's personal, single-user work hub, and the AI assistant (also called Athena) inside it. It brings together:

- what he reads (Discover, Sources);
- what he thinks (Think: notes, Sparks, canvases);
- what he plans (Plan, Projects);
- what he ships (Build).

Athena does most of the writing. Richard mostly prompts, decides and reviews; he does not usually draft by hand.

It runs as a desktop web app at athena.themicrosoftcloudblog.com, with the Athena Desktop (Electron) wrapper. The standalone `/chat` page is the only screen designed for mobile.

## 2. Primary use cases

In priority order:

1. **Ideas to product specs and Imagine demos.**
   - Spot an idea in Discover, a Spark, a note or a diagram.
   - Shape it into a spec for a product: an Imagine demo, the Imagine demo platform, or another IBM or personal product.
   - Hand it to GitHub Copilot to build. That is usually an interactive GitHub Copilot session; Athena Build is the option for clear, separable work.
   - See section 6.
2. **Podcast topic organisation.** Each Thursday Athena prepares a ranked topic brief for the Friday recording, threaded to earlier episodes. Richard reshapes it in conversation, and the show notes persona writes the notes. The podcast is the one place where tracking topics over time matters.
3. **Content.** Once Richard picks a topic (often a Discover item), Athena writes the blog or LinkedIn post and it is published soon after. There is deliberately **no** drafting pipeline or stage tracking for content.
4. **Programme governance and communications** (parked).
   - The intent is for Athena to coach the areas Richard finds hardest: governance discipline (owners, dates, reviews, escalation, steering readiness) and communications (drafts written for the reader, difficult messages, reviewing his own drafts).
   - Athena helps; it does not run the programme.
   - No work is planned until this is picked up again.

## 3. Areas

| Area | Role |
|---|---|
| **Today** (`/`) | What needs attention now: overdue, blocked or due tasks; failed connections; open Athena decisions; continue-working items; recent changes; and suggestions worth exploring (Discover picks with a reason, growing Spark themes). Also shows the Thursday podcast prep. |
| **Discover** (`/discover`) | A ranked feed of articles from Microsoft and industry sources, weighted by relevance, freshness, authority and project fit. Also covers calls for papers (CFPs). Items can be saved, turned into Sparks, or turned into quick LinkedIn and blog posts. |
| **Plan** (`/plan`) | Tasks in Board and Focus views, with saved views, Athena check-ins and at-risk prompts. Open use cases appear in the Board's Backlog or In Progress columns without creating duplicate task records. |
| **Think** (`/think`) | Notes (BlockNote editor with history, tags and GitHub publishing), **Sparks** (capture, connect into themes, mature, ship) and **canvases** (diagrams with drilldowns and links to notes). |
| **Build** (`/build`) | Specs are split into dependency-ordered tasks and dispatched to GitHub cloud coding agents (Copilot or Claude) as issues. Their PRs are tracked and merged. |
| **Athena chat** | Available everywhere: a side panel, a floating widget and `/chat`. It has personas: general, brainstorming, blog post, LinkedIn, demo designer, web designer, podcast prep, podcast show notes and Copilot coach. Chats record decisions and Outputs, and can be turned into a spec note. |
| **Activity** (`/my-work`) | Activity from connected systems (calendar, email, GitHub and others), plus connections and sync. |
| **Sources** (`/library`) | Indexed documents and source material, searchable and used for grounding. |
| **Knowledge graph** (`/graph`) | Connections across Athena's objects. |
| **Memory** (`/memory`) | What Athena remembers about Richard and his work. |
| **Projects** (`/projects`) | Project goal, role, dates, expected outputs, and the project **cockpit**, which holds the register of questions, risks and issues, and review packets. |
| **Management** | Tag Manager, repo-to-tag and repo-to-project mappings, and Knowledge health (AI usage, sync runs, index freshness). |

## 4. Core objects

- **Project:** the scope most other objects belong to. It carries the context Athena reloads on every turn.
- **Note:** a rich document in Think. It can be versioned, tagged, published to GitHub, or turned into a Build spec.
- **Spark:** a captured idea with its source. Sparks cluster into **themes**, which can become a note, canvas, project or blog post.
- **Canvas:** a diagram, which can link to notes and drill down into other diagrams.
- **Content item:** a Discover article or other indexed source.
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

- **Built:** everything in section 3. The README documents each feature in detail.
- **Built since this spec was written:** use cases (section 6).
- **Planned:** `docs/planned-features.md`, which covers the command palette, backlinks, `@` mentions, "why Athena picked this", keyboard triage, memory editing, empty states, a spatial view and side-peek. Its "content pipeline board" (item 6) is superseded by section 2: only the podcast needs topic tracking.
- **Assessed, not planned:** Fabric and Fabric IQ (`docs/fabric-iq-assessment.md`).
