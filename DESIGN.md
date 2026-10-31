---
name: Athena
description: A compact, dark knowledge and work hub built on Carbon g100 with a restrained teal accent.
colors:
  background: "#161616"
  surface: "#262626"
  surface-raised: "#393939"
  text-primary: "#f4f4f4"
  text-secondary: "#c6c6c6"
  text-helper: "#a8a8a8"
  border-subtle: "#525252"
  border-strong: "#6f6f6f"
  accent: "#3ddbd9"
  accent-tint: "rgba(61, 219, 217, 0.08)"
  accent-border: "rgba(61, 219, 217, 0.25)"
  prose-link: "#5fa898"
  prose-link-hover: "#82c4b4"
  focus-carbon: "#ffffff"
  success: "#42be65"
  warning: "#f1c21b"
  error: "#fa4d56"
  motion-blue: "#4589ff"
  motion-blue-light: "#78a9ff"
  motion-blue-deep: "#0f62fe"
  motion-blue-pale: "#a6c8ff"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.75rem"
  section:
    fontSize: "1.25rem"
    fontWeight: 600
  item:
    fontSize: "1.125rem"
    fontWeight: 600
  panel-title:
    fontSize: "1.125rem"
    fontWeight: 600
  panel-section:
    fontSize: "0.9375rem"
    fontWeight: 600
  utility-button:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: "0.75rem"
    letterSpacing: "0.08em"
rounded:
  sm: "2px"
  md: "4px"
  lg: "8px"
  pill: "999px"
spacing:
  tight: "4px"
  small: "8px"
  medium: "12px"
  standard: "16px"
  panel: "24px"
components:
  accent-button:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent}"
    typography: "{typography.utility-button}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  ghost-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.utility-button}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  dialog-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  identity-chip:
    rounded: "{rounded.pill}"
    typography: "{typography.meta}"
    padding: "2px 8px"
---

# Athena design guide

## Overview

This is a **reference for the existing application, not a proposed redesign**.
It was extracted from the current frontend on 23 October 2026. Its working
description is a **quiet workbench**: dense enough for daily work, legible enough
for sustained reading, with restrained colour carrying meaning rather than
decoration. That description is inferred from the implementation, not a new
brand decision.

Athena combines notes, diagrams, tasks, projects, research and an embedded AI
assistant. Design for a person moving between those activities without losing
context. The main application is desktop-first, including its Electron wrapper.
Only the standalone chat interface is designed for mobile.

### Using this with Claude Design

Upload this file as the design reference, then use this brief with the specific
screen or interaction you want:

> Design [screen or workflow] for Athena using the attached design guide.
> Preserve its Carbon g100 dark theme, compact desktop workbench, teal accents
> and existing navigation. This is a product screen, not a marketing page.
> Keep real content, controls and states; do not invent product capabilities,
> metrics or testimonials. Use the supplied tokens and reproduce the component
> relationships, not just the palette. Show realistic populated, loading,
> empty, error, focus and selected states where relevant. For side panels,
> show the design at about 400px wide as well as in its desktop context.
> Only make a mobile layout if this is standalone chat. Distinguish any proposed
> departures from the existing design. Return a design that can be implemented
> in React with Carbon components and SCSS, without introducing a new UI kit.

Supply a current screenshot of the relevant screen alongside this guide when
possible. A screenshot establishes its current composition; this file establishes
the reusable rules. No screenshot or live-browser audit was used to prepare this
guide.

## Colors

The base is **Carbon g100**, not a generic blue-black dashboard. Use neutral
greys for most of the screen. Use teal for Athena actions, selected navigation,
focus accents and identity, not for every border or paragraph.

