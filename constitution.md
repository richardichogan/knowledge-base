# constitution.md

> This file is the authoritative guide for GitHub Copilot and all AI agents working in this
> repository. Read it in full before touching any file. It has two sections:
> **Repo Conventions** (permanent, codebase-wide rules) and
> **Current Session** (the active feature being built).

---

## Repo Conventions

### Repository overview

**Personal Knowledge Hub** — a single-user productivity system that aggregates content from
GitHub, GitLab, Microsoft 365 (Planner tasks, calendar), RSS/podcast feeds, and personal
notes into one web application. Owner: Richard Hogan. All data belongs to one user; there
is no multi-tenancy.

**Monorepo structure:**

```
knowledge-hub-backend/   Node.js / Express / TypeScript backend (port 3000)
knowledge-hub-web/       React / TypeScript / Carbon Design System frontend (port 5173)
knowledge-hub-raycast/   Raycast extension (rarely touched)
infra/                   Bicep IaC for Azure resources
data/                    Static reference data (projects.json etc.)
scripts/                 One-off maintenance scripts
```

---

### Infrastructure and deployment

| Resource | Value |
|---|---|
| Azure subscription | **Alliance Tenant Reporting** |
| Resource group | `rg-knowledge-hub-prod` |
| Frontend (SWA) | `kh-prod-web` → `https://nice-mud-0f780fb03.7.azurestaticapps.net` |
| Backend (Container App) | `knowledge-hub-backend` in the same RG |
| Database | Azure Database for PostgreSQL Flexible Server: `kh-prod-pg-r6mgdn.postgres.database.azure.com` |
| Blob storage | Azure Storage Account (CMS/images) |
| AI | Azure AI Foundry (OpenAI-compatible endpoint) — `gpt-4o` and `gpt-4o-mini` deployments |
| Speech | Azure AI Services Speech REST API (`uksouth`) |

**Deploy frontend:**
```sh
az account set --subscription "Alliance Tenant Reporting"
cd knowledge-hub-web && npm run build
TOKEN=$(az staticwebapp secrets list --name kh-prod-web --resource-group rg-knowledge-hub-prod --query "properties.apiKey" -o tsv)
npx --yes @azure/static-web-apps-cli deploy dist --deployment-token $TOKEN --env production
```

**Deploy backend:** Push to `main`; CI/CD pipeline re-deploys the Container App. Or use
`az containerapp update` / Docker push for manual deploys.

**Run locally:**
```sh
# Backend (port 3000)
cd knowledge-hub-backend && node --import tsx/esm src/server.ts

# Frontend (port 5173, strictPort)
cd knowledge-hub-web && npm run dev
```
SKIP_AUTH=true in the backend .env bypasses JWT so the UI works without a login flow locally.

---

### Database

PostgreSQL (Azure Flexible Server). Connection string in `DATABASE_URL` env var.

**Migration pattern:** numbered SQL files in `knowledge-hub-backend/src/db/migrations/`.
Run with `npm run migrate` (in the backend package). Always add a new migration file —
never ALTER the existing ones. Name them `NNN_description.sql` using the next number.

**Key tables (all in `public` schema):**

| Table | Purpose |
|---|---|
| `content_items` | Discover feed — articles, GitHub commits/PRs/issues, docs. Source types: `github-commit`, `github-pr`, `github-issue`, `github-action`, `github-deployment`, `github-doc`, `discovered-article`, `email`, `podcast-episode`, `gitlab-commit`, etc. |
| `discover_item_tags` | Junction: `discover_item_id → content_items.id`, `tag_id → tags.id`, `is_primary BOOL` |
| `tags` | Taxonomy. Two-level hierarchy (no grandchildren enforced by trigger). Columns: `id, name, slug, parent_id, colour, role (filing\|concept), created_at, updated_at` |
| `note_tags` | Junction: `note_id, tag_id` |
| `task_tags` | Junction: `task_id, tag_id` |
| `notes` | Think-page notes. `content` column stores **JSON-serialised payload** `{title, contentType, contentJson, githubPath}` — never treat it as plain text. Use `fetchNotes()` from `notes/noteStorage.ts` to get parsed titles. |
| `tasks` | Planner tasks. Synced from Microsoft Graph. |
| `sparks` | Quick-capture thoughts. Columns: `id, source_id, source_type, body, tags[], cluster_id, created_at` |
| `spark_clusters` | AI-clustered spark groups. Columns: `id, theme, spark_count, surfaced, surfaced_at, dismissed, created_at, updated_at` |
| `ai_chat_sessions` | Athena chat session records with rolling summaries |
| `ai_chat_messages` | Per-session message history |
| `nodes` / `edges` | Knowledge graph (exists, not yet populated — wiring pending Gap 5 work) |
| `repo_tag_mappings` | Legacy: maps GitHub repo → tag. Replaced by `repo_project_mappings` in newest work. |
| `repo_project_mappings` | Maps `repo_full_name TEXT` → `project_tag_id UUID REFERENCES tags(id)` for Today GitHub card |

