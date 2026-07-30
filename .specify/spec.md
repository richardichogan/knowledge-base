# Spec: Today Page Triage Styling and Repo-to-Project Mapping Enhancement

## Summary
Implement an incremental enhancement to the existing Personal Knowledge Hub by splitting the Today page "Needs attention" rendering into separate Overdue and Awaiting a decision sections, adding overdue severity styling based on days overdue, and replacing the broken GitHub activity "configure project tags" flow with a real repo-to-project mapping mechanism backed by a new repo_project_mappings table and settings UI. This change must preserve existing sync, scoring, and Planner logic while updating only rendering, data wiring, and settings behavior in the existing repository.

## Goals
- Improve Today page triage clarity by rendering overdue Planner tasks separately from Discover items awaiting workflow action.
- Visually distinguish overdue task severity using existing palette values and minimal row styling changes.
- Replace the non-functional GitHub activity project-tag configuration concept with a manual repo-to-project mapping tied to existing filing-role tags.
- Ensure the Today page GitHub activity card groups synced commits and pull requests by mapped project tag and excludes unmapped repos.
- Keep the enhancement incremental within the existing Personal Knowledge Hub codebase without changing underlying sync or business logic.

## Proposed Approach
In knowledge-hub-web, refactor the existing Today page "Needs attention" presentation into two independently rendered section components or sub-render blocks while preserving the current upstream data inputs. Derive an overdue Planner task collection from the existing merged inputs, sort it by computed days overdue descending, and derive an awaiting-decision Discover collection filtered to existing `To Review` items and sorted by discovery date descending as it is today. Each section should display its own heading, count, and local expansion state using the existing visible-item pagination constant imported from the current implementation. For overdue rows, add a small severity helper that computes the tier from days overdue and returns class names or style tokens mapped to existing palette constants, specifically neutral for 0-6 days, amber for 7-30 days using the existing TAG_COLOURS amber value `#ffb784`, and red for 31+ days using the existing TAG_COLOURS red value `#fa4d56`. Apply only border-left and overdue text colour changes in SCSS, leaving row dimensions, controls, and checkbox styling untouched.

In knowledge-hub-backend, add a migration to create repo_project_mappings and its index exactly as specified, plus any standard updated_at trigger pattern already used in the repository if one exists. Implement repository/service/controller support for: listing connected repos from the existing sync configuration source already used by the app, listing filing-role tags from the existing tags table, listing current repo mappings, and upserting a mapping by repo_full_name. Keep the data model anchored to the existing tags table and do not introduce a new project entity. Expose minimal endpoints needed by the existing app, following current Express and TypeScript patterns.

In knowledge-hub-web settings, replace the broken GitHub activity settings action with navigation to a new Manage repo mapping screen. Build a table-style UI with one row per connected repo, showing repo full name, current mapping state, a filing-tag-only selector, and a save action per row. Repos without a mapping should display an explicit Unmapped state in the UI. Use the existing TagPicker if it already supports filtering by role cleanly; otherwise use a Carbon Dropdown after confirming the correct props via the Carbon MCP server. Add full styling in the relevant SCSS/global.scss using existing naming conventions and dark theme overrides.

For the Today page GitHub activity card, update the existing backend query or aggregation path so commits and pull requests from existing sync data are associated to repo_project_mappings by repo_full_name, then grouped by mapped project tag for response/rendering. Unmapped repos must be excluded silently from the Today page card. If there are no mappings at all, return or render the corrected empty state copy: "No repos mapped yet. Set up repo-to-project mapping in settings." with a link to the new mapping screen. Remove all remaining references to "configure project tags" in this flow. Keep implementation incremental, split logic into small files if needed to respect the 200-line limit, and add JSDoc to all new functions and exported interfaces.

## Acceptance Criteria
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