| Role | Existing token | Value |
|---|---|---|
| Application background | `--cds-background` | `#161616` |
| First surface | `--cds-layer-01` | `#262626` |
| Raised/nested surface | `--cds-layer-02` | `#393939` |
| Main text | `--cds-text-primary` | `#f4f4f4` |
| Supporting text | `--cds-text-secondary` | `#c6c6c6` |
| Helper text | `--cds-text-helper` | `#a8a8a8` |
| Subtle border | `--cds-border-subtle-01` | `#525252` |
| Strong border | `--cds-border-strong-01` | `#6f6f6f` |
| Athena accent | `--kh-accent` | `#3ddbd9` |
| Accent surface | `--kh-accent-bg` | `rgba(61, 219, 217, 0.08)` |
| Accent border | `--kh-accent-border` | `rgba(61, 219, 217, 0.25)` |
| Prose link / hover | `--kh-link-prose` / `--kh-link-prose-hover` | `#5fa898` / `#82c4b4` |
| Success / warning / error | Carbon support tokens | `#42be65` / `#f1c21b` / `#fa4d56` |

Carbon also supplies interactive blue in its own components; teal does not replace
every Carbon token. Use the actual context-specific token rather than globally
recolouring the library.

**Content-type colour is semantic.** Existing note badges use green for blog
(`#6fdc8c`), teal for podcast/use case (`#3ddbd9`), purple for newsletter/show
notes (`#be95ff`), blue for project/architecture (`#78a9ff`), yellow for note
(`#f1c21b`), red for script (`#ff8389`), orange for meeting (`#ff9f5a`), cyan for
research (`#33b1ff`) and pink for spec (`#ff7eb6`). Badge backgrounds use a 10%
tint. Keep readable labels; colour is not the only way to identify type.

Project and topic chips use their saved identity colour. Group chips are neutral.
Do not replace these meanings with an arbitrary rainbow.

## Typography

The root is 16px. The app's body stack is the native system sans-serif stack in
the frontmatter; don't substitute a decorative font. Some Carbon components
retain their own library typography. IBM Plex Mono is used selectively for
utility buttons and technical metadata, not as the default reading face.

| Purpose | Size | Weight |
|---|---|---|
| Body / panel prose | 14px (`--kh-text-body`) | Regular |
| Metadata / small labels | 12px (`--kh-text-meta`) | Regular or medium |
| Content section heading | 20px (`--kh-heading-section`) | Semibold |
| Item / panel title | 18px (`--kh-heading-item`, `--kh-panel-title`) | Semibold |
| Section inside a panel | 15px (`--kh-section-title`) | Semibold |

Expanded reading/detail titles in Discover and Today (including the shared
Plan task detail) use 32px, increasing to 40px in detail panes at least 700px
wide, with semibold weight and 1.25/1.2 line height. This shared reading-title
treatment is user-approved; it does not change the 24px workspace page header.

Keep headings, descriptions and prose flush-left on one shared text edge.
Do not justify prose or add a first-line indent. Preserve actual bullet markers,
hanging alignment and nested indentation; prose lists use `--kh-list-indent:
2rem`. Lists are not decorative rows.

Use semibold and restrained emphasis for hierarchy. Utility buttons may use
uppercase mono labels with 0.08em tracking; don't apply that treatment to body
copy, every heading or the main navigation. Longer reading surfaces commonly
use line heights around 1.6-1.7; navigation uses about 1.4.

## Layout

The current shell has a **48px fixed top header** (`--kh-header-height`) and a
flex content region below it. Primary destinations are in the header; secondary
tools live in a menu. Do not invent a permanent sidebar simply because an old
`--sidebar-width` variable exists.

Use 4/8/12/16/24px spacing as the working rhythm. Controls are normally **36px**
high, or **32px** in compact contexts. Header navigation has at least **44px**
targets; tool-menu rows have at least **48px** height.

Main workspace page headers use **24px titles**, **24px top and side gutters**,
a **64px header height**, 8px bottom padding and the same Carbon bottom divider. Subtitles sit
beneath the title; existing actions remain at the right. The shared PageHeader
owns this geometry, rather than individual destinations.

Owning panels apply their horizontal gutter once. Nested metadata, sections and
previews must not add successive horizontal insets. Bordered fields and
independent cards have their own internal inset, shared by heading and body.

The shell controls page scrolling. Panels and split views need `min-height: 0`
and `min-width: 0` where appropriate so content can shrink and scroll instead of
forcing the whole viewport wider. Preserve the existing resizable
editor/list/Athena relationships rather than nesting the entire app in cards.

The navigation changes around **1100px**, with additional narrow-screen
adjustments at **600px**. These are navigation breakpoints, not evidence that all
product screens have a mobile design.

