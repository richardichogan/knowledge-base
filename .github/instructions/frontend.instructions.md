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

## Code structure

- Never break the existing JSX structure of `AppShell.tsx` — it returns a `<>` fragment. Any new providers must wrap at the `App.tsx` level, not inside AppShell.
- The floating-widget/compact chat view (`FloatingAIChat` → `<AIChatPage compact>`) is narrow (~400px). Any new control added to the chat action row (e.g. persona switcher buttons) must collapse to icon-only there instead of wrapping or causing a horizontal scrollbar — see `.ai-new-chat-row--compact` overrides in `global.scss` for the existing pattern (label text in a `.kh-persona-switch__label` span, hidden via `display: none` in the compact selector).

## Verification

- Always run `tsc --noEmit` in `knowledge-hub-web` after changes, before declaring work done.
