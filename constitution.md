# constitution.md

> This file is the authoritative guide for GitHub Copilot and all AI agents working in this
> repository. Read it in full before touching any file. It has two sections:
> **Repo Conventions** (permanent, codebase-wide rules) and
> **Current Session** (the active feature being built).

## Repo Conventions

> ⚠️  No repo conventions have been set yet. Edit this section in the SDLC Orchestrator
> (Scope → Repo Conventions) and re-run Spec Kit init to commit the updated file.

### Placeholder conventions
- Deliver all work via pull request. No direct pushes to `main` or any production branch.
- Every PR must pass CI before merge.
- Write or update tests for every changed behaviour.
- Follow existing code style. Do not reformat unrelated files.
- Prefer extending existing patterns over adding new frameworks or dependencies.
- Keep commits small and independently green.
- Do not delete or overwrite `.specify/` artefacts or this file.

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

### Specification: Today Page Triage Styling and Repo-to-Project Mapping Enhancement

**Summary:** Implement an incremental enhancement to the existing Personal Knowledge Hub by splitting the Today page "Needs attention" rendering into separate Overdue and Awaiting a decision sections, adding overdue severity styling based on days overdue, and replacing the broken GitHub activity "configure project tags" flow with a real repo-to-project mapping mechanism backed by a new repo_project_mappings table and settings UI. This change must preserve existing sync, scoring, and Planner logic while updating only rendering, data wiring, and settings behavior in the existing repository.

**Goals:**
- Improve Today page triage clarity by rendering overdue Planner tasks separately from Discover items awaiting workflow action.
- Visually distinguish overdue task severity using existing palette values and minimal row styling changes.
- Replace the non-functional GitHub activity project-tag configuration concept with a manual repo-to-project mapping tied to existing filing-role tags.
- Ensure the Today page GitHub activity card groups synced commits and pull requests by mapped project tag and excludes unmapped repos.
- Keep the enhancement incremental within the existing Personal Knowledge Hub codebase without changing underlying sync or business logic.

**In Scope:**
- Update the existing Today page rendering in knowledge-hub-web to split the current merged "Needs attention" list into two sections: Overdue and Awaiting a decision.
- Use existing data already returned to the Today page and perform a rendering-only split without changing source queries for Planner tasks or Discover items.
- Apply overdue severity tiers to overdue task rows using only left border and overdue text colour changes, with thresholds of 0-6, 7-30, and 31+ days overdue.
- Reuse the existing collapsed item count constant for each section's independent "Show N more" behavior rather than introducing a new hardcoded value.
- Add a backend database migration in knowledge-hub-backend for the repo_project_mappings table and index exactly as specified.
- Add backend read/write support in knowledge-hub-backend for listing connected repos from existing sync configuration, listing filing-role tags, reading existing mappings, and saving a mapping per repo.
- Replace the current GitHub activity settings action and copy with a new Manage repo mapping screen in knowledge-hub-web.
- Build the mapping screen as a simple table with one row per connected repo, mapped tag selection filtered to filing-role tags only, and a per-row save action.
- Confirm Carbon Dropdown props before implementing the mapping selector and style the new UI per repository conventions.
- Update the Today page GitHub activity card to join existing synced GitHub and GitLab activity against repo_project_mappings by repo_full_name and group results by mapped project tag.
- Update empty-state copy on the Today page GitHub activity card to reference repo mapping instead of project tags when zero mappings exist.
- Add JSDoc comments to all new functions and exported interfaces and keep all touched or added files under the 200-line limit.

**Out of Scope:**
- Any change to Planner task sync, due date calculation, or overdue determination logic.
- Any change to Discover relevance scoring, workflow state logic, or the definition of the `To Review` state.
- Any AI-based categorisation, inference, or tagging of commits, pull requests, or repositories.
- Any change to the existing tags taxonomy beyond selecting existing filing-role tags.
- Any fresh external API fetch for repos in the mapping screen; repo rows must come from existing GitHub/GitLab sync configuration already stored or exposed by the app.
- Any change to other Today page sections, including Sparks composer.
- Any change to mobile or Raycast clients unless they already share the same settings or Today page implementation and require a compile-safe adjustment only.