**Filing-role tags** (used to categorise project ownership):
Eminence, Blog Site, Newsletter, Podcast, Vibe Coding YouTube, IBM Projects, AI FinOps,
AI Security and Governance, AI Well Architected Framework, ATOM, IBM Advantage,
Imagine, MSFT Dashboard, Nelfin, Personal, Independent Ventures, Knowledge Hub, ModelAIr.
Query: `SELECT id, name, slug FROM tags WHERE role = 'filing'`

---

### Backend conventions

**Language:** TypeScript, ESM (`"type": "module"` in package.json). Node ≥ 20.
**Framework:** Express 4. **DB client:** `pg` (node-postgres) — raw SQL, no ORM.
**Runtime start:** `node --import tsx/esm src/server.ts`

**File structure — one concern per file, ≤ 200 lines each:**
- `src/routes/` — Express routers, one per resource
- `src/services/` — business logic (no HTTP concerns)
- `src/db/` — DB pool (`db.ts`), migrations, query helpers
- `src/ai/` — Foundry client, RAG retriever, chat session store, tool definitions
- `src/integrations/` — GitHub, GitLab, Graph, CMS sync clients
- `src/sync/` — scheduler and sync orchestrator
- `src/jobs/` — background jobs (inferred edges etc.)
- `src/config/env.ts` — **the only place** that reads `process.env`. All env access elsewhere goes through `import { env } from '../config/env.js'`

**All routes use this pattern:**
```ts
router.get('/path', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      // ... work
      res.json(out);
    } catch (err) {
      next(err);
    }
  })();
});
```

**Response envelope (always use these types from `src/types/apiResponse.ts`):**
```ts
// Success
const out: ApiSuccess<T> = { success: true, data: payload };
res.json(out);

// Error — let errorHandler middleware handle it; throw typed errors:
throw new NotFoundError('Task not found');    // → 404
throw new UnauthorisedError('...');           // → 401
throw new ValidationError('...', fields);    // → 400
```

**Register new routers in `src/app.ts`** — follow the existing `app.use('/api/xyz', xyzRouter)` pattern. All `/api/*` routes go through the `authenticate` middleware automatically.

**Authentication:** JWT in `Authorization: Bearer <token>` header. Dev mode (`NODE_ENV=development` or `SKIP_AUTH=true`) bypasses JWT entirely. Cron/admin routes use `x-cron-secret` header.

**DB access:**
```ts
const db = getDb();                // singleton pool
const result = await db.query<RowType>('SELECT ...', [param1, param2]);
```
Never create a new Pool directly. All queries use parameterised `$1, $2, ...` placeholders.

**Scheduler:** Sync jobs run at 08:00, 14:00, 20:00 only (no overnight). In dev mode, AI-backed jobs (inferred edges, article scoring) are skipped to avoid burning AI credits.

---

### Frontend conventions

**Language:** TypeScript + React 18. **Build:** Vite 5. **UI:** Carbon Design System g100 (dark theme).
**Routing:** React Router v6. **Data fetching:** TanStack Query v5.

**File structure:**
- `src/pages/` — top-level route components (one per route)
- `src/components/` — shared/reusable components, grouped by domain in subdirectories
- `src/notes/` — Think-page note editor and storage (special: notes use serialised JSON content)
- `src/features/` — self-contained feature slices (sparks, autocue)
- `src/services/api.ts` — **all** backend calls go through this typed API client class
- `src/styles/global.scss` — **all** custom CSS lives here; no per-component CSS modules
- `src/types/` — shared TypeScript interfaces
- `src/services/todayUrgencyService.ts` — pure scoring functions, no React

**Theme:** Carbon g100. Theme token: `<Theme theme="g100">` wraps the app in `App.tsx`.
Use `var(--cds-*)` custom properties in CSS, not hardcoded hex where possible.
Exception: palette constants `#ffb784` (amber), `#fa4d56` (red), `#00a37f` (teal),
`#4589ff` (blue), `#ffa300` (amber-bright) are used where specific severity colours are needed.

**CSS conventions:**
- All styles in `src/styles/global.scss`
- BEM naming with project prefixes: `kh-` (shell/layout), `dc-` (discover card), `gctx__` (global context menu), `kb-modal-` (modals), `today-` (Today dashboard), `kh-chat-` (chat UI)
- Always style hover, active, disabled, open/closed states when interactive
- Dark Carbon theme: layer `#262626`, border `#393939`, text `#f4f4f4`, secondary `#c6c6c6`, placeholder `#6f6f6f`
- Never ship unstyled elements relying on browser defaults

