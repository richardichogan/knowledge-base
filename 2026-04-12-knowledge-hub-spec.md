---
sessionSummary: false
date: 2026-04-12
topic: knowledge-hub-spec
version: v4
---

# Personal Knowledge Hub
## Project Spec v4 — incorporating CMS schema review and IBM calendar decisions

---

## What this is

A React Native mobile app (iOS and Android) that aggregates content from
multiple personal and professional sources into a single unified view,
with an AI conversation layer that can act on that content.

The app serves as a personal knowledge hub and active workspace — everything
in one place, searchable, linkable, and accessible on mobile. The AI layer
can create content, cross-reference sources, update documentation, manage
tasks and diary, brainstorm ideas, and generate GHCP prompts and artefacts.

This project also serves as a real-world test of the React Native development
and App Store / Google Play submission process.

---

## The problem

Content, tasks, and activity are currently scattered across code platforms,
email, calendar, blog, newsletter, podcast, and task management tools.
No single view exists. Finding something requires knowing which system it
lives in, then searching that system individually. There is no AI layer
that understands the full picture, no way to cross-reference across sources,
and no frictionless way to capture tasks or ideas in the moment.

---

## The solution

A mobile app that:

1. Connects to each source via its API, SDK, or direct Azure integration
2. Pulls content into a unified timeline and cloud-synced search index
3. Presents everything in a single scrollable, filterable, searchable view
4. Provides an AI conversation layer with RAG-based context from aggregated
   content
5. Allows the AI to act on content — publishing posts, managing tasks,
   updating documentation, brainstorming ideas, generating GHCP prompts —
   via the same API connections used for reading
6. Runs on iOS and Android from a single codebase
7. Is complemented by a Raycast extension on Mac for frictionless task and
   idea capture via voice or keyboard shortcut

---

## Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React Native + TypeScript | iOS and Android from single codebase |
| Backend | Node.js + Express + TypeScript | Same pattern as Structara-AI |
| Database | PostgreSQL on Azure | Cloud-hosted for multi-device sync |
| Local cache | SQLite | Offline reading only, not primary store |
| Search | PostgreSQL FTS | Revisit if scale demands Azure AI Search |
| Auth (app) | OAuth2 to backend | App authenticates to own backend |
| Auth (sources) | OAuth2 tokens held server-side | Never stored in mobile app binary |
| AI layer | Azure AI Foundry (GPT-4o / GPT-4o mini) | Billed against MSDN credits |
| Voice capture | OpenAI Whisper API | Task and idea capture via Raycast |
| Blob access | Azure Managed Identity | No credentials for CMS blob access |
| Hosting | Azure App Service or Container | Alongside existing Azure footprint |
| Code quality | ESLint (strict TypeScript) + GitLab SAST | Free, runs in CI pipeline |
| Mac companion | Raycast extension (React + TypeScript) | Calls knowledge hub backend API |

OAuth tokens for all sources are held server-side. The mobile app
authenticates only to the knowledge hub backend. This avoids embedding
secrets in the app binary and simplifies token refresh.

Private repos live on GitLab to maintain the IBM information barrier.
GitHub is used for public or non-IBM-sensitive projects only.

---

## Architecture decisions — resolved

| Decision | Resolution |
|---|---|
| Backend location | Hosted on Azure, not on-device |
| Multi-device sync | PostgreSQL on Azure is the single source of truth |
| OAuth token storage | Server-side only, managed by backend |
| Search indexing | PostgreSQL FTS initially |
| AI model | Azure AI Foundry only — no Anthropic API in the app |
| CMS integration | Direct Azure Blob Storage read/write via Managed Identity |
| Offline behaviour | Local SQLite cache for read-only offline access |
| Code quality | ESLint strict + GitLab SAST from day one |
| Private repo platform | GitLab (IBM information barrier) |
| Task management | Microsoft To Do via Graph API (primary); GitHub Issues for code tasks |
| Mac task capture | Raycast extension calling knowledge hub backend |
| Voice input | Whisper API for natural language task and idea capture |
| AI builder | GHCP as primary builder; Claude Code for bounded specific tasks only |
| CMS content type | Determined by categories, not a separate type field |
| Work email | Out of scope — IBM tenant blocks access |

---

## Architecture decisions — still open

