# Athena

> Formerly "Personal Knowledge Hub". The product is now called **Athena**; code, folders (`knowledge-hub-*`) and Azure resources (`kh-prod-*`) keep their original names.

Microsoft sign-in renews silently where possible. When interactive sign-in is
required, Athena shows a session-expired dialog with a **Re-authenticate** button
instead of refreshing or redirecting unexpectedly. User-initiated re-authentication
opens a Microsoft popup, keeping the current page and unsaved editor content
mounted. Allow pop-ups for Athena; cancelled or blocked sign-in can be retried.

Think's **Copy note** action copies the whole current note as Markdown, including
unsaved edits and its title, with paragraphs, lists and links preserved.

Think notes have a **History** side-panel tab for lightweight recovery. On the
first changed save, the previous writing is checkpointed; further automatic
checkpoints are at most once per 30 minutes per note. Metadata-only and unchanged
saves do not create checkpoints. Autosave still saves current writing normally.
Athena replacements/deletions preserve the exact live draft before applying a
batch, and restoring preserves the current writing before replacing it.
Only the newest 30 checkpoints per note are retained (including protected ones),
with no age expiry. Intermediate autosaves are not an exhaustive edit log.
Restore affects title, content type and rich body only; current project, tags,
links and GitHub settings stay unchanged. Checkpoints retain image references,
not image files, and are never AI-indexed or added to Connections.
Conflicting writes pause autosave and keep the editor draft: copy it before
reopening the saved note. History is Think-only, not task/Discover/canvas history
or deleted-note recovery, and is not a substitute for backups.

Run the isolated history database regression from `knowledge-hub-backend` with
`node --import tsx/esm --test scripts/note-history.test.ts`. It uses in-memory
PostgreSQL, never the configured application database.
The real-editor browser fixture is `knowledge-hub-web/tests/note-history.html`;
use the existing browser runner with `ATHENA_BROWSER_CHECKS=note-history` and
`TODAY_FIXTURE_URL` pointing at that fixture on an isolated Vite server.

A unified personal intelligence layer that aggregates content, code activity, calendar events, and tasks from 10+ sources into a single, searchable, AI-queryable timeline — accessible from Android and Mac.

---

## Navigation

The single desktop header contains **Today, Discover, Plan, Think, Build and Projects**. The Athena identity returns to Today. **Tools** groups Activity (the existing `/my-work` route), Sources (`/library`), Knowledge graph and Memory separately from management actions. Connections and sync opens Activity's existing sync-status panel without starting a sync; Tag Manager, repo-to-tag mappings and repo project mappings retain their existing panels/routes. On narrow screens, Today stays visible and the menu separates Main destinations from Tools.

Search remains available through the header or Cmd+K / Ctrl+K. Its command palette uses the same destination groups. The toolbar is the only global Athena launcher: it opens the existing popout or reveals and focuses the Sources rail without changing context. It is disabled throughout Think, which uses its built-in Athena panel. There is no floating launcher on any screen. Sparks and Canvas remain Think modes, and quick Spark capture remains available in Think or with Cmd+. / Ctrl+. All existing URLs and redirects are preserved. No global project selector or new administration/search functionality is added.

Navigation regressions use the same isolated fixture server and Chromium executable as the Today checks below. Run `node tests/run-navigation-browser.mjs` from `knowledge-hub-web` with `TODAY_BROWSER_PATH` set. The fixture covers 1440px, 1024px and 390px, keyboard/focus behaviour, supporting routes, existing management panels, embedded Athena launch and failed supporting services. API/auth requests are blocked. Unit tests run with `node --import tsx/esm --test ../knowledge-hub-web/tests/navigation.test.ts` from the backend folder.

## Quick LinkedIn posts from Discover