**Compact Athena is about 400px wide.** Collapse action labels to accessible
icon-only controls where the existing UI does so. Do not wrap the persona row
or introduce a horizontal scrollbar. Standalone mobile chat must retain a
usable composer, readable replies and keyboard-safe height.

## Elevation & Depth

Depth comes mainly from neutral tonal layers and borders. Routine lists and
panels should not look like floating marketing cards.

Menus use a restrained shadow (`0 8px 24px rgba(0,0,0,0.4)`). Shared dialogs use
`0 24px 64px rgba(0,0,0,0.5)` with a dark backdrop
(`rgba(0,0,0,0.68)`). Reserve these for genuine overlays.

Popovers that extend beyond a diagram or chat container must not be clipped by
that container. Preserve the top-layer/anchored-popover behaviour, viewport
clamping, focus handling and dismissal. A higher z-index alone does not solve
overflow clipping.

## Shapes

Use the existing radius scale: **2px** small, **4px** controls/cards,
**8px** panels/dialogs. Pills (**999px**) are for chips and badges, not large
panels. Use fine borders and precise alignment rather than heavy outlines or
oversized rounding.

The standard and agentic diagram editors are an intentional exception to dark
surfaces, following the user-approved **Athena Modern Diagrams** reference:
a **white sheet** with `#e0e0e0` dots, white step cards with 12px corners,
1px `#e0e0e0` borders and soft, neutral shadows (0/2/3px at 8% and
0/0.5/0.5px at 10%, `#161616`). This appearance is shared by the editor
and SVG/PNG exports, including previews. Stored geometry and metadata are
not migrated. Transparent exports remain transparent; draw.io retains its
native shapes and stored colours.

Decisions use softened diamonds, `#fffbeb` fill and `#f1c21b` borders;
agentic gates use `#fff1f1` and `#fa4d56`. Groups use 20px corners and
`#f7f4ff` / `#e8daff` tint/border, retaining their existing header and
collapse controls. Terminator and document silhouettes remain identifiable.
Notes retain their semantic glyphs, in yellow `#fcf4d6` / `#8e6a00` tiles.
New labels default to 14px IBM Plex Sans; preserve existing text sizes and
explicit alignments. Role labels use 9px semibold; status/control chips use
9px type in 16px-high pills.
Inline label editing uses an opaque white surface, dark text and caret, and
white selected text on the blue focus colour. Keep its existing position and
Enter/Shift+Enter/Escape behaviour.

Agentic role tiles use Human `#edf5ff` / `#0f62fe` / `#0043ce`,
Steward `#fff0f7` / `#d02670` / `#9f1853`,
Worker `#f6f2ff` / `#8a3ffc` / `#6929c4`,
Specialist `#fff2e8` / `#eb6200` / `#8a3800`, and
System `#f4f4f4` / `#525252` / `#393939` (tint/icon/ink).
Channel retains `#d9fbfb` / `#007d79` / `#005d5d`; gates retain red.
Use the installed Carbon icons, never remote icon/font requests. Labels come
from existing metadata: do not invent owners, actor roles or group numbers
for ordinary flowcharts. Small or explicitly aligned nodes retain their
existing label layout and type chip rather than crowding in an icon tile.
Process, decision, terminator and document shapes expose **Header** and **Icon**
in the existing Properties panel. Headers support custom text, Agent/Human/Pipeline
presets, or none; icons support automatic, none or a local Carbon glyph. These
are independent presentation settings, never changes to an AI step's semantics.
Explicit choices reserve space inside the existing shape without moving or
resizing it; long headers ellipsize. Automatic agentic headings retain the
metadata defaults above. Standard header presets use purple Agent, green Human
(`#defbe6` / `#24a148` / `#0e6027`) and blue Pipeline tiles. Existing titles,
Properties controls and inline text editing remain in place.
Cards keep the **icon on the left**. The header and main text form a
**left-aligned text block to its right**, separated from the icon tile by 4px,
inside an 8px card inset. Centre that text block **top-to-bottom** within the
shape; the icon shares its vertical midpoint. Do not horizontally centre the
text or stack it under the icon. Default glyphs are 22px inside 28px tiles.
Browser wrapping measures the rendered font without a second padding inset.
Preserve authored line breaks, font sizes, explicit alignment settings and
shape geometry in editor and SVG/PNG exports.