| Decision | Notes |
|---|---|
| Sync frequency per source | Define per-source cadence before building sync layer |
| Data retention policy | How long to retain indexed content from each source |
| AI context window strategy | RAG confirmed; retrieval scoring to be defined |
| Write action confirmation model | UI pattern for confirming before AI executes write actions |
| Podcast platform | Resolve before building podcast integration — see notes |
| IBM work calendar | Delegated access test required before deciding — see pre-build validation |

---

## Sources — priority order

### Tier 1 — Build first

| Source | Integration method | Content type |
|---|---|---|
| Custom CMS (themicrosoftcloudblog.com) | Azure Blob Storage via Managed Identity | Blog posts, newsletter editions, podcast show notes, social push status |
| GitLab | REST API v4 | Commits, MRs, issues, pipeline status |
| GitHub | REST API v3 | Commits, PRs, issues |
| M365 Calendar (personal) | Microsoft Graph API | Events |
| Microsoft To Do | Microsoft Graph API | Tasks |

### Tier 2 — Build second

| Source | Integration method | Content type |
|---|---|---|
| Hotmail / personal email | Microsoft Graph API | Email summaries (not full body) |
| M365 email (personal) | Microsoft Graph API | Email summaries (not full body) |
| Podcast (RSS) | Spotify/Anchor RSS feed | Episode metadata, audio URLs, transcripts |
| Podcast (show notes) | Azure Blob Storage via Managed Identity | Full show notes HTML (already in CMS) |
| YouTube | YouTube Data API v3 | Episode video metadata, view counts |
| GitHub Issues | REST API v3 | Code-related tasks |
| MS Planner | Microsoft Graph API | Project-level task planning |

### Tier 3 — Build later

| Source | Integration method | Content type |
|---|---|---|
| IBM work calendar | Delegated Graph API access — subject to validation test | Read-only calendar events |
| Claude Projects sessions | Manual export via Cowork interim workflow | Session summaries as markdown |

### Nice to have — IBM Outlook read-only

If the delegated access validation test confirms that Microsoft Graph API
calls authenticate successfully against IBM's tenant using personal IBM
credentials from a non-IBM device, read-only access to the IBM work
calendar should be added as a Tier 3 integration. This would surface
work meetings and commitments in the unified timeline without any write
access or app registration against the IBM tenant.

Conditions for inclusion:
- Delegated access test must succeed (device code flow, no app registration)
- Read-only scope only — `Calendars.Read` via Graph, no write permissions
- IBM conditional access policies must not block non-compliant device access
- If IBM enforces Intune device compliance, this route is permanently closed

If the test fails, IBM work calendar remains permanently out of scope.

### Explicitly out of scope

| Source | Reason |
|---|---|
| IBM M365 email | IBM Azure AD tenant blocks OAuth app registration; delegated access unlikely for email |
| LinkedIn | API locked to approved partners |
| WhatsApp | No live sync path for personal messages |

---

## CMS integration detail

The blog CMS is a custom-built application hosted on Azure. Posts are stored
as individual JSON files in Azure Blob Storage, container `blogcontent`,
path `posts/<id>.json`. There are approximately 340 published posts.

File naming convention: `wp-<number>.json` — inherited from WordPress migration.
New posts continue this convention.

**The knowledge hub backend accesses the blob container directly using
Managed Identity. No API keys or connection strings are stored in the
knowledge hub codebase.**

### Content type identification

Content type is determined by the `categories` array — not a separate type
field. The knowledge hub must apply this logic when indexing CMS content:

| Category value | Content type in knowledge hub |
|---|---|
| `"Reaching for the Cloud"` | Newsletter edition |
| `"Podcast"` | Podcast show notes |
| Anything else | Blog post |

Category comparison must be case-insensitive. The category strings are
plain text, not slugs.

### Existing post schema

```json
{
  "id": "wp-1234",
  "title": "Post title",
  "slug": "url-friendly-slug",
  "date": "2026-03-01T10:00:00",
  "excerpt": "Short summary text...",
  "content": "<p>Full HTML...</p>",
  "featuredImage": "https://...",
  "categories": ["Category Name"],
  "tags": ["tag1", "tag2"],
  "status": "published"
}
```

`date` is ISO 8601 with no timezone — treat as UTC.
`status` is either `"published"` or `"draft"`.
Post URL structure is `/YYYY/MM/slug/` — derive year and month from `date`.

