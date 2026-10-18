# Planned features (not yet implemented)

Source: the October 2026 UX review and competitor research (Linear, Raycast, Notion, Obsidian, Capacities, Tana, Readwise Reader, Feedly, NotebookLM, Perplexity and others). **None of these exist yet.** Each is written so a new session can start without prior context.

Ground rules for every item:

- Athena is **desktop-first**. Do not build mobile or tablet layouts, except the standalone `/chat` screen.
- Follow the interface system in the README ("Consistent interface (desktop)"): shared `PageHeader`, 36px/32px control heights, heading/radius tokens, the canonical project/topic identity chip, the shared thin scrollbar, no text under 12px.
- Keep existing URLs, routes and data working. Add features; do not remove current behaviour.
- Before finishing: `tsc --noEmit` in `knowledge-hub-web` and `knowledge-hub-backend`, `npm run build`, `npm run test:isolated`. Deploying needs the user's explicit instruction (README/operations runbook). Next free migration number: 082 (latest is `081_use_cases.sql`; always check `knowledge-hub-backend/src/db/migrations/` first).

## 0. Prerequisite: define a note-to-note link (do this once, before items 2 and 3)

Notes have **no note-to-note link today**. The only note links are canvas-to-note (`DiagramNoteLinks.tsx`, `linkCanvasNote`), and deep links use `/think?noteId=<id>`. Items 2 and 3 must share one definition, so decide and document it first:

- **Format:** an inline BlockNote mention node, `{ type: 'noteMention', props: { noteId } }`, defined in `notes/editorSchema.ts`. The title is display-only and always read from the note, so renames do not break links.
- **Storage for backlinks:** a table `note_links (source_note_id, target_note_id, created_at)` in migration 082 (or the next free number), rebuilt from the note's content on every save (delete then insert for that source note), so it can be regenerated and never drifts.
- **Behaviour:** a link to a deleted or recycled note renders as "Unavailable note" and is excluded from backlinks. Navigation uses `/think?noteId=<id>`.
- Items 2 (backlinks) and 3 (`@` mentions and `[[` wiki links) both read and write only this format.

Suggested order is the order below (value against effort).

## 1. Command palette actions (effort S–M)

**Today:** `knowledge-hub-web/src/components/CommandPalette.tsx` (Cmd+K / Ctrl+K) only navigates to destinations, using groups from `navigation/destinations.ts`.

**Build:**
- Search across notes, tasks, sources, projects and Discover items from one input; open the result in place (a note opens in Think, a source in Sources).
- Add actions: capture a Spark, new note, new task, open Athena with the current page context, jump to a saved view.
- Recent items first when the input is empty. Arrow keys, Enter, Escape; keep the native modal dialog, focus trap and focus return that exist today.

**Acceptance:** one Cmd+K reaches any note/task/source/project by title and runs the listed actions; no new global search backend is required if existing list endpoints suffice (otherwise add one read-only search route with a result cap).

## 2. Backlinks and unlinked mentions in Think (effort M)

**Why:** link density, not folders, helps refind things. Do **not** add deeper folders.

**Today:** note editor is `notes/NoteEditor.tsx` (BlockNote via `BlockNoteViewWrapper.tsx`); side details are in `notes/MetadataPanel.tsx`.

**Build:**
- Backend: a read route returning, for a note, (a) notes that link to it (from `note_links`, see section 0) and (b) notes whose text contains its exact title but are not linked. Cap and paginate.
- Frontend: a "Backlinks" section in `MetadataPanel` with a linked list and an "Unlinked mentions" list, each with a one-click "Link it" action. Respect the existing paginated, keyboard-accessible patterns.

**Acceptance:** opening a note shows who links to it; "Link it" converts a plain mention into a link and the backlink then appears.

## 3. `@` mentions and `[[` wiki links in the note editor (effort M)

**Today:** BlockNote supports slash menus; `notes/editorSchema.ts` defines the schema.

**Build:**
- Typing `@` or `[[` opens a link menu (reuse the slash-menu mechanism). Both triggers produce the same `noteMention` node (section 0); `[[` is the wiki-link habit, `@` also offers Athena.
- Phase 1 results: notes matching the typed text, and **Athena** (`@` only). Later phases: projects, people, dates.
- **Link to an existing note:** choosing a note inserts a `noteMention`, which produces the backlink for item 2.
- **Link to a new note:** when no note matches, the menu offers **Create note "<typed text>"**. This creates a note whose first line (its title) is the typed text, in the current note's project, and inserts a mention to it. The new note opens only if the owner chooses to; the current note stays in place.
- Typing `[[topic]]` in full and closing the brackets behaves the same: link to the exact-title match if one exists, otherwise offer to create it. Never create a note silently.
- Pasted Markdown containing `[[topic]]` is left as plain text, and appears in item 2's "Unlinked mentions" for one-click linking.
- `@Athena <instruction>` runs the instruction on the selected or current block using the existing Athena chat/edit API, and inserts the answer as a **visibly AI-attributed** block so the owner can always tell AI text from their own.

**Acceptance:** `@` and `[[` list matching notes (and Athena for `@`); choosing a note or creating one inserts a navigable link and a backlink; no note is created without an explicit choice; AI-written blocks are clearly marked and undoable.

