---
target: Today page
total_score: 27
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-11-03T06-14-36Z
slug: knowledge-hub-web-src-pages-homepage-tsx
---
Method: dual-agent (A: today-design · B: today-evidence), supplemented by parent browser inspection.

Both local servers are running: frontend http://localhost:5173/ and backend port 3000 using production content, with scheduled jobs disabled locally. No application code or production content was changed.

## Design health: 27/40

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | System status | 3/4 | Header counts only the five displayed attention items |
| 2 | Real-world language | 3/4 | Due dates use activity-style elapsed time |
| 3 | User control | 3/4 | Clear selection and normal editors; regeneration consequences unclear |
| 4 | Consistency | 2/4 | Two Refresh buttons do different things |
| 5 | Error prevention | 2/4 | Recommendation regeneration looks like data reload |
| 6 | Recognition | 3/4 | Strong grouping; article evidence requires leaving the detail |
| 7 | Efficiency | 3/4 | Resizable panes and contextual Athena; verbose rows slow scanning |
| 8 | Minimalist design | 3/4 | Restrained identity; long angles consume the opening list |
| 9 | Error recovery | 3/4 | Source-specific retry controls; error wording not exercised |
| 10 | Help | 2/4 | Athena available; Refresh consequences unexplained |
| | **Total** | **27/40** | **Useful foundation with clarity issues** |

## Design specificity and overall impression

Today feels like Athena, not a generic dashboard: Carbon dark surfaces, restrained teal, real work, and the shared list/detail/Athena workbench. Preserve that identity, the approved first-position publishing picks, existing action locations and approved reading-title sizes.

The biggest opportunity is making the morning page quicker to understand, not making it more decorative.

The detector returned **0 findings** for HomePage.tsx. That narrow scan does not establish contrast or keyboard accessibility. Both assessment agents encountered browser session errors; the parent successfully inspected the populated default view and selected article in a fresh desktop browser canvas. The canvas was a narrow **744 CSS-pixel desktop pane**, not a mobile test. No horizontal document overflow was detected. No reliable detector overlay was produced, and wide-desktop layout, keyboard journeys and live error states remain unverified.

## What's working

- Three publishing recommendations give a bounded editorial starting point, with direct links into the existing draft editor.
- The shared review workspace keeps the selected item and Athena context together.
- Neutral colours, readable hierarchy and source-specific loading/retry states fit the quiet workbench.

## Priority issues

1. **[P1] The greeting understates attention work.** It says "5 things need your attention", while the list also says "25 other attention items". This makes a displayed shortlist sound like the complete workload. **Fix:** distinguish the total from the five shown, without expanding the list. **Command:** `/impeccable clarify`.
2. **[P1] Two Refresh buttons conceal different operations.** The header reloads data; the picks control generates replacement recommendations. **Fix:** keep both locations, but name the picks operation "Choose new picks" and explain that it replaces the saved shortlist. **Command:** `/impeccable clarify`.
3. **[P2] Default detail and the opening list disagree.** Initially the list begins with publishing picks, but the detail shows an overdue task whose selected row is below the opening viewport. This weakens the list/detail relationship. **Fix:** agree the initial-selection rule before changing it; keep the approved section order. **Command:** `/impeccable shape`.
4. **[P2] Long angles make recommendations slow to scan.** At the narrow desktop width, the three full explanations dominate the opening list. The selected detail then repeats the angle. **Fix:** agree whether the list should use a shorter preview while retaining the complete angle in detail. Do not silently remove content. **Command:** `/impeccable layout`.
5. **[P2] Deadline metadata reads like activity age.** Task rows say "20 days ago" rather than "Due 14 Oct" or "20 days overdue". Source code also maps future due dates to "Just now". **Fix:** use deadline-specific wording for tasks and elapsed times for events. **Command:** `/impeccable clarify`.

## Cognitive load and emotional journey

The three-pick choice and four selected-pick actions are bounded. Repeated long explanations and the initially unrelated detail increase orientation cost. The greeting is welcoming, but its count makes the work appear smaller than the list later reveals. Drafting and approval outcomes were not exercised against shared data.

## Persona flags

- **Power user:** identical Refresh labels interrupt a quick review-to-draft workflow.
- **First-time user:** the initial task detail does not explain why it differs from the articles at the top.
- **Keyboard/screen-reader user:** native selection buttons and aria-pressed are positive; operation-specific Refresh names and updated-detail announcements need attention. Keyboard behaviour was not tested.

## Minor observations

"Chosen Mon 22:11" lacks a calendar date. The detail correctly says "Suggested angle", but it contains no article excerpt; "Read article" opens the external source. Do not assume that an angle establishes full article retrieval.

## Decisions to resolve

Should Today initially open a posting pick or the most urgent task? Should the recommendation list show shorter previews, leaving the full angles in the existing detail pane? Both are user decisions, not approval to redesign.