**Proposed Approach:**
In knowledge-hub-web, refactor the existing Today page "Needs attention" presentation into two independently rendered section components or sub-render blocks while preserving the current upstream data inputs. Derive an overdue Planner task collection from the existing merged inputs, sort it by computed days overdue descending, and derive an awaiting-decision Discover collection filtered to existing `To Review` items and sorted by discovery date descending as it is today. Each section should display its own heading, count, and local expansion state using the existing visible-item pagination constant imported from the current implementation. For overdue rows, add a small severity helper that computes the tier from days overdue and returns class names or style tokens mapped to existing palette constants, specifically neutral for 0-6 days, amber for 7-30 days using the existing TAG_COLOURS amber value `#ffb784`, and red for 31+ days using the existing TAG_COLOURS red value `#fa4d56`. Apply only border-left and overdue text colour changes in SCSS, leaving row dimensions, controls, and checkbox styling untouched.

In knowledge-hub-backend, add a migration to create repo_project_mappings and its index exactly as specified, plus any standard updated_at trigger pattern already used in the repository if one exists. Implement repository/service/controller support for: listing connected repos from the existing sync configuration source already used by the app, listing filing-role tags from the existing tags table, listing current repo mappings, and upserting a mapping by repo_full_name. Keep the data model anchored to the existing tags table and do not introduce a new project entity. Expose minimal endpoints needed by the existing app, following current Express and TypeScript patterns.

In knowledge-hub-web settings, replace the broken GitHub activity settings action with navigation to a new Manage repo mapping screen. Build a table-style UI with one row per connected repo, showing repo full name, current mapping state, a filing-tag-only selector, and a save action per row. Repos without a mapping should display an explicit Unmapped state in the UI. Use the existing TagPicker if it already supports filtering by role cleanly; otherwise use a Carbon Dropdown after confirming the correct props via the Carbon MCP server. Add full styling in the relevant SCSS/global.scss using existing naming conventions and dark theme overrides.

For the Today page GitHub activity card, update the existing backend query or aggregation path so commits and pull requests from existing sync data are associated to repo_project_mappings by repo_full_name, then grouped by mapped project tag for response/rendering. Unmapped repos must be excluded silently from the Today page card. If there are no mappings at all, return or render the corrected empty state copy: "No repos mapped yet. Set up repo-to-project mapping in settings." with a link to the new mapping screen. Remove all remaining references to "configure project tags" in this flow. Keep implementation incremental, split logic into small files if needed to respect the 200-line limit, and add JSDoc to all new functions and exported interfaces.

**Acceptance Criteria:**
- The Today page no longer renders a single merged "Needs attention" list and instead shows two sections in this order: Overdue, then Awaiting a decision.
- The Overdue section contains only Planner tasks past their due date and is sorted by days overdue descending.
- The Awaiting a decision section contains only Discover items in `To Review` state and is sorted by discovery date most recent first.
- Each section displays its own heading and item count.
- Each section has its own independent collapsed/expanded "Show N more" behavior using the existing pagination/display-count constant rather than a newly hardcoded number.
- Overdue task rows 0-6 days overdue retain neutral styling with no border change and overdue text colour `#c6c6c6`.
- Overdue task rows 7-30 days overdue show a 2px left border and overdue text colour using the existing amber palette value `#ffb784`.
- Overdue task rows 31+ days overdue show a 2px left border and overdue text colour using the existing red palette value `#fa4d56`.
- No overdue severity styling change alters row height, padding, Done/Snooze button styling, or checkbox icon styling.
- A repo_project_mappings table exists in the database with columns and constraints matching the provided schema, including a unique repo_full_name and foreign key to tags(id).
- An index exists on repo_project_mappings(project_tag_id).
- The settings flow no longer references "configure project tags" for GitHub activity.
- A Manage repo mapping screen exists in knowledge-hub-web and lists one row per connected repo sourced from existing sync configuration rather than a fresh external API call.
- Each repo row shows the repo full name, current mapped filing tag or Unmapped state, a filing-role-only selector, and a per-row save action.
- Saving a repo mapping persists repo_full_name to project_tag_id in repo_project_mappings without creating any new project taxonomy.
- The Today page GitHub activity card groups commits and pull requests by mapped project tag using repo_full_name joins against repo_project_mappings.
- Repos with no mapping are excluded from the Today page GitHub activity card without showing an error on the Today page.
- If zero mappings exist, the Today page GitHub activity card shows the empty state copy: "No repos mapped yet. Set up repo-to-project mapping in settings." and links to the new mapping screen.
- No user-facing copy in this flow refers to GitHub commit or PR tags or to configuring project tags.
- All new functions and exported interfaces include JSDoc comments.
- No added or modified file exceeds 200 lines.

> See `.specify/spec.md` for the full specification and `.specify/tasks.md` for the issue task list.