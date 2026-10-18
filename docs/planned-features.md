# Planned features (not yet implemented)

Source: the October 2026 UX review and competitor research (Linear, Raycast, Notion, Obsidian, Capacities, Tana, Readwise Reader, Feedly, NotebookLM, Perplexity and others). **None of these exist yet.** Each is written so a new session can start without prior context.

Ground rules for every item:

- Athena is **desktop-first**. Do not build mobile or tablet layouts, except the standalone `/chat` screen.
- Follow the interface system in the README ("Consistent interface (desktop)"): shared `PageHeader`, 36px/32px control heights, heading/radius tokens, the canonical project/topic identity chip, the shared thin scrollbar, no text under 12px.
- Keep existing URLs, routes and data working. Add features; do not remove current behaviour.
- Before finishing: `tsc --noEmit` in `knowledge-hub-web` and `knowledge-hub-backend`, `npm run build`, `npm run test:isolated`. Deploying needs the user's explicit instruction (README/operations runbook). Next free migration number: 070.

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
- Backend: a read route returning, for a note, (a) notes that link to it and (b) notes whose text contains its exact title but are not linked. Cap and paginate.
- Frontend: a "Backlinks" section in `MetadataPanel` with a linked list and an "Unlinked mentions" list, each with a one-click "Link it" action. Respect the existing paginated, keyboard-accessible patterns.

**Acceptance:** opening a note shows who links to it; "Link it" converts a plain mention into a link and the backlink then appears.

## 3. `@` mentions in the note editor (effort M)

**Today:** BlockNote supports slash menus; `notes/editorSchema.ts` defines the schema.

**Build:**
- Typing `@` opens a menu (reuse the slash-menu mechanism). Phase 1 results: notes and **Athena**. Later phases: projects, people, dates.
- Choosing a note inserts an inline link (and so a backlink for item 2).
- `@Athena <instruction>` runs the instruction on the selected or current block using the existing Athena chat/edit API, and inserts the answer as a **visibly AI-attributed** block so the owner can always tell AI text from their own.

**Acceptance:** `@` lists notes and Athena; inserted note mentions are navigable; AI-written blocks are clearly marked and undoable.

## 4. "Why Athena picked this" in Discover (effort M)

**Today:** Discover is `pages/DiscoverPage.tsx` with `components/discover/DiscoverExplore.tsx` and `features/discover/discoverInsights.ts`; scoring comes from the backend discovery integration (`knowledge-hub-backend/src/integrations/discovery/`).

**Build:**
- Each pick shows a short reason (matched topics, source weight, recency, what the owner previously saved).
- A tunable interest control (topic or source weights) that changes ranking and is saved.
- On request, "What was filtered out this week" with a reason per item (the "why not" view).

**Acceptance:** every Discover card can explain itself; changing a weight visibly re-ranks; filtered items are viewable with reasons.

## 5. Keyboard triage and density toggle (effort S–M)

**Build:** in Discover and the Think list, single keys to archive, save, skip and create-from the focused item (j/k to move), a visible shortcut hint, and a compact/comfortable density toggle saved per area. Must not fire while typing in an input.

**Acceptance:** a user can clear a list with the keyboard alone; shortcuts are discoverable and disabled in text fields.

## 6. Content pipeline board (effort M)

**Build:** a board with stages (idea, draft, published) per content type (blog, newsletter, LinkedIn, podcast), threading Discover saves, Think Sparks/notes, Plan tasks and Build/publish. Likely a new view in Plan with a small backend model (check `knowledge-hub-backend/src/db/migrations/` for existing content workflow states before adding a table; use migration 070+). Optional counter on Today: "N ideas awaiting an angle", "N drafts stalled more than 7 days".

**Acceptance:** an item moves across stages and keeps its links back to the originating source or note.

## 7. Visible, editable Athena memory (effort S–M)

**Today:** `pages/MemoryPage.tsx` exists (Tools → Memory).

**Build:** show what Athena knows (voice, projects, recurring topics), allow edit and delete per item, and a "changed since last week" list with accept/reject.

**Acceptance:** every stored memory is listed, editable and removable; changes since the last visit are reviewable.

## 8. Standard empty states and page templates (effort S)

**Build:** one shared empty-state component (what this page is for, the main shortcut, one action) used by Today, Discover, Plan, Think, Build, Sources and Projects, with one-time, dismissible teaching text.

**Acceptance:** no area shows a blank list without guidance.

## 9. Spatial view and side-peek (effort M–L each)

- **Spatial view in Think:** an optional canvas for arranging Sparks and notes, reusing the existing canvas editor (`features/canvas/`). The flat list stays the default.
- **Side-peek:** open a linked note, source or Athena answer beside the current view using the shared `WorkspaceSidePanel` frame, instead of navigating away.

## Parked ideas

Angle Deck (swipe through "your angle" suggestions), timeline-of-thinking canvas, podcast "on air" Athena persona, source-staleness badges, voice-note capture routed to Today, cross-channel repurposing side-by-side, "ask the archive" (Athena scoped to the owner's published posts and episodes with citations).
