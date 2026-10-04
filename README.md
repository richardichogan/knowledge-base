# Athena

> Formerly "Personal Knowledge Hub". The product is now called **Athena**; code, folders (`knowledge-hub-*`) and Azure resources (`kh-prod-*`) keep their original names.

A unified personal intelligence layer that aggregates content, code activity, calendar events, and tasks from 10+ sources into a single, searchable, AI-queryable timeline — accessible from Android and Mac.

---

## Athena export to Think

**Export chat to Think** saves one note containing the full latest version of every saved Output, without AI summarisation or a generation-token limit. Separate Outputs remain unchanged. Show Notes packages follow the podcast section order; YouTube plain text and Spotify HTML are preserved in code blocks. Chats without Outputs retain the structured conversation export.

## Today

Today prioritises overdue, blocked, urgent and near-due Plan tasks, failed connections/automation, and open Athena decisions. Recent Think notes, canvases, in-progress tasks and saved Outputs form a separate continuation list; routine activity is grouped rather than shown as a feed. Discover suggestions require a stored relevance explanation, and Spark clusters need at least four Sparks.

The page initially shows at most five attention items, four continuations, three change summaries and three exploration suggestions. Source failures are local to each section and can be retried independently. Changes use the last browser visit (or the last 24 hours), scanning the latest 100 activity entries. Outputs and decisions cover the four most recent non-briefing Athena chats, not all historical chats. Ask Athena opens the existing popout with the visible context and item project, leaving the prompt editable before sending. Capture and the full narrative morning briefing remain available below the main sections.

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

The browser runner uses a temporary profile, checks 1440px and 390px layouts, and blocks `/api` and `/auth` requests. It does not require a backend or authenticated production session. The fixture covers local loading/failure states, refresh, completion, disclosures and the real popout's prompt/context handoff.

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