**Routing (App.tsx):**
- `/` → `HomePage` (Today dashboard)
- `/discover` → `DiscoverPage`
- `/plan` → `PlanPage`
- `/my-work` → `TimelinePage` (GitHub/GitLab activity)
- `/think` → `NotesPage`
- `/library` → `DocumentsPage`
- `/graph` → `GraphPage`
- `/chat` → `AIChatPage` standalone (no nav/sidebar — desktop PWA)
- Old routes redirect: `timeline→discover`, `tasks/calendar→plan`, `notes→think`, etc.

**AppShell.tsx:** Returns a `<>` fragment. Do NOT add providers inside AppShell — add them in `App.tsx` wrapping the whole tree. The nav (`NAV_ITEMS`) is defined in AppShell.

**Notes content quirk (critical):** `Note.content` from `/api/notes` is **not** plain text or markdown. It is a JSON string `{"title":"...","contentType":"...","contentJson":"...","githubPath":"..."}`. Always use `fetchNotes()` from `src/notes/noteStorage.ts` to get parsed `NoteListItem[]`. Never slice `.content` directly.

**API client (`src/services/api.ts`):**
- Uses axios, base URL from `VITE_API_URL` env var (empty string = relative URL, proxied by Vite dev server)
- Token from `VITE_API_TOKEN`
- All methods return `ApiResponse<T>` — always check `.success` before accessing `.data`
- Chat requests use 90s timeout; image uploads use 60s; everything else 8s

**Reusable components to use, not rebuild:**
- `components/TagPicker.tsx` — taxonomy tag selector, portal-rendered, props: `{ selectedIds, onChange, trigger }`
- `components/sparks/QuickSparkModal.tsx` — spark capture modal, props: `{ open, onClose }`
- `components/sparks/ClusterCard.tsx` / `features/sparks/SparkClusterCard.tsx` — cluster display with Draft/Dismiss actions
- `components/discover/DiscoverActions.tsx` — Save/Blog/Archive action buttons for discover items
- `components/CollapsibleSection.tsx` — collapsible section header

**AI chat (Athena):**
- Floating widget: `components/FloatingAIChat.tsx` → renders `<AIChatPage compact />`
- Standalone PWA: `/chat` route → `<AIChatPage standalone />`
- Widget and standalone use **separate** `localStorage` session keys (`kh-athena-session-id-widget` vs `-standalone`) so conversations don't bleed between surfaces
- Mobile breakpoint: 640px — at this width standalone sidebar becomes off-canvas drawer, float panel goes full-screen

---

### TypeScript rules (both packages)

- Strict mode. `npx tsc --noEmit` must pass with zero errors before any PR.
- No `any` unless absolutely unavoidable; if used, add `// eslint-disable-line` comment with justification.
- All exported functions and interfaces require JSDoc `/** ... */` comments.
- No file over 200 lines — split into focused files if needed.
- Imports use `.js` extension in the backend (ESM interop). Frontend uses no extension.

---

### Git and PR conventions

- All work via pull request. No direct pushes to `main` unless the repo owner explicitly does so.
- Every PR must pass TypeScript checks (`tsc --noEmit`) in both frontend and backend before merge.
- Commit messages: imperative present tense, concise subject, body explains the *why* not the *what*.
- Co-authored-by trailer on every AI-assisted commit:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`
- Do not delete or overwrite `.specify/` artefacts or this file.

---

### What NOT to change without explicit instruction

- The JSX structure of `AppShell.tsx` — it returns `<>` fragment; providers wrap at `App.tsx` level
- The Carbon `<Theme theme="g100">` wrapper
- The sync scheduler timing (08:00, 14:00, 20:00) or the SNAT-aware DB pool settings
- The `notes/noteStorage.ts` serialise/deserialise contract — other code depends on the JSON format
- Any production `.env` secret values
- The `PasswordGate` component — it protects the whole app

---

## Current Session

**Repository:** richardichogan/knowledge-base
**Session:** UI Updates
**Brief:** # GHCP Prompt — Today Page Triage Styling and GitHub Repo-to-Project Mapping

## Context

The Today page currently renders every item in "Needs attention" with
identical visual weight. An overdue task 90 days late and a Discover
article discovered 16 days ago look the same. This prompt fixes that,
splits the section by category, and replaces the broken "configure
project tags" GitHub activity settings with a real repo-to-project
mapping mechanism.

This is a targeted styling and data-wiring prompt. Do not touch the
underlying task sync, Discover relevance scoring, or Planner
integration logic.

---

## Part 1 — Split "Needs attention" into two sections

Currently "Needs attention" is a single merged list of overdue Planner
tasks and Discover items awaiting a workflow decision. Split it into
two sections, each with its own heading and item count, in this order:

1. **Overdue** — Planner tasks past their due date. Sorted by days
   overdue, descending (most overdue first).
2. **Awaiting a decision** — Discover items still in `To Review` state.
   Sorted by discovery date, most recent first (matches current
   behaviour).

Each section keeps its own "Show N more" expansion, collapsed to the
same item count currently used (looks like 4 items visible by default
based on the current page, confirm against existing pagination
constant rather than hardcoding a new one).

Do not merge the two sections back together. Do not change the data
source queries for either — this is a rendering split only.

---

## Part 2 — Overdue severity styling

Each overdue task row gets a severity tier based on days overdue,
applied as a left border and the "Overdue by N days" text colour:

```
0-6 days overdue:   neutral, no border change, text stays #c6c6c6
7-30 days overdue:  amber — border-left: 2px solid #ffb784;
                    text color: #ffb784;