Connections reuse the existing shared graph, not a canvas-only relationship model.
Use the existing right-click menu on selected Think note text to **Create Spark**.
The Spark retains the selection and its source-note reference. After saving,
its graph node and source connection are committed together (if the source is
not yet indexed, the existing scheduled sync resolves the connection).
**Send Spark to Canvas** adds a card referencing that Spark; existing Spark rows
also expose **Original note** and **Map Spark** actions. Canvas cards can then be
connected to new ideas using the existing connection controls. Sparks remain a
Think subview, not a separate main navigation destination; diagram canvases are
not offered in this card-based mapping flow.
Think shows contextual connections before linked canvases. Notes, Plan tasks,
Discover articles, Library documents, Sparks and indexed GitHub activity can be
related through explicit links, shared concept tags or scheduled AI inference.
Each connection displays its reason; weak or unexplained AI suggestions are not
saved. Inference compares actual note text, task descriptions and article/GitHub
content, with candidates balanced across item types (up to 30 candidates and five
new suggestions per source per run). Connection-only checks run every 15 minutes,
processing up to 25 new/changed items per pass after a two-minute settling delay.
Content-version checkpoints persist across restarts, including no-match results;
failed assessments retry and edits made during a check remain pending. Existing
content is baselined on migration, not bulk reassessed. This job only reads stored
content and updates graph metadata/relationships: it never starts source sync,
search re-indexing or embeddings. The existing source-sync and Foundry backfill
schedules are unchanged. GitHub issues, PRs, reviews, actions, releases
and deployments join the existing commit index on the next regular sync. Notes
and tasks open their specific item; Discover and GitHub connections open the
original source when available. Existing saved relationships are retained.

Article actions (including Copy URL, Canvas, Spark and Connections) remain visible
without hovering; the action row wraps on narrow screens.

**LinkedIn post** on a Discover article or Inbox email opens a short, editable
draft in a popup: a brief summary and, where supported, one enterprise IT
observation (at most 90 generated words). **Copy post + link** preserves blank
lines and appends the original source URL. Email links open the original message
and require mailbox access; they are not public article links. Review email
content for private information before sharing. Successfully copying an article's
post moves it to **Published**, matching **Copy URL**; it does not post to LinkedIn.
Generating/closing drafts, failed clipboard copies and copying Inbox emails do
not change workflow state. Failed workflow updates are shown with a retry option.

Browser alerts and confirmations use Athena's styled in-app dialogs throughout
the web app, with focus trapping, Escape dismissal and Cancel as the initial
focus for destructive actions.

Regression checks: from `knowledge-hub-backend`, run
`node --import tsx/esm --test scripts\linkedin-draft.test.ts ..\knowledge-hub-web\tests\appDialogs.test.ts`.
The isolated browser fixture needs only Vite on a free port (default 5186);
from `knowledge-hub-web`, set `TODAY_BROWSER_PATH` to an installed Chromium
executable and run `node tests\run-discover-browser.mjs`. It uses mock data,
blocks live API/auth requests and checks desktop/mobile, draft/copy failures,
source links and dialog behaviour.

## Athena export to Think

**Export chat to Think** saves one note containing the full latest version of every saved Output, without AI summarisation or a generation-token limit. Separate Outputs remain unchanged. Show Notes packages follow the podcast section order; YouTube plain text and Spotify HTML are preserved in code blocks. Chats without Outputs retain the structured conversation export.

## Capturing Sparks with Athena

Ask Athena to "save that as a spark" or "create a spark: …" to capture a brief thought in **Think > Sparks**, without creating a note or task. Sparks are standalone by default, support optional tag names, and can be attached to a known source when requested. They use the existing Spark clustering pipeline. Athena does not save Sparks unsolicited, and read-only "Ask another model" replies cannot create them.

## Think canvases

The diagram editing sheet uses Athena's dark theme with a subdued grid and
contrast-adjusted connectors and transparent labels. Saved shape colours and
PNG/SVG export colours are unchanged; exports still offer white or transparent
backgrounds.

Select one diagram shape or connector to edit its **Title** and **Description**
in the right-hand **Properties** panel. Title is the visible label (including
image captions); Description is stored with the item, up to 10,000 characters,
but is not printed on the drawing or PNG/SVG exports. Both autosave, participate
in undo/redo and are preserved when duplicating items. Use the Properties button
to hide/show the panel. Multi-selection asks you to select a single item.
Existing diagrams remain compatible and start with empty descriptions.

From a note, **Create diagram** opens a new blank diagram linked to that note;
it does not automatically generate shapes from the note's prose. In a diagram,
**Properties → Linked notes → Link a note** associates an existing note, and
the note's **Connections → Canvases** provides the return link. Linked notes
can be opened or unlinked from the diagram. These are links to the live,
editable diagram, not static image embeds.

