# Competitor and market monitoring in Discover Watchlists — spec

**Status:** refining (not built). Product spec use case 5 (`docs/athena-spec.md`) and backlog item 11 (`docs/planned-features.md`). It absorbs backlog item 4, "Why Athena picked this".

**Development corrections, 18 October 2026 (awaiting owner review):** a
watchlist searches the web for each named competitor; existing Discover feeds
are optional extras. Manual comparison text is optional. The creation form calls
the monitored-name field **Competitor list**, ignores empty extra rows, and
reports validation beside Save rather than silently disabling it. Form drafts
are retained in this browser tab across closing/reopening and reload, scoped to
the signed-in identity/session; successful saves clear the draft and select the
saved watchlist. Storage failures are visible. Automated tests remain deferred
until the owner has reviewed the feature.
Retained new-watchlist drafts also appear on the Watchlists page as **Unsaved
draft**, with their entered competitors and a **Continue editing** action;
closing the form is not presented as a successful save.
The draft shows the exact missing required fields. Complete drafts can be saved
directly from that page; restored forms highlight and focus blocking fields.
Archived projects are excluded from new selections, while existing selections
are preserved.

The report leads with **What you need to know now**: a count of saved developments
and evidence-grounded synthesis, followed by up to five developments distributed
across companies, repeated fields and project implications. Coverage is supporting
metadata below the synthesis, with missing-entity warnings, source health and dated
evidence windows behind **View coverage details**. Observation dates never imply
that an event or publication is recent. **Company by company** keeps one company's
findings in view at a time, with keyboard-accessible company tabs. Each finding
shows what changed and why it matters, with provenance, Microsoft involvement,
uncertainty and project detail available on demand alongside its own citations.
There are no suggested responses, report filters or Create use case actions.
No meaningful change, incomplete coverage, no evidence, failed checks and stale
checks remain distinct; silence is not reported as reassurance. Research
configuration and monitoring history are secondary and collapsed. The report and controls
use Athena's shared Carbon surfaces, teal accent, typography, spacing and control
tokens rather than a separate blue visual theme. Existing analysis text is
preserved, not rewritten by the presentation layer.
New analyses use current saved project information and indexed project notes and
documents, including when manual comparison text is provided. Linked projects
focus the comparison; otherwise active projects are considered (up to 20, ordered
by importance and priority). Microsoft involvement must be explicit in the
competitor's sources. Project impact must relate to supplied project capabilities,
not merely a shared AI theme. Older reports retain their original findings and
explicitly mark Microsoft involvement as not separately assessed.
The monitoring brief is collapsed so the latest analysis appears first.
**Impact on your work** groups structured
assessments by saved project, linking each implication back to its finding.
New analyses explicitly distinguish high, medium and low material relevance,
no material impact identified, and insufficient evidence. These are not a
relabelling of the existing confirmed-overlap, possible-relevance and
insufficient-context relationships. An absent assessment does not establish no
impact. Each supplied project is assessed at least once across a nonempty report,
not repeatedly against every finding. High-relevance assessments lead the project
section; company developments retain their existing breadth-first order.
Confirmed overlap, possible relevance and insufficient context remain distinct;
differentiation requires support from both project context and competitor sources,
not invented scores or assumptions. Repeated fields across competitors are
listed only when multiple competitors have findings in that field. Narrow
layouts retain the reading order. Historical findings without structured
project assessments keep their original impact text and are labelled accordingly.

On wide containers the reading column uses approximately 70% of the available
space, with prose bounded to 72ch. A sticky context rail uses the remainder for
compact project explanations linking to the full assessment, **Watch next**, and
coverage counts. It sticks inside the application's scrolling content pane and
stacks below the main content in narrower containers. Typography and separators
distinguish signal, evidence and interpretation without nested cards.

This reuses the existing monitoring run, evidence collection, project context,
JSON finding storage, history and knowledge retrieval. The same model call and
output budget produce optional concise headlines, evidence highlights with
finding-specific citations, and evidence-grounded watch signals. A watch signal
identifies evidence to monitor, not a prediction, task or competitive-response
recommendation. Optional project watch signals inherit their finding's evidence.
The parser bounds the new text and rejects invalid project identities, relevance
states and citations outside the finding. Historical reports are neither rewritten
nor automatically rerun: their original change text and overlap labels remain,
with missing structured content explicitly identified. No second ingestion or
analysis pipeline, render-time model call, new dependency or migration is needed.

## Summary

This would add competitor and market monitoring to Athena, using blogs, news announcements and press releases as inputs. The aim is to identify meaningful competitive change against an explicit comparison baseline, rather than produce another news digest.

It matters if it changes a decision, exposes a weak assumption, or saves meaningful research time. If it only summarises press releases, it does not justify itself.

## Why it fits

Discover would collect and monitor the material, and Athena would interpret it. Athena already collects this material. The value added is organising it around who is being watched, why, and what has changed over time.

The name can mislead. If this is "competitor analysis" in name but only gathers what competitors publish, it adds little. The useful version compares the evidence against an explicit baseline and sets out implications the user can challenge.