Shape edges/centres and equal-spacing targets are measured from the raw pointer;
the nearest target wins per axis within eight screen pixels. Grid snapping is
the fallback, not a pre-rounding step. Distance guidewires sit outside shapes,
with dotted witnesses, end caps and zoom-stable values; equal gaps are purple.
Preserve separate Snap controls, Alt bypass and Shift aspect-ratio resizing.
PII uses `#fff1f1` / `#a2191f`; controls use `#defbe6` / `#0e6027`;
Future retains its dashed blue outline. Real findings alone produce
blue information, yellow warning and red blocking dots.

Connectors use rounded bends without changing their routes, ports or line
jumps. Standard lines are 1.5px `#8d8d8d`; No/rework is dashed red
`#da1e28` (4/4). Agentic async/flow uses `#6f6f6f`, sync uses
1.25px `#a8a8a8` (4/4), and control uses red (5/4). Existing authored
data-blue/custom strokes remain intact. White branch pills use green Yes
(`#198038`, border `#a7f0ba`) or red No (border `#ffd7d9`).

Recognised shipped defaults receive the modern appearance. Other custom
colours remain available; the legacy contrast palette is retained for
non-default shapes. Fill choices include Blue `#a6c8ff`, Purple `#d4bbff`, Cyan `#82cfff`,
Teal `#3ddbd9`, Green `#6fdc8c`, Magenta `#ffafd2`, Red `#ffb3b8`,
Yellow `#f1c21b` and Orange `#ffb784`, plus white, grey and no fill.
Newly chosen fills are saved as selected.
Multi-selection supports shared colours, thickness, text size and line styles
in Properties and contextual styling; mixed values stay unchanged until chosen.
Preserve alignment guides and selectable 5/10/20/40 grid spacing (default 10).

The brainstorm canvas follows the user-approved **Two-Sided Card Tree**
reference on the same white, `#e0e0e0`-dotted sheet. Cards are white with
1px `#c6c6c6` borders and 4px corners, a 26px tinted icon tile on the left,
a mono uppercase type label in the type's ink and a 13.5px semibold title.
Tiles: note `#d9fbfb`/`#007d79`, document `#edf5ff`/`#0f62fe`, idea
`#fcf4d6`/`#b28600`. The first card is the root: `#f2fcfc` fill, 2px `#007d79`
border. Size follows depth in the drawn tree for all card types: centre 300px
wide / 18px title, level 2 branches 240px / 16px, level 3 cards 190px / 13.5px,
level 4 cards 170px / 12px and level 5 cards 150px / 11px. Levels below 5
retain the fifth tier to stay readable; the centre counts as level 1.
Cards grow vertically to show their titles and annotations without truncation.
Manual title-size overrides take precedence; changing connections updates the
default tier without moving authored positions. Properties, layout measurement
and PNG/SVG/Mural exports use the same hierarchy.
Connectors are rounded elbows (4px radius) in each
connection type's sheet colour; typed lines are 1.75px, untyped `related`
lines 1.25px `#a8a8a8`; labels are white pills outlined in that colour.
Tidy keeps the main node fixed and places level-2 branches at equal angles
around it, independent of connection type. Descendants form compact
parent-and-children groups extending outward within their branch's sector.
Sibling subtrees stay together, with spacing based on measured card dimensions;
do not place descendants on global concentric rings. Collapsed descendants stay
hidden and retain their positions. Cards remain freely draggable afterwards,
and Undo restores the previous arrangement. No column headers or legend are shown.
Automatic additions join their parent's outward-facing group and reflow only
that parent's descendants, keeping siblings together and unrelated branches
fixed. New root branches use an available angular gap. Explicit drop positions
remain authored. Branch spacing accounts for fixed neighbouring cards; Undo
restores the addition and the affected group's previous positions together.