### Fields to add to post schema

Only three fields need adding. Do not add a `type` field — categories
already handle content type identification.

**`socialPush`** — tracks whether the post has been distributed to social
platforms. Updated by the knowledge hub AI write layer.

```json
"socialPush": {
  "linkedin": { "pushed": false, "pushedAt": null },
  "x": { "pushed": false, "pushedAt": null },
  "bluesky": { "pushed": false, "pushedAt": null }
}
```

**`podcastEpisode`** — optional. Present only on posts with category
`"Podcast"`. References the RSS `<guid>` of the corresponding episode,
enabling the knowledge hub to link show notes to episode metadata.

```json
"podcastEpisode": "episode-guid-from-rss"
```

**`sessionSummary`** — boolean. True only on markdown files exported from
Claude Projects sessions and pushed to the blob store. Allows the knowledge
hub to distinguish session exports from real CMS content.

```json
"sessionSummary": true
```

### Critical rules for GHCP

1. **Never write `content/posts/index.json`** — it is a stale derived cache
   regenerated server-side on publish. Direct writes will corrupt it.
2. **Post URLs are always `/YYYY/MM/slug/`** — derive year and month from
   the `date` field at render time. Never hardcode.
3. **Categories are case-sensitive in storage, case-insensitive in
   comparison** — always compare with `.toLowerCase()` in code.
4. **Change detection uses blob last-modified timestamps** — no file
   diffing required.
5. **Write access via Managed Identity covers both read and write** — the
   same identity used for reading is used for publishing and updating
   social push flags.

### Post index (`content/posts/index.json`)

A denormalised summary cache of all posts used for listing without loading
individual files. It is always stale by design and regenerated server-side.
The knowledge hub must never read from this file as a source of truth and
must never write to it under any circumstances.

---

## Podcast integration detail

The podcast (*Cloudy with a Chance of Insights*) has two data sources that
must be kept in sync. They serve different purposes and neither replaces
the other.

### RSS feed (canonical episode source)

URL: `https://anchor.fm/s/fb7dd7f4/podcast/rss` (Spotify/Anchor hosted)

The RSS feed is the source of truth for episode metadata — title, duration,
audio URL, publish date, Spotify link, and description. The knowledge hub
backend fetches and parses this feed to index episode data.

Episode slugs follow the pattern `ep<N>-<kebab-title>` (max 60 chars).

Fields available after RSS parsing:

```typescript
{
  id: string;              // from RSS <guid>
  slug: string;            // generated from title + episode number
  title: string;
  subtitle?: string;
  description: string;     // HTML from RSS
  descriptionText: string; // plain text version
  publishDate: string;     // ISO date
  duration: string;        // "HH:MM:SS"
  audioUrl: string;        // direct mp3 URL
  spotifyUrl: string;
  youtubeUrl?: string;     // extracted from description or overrides
  appleUrl?: string;       // from overrides
  transcript?: string;     // from overrides
  season?: number;
  episode?: number;
  imageUrl?: string;
}
```

### Podcast overrides (`content/podcast-overrides.json`)

Stored in Azure Blob Storage. Allows enriching RSS episode data without
editing the RSS feed. Currently empty. The knowledge hub should merge
override data on top of RSS data when indexing episodes.

### Show notes posts (CMS)

Each episode has a companion blog post in the CMS with `categories: ["Podcast"]`.
These contain full show notes, links, and embedded player HTML. The knowledge
hub links show notes to episodes via the `podcastEpisode` field (RSS guid).

### Podcast platform migration

The podcast is currently hosted on Spotify for Podcasters (formerly Anchor).
Migration to Buzzsprout or similar would provide a better API, cleaner
analytics, and broader directory distribution. This decision must be made
before building the podcast integration — migration mid-build would change
the RSS URL and break the integration.

If migration happens, update the RSS URL in the integration config before
building. Do not hardcode the RSS URL in application code — store it in
environment configuration.

---

## AI conversation layer

The AI layer is a core feature, not an add-on. It provides a persistent
conversation interface inside the app where the model has contextual
awareness of the user's aggregated content and can act on it.

The AI model is Azure AI Foundry only. No Anthropic API is used in the app.
GPT-4o for complex reasoning tasks; GPT-4o mini for lightweight tasks.
All usage billed against MSDN credits.