31+ days overdue:   red — border-left: 2px solid #fa4d56;
                    text color: #fa4d56;
```

Border and text colour are the only changes. Do not alter row height,
padding, the Done/Snooze buttons, or checkbox icon styling.

This uses the existing `TAG_COLOURS` amber (`#ffb784`) and red
(`#fa4d56`) values already defined in the hub's colour palette — do
not introduce new hex values outside that set.

---

## Part 3 — GitHub activity: repo-to-project mapping

### Problem being fixed

The current "GitHub activity" card reads "No tagged GitHub activity
found. Use ⚙ to configure project tags." This is broken by design —
GitHub commits and PRs have no taggable field to configure against.
Repos have topics; commits and PRs do not. The settings screen this
links to must be replaced with something that maps to a real GitHub
concept: the repository itself.

### What to build

A simple manual mapping table, not an AI-driven or tag-driven system.

```sql
CREATE TABLE repo_project_mappings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_full_name TEXT NOT NULL UNIQUE,
  project_tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_repo_mapping_tag ON repo_project_mappings(project_tag_id);
```

`repo_full_name` is the GitHub/GitLab `owner/repo` string exactly as
returned by the existing sync service (e.g.
`richardichogan/content-store`).

`project_tag_id` references an existing filing-role tag from the tag
taxonomy (e.g. Independent Ventures, ModelAIr, a specific IBM project
tag). Use the existing `tags` table — do not create a parallel project
concept.

### Settings UI

Replace the current "⚙ configure project tags" action with a
"Manage repo mapping" screen. Simple table view:

- One row per connected repo (pulled from the existing GitHub/GitLab
  sync configuration, not a fresh API call)
- Each row: repo full name, a dropdown to select the mapped project
  tag (filtered to role `filing` tags only, using the existing
  TagPicker or a plain Carbon `Dropdown`), and a save action per row
- Repos with no mapping set show "Unmapped" and are excluded from the
  Today GitHub activity card until mapped
- No AI involved. No per-commit or per-PR tagging call. This table is
  set once per repo and rarely touched again

Confirm Carbon `Dropdown` props via the Carbon MCP server before
writing this component.

### Today page GitHub activity card

Once mappings exist, the GitHub activity card queries commits and PRs
from the existing sync data, joins against `repo_project_mappings` on
`repo_full_name`, and groups activity by mapped project tag. Repos
with no mapping are silently excluded — do not show an error state for
unmapped repos on the Today page itself, only in the settings screen.

If zero mappings exist, keep a version of the current empty state but
correct the copy: "No repos mapped yet. Set up repo-to-project mapping
in settings." Do not reference "tags" in this message since the
missing concept was never a GitHub tag — link directly to the new
mapping screen.

---

## What this prompt does NOT include

- Any change to Discover relevance scoring or workflow state logic
- Any change to Planner task sync or due date calculation
- AI-based commit or PR categorisation of any kind
- Changes to the concept/filing tag taxonomy itself
- Changes to any other Today page section (Sparks composer stays as is)

---

## Done when

- Needs attention is split into Overdue and Awaiting a decision, each
  with its own heading, count, and Show more expansion
- Overdue rows show amber border/text at 7-30 days and red at 31+ days,
  using existing palette hex values only
- `repo_project_mappings` table exists and is populated via the new
  settings screen, not by AI inference
- Today's GitHub activity card groups by mapped project tag and
  excludes unmapped repos
- The broken "configure project tags" copy and non-functional settings
  link are gone, replaced by the repo mapping screen
- No file exceeds 200 lines
- All new functions and exported interfaces have JSDoc comments

> See `.specify/spec.md` for the full specification and `.specify/tasks.md` for the issue task list.
