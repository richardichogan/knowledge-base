---
target: Plan
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
timestamp: 2026-11-03T06-33-26Z
slug: knowledge-hub-web-src-pages-planpage-tsx
---
Method: dual-agent (A: main-pages-design; B: main-pages-evidence), supplemented by parent live desktop inspection.

# Discover, Plan, Think and Build critique

No application changes or production-content mutations. Preserve the Athena Carbon quiet workbench, existing editors, properties and action locations. This is not approval for a redesign.

| Heuristic | Discover | Plan | Think | Build |
|-----------|----------|------|-------|-------|
| System status | 3 | 3 | 3 | 2 |
| Real-world match | 2 | 2 | 3 | 3 |
| User control | 3 | 2 | 3 | 1 |
| Consistency | 3 | 3 | 3 | 2 |
| Error prevention | 3 | 2 | 3 | 2 |
| Recognition | 3 | 3 | 2 | 3 |
| Efficiency | 3 | 3 | 2 | 2 |
| Minimalism | 3 | 2 | 3 | 3 |
| Error recovery | 3 | 3 | 3 | 1 |
| Help | 2 | 2 | 2 | 3 |
| Total /40 | 28 | 25 | 27 | 22 |

Each heuristic is scored out of four. Scores are directional, not usability-test results. Build's populated/editor states were source-reviewed only.

## Specificity and strengths

All four pages use Athena's visual language rather than a generic dashboard. Discover's ranked briefing and direct editorial actions work well. Plan makes work state and provenance visible. Think preserves its editor and Design structure with readable text. Build explains its spec-to-PR execution purpose, with confirmations around high-stakes execution.

## Discover

- P2: Inbox header falls through to article count/loading state, rather than email state. Source-confirmed in DiscoverPage.tsx header logic. Fix active-view terminology and status; clarify/harden.
- P2: Saved, Parking lot, Shelved and Archived consequences require learning a hidden taxonomy. Explain the existing actions without merging states or changing approved workflows; clarify.
- P2: No local article search/filter in the inspected workspace; global Search remains present. With 589 articles and 24 pages, known-item retrieval may require leaving this workspace. Agree any retrieval control before adding it; shape.

## Plan

- P1: Task Options Delete directly invokes deletion without a confirmation or visible undo in the inspected flow (TasksPage.tsx:132-136,1121-1126). Source finding, not exercised on live data. Agree established confirmation/recovery boundary; harden.
- P2: Header is cramped in the 744 CSS-pixel desktop canvas; project and tag filter text clips and views become icons. Retain current controls but improve fit at narrow desktop widths; layout.
- P2: Focus has no direct Add task action in source; creation exists on Board. Agree whether creation should be available there; clarify/shape.
- Product decision: Plan still offers New use case, despite Think being the content-development workspace. Do not relocate or remove anything without agreement.

## Think

- P1: Main Notes disables existing local search/sort/grouping controls with showTools=false (NotesPage.tsx:768-782; NoteList.tsx:86-87,239-303). Live view shows 100 of 181 documents and Load more, with global Search still available. Agree restoration of local retrieval controls without moving editor/properties; shape.
- P2: View switcher declares tabs without matching arrow-key/roving-focus/panel contract in the source. Canvas rows handle Enter but not Space and contain nested deletion controls (NotesPage.tsx:663-677,808-821). Source-confirmed accessibility concerns, keyboard journey not exercised; harden.

## Build

- P1: List failures can display No specs yet; detail failures can remain Loading spec indefinitely (BuildPage.tsx:260-264,295,477-497). Live page displayed No specs yet, but its displayed state alone cannot prove the request failed. Implement distinct loading/empty/error with retry; harden.
- P1: Changing selected spec resets an unsaved draft without a dirty-state boundary (BuildPage.tsx:285-287,483-486,505-511). Not exercised because no populated build was available. Agree save/discard/cancel or recoverable drafts; harden.
- P1: Inspected Build page lacks selected-spec Athena context wiring for markdown, tasks and events (BuildPage.tsx:7-27,471-519). This is a page-context gap, not proof backend tools are absent. Wire existing mechanisms and verify supported reads/writes; shape.
- P2: Live empty state says Pick a spec on the left despite showing no list entries, duplicating creation guidance. Make the detail empty state agree with available content; clarify.

## Cognitive load, personas and emotional journey

Power-user retrieval is the biggest recurring concern in Discover and Think. First-time users must learn Discover retention states and the Think/Plan creation boundary. Keyboard-dependent users face source-level Think semantics gaps. Plan's narrow-desktop header imposes scanning cost. Build's execution narrative is reassuring, but false empty/loading states and silent draft loss undermine trust.

## Evidence and limitations

Bundled detector ran once on the four route entry sources and returned [] (zero findings). No false positives or user-visible overlay. Agent browser sessions were unavailable; parent inspected Discover populated list/detail, Plan Board, Think populated editor and Build empty state in one desktop canvas (744 CSS pixels). No mobile, destructive actions, posting, generation or build execution. Wide-desktop, computed contrast, keyboard and failure journeys remain unverified. No claim that zero static findings establishes accessibility.

## Decisions

Prioritize safe clarity/layout changes versus Build recovery and editing safeguards. Discuss local retrieval controls and content-creation ownership before changing placement, properties, workflows or scope.