### Context architecture (RAG)

Every conversation turn uses a three-layer context structure:

**Static context (system prompt, every call)**
User preferences, communication style, code standards, identity separation
rules (personal vs IBM), and app configuration. Loaded from a config file
in blob storage. Updated occasionally, not per session.

**Project context (system prompt, every call)**
Current architecture decisions, source integration status, active project
state for Structara AI and other side projects. Stored as a markdown file
in blob storage, loaded fresh on each session open.

**Dynamic context (RAG, per turn)**
The backend runs a search against the PostgreSQL index on each turn,
retrieves the most relevant indexed content items for the current query,
and injects a summary into the context alongside the user message. This
keeps token usage manageable while ensuring relevant content is available.

Completed sessions are summarised and stored back into the blob store
as markdown files, making them retrievable by future RAG queries. This
creates a compound effect — each session builds on the history of previous
ones.

### Capabilities — read (on-demand, user-initiated)

- Summarise activity across sources for a given time period
- Cross-reference content across sources
- Answer questions about indexed content
- Suggest topics for blog posts, newsletter editions, or podcast episodes
- Propose a weekly plan based on calendar, open tasks, and recent activity
- Generate GHCP prompts based on architecture decisions, code standards,
  and current task context

### Capabilities — write (explicit user confirmation required before execution)

- Draft and publish blog posts or newsletter editions to the CMS
- Draft social posts for LinkedIn, X, or Bluesky
- Update `socialPush` flags in CMS post JSON after distribution
- Create tasks in Microsoft To Do or GitHub Issues
- Update code documentation based on recent commits or MRs
- Save brainstorming session output as a markdown file to blob storage

### AI design principles

- All write actions require explicit user confirmation before execution
- No automatic summarisation of all content on sync — user initiates
  AI interactions explicitly
- GPT-4o for complex reasoning; GPT-4o mini for lightweight tasks
- Context selection is intelligent — relevant content only, not full index
- Brainstorming sessions are saved and indexed, creating compounding value
  over time

---

## Raycast extension (Mac companion)

A lightweight Raycast extension that provides frictionless task and idea
capture on Mac without opening the app. Built in React and TypeScript,
consistent with the main app stack.

The extension calls the knowledge hub backend API directly, sharing the
same task creation and session export endpoints as the mobile app.

### Capabilities

- Global keyboard shortcut opens a minimal input overlay
- Voice input via Whisper API or typed text
- Natural language parsing — "remind me to call the accountant on Friday"
  creates a task with a due date in Microsoft To Do
- Push Claude Projects session content to blob storage as markdown
  (interim workflow until conversations happen natively in the app)
- Close or update existing tasks without opening the task management platform

### Limitations

- Mac only — Raycast is not available on Windows
- PC task capture: pinned browser shortcut to a minimal web form hitting
  the same backend endpoint is the pragmatic interim solution

---

## Core app features

### Unified timeline

All content from all sources in a single chronological feed.
Each item shows: source icon, date, title or summary, link to original.
Filter by source, date range, content type, or project context
(personal vs Structara AI vs IBM thought leadership).

### Search

Full-text search across all indexed content.
Results ranked by recency and relevance.
Filter by source.

### Source cards

Dashboard view showing each connected source as a card.
Card shows: connection status, last sync time, item count, most recent item.

### AI conversation

Persistent conversation interface with RAG-based context from indexed content.
Supports read queries and confirmed write actions.
Conversation history stored per session in PostgreSQL.
Completed sessions summarised and pushed to blob storage for future retrieval.
Chat UI built with react-native-gifted-chat or equivalent.

### Task capture and management

View and manage Microsoft To Do tasks and GitHub Issues in the timeline.
Create, update, and close tasks from within the app.
Voice capture available via Raycast extension on Mac.

### Diary and calendar

Personal M365 calendar events in the unified timeline.
IBM work calendar surfaced if delegated access validation succeeds (read-only).
AI can propose weekly plans based on calendar, tasks, and recent activity.

### Content publishing

Draft and publish blog posts and newsletter editions directly to the CMS.
AI assists with drafting based on recent activity and indexed content.
Review and confirm step before any publish action executes.

### Social push tracking

Per-post flags showing whether content has been pushed to LinkedIn, X,
and Bluesky. Updated manually or via AI write action. Stored in CMS JSON
as `socialPush` object with pushed boolean and timestamp per platform.