## 4. "Why Athena picked this" in Discover — merged into item 11

Pick reasons and server-side interest weights are now built as part of Discover Watchlists (item 11). The original detail is kept below for reference.

**Today:** Discover is `pages/DiscoverPage.tsx` with `components/discover/DiscoverExplore.tsx` and `features/discover/discoverInsights.ts`; scoring comes from the backend discovery integration (`knowledge-hub-backend/src/integrations/discovery/`).

**Build:**
- Each pick shows a short reason (matched topics, source weight, recency, what the owner previously saved).
- A tunable interest control (topic and source weights, 0 to 2, default 1) that changes ranking. Weights are stored **server-side**, in a small table in migration 082 or later, so they follow the account across browsers. (Discover's "last seen" timestamps are browser-local today; do not copy that for weights.)
- On request, "What was filtered out this week" with a reason per item (the "why not" view).

**Acceptance:** every Discover card can explain itself; changing a weight visibly re-ranks and **persists after a reload and in a different browser**; filtered items are viewable with reasons.

## 5. Keyboard triage and density toggle (effort S–M)

**Build:** in Discover and the Think list, single keys to archive, save, skip and create-from the focused item (j/k to move), a visible shortcut hint, and a compact/comfortable density toggle saved per area. Must not fire while typing in an input.

**Acceptance:** a user can clear a list with the keyboard alone; shortcuts are discoverable and disabled in text fields.

## 6. Content pipeline board (effort M)

**Build:** a board with stages (idea, draft, published) per content type (blog, newsletter, LinkedIn, podcast), threading Discover saves, Think Sparks/notes, Plan tasks and Build/publish. Likely a new view in Plan with a small backend model (check `knowledge-hub-backend/src/db/migrations/` for existing content workflow states before adding a table; use migration 082 or later). Optional counter on Today: "N ideas awaiting an angle", "N drafts stalled more than 7 days".

**Acceptance:** an item moves across stages and keeps its links back to the originating source or note.

## 7. Visible, editable Athena memory (effort S–M)

**Today:** `pages/MemoryPage.tsx` exists (Tools → Memory).

**Build:** show what Athena knows (voice, projects, recurring topics), allow edit and delete per item, and a "changed since last week" list with accept/reject.

**Acceptance:** every stored memory is listed, editable and removable; changes since the last visit are reviewable.

## 8. Standard empty states and page templates (effort S)

**Build:** one shared empty-state component (what this page is for, the main shortcut, one action) used by Today, Discover, Plan, Think, Build, Sources and Projects, with one-time, dismissible teaching text.

**Acceptance:** no area shows a blank list without guidance.

## 9. Spatial view in Think (effort M–L)

**Build:** an optional canvas for arranging Sparks and notes, reusing the existing canvas editor (`features/canvas/`). The flat list stays the default; a toggle in Think switches views, and the choice is remembered.

**Acceptance:** Sparks and notes can be placed, moved and linked on the canvas; positions persist; the list view is unaffected.

## 10. Side-peek (effort M–L)

**Build:** open a linked note, source or Athena answer beside the current view using the shared `WorkspaceSidePanel` frame, instead of navigating away. Start with note mentions and backlinks (items 2 and 3).

**Acceptance:** clicking a note mention opens it in a side panel with a close control and focus return; the current page and its scroll position are untouched; Escape closes it.

## 11. Discover Watchlists: competitive and market monitoring (effort L)

**Spec:** `docs/specs/competitor-watchlists.md` (product spec use case 5). Tracked as a use case in Plan → Use cases.

**Build (first version, once the spec's open questions are answered):**
- A **Watchlists** view in Discover, not a new top-level area. App-wide, with optional project links.
- A watchlist holds: a question, monitored organisations and products with relationship labels, a **versioned** baseline, comparison criteria, cadence, and active or paused state. Store it server-side in migration 082 or later.
- Reuse Discover ingestion and `content_items`; link findings to those items rather than copying articles. De-duplicate syndicated press releases so one event is one source.
- A scheduled run writes dated findings (what changed, why it matters, what is uncertain, whether to respond), each citing its articles and the baseline version it used. "No meaningful change" is a stored, valid result.
- Athena tool access to saved findings, so it can answer "What changed this month?" with citations.
- Item 4's pick reasons and server-side weights are delivered here.
- Each finding offers "→ Use case".

**Acceptance:** one watchlist with about five organisations produces a weekly brief whose every claim links to evidence and a baseline version; syndicated copies count once; a quiet week shows "No meaningful change"; Athena answers questions from the saved findings without re-researching.

## Parked ideas

Angle Deck (swipe through "your angle" suggestions), timeline-of-thinking canvas, voice-note capture routed to Today, cross-channel repurposing side-by-side, source-staleness badges, "ask the archive" (Athena scoped to the owner's published posts and episodes with citations). Also a podcast "on air" persona: this would be a *talking-points* mode (conversational bullets for recording) and is different from the existing **Show Notes** persona (`knowledge-hub-backend/src/ai/showNotesPersona.ts`), which turns a finished transcript into show notes, a companion post and social posts. Do not merge or duplicate them.
