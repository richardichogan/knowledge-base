# Personal Knowledge Hub

A unified personal intelligence layer that aggregates content, code activity, calendar events, and tasks from 10+ sources into a single, searchable, AI-queryable timeline — accessible from Android and Mac.

---

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
# In development the Vite proxy forwards /api to localhost:3000 automatically.
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