### GHCP prompt generation

AI generates GHCP prompts based on architecture decisions, code standards,
task context, and current project state. Output saved as indexed content
and available to copy directly.

### Notifications (later)

Alert on CI pipeline failure, PR awaiting review, or approaching calendar
event.

---

## User stories

### Content and publishing

- As Richard, I want to see all published blog posts, newsletter editions,
  and podcast episodes in a single timeline so I can see my output at a
  glance without opening multiple platforms.
- As Richard, I want to draft a blog post inside the app using AI assistance,
  review it, and publish it directly to the CMS without context-switching
  to a separate editor.
- As Richard, I want to mark a post as pushed to LinkedIn, X, or Bluesky
  so I have a clear record of where each piece of content has been distributed.
- As Richard, I want the AI to suggest my next blog post or newsletter topic
  based on recent GitLab and GitHub activity, calendar events, and what I
  have not covered recently.
- As Richard, I want to generate a GHCP prompt from within the app based on
  a task or architecture decision, ready to use in GHCP without writing it
  from scratch.

### Code and development

- As Richard, I want to see recent GitLab commits, MRs, and pipeline status
  alongside GitHub activity in a single feed so I know the state of all
  projects without opening both platforms.
- As Richard, I want to create a GitLab or GitHub issue from a voice capture
  via Raycast so I can log something the moment I think of it without breaking
  my flow.
- As Richard, I want to ask the AI to update a README or code comment based
  on recent commits so documentation stays current without manual effort.
- As Richard, I want GitLab SAST findings surfaced in my timeline so security
  issues are visible in the same place as everything else.

### Task and diary management

- As Richard, I want to capture a task by voice or keyboard shortcut via
  Raycast on Mac so the friction of logging something is low enough that I
  actually do it.
- As Richard, I want to see tasks and calendar events in the same timeline
  as content and code activity so I understand what I have to do alongside
  what I have done.
- As Richard, I want to ask the AI to propose a plan for my week based on
  my calendar, open tasks, and recent activity so I can start Monday with
  a clear picture.
- As Richard, I want to close or update a task from within the app or via
  Raycast without opening the task management platform directly.

### AI brainstorming and knowledge

- As Richard, I want to start a brainstorming session about a topic and have
  the AI reference my existing blog posts, podcast episodes, and recent code
  work as context so ideas build on what already exists.
- As Richard, I want brainstorming sessions saved as searchable content in
  the knowledge hub so I can reference them in future sessions and avoid
  repeating thinking I have already done.
- As Richard, I want to ask a question across all my content — "what have I
  written or built related to Copilot in the last six months" — and get a
  coherent answer rather than searching each system individually.

### Project separation

- As Richard, I want Structara AI activity kept clearly separate from IBM
  thought leadership content so there is never any ambiguity about which
  context I am working in.
- As Richard, I want to filter the timeline to a specific project context —
  personal, Structara AI, or IBM thought leadership — so I can focus without
  noise from other contexts.

---

## Pre-build validation tasks

These must be completed and their outcomes recorded before building the
relevant integrations.

### IBM work calendar — delegated access test

Run the Claude Code generated Node.js script (device code flow via
`@azure/identity` and `@microsoft/microsoft-graph-client`) to attempt
reading IBM calendar events using personal IBM credentials from a
non-IBM device.

Possible outcomes:

**Success** — Graph returns calendar events. Delegated access works.
Add IBM work calendar as a Tier 3 integration with `Calendars.Read` scope.
Update the sources table and architecture decisions accordingly.

**Conditional access policy block** — IBM tenant rejects the request due
to device compliance or app approval policy. IBM work calendar is
permanently out of scope. Note the specific policy error for the record.

**Partial success** — Authentication succeeds but specific scopes are
blocked. Evaluate what is actually accessible and decide accordingly.

---

## Code quality

GitLab SAST is included in the CI pipeline from day one via a single
include directive in `.gitlab-ci.yml`. No additional setup or external
service required for private GitLab repos — included free on all tiers.

ESLint with strict TypeScript rules (`@typescript-eslint/recommended-requiring-type-checking`)
runs locally and in CI as the primary quality gate. Warnings treated as
errors. Issues are caught before they reach SAST.

SonarCloud is not used at this stage. Revisit if the project moves to
public GitHub repos.

