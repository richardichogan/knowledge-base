# Session Summary & Notes

## Session: 10 May 2026 — Discover Feed Scoring Fixes & Admin Tooling

### 1. Relevance Scoring Prompt — Full Rebalance
- Community posts (MVPs, personal blogs, forums, Reddit) were ranking too high due to insufficient penalty
- **Fix:** Penalty increased from -0.1 → -0.3, hard cap added at **0.35** regardless of topic
- Community posts are now always below official Microsoft sources and Microsoft Research
- Prompt explicitly states community content is derivative and lower value

### 2. Admin Score Endpoints Added (`/api/discover/admin/`)
- `GET /api/discover/admin/score-status` — returns total/unscored count + sample of unscored articles (no DB connection needed)
- `POST /api/discover/admin/score-batch` — triggers immediate scoring of next 10 unscored articles
- Both secured via `x-cron-secret` header (bypasses JWT so they can be called from terminal)
- Auth middleware updated to skip JWT for `/admin/` paths

### 3. All 169 Articles Re-scored
- Cleared all existing scores via `UPDATE content_items SET relevance_score = NULL...`
- Re-scored all 169 articles using the new prompt via 16 batch calls
- Feed now ordered: official MS announcements → Research → press → community (≤0.35)
- Order is: `relevance_score DESC, published_at DESC`

### 4. Scoring Prompt — Current Final State
**Topic priority (score band):**
1. Azure → 0.7–1.0
2. GitHub & GitHub Copilot → 0.6–0.9
3. M365 & M365 Copilot → 0.5–0.8
4. Microsoft Research → 0.4–0.7
5. Everything else Microsoft → 0.3–0.6
6. Non-Microsoft → 0.0–0.3

**Source authority (adjustment within band):**
- Official Microsoft sources → +0.1
- Major tech press → neutral
- Community/personal blogs/MVPs/Reddit → -0.3, **capped at 0.35**

**Article type (minor adjustment):**
- Thought leadership / product announcement → +0.05
- Case study → neutral
- General update / how-to → -0.05

---

## Previous Sessions

### 1. Projects Page Visual & UI Fixes
* **Removed Carbon Tile Component**: Stripped out the restrictive `Tile` component in favor of plain `div`s with explicit Carbon CSS vars/pixels to fix invisible card layouts.
* **Source Badges**: Added clear GitLab and GitHub icon badges on project cards to indicate their source.

### 2. Projects Database Migration & CRUD
* **Moved to PostgreSQL**: Migrated the existing JSON file store to a fully fleshed out `projects` table in PostgreSQL.
* **Added Metadata Fields**: Expanded project records to include a `category` field (work, personal, side-hustle) and a `priority` field (low, medium, high).
* **Full API Implementation**: Built the backend CRUD routes (`/api/projects`) to support creating and editing local projects accurately without overwriting remote GitHub/GitLab data.

### 3. Notes Enhancements (Project Assignment & Global Tags)
* **Project Linking**: Appended a `project_id` column to the `notes` table so notes can be assigned directly to specific projects.
* **Global Tags System**: Created a `global_tags` table that tracks tag usage. Whenever notes or projects are saved, tags are upserted into this table and ordered by `usage_count`.
* **Tag Autocomplete API**: Added a new GET `/api/tags` route to power autocomplete dropdowns across the frontend.
* **MetadataBar Rewrite**: Refactored `MetadataBar.tsx` on the Notes page to use a ComboBox for project selection, along with a new ComboBox for adding tags.
* **Tag Pills UI**: Added tag pills displaying inside the `MetadataBar` and Projects modal, including an "×" button to remove them. Wrote custom CSS (e.g., `.notes-tag-pills`, `.proj-tag-pills-edit`) to style these neatly.
* **Server Verification**: Successfully restarted the multi-server environment (`concurrently` for Vite and Node/Express) and validated the backend tag endpoints.

### Next / Pending Work (Content Store)
* A large request was queued to integrate `richardichogan/content-store` as a special markdown content repository. 
* This will involve GitHub API checks, parsing `.md` frontmatter, replacing project relationships, and rendering them as read-only synced notes with a Teal Carbon tag.