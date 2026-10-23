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

The diagram editor is an intentional exception to the dark surfaces: it uses
a **light-grey sheet**, stronger IBM 30 node fills paired with darker borders
from the same hue family, and dark ink inside dark application
chrome. Editor-only colour mappings do not rewrite saved colours or exports.
Fill choices are Blue `#a6c8ff`, Purple `#d4bbff`, Cyan `#82cfff`,
Teal `#3ddbd9`, Green `#6fdc8c`, Magenta `#ffafd2`, Red `#ffb3b8`,
Yellow `#f1c21b` and Orange `#ffb784`, plus white, grey and no fill.
Existing pale/legacy palette colours receive the stronger editor appearance;
custom colours remain unchanged. Newly chosen fills are saved as selected.
Multi-selection supports shared colours, thickness, text size and line styles
in Properties and contextual styling; mixed values stay unchanged until chosen.
Preserve alignment guides and selectable 5/10/20/40 grid spacing (default 10).

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
morphs them into a row; thinking expands and rotates them; the accepted answer
contracts them into its corner mark before returning to the composer. Its
dedicated blue palette is not a replacement for the teal application accent.
Preserve reduced-motion support and hidden/offscreen pausing. Never change
Windows or browser accessibility settings to make a design animate.

**Dialogs and images.** Shared dialogs are normally up to 480px wide (660px for
the wide variant), constrained to the viewport. Image viewing has its own
full-screen surface with zoom, fit, copy and close actions. Preserve authenticated
image loading and clear failure states.

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