---

## What this is NOT

- Not a replacement for any of the source apps
- Not a team tool — personal use only
- Not a web app — mobile first, Raycast extension as Mac companion only
- Not connected to IBM systems (unless delegated calendar access validates)
- Not using the Anthropic API — Azure AI Foundry only in the app
- Not using Claude Code as the primary builder — GHCP builds, Claude Code
  for bounded specific tasks only
- Not an extension of the blog CMS — a completely separate project,
  connected to the CMS only via blob storage

---

## Development and deployment

### Platforms

- Development machine: Mac — correct platform for both iOS and Android builds
- Android testing: physical device via USB, no paid account required,
  Android Studio handles deployment
- iOS testing: Apple Developer account ($99/year) required for anything
  beyond basic sideloading — plan for this cost early
- Android first for initial testing; iOS once Android build is stable

### App Store / Play Store

- Google Play: one-time $25 registration fee
- Apple App Store: $99/year developer account
- Both require a working privacy policy covering calendar and email data
  access before submission
- Plan for at least one rejection and resubmission cycle on first attempt

---

## Interim workflow — Claude Projects to knowledge hub

Until the app is built and conversations happen natively in Azure AI Foundry,
significant Claude Projects sessions are exported to the blob store using
Cowork:

1. Complete a significant session in Claude Projects
2. Use Cowork to grab the conversation content from the browser
3. Cowork writes it as a markdown file to the knowledge hub blob container
4. Naming convention: `YYYY-MM-DD-topic-slug.md`
5. File includes `"sessionSummary": true` in its metadata

This content will be indexed and become part of the RAG context when the
app is built. Test this workflow with the current spec document as the
first push.

---

## Cost model

| Item | Cost | Notes |
|---|---|---|
| Azure AI Foundry (GPT-4o / mini) | Against MSDN credits (~£50 headroom) | Monitor consumption once live |
| Azure hosting (App Service) | Against MSDN credits | Alongside existing footprint |
| Azure Blob Storage | Against MSDN credits | Minimal at personal scale |
| Azure PostgreSQL | Against MSDN credits | Flexible server, smallest tier |
| Whisper API | Separate OpenAI account | Minimal at personal usage scale |
| Apple Developer account | $99/year | Required for iOS testing and submission |
| Google Play registration | $25 one-time | Required for Android submission |
| Claude Pro subscription | As now | For Claude Projects design sessions only |

No Anthropic API cost — Azure AI Foundry only in the app.

---

## Code standards

All code must follow the standards defined in MODELAIR_CODE_STANDARDS.md:
- No file over 200 lines
- Single responsibility per file
- Warnings treated as errors
- No inline magic strings or numbers
- Typed error hierarchy
- Consistent async/await patterns
- JSDoc on all public interfaces

---

## Next steps

1. Run IBM delegated access validation test (CC-generated script) and
   record outcome
2. Decide on podcast platform before building podcast integration
3. Add three new fields to CMS post JSON schema: `socialPush`,
   `podcastEpisode`, `sessionSummary`
4. Push this spec to blob storage via Cowork as first test of interim
   export workflow — naming convention: `2026-04-12-knowledge-hub-spec.md`
5. Resolve remaining open architecture decisions (sync frequency, data
   retention, write action confirmation UI pattern)
6. Define the unified content index data model
7. Spec the API integration layer for Tier 1 sources
8. Write GHCP prompts for each component
9. Build Tier 1 backend and test with Android device
10. Build Raycast extension once backend task endpoint is stable

---

## Notes

- Personal project, not IBM — maintain identity separation in all Azure
  resource naming, app registrations, and accounts
- Privacy policy required for App Store submission covering calendar and
  email data access
- ICO registration may need updating if the app processes third-party data
  (emails mentioning other people)
- Podcast RSS URL must be stored in environment config, not hardcoded —
  platform migration would change this URL
- PC task capture gap: Raycast is Mac only — pinned browser shortcut to
  a minimal web form is the pragmatic PC solution
- IBM work systems remain out of scope for email regardless of calendar
  outcome — email adds risk and complexity that calendar does not
- Featured images: legacy posts use `richardihogan.wordpress.com` CDN;
  new posts should use `mscloudblogs2026.blob.core.windows.net/images/`
  — knowledge hub should handle both when displaying post thumbnails