**New canvas** offers two separate editors:

- **Brainstorm** preserves the existing network of idea cards and linked Think/Library/Athena content.
- **Diagram** is a visual editor for architecture diagrams and process flows: shapes, text, nested containers/swimlanes, attached straight/right-angle connectors, PNG/SVG icons and compact formatting controls. Diagrams are editable documents, not screenshots. Note-linked diagrams and brainstorms remain separate; the note's brainstorming action still opens a brainstorm.

Paste image data copied from msicons.com, drag an image file onto the diagram, or upload PNG/SVG. Some websites/browsers copy only an image URL rather than image bytes; in that case download the icon and upload it. Imported SVG must be a self-contained, safe image: scripts, external resources and active content are rejected. Icons preserve their aspect ratio.

The **Microsoft icons** picker contains a curated official set from Azure, Power Platform, Fabric and Microsoft 365 architecture symbols. It is bundled locally rather than fetched from third-party sites while drawing. Microsoft 365 symbols are not current product logos. Product marks must not be distorted, recoloured or used as your own branding; sources and permitted-use terms are in `knowledge-hub-web/public/diagram-icons/NOTICE.txt`.

PNG/SVG export includes the full diagram, including objects outside the viewport, and embeds icons. SVG remains scalable; a PNG icon embedded in an SVG remains raster. PNG output is limited to 16,384 pixels per side and 64 megapixels; use SVG for larger drawings. Export fails explicitly if an icon has not loaded rather than silently omitting it.

Diagram checks use the existing TypeScript loader and isolated browser fixture:

```powershell
cd knowledge-hub-web
$loader = ([System.Uri](Resolve-Path '..\knowledge-hub-backend\node_modules\tsx\dist\loader.mjs').Path).AbsoluteUri
node --import $loader --test src\features\diagram\tests\diagramGeometry.test.ts
npx tsc --noEmit -p tests\tsconfig.json
# Start Vite on a free port (the runner defaults to 5142); no backend is required.
$env:TODAY_BROWSER_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests\run-diagram-browser.mjs
```

The diagram fixture blocks live API/auth requests, uses test-only architecture/process data, and verifies full-bounds embedded SVG export and PNG rendering at desktop and mobile widths.

Diagram documents and their last 50 saved revisions are stored in PostgreSQL. Saves use optimistic revision checks; a conflicting save reports an error instead of overwriting another session. Dedicated canvas-scoped image rows store PNG/SVG bytes without OCR or new blob containers, credentials or environment variables. Deleting a canvas deletes its diagram and assets. Migration `055_diagram_canvases.sql` runs through the normal startup migration path and preserves existing canvases as Brainstorm.

Limits are 1,000 nodes, 2,000 connectors, 100 bends per connector, 200 uploaded assets per canvas and 5 MiB per asset. Uploaded PNGs are limited to 16,384 pixels per side and 40 million pixels. Run backend validation and revision-conflict checks from `knowledge-hub-backend` with `node --import tsx/esm --test scripts\diagram.test.ts`; these include every bundled icon and reject unsafe SVG uploads.

## Build (GitHub cloud coding agents)

**Build** turns a spec into dependency-ordered tasks and runs them on GitHub's cloud-hosted coding agents (Copilot coding agent or Claude), not the local agents in VS Code or the Copilot app.