Idea cards have a brainstorm type, chosen from a dropdown (icon tile and name) in
the Properties tab, with its own
icon and tile tint/icon/ink: Topic `#d9fbfb`/`#007d79`/`#005d5d` (the root's
default), Subject `#f4f4f4`/`#525252`/`#393939` (Bookmark), Idea `#fcf4d6`/`#b28600`/`#8e6a00` (the default), Question
`#f6f2ff`/`#8a3ffc`/`#6929c4`, Option `#edf5ff`/`#0f62fe`/`#0043ce`, Pro
`#defbe6`/`#24a148`/`#0e6027`, Con `#fff1f1`/`#da1e28`/`#a2191f`, Risk
`#fff2e8`/`#eb6200`/`#8a3800`, Action `#e5f6ff`/`#0072c3`/`#00539a` and
Decision `#fff0f7`/`#d02670`/`#9f1853`. Linked cards keep their source type.
A non-root card with children shows a 20px white collapse knob on the line to
its children, outside the connect dot; collapsed, it shows the hidden count in
the card's ink. Footnotes match diagrams: a 20px `#0f62fe` numbered marker on
the card's top-right corner and a dashed-divider Notes list below the cards.
The header reuses the diagram header (`.dg-header`): Undo/Redo, Add idea,
zoom and Fit, Tidy and Copy Markdown groups, then Export (PNG, SVG, Mural),
Make a use case and Delete; pinned-note chips sit on the row beneath.
Do not show persistent gesture or keyboard-instruction text across the canvas.
Diagram and brainstorm share Snap controls, alignment/equal-spacing calculations
and drawing guides. Brainstorm offers independent grid visibility, grid snap
and card/equal-spacing snap with 5/10/20/40-unit spacing (default 10).
Snapping uses visible cards' measured edges and centres. Hold Alt during a
card drag to bypass snapping and guides; starting Alt+drag still creates a
connection. Grid and snapping choices are saved per brainstorm. Hold Space and
drag to pan, including when the pointer is over a card or connection; typing
in editors and using controls must retain their normal Space-key behaviour.
At low zoom, subsample visible grid points in powers of two to retain at least
12 screen pixels between dots. The sheet stays white rather than merging into
a grey dot field; snapping still uses the selected world-unit spacing.

Every brainstorm card, including linked content, has an Appearance section in
Properties. Reuse diagram colour swatches and border-style controls for the
background, border colour/style/thickness and text colour; title size uses
10-36px choices. Custom text colour applies to the title and card annotation,
not the type icon or label. Existing card layout, type colours, root and pinned
defaults remain unchanged unless overridden. Reset appearance clears only
styling overrides. Saved styling participates in Undo/Redo and PNG/SVG/Mural
exports; selecting no fill or border makes that part transparent.

## Components

**Buttons.** Prefer existing Carbon and Athena variants. The outlined accent
utility button uses teal text, an 8% teal fill, a 25% teal border, 4px radius,
8px/16px padding and a 6px icon gap. Its hover increases the tint to 14% and
uses a solid teal border. Ghost buttons are neutral until interacted with.
Shared dialog primary actions use solid teal with dark text. Destructive
actions use the existing red variant, never teal.

**Fields.** Use Carbon field backgrounds, readable text and subtle/strong border
tokens. Labels remain visible; placeholders do not replace them. Show error,
disabled, selected and focus states. Keep validation next to its field.

**Focus.** Existing custom controls generally use a 2px teal focus-visible
outline with 2-3px offset; Carbon controls can use Carbon's white focus token.
Keep visible keyboard focus, accessible names for icon-only controls and
disabled semantics. Do not rely on a colour change alone.

**Lists and cards.** Dense, scannable rows are the default for work queues and
note lists. Separate title, explanation and metadata without burying the title
in tiny uppercase text. Reserve cards for independently meaningful units.
Keep content-type badges visible in note lists.

**Identity chips.** A project has a coloured icon and stronger tint. Topics and
themes use a coloured dot with a lighter tint. Groups remain neutral.
Chips truncate long labels without losing their remove or navigation controls.

**Navigation.** The selected top-level destination has a 2px teal underline,
teal-tinted background and semibold primary text. Tool-menu selection has a
3px teal left edge. Attention badges carry an accessible count and meaning.

**Athena conversation.** Distinguish the user's question, the working status
and the accepted answer. Keep source/reference controls subordinate to the
answer. Do not display provisional model rounds as final replies: those rounds
can be discarded during tool use or evidence repair.

