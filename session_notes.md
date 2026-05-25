# Session Summary & Notes

## Session: 25 May 2026 — Cert Tracker Rollback & Rebuild + Tag Consolidation Completion

### 1. Tag Consolidation — Final State
- Previous session had consolidated 476 → 111 tags via `collapse-tags.ts` and `collapse-arch-tags.ts`
- This session added **9 curated Architecture & Method sub-tags** under `architecture-and-method`: API Design, Cloud Architecture, Design System, DevSecOps, Migration, Platform Engineering, Reference Architecture, Solution Design, Well-Architected
- Total tags: **121** (120 + Certification added this session)
- Added **Certification** concept tag as a child of `devops-and-automation`

### 2. Cert Feature — Full Rollback
The previous session had built a complex cert learning tracker (separate DB tables, routes, views). This was rolled back in full:

**DB:** Dropped all cert tables and enums:
- `cert_output_tags`, `cert_practice_scores`, `cert_outputs`, `cert_sessions`, `cert_programmes`
- Dropped associated Postgres enums

**Backend routes deleted:**
- `src/routes/cert.ts` — removed
- `src/seeds/cert-programme.ts` — removed
- Deregistered from `app.ts`

**Frontend removed:**
- `features/cert/` directory (all 4 components: `CertLearningView`, `CertOutputsFeed`, `CertSessionPanel`, `CertThinkView`)
- `types/cert.ts`
- Learning tab removed from `PlanPage`
- `CertOutputsFeed` removed from `TimelinePage`
- Cert mode removed from `NotesPage` (restored to 3-mode: notes/canvas/sparks)

### 3. Cert Feature — Correct Implementation (per spec)
Simple design: `task_type` on existing tasks + one new table.

**Schema (Change 021):**
```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'standard';
CREATE TABLE IF NOT EXISTS cert_practice_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_code TEXT NOT NULL,
  score INT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  notes TEXT,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**New API routes (`/api/cert-scores`):**
- `POST /api/cert-scores` — log a score: `{ cert_code, score, task_id?, notes? }`
- `GET /api/cert-scores?cert_code=` — fetch history ordered by `taken_at DESC`

**API service (`services/api.ts`):**
- `postCertScore(payload)` — posts a practice score
- `getCertScores(certCode)` — fetches score history

**Tasks page (`TasksPage.tsx`):**
- New type `TaskType = 'standard' | 'cert_session' | 'cert_review'`
- `task_type` added to `Task` interface
- Task type filter `<Select>` added to board controls (filters board columns)
- `TaskModal` now includes:
  - Task Type selector (Standard / Cert session / Cert review) — saved on submit
  - Repeats row restored as half-width row
  - **Cert score panel** (shown only for `cert_review` tasks when editing): cert code input, score input (0–100), "Log score" button, score history list below

### 4. Styling — All New Classes Added to `global.scss`
Previously-unstyled classes now fully defined:
- **`kb-modal-form__row`** — two-column grid layout; `--half-left` variant for single half-width field
- **`kb-task-activity__*`** — tab bar (underline active), badge pills, log entries, textarea + add-note button, linked items list, search input + results
- **`kb-cert-scores__*`** — score history rows (mono score, date, notes; alternating backgrounds)

### 5. tsc — Both Packages Clean
- `knowledge-hub-backend`: exit 0
- `knowledge-hub-web`: exit 0

---

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