1. Create a spec on the Build page, or use **Send to Build** on a Think note or a markdown Athena output. Pick the GitHub repo and, optionally, a target branch (defaults to the repo's default branch).
2. **Decompose**: Athena splits the spec into small tasks, each with dependencies, a size (S/M/L) and a suggested agent with a reason. You can change the agent and dependencies before starting.
3. **Start**: each ready task becomes a GitHub issue assigned to its agent (at most *max parallel* at once). The agent opens a PR from its own branch.
4. The runner checks every two minutes; **Check now** runs a pass immediately. It then does the following:
   - Asks the agent (via a PR comment) to fix failing checks or merge conflicts.
   - Squash-merges the PR once checks pass, if auto-merge is on.

   A task waits for you (*awaiting approval*, use **Merge now**) when any of these apply:
   - Auto-merge is off.
   - No CI checks ran.
   - The PR changes `.github/workflows/`.

   A task is marked *blocked* after repeated failed fix requests, or if the PR is closed unmerged; **Retry** puts it back in the loop. Merging a task releases the tasks that depend on it.

Branching: with **Use an integration branch** on (the default), **Start** creates `build/<slug>-<id>` from the target branch and every agent PR targets that branch, so the target branch only changes once. When all tasks are merged, the runner opens one PR from the integration branch into the target. Click **Merge into &lt;target&gt;** (a merge commit), or merge the PR on GitHub; either way the integration branch is then deleted. Repo, target branch and the toggle are locked once the integration branch exists. With the toggle off, agent PRs merge straight into the target branch. Local worktree work (e.g. in the Copilot app) should branch from and PR into the same target as normal.

Setup:

- Enable the agent(s) for the target repo in GitHub (Copilot coding agent and/or the Claude agent). **Start** fails with `BUILD_AGENT_UNAVAILABLE` if a chosen agent isn't assignable.
- Set `GITHUB_AGENT_TOKEN` to a **user** fine-grained PAT with read/write on contents, issues, pull requests and actions for the target repos. It falls back to `GITHUB_ACCESS_TOKEN`. In production, store it as a Container App secret: `az containerapp secret set ... --secrets github-agent-token=<pat>`, then `--set-env-vars GITHUB_AGENT_TOKEN=secretref:github-agent-token`.
- Workflows on agent PRs may need **Approve and run workflows** in GitHub before checks run; until they run, the task stays *awaiting approval*.
- The runner is off in local development so a dev backend never dispatches alongside production; set `BUILD_RUNNER_ENABLED=true` to enable it. Note that the local `.env` points at the production database.
- Migrations `056_build_pipeline.sql` (`build_specs`, `build_tasks`, `build_events`) and `057_build_integration_branch.sql` run on startup.

Tests: from `knowledge-hub-backend`, `node --import tsx/esm --test scripts\build.test.ts`.

## Project dates and saving

Athena reloads the assigned project's saved goal, role, ownership, state,
dates, importance and complete expected outputs on every turn. Current
project fields take precedence over older chat history and memories.
Unassigned chats have a saved-project catalog and `get_project_details`
lookup for named projects.

Projects uses the shared primary-page header, gutters and typography. Search
and filters sit below the header, with a visible result count. Cards show a
short summary; expandable Project details retains the complete goal, context
and expected outputs as readable text, not oversized pills. Desktop uses two
columns and mobile one; editing retains all full-length content.

Chat drafts are saved per conversation in the current browser tab and restored
after refresh. A draft is cleared only once the server accepts its turn;
the new conversation ID is saved before authentication or network requests.
If Microsoft sign-in has expired, the page redirects to sign in as before;
the draft is saved in session storage first and restored on return.

Project dates are returned as `YYYY-MM-DD` calendar dates (or `null`), without
timezone conversion, so editing a dated project preserves its dates. Project
save failures display the backend validation message rather than only an HTTP
status. Regression checks: from `knowledge-hub-backend`, run
`node --import tsx/esm --test scripts/projects.test.ts ../knowledge-hub-web/tests/apiError.test.ts`.

Expected outputs are full text descriptions, one per line, not short labels:
they are not truncated or capped at 30 entries/100 characters. Empty lines are
ignored by the form; the API rejects non-text or blank entries. Overall request
body limits still apply. Goal (2,000 characters), role and ownership (200 each)
have visible limits and pre-save validation that preserves the entered text.

## Today

Today prioritises overdue, blocked, urgent and near-due Plan tasks, failed connections/automation, and open Athena decisions. Recent Think notes, canvases, in-progress tasks and saved Outputs form a separate continuation list; routine activity is grouped rather than shown as a feed. Discover suggestions require a stored relevance explanation, and Spark clusters need at least four Sparks.

The page initially shows at most five attention items, four continuations, three change summaries and three exploration suggestions. Each desktop column stacks independently, so Worth exploring follows Continue working without a gap caused by the attention list. Mobile keeps the attention, continuation, changes and exploration order. Source failures are local to each section and can be retried independently. Changes cover at least the last 24 hours (or since the last browser visit when older), so reopening Today does not immediately clear the list. They include saved Think notes, Plan updates/completions, Athena Outputs and the latest 100 activity entries ordered by source update time, excluding future events. Outputs and decisions cover the four most recent non-briefing Athena chats, not all historical chats. Today has no standalone Athena prompt box or suggested-prompt strip; use the toolbar instead. Item-specific Ask Athena actions retain their visible context and project handoff, leaving the prompt editable before sending. Capture thoughts through Athena or Think > Sparks; access the full morning briefing through Athena, not the home page.

Today regression checks use the existing backend `tsx` loader and an isolated browser fixture (not production data):

```powershell
cd knowledge-hub-backend
node --import tsx/esm --test ..\knowledge-hub-web\tests\todayViewModel.test.ts
cd ..\knowledge-hub-web
npx tsc --noEmit -p tests\tsconfig.json
# In a separate terminal, after checking that port 5142 is free:
npm run dev -- --port 5142
# In the test terminal:
$env:TODAY_BROWSER_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests\run-today-browser.mjs
```

The browser runner uses a temporary profile, checks 1440px and 390px layouts, and blocks `/api` and `/auth` requests. It does not require a backend or authenticated production session. The fixture covers local loading/failure states, refresh, completion, disclosures and the real popout's prompt/context handoff. It also renders the actual Discover and Think pages with test-only data to compare Today's shared header typography, gutters and divider, Discover body typography and Think note-title typography. Today uses the existing left-aligned page frame, not a separate centred container.

## Repository structure

```
Knowledge-Base/
├── knowledge-hub-backend/   # Node.js + Express + TypeScript API server
├── knowledge-hub-web/       # React + TypeScript + Vite web frontend (primary — PC/Mac browser)
├── knowledge-hub-app/       # React Native Android app (Tier 2)
├── knowledge-hub-raycast/   # Raycast extension (Mac capture + session export)
├── CHANGE_LOG.md            # Post-spec decisions and scope changes
└── 2026-04-12-knowledge-hub-spec.md  # Full project spec v4
```

---

## Architecture overview

| Layer | Technology |
|---|---|
| Backend API | Node.js 20 · Express · TypeScript 5.5 |
| Database | PostgreSQL (Azure) — FTS via `tsvector` trigger |
| Blob storage | Azure Blob Storage (`blogcontent` container) — Managed Identity |
| CMS | Azure Blob Storage posts (`posts/<id>.json`) |
| Source syncing | GitLab · GitHub · Microsoft Graph (M365 Calendar + To Do) |
| Podcast | Configurable RSS URL (`PODCAST_RSS_URL` env var) |
| AI | Azure AI Foundry — GPT-4o / GPT-4o mini via REST |
| Auth (app→API) | JWT Bearer tokens |
| Auth (API→sources) | OAuth2 server-side (Graph refresh token · GitLab/GitHub PATs) |
| Mobile | React Native 0.74 · TypeScript |
| Mac companion | Raycast extension — `@raycast/api` |

---

## Quick start

### 1. Prerequisites

- Node.js 20+
- PostgreSQL instance (local or Azure)
- Azure subscription with Blob Storage account
- Azure AI Foundry deployment (GPT-4o + GPT-4o mini)
- Microsoft 365 account (personal) for Graph integration
- GitLab + GitHub personal access tokens

### 2. Web frontend (primary — PC/Mac browser)

```bash
cd knowledge-hub-web
npm install
cp .env.example .env
# In development the Vite proxy forwards /api to the backend (default port 3000).
# Set KH_API_PORT if the backend runs on a different port.
# Set VITE_API_TOKEN if your backend JWT auth is enabled.
npm run dev   # Starts Vite dev server on http://localhost:5173
```

Pages: **Timeline · Search · Notes · AI Chat · Tasks · Calendar**

### 3. Backend

```bash
cd knowledge-hub-backend
npm install
cp .env.example .env
# Edit .env — fill in all required values
npm run migrate        # Creates tables and FTS trigger
npm run dev            # Starts ts-node-dev on port 3000
```

Key npm scripts:

| Script | Description |
|---|---|
| `npm run dev` | Start with hot reload (`ts-node-dev`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run lint` | ESLint + type check |
| `npm run migrate` | Run `schema.sql` against `DATABASE_URL` |
| `npm run validate:ibm` | IBM M365 calendar device-code validation |

### 3. React Native app (Android)

```bash
cd knowledge-hub-app
npm install
# Set env vars in a .env file or edit src/services/ApiClientContext.tsx
# KNOWLEDGE_HUB_API_URL — backend URL (default: http://10.0.2.2:3000 for Android emulator)
# KNOWLEDGE_HUB_API_TOKEN — JWT token for authentication
npx react-native run-android
```

### 4. Raycast extension (Mac)

```bash
cd knowledge-hub-raycast
npm install
# Set environment variables in your shell profile:
# export KNOWLEDGE_HUB_API_URL=http://localhost:3000
# export KNOWLEDGE_HUB_API_TOKEN=<your-jwt-token>
npm run dev   # Opens Raycast in development mode
```

---

## Environment variables

All required variables are documented in `knowledge-hub-backend/.env.example`.

The backend detects Azure Container Apps via its built-in `CONTAINER_APP_NAME`
variable and trusts exactly one ingress proxy hop for client IP/rate limiting.
Earlier forwarded IP entries remain untrusted; local/direct hosting trusts no
proxy. Stored note images are enriched only for valid UUID image references;
inline data URLs, temporary blob URLs and named external images are not queried
against the UUID-backed image table.

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing/verifying JWT tokens |
| `AZURE_BLOB_ACCOUNT_URL` | Blob storage account URL (Managed Identity auth) |
| `AZURE_STORAGE_CONNECTION_STRING` | Local dev fallback for blob auth |
| `AZURE_OPENAI_ENDPOINT` | Azure AI Foundry endpoint |
| `AZURE_OPENAI_API_KEY` | Azure AI Foundry API key |
| `AZURE_OPENAI_DEPLOYMENT_GPT4O` | GPT-4o deployment name |
| `AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI` | GPT-4o mini deployment name |
| `GRAPH_CLIENT_ID` | Azure AD app client ID |
| `GRAPH_CLIENT_SECRET` | Azure AD app client secret |
| `GRAPH_TENANT_ID` | Azure AD tenant ID |
| `GRAPH_REFRESH_TOKEN` | M365 OAuth2 refresh token |
| `GITLAB_BASE_URL` | GitLab instance URL |
| `GITLAB_TOKEN` | GitLab personal access token |
| `GITLAB_USER_ID` | GitLab user ID |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_USERNAME` | GitHub username |
| `GITHUB_AGENT_TOKEN` | User fine-grained PAT for the Build pipeline (assign cloud agents, merge PRs); falls back to `GITHUB_ACCESS_TOKEN`. Secret — use `secretref:` |
| `BUILD_RUNNER_ENABLED` | `true` to run the Build runner in development (always on in production) |
| `PODCAST_RSS_URL` | Podcast RSS feed URL |
| `CMS_BLOB_CONTAINER` | Blob container name (default: `blogcontent`) |
| `CMS_POSTS_PREFIX` | Blob path prefix (default: `posts/`) |

---

## Deployment (production)

Production is **manual** — there is no CI/CD pipeline. Deploys are run from a local
shell with the Azure CLI. The Azure MCP tools must not be used for this; they hang.

### Resources

| Purpose | Resource | Resource group |
|---|---|---|
| Backend container app | `kh-prod-api-vnet` | `rg-knowledge-hub-prod` |
| Container registry | `cad79107555facr` (image `kh-prod-api`) | `rg-knowledge-hub-prod` |
| Frontend static web app | `kh-prod-web` | `rg-knowledge-hub-prod` |

Subscription: **Alliance Tenant Reporting**.
Live site: <https://athena.themicrosoftcloudblog.com>
(the underlying Static Web Apps hostname `nice-mud-0f780fb03.7.azurestaticapps.net`
also still resolves).

### Before deploying anything

```bash
cd knowledge-hub-web     && npx tsc --noEmit
cd knowledge-hub-backend && npx tsc --noEmit
```

Both must be clean. Then commit and push the branch you intend to deploy — the
backend image is built from GitHub, not from your working tree, so uncommitted
changes are silently ignored.

### Backend

```bash
az account set --subscription "Alliance Tenant Reporting"

# 1. Find the tag currently deployed and pick the next one.
az containerapp show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --query "properties.template.containers[0].image" -o tsv

# 2. Build the image from the pushed branch (note the #branch:subdir syntax).
az acr build --registry cad79107555facr --image kh-prod-api:v<NN> \
  --file Dockerfile \
  "https://github.com/richardichogan/knowledge-base.git#<branch>:knowledge-hub-backend"

# 3. Roll the container app onto it.
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --image cad79107555facr.azurecr.io/kh-prod-api:v<NN>

# 4. Verify — do not consider the deploy done until the new revision is Healthy.
az containerapp revision list --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --query "[?properties.active].{name:name,health:properties.healthState,running:properties.runningState,image:properties.template.containers[0].image}" \
  -o table
```

The new revision takes a minute or two to go from `Activating` to
`Healthy` / `RunningAtMaxScale`. If it fails to start, read the logs rather than
guessing:

```bash
az containerapp logs show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --tail 50
```

### Frontend

```bash
cd knowledge-hub-web
npm run build   # loads .env.production — bakes in VITE_API_URL and the password gate

$token = az staticwebapp secrets list --name kh-prod-web \
  --resource-group rg-knowledge-hub-prod --query "properties.apiKey" -o tsv

npx --yes @azure/static-web-apps-cli deploy ./dist --deployment-token $token --env production
```

### Environment variables and secrets

Non-secret settings are plain env vars:

```bash
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --set-env-vars SOME_VAR=value
```

Secrets must go through the secret store and be referenced indirectly — never as a
literal env var value:

```bash
az containerapp secret set --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --secrets my-key=<value>
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --set-env-vars MY_KEY=secretref:my-key
```

### Custom domains and CORS

`CORS_ORIGIN` on the backend is a **comma-separated allow-list** of front-end
origins. Adding or changing a front-end domain requires updating it, otherwise the
site loads but every API call is blocked by the browser and the app appears empty:

```bash
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod \
  --set-env-vars "CORS_ORIGIN=https://athena.themicrosoftcloudblog.com,https://nice-mud-0f780fb03.7.azurestaticapps.net"
```

A new front-end domain does **not** require a frontend rebuild — `VITE_API_URL`
points at the backend, not at the site's own hostname.

---

## Pre-build validation

Before running in production, validate IBM calendar connectivity:

```bash
cd knowledge-hub-backend
npm run validate:ibm
```

This uses the Microsoft Azure CLI public client and device code flow — no secrets needed. Follow the on-screen instructions. The script will report one of:

- **SUCCESS** — IBM M365 calendar readable; proceed with integration
- **PARTIAL** — Some events visible; contact IT about Calendars.Read scope
- **CONDITIONAL ACCESS BLOCK** — IT policy prevents access; IBM calendar will be excluded from sync

---

## Tier 1 sources (synced automatically every 15–60 min)

| Source | Cadence |
|---|---|
| CMS blog posts (Azure Blob) | 15 min |
| GitLab commits | 30 min |
| GitLab merge requests | 30 min |
| GitLab issues | 30 min |
| GitLab pipelines | 30 min |
| GitHub commits | 30 min |
| GitHub pull requests | 30 min |
| GitHub issues | 30 min |
| M365 Calendar (personal) | 15 min |
| M365 To Do | 15 min |

---

## AI write actions (require confirmation)

All write actions follow a **propose → confirm → execute** flow. The AI will never modify data without explicit user confirmation.

Supported actions:

| Type | Description |
|---|---|
| `cms-update-social-push` | Mark a blog post's social push status |
| `todo-create-task` | Create a task in Microsoft To Do |
| `todo-update-task` | Update an existing To Do task |
| `github-create-issue` | Create a GitHub issue |
| `blob-save-markdown` | Save a markdown file to blob storage |

---

## Project conventions

- No file over 200 lines (single responsibility)
- No magic strings or numbers — all in `src/config/constants.ts`
- No credentials hardcoded — all via environment variables
- `exactOptionalPropertyTypes: true` — use `...(x !== undefined && { key: x })` spread pattern
- All write actions gated by `proposeWriteAction` → `confirmWriteAction`
- `content/posts/index.json` must **never** be written

---

## Roadmap

See the full project spec: `2026-04-12-knowledge-hub-spec.md`

**v0.1 (current):** Tier 1 backend, Android app, Raycast extension  
**v0.2:** IBM calendar integration (pending IT validation), CMS publish action, podcast sync  
**v0.3:** Social post drafting, LinkedIn/Twitter integration, Spotify podcast  