**Athena motion.** The signature mark is four quarter-circle pieces. Typing
morphs them into four dots, returning to rest after 1.5 seconds without typing.
Voice dots follow the captured microphone level. Resting breathes over 3.4 seconds
with a periodic quarter turn; thinking uses the supplied stepped 3.2-second loop,
not square pieces. The accepted answer contracts them into its corner mark
before returning to the composer. State morphs take 240ms; placement travels
400ms into the thread and 500ms home. The answer surface grows from 72px over
400ms using transforms; content rises 16px with 100ms stagger steps. After the
entrance and a 600ms hold, the mark returns to the dock. Every completed answer
keeps the supplied 27px static mark at 55% opacity. The dock is 24px above the
composer, aligned with the content column. Its
dedicated blue palette is not a replacement for the teal application accent.
Preserve reduced-motion support and hidden/offscreen pausing. Never change
Windows or browser accessibility settings to make a design animate.
The supplied custom element is served locally from `/athena/athena-mark.js`;
its four-quarter animation maths are retained unchanged. See
`docs/athena-mark.md` for the integration and intentional streaming adaptations.

**Dialogs and images.** Shared dialogs are normally up to 480px wide (660px for
the wide variant), constrained to the viewport. Image viewing has its own
full-screen surface with zoom, fit, copy and close actions. Preserve authenticated
image loading and clear failure states.

The blog publishing dialog starts with no format selected and offers Quick take
and Article with short descriptions. Drafting begins only on the explicit
Start drafting action. After starting or generating again, keep a dismissible
Draft in progress dialog open: state that work is not complete, Athena will
notify the user when it is ready to review, and nothing has been published.
Do not automatically dismiss it when the background job is accepted.

The blog draft/review dialog keeps Title, Post type and the existing rich-text/HTML
editor visible. Excerpt, summary, takeaways, categories and tags live in a collapsed
Post details disclosure. Major publication blockers remain visible; advisory
suggestions and review history have separate collapsed disclosures with counts.
Keep existing footer actions. After sending, replace the editor with one success
dialog, retaining post/admin links. Done, Escape and the close button dismiss the
whole publishing flow and reveal the underlying screen; do not stack another
success alert or leave a completion dialog underneath.

### Task-linked briefs and email drafts

Deliverable brief and Email draft are Work content types within the existing
Think shell, not separate workspaces or Plan actions. Preserve the note editor,
action bar and properties panel. Brief headings are authored note content;
target folder/file and produced-file status belong in the properties panel.
Email To, Cc and Subject are compact, labelled fields immediately above the
body; Draft/Sent, sent date and copying/confirmation actions stay in properties.

Use the existing teal brief and blue email content-type badges. Fields use
Carbon layers, borders, text and focus tokens. Keep confirmations inline,
buttons compact and source/status text flush-left. Clearly distinguish
loading, retained draft/conflict, waiting for sync and ready for review.
Neither copied text nor a detected file implies sending or task completion.

## Do's and Don'ts

- **Do** retain the current workbench hierarchy, real content and selection context.
- **Do** use Athena and Carbon tokens, including all hover/focus/disabled/error states.
- **Do** show a realistic desktop screen and the compact panel when relevant.
- **Do** distinguish explicit assignments, suggestions, evidence and unavailable data in AI copy.
- **Don't** replace this with a generic SaaS dashboard, marketing hero or new UI kit.
- **Don't** introduce gradients, glass surfaces or oversized cards as a new visual identity.
- **Don't** use pills for panels, a second nested gutter, justified prose or markerless authored lists.
- **Don't** sacrifice source labels, accessible names or visible keyboard focus for visual minimalism.
- **Don't** add arbitrary mobile layouts outside chat or remove reduced-motion behaviour.

Implementation references: `knowledge-hub-web\src\styles\global.scss`,
`styles\navigation.scss`, `styles\_identity.scss`, `styles\_imageViewer.scss`,
`components\AppShell.tsx`, `components\athena\AthenaPresence.tsx`,
`chat\athenaMotion.ts` and `features\diagram\diagramTheme.ts`.
The `--cds-*` palette was checked against the installed Carbon g100 theme.