## Users and their needs

- As a user, I want Athena to keep track of the organisations and products I care about, remember their previous position, and tell me when something changes that challenges my thinking or affects my work.
- As a user, I want monitoring attached to a specific question or purpose, so that the same company can be treated differently in different contexts.
- As a user, I want dated, saved records with supporting evidence, so that Athena does not reconstruct the comparison from scratch each time.
- As a user, I want "no meaningful change" to be a valid outcome, so that I do not get noise presented as insight.

## What it does

It monitors organisations, products and themes against an explicit competitive question.

Proposed capabilities:

- Watchlists organised around a purpose, not just a feed of articles.
- Dated, evidence-backed claims about what an organisation says it offers, who it targets, availability, pricing where published, and supporting evidence.
- Clear distinction between positioning, announced capability, documented availability and reported customer outcomes.
- Change tracking over time, including new capabilities, shifts in target buyers, changed messaging, partnerships and commercial changes.
- De-duplication of syndicated press releases, so one event is not treated as multiple corroborating sources.
- Analytical output on what changed, why it matters to the comparison, what remains uncertain, and whether any response is warranted.
- Athena queries over saved records, such as:
    - "What changed this month?"
    - "How does this compare with our proposition?"
    - "Is this new capability or new wording?"

## Screens and flow

The proposed flow:

1. **Discover → Articles** for triaging individual blogs, announcements and press releases.
2. **Discover → Watchlists** for monitored organisations and products, comparison criteria, and dated history of meaningful changes.
3. **Athena** for interpretation across those saved records.
4. **Think** for briefs the user explicitly chooses to save or develop, rather than every automated observation.

Also:

- Watchlists would be app-wide, with optional project links.
- Each finding should link back to its supporting articles.
- The first version should not include an elaborate dashboard.

## Data and integrations

Inputs:

- Blogs
- News announcements
- Press releases
- Relevant product or documentation pages

Implementation direction:

- Extend Discover for collection and monitoring.
- Reuse existing Discover ingestion rather than build a second article ingestion system.
- Use RSS where available, with targeted page checks or searches elsewhere.
- Allow the same organisation or product to appear in multiple watchlists without duplicating underlying source material.
- Keep public competitive evidence separate from confidential internal comparisons, especially where the analysis may inform public writing.

A watchlist would hold:

- Name and description
- A specific monitoring question or purpose
- Optional project links
- Monitored organisations and products
- Relationship labels such as competitor, partner, platform provider or market reference
- Explicit comparison baseline
- Comparison criteria
- Active or paused state
- Monitoring cadence and last-run status

Baseline handling:

- The baseline should be explicit and not silently inferred from the currently open project.
- Manual text with optional links to existing project material or notes was proposed.
- Baseline changes should be versioned so historical findings retain the baseline version used at the time.

## Governance, risks and dependencies

- The comparison baseline is the load-bearing issue. Without it, this risks becoming a news digest instead of competitive intelligence.
- Saved records are needed; a chat response alone loses the history that makes comparison useful.
- Public competitive evidence and confidential internal comparisons should be kept separate.
- Syndicated publication should not be mistaken for corroboration.
- "No meaningful change" should be an acceptable answer.
- It depends on existing Discover collection, persistence, background jobs, authentication and Athena tooling.

## Fit with the rest of Athena

- **Use cases (product spec section 6).** This spec is tracked as a use case. A watchlist finding should also offer "→ Use case", so a competitive change can become a product idea.
- **"Why Athena picked this" (backlog item 4) is merged in here.** Both rely on an explicit model of what the user cares about. Watchlists are the stronger form: a purpose, a baseline and criteria, rather than topic weights alone. Build item 4's server-side weights and pick reasons as part of this work, not separately.
- **Editable Athena memory (backlog item 7).** The versioned baseline should follow the same pattern: visible, editable, with a reviewable change history.
- **Parked "ask the archive".** Questions over saved findings, with citations, use the same approach. Build one retrieval pattern, not two.
- **Fabric (`docs/fabric-iq-assessment.md`).** Not needed. Postgres is sufficient at this scale.

## Decisions so far

- Product spec use case 5, tracked in Plan → Use cases (October 2026).
- Backlog item 4 is folded into this work.

## Open questions

- Should this live in Discover or somewhere else?
- If it lives in Discover, should it be a dedicated **Watchlists** view rather than a new top-level section?
- What should the first watchlist question be?
- Which organisations, products or themes should be included first?
- What explicit baseline should the first watchlist use?
- Which comparison criteria should be configured by default?
- What should the first-version scope be: for example, one competitive question, five organisations, and a weekly change brief with deeper comparisons on demand?
- At what point, if any, should this move into a separate **Intelligence** section?

## Next steps

- Decide where this capability should live in the product.
- Choose one competitive question for the first pass.
- Define the explicit baseline and comparison criteria for that question.
- Select a small initial set of organisations or products to monitor.
- Reuse existing Discover sources and link supporting articles to findings.
- Test the output against the stated standard: does it change a decision, expose a weak assumption, or save meaningful research time?

## Sources

_Not discussed yet._
