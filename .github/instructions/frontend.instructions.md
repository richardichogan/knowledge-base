---
applyTo: "knowledge-hub-web/**"
---

# Frontend (knowledge-hub-web) instructions

## Styling — MANDATORY

**Every new UI element must be fully styled before the change is considered complete.**

- Every new component, button, input, modal, panel, list item, badge, or icon added to the frontend MUST have corresponding CSS in `global.scss` (or the relevant component SCSS file).
- Never add a raw unstyled HTML element or Carbon component without defining its visual appearance.
- Use existing BEM naming conventions already present in the codebase (e.g. `kh-`, `dc-`, `gctx__`, `kb-modal-`, etc.).
- If a component has interactive states (hover, active, disabled, open/closed), all states must be styled.
- Do not ship a PR or consider a task complete if any element relies solely on browser defaults or Carbon defaults without intentional overrides matching the app's dark Carbon theme.

### Text alignment and side panels — permanent rule

- Headings, paragraphs, descriptions, explanations and read-only values MUST share a flush-left text edge within their section, on every page and in every side panel. No first-line indent, hanging prose indent or progressively inset section bodies. Use left/start alignment, not full justification (stretched word spacing).
- Only visibly marked bullet/numbered lists may indent prose. Markerless semantic lists MUST use `list-style: none; margin-inline: 0; padding-inline: 0`. Preserve intentional hierarchy in navigation trees and whitespace in code; do not flatten authored editor lists.
- Apply the panel gutter once, at the owning panel body. Nested section, preview, metadata and connection wrappers MUST NOT add another horizontal gutter. Inside a bordered input or independent card, keep the same inset for its heading and body.
- Use Athena/Carbon colour, typography, spacing, radius and focus tokens. Small section labels use `--kh-heading-label`; ordinary panel text uses `--kh-text-body`. Do not use pill radii for panels.
- Static presentation belongs in SCSS classes, never inline styles. Inline styles are allowed only for genuinely runtime-dependent geometry, progress, user-selected colours or CSS custom properties carrying such values. Finite visual states use classes.
- Before removing CSS, verify its selectors against JSX, generated markup and responsive/interactive states. Consolidate conflicting declarations at their source; do not stack blanket overrides or delete styles based on a single screenshot.

## Code structure

- Never break the existing JSX structure of `AppShell.tsx` — it returns a `<>` fragment. Any new providers must wrap at the `App.tsx` level, not inside AppShell.
- The floating-widget/compact chat view (`FloatingAIChat` → `<AIChatPage compact>`) is narrow (~400px). Any new control added to the chat action row (e.g. persona switcher buttons) must collapse to icon-only there instead of wrapping or causing a horizontal scrollbar — see `.ai-new-chat-row--compact` overrides in `global.scss` for the existing pattern (label text in a `.kh-persona-switch__label` span, hidden via `display: none` in the compact selector).

## Verification

- Always run `tsc --noEmit` in `knowledge-hub-web` after changes, before declaring work done.
